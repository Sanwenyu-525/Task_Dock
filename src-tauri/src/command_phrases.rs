//! 句式命令：确定性封闭帧表解析与只读查询。
//!
//! 设计边界（见 `docs/adr/0001-deterministic-command-phrases.md`）：
//! - 不接模型；帧表外输入返回 `None`，由全局搜索按普通检索处理（零损失回退）。
//! - 整句精确命中已有任务标题时同样返回 `None`：搜索无损、命令有副作用。
//! - 写意图只给候选，不在后端执行；执行与二次确认由前端负责。

use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};
use regex::Regex;
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::actions::{self, ActionFilter};
use crate::commands::tasks::{list_tasks_inner, TaskFilter};
use crate::db::Db;
use crate::error::AppResult;
use crate::nlp;
use crate::task_analytics::{self, RangeKind};

const CANDIDATE_LIMIT: i64 = 5;
const QUERY_ITEM_LIMIT: u32 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    Complete { target: String },
    Reschedule { target: String, time_text: String },
    Priority { target: String, priority: u8 },
    QueryWeekCompleted,
    QueryOverdue,
    QueryToday,
    QueryAgentFailures,
}

struct Frames {
    complete: Regex,
    complete_baci: Regex,
    reschedule_baci: Regex,
    reschedule_prefix: Regex,
    priority_baci: Regex,
    priority_suffix: Regex,
    query_week: Regex,
    query_overdue: Regex,
    query_today: Regex,
    query_agents: Regex,
}

fn frames() -> &'static Frames {
    static FRAMES: OnceLock<Frames> = OnceLock::new();
    FRAMES.get_or_init(|| Frames {
        complete: Regex::new(r"^完成\s+(.+)$").unwrap(),
        complete_baci: Regex::new(r"^把\s*(.+?)\s*标记完成$").unwrap(),
        reschedule_baci: Regex::new(r"^把\s*(.+?)\s*改到\s*(.+)$").unwrap(),
        reschedule_prefix: Regex::new(r"^(.+?)\s*改到\s*(.+)$").unwrap(),
        priority_baci: Regex::new(r"^把\s*(.+?)\s*(?:的)?\s*优先级\s*(?:改成|改为)\s*(高|中|低)$")
            .unwrap(),
        priority_suffix: Regex::new(r"^(.+?)\s*优先级\s*(高|中|低)$").unwrap(),
        query_week: Regex::new(r"^本周完成(?:了什么|了哪些|情况)?$").unwrap(),
        query_overdue: Regex::new(r"^(?:有哪些逾期的|逾期任务)$").unwrap(),
        query_today: Regex::new(r"^今天要做什么$").unwrap(),
        query_agents: Regex::new(r"(?i)^哪些\s*agent\s*失败了$").unwrap(),
    })
}

/// 去掉首尾空白与句末标点；句末问号/句号不参与帧匹配。
fn normalize(input: &str) -> String {
    input
        .trim()
        .trim_end_matches(['?', '？', '!', '！', '。', ' '])
        .to_string()
}

fn priority_value(raw: &str) -> Option<u8> {
    match raw {
        "高" => Some(1),
        "中" => Some(2),
        "低" => Some(3),
        _ => None,
    }
}

fn captured(caps: &regex::Captures<'_>, idx: usize) -> Option<String> {
    caps.get(idx)
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 纯解析：只识别封闭帧表，不查库、不执行。
pub fn parse(input: &str) -> Option<Intent> {
    let text = normalize(input);
    if text.is_empty() {
        return None;
    }
    let f = frames();

    // 查询帧先匹配：它们不以动词/「把」起手，不会被写帧误吃。
    if f.query_week.is_match(&text) {
        return Some(Intent::QueryWeekCompleted);
    }
    if f.query_overdue.is_match(&text) {
        return Some(Intent::QueryOverdue);
    }
    if f.query_today.is_match(&text) {
        return Some(Intent::QueryToday);
    }
    if f.query_agents.is_match(&text) {
        return Some(Intent::QueryAgentFailures);
    }

    // 优先级帧必须在改期/完成之前：「把X的优先级改成高」不含「改到」，但
    // 「X优先级高」需要先于泛化的完成帧处理。
    if let Some(caps) = f.priority_baci.captures(&text) {
        if let (Some(target), Some(priority)) = (
            captured(&caps, 1),
            captured(&caps, 2).and_then(|p| priority_value(&p)),
        ) {
            return Some(Intent::Priority { target, priority });
        }
    }
    if let Some(caps) = f.priority_suffix.captures(&text) {
        if let (Some(target), Some(priority)) = (
            captured(&caps, 1),
            captured(&caps, 2).and_then(|p| priority_value(&p)),
        ) {
            return Some(Intent::Priority { target, priority });
        }
    }

    if let Some(caps) = f.reschedule_baci.captures(&text) {
        if let (Some(target), Some(time_text)) = (captured(&caps, 1), captured(&caps, 2)) {
            return Some(Intent::Reschedule { target, time_text });
        }
    }
    if let Some(caps) = f.reschedule_prefix.captures(&text) {
        if let (Some(target), Some(time_text)) = (captured(&caps, 1), captured(&caps, 2)) {
            return Some(Intent::Reschedule { target, time_text });
        }
    }

    if let Some(caps) = f.complete_baci.captures(&text) {
        if let Some(target) = captured(&caps, 1) {
            return Some(Intent::Complete { target });
        }
    }
    if let Some(caps) = f.complete.captures(&text) {
        if let Some(target) = captured(&caps, 1) {
            return Some(Intent::Complete { target });
        }
    }

    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseTaskCandidate {
    pub id: String,
    pub title: String,
    pub due_at: Option<String>,
    pub priority: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseWrite {
    pub target: String,
    pub candidates: Vec<PhraseTaskCandidate>,
    pub due_at: Option<String>,
    pub date_only: bool,
    pub priority: Option<u8>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryKind {
    WeekCompleted,
    Overdue,
    Today,
    AgentFailures,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseQuerySummary {
    pub completed: i64,
    pub overdue: i64,
    pub due: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseAgentRef {
    pub source_id: String,
    pub session_id: String,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseQueryItem {
    pub id: String,
    pub title: String,
    /// task | agent
    pub kind: &'static str,
    pub due_at: Option<String>,
    pub occurred_at: Option<String>,
    pub source_name: Option<String>,
    pub agent: Option<PhraseAgentRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseQuery {
    pub query: QueryKind,
    pub summary: Option<PhraseQuerySummary>,
    pub items: Vec<PhraseQueryItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PhraseResolution {
    Complete(PhraseWrite),
    Reschedule(PhraseWrite),
    Priority(PhraseWrite),
    Query(PhraseQuery),
}

fn escape_like(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn exact_title_exists(db: &Db, title: &str) -> AppResult<bool> {
    let exists = db.with_conn(|conn| {
        let hit = conn
            .query_row(
                "SELECT 1 FROM tasks WHERE title = ?1 LIMIT 1",
                rusqlite::params![title],
                |_| Ok(()),
            )
            .optional()?;
        Ok(hit.is_some())
    })?;
    Ok(exists)
}

fn query_candidates(db: &Db, pattern: &str, exact: bool) -> AppResult<Vec<PhraseTaskCandidate>> {
    db.with_conn(|conn| {
        let sql = if exact {
            "SELECT id, title, due_at, priority FROM tasks
             WHERE status = 'pending' AND title = ?1
             ORDER BY updated_at DESC LIMIT ?2"
        } else {
            "SELECT id, title, due_at, priority FROM tasks
             WHERE status = 'pending' AND title LIKE ?1 ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT ?2"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params![pattern, CANDIDATE_LIMIT], |row| {
            Ok(PhraseTaskCandidate {
                id: row.get(0)?,
                title: row.get(1)?,
                due_at: row.get(2)?,
                priority: row.get::<_, i64>(3)? as u8,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// 先精确后子串；已完成的任不进入写候选（「完成」对已完成项会反开）。
fn match_tasks(db: &Db, target: &str) -> AppResult<Vec<PhraseTaskCandidate>> {
    let exact = query_candidates(db, target, true)?;
    if !exact.is_empty() {
        return Ok(exact);
    }
    query_candidates(db, &format!("%{}%", escape_like(target)), false)
}

fn build_write(
    db: &Db,
    target: String,
    due_at: Option<String>,
    date_only: bool,
    priority: Option<u8>,
) -> AppResult<PhraseWrite> {
    let candidates = match_tasks(db, &target)?;
    Ok(PhraseWrite {
        target,
        candidates,
        due_at,
        date_only,
        priority,
    })
}

fn local_midnight_utc(date: NaiveDate) -> DateTime<Utc> {
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .unwrap()
        .with_timezone(&Utc)
}

fn week_completed(db: &Db) -> AppResult<PhraseQuery> {
    let report = task_analytics::report(db, Some("week"))?;
    let (start, end) = task_analytics::range_window(RangeKind::Week, Local::now().date_naive());
    let start_iso = local_midnight_utc(start).to_rfc3339();
    let end_iso = local_midnight_utc(end).to_rfc3339();
    let items = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.title, e.completed_at
             FROM task_completion_events e
             JOIN tasks t ON t.id = e.task_id
             WHERE e.completed_at >= ?1 AND e.completed_at < ?2
             ORDER BY e.completed_at DESC
             LIMIT 20",
        )?;
        let rows = stmt.query_map(rusqlite::params![start_iso, end_iso], |row| {
            Ok(PhraseQueryItem {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: "task",
                due_at: None,
                occurred_at: row.get(2)?,
                source_name: None,
                agent: None,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })?;
    Ok(PhraseQuery {
        query: QueryKind::WeekCompleted,
        summary: Some(PhraseQuerySummary {
            completed: report.summary.completed,
            overdue: report.summary.due_overdue,
            due: report.summary.due,
        }),
        items,
    })
}

fn task_query(db: &Db, kind: QueryKind, view: &str) -> AppResult<PhraseQuery> {
    let tasks = list_tasks_inner(
        db,
        TaskFilter {
            view: Some(view.into()),
            status: Some("pending".into()),
            sort: Some("due".into()),
            limit: Some(QUERY_ITEM_LIMIT),
            ..Default::default()
        },
    )?;
    let items = tasks
        .into_iter()
        .map(|t| PhraseQueryItem {
            id: t.id,
            title: t.title,
            kind: "task",
            due_at: t.due_at,
            occurred_at: None,
            source_name: None,
            agent: None,
        })
        .collect();
    Ok(PhraseQuery {
        query: kind,
        summary: None,
        items,
    })
}

fn agent_failures(db: &Db) -> AppResult<PhraseQuery> {
    let feed = actions::feed(
        db,
        &ActionFilter {
            kind: Some("failed".into()),
            category: Some("intervention".into()),
            limit: Some(QUERY_ITEM_LIMIT as usize),
            ..Default::default()
        },
    )?;
    let items = feed
        .items
        .into_iter()
        .map(|item| {
            let agent = if item.session_external_id.is_empty() {
                None
            } else {
                Some(PhraseAgentRef {
                    source_id: item.source_id.clone(),
                    session_id: item.session_external_id.clone(),
                    run_id: item.run_external_id.clone(),
                })
            };
            PhraseQueryItem {
                id: item.id,
                title: item.title,
                kind: "agent",
                due_at: None,
                occurred_at: Some(item.occurred_at),
                source_name: Some(item.source_name),
                agent,
            }
        })
        .collect();
    Ok(PhraseQuery {
        query: QueryKind::AgentFailures,
        summary: None,
        items,
    })
}

/// 查库解析：帧匹配 → 整句标题冲突 → 候选/查询结果。
pub fn resolve(db: &Db, raw: &str) -> AppResult<Option<PhraseResolution>> {
    let intent = match parse(raw) {
        Some(intent) => intent,
        None => return Ok(None),
    };
    // 规则 1：整句精确命中任务标题时保持搜索语义，避免误改数据。
    if exact_title_exists(db, &normalize(raw))? {
        return Ok(None);
    }
    match intent {
        Intent::Complete { target } => Ok(Some(PhraseResolution::Complete(build_write(
            db,
            target,
            None,
            false,
            None,
        )?))),
        Intent::Reschedule { target, time_text } => {
            let parsed = nlp::parse(&time_text);
            let due = match parsed.due_at {
                Some(due) => due,
                // 帧命中但时间解析不了：回退搜索，不猜测时间。
                None => return Ok(None),
            };
            Ok(Some(PhraseResolution::Reschedule(build_write(
                db,
                target,
                Some(due.to_rfc3339()),
                parsed.date_only,
                None,
            )?)))
        }
        Intent::Priority { target, priority } => Ok(Some(PhraseResolution::Priority(build_write(
            db,
            target,
            None,
            false,
            Some(priority),
        )?))),
        Intent::QueryWeekCompleted => Ok(Some(PhraseResolution::Query(week_completed(db)?))),
        Intent::QueryOverdue => Ok(Some(PhraseResolution::Query(task_query(
            db,
            QueryKind::Overdue,
            "overdue",
        )?))),
        Intent::QueryToday => Ok(Some(PhraseResolution::Query(task_query(
            db,
            QueryKind::Today,
            "due_today",
        )?))),
        Intent::QueryAgentFailures => Ok(Some(PhraseResolution::Query(agent_failures(db)?))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tasks::{create_task_inner, toggle_task_inner, TaskInput};
    use chrono::Duration;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn create(db: &Db, title: &str, due_at: Option<String>) -> crate::db::Task {
        create_task_inner(
            db,
            TaskInput {
                title: title.into(),
                due_at: due_at.map(Some),
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn parses_each_supported_frame() {
        assert_eq!(
            parse("完成 交周报"),
            Some(Intent::Complete {
                target: "交周报".into()
            })
        );
        assert_eq!(
            parse("把 交周报 标记完成"),
            Some(Intent::Complete {
                target: "交周报".into()
            })
        );
        assert_eq!(
            parse("把交周报改到明天下午三点"),
            Some(Intent::Reschedule {
                target: "交周报".into(),
                time_text: "明天下午三点".into()
            })
        );
        assert_eq!(
            parse("交周报 改到 明天"),
            Some(Intent::Reschedule {
                target: "交周报".into(),
                time_text: "明天".into()
            })
        );
        assert_eq!(
            parse("把交周报的优先级改成高"),
            Some(Intent::Priority {
                target: "交周报".into(),
                priority: 1
            })
        );
        assert_eq!(
            parse("交周报优先级低"),
            Some(Intent::Priority {
                target: "交周报".into(),
                priority: 3
            })
        );
        assert_eq!(parse("本周完成了什么"), Some(Intent::QueryWeekCompleted));
        assert_eq!(parse("本周完成？"), Some(Intent::QueryWeekCompleted));
        assert_eq!(parse("逾期任务"), Some(Intent::QueryOverdue));
        assert_eq!(parse("今天要做什么"), Some(Intent::QueryToday));
        assert_eq!(parse("哪些 Agent 失败了"), Some(Intent::QueryAgentFailures));
    }

    #[test]
    fn rejects_unlisted_phrasings() {
        assert_eq!(parse("完成交周报"), None, "完成帧要求空格，避免误吃标题");
        assert_eq!(parse("取消完成 交周报"), None);
        assert_eq!(parse("把交周报的优先级调高"), None);
        assert_eq!(parse("交周报 改成明天"), None, "缺「到」不进帧表");
        assert_eq!(parse("交周报"), None);
    }

    #[test]
    fn exact_full_title_wins_over_phrase() {
        let db = db();
        create(&db, "完成 交周报", None);
        // 同一句话既是合法「完成」帧，也精确命中一个任务标题：保持搜索。
        assert!(resolve(&db, "完成 交周报").unwrap().is_none());
    }

    #[test]
    fn complete_matches_pending_only() {
        let db = db();
        let done = create(&db, "交周报", None);
        toggle_task_inner(&db, &done.id).unwrap();
        let pending = create(&db, "交周报终稿", None);
        let res = resolve(&db, "把交周报标记完成").unwrap().unwrap();
        let PhraseResolution::Complete(write) = res else {
            panic!("应为完成意图");
        };
        assert_eq!(write.candidates.len(), 1);
        assert_eq!(write.candidates[0].id, pending.id);
    }

    #[test]
    fn zero_candidate_still_returns_write_intent() {
        let db = db();
        let res = resolve(&db, "完成 不存在的任务").unwrap().unwrap();
        let PhraseResolution::Complete(write) = res else {
            panic!("应为完成意图");
        };
        assert!(write.candidates.is_empty());
        assert_eq!(write.target, "不存在的任务");
    }

    #[test]
    fn reschedule_carries_time_and_date_only() {
        let db = db();
        create(&db, "交周报", None);
        let res = resolve(&db, "把交周报改到明天").unwrap().unwrap();
        let PhraseResolution::Reschedule(write) = res else {
            panic!("应为改期意图");
        };
        assert!(write.due_at.is_some());
        assert!(write.date_only, "只给日期时补 09:00 并标记 date_only");
        assert_eq!(write.candidates.len(), 1);
    }

    #[test]
    fn unparseable_time_falls_back_to_search() {
        let db = db();
        create(&db, "交周报", None);
        assert!(resolve(&db, "把交周报改到随便什么时候").unwrap().is_none());
    }

    #[test]
    fn priority_frame_maps_values() {
        let db = db();
        create(&db, "交周报", None);
        let res = resolve(&db, "交周报优先级中").unwrap().unwrap();
        let PhraseResolution::Priority(write) = res else {
            panic!("应为优先级意图");
        };
        assert_eq!(write.priority, Some(2));
    }

    #[test]
    fn week_query_uses_analytics_summary_and_lists_completed() {
        let db = db();
        let task = create(&db, "本周完成的任务", None);
        toggle_task_inner(&db, &task.id).unwrap();
        let res = resolve(&db, "本周完成了什么").unwrap().unwrap();
        let PhraseResolution::Query(query) = res else {
            panic!("应为查询");
        };
        let summary = query.summary.expect("周查询应有汇总");
        assert!(summary.completed >= 1);
        assert!(query.items.iter().any(|i| i.id == task.id));
    }

    #[test]
    fn overdue_query_lists_past_due_pending() {
        let db = db();
        let past = (Utc::now() - Duration::hours(2)).to_rfc3339();
        create(&db, "已逾期任务", Some(past));
        create(&db, "未来任务", Some((Utc::now() + Duration::hours(2)).to_rfc3339()));
        let res = resolve(&db, "逾期任务").unwrap().unwrap();
        let PhraseResolution::Query(query) = res else {
            panic!("应为查询");
        };
        assert_eq!(query.items.len(), 1);
        assert_eq!(query.items[0].title, "已逾期任务");
    }

    #[test]
    fn today_query_uses_local_day_window() {
        let db = db();
        let noon = Local::now().date_naive().and_hms_opt(12, 0, 0).unwrap();
        let due = Local.from_local_datetime(&noon).unwrap().to_rfc3339();
        create(&db, "今天的任务", Some(due));
        let res = resolve(&db, "今天要做什么").unwrap().unwrap();
        let PhraseResolution::Query(query) = res else {
            panic!("应为查询");
        };
        assert_eq!(query.items.len(), 1);
        assert_eq!(query.items[0].title, "今天的任务");
    }

    #[test]
    fn agent_failure_query_is_empty_without_events() {
        let db = db();
        let res = resolve(&db, "哪些 Agent 失败了").unwrap().unwrap();
        let PhraseResolution::Query(query) = res else {
            panic!("应为查询");
        };
        assert!(query.items.is_empty());
    }
}
