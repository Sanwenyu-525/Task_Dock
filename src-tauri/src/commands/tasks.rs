//! 任务管理命令：CRUD、快速录入、筛选视图、重复任务、稍后提醒、Agent 关联。

use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

use crate::agents::{now_iso, validate_session_id, AgentHub};
use crate::db::{Db, RecurrenceRule, Task, TaskAgentLink};
use crate::error::{AppError, AppResult};
use crate::nlp;
use crate::recurrence::RecurrenceRuleInput;

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
    pub view: Option<String>,   // today | tomorrow | week | all | overdue
    pub status: Option<String>, // pending | completed | all
    pub category: Option<String>,
    pub tag: Option<String>,
    pub priority: Option<u8>,
    pub search: Option<String>,
    pub sort: Option<String>, // due | priority | created
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
        Local
            .from_local_datetime(&start)
            .unwrap()
            .with_timezone(&Utc),
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
        by_weekday: serde_json::from_str(&row.get::<_, String>(16).unwrap_or_default())
            .unwrap_or_default(),
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
fn insert_rule_tx(
    conn: &rusqlite::Connection,
    input: &RecurrenceRuleInput,
    anchor_date: &str,
) -> AppResult<Option<String>> {
    if input.freq.is_empty() {
        return Ok(None);
    }
    let id = uuid::Uuid::new_v4().to_string();
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
    Ok(Some(id))
}

/// 重建任务的提醒行（截止 + 提前）。在调用方事务内执行。
fn rebuild_reminders_tx(
    conn: &rusqlite::Connection,
    task_id: &str,
    due_at: Option<&str>,
    remind_at: Option<&str>,
    advance_minutes: i64,
) -> AppResult<()> {
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
            let kind = if due_at.map(|d| d == remind).unwrap_or(false) {
                "due"
            } else {
                "custom"
            };
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
                let adv =
                    (due_dt.with_timezone(&Utc) - Duration::minutes(advance_minutes)).to_rfc3339();
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
    Ok(())
}

fn get_task(db: &Db, id: &str) -> AppResult<Task> {
    db.with_conn(|conn| {
        conn.query_row(
            &format!("{} WHERE t.id = ?1", TASK_SELECT),
            rusqlite::params![id],
            row_to_task,
        )
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
            sql += &format!(
                " AND t.due_at IS NOT NULL AND t.due_at < ?{} AND t.status = 'pending'",
                idx
            );
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
        Some("priority") => {
            " ORDER BY t.priority ASC, t.due_at IS NULL, t.due_at ASC, t.created_at DESC"
        }
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
/// 规则、任务、提醒行在同一个事务内写入：中途失败不会留下无提醒的任务或孤儿规则。
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
        .map(|d| {
            d.with_timezone(&Local)
                .date_naive()
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string());

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let rule_id = match &input.recurrence {
            Some(r) if !r.freq.is_empty() => insert_rule_tx(&tx, r, &anchor_date)?,
            _ => None,
        };
        tx.execute(
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
        rebuild_reminders_tx(&tx, &id, due_iso.as_deref(), remind_iso.as_deref(), advance)?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })?;
    get_task(db, &id)
}

#[tauri::command]
pub fn update_task(db: State<'_, Arc<Db>>, id: String, input: TaskInput) -> AppResult<Task> {
    update_task_inner(&db, &id, input)
}

/// 更新核心：规则替换、任务更新、旧规则清理、提醒重建在同一个事务内。
/// 旧实现先删旧规则再更新任务（错误被 `let _ =` 吞掉），中途失败会让
/// ON DELETE SET NULL 静默吃掉任务的重复规则。
pub fn update_task_inner(db: &Db, id: &str, input: TaskInput) -> AppResult<Task> {
    check_title(&input.title)?;
    let existing = get_task(db, id)?;
    let due = parse_opt_utc(&input.due_at)?;
    let remind = parse_opt_utc(&input.remind_at)?;
    let priority = input.priority.unwrap_or(existing.priority).min(3);
    let advance = input
        .advance_minutes
        .unwrap_or(existing.advance_minutes)
        .max(0);
    let tags = input.tags.unwrap_or(existing.tags.clone());
    let due_iso = due.map(|d| d.to_rfc3339());
    let remind_iso = remind.map(|d| d.to_rfc3339());
    let now = now_iso();

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut next_rule: Option<String> = existing.recurrence.as_ref().map(|r| r.id.clone());
        match &input.recurrence {
            Some(r) if !r.freq.is_empty() => {
                let anchor_date = due
                    .map(|d| d.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| {
                        existing
                            .recurrence
                            .as_ref()
                            .map(|r| r.anchor.clone())
                            .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string())
                    });
                let rid = insert_rule_tx(&tx, r, &anchor_date)?;
                if let Some(old) = &next_rule {
                    tx.execute("DELETE FROM recurrence_rules WHERE id = ?1", rusqlite::params![old])?;
                }
                next_rule = rid;
            }
            _ => {
                if let Some(old) = &next_rule {
                    tx.execute("DELETE FROM recurrence_rules WHERE id = ?1", rusqlite::params![old])?;
                    next_rule = None;
                }
            }
        }
        tx.execute(
            "UPDATE tasks SET title = ?1, description = ?2, priority = ?3, category = ?4, tags = ?5,
               due_at = ?6, remind_at = ?7, advance_minutes = ?8, recurrence_rule_id = ?9, updated_at = ?10
             WHERE id = ?11",
            rusqlite::params![
                input.title.trim(),
                input.description.trim(),
                priority as i64,
                input.category.clone().unwrap_or(existing.category.clone()),
                serde_json::to_string(&tags)?,
                due_iso,
                remind_iso,
                advance,
                next_rule,
                now,
                id,
            ],
        )?;
        rebuild_reminders_tx(&tx, id, due_iso.as_deref(), remind_iso.as_deref(), advance)?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })?;
    get_task(db, id)
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
        // 重新打开：状态回退与提醒重建在同一事务
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET status = 'pending', completed_at = NULL, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, id],
            )?;
            rebuild_reminders_tx(
                conn,
                &id,
                task.due_at.as_deref(),
                task.remind_at.as_deref(),
                task.advance_minutes,
            )?;
            Ok::<_, AppError>(())
        })?;
    }
    get_task(&db, &id)
}

#[tauri::command]
pub fn delete_task(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    let deleted = db.with_conn(|conn| {
        Ok(conn.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])?)
    })?;
    if deleted == 0 {
        return Err(AppError::NotFound(format!("任务不存在: {}", id)));
    }
    Ok(())
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

/// 稍后提醒：把当前未触发的提醒整体后移 N 分钟。
///
/// P0 修复：旧实现「删光未触发提醒 + 插一条 custom」，把重复任务赖以推进的
/// due 提醒一并销毁 —— custom 触发不会推进 recurrence，任务从此卡死。
/// 新实现原地后移（保留 kind 与 occurrence 标识）：
/// - 重复任务的 due 提醒保留 kind='due'，snooze 到点触发后照常推进到下一期；
/// - 一个事务内完成，无中间态。
pub fn snooze_reminder_inner(db: &Db, task_id: &str, minutes: i64) -> AppResult<()> {
    let minutes = minutes.clamp(1, 24 * 60);
    let target = (Utc::now() + Duration::minutes(minutes)).to_rfc3339();
    db.with_conn(|conn| {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1",
                rusqlite::params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("任务不存在: {}", task_id)));
        }
        let tx = conn.unchecked_transaction()?;
        let moved = tx.execute(
            "UPDATE task_reminders SET remind_at = ?1 WHERE task_id = ?2 AND fired = 0",
            rusqlite::params![target, task_id],
        )?;
        if moved == 0 {
            // 没有未触发的提醒（如全部已触发后从通知中心 snooze）：补一条一次性提醒
            tx.execute(
                "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES (?1, ?2, ?3, ?3, 'custom', 0, NULL)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, target],
            )?;
        }
        tx.commit()?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub fn snooze_reminder(db: State<'_, Arc<Db>>, task_id: String, minutes: i64) -> AppResult<()> {
    snooze_reminder_inner(&db, &task_id, minutes)
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
        conn.execute(
            "DELETE FROM task_agent_links WHERE id = ?1",
            rusqlite::params![link_id],
        )?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn create(
        db: &Db,
        title: &str,
        due_at: Option<String>,
        recurrence: Option<crate::recurrence::RecurrenceRuleInput>,
    ) -> Task {
        create_task_inner(
            db,
            TaskInput {
                title: title.into(),
                due_at,
                recurrence,
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn create_task_builds_due_and_advance_reminders() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "带提前提醒".into(),
                due_at: Some(due),
                advance_minutes: Some(30),
                ..Default::default()
            },
        )
        .unwrap();
        let (due_n, advance_n): (i64, i64) = db
            .with_conn(|c| {
                Ok((
                    c.query_row(
                        "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND kind = 'due' AND fired = 0",
                        rusqlite::params![t.id],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND kind = 'advance' AND fired = 0",
                        rusqlite::params![t.id],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(due_n, 1);
        assert_eq!(advance_n, 1);
    }

    #[test]
    fn snooze_keeps_due_reminder_and_occurrence() {
        let db = db();
        let due = (Utc::now() - chrono::Duration::minutes(3)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "到期任务".into(),
                due_at: Some(due.clone()),
                remind_at: Some(due.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        snooze_reminder_inner(&db, &t.id, 10).unwrap();
        let (kind, remind_at): (String, String) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT kind, remind_at FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![t.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(kind, "due", "非重复任务 snooze 后仍保留 due 语义");
        assert!(remind_at > due);
        // tasks.remind_at 不再被 snooze 覆盖（保留用户原始配置）
        let task_remind: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT remind_at FROM tasks WHERE id = ?1",
                    rusqlite::params![t.id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(task_remind.as_deref(), Some(due.as_str()));
    }

    #[test]
    fn snooze_with_no_pending_reminder_inserts_one_shot() {
        let db = db();
        let due = (Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        let t = create(&db, "已触发任务", Some(due), None);
        db.with_conn(|c| {
            c.execute(
                "UPDATE task_reminders SET fired = 1, fired_at = ?2 WHERE task_id = ?1",
                rusqlite::params![t.id, now_iso()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        snooze_reminder_inner(&db, &t.id, 5).unwrap();
        let n: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 0 AND kind = 'custom'",
                    rusqlite::params![t.id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 1, "无未触发提醒时 snooze 应补一条一次性提醒");
    }

    #[test]
    fn snooze_unknown_task_returns_not_found() {
        let db = db();
        let err = snooze_reminder_inner(&db, "no-such-task", 5).unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "不得对不存在的任务假报成功"
        );
    }

    #[test]
    fn update_task_removes_recurrence_and_rebuilds_in_one_tx() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let t = create(
            &db,
            "每周例会",
            Some(due.clone()),
            Some(crate::recurrence::RecurrenceRuleInput {
                freq: "weekly".into(),
                interval: 1,
                by_weekday: vec![1],
                by_monthday: None,
            }),
        );
        assert!(t.recurrence.is_some());
        let updated = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "改为一次性".into(),
                due_at: Some(due),
                recurrence: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            updated.recurrence.is_none(),
            "移除重复规则后任务不得再引用规则"
        );
        // 旧规则行已清理（无孤儿规则）
        let orphan: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM recurrence_rules", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(orphan, 0);
        // 提醒已重建
        let pending: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![t.id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(pending, 1);
    }

    #[test]
    fn update_task_replaces_recurrence_with_new_rule() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let t = create(
            &db,
            "每天日报",
            Some(due),
            Some(crate::recurrence::RecurrenceRuleInput {
                freq: "daily".into(),
                interval: 1,
                by_weekday: vec![],
                by_monthday: None,
            }),
        );
        let updated = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "每天日报".into(),
                due_at: t.due_at.clone(),
                recurrence: Some(crate::recurrence::RecurrenceRuleInput {
                    freq: "weekly".into(),
                    interval: 2,
                    by_weekday: vec![1, 3],
                    by_monthday: None,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        let rule = updated.recurrence.expect("应挂新规则");
        assert_eq!(rule.freq, "weekly");
        assert_eq!(rule.interval, 2);
        // 只有一条规则行（旧规则已删）
        let n: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM recurrence_rules", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 1);
    }
}
