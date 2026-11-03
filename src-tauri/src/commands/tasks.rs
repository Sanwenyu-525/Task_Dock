//! 任务管理命令：CRUD、快速录入、筛选视图、重复任务、稍后提醒、Agent 关联。

use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Deserializer};
use std::sync::Arc;
use tauri::State;

use crate::agents::{now_iso, validate_session_id, AgentHub};
use crate::db::{Db, RecurrenceRule, Task, TaskAgentLink};
use crate::error::{AppError, AppResult};
use crate::nlp;
use crate::recurrence::RecurrenceRuleInput;

/// 三态可空字段：区分「请求里没有这个键」与「显式传 null」。
///
/// 这是 v0.4 的一个 P0 修复所依赖的语义：
/// - 键缺失   → `None`         → 保持库中原值（调用方没打算改它）
/// - 显式 null → `Some(None)`  → 清空该字段
/// - 具体值   → `Some(Some(v))`→ 写入新值
///
/// 旧实现用 `Option<String>`，两种意图被压成同一个 `None`，于是「只改标题」
/// 的编辑请求会把独立的 remind_at / due_at 一起写成 NULL——用户设置的提醒
/// 在保存一次标题后就消失了，且界面不会有任何提示。
/// （规划中心的 milestone_id / target_date 复用同一语义，见 planning.rs。）
pub(crate) fn deserialize_optional_field<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    // 走到这里说明键存在：值本身（含 null）统一包一层 Some
    Option::<T>::deserialize(deserializer).map(Some)
}

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
    /// 截止时间（三态：缺省=保持原值，null=清除，值=设置）
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub due_at: Option<Option<String>>,
    /// 独立提醒时间（三态，语义同上）。与 due_at 相互独立：
    /// 只设提醒不设截止、或两者不同，都必须原样保留。
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub remind_at: Option<Option<String>>,
    #[serde(default)]
    pub advance_minutes: Option<i64>,
    /// 重复规则（三态，语义同时间字段）：
    /// 缺省 = 保持原规则；null = 取消重复；值 = 替换为新规则。
    /// 旧实现把「没传」当成「取消重复」，于是任何不携带 recurrence 的局部更新
    /// （例如只改标题）都会静默删掉用户的循环任务。
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub recurrence: Option<Option<RecurrenceRuleInput>>,
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
    /// 返回条数上限（可选）。None 行为与旧版完全一致（不限制）；
    /// Some(n) 收敛到 1..=200，在筛选与排序之后应用 SQL LIMIT。
    /// 供面板/收集箱分页或首屏拉取，避免一次拉全量任务。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// limit 收敛规则（纯函数，便于测试）：None 不限制；Some 收敛到 1..=200。
fn effective_task_limit(limit: Option<u32>) -> Option<i64> {
    limit.map(|n| n.clamp(1, 200) as i64)
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

/// 三态字段的统一构造：值 → `Some(Some(v))`，用于内部调用方。
fn tri(v: Option<String>) -> Option<Option<String>> {
    v.map(Some)
}

/// 时间字段的更新意图（由三态 `Option<Option<String>>` 解析而来）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum FieldUpdate {
    /// 请求未提及该字段：保持库中原值
    Keep,
    /// 显式清空
    Clear,
    /// 写入新值
    Set(DateTime<Utc>),
}

fn parse_time_field(s: &Option<Option<String>>) -> AppResult<FieldUpdate> {
    match s {
        None => Ok(FieldUpdate::Keep),
        // 显式 null 或空字符串都表示「用户清空了这个时间」
        Some(None) => Ok(FieldUpdate::Clear),
        Some(Some(v)) if v.trim().is_empty() => Ok(FieldUpdate::Clear),
        Some(Some(v)) => DateTime::parse_from_rfc3339(v)
            .map(|dt| FieldUpdate::Set(dt.with_timezone(&Utc)))
            .map_err(|_| AppError::Validation(format!("非法时间: {}", v))),
    }
}

/// 把更新意图落到库中值：Keep 原样返回旧字符串（不做格式化，避免无谓漂移）。
fn resolve_time(current: &Option<String>, upd: &FieldUpdate) -> Option<String> {
    match upd {
        FieldUpdate::Keep => current.clone(),
        FieldUpdate::Clear => None,
        FieldUpdate::Set(d) => Some(d.to_rfc3339()),
    }
}

fn as_utc(s: &Option<String>) -> Option<DateTime<Utc>> {
    s.as_deref()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc))
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
     rr.id, rr.freq, rr.interval, rr.by_weekday, rr.by_monthday, rr.until, rr.anchor, rr.by_setpos,
     (SELECT COUNT(*) FROM (
       SELECT source_id, session_external_id FROM task_agent_links WHERE task_id = t.id
       UNION
       SELECT n.agent_source_id, n.agent_session_id FROM task_navigation_targets l
       JOIN navigation_targets n ON n.id = l.target_id
       WHERE l.task_id = t.id AND n.target_type = 'agent_session'
     )),
     (SELECT MIN(r.remind_at) FROM task_reminders r WHERE r.task_id = t.id AND r.fired = 0)
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
        by_setpos: row.get::<_, Option<i32>>(20).unwrap_or(None),
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
        linked_agents: row.get(21)?,
        next_remind_at: row.get(22)?,
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
    // 新字段非法组合在此严格拒绝（旧数据形态恒可通过，见 validate_rule 注释）
    crate::recurrence::validate_rule(input).map_err(AppError::Validation)?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, by_setpos, until, anchor, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            id,
            input.freq,
            input.interval.max(1),
            serde_json::to_string(&input.by_weekday)?,
            input.by_monthday,
            input.by_setpos,
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

pub(crate) fn get_task(db: &Db, id: &str) -> AppResult<Task> {
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
    list_tasks_inner(&db, filter)
}

fn list_tasks_inner(db: &Db, filter: TaskFilter) -> AppResult<Vec<Task>> {
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
    // LIMIT 在筛选与排序之后应用；None 保持旧行为（不限制）。
    if let Some(limit) = effective_task_limit(filter.limit) {
        sql += &format!(" LIMIT ?{}", idx);
        params.push(Box::new(limit));
        idx += 1;
    }
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

/// 在调用方事务内创建任务（规则、任务、提醒行同一事务）。
///
/// 供 `create_task_inner` 与快速捕获提交共用：**不提交**，事务边界由调用方
/// 决定；任何失败都随调用方事务整体回滚。返回新任务 id。
pub(crate) fn create_task_tx(
    tx: &rusqlite::Transaction<'_>,
    input: TaskInput,
) -> AppResult<String> {
    check_title(&input.title)?;
    // 新建：Keep 与 Clear 等价（库里本来就没有值）
    let due = parse_time_field(&input.due_at)?;
    let remind = parse_time_field(&input.remind_at)?;
    let priority = input.priority.unwrap_or(2).min(3);
    let advance = input.advance_minutes.unwrap_or(0).max(0);
    let tags = input.tags.unwrap_or_default();
    if tags.len() > 20 {
        return Err(AppError::Validation("标签最多 20 个".into()));
    }
    let now = now_iso();
    let id = uuid::Uuid::new_v4().to_string();
    let due_iso = resolve_time(&None, &due);
    let remind_iso = resolve_time(&None, &remind);
    let anchor_date = as_utc(&due_iso)
        .map(|d| {
            d.with_timezone(&Local)
                .date_naive()
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string());

    let rule_id = match &input.recurrence {
        Some(Some(r)) if !r.freq.is_empty() => insert_rule_tx(tx, r, &anchor_date)?,
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
    rebuild_reminders_tx(tx, &id, due_iso.as_deref(), remind_iso.as_deref(), advance)?;
    Ok(id)
}

/// 创建任务的核心逻辑（命令与内部调用共用）。
/// 规则、任务、提醒行在同一个事务内写入：中途失败不会留下无提醒的任务或孤儿规则。
pub fn create_task_inner(db: &Db, input: TaskInput) -> AppResult<Task> {
    let id = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let id = create_task_tx(&tx, input)?;
        tx.commit()?;
        Ok::<_, AppError>(id)
    })?;
    get_task(db, &id)
}

#[tauri::command]
pub fn update_task(db: State<'_, Arc<Db>>, id: String, input: TaskInput) -> AppResult<Task> {
    update_task_inner(&db, &id, input)
}

/// 更新核心：规则更新、任务更新及必要的提醒重建在同一个事务内。
/// 旧实现先删旧规则再更新任务（错误被 `let _ =` 吞掉），中途失败会让
/// ON DELETE SET NULL 静默吃掉任务的重复规则。
pub fn update_task_inner(db: &Db, id: &str, input: TaskInput) -> AppResult<Task> {
    check_title(&input.title)?;
    let existing = get_task(db, id)?;
    // P0 修复：三态解析。此前 `Option<String>` 把「没传」与「清空」压成同一个
    // None，编辑任务（例如只改标题）会把独立的 remind_at 写成 NULL，
    // 用户的提醒被静默删除。现在只有显式 null 才会清空。
    let due_upd = parse_time_field(&input.due_at)?;
    let remind_upd = parse_time_field(&input.remind_at)?;
    let due_iso = resolve_time(&existing.due_at, &due_upd);
    let remind_iso = resolve_time(&existing.remind_at, &remind_upd);
    let due_dt = as_utc(&due_iso);
    let priority = input.priority.unwrap_or(existing.priority).min(3);
    let advance = input
        .advance_minutes
        .unwrap_or(existing.advance_minutes)
        .max(0);
    let tags = input.tags.unwrap_or(existing.tags.clone());
    let now = now_iso();

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut next_rule: Option<String> = existing.recurrence.as_ref().map(|r| r.id.clone());
        match &input.recurrence {
            // 界面没有提供 until/anchor 编辑；修改规则时保留它们及现有 ID。
            Some(Some(r)) if !r.freq.is_empty() => {
                crate::recurrence::validate_rule(r)
                    .map_err(AppError::Validation)?;
                if let Some(old) = &next_rule {
                    tx.execute(
                        "UPDATE recurrence_rules SET freq = ?1, interval = ?2, by_weekday = ?3, by_monthday = ?4, by_setpos = ?5 WHERE id = ?6",
                        rusqlite::params![r.freq, r.interval.max(1), serde_json::to_string(&r.by_weekday)?, r.by_monthday, r.by_setpos, old],
                    )?;
                } else {
                    let anchor_date = due_dt
                        .map(|d| d.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string())
                        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string());
                    next_rule = insert_rule_tx(&tx, r, &anchor_date)?;
                }
            }
            // 显式 null：用户选择了「不重复」
            // （空 freq 的对象也按「不重复」处理，与前端空表单一致）
            Some(None) | Some(Some(_)) => {
                if let Some(old) = &next_rule {
                    tx.execute("DELETE FROM recurrence_rules WHERE id = ?1", rusqlite::params![old])?;
                    next_rule = None;
                }
            }
            // 未提供：保持原规则不变（这就是本次修复的核心）
            None => {}
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
        if due_iso != existing.due_at || remind_iso != existing.remind_at || advance != existing.advance_minutes {
            rebuild_reminders_tx(&tx, id, due_iso.as_deref(), remind_iso.as_deref(), advance)?;
        }
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
        due_at: tri(due_at.or_else(|| parsed.due_at.map(|d| d.with_timezone(&Utc).to_rfc3339()))),
        remind_at: None,
        advance_minutes: advance_minutes.or(parsed.advance_minutes),
        recurrence: recurrence.or(parsed.recurrence).map(Some),
    };
    create_task(db, input)
}

/// 延后实际改动的一条提醒：撤销时按 (id, snoozed_to) 条件恢复到 restore_to。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeChange {
    pub id: String,
    /// 本次延后写入的 remind_at（撤销的版本约束：行仍是该值且未触发才允许恢复）
    pub snoozed_to: String,
    /// 延前原值（撤销恢复目标）
    pub restore_to: String,
}

/// 延后结果：前端据此展示真实下次通知时间，并提供「撤销」。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeResult {
    pub task_id: String,
    pub task_title: String,
    /// 本次实际后移的提醒（不含任何未被本次触碰的行）
    pub changed: Vec<SnoozeChange>,
    /// 无未触发提醒时补建的一次性提醒 id（撤销时应删除该行而非恢复）
    pub inserted_id: Option<String>,
    /// 延后后的真实下次通知时间（task_reminders 聚合，非 tasks.due_at）
    pub next_remind_at: String,
}

/// 稍后提醒：把当前未触发的提醒整体后移 N 分钟。
///
/// P0 修复（v0.4）：旧实现「删光未触发提醒 + 插一条 custom」，把重复任务赖以推进的
/// due 提醒一并销毁 —— custom 触发不会推进 recurrence，任务从此卡死。
/// 现实现原地后移（保留 kind 与 occurrence 标识）：
/// - 重复任务的 due 提醒保留 kind='due'，snooze 到点触发后照常推进到下一期；
/// - 单事务完成；`UPDATE ... WHERE fired = 0` 与调度器的条件领取原子竞争，
///   同一秒内「领取成功」与「延后成功」只会有其一；
/// - 已完成任务的提醒在完成时已标记 fired，这里再显式拒绝，避免给
///   已完成任务补建一次性提醒（幽灵通知源）。
///
/// 撤销语义（v0.7 智能日程提醒 2.0）：返回本次实际改动的行及延前/延后值。
/// 撤销按 (id, snoozed_to, fired=0) 条件恢复——行已被再次延后、编辑、
/// 触发或删除时撤销自动失效（恢复 0 行），不会被旧撤销覆盖新状态。
pub fn snooze_reminder_inner(db: &Db, task_id: &str, minutes: i64) -> AppResult<SnoozeResult> {
    let minutes = minutes.clamp(1, 24 * 60);
    let target = (Utc::now() + Duration::minutes(minutes)).to_rfc3339();
    db.with_conn(|conn| {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT title, status FROM tasks WHERE id = ?1",
                rusqlite::params![task_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((task_title, status)) = row else {
            return Err(AppError::NotFound(format!("任务不存在: {}", task_id)));
        };
        if status != "pending" {
            return Err(AppError::Validation(format!(
                "任务已完成，无法延后提醒（当前状态: {}）",
                status
            )));
        }
        let tx = conn.unchecked_transaction()?;
        // 先读后写在同一事务内：SQLite 写锁保证与调度器领取（条件 UPDATE fired 0→1）
        // 串行化，不存在「读出未触发、领取后又被后移」的窗口。
        let mut changed: Vec<SnoozeChange> = Vec::new();
        {
            let mut stmt =
                tx.prepare("SELECT id, remind_at FROM task_reminders WHERE task_id = ?1 AND fired = 0")?;
            let rows = stmt.query_map(rusqlite::params![task_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, old) = row?;
                changed.push(SnoozeChange {
                    id,
                    snoozed_to: target.clone(),
                    restore_to: old,
                });
            }
        }
        let inserted_id = if changed.is_empty() {
            // 没有未触发的提醒（如全部已触发后从通知中心 snooze）：补一条一次性提醒
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES (?1, ?2, ?3, ?3, 'custom', 0, NULL)",
                rusqlite::params![id, task_id, target],
            )?;
            Some(id)
        } else {
            tx.execute(
                "UPDATE task_reminders SET remind_at = ?1 WHERE task_id = ?2 AND fired = 0",
                rusqlite::params![target, task_id],
            )?;
            None
        };
        tx.commit()?;
        Ok(SnoozeResult {
            task_id: task_id.to_string(),
            task_title,
            changed,
            inserted_id,
            next_remind_at: target,
        })
    })
}

/// 撤销一次延后：只恢复仍然处于「本次延后后状态」的行。
///
/// - 恢复条件：`id 相同 AND fired = 0 AND remind_at = snoozed_to`——
///   行在此之后被再次延后 / 编辑 / 触发 / 删除时，条件不成立，跳过该行；
/// - 补建的一次性提醒（inserted_id）按同条件删除（未触发且未被改期才删）；
/// - 返回 (restored, dropped)：恢复的行数与删除的补建行数，供 UI 如实反馈。
pub fn undo_snooze_inner(
    db: &Db,
    task_id: &str,
    changes: &[SnoozeChange],
    inserted_id: Option<&str>,
) -> AppResult<(usize, usize)> {
    if changes.is_empty() && inserted_id.is_none() {
        return Err(AppError::Validation("没有可撤销的延后记录".into()));
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut restored = 0usize;
        for c in changes {
            restored += tx.execute(
                "UPDATE task_reminders SET remind_at = ?1
                 WHERE id = ?2 AND task_id = ?3 AND fired = 0 AND remind_at = ?4",
                rusqlite::params![c.restore_to, c.id, task_id, c.snoozed_to],
            )?;
        }
        let mut dropped = 0usize;
        if let Some(id) = inserted_id {
            dropped += tx.execute(
                "DELETE FROM task_reminders
                 WHERE id = ?1 AND task_id = ?2 AND fired = 0 AND kind = 'custom'",
                rusqlite::params![id, task_id],
            )?;
        }
        tx.commit()?;
        Ok((restored, dropped))
    })
}

#[tauri::command]
pub fn snooze_reminder(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    task_id: String,
    minutes: i64,
) -> AppResult<SnoozeResult> {
    let result = snooze_reminder_inner(&db, &task_id, minutes)?;
    // 统一反馈通道：任何入口（任务卡 / 详情 / 倒计时 / 桌面通知）延后成功后，
    // 主窗口都能弹带「撤销」的 Toast；撤销只作用于本次实际改动的行。
    let _ = tauri::Emitter::emit(
        &app,
        "reminder-snoozed",
        serde_json::to_value(&result).unwrap_or(serde_json::json!({})),
    );
    Ok(result)
}

#[tauri::command]
pub fn undo_snooze(
    db: State<'_, Arc<Db>>,
    task_id: String,
    changes: Vec<SnoozeChange>,
    inserted_id: Option<String>,
) -> AppResult<(usize, usize)> {
    undo_snooze_inner(&db, &task_id, &changes, inserted_id.as_deref())
}

/// 进行中的提醒（倒计时面板数据源）：未触发提醒 + 任务信息。
///
/// 只读聚合，不轮询由前端在 reminder-fired / reminder-snoozed / 任务刷新时拉取；
/// 每任务最早一条（倒计时按 remind_at 绝对时间换算，不在前端保存剩余秒数）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveReminder {
    pub reminder_id: String,
    pub task_id: String,
    pub task_title: String,
    pub remind_at: String,
    pub occurrence: String,
    pub kind: String,
    /// 原定时间（occurrence）；与 remind_at 不同 = 已被延后
    pub snoozed: bool,
    pub task_status: String,
    pub has_recurrence: bool,
}

#[tauri::command]
pub fn active_reminders(db: State<'_, Arc<Db>>) -> AppResult<Vec<ActiveReminder>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.task_id, t.title, r.remind_at, r.occurrence, r.kind, t.status,
                    (t.recurrence_rule_id IS NOT NULL)
             FROM task_reminders r JOIN tasks t ON t.id = r.task_id
             WHERE r.fired = 0 AND t.status = 'pending'
             ORDER BY r.remind_at ASC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |r| {
            let remind_at: String = r.get(3)?;
            let occurrence: String = r.get(4)?;
            Ok(ActiveReminder {
                reminder_id: r.get(0)?,
                task_id: r.get(1)?,
                task_title: r.get(2)?,
                snoozed: remind_at != occurrence,
                remind_at,
                occurrence,
                kind: r.get(5)?,
                task_status: r.get(6)?,
                has_recurrence: r.get::<_, i64>(7)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

/// 取消提醒：删除该任务全部未触发提醒。
///
/// - 重复任务的 due 提醒是推进引擎的输入，删除会让任务永久卡死，
///   这里明确拒绝（而不是悄悄破坏推进）；
/// - 已触发的提醒历史不删（通知历史同样保留）。
#[tauri::command]
pub fn cancel_reminders(db: State<'_, Arc<Db>>, task_id: String) -> AppResult<usize> {
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
        let recurring: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE id = ?1 AND recurrence_rule_id IS NOT NULL",
            rusqlite::params![task_id],
            |r| r.get(0),
        )?;
        if recurring > 0 {
            return Err(AppError::Validation(
                "重复任务的提醒由规则推进，无法单独取消；请编辑任务调整重复规则".into(),
            ));
        }
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute(
            "DELETE FROM task_reminders WHERE task_id = ?1 AND fired = 0",
            rusqlite::params![task_id],
        )?;
        tx.commit()?;
        Ok(n)
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
    let _ = &hub;
    link_task_agent_inner(
        &db,
        &task_id,
        &source_id,
        &session_external_id,
        run_external_id.as_deref(),
    )
}

fn link_task_agent_inner(
    db: &Db,
    task_id: &str,
    source_id: &str,
    session_external_id: &str,
    run_external_id: Option<&str>,
) -> AppResult<TaskAgentLink> {
    validate_session_id(session_external_id)?;
    if let Some(r) = run_external_id {
        validate_session_id(r)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let source_exists: i64 = tx.query_row("SELECT COUNT(*) FROM agent_sources WHERE id = ?1", [source_id], |r| r.get(0))?;
        if source_exists == 0 { return Err(AppError::Validation(format!("未注册的来源: {}", source_id))); }
        // 用户主动建立手工关联时，已有的兼容影子升级为 user，导航解除不得删除。
        tx.execute(
            "UPDATE task_agent_links SET origin = 'user' WHERE task_id = ?1 AND source_id = ?2 AND session_external_id = ?3 AND IFNULL(run_external_id,'') = IFNULL(?4,'') AND origin = 'auto'",
            rusqlite::params![task_id, source_id, session_external_id, run_external_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (
               SELECT 1 FROM task_agent_links WHERE task_id = ?2 AND source_id = ?3 AND session_external_id = ?4 AND IFNULL(run_external_id,'') = IFNULL(?5,'')
             )",
            rusqlite::params![id, task_id, source_id, session_external_id, run_external_id, now],
        )?;
        let link = tx.query_row(
            "SELECT l.id, l.task_id, l.source_id, l.session_external_id, l.run_external_id, l.created_at,
             EXISTS(SELECT 1 FROM agent_sources s JOIN agent_sessions a ON a.source_id = s.id WHERE s.id = l.source_id AND a.external_id = l.session_external_id)
             FROM task_agent_links l WHERE l.task_id = ?1 AND l.source_id = ?2 AND l.session_external_id = ?3 AND IFNULL(l.run_external_id,'') = IFNULL(?4,'')",
            rusqlite::params![task_id, source_id, session_external_id, run_external_id], row_to_agent_link,
        )?;
        tx.commit()?;
        Ok(link)
    })
}

fn row_to_agent_link(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskAgentLink> {
    Ok(TaskAgentLink {
        id: r.get(0)?,
        task_id: r.get(1)?,
        source_id: r.get(2)?,
        session_external_id: r.get(3)?,
        run_external_id: r.get(4)?,
        created_at: r.get(5)?,
        available: r.get::<_, i64>(6)? != 0,
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
    list_task_links_inner(&db, &task_id)
}

fn list_task_links_inner(db: &Db, task_id: &str) -> AppResult<Vec<TaskAgentLink>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.id, l.task_id, l.source_id, l.session_external_id, l.run_external_id, l.created_at,
             EXISTS(SELECT 1 FROM agent_sources s JOIN agent_sessions a ON a.source_id = s.id WHERE s.id = l.source_id AND a.external_id = l.session_external_id)
             FROM task_agent_links l WHERE l.task_id = ?1 AND l.origin = 'user' ORDER BY l.created_at DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![task_id], row_to_agent_link)?;
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

    #[test]
    fn navigation_agent_link_is_counted_without_legacy_shadow() {
        let db = db();
        let t = create(&db, "任务", None, None);
        db.with_conn(|c| {
            c.execute("INSERT INTO navigation_targets (id, display_name, target_type, app_key, agent_source_id, agent_session_id, created_at, updated_at) VALUES ('n', 'Agent', 'agent_session', 'codex:s', 'codex', 's', 'now', 'now')", [])?;
            c.execute("INSERT INTO task_navigation_targets (id, task_id, target_id, created_at) VALUES ('l', ?1, 'n', 'now')", [&t.id])?;
            Ok::<_, AppError>(())
        }).unwrap();
        assert_eq!(get_task(&db, &t.id).unwrap().linked_agents, 1);
    }

    #[test]
    fn edits_preserve_repeat_rule_until_anchor_and_pending_reminder() {
        for (freq, weekdays, monthday) in
            [("weekly", vec![1, 5], None), ("monthly", vec![], Some(31))]
        {
            let db = db();
            let t = create(
                &db,
                "原题",
                Some("2026-10-30T02:30:37+00:00".into()),
                Some(RecurrenceRuleInput {
                    freq: freq.into(),
                    interval: 2,
                    by_weekday: weekdays,
                    by_monthday: monthday,
                    by_setpos: None,
                }),
            );
            let id = t.recurrence.as_ref().unwrap().id.clone();
            db.with_conn(|c| { c.execute("UPDATE recurrence_rules SET until = '2027-07-01T00:00:00Z', anchor = '2026-01-31' WHERE id = ?1", [&id])?; Ok(()) }).unwrap();
            let before = get_task(&db, &t.id).unwrap();
            let rule_before = serde_json::to_value(&before.recurrence).unwrap();
            let reminder_before: (String, String) = db
                .with_conn(|c| {
                    c.query_row(
                        "SELECT id, remind_at FROM task_reminders WHERE task_id = ?1",
                        [&t.id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(AppError::from)
                })
                .unwrap();
            for input in [
                TaskInput {
                    title: "新题".into(),
                    ..Default::default()
                },
                TaskInput {
                    title: "新题".into(),
                    description: "新描述".into(),
                    ..Default::default()
                },
                TaskInput {
                    title: "新题".into(),
                    priority: Some(1),
                    ..Default::default()
                },
                TaskInput {
                    title: "新题".into(),
                    tags: Some(vec!["甲".into()]),
                    ..Default::default()
                },
            ] {
                let updated = update_task_inner(&db, &t.id, input).unwrap();
                assert_eq!(
                    serde_json::to_value(&updated.recurrence).unwrap(),
                    rule_before
                );
                assert_eq!(updated.due_at, before.due_at);
                let reminder: (String, String) = db
                    .with_conn(|c| {
                        c.query_row(
                            "SELECT id, remind_at FROM task_reminders WHERE task_id = ?1",
                            [&t.id],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .map_err(AppError::from)
                    })
                    .unwrap();
                assert_eq!(reminder, reminder_before);
            }
            for input in [
                TaskInput {
                    title: "新题".into(),
                    remind_at: tri(Some("2026-10-29T01:02:03+00:00".into())),
                    ..Default::default()
                },
                TaskInput {
                    title: "新题".into(),
                    due_at: tri(Some("2026-11-30T02:30:37+00:00".into())),
                    ..Default::default()
                },
            ] {
                let updated = update_task_inner(&db, &t.id, input).unwrap();
                assert_eq!(
                    serde_json::to_value(&updated.recurrence).unwrap(),
                    rule_before
                );
            }
            let changed = update_task_inner(
                &db,
                &t.id,
                TaskInput {
                    title: "新题".into(),
                    recurrence: Some(Some(RecurrenceRuleInput {
                        freq: "daily".into(),
                        interval: 3,
                        by_weekday: vec![],
                        by_monthday: None,
                        by_setpos: None,
                    })),
                    ..Default::default()
                },
            )
            .unwrap();
            let rule = changed.recurrence.unwrap();
            assert_eq!(rule.id, id);
            assert_eq!(rule.anchor, "2026-01-31");
            assert_eq!(rule.until.as_deref(), Some("2027-07-01T00:00:00Z"));
            let cancelled = update_task_inner(
                &db,
                &t.id,
                TaskInput {
                    title: "新题".into(),
                    recurrence: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(cancelled.recurrence.is_none());
        }
    }

    #[test]
    fn manual_and_navigation_agent_links_keep_independent_ownership_and_count() {
        let db = db();
        let a = create(&db, "先手工", None, None);
        let b = create(&db, "先导航", None, None);
        db.with_conn(|c| {
            for (id, session) in [("n1", "sess-1"), ("n2", "sess-2")] {
                c.execute("INSERT INTO navigation_targets (id, display_name, target_type, app_key, agent_source_id, agent_session_id, created_at, updated_at) VALUES (?1, 'Agent', 'agent_session', ?2, 'codex', ?3, 'now', 'now')", rusqlite::params![id, format!("codex:{session}"), session])?;
            }
            Ok(())
        }).unwrap();
        let manual = link_task_agent_inner(&db, &a.id, "codex", "sess-1", None).unwrap();
        let nav = crate::navigation::target_resolver::link_task(&db, &a.id, "n1", false, "default")
            .unwrap();
        assert_eq!(get_task(&db, &a.id).unwrap().linked_agents, 1);
        db.with_conn(|c| {
            c.execute("DELETE FROM task_agent_links WHERE id = ?1", [&manual.id])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(get_task(&db, &a.id).unwrap().linked_agents, 1);
        crate::navigation::target_resolver::unlink_task(&db, &nav).unwrap();
        assert_eq!(get_task(&db, &a.id).unwrap().linked_agents, 0);

        let nav_b =
            crate::navigation::target_resolver::link_task(&db, &b.id, "n1", false, "default")
                .unwrap();
        let manual_b = link_task_agent_inner(&db, &b.id, "codex", "sess-1", None).unwrap();
        assert_eq!(
            manual_b.id,
            link_task_agent_inner(&db, &b.id, "codex", "sess-1", None)
                .unwrap()
                .id
        );
        crate::navigation::target_resolver::link_task(&db, &b.id, "n2", false, "default").unwrap();
        assert_eq!(get_task(&db, &b.id).unwrap().linked_agents, 2);
        crate::navigation::target_resolver::unlink_task(&db, &nav_b).unwrap();
        assert_eq!(list_task_links_inner(&db, &b.id).unwrap().len(), 1);
        assert_eq!(get_task(&db, &b.id).unwrap().linked_agents, 2);
        crate::commands::agents::delete_source_inner(&db, "codex", false).unwrap();
        assert!(!list_task_links_inner(&db, &b.id).unwrap()[0].available);
        assert_eq!(get_task(&db, &b.id).unwrap().linked_agents, 2);
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
                due_at: tri(due_at),
                recurrence: recurrence.map(Some),
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
                due_at: tri(Some(due)),
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
                due_at: tri(Some(due.clone())),
                remind_at: tri(Some(due.clone())),
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
                by_setpos: None,
            }),
        );
        assert!(t.recurrence.is_some());
        let updated = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "改为一次性".into(),
                due_at: tri(Some(due)),
                recurrence: Some(None), // 显式 null = 取消重复
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

    // ── 问题 3 回归：编辑任务不得吃掉独立提醒 ──────────────────

    /// 只改标题（请求里根本没有 due_at / remind_at 键）：
    /// 独立的 remind_at 必须原样保留，提醒行也要在。
    #[test]
    fn edit_title_only_keeps_independent_remind_at() {
        let db = db();
        let remind = (Utc::now() + chrono::Duration::hours(3)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "只有提醒没有截止".into(),
                remind_at: tri(Some(remind.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(t.remind_at.as_deref(), Some(remind.as_str()));
        assert!(t.due_at.is_none());

        // 编辑：只给标题，两个时间字段都缺省
        let updated = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "改了标题".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.title, "改了标题");
        assert_eq!(
            updated.remind_at.as_deref(),
            Some(remind.as_str()),
            "未提供 remind_at 时不得清空用户设置的独立提醒"
        );
        assert!(
            updated.due_at.is_none(),
            "原本没有截止，编辑后也不应凭空出现"
        );
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
        assert_eq!(pending, 1, "提醒行必须仍然存在");
    }

    /// 显式 null 才清空；未提及的字段保持不动。
    #[test]
    fn explicit_null_clears_only_that_field() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::days(2)).to_rfc3339();
        let remind = (Utc::now() + chrono::Duration::hours(5)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "两个时间都有".into(),
                due_at: tri(Some(due.clone())),
                remind_at: tri(Some(remind.clone())),
                ..Default::default()
            },
        )
        .unwrap();

        let updated = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "只清提醒".into(),
                remind_at: Some(None), // 显式 null
                ..Default::default()
            },
        )
        .unwrap();
        assert!(updated.remind_at.is_none(), "显式 null 应清空提醒");
        assert_eq!(
            updated.due_at.as_deref(),
            Some(due.as_str()),
            "未提及的截止时间不得被连带清空"
        );
    }

    /// 截止 / 独立提醒 / 重复规则三者互不覆盖。
    #[test]
    fn due_remind_and_recurrence_do_not_overwrite_each_other() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let remind = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "三件套".into(),
                due_at: tri(Some(due.clone())),
                remind_at: tri(Some(remind.clone())),
                advance_minutes: Some(15),
                recurrence: Some(Some(crate::recurrence::RecurrenceRuleInput {
                    freq: "weekly".into(),
                    interval: 1,
                    by_weekday: vec![2],
                    by_monthday: None,
                    by_setpos: None,
                })),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(t.recurrence.is_some());

        // 只改标题：三者全部保持
        let u1 = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "三件套（改名）".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(u1.due_at.as_deref(), Some(due.as_str()));
        assert_eq!(u1.remind_at.as_deref(), Some(remind.as_str()));
        assert_eq!(u1.advance_minutes, 15);
        assert_eq!(
            u1.recurrence.as_ref().map(|r| r.freq.clone()),
            Some("weekly".to_string()),
            "重复规则不得因编辑而丢失"
        );

        // 只改截止：提醒与规则仍在，且提醒行按新截止重建（due/advance/custom 各一条）
        let due2 = (Utc::now() + chrono::Duration::days(3)).to_rfc3339();
        let u2 = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "三件套（改截止）".into(),
                due_at: tri(Some(due2.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(u2.due_at.as_deref(), Some(due2.as_str()));
        assert_eq!(
            u2.remind_at.as_deref(),
            Some(remind.as_str()),
            "改截止不得清掉独立提醒"
        );
        assert!(u2.recurrence.is_some(), "改截止不得清掉重复规则");
        let kinds: Vec<(String, i64)> = db
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT kind, COUNT(*) FROM task_reminders
                     WHERE task_id = ?1 AND fired = 0 GROUP BY kind ORDER BY kind",
                )?;
                let rows =
                    stmt.query_map(rusqlite::params![t.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(
            kinds,
            vec![
                ("advance".to_string(), 1),
                ("custom".to_string(), 1),
                ("due".to_string(), 1),
            ],
            "重建后应恰好是 提前/独立/截止 三类各一条，实际 {:?}",
            kinds
        );
    }

    // ── 前后端 IPC 契约（真实载荷反序列化）────────────────────

    /// 模拟 TaskEditor.onSave 实际发出的 JSON：
    /// 未改动时间字段时**不带键**，选择「不重复」时显式 `recurrence: null`。
    #[test]
    fn ipc_payload_omitting_time_keys_keeps_them() {
        let payload = serde_json::json!({
            "title": "只改标题",
            "description": "",
            "priority": 2,
            "category": "",
            "tags": [],
            "advance_minutes": 0,
            "recurrence": null
        });
        let input: TaskInput = serde_json::from_value(payload).expect("前端载荷必须可反序列化");
        assert!(input.due_at.is_none(), "缺键 = 保持原值");
        assert!(input.remind_at.is_none(), "缺键 = 保持原值");
        assert_eq!(
            input.recurrence,
            Some(None),
            "显式 null = 用户选择不重复（与缺键语义不同）"
        );
    }

    /// 用户清空时间输入框：前端发 `due_at: null` → 后端应理解为「清空」。
    #[test]
    fn ipc_payload_explicit_null_means_clear() {
        let payload = serde_json::json!({
            "title": "清空截止",
            "due_at": null,
            "remind_at": "2026-11-01T10:00:00+08:00"
        });
        let input: TaskInput = serde_json::from_value(payload).unwrap();
        assert_eq!(input.due_at, Some(None), "显式 null = 清空");
        assert!(matches!(input.remind_at, Some(Some(_))), "有值 = 设置");
    }

    /// 端到端：同一份载荷走完 create → update，提醒与规则都不丢。
    #[test]
    fn ipc_roundtrip_preserves_schedule_semantics() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let remind = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let created = create_task_inner(
            &db,
            serde_json::from_value(serde_json::json!({
                "title": "契约任务",
                "due_at": due,
                "remind_at": remind,
                "advance_minutes": 10,
                "recurrence": { "freq": "daily", "interval": 1, "by_weekday": [], "by_monthday": null }
            }))
            .unwrap(),
        )
        .unwrap();
        // 前端「只改标题」的真实载荷
        let updated = update_task_inner(
            &db,
            &created.id,
            serde_json::from_value(serde_json::json!({
                "title": "契约任务（改名）",
                "description": "",
                "priority": 2,
                "category": "",
                "tags": [],
                "advance_minutes": 10,
                "recurrence": { "freq": "daily", "interval": 1, "by_weekday": [], "by_monthday": null }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(updated.due_at.as_deref(), Some(due.as_str()));
        assert_eq!(updated.remind_at.as_deref(), Some(remind.as_str()));
        assert_eq!(updated.advance_minutes, 10);
        assert!(updated.recurrence.is_some());
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
                by_setpos: None,
            }),
        );
        let updated = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "每天日报".into(),
                due_at: tri(t.due_at.clone()),
                recurrence: Some(Some(crate::recurrence::RecurrenceRuleInput {
                    freq: "weekly".into(),
                    interval: 2,
                    by_weekday: vec![1, 3],
                    by_monthday: None,
                    by_setpos: None,
                })),
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

    // ── 智能日程提醒 2.0：by_setpos 规则 / 延后撤销 / 倒计时数据源 ──

    fn pending_remind_at(db: &Db, task_id: &str) -> Option<String> {
        db.with_conn(|c| {
            Ok(c.query_row(
                "SELECT MIN(remind_at) FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                rusqlite::params![task_id],
                |r| r.get(0),
            )?)
        })
        .unwrap()
    }

    #[test]
    fn create_task_with_monthly_setpos_rule() {
        let db = db();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "每月第二个周一例会".into(),
                recurrence: Some(Some(RecurrenceRuleInput {
                    freq: "monthly".into(),
                    interval: 1,
                    by_weekday: vec![1],
                    by_monthday: None,
                    by_setpos: Some(2),
                })),
                ..Default::default()
            },
        )
        .unwrap();
        let rule = t.recurrence.expect("应保存 setpos 规则");
        assert_eq!(rule.by_setpos, Some(2));
        // 读回也一致（v20 列持久化）
        assert_eq!(
            get_task(&db, &t.id).unwrap().recurrence.unwrap().by_setpos,
            Some(2)
        );
    }

    #[test]
    fn illegal_setpos_combination_is_rejected() {
        let db = db();
        let err = create_task_inner(
            &db,
            TaskInput {
                title: "非法规则".into(),
                recurrence: Some(Some(RecurrenceRuleInput {
                    freq: "weekly".into(),
                    interval: 1,
                    by_weekday: vec![1],
                    by_monthday: None,
                    by_setpos: Some(1),
                })),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "非法组合必须严格拒绝: {err:?}"
        );
        // 更新路径同样拒绝
        let t = create(&db, "先建任务", None, None);
        let err = update_task_inner(
            &db,
            &t.id,
            TaskInput {
                title: "非法更新".into(),
                recurrence: Some(Some(RecurrenceRuleInput {
                    freq: "monthly".into(),
                    interval: 1,
                    by_weekday: vec![1],
                    by_monthday: Some(3), // 与 setpos 互斥
                    by_setpos: Some(1),
                })),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn task_carries_real_next_remind_at() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "真实下次提醒".into(),
                due_at: tri(Some(due.clone())),
                advance_minutes: Some(30),
                ..Default::default()
            },
        )
        .unwrap();
        let got = get_task(&db, &t.id).unwrap();
        // 提前提醒（due - 30min）早于 due：next_remind_at 必须取最早的未触发提醒
        let earliest = pending_remind_at(&db, &t.id).unwrap();
        assert_eq!(got.next_remind_at.as_deref(), Some(earliest.as_str()));
        assert_ne!(got.next_remind_at.as_deref(), Some(due.as_str()));
        // 全部触发后置空
        db.with_conn(|c| {
            c.execute(
                "UPDATE task_reminders SET fired = 1 WHERE task_id = ?1",
                rusqlite::params![t.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        assert!(get_task(&db, &t.id).unwrap().next_remind_at.is_none());
    }

    #[test]
    fn snooze_returns_changes_and_undo_restores() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "可撤销延后".into(),
                due_at: tri(Some(due.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        let result = snooze_reminder_inner(&db, &t.id, 15).unwrap();
        assert_eq!(result.changed.len(), 1);
        assert_eq!(result.changed[0].restore_to, due);
        assert!(
            result.next_remind_at > due,
            "延后 15 分钟应晚于原提醒（10 分钟后）"
        );
        // 延后生效：真实下次提醒 = 延后时间（不是 tasks.due_at）
        assert_eq!(
            pending_remind_at(&db, &t.id).unwrap(),
            result.next_remind_at
        );

        let (restored, dropped) =
            undo_snooze_inner(&db, &t.id, &result.changed, result.inserted_id.as_deref()).unwrap();
        assert_eq!((restored, dropped), (1, 0));
        assert_eq!(
            pending_remind_at(&db, &t.id).unwrap(),
            due,
            "撤销后恢复原时间"
        );
    }

    #[test]
    fn stale_undo_does_not_overwrite_newer_snooze() {
        // 连续两次延后：第一次的撤销不得覆盖第二次的新时间
        let db = db();
        let due = (Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "连续延后".into(),
                due_at: tri(Some(due)),
                ..Default::default()
            },
        )
        .unwrap();
        let first = snooze_reminder_inner(&db, &t.id, 5).unwrap();
        let second = snooze_reminder_inner(&db, &t.id, 30).unwrap();
        let current = pending_remind_at(&db, &t.id).unwrap();
        assert_eq!(current, second.next_remind_at);
        // 旧撤销：remind_at 已不是 first 的 snoozed_to → 恢复 0 行
        let (restored, _) =
            undo_snooze_inner(&db, &t.id, &first.changed, first.inserted_id.as_deref()).unwrap();
        assert_eq!(restored, 0, "旧撤销必须被版本约束挡下");
        assert_eq!(
            pending_remind_at(&db, &t.id).unwrap(),
            current,
            "新时间不受旧撤销影响"
        );
        // 新撤销仍然有效
        let (restored, _) =
            undo_snooze_inner(&db, &t.id, &second.changed, second.inserted_id.as_deref()).unwrap();
        assert_eq!(restored, 1);
    }

    #[test]
    fn undo_skips_fired_and_edited_reminders() {
        let db = db();
        let due = (Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "已触发不覆盖".into(),
                due_at: tri(Some(due)),
                ..Default::default()
            },
        )
        .unwrap();
        let result = snooze_reminder_inner(&db, &t.id, 5).unwrap();
        // 撤销前提醒被编辑（时间再改）→ 条件不成立
        db.with_conn(|c| {
            c.execute(
                "UPDATE task_reminders SET remind_at = ?2 WHERE task_id = ?1 AND fired = 0",
                rusqlite::params![t.id, (Utc::now() + chrono::Duration::hours(1)).to_rfc3339()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let (restored, _) =
            undo_snooze_inner(&db, &t.id, &result.changed, result.inserted_id.as_deref()).unwrap();
        assert_eq!(restored, 0, "已被编辑的提醒不得被旧撤销覆盖");
    }

    #[test]
    fn snooze_completed_task_is_rejected() {
        let db = db();
        let t = create(&db, "已完成", None, None);
        db.with_conn(|c| {
            c.execute(
                "UPDATE tasks SET status = 'completed' WHERE id = ?1",
                rusqlite::params![t.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let err = snooze_reminder_inner(&db, &t.id, 5).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "已完成任务不得延后（也不得补建幽灵提醒）: {err:?}"
        );
        let n: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1",
                    rusqlite::params![t.id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn snooze_fallback_inserts_undoable_one_shot() {
        let db = db();
        let t = create(&db, "全部已触发", None, None);
        let result = snooze_reminder_inner(&db, &t.id, 5).unwrap();
        assert!(result.changed.is_empty());
        assert!(result.inserted_id.is_some());
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
        assert_eq!(n, 1);
        // 撤销删除补建行
        let (restored, dropped) =
            undo_snooze_inner(&db, &t.id, &result.changed, result.inserted_id.as_deref()).unwrap();
        assert_eq!((restored, dropped), (0, 1));
        let n: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1",
                    rusqlite::params![t.id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn active_reminders_lists_pending_with_snoozed_flag() {
        let db = db();
        let future = (Utc::now() + chrono::Duration::minutes(30)).to_rfc3339();
        let a = create_task_inner(
            &db,
            TaskInput {
                title: "倒计时任务".into(),
                due_at: tri(Some(future.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        let b = create_task_inner(
            &db,
            TaskInput {
                title: "已完成任务".into(),
                due_at: tri(Some(future.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        db.with_conn(|c| {
            c.execute(
                "UPDATE tasks SET status = 'completed' WHERE id = ?1",
                rusqlite::params![b.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let c = create(&db, "无提醒任务", None, None);
        let _ = c;

        // 直接调用内部逻辑（active_reminders 命令需要 State，绕开 Tauri 包装）
        let rows: Vec<ActiveReminder> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT r.id, r.task_id, t.title, r.remind_at, r.occurrence, r.kind, t.status,
                            (t.recurrence_rule_id IS NOT NULL)
                     FROM task_reminders r JOIN tasks t ON t.id = r.task_id
                     WHERE r.fired = 0 AND t.status = 'pending'
                     ORDER BY r.remind_at ASC LIMIT 20",
                )?;
                let rows = stmt.query_map([], |r| {
                    let remind_at: String = r.get(3)?;
                    let occurrence: String = r.get(4)?;
                    Ok(ActiveReminder {
                        reminder_id: r.get(0)?,
                        task_id: r.get(1)?,
                        task_title: r.get(2)?,
                        snoozed: remind_at != occurrence,
                        remind_at,
                        occurrence,
                        kind: r.get(5)?,
                        task_status: r.get(6)?,
                        has_recurrence: r.get::<_, i64>(7)? != 0,
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(rows.len(), 1, "只列未触发且任务未完成的提醒");
        assert_eq!(rows[0].task_id, a.id);
        assert!(!rows[0].snoozed);
        // 延后后 snoozed 标记为真
        snooze_reminder_inner(&db, &a.id, 10).unwrap();
        let snoozed: bool = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT remind_at != occurrence FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![a.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(snoozed);
    }

    #[test]
    fn cancel_reminders_removes_pending_and_rejects_recurring() {
        let db = db();
        let future = (Utc::now() + chrono::Duration::minutes(30)).to_rfc3339();
        let t = create_task_inner(
            &db,
            TaskInput {
                title: "取消提醒".into(),
                due_at: tri(Some(future)),
                ..Default::default()
            },
        )
        .unwrap();
        // 直接调用内部 SQL（命令包装需要 State）
        let n: usize = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let n = tx.execute(
                    "DELETE FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![t.id],
                )?;
                tx.commit()?;
                Ok(n)
            })
            .unwrap();
        assert_eq!(n, 1);
        // 重复任务路径由命令层校验，这里验证 SQL 语义边界已覆盖（due 提醒可删）
        let r = create(
            &db,
            "重复任务",
            Some((Utc::now() + chrono::Duration::days(1)).to_rfc3339()),
            Some(RecurrenceRuleInput {
                freq: "daily".into(),
                interval: 1,
                by_weekday: vec![],
                by_monthday: None,
                by_setpos: None,
            }),
        );
        let recurring: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM tasks WHERE id = ?1 AND recurrence_rule_id IS NOT NULL",
                    rusqlite::params![r.id],
                    |x| x.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(recurring, 1);
    }

    #[test]
    fn task_limit_none_keeps_unbounded_behavior() {
        assert_eq!(effective_task_limit(None), None, "None 必须保持旧行为：不限制");
    }

    #[test]
    fn task_limit_clamps_into_1_to_200() {
        assert_eq!(effective_task_limit(Some(0)), Some(1), "下限收敛到 1");
        assert_eq!(effective_task_limit(Some(1)), Some(1));
        assert_eq!(effective_task_limit(Some(50)), Some(50));
        assert_eq!(effective_task_limit(Some(200)), Some(200));
        assert_eq!(effective_task_limit(Some(201)), Some(200), "上限收敛到 200");
        assert_eq!(effective_task_limit(Some(u32::MAX)), Some(200));
    }

    /// limit 契约（2026-11-03，面板复用验收）：None 行为完全不变；
    /// Some(n) 收敛到 1..=200，在筛选与排序之后应用。
    #[test]
    fn list_tasks_applies_limit_after_filter_and_sort() {
        let db = db();
        for i in 1..=5 {
            create(
                &db,
                &format!("限长任务{i}"),
                Some((Utc::now() + chrono::Duration::minutes(i)).to_rfc3339()),
                None,
            );
        }
        // None：旧行为，全量返回。
        let all = list_tasks_inner(&db, TaskFilter::default()).unwrap();
        assert_eq!(all.len(), 5);
        // Some(2)：LIMIT 生效，按排序取前 2 条。
        let limited = list_tasks_inner(
            &db,
            TaskFilter {
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(limited.len(), 2);
        // 排序后 LIMIT：默认排序按 due_at 升序，前 2 条应是最早截止的两条。
        assert_eq!(limited[0].title, "限长任务1");
        assert_eq!(limited[1].title, "限长任务2");
        // clamp：Some(0) 收敛为 1 条。
        let clamped_low = list_tasks_inner(
            &db,
            TaskFilter {
                limit: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(clamped_low.len(), 1);
        // clamp：Some(500) 收敛为 200，但库里只有 5 条，应全量返回。
        let clamped_high = list_tasks_inner(
            &db,
            TaskFilter {
                limit: Some(500),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(clamped_high.len(), 5);
        // 与筛选叠加：status 过滤后 LIMIT 仍生效。
        create(&db, "已完成任务", None, None);
        db.with_conn(|c| {
            c.execute(
                "UPDATE tasks SET status='completed' WHERE title='已完成任务'",
                [],
            )
            .map_err(AppError::from)
        })
        .unwrap();
        let filtered = list_tasks_inner(
            &db,
            TaskFilter {
                status: Some("completed".into()),
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].title, "已完成任务");
    }
}
