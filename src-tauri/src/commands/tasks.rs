//! 任务管理命令：CRUD、快速录入、筛选视图、重复任务、稍后提醒、Agent 关联。

use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

use crate::agents::{now_iso, validate_session_id, AgentHub};
use crate::db::{Db, RecurrenceRule, Task, TaskAgentLink};
use crate::error::{AppError, AppResult};
use crate::recurrence::RecurrenceRuleInput;
use crate::nlp;

#[derive(Debug, Deserialize, Default)]
pub struct TaskInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub remind_at: Option<String>,
    #[serde(default)]
    pub advance_minutes: Option<i64>,
    #[serde(default)]
    pub recurrence: Option<RecurrenceRuleInput>,
}

#[derive(Debug, Deserialize, Default)]
pub struct TaskFilter {
    pub view: Option<String>,    // today | tomorrow | week | all | overdue
    pub status: Option<String>,  // pending | completed | all
    pub category: Option<String>,
    pub tag: Option<String>,
    pub priority: Option<u8>,
    pub search: Option<String>,
    pub sort: Option<String>,    // due | priority | created
}

fn check_title(t: &str) -> AppResult<()> {
    if t.trim().is_empty() {
        return Err(AppError::Validation("任务标题不能为空".into()));
    }
    if t.chars().count() > 200 {
        return Err(AppError::Validation("任务标题超过 200 字符".into()));
    }
    Ok(())
}

fn parse_opt_utc(s: &Option<String>) -> AppResult<Option<DateTime<Utc>>> {
    match s {
        None => Ok(None),
        Some(v) if v.trim().is_empty() => Ok(None),
        Some(v) => DateTime::parse_from_rfc3339(v)
            .map(|dt| Some(dt.with_timezone(&Utc)))
            .map_err(|_| AppError::Validation(format!("非法时间: {}", v))),
    }
}

fn local_day_bounds() -> (DateTime<Utc>, DateTime<Utc>) {
    let today = Local::now().date_naive();
    let start = today.and_hms_opt(0, 0, 0).unwrap();
    let end = (today + Duration::days(1)).and_hms_opt(0, 0, 0).unwrap();
    (
        Local.from_local_datetime(&start).unwrap().with_timezone(&Utc),
        Local.from_local_datetime(&end).unwrap().with_timezone(&Utc),
    )
}

const TASK_SELECT: &str = "SELECT t.id, t.title, t.description, t.priority, t.status, t.category, t.tags, t.due_at, t.remind_at, t.advance_minutes, t.created_at, t.updated_at, t.completed_at,
     rr.id, rr.freq, rr.interval, rr.by_weekday, rr.by_monthday, rr.until, rr.anchor,
     (SELECT COUNT(*) FROM task_agent_links l WHERE l.task_id = t.id)
   FROM tasks t
   LEFT JOIN recurrence_rules rr ON rr.id = t.recurrence_rule_id";

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let rule_id: Option<String> = row.get(13)?;
    let recurrence = rule_id.map(|id| RecurrenceRule {
        id,
        freq: row.get::<_, String>(14).unwrap_or_default(),
        interval: row.get::<_, i64>(15).unwrap_or(1),
        by_weekday: serde_json::from_str(&row.get::<_, String>(16).unwrap_or_default()).unwrap_or_default(),
        by_monthday: row.get::<_, Option<u32>>(17).unwrap_or(None),
        until: row.get::<_, Option<String>>(18).unwrap_or(None),
        anchor: row.get::<_, String>(19).unwrap_or_default(),
    });
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        priority: row.get::<_, i64>(3)? as u8,
        status: row.get(4)?,
        category: row.get(5)?,
        tags: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        due_at: row.get(7)?,
        remind_at: row.get(8)?,
        advance_minutes: row.get(9)?,
        recurrence,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        completed_at: row.get(12)?,
        linked_agents: row.get(20)?,
    })
}

/// 写入/替换重复规则，返回规则 id。
fn upsert_rule(db: &Db, input: &RecurrenceRuleInput, anchor_date: &str) -> AppResult<Option<String>> {
    if input.freq.is_empty() {
        return Ok(None);
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, until, anchor, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                input.freq,
                input.interval.max(1),
                serde_json::to_string(&input.by_weekday)?,
                input.by_monthday,
                Option::<String>::None,
                anchor_date,
                now_iso(),
            ],
        )?;
        Ok::<_, AppError>(Some(id))
    })
}

/// 重建任务的提醒行（截止 + 提前）。
fn rebuild_reminders(db: &Db, task_id: &str, due_at: Option<&str>, remind_at: Option<&str>, advance_minutes: i64) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM task_reminders WHERE task_id = ?1 AND fired = 0",
            rusqlite::params![task_id],
        )?;
        let mut occ = std::collections::HashSet::new();
        if let Some(due) = due_at {
            if occ.insert(due.to_string()) {
                conn.execute(
                    "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                     VALUES (?1, ?2, ?3, ?3, 'due', 0, NULL)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, due],
                )?;
            }
        }
        if let Some(remind) = remind_at {
            if occ.insert(remind.to_string()) {
                let kind = if due_at.map(|d| d == remind).unwrap_or(false) { "due" } else { "custom" };
                conn.execute(
                    "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                     VALUES (?1, ?2, ?3, ?3, ?4, 0, NULL)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, remind, kind],
                )?;
            }
        }
        if advance_minutes > 0 {
            if let Some(due) = due_at {
                if let Ok(due_dt) = DateTime::parse_from_rfc3339(due) {
                    let adv = (due_dt.with_timezone(&Utc) - Duration::minutes(advance_minutes)).to_rfc3339();
                    if occ.insert(adv.clone()) {
                        conn.execute(
                            "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                             VALUES (?1, ?2, ?3, ?3, 'advance', 0, NULL)",
                            rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, adv],
                        )?;
                    }
                }
            }
        }
        Ok::<_, AppError>(())
    })
}

fn get_task(db: &Db, id: &str) -> AppResult<Task> {
    db.with_conn(|conn| {
        conn.query_row(&format!("{} WHERE t.id = ?1", TASK_SELECT), rusqlite::params![id], row_to_task)
            .optional()
            .map_err(AppError::from)
    })?
    .ok_or_else(|| AppError::NotFound(format!("任务不存在: {}", id)))
}

#[tauri::command]
pub fn list_tasks(db: State<'_, Arc<Db>>, filter: TaskFilter) -> AppResult<Vec<Task>> {
    let mut sql = format!("{} WHERE 1=1", TASK_SELECT);
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut idx = 1;

    let (today_start, tomorrow_start) = local_day_bounds();
    match filter.view.as_deref() {
        Some("today") => {
            sql += &format!(" AND (t.due_at IS NULL OR t.due_at < ?{})", idx);
            params.push(Box::new(tomorrow_start.to_rfc3339()));
            idx += 1;
        }
        Some("tomorrow") => {
            sql += &format!(" AND t.due_at >= ?{} AND t.due_at < ?{}", idx, idx + 1);
            params.push(Box::new(tomorrow_start.to_rfc3339()));
            params.push(Box::new((tomorrow_start + Duration::days(1)).to_rfc3339()));
            idx += 2;
        }
        Some("week") => {
            sql += &format!(" AND (t.due_at IS NULL OR t.due_at < ?{})", idx);
            params.push(Box::new((today_start + Duration::days(7)).to_rfc3339()));
            idx += 1;
        }
        Some("overdue") => {
            sql += &format!(" AND t.due_at IS NOT NULL AND t.due_at < ?{} AND t.status = 'pending'", idx);
            params.push(Box::new(now_iso()));
            idx += 1;
        }
        _ => {}
    }
    if let Some(status) = &filter.status {
        if status != "all" {
            sql += &format!(" AND t.status = ?{}", idx);
            params.push(Box::new(status.clone()));
            idx += 1;
        }
    } else {
        sql += " AND t.status = 'pending'";
    }
    if let Some(cat) = &filter.category {
        if !cat.is_empty() {
            sql += &format!(" AND t.category = ?{}", idx);
            params.push(Box::new(cat.clone()));
            idx += 1;
        }
    }
    if let Some(tag) = &filter.tag {
        if !tag.is_empty() {
            sql += &format!(" AND t.tags LIKE ?{}", idx);
            params.push(Box::new(format!("%\"{}\"%%", tag)));
            idx += 1;
        }
    }
    if let Some(p) = filter.priority {
        sql += &format!(" AND t.priority = ?{}", idx);
        params.push(Box::new(p as i64));
        idx += 1;
    }
    if let Some(q) = &filter.search {
        if !q.trim().is_empty() {
            sql += &format!(" AND (t.title LIKE ?{0} OR t.description LIKE ?{0})", idx);
            params.push(Box::new(format!("%{}%", q.trim())));
            idx += 1;
        }
    }
    let order = match filter.sort.as_deref() {
        Some("priority") => " ORDER BY t.priority ASC, t.due_at IS NULL, t.due_at ASC, t.created_at DESC",
        Some("created") => " ORDER BY t.created_at DESC",
        _ => " ORDER BY t.due_at IS NULL, t.due_at ASC, t.priority ASC, t.created_at DESC",
    };
    sql += order;
    let _ = idx;

    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_ref.as_slice(), row_to_task)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

#[tauri::command]
pub fn create_task(db: State<'_, Arc<Db>>, input: TaskInput) -> AppResult<Task> {
    create_task_inner(&db, input)
}

/// 全局任务统计（跨所有视图/筛选，供极简模式、徽标与概览使用）。
#[derive(Debug, serde::Serialize)]
pub struct TaskStats {
    pub pending: i64,
    pub overdue: i64,
    pub due_today: i64,
    pub completed_today: i64,
    /// 最早未完成截止时间（ISO8601，无则 NULL）
    pub next_due_at: Option<String>,
}

#[tauri::command]
pub fn task_stats(db: State<'_, Arc<Db>>) -> AppResult<TaskStats> {
    let (today_start, tomorrow_start) = local_day_bounds();
    let now = now_iso();
    db.with_conn(|conn| {
        let count = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> AppResult<i64> {
            Ok(conn.query_row(sql, p, |r| r.get(0))?)
        };
        let pending = count(
            "SELECT COUNT(*) FROM tasks WHERE status = 'pending'",
            &[],
        )?;
        let overdue = count(
            "SELECT COUNT(*) FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < ?1",
            &[&now],
        )?;
        let due_today = count(
            "SELECT COUNT(*) FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at >= ?1 AND due_at < ?2",
            &[&today_start.to_rfc3339() as &dyn rusqlite::ToSql, &tomorrow_start.to_rfc3339()],
        )?;
        let completed_today = count(
            "SELECT COUNT(*) FROM tasks WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at >= ?1",
            &[&today_start.to_rfc3339()],
        )?;
        let next_due_at: Option<String> = conn
            .query_row(
                "SELECT MIN(due_at) FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at >= ?1",
                rusqlite::params![now],
                |r| r.get(0),
            )
            .unwrap_or(None);
        Ok(TaskStats { pending, overdue, due_today, completed_today, next_due_at })
    })
}

/// 创建任务的核心逻辑（命令与内部调用共用）。
pub fn create_task_inner(db: &Db, input: TaskInput) -> AppResult<Task> {
    check_title(&input.title)?;
    let due = parse_opt_utc(&input.due_at)?;
    let remind = parse_opt_utc(&input.remind_at)?;
    let priority = input.priority.unwrap_or(2).min(3);
    let advance = input.advance_minutes.unwrap_or(0).max(0);
    let tags = input.tags.unwrap_or_default();
    if tags.len() > 20 {
        return Err(AppError::Validation("标签最多 20 个".into()));
    }
    let now = now_iso();
    let id = uuid::Uuid::new_v4().to_string();
    let due_iso = due.map(|d| d.to_rfc3339());
    let remind_iso = remind.map(|d| d.to_rfc3339());
    let anchor_date = due
        .map(|d| d.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string());

    let rule_id = match &input.recurrence {
        Some(r) if !r.freq.is_empty() => upsert_rule(&db, r, &anchor_date)?,
        _ => None,
    };
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, NULL)",
            rusqlite::params![
                id,
                input.title.trim(),
                input.description.trim(),
                priority as i64,
                input.category.clone().unwrap_or_default(),
                serde_json::to_string(&tags)?,
                due_iso,
                remind_iso,
                advance,
                rule_id,
                now,
            ],
        )?;
        Ok::<_, AppError>(())
    })?;
    rebuild_reminders(&db, &id, due_iso.as_deref(), remind_iso.as_deref(), advance)?;
    get_task(&db, &id)
}

#[tauri::command]
pub fn update_task(db: State<'_, Arc<Db>>, id: String, input: TaskInput) -> AppResult<Task> {
    check_title(&input.title)?;
    let existing = get_task(&db, &id)?;
    let due = parse_opt_utc(&input.due_at)?;
    let remind = parse_opt_utc(&input.remind_at)?;
    let priority = input.priority.unwrap_or(existing.priority).min(3);
    let advance = input.advance_minutes.unwrap_or(existing.advance_minutes).max(0);
    let tags = input.tags.unwrap_or(existing.tags.clone());
    let due_iso = due.map(|d| d.to_rfc3339());
    let remind_iso = remind.map(|d| d.to_rfc3339());
    let now = now_iso();

    // 重复规则替换
    let mut new_rule_id: Option<String> = existing.recurrence.as_ref().map(|r| r.id.clone());
    match &input.recurrence {
        Some(r) if !r.freq.is_empty() => {
            let anchor_date = due
                .map(|d| d.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| existing.recurrence.as_ref().map(|r| r.anchor.clone()).unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string()));
            let rid = upsert_rule(&db, r, &anchor_date)?;
            if let Some(old) = &new_rule_id {
                let _ = db.with_conn(|conn| {
                    conn.execute("DELETE FROM recurrence_rules WHERE id = ?1", rusqlite::params![old])?;
                    Ok::<_, AppError>(())
                });
            }
            new_rule_id = rid;
        }
        _ => {
            if let Some(old) = &new_rule_id {
                let _ = db.with_conn(|conn| {
                    conn.execute("DELETE FROM recurrence_rules WHERE id = ?1", rusqlite::params![old])?;
                    Ok::<_, AppError>(())
                });
                new_rule_id = None;
            }
        }
    }

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tasks SET title = ?1, description = ?2, priority = ?3, category = ?4, tags = ?5,
               due_at = ?6, remind_at = ?7, advance_minutes = ?8, recurrence_rule_id = ?9, updated_at = ?10
             WHERE id = ?11",
            rusqlite::params![
                input.title.trim(),
                input.description.trim(),
                priority as i64,
                input.category.unwrap_or(existing.category.clone()),
                serde_json::to_string(&tags)?,
                due_iso,
                remind_iso,
                advance,
                new_rule_id,
                now,
                id,
            ],
        )?;
        Ok::<_, AppError>(())
    })?;
    rebuild_reminders(&db, &id, due_iso.as_deref(), remind_iso.as_deref(), advance)?;
    get_task(&db, &id)
}

#[tauri::command]
pub fn toggle_task(db: State<'_, Arc<Db>>, id: String) -> AppResult<Task> {
    let task = get_task(&db, &id)?;
    let now = now_iso();
    if task.status == "pending" {
        if task.recurrence.is_some() {
            // 重复任务：完成即推进到下一次，任务本身保持 pending（循环任务）
            crate::scheduler::advance_task_now(&db, &id)?;
            return get_task(&db, &id);
        }
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, id],
            )?;
            conn.execute(
                "UPDATE task_reminders SET fired = 1, fired_at = ?1 WHERE task_id = ?2 AND fired = 0",
                rusqlite::params![now, id],
            )?;
            Ok::<_, AppError>(())
        })?;
    } else {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET status = 'pending', completed_at = NULL, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, id],
            )?;
            Ok::<_, AppError>(())
        })?;
        rebuild_reminders(&db, &id, task.due_at.as_deref(), task.remind_at.as_deref(), task.advance_minutes)?;
    }
    get_task(&db, &id)
}

#[tauri::command]
pub fn delete_task(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])?;
        Ok::<_, AppError>(())
    })
}

/// 自然语言解析预览（不落库）。
#[tauri::command]
pub fn parse_quick_add(text: String) -> AppResult<nlp::ParsedInput> {
    if text.trim().is_empty() {
        return Err(AppError::Validation("内容为空".into()));
    }
    Ok(nlp::parse(&text))
}

/// 从自然语言直接创建任务（用户确认后的结果）。
#[tauri::command]
pub fn create_from_quick_add(
    db: State<'_, Arc<Db>>,
    text: String,
    due_at: Option<String>,
    recurrence: Option<RecurrenceRuleInput>,
    advance_minutes: Option<i64>,
) -> AppResult<Task> {
    let parsed = nlp::parse(&text);
    let input = TaskInput {
        title: parsed.title,
        description: String::new(),
        priority: None,
        category: None,
        tags: None,
        due_at: due_at.or_else(|| parsed.due_at.map(|d| d.with_timezone(&Utc).to_rfc3339())),
        remind_at: None,
        advance_minutes: advance_minutes.or(parsed.advance_minutes),
        recurrence: recurrence.or(parsed.recurrence),
    };
    create_task(db, input)
}

/// 稍后提醒：取消未触发提醒，改为 N 分钟后。
#[tauri::command]
pub fn snooze_reminder(db: State<'_, Arc<Db>>, task_id: String, minutes: i64) -> AppResult<()> {
    let minutes = minutes.clamp(1, 24 * 60);
    let target = (Utc::now() + Duration::minutes(minutes)).to_rfc3339();
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM task_reminders WHERE task_id = ?1 AND fired = 0",
            rusqlite::params![task_id],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
             VALUES (?1, ?2, ?3, ?3, 'custom', 0, NULL)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, target],
        )?;
        conn.execute(
            "UPDATE tasks SET remind_at = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![target, now_iso(), task_id],
        )?;
        Ok::<_, AppError>(())
    })
}

// ── 任务 ↔ Agent 关联 ────────────────────────────────────────

#[tauri::command]
pub fn link_task_agent(
    db: State<'_, Arc<Db>>,
    hub: State<'_, std::sync::Arc<AgentHub>>,
    task_id: String,
    source_id: String,
    session_external_id: String,
    run_external_id: Option<String>,
) -> AppResult<TaskAgentLink> {
    validate_session_id(&session_external_id)?;
    if let Some(r) = &run_external_id {
        validate_session_id(r)?;
    }
    let task = get_task(&db, &task_id)?;
    let _ = task;
    let source_exists = db.with_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM agent_sources WHERE id = ?1",
            rusqlite::params![source_id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(AppError::from)
    })?;
    if source_exists == 0 {
        return Err(AppError::Validation(format!("未注册的来源: {}", source_id)));
    }
    let _ = &hub;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (
               SELECT 1 FROM task_agent_links WHERE task_id = ?2 AND source_id = ?3 AND session_external_id = ?4 AND IFNULL(run_external_id,'') = IFNULL(?5,'')
             )",
            rusqlite::params![id, task_id, source_id, session_external_id, run_external_id, now],
        )?;
        Ok::<_, AppError>(())
    })?;
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT id, task_id, source_id, session_external_id, run_external_id, created_at
             FROM task_agent_links WHERE task_id = ?1 AND source_id = ?2 AND session_external_id = ?3",
            rusqlite::params![task_id, source_id, session_external_id],
            |r| {
                Ok(TaskAgentLink {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    source_id: r.get(2)?,
                    session_external_id: r.get(3)?,
                    run_external_id: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )
        .map_err(AppError::from)
    })
}

#[tauri::command]
pub fn unlink_task_agent(db: State<'_, Arc<Db>>, link_id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM task_agent_links WHERE id = ?1", rusqlite::params![link_id])?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn list_task_links(db: State<'_, Arc<Db>>, task_id: String) -> AppResult<Vec<TaskAgentLink>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, task_id, source_id, session_external_id, run_external_id, created_at
             FROM task_agent_links WHERE task_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![task_id], |r| {
            Ok(TaskAgentLink {
                id: r.get(0)?,
                task_id: r.get(1)?,
                source_id: r.get(2)?,
                session_external_id: r.get(3)?,
                run_external_id: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

/// Agent 执行结果中的待处理事项 → 新普通任务（必须经用户确认后由前端调用）。
#[tauri::command]
pub fn pending_items_to_tasks(db: State<'_, Arc<Db>>, items: Vec<String>) -> AppResult<Vec<Task>> {
    let mut out = Vec::new();
    for item in items {
        let item = item.trim();
        if item.is_empty() || item.chars().count() > 200 {
            continue;
        }
        let task = create_task_inner(
            &db,
            TaskInput {
                title: item.to_string(),
                ..Default::default()
            },
        )?;
        out.push(task);
    }
    Ok(out)
}
