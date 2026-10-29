//! Agent 行动中心：把散落的 Agent 事件聚合成「需要人处理的动作」。
//!
//! 约束：
//! - 只读 `agent_events` / `agent_runs` / `tasks` / 关联表 / `notification_history`，
//!   从不写 Agent 状态，也不推断「任务完成」；
//! - 状态完全来自真实事件；未接入/未验证的来源只显示覆盖度，不生成动作；
//! - 相邻同来源/会话/轮次/类型/消息的事件在 10 分钟内合并，保留全部 event_ids 供批量确认；
//! - 「授权」类型是关键词推断（UI 必须标注「推断」），不是权限系统；
//! - 单次查询最多读 600 条事件、返回 300 条动作，避免历史增长拖垮 UI。

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::agents::AgentState;
use crate::db::Db;
use crate::error::{AppError, AppResult};

const EVENT_SCAN_LIMIT: i64 = 600;
const ITEM_LIMIT_DEFAULT: usize = 120;
const ITEM_LIMIT_MAX: usize = 300;
const MERGE_WINDOW_SECS: i64 = 600;
const EVENT_LOOKBACK_DAYS: i64 = 7;
const SOURCE_STALE_HOURS: i64 = 24;

const AUTH_KEYWORDS: &[&str] = &[
    "授权",
    "权限",
    "批准",
    "同意",
    "确认访问",
    "permission",
    "approve",
    "authorization",
    "allow access",
];

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ActionFilter {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// failed | authorization | waiting_input | running | completed | disconnected | reminder
    #[serde(default)]
    pub kind: Option<String>,
    /// 0=P0 … 3=P3
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub include_acked: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionItem {
    /// 合并后稳定键（取最新事件 id）
    pub id: String,
    pub kind: String,
    /// 0=P0 最高 … 3=P3
    pub priority: u8,
    pub source_id: String,
    pub source_name: String,
    pub session_external_id: String,
    pub run_row_id: Option<String>,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub title: String,
    pub message: String,
    pub occurred_at: String,
    pub count: usize,
    pub event_ids: Vec<String>,
    pub acked: bool,
    pub authorization_inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoverageRow {
    pub source_id: String,
    pub display_name: String,
    pub enabled: bool,
    pub verified: bool,
    pub transport_verified: bool,
    /// 仅 enabled && transport_verified 才算真正接入监控
    pub monitored: bool,
    pub last_event_at: Option<String>,
    /// live | stale | no-events | disabled | not-configured
    pub level: String,
    /// 给用户看的一句话说明（为什么是当前级别）
    pub explanation: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ActionCounts {
    pub failed: usize,
    pub authorization: usize,
    pub waiting_input: usize,
    pub running: usize,
    pub completed: usize,
    pub disconnected: usize,
    pub reminder: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionFeed {
    pub items: Vec<ActionItem>,
    pub counts: ActionCounts,
    pub coverage: Vec<CoverageRow>,
    pub generated_at: String,
    pub truncated: bool,
    pub scanned_events: usize,
}

#[derive(Debug)]
struct EventRow {
    id: String,
    source_id: String,
    source_name: String,
    session: String,
    run_ext: Option<String>,
    run_row: Option<String>,
    state: String,
    message: String,
    occurred_at: String,
    task_id: Option<String>,
    task_title: Option<String>,
}

#[derive(Debug, Clone)]
struct TaskMapping {
    id: String,
    title: String,
    status: String,
    updated_at: String,
}

fn classify(state: &str, text: &str) -> (&'static str, u8) {
    match state {
        "failed" => ("failed", 0),
        "waiting" => {
            let lower = text.to_ascii_lowercase();
            if AUTH_KEYWORDS
                .iter()
                .any(|k| text.contains(k) || lower.contains(k))
            {
                ("authorization", 1)
            } else {
                ("waiting_input", 1)
            }
        }
        "disconnected" => ("disconnected", 2),
        "running" => ("running", 2),
        "completed" => ("completed", 3),
        _ => ("idle", 3),
    }
}

fn kind_title(kind: &str) -> &'static str {
    match kind {
        "failed" => "执行失败",
        "authorization" => "等待授权（推断）",
        "waiting_input" => "等待输入",
        "disconnected" => "连接中断",
        "running" => "正在执行",
        "completed" => "本轮完成",
        "reminder" => "任务提醒",
        _ => "状态更新",
    }
}

fn load_task_map(conn: &rusqlite::Connection) -> AppResult<HashMap<(String, String), TaskMapping>> {
    let mut stmt = conn.prepare(
        "SELECT l.source_id, l.session_external_id, t.id, t.title, t.status, t.updated_at
         FROM task_agent_links l JOIN tasks t ON t.id = l.task_id
         UNION ALL
         SELECT n.agent_source_id, n.agent_session_id, t.id, t.title, t.status, t.updated_at
         FROM task_navigation_targets nl
         JOIN navigation_targets n ON n.id = nl.target_id
         JOIN tasks t ON t.id = nl.task_id
         WHERE n.target_type = 'agent_session'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
            TaskMapping {
                id: r.get(2)?,
                title: r.get(3)?,
                status: r.get(4)?,
                updated_at: r.get(5)?,
            },
        ))
    })?;
    let mut out: HashMap<(String, String), TaskMapping> = HashMap::new();
    for row in rows {
        let (key, cand) = row?;
        match out.get(&key) {
            None => {
                out.insert(key, cand);
            }
            Some(cur) => {
                // 未完成优先，其次最近更新（一个会话可能被多个任务引用）
                let cur_pending = cur.status == "pending";
                let cand_pending = cand.status == "pending";
                if (cand_pending && !cur_pending)
                    || (cand_pending == cur_pending && cand.updated_at > cur.updated_at)
                {
                    out.insert(key, cand);
                }
            }
        }
    }
    Ok(out)
}

fn load_events(conn: &rusqlite::Connection, cutoff: &str) -> AppResult<Vec<EventRow>> {
    let task_map = load_task_map(conn)?;
    let mut stmt = conn.prepare(
        "SELECT e.id, e.source_id, COALESCE(s.display_name, e.source_id), e.session_external_id,
                e.run_external_id, e.state, COALESCE(e.message, ''),
                COALESCE(e.occurred_at, e.received_at),
                (SELECT r.id FROM agent_runs r
                  WHERE r.source_id = e.source_id AND r.external_run_id = e.run_external_id
                  LIMIT 1)
         FROM agent_events e
         LEFT JOIN agent_sources s ON s.id = e.source_id
         WHERE COALESCE(e.occurred_at, e.received_at) >= ?1
           -- 自测事件只证明通道可用，绝不进入行动中心冒充真实会话
           AND e.session_external_id NOT LIKE 'taskdock-selftest-%'
         ORDER BY COALESCE(e.occurred_at, e.received_at) DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![cutoff, EVENT_SCAN_LIMIT], |r| {
        let source_id: String = r.get(1)?;
        let session: String = r.get(3)?;
        let task = task_map.get(&(source_id.clone(), session.clone()));
        Ok(EventRow {
            id: r.get(0)?,
            source_id,
            source_name: r.get(2)?,
            session,
            run_ext: r.get(4)?,
            run_row: r.get(8)?,
            state: r.get(5)?,
            message: r.get(6)?,
            occurred_at: r.get(7)?,
            task_id: task.map(|t| t.id.clone()),
            task_title: task.map(|t| t.title.clone()),
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn load_reminders(
    conn: &rusqlite::Connection,
    limit: usize,
    include_acked: bool,
) -> AppResult<Vec<ActionItem>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, n.body, n.created_at, n.ref_id, n.is_read,
                COALESCE((SELECT title FROM tasks WHERE id = n.ref_id), '')
         FROM notification_history n
         WHERE n.kind = 'reminder' AND (n.is_read = 0 OR ?2 = 1)
         ORDER BY n.created_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64, include_acked as i64], |r| {
        let task_id: Option<String> = r.get(4)?;
        Ok(ActionItem {
            id: r.get(0)?,
            kind: "reminder".into(),
            priority: 1,
            source_id: String::new(),
            source_name: "任务提醒".into(),
            session_external_id: String::new(),
            run_row_id: None,
            task_id,
            task_title: {
                let t: String = r.get(6)?;
                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            },
            title: r.get(1)?,
            message: r.get(2)?,
            occurred_at: r.get(3)?,
            count: 1,
            event_ids: vec![r.get(0)?],
            acked: r.get::<_, i64>(5)? != 0,
            authorization_inferred: false,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn merge_events(rows: Vec<EventRow>, acked_ids: &HashSet<String>) -> Vec<ActionItem> {
    struct Group {
        item: ActionItem,
        last_ts: DateTime<Utc>,
        merge_key: String,
        all_acked: bool,
    }
    let mut groups: Vec<Group> = Vec::new();
    for row in rows {
        let state = AgentState::parse(&row.state);
        if state.is_none() {
            continue;
        }
        let (kind, priority) = classify(&row.state, &row.message);
        if kind == "idle" {
            // idle 不是需要处理的动作，只保留在历史流水里
            continue;
        }
        let ts = parse_ts(&row.occurred_at).unwrap_or_else(Utc::now);
        let merge_key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            row.source_id,
            row.session,
            row.run_ext.as_deref().unwrap_or(""),
            kind,
            row.message
        );
        let can_merge = groups.last().map(|g| {
            g.merge_key == merge_key
                && (g.last_ts - ts).num_seconds() <= MERGE_WINDOW_SECS
                && (g.last_ts - ts).num_seconds() >= 0
        });
        let event_acked = acked_ids.contains(&row.id);
        if can_merge == Some(true) {
            let g = groups.last_mut().unwrap();
            g.item.count += 1;
            g.item.event_ids.push(row.id.clone());
            g.all_acked = g.all_acked && event_acked;
            g.item.acked = g.all_acked;
            g.last_ts = ts;
            continue;
        }
        let title = if row.task_title.as_deref().unwrap_or("").is_empty() {
            kind_title(kind).to_string()
        } else {
            format!(
                "{} · {}",
                kind_title(kind),
                row.task_title.as_deref().unwrap_or("")
            )
        };
        groups.push(Group {
            merge_key,
            last_ts: ts,
            all_acked: event_acked,
            item: ActionItem {
                id: row.id.clone(),
                kind: kind.into(),
                priority,
                source_id: row.source_id.clone(),
                source_name: row.source_name.clone(),
                session_external_id: row.session.clone(),
                run_row_id: row.run_row.clone(),
                task_id: row.task_id.clone(),
                task_title: row.task_title.clone(),
                title,
                message: row.message.clone(),
                occurred_at: row.occurred_at.clone(),
                count: 1,
                event_ids: vec![row.id.clone()],
                acked: event_acked,
                authorization_inferred: kind == "authorization",
            },
        });
    }
    groups.into_iter().map(|g| g.item).collect()
}

fn load_acked(conn: &rusqlite::Connection, ids: &[String]) -> AppResult<HashSet<String>> {
    // 只查本批出现的 id（避免全表扫描；action_acks 有主键）
    let mut out = HashSet::new();
    let mut stmt = conn.prepare("SELECT 1 FROM action_acks WHERE event_id = ?1")?;
    for id in ids {
        if stmt.exists(params![id])? {
            out.insert(id.clone());
        }
    }
    Ok(out)
}

fn coverage(conn: &rusqlite::Connection) -> AppResult<Vec<CoverageRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, display_name, enabled, verified, transport_verified, last_event_at,
                COALESCE(adapter, ''), COALESCE(note, '')
         FROM agent_sources WHERE hidden = 0 AND id <> 'mock'
         ORDER BY enabled DESC, id",
    )?;
    let now = Utc::now();
    let rows = stmt.query_map([], |r| {
        let enabled = r.get::<_, i64>(2)? != 0;
        let verified = r.get::<_, i64>(3)? != 0;
        let transport_verified = r.get::<_, i64>(4)? != 0;
        let last_event_at: Option<String> = r.get(5)?;
        let adapter: String = r.get(6)?;
        let note: String = r.get(7)?;
        let monitored = enabled && transport_verified;
        let level = if !enabled {
            "disabled".to_string()
        } else if last_event_at.is_none() {
            "no-events".to_string()
        } else {
            let fresh = last_event_at
                .as_deref()
                .and_then(parse_ts)
                .map(|t| now - t <= Duration::hours(SOURCE_STALE_HOURS))
                .unwrap_or(false);
            if monitored && fresh {
                "live".to_string()
            } else if monitored {
                "stale".to_string()
            } else {
                "not-configured".to_string()
            }
        };
        let explanation = match level.as_str() {
            "disabled" => "已停用：不接收事件".to_string(),
            "no-events" => "未接入：仅发现/安装，尚无真实事件".to_string(),
            "stale" => format!("{} 小时无新事件，状态可能已过期", SOURCE_STALE_HOURS),
            "not-configured" => "通道未验证：不显示运行状态".to_string(),
            _ => {
                if verified {
                    "运行中：已收到真实会话事件".to_string()
                } else {
                    "通道已打通，尚未收到真实会话事件".to_string()
                }
            }
        };
        Ok(CoverageRow {
            source_id: r.get(0)?,
            display_name: r.get(1)?,
            enabled,
            verified,
            transport_verified,
            monitored,
            last_event_at,
            level,
            explanation,
            note: if note.is_empty() {
                adapter
            } else {
                format!("{} · {}", adapter, note)
            },
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn feed(db: &Db, filter: &ActionFilter) -> AppResult<ActionFeed> {
    let cutoff = (Utc::now() - Duration::days(EVENT_LOOKBACK_DAYS)).to_rfc3339();
    db.with_read(|conn| {
        let mut rows = load_events(conn, &cutoff)?;
        let scanned_events = rows.len();
        // 预先取 ack 状态（只查本批 event id）
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let acked = load_acked(conn, &ids)?;
        let mut items = merge_events(rows.split_off(0), &acked);
        items.extend(load_reminders(conn, 100, filter.include_acked)?);

        let mut counts = ActionCounts::default();
        for it in &items {
            match it.kind.as_str() {
                "failed" => counts.failed += 1,
                "authorization" => counts.authorization += 1,
                "waiting_input" => counts.waiting_input += 1,
                "running" => counts.running += 1,
                "completed" => counts.completed += 1,
                "disconnected" => counts.disconnected += 1,
                "reminder" => counts.reminder += 1,
                _ => {}
            }
        }

        items.retain(|it| {
            if !filter.include_acked && it.acked {
                return false;
            }
            if let Some(s) = &filter.source_id {
                if !s.is_empty() && &it.source_id != s {
                    return false;
                }
            }
            if let Some(t) = &filter.task_id {
                if it.task_id.as_deref() != Some(t.as_str()) {
                    return false;
                }
            }
            if let Some(k) = &filter.kind {
                if !k.is_empty() && &it.kind != k {
                    return false;
                }
            }
            if let Some(p) = filter.priority {
                if it.priority != p {
                    return false;
                }
            }
            true
        });
        // 排序稳定：优先级 → 时间倒序
        items.sort_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| b.occurred_at.cmp(&a.occurred_at))
        });
        let limit = filter
            .limit
            .unwrap_or(ITEM_LIMIT_DEFAULT)
            .clamp(1, ITEM_LIMIT_MAX);
        let truncated = items.len() > limit;
        items.truncate(limit);

        Ok(ActionFeed {
            items,
            counts,
            coverage: coverage(conn)?,
            generated_at: crate::agents::now_iso(),
            truncated,
            scanned_events,
        })
    })
}

/// 标记已处理（幂等）。返回新写入的条数。
pub fn ack(db: &Db, event_ids: &[String]) -> AppResult<usize> {
    if event_ids.is_empty() {
        return Ok(0);
    }
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut n = 0usize;
        for id in event_ids.iter().take(500) {
            n += tx.execute(
                "INSERT OR IGNORE INTO action_acks (event_id, acked_at) VALUES (?1, ?2)",
                params![id, now],
            )?;
            // 提醒类动作的 id 即 notification_history.id：确认动作必须同时消除未读，
            // 否则收件箱会继续显示同一条提醒。
            tx.execute(
                "UPDATE notification_history SET is_read = 1 WHERE id = ?1",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(n)
    })
}

/// 取消已处理标记（用于误点恢复）。
pub fn unack(db: &Db, event_ids: &[String]) -> AppResult<usize> {
    if event_ids.is_empty() {
        return Ok(0);
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut n = 0usize;
        for id in event_ids.iter().take(500) {
            n += tx.execute("DELETE FROM action_acks WHERE event_id = ?1", params![id])?;
            tx.execute(
                "UPDATE notification_history SET is_read = 0 WHERE id = ?1",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(n)
    })
}

pub fn open_session_target(
    db: &Db,
    source_id: &str,
    session_id: &str,
) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT id FROM navigation_targets
             WHERE target_type = 'agent_session' AND agent_source_id = ?1 AND agent_session_id = ?2
             LIMIT 1",
            params![source_id, session_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(AppError::from)
    })
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn event(
        db: &Db,
        id: &str,
        source: &str,
        session: &str,
        run: &str,
        state: &str,
        message: &str,
        at: &str,
    ) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_events
                   (id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, occurred_at, dedupe_key)
                 VALUES (?1, ?2, ?3, ?4, 'status', ?5, ?6, ?7, ?7, ?8)",
                params![id, source, session, run, state, message, at, format!("test:{}", id)],
            )?;
            // 与真实摄取一致：事件到达会刷新来源的 last_event_at
            c.execute(
                "UPDATE agent_sources SET last_event_at = ?1 WHERE id = ?2",
                params![at, source],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn task(db: &Db, id: &str, title: &str, status: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'now', 'now')",
                params![id, title, status],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn classifies_and_maps_task() {
        let db = memdb();
        task(&db, "t1", "重构登录", "pending");
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, created_at)
                 VALUES ('l1', 't1', 'codex', 's1', 'now')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        event(
            &db,
            "e1",
            "codex",
            "s1",
            "r1",
            "failed",
            "测试失败",
            "2026-10-28T10:00:00+00:00",
        );
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert_eq!(f.items.len(), 1);
        assert_eq!(f.items[0].kind, "failed");
        assert_eq!(f.items[0].priority, 0);
        assert_eq!(f.items[0].task_id.as_deref(), Some("t1"));
        assert_eq!(f.items[0].task_title.as_deref(), Some("重构登录"));
    }

    #[test]
    fn authorization_is_inferred_and_marked() {
        let db = memdb();
        event(
            &db,
            "e1",
            "qoder",
            "s1",
            "r1",
            "waiting",
            "需要授权访问工作区",
            "2026-10-28T10:00:00+00:00",
        );
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert_eq!(f.items[0].kind, "authorization");
        assert!(f.items[0].authorization_inferred);
        // 普通等待不冒充授权
        event(
            &db,
            "e2",
            "qoder",
            "s2",
            "r2",
            "waiting",
            "等待输入文件名",
            "2026-10-28T10:01:00+00:00",
        );
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert!(f.items.iter().any(|i| i.kind == "waiting_input"));
    }

    #[test]
    fn merges_high_frequency_events_and_acks_all_ids() {
        let db = memdb();
        for i in 0..5 {
            event(
                &db,
                &format!("e{}", i),
                "codex",
                "s1",
                "r1",
                "failed",
                "失败",
                &format!("2026-10-28T10:0{}:00+00:00", i),
            );
        }
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert_eq!(f.items.len(), 1, "10 分钟内相同事件合并为一条");
        assert_eq!(f.items[0].count, 5);
        assert_eq!(f.items[0].event_ids.len(), 5);
        // 部分确认不算已处理
        ack(&db, &["e0".to_string()]).unwrap();
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert!(!f.items[0].acked);
        ack(&db, &f.items[0].event_ids).unwrap();
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert!(f.items.is_empty(), "全部确认后默认不再显示");
        let all = feed(
            &db,
            &ActionFilter {
                include_acked: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(all.items[0].acked);
    }

    #[test]
    fn filters_by_kind_priority_and_task() {
        let db = memdb();
        task(&db, "t1", "任务一", "pending");
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, created_at)
                 VALUES ('l1', 't1', 'codex', 's1', 'now')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        event(
            &db,
            "e1",
            "codex",
            "s1",
            "r1",
            "failed",
            "x",
            "2026-10-28T10:00:00+00:00",
        );
        event(
            &db,
            "e2",
            "trae",
            "s2",
            "r2",
            "running",
            "y",
            "2026-10-28T10:01:00+00:00",
        );
        let only_failed = feed(
            &db,
            &ActionFilter {
                kind: Some("failed".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_failed.items.len(), 1);
        let only_task = feed(
            &db,
            &ActionFilter {
                task_id: Some("t1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_task.items.len(), 1);
        assert_eq!(only_task.items[0].source_id, "codex");
        let only_p2 = feed(
            &db,
            &ActionFilter {
                priority: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_p2.items.len(), 1);
        assert_eq!(only_p2.items[0].kind, "running");
    }

    #[test]
    fn coverage_never_fakes_monitoring() {
        let db = memdb();
        let f = feed(&db, &ActionFilter::default()).unwrap();
        let zcode = f.coverage.iter().find(|c| c.source_id == "zcode").unwrap();
        assert_eq!(zcode.level, "no-events");
        assert!(!zcode.monitored, "未收到真实事件的来源不得标记为监控中");
        // 自测事件只证明通道，不产生动作、不代表 live
        event(
            &db,
            "e1",
            "codex",
            "taskdock-selftest-codex",
            "r1",
            "running",
            "",
            "2026-10-28T10:00:00+00:00",
        );
        let f = feed(&db, &ActionFilter::default()).unwrap();
        let codex = f.coverage.iter().find(|c| c.source_id == "codex").unwrap();
        assert_eq!(codex.level, "not-configured");
        assert!(!codex.verified);
        assert!(f
            .items
            .iter()
            .all(|i| i.kind != "running" || i.source_id != "codex"));
    }

    #[test]
    fn unread_reminders_appear_as_actions() {
        let db = memdb();
        task(&db, "t1", "交报告", "pending");
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
                 VALUES ('n1', 'reminder', '任务提醒', '交报告', 'task', 't1', 'occ', 0, '2026-10-28T10:00:00+00:00')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let f = feed(&db, &ActionFilter::default()).unwrap();
        assert!(f
            .items
            .iter()
            .any(|i| i.kind == "reminder" && i.task_id.as_deref() == Some("t1")));
    }
}
