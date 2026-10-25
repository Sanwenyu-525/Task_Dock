//! 数据导入导出与本地自动备份。
//!
//! 所有用户数据仅保存在本地；导出为纯 JSON，不包含任何 Agent Prompt/代码内容。
//!
//! v2 格式修复（相对 v0.3 发布版）：
//! - 导出补齐 agent_sources / agent_instances / agent_sessions / agent_events，
//!   修复「导出了 agent_runs 却没有 agent_sessions，导入必撞外键」的 P0 缺陷；
//! - 导入使用强类型行结构 + SQLite 原生类型绑定（bool→INTEGER、数字→INTEGER/REAL），
//!   不再经 serde_json::Value 绑定（旧实现把布尔绑成 TEXT 'true'/'false'，导入的
//!   fired/is_read 永远不等于 0/1，提醒引擎与已读状态全部失效）；
//! - 导入前完整校验：结构、必需字段、数据版本、表内唯一性、引用完整性；
//! - 单事务恢复（BEGIN IMMEDIATE … COMMIT），任一步失败整体回滚，原库不动；
//! - v1 旧文件中的孤儿 agent_runs 自动合成占位会话（不再外键报错）；
//! - 备份/导出为一致性只读快照 + 临时文件原子写入。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

const EXPORT_VERSION: i64 = 2;

fn app_data(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_data_dir()?)
}

fn backup_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app_data(app)?.join("backups");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// ── 导出行结构（强类型：导出与导入共用，字段与列一一对应）────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub description: String,
    pub priority: i64,
    pub status: String,
    pub category: String,
    pub tags: String,
    pub due_at: Option<String>,
    pub remind_at: Option<String>,
    pub advance_minutes: i64,
    pub recurrence_rule_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleRow {
    pub id: String,
    pub freq: String,
    pub interval: i64,
    pub by_weekday: String,
    pub by_monthday: Option<u32>,
    pub until: Option<String>,
    pub anchor: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderRow {
    pub id: String,
    pub task_id: String,
    pub remind_at: String,
    pub occurrence: String,
    pub kind: String,
    pub fired: bool,
    pub fired_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkRow {
    pub id: String,
    pub task_id: String,
    pub source_id: String,
    pub session_external_id: String,
    pub run_external_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryRow {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRow {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub enabled: bool,
    pub verified: bool,
    #[serde(default)]
    pub transport_verified: bool,
    pub homepage: String,
    pub note: String,
    pub config: String,
    #[serde(default)]
    pub adapter: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub last_event_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceRow {
    pub id: String,
    pub source_id: String,
    pub instance_key: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub exe_path: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    #[serde(default)]
    pub meta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub source_id: String,
    pub external_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    #[serde(default)]
    pub last_run_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRow {
    pub id: String,
    pub session_id: String,
    pub source_id: String,
    pub external_run_id: Option<String>,
    #[serde(default)]
    pub task_title: String,
    #[serde(default)]
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub pending_items: String,
    #[serde(default)]
    pub meta: String,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRow {
    pub id: String,
    pub source_id: String,
    pub session_external_id: String,
    #[serde(default)]
    pub run_external_id: Option<String>,
    #[serde(default)]
    pub event_type: String,
    pub state: String,
    #[serde(default)]
    pub message: Option<String>,
    pub received_at: String,
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub evidence_type: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub dedupe_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationRowData {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub ref_type: Option<String>,
    #[serde(default)]
    pub ref_id: Option<String>,
    #[serde(default)]
    pub occurrence: Option<String>,
    pub is_read: bool,
    pub created_at: String,
}

/// 解析后的完整导出数据（已通过结构与引用完整性校验）。
#[derive(Debug, Default)]
struct ParsedImport {
    tasks: Vec<TaskRow>,
    rules: Vec<RuleRow>,
    reminders: Vec<ReminderRow>,
    links: Vec<LinkRow>,
    categories: Vec<CategoryRow>,
    sources: Vec<SourceRow>,
    instances: Vec<InstanceRow>,
    sessions: Vec<SessionRow>,
    runs: Vec<RunRow>,
    events: Vec<EventRow>,
    notifications: Vec<NotificationRowData>,
    settings: serde_json::Map<String, serde_json::Value>,
}

/// 收集全量数据（导出/备份共用）。
/// 单个只读事务内读取全部表：与调度器/接入写入并发时仍得到一致性快照。
fn collect(db: &Db) -> AppResult<serde_json::Value> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let tasks: Vec<TaskRow> = query_rows(&tx,
            "SELECT id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at FROM tasks",
            |r| Ok(TaskRow {
                id: r.get(0)?, title: r.get(1)?, description: r.get(2)?, priority: r.get(3)?,
                status: r.get(4)?, category: r.get(5)?, tags: r.get(6)?, due_at: r.get(7)?,
                remind_at: r.get(8)?, advance_minutes: r.get(9)?, recurrence_rule_id: r.get(10)?,
                created_at: r.get(11)?, updated_at: r.get(12)?, completed_at: r.get(13)?,
            }))?;
        let rules: Vec<RuleRow> = query_rows(&tx,
            "SELECT id, freq, interval, by_weekday, by_monthday, until, anchor, created_at FROM recurrence_rules",
            |r| Ok(RuleRow {
                id: r.get(0)?, freq: r.get(1)?, interval: r.get(2)?, by_weekday: r.get(3)?,
                by_monthday: r.get(4)?, until: r.get(5)?, anchor: r.get(6)?, created_at: r.get(7)?,
            }))?;
        let reminders: Vec<ReminderRow> = query_rows(&tx,
            "SELECT id, task_id, remind_at, occurrence, kind, fired, fired_at FROM task_reminders",
            |r| Ok(ReminderRow {
                id: r.get(0)?, task_id: r.get(1)?, remind_at: r.get(2)?, occurrence: r.get(3)?,
                kind: r.get(4)?, fired: r.get::<_, i64>(5)? != 0, fired_at: r.get(6)?,
            }))?;
        let links: Vec<LinkRow> = query_rows(&tx,
            "SELECT id, task_id, source_id, session_external_id, run_external_id, created_at FROM task_agent_links",
            |r| Ok(LinkRow {
                id: r.get(0)?, task_id: r.get(1)?, source_id: r.get(2)?, session_external_id: r.get(3)?,
                run_external_id: r.get(4)?, created_at: r.get(5)?,
            }))?;
        let categories: Vec<CategoryRow> = query_rows(&tx,
            "SELECT id, name, color, sort_order, created_at FROM task_categories",
            |r| Ok(CategoryRow {
                id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, sort_order: r.get(3)?, created_at: r.get(4)?,
            }))?;
        let sources: Vec<SourceRow> = query_rows(&tx,
            "SELECT id, display_name, kind, enabled, verified, transport_verified, homepage, note, config, adapter, icon, hidden, last_event_at, created_at, updated_at FROM agent_sources",
            |r| Ok(SourceRow {
                id: r.get(0)?, display_name: r.get(1)?, kind: r.get(2)?, enabled: r.get::<_, i64>(3)? != 0,
                verified: r.get::<_, i64>(4)? != 0, transport_verified: r.get::<_, i64>(5)? != 0,
                homepage: r.get(6)?, note: r.get(7)?, config: r.get(8)?, adapter: r.get(9)?,
                icon: r.get(10)?, hidden: r.get::<_, i64>(11)? != 0, last_event_at: r.get(12)?,
                created_at: r.get(13)?, updated_at: r.get(14)?,
            }))?;
        let instances: Vec<InstanceRow> = query_rows(&tx,
            "SELECT id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, meta FROM agent_instances",
            |r| Ok(InstanceRow {
                id: r.get(0)?, source_id: r.get(1)?, instance_key: r.get(2)?, display_name: r.get(3)?,
                exe_path: r.get(4)?, first_seen_at: r.get(5)?, last_seen_at: r.get(6)?, meta: r.get(7)?,
            }))?;
        let sessions: Vec<SessionRow> = query_rows(&tx,
            "SELECT id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id FROM agent_sessions",
            |r| Ok(SessionRow {
                id: r.get(0)?, source_id: r.get(1)?, external_id: r.get(2)?, title: r.get(3)?,
                status: r.get(4)?, first_seen_at: r.get(5)?, last_seen_at: r.get(6)?,
                last_run_id: r.get(7)?, instance_id: r.get(8)?,
            }))?;
        let runs: Vec<RunRow> = query_rows(&tx,
            "SELECT id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id FROM agent_runs",
            |r| Ok(RunRow {
                id: r.get(0)?, session_id: r.get(1)?, source_id: r.get(2)?, external_run_id: r.get(3)?,
                task_title: r.get(4)?, status: r.get(5)?, started_at: r.get(6)?, updated_at: r.get(7)?,
                ended_at: r.get(8)?, pending_items: r.get(9)?, meta: r.get(10)?,
                instance_id: r.get(11)?, parent_run_id: r.get(12)?,
            }))?;
        let events: Vec<EventRow> = query_rows(&tx,
            "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key FROM agent_events",
            |r| Ok(EventRow {
                id: r.get(0)?, source_id: r.get(1)?, session_external_id: r.get(2)?,
                run_external_id: r.get(3)?, event_type: r.get(4)?, state: r.get(5)?,
                message: r.get(6)?, received_at: r.get(7)?, schema_version: r.get::<_, i64>(8)? as u32,
                event_id: r.get(9)?, instance_id: r.get(10)?, parent_run_id: r.get(11)?,
                occurred_at: r.get(12)?, transport: r.get(13)?, evidence_type: r.get(14)?,
                confidence: r.get(15)?, dedupe_key: r.get(16)?,
            }))?;
        let notifications: Vec<NotificationRowData> = query_rows(&tx,
            "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at FROM notification_history ORDER BY created_at DESC, id DESC LIMIT 500",
            |r| Ok(NotificationRowData {
                id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, body: r.get(3)?,
                ref_type: r.get(4)?, ref_id: r.get(5)?, occurrence: r.get(6)?,
                is_read: r.get::<_, i64>(7)? != 0, created_at: r.get(8)?,
            }))?;
        // http_token 属于本机安全项，不随导出文件流转
        let mut settings = serde_json::Map::new();
        {
            let mut stmt = tx.prepare("SELECT key, value FROM application_settings WHERE key != 'http_token'")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (k, v) = row?;
                settings.insert(k, serde_json::from_str(&v).unwrap_or(serde_json::Value::Null));
            }
        }
        tx.commit()?;
        Ok(serde_json::json!({
            "app": "task-dock",
            "version": EXPORT_VERSION,
            "exported_at": now_iso(),
            "tasks": tasks,
            "recurrence_rules": rules,
            "task_reminders": reminders,
            "task_agent_links": links,
            "task_categories": categories,
            "agent_sources": sources,
            "agent_instances": instances,
            "agent_sessions": sessions,
            "agent_runs": runs,
            "agent_events": events,
            "notification_history": notifications,
            "settings": serde_json::Value::Object(settings),
        }))
    })
}

fn query_rows<T>(
    conn: &rusqlite::Connection,
    sql: &str,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 原子写入：临时文件 + rename（Windows rename 不覆盖既有文件，先删再换）。
fn write_json_atomic(path: &Path, content: &str) -> AppResult<()> {
    let tmp = path.with_extension("taskdock-tmp");
    std::fs::write(&tmp, content)?;
    if std::fs::rename(&tmp, path).is_err() {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        std::fs::rename(&tmp, path)?;
    }
    Ok(())
}

/// 导出到指定路径（由前端对话框选择）。
#[tauri::command]
pub fn export_data(db: State<'_, Arc<Db>>, path: String) -> AppResult<String> {
    let data = collect(&db)?;
    let pretty = serde_json::to_string_pretty(&data)?;
    write_json_atomic(Path::new(&path), &pretty)?;
    tracing::info!("数据已导出: {}", path);
    Ok(path)
}

/// 立即备份到应用数据目录。
#[tauri::command]
pub fn backup_now(app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> AppResult<String> {
    let dir = backup_dir(&app)?;
    let data = collect(&db)?;
    let pretty = serde_json::to_string_pretty(&data)?;
    let path = dir.join(format!(
        "backup-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    write_json_atomic(&path, &pretty)?;
    prune_backups(&app, &db)?;
    tracing::info!("本地备份完成: {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_backups(app: tauri::AppHandle) -> AppResult<Vec<serde_json::Value>> {
    let dir = backup_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() {
            out.push(serde_json::json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "size": meta.len(),
                "modified": chrono::DateTime::<chrono::Utc>::from(meta.modified()?).to_rfc3339(),
            }));
        }
    }
    out.sort_by(|a, b| {
        b.get("modified")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(a.get("modified").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(out)
}

fn prune_backups(app: &tauri::AppHandle, db: &Db) -> AppResult<()> {
    let settings = crate::db::Settings::load(db)?;
    let retain = settings.backup_retain_days.max(1) as i64;
    let dir = backup_dir(app)?;
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs((retain * 86400) as u64);
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

/// 启动时自动备份（距上次备份超过 24 小时才执行）。
pub fn auto_backup_if_needed_inner(app: &tauri::AppHandle, db: &Db) -> AppResult<Option<String>> {
    let settings = crate::db::Settings::load(db)?;
    if !settings.auto_backup {
        return Ok(None);
    }
    let dir = backup_dir(app)?;
    let last = std::fs::read_dir(&dir).ok().and_then(|entries| {
        entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .filter_map(|m| m.modified().ok())
            .max()
    });
    let stale = match last {
        Some(t) => t
            .elapsed()
            .map(|d| d > std::time::Duration::from_secs(24 * 3600))
            .unwrap_or(true),
        None => true,
    };
    if stale {
        let data = collect(db)?;
        let pretty = serde_json::to_string_pretty(&data)?;
        let path = dir.join(format!(
            "backup-{}.json",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        write_json_atomic(&path, &pretty)?;
        prune_backups(app, db)?;
        tracing::info!("启动自动备份完成: {}", path.display());
        return Ok(Some(path.to_string_lossy().to_string()));
    }
    Ok(None)
}

#[tauri::command]
pub fn auto_backup_if_needed(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<Option<String>> {
    auto_backup_if_needed_inner(&app, &db)
}

// ── 导入：解析 → 校验 → 单事务应用 ───────────────────────────

fn rows_of<T: serde::de::DeserializeOwned>(
    data: &serde_json::Value,
    key: &str,
) -> AppResult<Vec<T>> {
    let arr = data
        .get(key)
        .map(|v| {
            v.as_array()
                .cloned()
                .ok_or_else(|| AppError::Validation(format!("{} 必须是数组", key)))
        })
        .transpose()?
        .unwrap_or_default();
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let row: T = serde_json::from_value(item.clone()).map_err(|e| {
            AppError::Validation(format!("{}[{}] 字段缺失或类型不合法: {}", key, i, e))
        })?;
        out.push(row);
    }
    Ok(out)
}

fn dup_check<T>(items: &[T], key: impl Fn(&T) -> String, table: &str) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    for it in items {
        let k = key(it);
        if !seen.insert(k) {
            return Err(AppError::Validation(format!("{} 存在重复 id", table)));
        }
    }
    Ok(())
}

/// 解析并校验导出文件（不写库）。
/// - 结构与必需字段：逐表反序列化为强类型行（serde 严格模式，缺字段即报错）；
/// - 数据版本：1（v0.3 旧格式，缺 Agent 表）或 2（完整格式）；
/// - 引用完整性：reminder→task、task→rule、link→task、run→session、
///   session/instance→source（文件内 ∪ 目标库既有）；
/// - v1 兼容：旧文件导出过 agent_runs 但没有 agent_sessions，为孤儿 run
///   合成占位会话，而不是抛外键错误。
fn parse_and_validate(db: &Db, data: &serde_json::Value) -> AppResult<ParsedImport> {
    if data.get("app").and_then(|v| v.as_str()) != Some("task-dock") {
        return Err(AppError::Validation("不是 Task Dock 的导出文件".into()));
    }
    let version = data.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    if !(1..=EXPORT_VERSION).contains(&version) {
        return Err(AppError::Validation(format!(
            "不支持的数据版本: {}",
            version
        )));
    }

    let mut parsed = ParsedImport {
        tasks: rows_of(data, "tasks")?,
        rules: rows_of(data, "recurrence_rules")?,
        reminders: rows_of(data, "task_reminders")?,
        links: rows_of(data, "task_agent_links")?,
        categories: rows_of(data, "task_categories")?,
        sources: rows_of(data, "agent_sources")?,
        instances: rows_of(data, "agent_instances")?,
        sessions: rows_of(data, "agent_sessions")?,
        runs: rows_of(data, "agent_runs")?,
        events: rows_of(data, "agent_events")?,
        notifications: rows_of(data, "notification_history")?,
        settings: data
            .get("settings")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default(),
    };

    // 既有来源（导入采用 upsert 合并，文件来源可与库内共存）
    let mut known_sources: std::collections::HashSet<String> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM agent_sources")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })?
        .into_iter()
        .collect();
    for s in &parsed.sources {
        known_sources.insert(s.id.clone());
    }

    // 表内唯一性
    dup_check(&parsed.tasks, |t| t.id.clone(), "tasks")?;
    dup_check(&parsed.rules, |r| r.id.clone(), "recurrence_rules")?;
    dup_check(&parsed.reminders, |r| r.id.clone(), "task_reminders")?;
    dup_check(&parsed.sources, |s| s.id.clone(), "agent_sources")?;
    dup_check(&parsed.instances, |i| i.id.clone(), "agent_instances")?;
    dup_check(&parsed.sessions, |s| s.id.clone(), "agent_sessions")?;
    dup_check(&parsed.runs, |r| r.id.clone(), "agent_runs")?;
    dup_check(&parsed.events, |e| e.id.clone(), "agent_events")?;
    {
        let mut seen = std::collections::HashSet::new();
        for r in &parsed.reminders {
            if !seen.insert((r.task_id.clone(), r.occurrence.clone())) {
                return Err(AppError::Validation(
                    "task_reminders 违反 UNIQUE(task_id, occurrence)".into(),
                ));
            }
        }
        let mut seen = std::collections::HashSet::new();
        for r in &parsed.runs {
            if let Some(ext) = &r.external_run_id {
                if !seen.insert((r.source_id.clone(), ext.clone())) {
                    return Err(AppError::Validation(
                        "agent_runs 违反 UNIQUE(source_id, external_run_id)".into(),
                    ));
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        for e in &parsed.events {
            if let Some(k) = &e.dedupe_key {
                if !seen.insert(k.clone()) {
                    return Err(AppError::Validation(
                        "agent_events 存在重复 dedupe_key".into(),
                    ));
                }
            }
        }
    }

    // 引用完整性
    let task_ids: std::collections::HashSet<String> =
        parsed.tasks.iter().map(|t| t.id.clone()).collect();
    let rule_ids: std::collections::HashSet<String> =
        parsed.rules.iter().map(|r| r.id.clone()).collect();
    let session_ids: std::collections::HashSet<String> =
        parsed.sessions.iter().map(|s| s.id.clone()).collect();
    for t in &parsed.tasks {
        if let Some(rid) = &t.recurrence_rule_id {
            if !rule_ids.contains(rid) {
                return Err(AppError::Validation(format!(
                    "tasks[{}] 引用了不存在的 recurrence_rules: {}",
                    t.id, rid
                )));
            }
        }
    }
    for r in &parsed.reminders {
        if !task_ids.contains(&r.task_id) {
            return Err(AppError::Validation(format!(
                "task_reminders[{}] 引用了不存在的任务: {}",
                r.id, r.task_id
            )));
        }
    }
    for l in &parsed.links {
        if !task_ids.contains(&l.task_id) {
            return Err(AppError::Validation(format!(
                "task_agent_links[{}] 引用了不存在的任务: {}",
                l.id, l.task_id
            )));
        }
        if !known_sources.contains(&l.source_id) {
            return Err(AppError::Validation(format!(
                "task_agent_links[{}] 引用了不存在的来源: {}",
                l.id, l.source_id
            )));
        }
    }
    for s in &parsed.sessions {
        if !known_sources.contains(&s.source_id) {
            return Err(AppError::Validation(format!(
                "agent_sessions[{}] 引用了不存在的来源: {}",
                s.id, s.source_id
            )));
        }
    }
    for i in &parsed.instances {
        if !known_sources.contains(&i.source_id) {
            return Err(AppError::Validation(format!(
                "agent_instances[{}] 引用了不存在的来源: {}",
                i.id, i.source_id
            )));
        }
    }
    for r in &parsed.runs {
        if !session_ids.contains(&r.session_id) {
            if version == 1 {
                // v1 旧格式没有 agent_sessions：为孤儿 run 合成占位会话
                if !known_sources.contains(&r.source_id) {
                    return Err(AppError::Validation(format!(
                        "agent_runs[{}] 引用了不存在的来源: {}",
                        r.id, r.source_id
                    )));
                }
                continue;
            }
            return Err(AppError::Validation(format!(
                "agent_runs[{}] 引用了不存在的 agent_sessions: {}（v2 文件必须携带完整会话表）",
                r.id, r.session_id
            )));
        }
    }
    if version == 1 && !parsed.runs.is_empty() {
        // 为每个孤儿 session_id 合成占位会话（id 必须等于 run.session_id 以满足外键）
        let mut synthesized: std::collections::HashMap<String, SessionRow> =
            std::collections::HashMap::new();
        for r in &parsed.runs {
            if session_ids.contains(&r.session_id) {
                continue;
            }
            let entry = synthesized
                .entry(r.session_id.clone())
                .or_insert_with(|| SessionRow {
                    id: r.session_id.clone(),
                    source_id: r.source_id.clone(),
                    external_id: format!("recovered-{}", r.session_id),
                    title: "v1 导出恢复的会话".into(),
                    status: "idle".into(),
                    first_seen_at: r.started_at.clone(),
                    last_seen_at: r.updated_at.clone(),
                    last_run_id: None,
                    instance_id: None,
                });
            if r.updated_at > entry.last_seen_at {
                entry.last_seen_at = r.updated_at.clone();
            }
        }
        let count = synthesized.len();
        parsed.sessions.extend(synthesized.into_values());
        tracing::info!("v1 导出兼容：合成了 {} 个占位会话", count);
    }

    // 设置：必须是对象；键在应用时校验
    if !parsed.settings.is_empty() {
        for (k, v) in &parsed.settings {
            if k == "http_token" {
                continue; // 本机安全项不导入
            }
            // 已知键校验类型/范围；未知键（更老/更新版本）跳过不报错
            if let Err(e) = crate::commands::settings::validate_setting(k, v) {
                if !matches!(e, AppError::Validation(ref m) if m.starts_with("未知设置键")) {
                    return Err(AppError::Validation(format!(
                        "settings.{} 不合法: {}",
                        k, e
                    )));
                }
            }
        }
    }
    Ok(parsed)
}

/// 导入核心：整体替换用户数据（校验 → 单事务）。任一步失败整体回滚，原库保持不变。
pub fn import_value(db: &Db, data: &serde_json::Value) -> AppResult<()> {
    let parsed = parse_and_validate(db, data)?;
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> AppResult<()> {
            // 依赖序清除旧数据（agent_sources 例外：来源注册表 upsert 合并，不删）
            for table in [
                "task_agent_links",
                "task_reminders",
                "agent_events",
                "agent_runs",
                "agent_sessions",
                "agent_instances",
                "notification_history",
                "recurrence_rules",
                "tasks",
                "task_categories",
            ] {
                conn.execute(&format!("DELETE FROM {}", table), [])?;
            }

            // 来源：upsert（保留库内已有、文件内未覆盖的注册项）
            for s in &parsed.sources {
                conn.execute(
                    "INSERT INTO agent_sources
                       (id, display_name, kind, enabled, verified, transport_verified, homepage, note, config,
                        adapter, icon, hidden, last_event_at, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
                     ON CONFLICT(id) DO UPDATE SET
                       display_name = excluded.display_name, kind = excluded.kind,
                       enabled = excluded.enabled, verified = excluded.verified,
                       transport_verified = excluded.transport_verified, homepage = excluded.homepage,
                       note = excluded.note, config = excluded.config, adapter = excluded.adapter,
                       icon = excluded.icon, hidden = excluded.hidden,
                       last_event_at = excluded.last_event_at, updated_at = excluded.updated_at,
                       created_at = excluded.created_at",
                    rusqlite::params![
                        s.id, s.display_name, s.kind, s.enabled as i64, s.verified as i64,
                        s.transport_verified as i64, s.homepage, s.note, s.config,
                        s.adapter, s.icon, s.hidden as i64, s.last_event_at, s.created_at, s.updated_at,
                    ],
                )?;
            }
            for i in &parsed.instances {
                conn.execute(
                    "INSERT INTO agent_instances (id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, meta)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    rusqlite::params![i.id, i.source_id, i.instance_key, i.display_name, i.exe_path, i.first_seen_at, i.last_seen_at, i.meta],
                )?;
            }
            for s in &parsed.sessions {
                conn.execute(
                    "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![s.id, s.source_id, s.external_id, s.title, s.status, s.first_seen_at, s.last_seen_at, s.last_run_id, s.instance_id],
                )?;
            }
            for r in &parsed.runs {
                conn.execute(
                    "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    rusqlite::params![r.id, r.session_id, r.source_id, r.external_run_id, r.task_title, r.status, r.started_at, r.updated_at, r.ended_at, r.pending_items, r.meta, r.instance_id, r.parent_run_id],
                )?;
            }
            for e in &parsed.events {
                conn.execute(
                    "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                    rusqlite::params![e.id, e.source_id, e.session_external_id, e.run_external_id, e.event_type, e.state, e.message, e.received_at, e.schema_version as i64, e.event_id, e.instance_id, e.parent_run_id, e.occurred_at, e.transport, e.evidence_type, e.confidence, e.dedupe_key],
                )?;
            }
            for c in &parsed.categories {
                conn.execute(
                    "INSERT INTO task_categories (id, name, color, sort_order, created_at) VALUES (?1,?2,?3,?4,?5)",
                    rusqlite::params![c.id, c.name, c.color, c.sort_order, c.created_at],
                )?;
            }
            for r in &parsed.rules {
                conn.execute(
                    "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, until, anchor, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    rusqlite::params![r.id, r.freq, r.interval, r.by_weekday, r.by_monthday, r.until, r.anchor, r.created_at],
                )?;
            }
            for t in &parsed.tasks {
                conn.execute(
                    "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    rusqlite::params![t.id, t.title, t.description, t.priority, t.status, t.category, t.tags, t.due_at, t.remind_at, t.advance_minutes, t.recurrence_rule_id, t.created_at, t.updated_at, t.completed_at],
                )?;
            }
            for r in &parsed.reminders {
                conn.execute(
                    "INSERT INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![r.id, r.task_id, r.remind_at, r.occurrence, r.kind, r.fired as i64, r.fired_at],
                )?;
            }
            for l in &parsed.links {
                conn.execute(
                    "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![l.id, l.task_id, l.source_id, l.session_external_id, l.run_external_id, l.created_at],
                )?;
            }
            for n in &parsed.notifications {
                conn.execute(
                    "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![n.id, n.kind, n.title, n.body, n.ref_type, n.ref_id, n.occurrence, n.is_read as i64, n.created_at],
                )?;
            }
            // 设置：已知键校验后写入（同一事务）；http_token 属本机安全项，不导入
            let now = now_iso();
            for (k, v) in &parsed.settings {
                if k == "http_token" {
                    continue;
                }
                if crate::commands::settings::validate_setting(k, v).is_err() {
                    continue; // 未知键（跨版本）跳过
                }
                conn.execute(
                    "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    rusqlite::params![k, serde_json::to_string(v)?, now],
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                Ok::<_, AppError>(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

/// 从 JSON 文件导入（整体替换，导入前自动备份当前数据）。
#[tauri::command]
pub fn import_data(app: tauri::AppHandle, db: State<'_, Arc<Db>>, path: String) -> AppResult<()> {
    let raw = std::fs::read_to_string(&path)?;
    let data: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("导出文件不是合法 JSON: {}", e)))?;
    // 先校验再备份再导入：校验失败不动原库、不产生无意义备份
    parse_and_validate(&db, &data)?;
    let _ = backup_now(app.clone(), db.clone())?;
    import_value(&db, &data)?;
    tracing::info!("数据导入完成: {}", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{ingest_core, AgentEvent, Transport};
    use rusqlite::OptionalExtension;

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn strip_volatile(v: serde_json::Value) -> serde_json::Value {
        let mut v = v;
        if let Some(obj) = v.as_object_mut() {
            obj.remove("exported_at");
        }
        v
    }

    fn seed_full(db: &Db) {
        // 任务 + 重复规则 + 已触发/未触发提醒 + 分类 + 通知
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, until, anchor, created_at)
                 VALUES ('rule-1','daily',1,'[]',NULL,NULL,'2026-10-20',?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                 VALUES ('task-1','验收任务','内容',1,'pending','工作','[\"a\",\"b\"]','2026-10-26T02:00:00+00:00','2026-10-26T01:30:00+00:00',30,'rule-1',?1,?1,NULL)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES ('rem-1','task-1','2026-10-26T01:30:00+00:00','2026-10-26T01:30:00+00:00','advance',0,NULL)",
                [],
            )?;
            c.execute(
                "INSERT INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES ('rem-2','task-1','2026-10-25T01:30:00+00:00','2026-10-25T01:30:00+00:00','due',1,'2026-10-25T01:30:00+00:00')",
                [],
            )?;
            c.execute(
                "INSERT INTO task_categories (id, name, color, sort_order, created_at) VALUES ('cat-1','工作','#6366f1',0,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
                 VALUES ('n-1','reminder','任务提醒','body','task','task-1','2026-10-25T01:30:00+00:00',0,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at)
                 VALUES ('link-1','task-1','codex','s-1','r-1',?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        // Agent 数据经真实状态机写入
        let ingest = |ev: AgentEvent, t: Transport| {
            db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                ingest_core(&tx, &ev, &now_iso(), t)?;
                tx.commit()?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        };
        let mk = |session: &str, run: Option<&str>, state: &str| {
            let mut e = AgentEvent {
                source_id: "codex".into(),
                session_id: session.into(),
                run_id: run.map(|s| s.to_string()),
                state: state.into(),
                ..Default::default()
            };
            e.task_title = Some("联调任务".into());
            e.transport = Some("fake-client-claim".into());
            e
        };
        ingest(mk("s-1", Some("r-1"), "running"), Transport::Http);
        ingest(mk("s-1", Some("r-1"), "completed"), Transport::Http);
        // 自测事件（隔离验证）
        ingest(
            mk("taskdock-selftest-codex", None, "running"),
            Transport::Http,
        );
        db.set_setting("theme", serde_json::json!("dark")).unwrap();
    }

    #[test]
    fn export_import_export_roundtrip_is_consistent() {
        let db1 = memdb();
        seed_full(&db1);
        let v1 = strip_volatile(collect(&db1).unwrap());

        // 导入到已有数据的库（整体替换语义）
        let db2 = memdb();
        seed_light(&db2);
        import_value(&db2, &v1).unwrap();
        let v2 = strip_volatile(collect(&db2).unwrap());
        assert_eq!(v1, v2, "export → import → export 必须语义一致");

        // 原生类型绑定：fired/is_read 为 INTEGER，不是 TEXT 'true'
        let fired_type: String = db2
            .with_conn(|c| {
                c.query_row(
                    "SELECT typeof(fired) FROM task_reminders WHERE id = 'rem-1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(fired_type, "integer", "布尔必须绑定为 SQLite INTEGER");
        let fired_val: i64 = db2
            .with_conn(|c| {
                c.query_row(
                    "SELECT fired FROM task_reminders WHERE id = 'rem-2'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(fired_val, 1, "导入的 fired=1 保持触发语义");
        // 全表恢复
        for (table, expect) in [
            ("tasks", 1),
            ("recurrence_rules", 1),
            ("task_reminders", 2),
            ("task_agent_links", 1),
            ("task_categories", 1),
            ("agent_sources", 0), // upsert 合并：≥9 个预置来源
            ("agent_sessions", 2),
            ("agent_runs", 2),
            ("agent_events", 3),
            ("notification_history", 2),
        ] {
            if table == "agent_sources" {
                let n: i64 = db2
                    .with_conn(|c| {
                        c.query_row("SELECT COUNT(*) FROM agent_sources", [], |r| r.get(0))
                            .map_err(AppError::from)
                    })
                    .unwrap();
                assert!(n >= 9, "来源注册表应保留预置来源，实际 {}", n);
                continue;
            }
            let n: i64 = db2
                .with_conn(|c| {
                    c.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
                        .map_err(AppError::from)
                })
                .unwrap();
            assert_eq!(n, expect, "{} 恢复数量不符", table);
        }
        // 设置恢复
        let theme = db2.get_setting("theme").unwrap().unwrap();
        assert_eq!(theme, serde_json::json!("dark"));
        // http_token 不随导出流转
        assert!(v1["settings"].get("http_token").is_none());
    }

    fn seed_light(db: &Db) {
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('old-task','旧任务','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn import_v1_with_orphan_runs_synthesizes_sessions() {
        // P0 缺陷现场：v0.3 导出的 v1 文件含 agent_runs 但无 agent_sessions
        let db = memdb();
        seed_light(&db);
        let v1 = serde_json::json!({
            "app": "task-dock",
            "version": 1,
            "tasks": [{
                "id": "t1", "title": "旧任务", "description": "", "priority": 2, "status": "pending",
                "category": "", "tags": "[]", "due_at": null, "remind_at": null, "advance_minutes": 0,
                "recurrence_rule_id": null, "created_at": "2026-10-20T10:00:00+00:00",
                "updated_at": "2026-10-20T10:00:00+00:00", "completed_at": null
            }],
            "recurrence_rules": [],
            "task_reminders": [],
            "task_agent_links": [],
            "task_categories": [],
            "agent_runs": [{
                "id": "run-x", "session_id": "sess-x", "source_id": "codex", "external_run_id": "rx",
                "task_title": "历史轮次", "status": "completed",
                "started_at": "2026-10-21T10:00:00+00:00", "updated_at": "2026-10-21T11:00:00+00:00",
                "ended_at": "2026-10-21T11:00:00+00:00", "pending_items": "[]", "meta": "{}"
            }],
            "notification_history": [],
            "settings": {}
        });
        import_value(&db, &v1).unwrap();
        let n: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM agent_runs WHERE id = 'run-x'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 1, "孤儿 run 必须成功恢复（不再外键报错）");
        let sess: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT external_id FROM agent_sessions WHERE id = 'sess-x'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(sess.starts_with("recovered-"), "应合成占位会话");
    }

    #[test]
    fn import_v2_missing_sessions_is_rejected_and_original_preserved() {
        let db = memdb();
        seed_light(&db);
        let v2 = serde_json::json!({
            "app": "task-dock",
            "version": 2,
            "tasks": [],
            "recurrence_rules": [],
            "task_reminders": [],
            "task_agent_links": [],
            "task_categories": [],
            "agent_sources": [],
            "agent_instances": [],
            "agent_sessions": [],
            "agent_runs": [{
                "id": "run-x", "session_id": "ghost", "source_id": "codex", "external_run_id": null,
                "task_title": "", "status": "running",
                "started_at": "2026-10-21T10:00:00+00:00", "updated_at": "2026-10-21T11:00:00+00:00",
                "ended_at": null, "pending_items": "[]", "meta": "{}"
            }],
            "agent_events": [],
            "notification_history": [],
            "settings": {}
        });
        let err = import_value(&db, &v2).unwrap_err();
        assert!(
            err.to_string().contains("agent_sessions"),
            "v2 文件引用缺失会话应报明确错误: {}",
            err
        );
        // 原库数据保留
        let n: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM tasks WHERE id = 'old-task'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 1, "导入失败必须保留原数据库");
    }

    #[test]
    fn import_rejects_wrong_types_and_missing_fields() {
        let db = memdb();
        // fired 是字符串（旧 Value 绑定缺陷现场）
        let bad_bool = serde_json::json!({
            "app": "task-dock", "version": 2,
            "tasks": [], "recurrence_rules": [],
            "task_reminders": [{
                "id": "r", "task_id": "t", "remind_at": "x", "occurrence": "x",
                "kind": "due", "fired": "yes", "fired_at": null
            }],
            "task_agent_links": [], "task_categories": [],
            "agent_sources": [], "agent_instances": [], "agent_sessions": [],
            "agent_runs": [], "agent_events": [], "notification_history": [],
            "settings": {}
        });
        let err = import_value(&db, &bad_bool).unwrap_err();
        assert!(
            err.to_string().contains("task_reminders"),
            "类型错误应指明表名: {}",
            err
        );
        // 缺必需字段
        let missing = serde_json::json!({
            "app": "task-dock", "version": 2,
            "tasks": [{ "id": "t1", "title": "缺字段" }],
            "recurrence_rules": [], "task_reminders": [], "task_agent_links": [],
            "task_categories": [], "agent_sources": [], "agent_instances": [],
            "agent_sessions": [], "agent_runs": [], "agent_events": [],
            "notification_history": [], "settings": {}
        });
        assert!(import_value(&db, &missing).is_err(), "必需字段缺失必须拒绝");
        // 版本不合法
        let bad_ver = serde_json::json!({ "app": "task-dock", "version": 99 });
        assert!(import_value(&db, &bad_ver).is_err());
        // 非 Task Dock 文件
        let not_ours = serde_json::json!({ "app": "other", "version": 1 });
        assert!(import_value(&db, &not_ours).is_err());
    }

    #[test]
    fn import_rejects_dangling_references() {
        let db = memdb();
        let dangling_reminder = serde_json::json!({
            "app": "task-dock", "version": 2,
            "tasks": [], "recurrence_rules": [],
            "task_reminders": [{
                "id": "r", "task_id": "ghost-task", "remind_at": "x", "occurrence": "x",
                "kind": "due", "fired": false, "fired_at": null
            }],
            "task_agent_links": [], "task_categories": [],
            "agent_sources": [], "agent_instances": [], "agent_sessions": [],
            "agent_runs": [], "agent_events": [], "notification_history": [],
            "settings": {}
        });
        let err = import_value(&db, &dangling_reminder).unwrap_err();
        assert!(
            err.to_string().contains("不存在的任务"),
            "引用完整性校验: {}",
            err
        );
    }

    #[test]
    fn import_preserves_local_http_token_and_registry() {
        let db = memdb();
        seed_full(&db);
        let token_before: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT value FROM application_settings WHERE key = 'http_token'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(AppError::from)
            })
            .unwrap()
            .expect("seed 后存在 token");
        let v = collect(&db).unwrap();
        import_value(&db, &v).unwrap();
        let token_after: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT value FROM application_settings WHERE key = 'http_token'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(token_before, token_after, "导入不得覆盖本机 http_token");
    }
}
