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
//!
//! v3 格式（Task Dock 0.4 统一导航）：
//! - 纳入 `navigation_targets`、`task_navigation_targets`，修复「备份/恢复后用户
//!   确认过的导航目标与任务关联全部丢失」的数据缺口（v2 只导出了任务与 Agent 数据）；
//! - `navigation_log` 的策略：它是**诊断流水**而非用户配置——导出保留最近
//!   `NAV_LOG_EXPORT_LIMIT` 条，恢复时整体替换；它不参与引用完整性校验
//!   （`target_id` 允许指向已删除的目标），因此旧文件缺该键、或日志里的目标
//!   早已不存在，都不会让整次恢复失败；
//! - 引用完整性新增：task_navigation_targets → tasks / navigation_targets、
//!   agent_session 目标 → agent_sources；并在 COMMIT 前执行
//!   `PRAGMA foreign_key_check` 作为最后一道闸门，任何外键残留整体回滚；
//! - 向后兼容：v1 / v2 文件缺导航表 → 视为空表，其余数据照常恢复
//!   （旧备份不会因为「没有导航数据」而被拒绝）。
//!
//! v3.1 校验策略（删除 Agent 来源后备份可恢复性）：
//! 「历史引用已失效」与「非法伪造引用」分开处理——
//! - **伪造/损坏（整体拒绝）**：结构非法、目标类型非法、身份字段为空、
//!   agent_session 目标的会话 ID 不过白名单、关联引用不存在的任务/导航目标
//!   （有真实外键的引用必须完整）；
//! - **历史失效（接受并保留）**：task_agent_links 与 agent_session 导航目标指向的
//!   来源/会话已不存在（典型场景：删除来源之后才做的备份）。这些列没有外键约束，
//!   引用按历史记录保留；恢复后 UI 如实显示 `unavailable`，用户可解除或重新关联。
//!   合法备份绝不因「来源已删除」而整体恢复失败。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

// v4 增加任务级窗口配置；旧版本应拒绝导入，而不是静默丢失该配置。
const EXPORT_VERSION: i64 = 4;
/// 导航日志是诊断流水：只导出最近这些条，恢复时整体替换。
const NAV_LOG_EXPORT_LIMIT: i64 = 500;
/// 事件流水同理：仅导出最近这些条，避免备份随工具进度无限膨胀、内存无界。
/// 用户可见状态/审计结论保存在 agent_runs（全量导出），事件流水缺失不影响状态恢复。
const EVENT_EXPORT_LIMIT: i64 = 20_000;

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
    /// 关联所有权（v5）：user = 用户手工创建；auto = 导航关联自动补写的影子记录。
    /// 旧版本导出文件没有该字段 → 视为 user（保守：自动逻辑不删历史行）。
    #[serde(default = "default_link_origin")]
    pub origin: String,
}

fn default_link_origin() -> String {
    "user".into()
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
    /// v3：用户确认过的导航目标（可信启动配置）
    nav_targets: Vec<NavTargetRowData>,
    /// v3：任务 ↔ 导航目标关联（导入后必须原样恢复，否则用户工作区配置丢失）
    task_nav_targets: Vec<TaskNavTargetRowData>,
    /// v3：导航诊断流水（允许指向已删除目标，不参与引用完整性校验）
    nav_logs: Vec<NavLogRowData>,
    settings: serde_json::Map<String, serde_json::Value>,
}

// ── v3 导航行结构 ──────────────────────────────────────────

fn default_launch_behavior() -> String {
    "default".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavTargetRowData {
    pub id: String,
    pub display_name: String,
    pub target_type: String,
    pub app_key: String,
    #[serde(default)]
    pub exe_path: String,
    #[serde(default)]
    pub launch_args: String,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub app_user_model_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub agent_source_id: String,
    #[serde(default)]
    pub agent_session_id: String,
    #[serde(default)]
    pub window_title_hint: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub use_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNavTargetRowData {
    pub id: String,
    pub task_id: String,
    pub target_id: String,
    #[serde(default)]
    pub display_order: i64,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default = "default_launch_behavior")]
    pub launch_behavior: String,
    pub created_at: String,
    #[serde(default)]
    pub window_identity: Option<String>,
    #[serde(default = "default_window_fallback")]
    pub window_fallback: String,
}

fn default_window_fallback() -> String {
    "reselect".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavLogRowData {
    pub id: String,
    #[serde(default)]
    pub target_id: String,
    #[serde(default)]
    pub target_name: String,
    pub requested_action: String,
    #[serde(default)]
    pub actual_action: Option<String>,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub fallback_used: bool,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub verification_level: String,
    pub created_at: String,
}

/// 收集全量数据（导出/备份共用）。
/// 单个只读事务内读取全部表：与调度器/接入写入并发时仍得到一致性快照。
fn collect(db: &Db) -> AppResult<serde_json::Value> {
    // 只占用读连接池：WAL 下读写互不阻塞，备份不会长时间持锁拖慢主路径。
    db.with_read(|conn| {
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
            "SELECT id, task_id, source_id, session_external_id, run_external_id, created_at, origin FROM task_agent_links",
            |r| Ok(LinkRow {
                id: r.get(0)?, task_id: r.get(1)?, source_id: r.get(2)?, session_external_id: r.get(3)?,
                run_external_id: r.get(4)?, created_at: r.get(5)?, origin: r.get(6)?,
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
        let events: Vec<EventRow> = query_rows_with(&tx,
            "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key
             FROM agent_events ORDER BY received_at DESC, id DESC LIMIT ?1",
            rusqlite::params![EVENT_EXPORT_LIMIT],
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
        // v3：导航目标（用户确认过的可信启动配置）
        let nav_targets: Vec<NavTargetRowData> = query_rows(&tx,
            "SELECT id, display_name, target_type, app_key, exe_path, launch_args, working_dir,
                    app_user_model_id, url, path, agent_source_id, agent_session_id,
                    window_title_hint, icon, category, favorite, hidden, last_used_at,
                    use_count, created_at, updated_at
             FROM navigation_targets",
            |r| Ok(NavTargetRowData {
                id: r.get(0)?, display_name: r.get(1)?, target_type: r.get(2)?, app_key: r.get(3)?,
                exe_path: r.get(4)?, launch_args: r.get(5)?, working_dir: r.get(6)?,
                app_user_model_id: r.get(7)?, url: r.get(8)?, path: r.get(9)?,
                agent_source_id: r.get(10)?, agent_session_id: r.get(11)?,
                window_title_hint: r.get(12)?, icon: r.get(13)?, category: r.get(14)?,
                favorite: r.get::<_, i64>(15)? != 0, hidden: r.get::<_, i64>(16)? != 0,
                last_used_at: r.get(17)?, use_count: r.get(18)?,
                created_at: r.get(19)?, updated_at: r.get(20)?,
            }))?;
        // v3：任务 ↔ 导航目标关联（工作区配置本体）
        let task_nav_targets: Vec<TaskNavTargetRowData> = query_rows(&tx,
            "SELECT id, task_id, target_id, display_order, is_default, launch_behavior, created_at, window_identity, window_fallback
             FROM task_navigation_targets",
            |r| Ok(TaskNavTargetRowData {
                id: r.get(0)?, task_id: r.get(1)?, target_id: r.get(2)?,
                display_order: r.get(3)?, is_default: r.get::<_, i64>(4)? != 0,
                launch_behavior: r.get(5)?, created_at: r.get(6)?, window_identity: r.get(7)?, window_fallback: r.get(8)?,
            }))?;
        // v3：导航流水（诊断用，按时间截断，避免备份文件无限膨胀）
        let nav_logs: Vec<NavLogRowData> = query_rows_with(&tx,
            "SELECT id, target_id, target_name, requested_action, actual_action, success,
                    fallback_used, reason, verification_level, created_at
             FROM navigation_log ORDER BY created_at DESC, id DESC LIMIT ?1",
            rusqlite::params![NAV_LOG_EXPORT_LIMIT],
            |r| Ok(NavLogRowData {
                id: r.get(0)?, target_id: r.get(1)?, target_name: r.get(2)?,
                requested_action: r.get(3)?, actual_action: r.get(4)?,
                success: r.get::<_, i64>(5)? != 0, fallback_used: r.get::<_, i64>(6)? != 0,
                reason: r.get(7)?, verification_level: r.get(8)?, created_at: r.get(9)?,
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
            "navigation_targets": nav_targets,
            "task_navigation_targets": task_nav_targets,
            "navigation_log": nav_logs,
            "settings": serde_json::Value::Object(settings),
        }))
    })
}

fn query_rows<T>(
    conn: &rusqlite::Connection,
    sql: &str,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<Vec<T>> {
    query_rows_with(conn, sql, [], map)
}

/// 带绑定参数的查询（导航流水按 LIMIT 截断时使用）。
fn query_rows_with<T, P: rusqlite::Params>(
    conn: &rusqlite::Connection,
    sql: &str,
    params: P,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, map)?;
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
/// 走阻塞线程池：大库序列化不占主线程，UI 不卡顿。
#[tauri::command]
pub async fn export_data(db: State<'_, Arc<Db>>, path: String) -> AppResult<String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let data = collect(&db)?;
        let pretty = serde_json::to_string_pretty(&data)?;
        write_json_atomic(Path::new(&path), &pretty)?;
        tracing::info!("数据已导出: {}", path);
        Ok::<_, AppError>(path)
    })
    .await
    .map_err(|e| AppError::Agent(format!("导出任务中断: {}", e)))?
}

fn backup_now_inner(app: &tauri::AppHandle, db: &Db) -> AppResult<String> {
    let dir = backup_dir(app)?;
    let data = collect(db)?;
    let pretty = serde_json::to_string_pretty(&data)?;
    let path = dir.join(format!(
        "backup-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    write_json_atomic(&path, &pretty)?;
    prune_backups(app, db)?;
    tracing::info!("本地备份完成: {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

/// 立即备份到应用数据目录。
#[tauri::command]
pub async fn backup_now(app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> AppResult<String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup_now_inner(&app, &db))
        .await
        .map_err(|e| AppError::Agent(format!("备份任务中断: {}", e)))?
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
pub async fn auto_backup_if_needed(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<Option<String>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || auto_backup_if_needed_inner(&app, &db))
        .await
        .map_err(|e| AppError::Agent(format!("自动备份任务中断: {}", e)))?
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
/// - 数据版本：1（v0.3 旧格式，缺 Agent 表）/ 2（完整 Agent 格式）/
///   3（v0.4，含导航三表）；缺表按空表处理，旧备份不会被拒绝；
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
        // v1/v2 文件没有这三张表 → rows_of 返回空表（向后兼容，不视为损坏）
        nav_targets: rows_of(data, "navigation_targets")?,
        task_nav_targets: rows_of(data, "task_navigation_targets")?,
        nav_logs: rows_of(data, "navigation_log")?,
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
    dup_check(&parsed.nav_targets, |t| t.id.clone(), "navigation_targets")?;
    dup_check(
        &parsed.task_nav_targets,
        |l| l.id.clone(),
        "task_navigation_targets",
    )?;
    dup_check(&parsed.nav_logs, |l| l.id.clone(), "navigation_log")?;
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
        // v3：UNIQUE(task_id, target_id) —— 同一任务同一目标只允许一行
        let mut seen = std::collections::HashSet::new();
        for l in &parsed.task_nav_targets {
            if !seen.insert((l.task_id.clone(), l.target_id.clone())) {
                return Err(AppError::Validation(
                    "task_navigation_targets 违反 UNIQUE(task_id, target_id)".into(),
                ));
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
    let nav_target_ids: std::collections::HashSet<String> =
        parsed.nav_targets.iter().map(|t| t.id.clone()).collect();
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
        // 身份为空 = 伪造/损坏数据（正常路径不可能产生），整体拒绝；
        // 来源不存在 = 历史失效（如来源删除后才做的备份），按历史记录保留。
        // task_agent_links.source_id 没有外键约束，保留不破坏引用完整性。
        if l.source_id.trim().is_empty() || l.session_external_id.trim().is_empty() {
            return Err(AppError::Validation(format!(
                "task_agent_links[{}] 身份字段为空（来源或会话 ID 缺失）",
                l.id
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

    // v3：导航目标的类型与身份校验。
    // 校验分两层：
    // - 伪造/损坏（拒绝）：类型非法、agent_session 身份为空、会话 ID 不过白名单；
    // - 历史失效（接受）：来源/会话在文件与本地库都不存在（如删除来源后才做的备份）。
    //   agent_source_id/agent_session_id 没有外键约束，目标行保留后由 UI 如实显示
    //   `unavailable`，用户可解除或重新关联——合法备份绝不因此整体恢复失败。
    const NAV_TYPES: &[&str] = &["application", "url", "file", "directory", "agent_session"];
    let mut known_sessions: std::collections::HashSet<(String, String)> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT source_id, external_id FROM agent_sessions")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })?
        .into_iter()
        .collect();
    for s in &parsed.sessions {
        known_sessions.insert((s.source_id.clone(), s.external_id.clone()));
    }
    let mut stale_agent_targets: usize = 0;
    for t in &parsed.nav_targets {
        if !NAV_TYPES.contains(&t.target_type.as_str()) {
            return Err(AppError::Validation(format!(
                "navigation_targets[{}] 目标类型非法: {}",
                t.id, t.target_type
            )));
        }
        if t.target_type == "agent_session" {
            if t.agent_source_id.trim().is_empty() || t.agent_session_id.trim().is_empty() {
                return Err(AppError::Validation(format!(
                    "navigation_targets[{}] 是 Agent 会话目标，但缺少来源或会话 ID",
                    t.id
                )));
            }
            // 会话 ID 白名单（与保存/执行路径一致）：不过白名单的必然是伪造数据
            if let Err(e) = crate::agents::validate_session_id(&t.agent_session_id) {
                return Err(AppError::Validation(format!(
                    "navigation_targets[{}] 会话 ID 非法: {}",
                    t.id, e
                )));
            }
            let stale = !known_sources.contains(&t.agent_source_id)
                || !known_sessions
                    .contains(&(t.agent_source_id.clone(), t.agent_session_id.clone()));
            if stale {
                stale_agent_targets += 1;
                tracing::info!(
                    "导航目标 {} 指向的 Agent 会话 {}/{} 已不存在，保留为失效引用（恢复后显示 unavailable）",
                    t.id,
                    t.agent_source_id,
                    t.agent_session_id
                );
            }
        }
    }
    if stale_agent_targets > 0 {
        tracing::info!(
            "共 {} 个 Agent 会话导航目标为历史失效引用，已按策略保留",
            stale_agent_targets
        );
    }
    // v3：任务 ↔ 目标关联的引用完整性（导入后工作区配置不能指向已不存在的行）
    for l in &parsed.task_nav_targets {
        if !task_ids.contains(&l.task_id) {
            return Err(AppError::Validation(format!(
                "task_navigation_targets[{}] 引用了不存在的任务: {}",
                l.id, l.task_id
            )));
        }
        if !nav_target_ids.contains(&l.target_id) {
            return Err(AppError::Validation(format!(
                "task_navigation_targets[{}] 引用了不存在的导航目标: {}",
                l.id, l.target_id
            )));
        }
        if !["reselect", "focus_app", "launch"].contains(&l.window_fallback.as_str()) {
            return Err(AppError::Validation(format!(
                "关联 {} 的窗口降级策略无效",
                l.id
            )));
        }
        if let Some(raw) = &l.window_identity {
            let m: crate::navigation::window_manager::WindowMemory = serde_json::from_str(raw)
                .map_err(|_| AppError::Validation(format!("关联 {} 的窗口身份无效", l.id)))?;
            let target = parsed
                .nav_targets
                .iter()
                .find(|t| t.id == l.target_id)
                .unwrap();
            if target.target_type != "application"
                || m.origin != crate::navigation::window_manager::MemoryOrigin::User
                || m.exe_path.is_empty()
                || !m.exe_path.eq_ignore_ascii_case(&target.exe_path)
                || m.class_name.is_empty()
                || m.title.is_empty()
            {
                return Err(AppError::Validation(format!(
                    "关联 {} 的窗口身份与应用不一致",
                    l.id
                )));
            }
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
            // 顺序约束：先清关联表，再清被引用表（task_navigation_targets 同时引用
            // tasks 与 navigation_targets，必须在两者之前删除）。
            for table in [
                "task_navigation_targets",
                "task_agent_links",
                "task_reminders",
                "agent_events",
                "agent_runs",
                "agent_sessions",
                "agent_instances",
                "navigation_targets",
                "navigation_log",
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
                    "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at, origin) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![l.id, l.task_id, l.source_id, l.session_external_id, l.run_external_id, l.created_at, l.origin],
                )?;
            }
            for n in &parsed.notifications {
                conn.execute(
                    "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![n.id, n.kind, n.title, n.body, n.ref_type, n.ref_id, n.occurrence, n.is_read as i64, n.created_at],
                )?;
            }
            // v3：导航目标（用户确认过的可信启动配置）→ 必须在任务关联之前写入
            for t in &parsed.nav_targets {
                conn.execute(
                    "INSERT INTO navigation_targets
                       (id, display_name, target_type, app_key, exe_path, launch_args, working_dir,
                        app_user_model_id, url, path, agent_source_id, agent_session_id,
                        window_title_hint, icon, category, favorite, hidden, last_used_at,
                        use_count, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
                    rusqlite::params![
                        t.id, t.display_name, t.target_type, t.app_key, t.exe_path, t.launch_args,
                        t.working_dir, t.app_user_model_id, t.url, t.path, t.agent_source_id,
                        t.agent_session_id, t.window_title_hint, t.icon, t.category,
                        t.favorite as i64, t.hidden as i64, t.last_used_at, t.use_count,
                        t.created_at, t.updated_at,
                    ],
                )?;
            }
            // v3：任务 ↔ 目标关联（工作区配置本体，导入后必须与导出前一致）
            for l in &parsed.task_nav_targets {
                conn.execute(
                    "INSERT INTO task_navigation_targets
                       (id, task_id, target_id, display_order, is_default, launch_behavior, created_at, window_identity, window_fallback)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![
                        l.id, l.task_id, l.target_id, l.display_order, l.is_default as i64,
                        l.launch_behavior, l.created_at, l.window_identity, l.window_fallback,
                    ],
                )?;
            }
            // v3：导航流水（诊断数据，整体替换，不参与引用完整性）
            for l in &parsed.nav_logs {
                conn.execute(
                    "INSERT INTO navigation_log
                       (id, target_id, target_name, requested_action, actual_action, success,
                        fallback_used, reason, verification_level, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![
                        l.id, l.target_id, l.target_name, l.requested_action, l.actual_action,
                        l.success as i64, l.fallback_used as i64, l.reason,
                        l.verification_level, l.created_at,
                    ],
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
            // 最后一道闸门：SQLite 自己再查一遍外键（不信任上面的手写校验，
            // 也覆盖「手写校验没预料到的新引用」）。有任何残留 → 整体回滚。
            let violations: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check",
                [],
                |r| r.get(0),
            )?;
            if violations > 0 {
                return Err(AppError::Validation(format!(
                    "导入后存在 {} 处外键引用不一致，已整体回滚（原数据未改动）",
                    violations
                )));
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

fn import_data_inner(app: &tauri::AppHandle, db: &Db, path: &str) -> AppResult<()> {
    let raw = std::fs::read_to_string(path)?;
    let data: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("导出文件不是合法 JSON: {}", e)))?;
    // 先校验再备份再导入：校验失败不动原库、不产生无意义备份
    parse_and_validate(db, &data)?;
    let _ = backup_now_inner(app, db)?;
    import_value(db, &data)?;
    tracing::info!("数据导入完成: {}", path);
    Ok(())
}

/// 从 JSON 文件导入（整体替换，导入前自动备份当前数据）。
/// 校验/备份/单事务导入全部在阻塞线程池执行，避免大文件卡住 UI 主线程。
#[tauri::command]
pub async fn import_data(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    path: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || import_data_inner(&app, &db, &path))
        .await
        .map_err(|e| AppError::Agent(format!("导入任务中断: {}", e)))?
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
            // v3 导航配置：普通应用目标 + Agent 会话目标 + 两条任务关联 + 一条流水
            c.execute(
                "INSERT INTO navigation_targets
                   (id, display_name, target_type, app_key, exe_path, launch_args, working_dir,
                    app_user_model_id, url, path, agent_source_id, agent_session_id,
                    window_title_hint, icon, category, favorite, hidden, last_used_at,
                    use_count, created_at, updated_at)
                 VALUES ('nt-app','记事本','application','c:\\windows\\notepad.exe',
                    'C:\\Windows\\notepad.exe','--flag \"C:\\My Dir\"','','','','','','','',
                    '','dev',1,0,'2026-10-25T01:00:00+00:00',7,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO navigation_targets
                   (id, display_name, target_type, app_key, exe_path, launch_args, working_dir,
                    app_user_model_id, url, path, agent_source_id, agent_session_id,
                    window_title_hint, icon, category, favorite, hidden, last_used_at,
                    use_count, created_at, updated_at)
                 VALUES ('nt-agent','Codex 联调会话','agent_session','codex:s-1',
                    '','','','','','','codex','s-1','','','',0,0,NULL,0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO task_navigation_targets
                   (id, task_id, target_id, display_order, is_default, launch_behavior, created_at)
                 VALUES ('tnl-1','task-1','nt-app',0,1,'focus_or_launch',?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO task_navigation_targets
                   (id, task_id, target_id, display_order, is_default, launch_behavior, created_at)
                 VALUES ('tnl-2','task-1','nt-agent',1,0,'resume_session',?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO navigation_log
                   (id, target_id, target_name, requested_action, actual_action, success,
                    fallback_used, reason, verification_level, created_at)
                 VALUES ('nl-1','nt-app','记事本','open_app','open_app',1,0,'','process-spawned',?1)",
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
            ("navigation_targets", 2),
            ("task_navigation_targets", 2),
            ("navigation_log", 1),
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

        // v3 关键断言：任务 ↔ 导航目标关联必须逐字段回来
        // （旧实现只导出任务与 Agent 数据，恢复后用户的工作区配置会静默消失）
        let links: Vec<(String, i64, i64, String)> = db2
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT target_id, display_order, is_default, launch_behavior
                     FROM task_navigation_targets WHERE task_id = 'task-1' ORDER BY display_order",
                )?;
                let rows =
                    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(
            links,
            vec![
                ("nt-app".to_string(), 0, 1, "focus_or_launch".to_string()),
                ("nt-agent".to_string(), 1, 0, "resume_session".to_string()),
            ],
            "导航关联的顺序/默认/行为必须原样恢复"
        );
        // Agent 会话目标的身份字段不能丢（丢了就点不动）
        let agent_target: (String, String, String) = db2
            .with_conn(|c| {
                c.query_row(
                    "SELECT target_type, agent_source_id, agent_session_id
                     FROM navigation_targets WHERE id = 'nt-agent'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(
            agent_target,
            ("agent_session".into(), "codex".into(), "s-1".into())
        );
        // 启动参数里的引号与空格必须逐字符保留（导出层不得做任何"清洗"）
        let args: String = db2
            .with_conn(|c| {
                c.query_row(
                    "SELECT launch_args FROM navigation_targets WHERE id = 'nt-app'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(args, "--flag \"C:\\My Dir\"");
        // 外键闸门：导入完成后全库无违规
        let violations: i64 = db2
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn task_window_identity_and_fallback_survive_backup_restore() {
        let db = memdb();
        seed_full(&db);
        let w = crate::navigation::window_manager::WindowInfo {
            hwnd: 987654321,
            pid: 11,
            title: "文档 A".into(),
            class_name: "Class".into(),
            is_minimized: false,
            exe_path: Some("C:\\Windows\\notepad.exe".into()),
        };
        crate::navigation::target_resolver::set_task_window(&db, "tnl-1", Some(&w)).unwrap();
        crate::navigation::target_resolver::set_task_window_fallback(&db, "tnl-1", "focus_app")
            .unwrap();
        let exported = collect(&db).unwrap();
        assert_eq!(exported["version"], 4);
        assert!(!exported.to_string().contains("987654321"));
        let restored = memdb();
        import_value(&restored, &exported).unwrap();
        let (identity, fallback) =
            crate::navigation::target_resolver::task_window_config(&restored, "tnl-1", "nt-app")
                .unwrap();
        assert_eq!(identity.unwrap().title, "文档 A");
        assert_eq!(fallback, "focus_app");
        let mut invalid = exported.clone();
        invalid["task_navigation_targets"][0]["window_fallback"] = serde_json::json!("unknown");
        assert!(import_value(&restored, &invalid).is_err());
        assert_eq!(
            crate::navigation::target_resolver::task_window_config(&restored, "tnl-1", "nt-app")
                .unwrap()
                .1,
            "focus_app"
        );
    }

    /// 旧版（v2）备份没有导航三表：必须被接受，且不把现有导航配置当成"损坏"。
    #[test]
    fn import_v2_backup_without_navigation_keys_is_accepted() {
        let db = memdb();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('t-old','旧任务','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        // 模拟 v2 文件：完全没有 navigation_* 键
        let v2 = serde_json::json!({
            "app": "task-dock",
            "version": 2,
            "exported_at": now,
            "tasks": [{
                "id": "t-old", "title": "旧任务", "description": "", "priority": 2,
                "status": "pending", "category": "", "tags": "[]", "due_at": null,
                "remind_at": null, "advance_minutes": 0, "recurrence_rule_id": null,
                "created_at": now, "updated_at": now, "completed_at": null
            }],
            "recurrence_rules": [], "task_reminders": [], "task_agent_links": [],
            "task_categories": [], "agent_sources": [], "agent_instances": [],
            "agent_sessions": [], "agent_runs": [], "agent_events": [],
            "notification_history": [], "settings": {}
        });
        import_value(&db, &v2).expect("缺导航表的旧备份必须仍可导入");
        let n: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 1, "旧备份的任务应正常恢复");
        let nav: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM navigation_targets", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(nav, 0, "缺表即视为空，不得凭空生成");
    }

    /// 导航目标类型非法（手工编辑 / 跨版本脏数据）：必须明确拒绝。
    #[test]
    fn import_rejects_illegal_navigation_target_type() {
        let db = memdb();
        let now = now_iso();
        let bad = serde_json::json!({
            "app": "task-dock", "version": 3, "exported_at": now,
            "tasks": [], "recurrence_rules": [], "task_reminders": [],
            "task_agent_links": [], "task_categories": [], "agent_sources": [],
            "agent_instances": [], "agent_sessions": [], "agent_runs": [],
            "agent_events": [], "notification_history": [],
            "navigation_targets": [{
                "id": "n1", "display_name": "坏目标", "target_type": "shell_command",
                "app_key": "x", "created_at": now, "updated_at": now
            }],
            "task_navigation_targets": [], "navigation_log": [], "settings": {}
        });
        let err = import_value(&db, &bad).unwrap_err();
        assert!(err.to_string().contains("目标类型非法"), "实际: {}", err);
    }

    /// 伪造引用 vs 历史失效引用，校验策略必须不同：
    /// - 会话 ID 不过白名单 / 身份为空 = 伪造，整体拒绝；
    /// - 身份合法但来源/会话已不存在 = 历史失效，接受并保留（恢复后显示失效）。
    #[test]
    fn import_rejects_forged_agent_target_but_accepts_stale_one() {
        let db = memdb();
        let now = now_iso();
        let mk = |session: &str| {
            serde_json::json!({
                "app": "task-dock", "version": 3, "exported_at": now,
                "tasks": [], "recurrence_rules": [], "task_reminders": [],
                "task_agent_links": [], "task_categories": [], "agent_sources": [],
                "agent_instances": [], "agent_sessions": [], "agent_runs": [],
                "agent_events": [], "notification_history": [],
                "navigation_targets": [{
                    "id": "n1", "display_name": "会话目标", "target_type": "agent_session",
                    "app_key": format!("codex:{session}"), "agent_source_id": "codex",
                    "agent_session_id": session, "created_at": now, "updated_at": now
                }],
                "task_navigation_targets": [], "navigation_log": [], "settings": {}
            })
        };
        // 伪造：会话 ID 含空格/特殊字符（过不了白名单）
        let err = import_value(&db, &mk("bad id;rm -rf")).unwrap_err();
        assert!(
            err.to_string().contains("非法"),
            "伪造会话 ID 必须拒绝: {}",
            err
        );
        // 伪造：身份为空
        let empty = serde_json::json!({
            "app": "task-dock", "version": 3, "exported_at": now,
            "tasks": [], "recurrence_rules": [], "task_reminders": [],
            "task_agent_links": [], "task_categories": [], "agent_sources": [],
            "agent_instances": [], "agent_sessions": [], "agent_runs": [],
            "agent_events": [], "notification_history": [],
            "navigation_targets": [{
                "id": "n1", "display_name": "空身份", "target_type": "agent_session",
                "app_key": "codex:", "agent_source_id": "", "agent_session_id": "",
                "created_at": now, "updated_at": now
            }],
            "task_navigation_targets": [], "navigation_log": [], "settings": {}
        });
        let err = import_value(&db, &empty).unwrap_err();
        assert!(
            err.to_string().contains("缺少来源或会话 ID"),
            "实际: {}",
            err
        );
        // 历史失效：身份合法但来源/会话不存在 → 接受，保留目标行
        let stale = mk("ghost-session");
        import_value(&db, &stale).unwrap();
        let kept: (String, String, String) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT target_type, agent_source_id, agent_session_id FROM navigation_targets WHERE id = 'n1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(
            kept,
            (
                "agent_session".into(),
                "codex".into(),
                "ghost-session".into()
            ),
            "历史失效目标必须保留"
        );
        let violations: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(violations, 0, "失效引用列无外键，不得产生外键违规");
    }

    /// 关联身份字段为空 = 伪造/损坏：拒绝（正常路径不可能产生空来源的关联）。
    #[test]
    fn import_rejects_link_with_empty_identity() {
        let db = memdb();
        let now = now_iso();
        let bad = serde_json::json!({
            "app": "task-dock", "version": 3, "exported_at": now,
            "tasks": [{
                "id": "t-1", "title": "任务", "description": "", "priority": 2,
                "status": "pending", "category": "", "tags": "[]", "due_at": null,
                "remind_at": null, "advance_minutes": 0, "recurrence_rule_id": null,
                "created_at": now, "updated_at": now, "completed_at": null
            }],
            "recurrence_rules": [], "task_reminders": [],
            "task_agent_links": [{
                "id": "l1", "task_id": "t-1", "source_id": "",
                "session_external_id": "", "run_external_id": null, "created_at": now
            }],
            "task_categories": [], "agent_sources": [],
            "agent_instances": [], "agent_sessions": [], "agent_runs": [],
            "agent_events": [], "notification_history": [],
            "navigation_targets": [], "task_navigation_targets": [], "navigation_log": [], "settings": {}
        });
        let err = import_value(&db, &bad).unwrap_err();
        assert!(
            err.to_string().contains("身份字段为空"),
            "空身份关联必须拒绝: {}",
            err
        );
    }

    /// 端到端回归（P1）：任务关联 Agent 会话 → 删除来源 → 备份 → 导入全新数据库。
    /// 任务、历史关联、导航目标与失效状态必须完整恢复，外键零违规。
    /// （修复前：导入严格校验会话存在性，整份备份恢复失败。）
    #[test]
    fn delete_source_backup_restore_roundtrip_preserves_tasks_and_marks_unavailable() {
        // ① 建任务 + 来源 + 会话 + 统一导航关联（两表同步）
        let db1 = memdb();
        let now = now_iso();
        db1.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('task-1','联调任务','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO agent_sources (id, display_name, kind, enabled, verified, homepage, note, config, created_at, updated_at)
                 VALUES ('myagent','自定义来源','manual',1,0,'','','{}',?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-1','myagent','ext-1','联调会话','running',?1,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let t = crate::navigation::target_resolver::save_target(
            &db1,
            &crate::navigation::target_resolver::TargetInput {
                target_type: "agent_session".into(),
                display_name: "".into(),
                agent_source_id: "myagent".into(),
                agent_session_id: "ext-1".into(),
                ..Default::default()
            },
        )
        .unwrap();
        crate::navigation::target_resolver::link_task(
            &db1,
            "task-1",
            &t.id,
            false,
            "resume_session",
        )
        .unwrap();
        assert_eq!(
            crate::navigation::target_resolver::task_targets(&db1, "task-1").unwrap()[0]
                .running_state,
            "agent",
            "删除前必须显示为可用"
        );

        // ② 删除来源（模拟 commands::agents::delete_source 的数据生命周期）
        db1.with_conn(|c| {
            c.execute("DELETE FROM agent_runs WHERE source_id = 'myagent'", [])?;
            c.execute("DELETE FROM agent_sessions WHERE source_id = 'myagent'", [])?;
            c.execute(
                "DELETE FROM agent_instances WHERE source_id = 'myagent'",
                [],
            )?;
            c.execute("DELETE FROM agent_sources WHERE id = 'myagent'", [])?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // ③ 备份 → 导入到全新数据库（新库只有预置来源，没有 myagent）
        let backup = collect(&db1).unwrap();
        let db2 = memdb();
        import_value(&db2, &backup).unwrap();

        // ④ 验证：任务恢复、关联数量一致、目标保留、状态如实失效
        let tasks: i64 = db2
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tasks WHERE id = 'task-1'", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(tasks, 1, "用户任务必须完整恢复");
        let links: i64 = db2
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(links, 1, "历史关联记录数量必须与备份一致");
        let nav_links: i64 = db2
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_navigation_targets WHERE task_id = 'task-1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(nav_links, 1, "统一导航关联必须完整恢复");
        let targets = crate::navigation::target_resolver::task_targets(&db2, "task-1").unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].running_state, "unavailable",
            "恢复后必须如实显示目标已失效"
        );
        // 外键闸门：全库零违规
        let violations: i64 = db2
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    /// 备份/恢复后关联所有权一致：origin 字段必须随导出/导入原样保留，
    /// 否则恢复后解除导航关联会误删（或漏删）旧表记录。
    #[test]
    fn link_origin_survives_backup_restore() {
        let db1 = memdb();
        let now = now_iso();
        db1.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('t1','T','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at, origin)
                 VALUES ('l-auto','t1','codex','s-1',NULL,?1,'auto')",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at, origin)
                 VALUES ('l-user','t1','codex','s-2',NULL,?1,'user')",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let backup = collect(&db1).unwrap();
        let db2 = memdb();
        import_value(&db2, &backup).unwrap();
        let origins: Vec<(String, String)> = db2
            .with_conn(|c| {
                let mut stmt = c.prepare("SELECT id, origin FROM task_agent_links ORDER BY id")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(
            origins,
            vec![
                ("l-auto".to_string(), "auto".to_string()),
                ("l-user".to_string(), "user".to_string())
            ],
            "origin 必须随备份原样恢复"
        );
    }

    /// 目标路径不可写（父路径是普通文件）：必须返回可读错误，不得 panic。
    #[test]
    fn export_to_unwritable_path_returns_error_not_panic() {
        let dir = std::env::temp_dir().join(format!("td-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        // 父路径是文件 → 必然无法创建/写入
        let target = blocker.join("out.json");
        let db = memdb();
        let pretty = serde_json::to_string_pretty(&collect(&db).unwrap()).unwrap();
        let err = write_json_atomic(&target, &pretty).unwrap_err();
        assert!(!err.to_string().is_empty(), "不可写路径必须返回明确错误");
        // 原文件未被破坏
        assert_eq!(std::fs::read(&blocker).unwrap(), b"not a directory");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 损坏的 JSON（截断/非对象）：解析层直接拒绝，不触碰数据库。
    #[test]
    fn corrupted_json_payload_is_rejected() {
        let db = memdb();
        // 完全不是 JSON
        assert!(serde_json::from_str::<serde_json::Value>("{ broken").is_err());
        // 是 JSON 但不是对象
        let arr = serde_json::json!([1, 2, 3]);
        let err = parse_and_validate(&db, &arr).unwrap_err();
        assert!(err.to_string().contains("不是 Task Dock"), "实际: {}", err);
        // 版本号越界
        let v999 = serde_json::json!({ "app": "task-dock", "version": 999 });
        assert!(parse_and_validate(&db, &v999).is_err());
    }

    /// 导航关联指向不存在的目标：整次导入必须回滚，原库不动。
    #[test]
    fn import_rejects_dangling_navigation_links_and_rolls_back() {
        let db = memdb();
        seed_light(&db);
        let before: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        let now = now_iso();
        let bad = serde_json::json!({
            "app": "task-dock",
            "version": 3,
            "exported_at": now,
            "tasks": [], "recurrence_rules": [], "task_reminders": [],
            "task_agent_links": [], "task_categories": [], "agent_sources": [],
            "agent_instances": [], "agent_sessions": [], "agent_runs": [],
            "agent_events": [], "notification_history": [],
            "navigation_targets": [],
            "task_navigation_targets": [{
                "id": "bad-link", "task_id": "no-task", "target_id": "no-target",
                "display_order": 0, "is_default": false, "launch_behavior": "default",
                "created_at": now
            }],
            "navigation_log": [], "settings": {}
        });
        let err = import_value(&db, &bad).unwrap_err();
        assert!(
            err.to_string().contains("不存在的任务"),
            "必须明确报出引用错误，实际: {}",
            err
        );
        let after: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(before, after, "校验失败不得删改原库数据");
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
