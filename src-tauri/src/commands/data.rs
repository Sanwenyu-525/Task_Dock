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

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agents::now_iso;
use crate::commands::backup::BackupKind;
use crate::db::Db;
use crate::error::{AppError, AppResult};

// v4 增加任务级窗口配置；v5 增加 Agent 轮次因果水位（事件受理序号/事件时间）。
// 旧版本应拒绝导入，而不是静默丢失这些字段。
pub(crate) const EXPORT_VERSION: i64 = 5;
/// 导航日志是诊断流水：只导出最近这些条，恢复时整体替换。
const NAV_LOG_EXPORT_LIMIT: i64 = 500;
/// 事件流水同理：仅导出最近这些条，避免备份随工具进度无限膨胀、内存无界。
/// 用户可见状态/审计结论保存在 agent_runs（全量导出），事件流水缺失不影响状态恢复。
const EVENT_EXPORT_LIMIT: i64 = 20_000;

fn app_data(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(crate::app_data_dir(app))
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

/// 旧备份没有来源可信分类字段：按真实数据恢复，导入后由 `backfill_origin_labels`
/// 依据可证明的测试前缀重新归类，绝不把旧测试数据直接当真实数据处理。
pub(crate) fn default_origin_real() -> String {
    "real".into()
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
    /// v12：来源可信类别（real / mock / benchmark）
    #[serde(default = "default_origin_real")]
    pub category: String,
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
    /// v12：可信来源分类
    #[serde(default = "default_origin_real")]
    pub origin: String,
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
    /// v12：可信来源分类
    #[serde(default = "default_origin_real")]
    pub origin: String,
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
    /// v5：因果顺序水位；旧备份缺省为 0（不建立屏障，保持既有行为）。
    #[serde(default)]
    pub last_ingest_seq: i64,
    #[serde(default)]
    pub last_event_at: String,
    /// v12：可信来源分类
    #[serde(default = "default_origin_real")]
    pub origin: String,
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
    /// v5：事件受理序号；旧备份缺省为 0。
    #[serde(default)]
    pub ingest_seq: i64,
    /// v12：可信来源分类
    #[serde(default = "default_origin_real")]
    pub origin: String,
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
    /// v12：通知所属 Agent 数据的可信来源分类（reminder 等非 Agent 通知为 real）
    #[serde(default = "default_origin_real")]
    pub agent_origin: String,
}

/// 行数据来源：内存 JSON（旧式整文件导入）或按表落盘的 JSONL（分块备份恢复）。
#[derive(Clone, Copy)]
pub(crate) enum SectionSource<'a> {
    Value(&'a serde_json::Value),
    Dir(&'a Path),
}

impl SectionSource<'_> {
    fn has_table(&self, table: &str) -> bool {
        match self {
            SectionSource::Value(data) => data.get(table).is_some(),
            SectionSource::Dir(dir) => dir.join(format!("{}.jsonl", table)).exists(),
        }
    }
}

/// 事件表可能很大（10 万级）：落盘时保持 JSONL 形式，写库时单遍流式读取，
/// 不在内存里保留整张事件表。
#[derive(Debug)]
enum EventRows {
    Memory(Vec<EventRow>),
    Spilled { path: PathBuf },
}

impl Default for EventRows {
    fn default() -> Self {
        EventRows::Memory(Vec::new())
    }
}

impl EventRows {
    fn for_each_ref(&self, mut f: impl FnMut(usize, &EventRow) -> AppResult<()>) -> AppResult<()> {
        match self {
            EventRows::Memory(rows) => {
                for (i, row) in rows.iter().enumerate() {
                    f(i, row)?;
                }
                Ok(())
            }
            EventRows::Spilled { path } => {
                let dir = path.parent().unwrap_or_else(|| Path::new(""));
                let table = "agent_events";
                crate::commands::backup::for_each_spilled_row_typed(dir, table, |i, row| f(i, &row))
            }
        }
    }
}

/// 解析后的完整导出数据（已通过结构与引用完整性校验）。
#[derive(Debug, Default)]
pub(crate) struct ParsedImport {
    tasks: Vec<TaskRow>,
    rules: Vec<RuleRow>,
    reminders: Vec<ReminderRow>,
    links: Vec<LinkRow>,
    categories: Vec<CategoryRow>,
    sources: Vec<SourceRow>,
    instances: Vec<InstanceRow>,
    sessions: Vec<SessionRow>,
    runs: Vec<RunRow>,
    events: EventRows,
    notifications: Vec<NotificationRowData>,
    /// v3：用户确认过的导航目标（可信启动配置）
    nav_targets: Vec<NavTargetRowData>,
    /// v3：任务 ↔ 导航目标关联（导入后必须原样恢复，否则用户工作区配置丢失）
    task_nav_targets: Vec<TaskNavTargetRowData>,
    /// v3：导航诊断流水（允许指向已删除目标，不参与引用完整性校验）
    nav_logs: Vec<NavLogRowData>,
    settings: serde_json::Map<String, serde_json::Value>,
    /// v6：剪贴板 / 工作现场 / 行动中心（旧备份没有该模块时必须保留现有数据）
    extended: ExtendedModules,
}

#[derive(Debug, Default)]
struct ExtendedModules {
    /// 文件是否显式携带扩展模块。false = 旧备份，恢复时保留库内现有扩展数据。
    active: bool,
    /// 显式出现的数据表 → 行（仅出现过的表会被替换）。
    tables: BTreeMap<&'static str, Vec<serde_json::Map<String, serde_json::Value>>>,
}

/// 导入选项：扩展模块（含图片资产）只能由已校验的分块备份恢复流程启用。
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    pub allow_extended: bool,
    /// 同事务写入的恢复提交标记（用于崩溃后判断数据库是否已提交）。
    pub commit_marker: Option<String>,
}

#[derive(Debug, Clone)]
struct ColumnSpec {
    name: String,
    not_null: bool,
    has_default: bool,
    pk_order: i64,
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
            "SELECT id, display_name, kind, enabled, verified, transport_verified, homepage, note, config, adapter, icon, hidden, last_event_at, category, created_at, updated_at FROM agent_sources",
            |r| Ok(SourceRow {
                id: r.get(0)?, display_name: r.get(1)?, kind: r.get(2)?, enabled: r.get::<_, i64>(3)? != 0,
                verified: r.get::<_, i64>(4)? != 0, transport_verified: r.get::<_, i64>(5)? != 0,
                homepage: r.get(6)?, note: r.get(7)?, config: r.get(8)?, adapter: r.get(9)?,
                icon: r.get(10)?, hidden: r.get::<_, i64>(11)? != 0, last_event_at: r.get(12)?,
                category: r.get(13)?, created_at: r.get(14)?, updated_at: r.get(15)?,
            }))?;
        let instances: Vec<InstanceRow> = query_rows(&tx,
            "SELECT id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, meta, origin FROM agent_instances",
            |r| Ok(InstanceRow {
                id: r.get(0)?, source_id: r.get(1)?, instance_key: r.get(2)?, display_name: r.get(3)?,
                exe_path: r.get(4)?, first_seen_at: r.get(5)?, last_seen_at: r.get(6)?, meta: r.get(7)?,
                origin: r.get(8)?,
            }))?;
        let sessions: Vec<SessionRow> = query_rows(&tx,
            "SELECT id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id, origin FROM agent_sessions",
            |r| Ok(SessionRow {
                id: r.get(0)?, source_id: r.get(1)?, external_id: r.get(2)?, title: r.get(3)?,
                status: r.get(4)?, first_seen_at: r.get(5)?, last_seen_at: r.get(6)?,
                last_run_id: r.get(7)?, instance_id: r.get(8)?, origin: r.get(9)?,
            }))?;
        let runs: Vec<RunRow> = query_rows(&tx,
            "SELECT id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id, last_ingest_seq, last_event_at, origin FROM agent_runs",
            |r| Ok(RunRow {
                id: r.get(0)?, session_id: r.get(1)?, source_id: r.get(2)?, external_run_id: r.get(3)?,
                task_title: r.get(4)?, status: r.get(5)?, started_at: r.get(6)?, updated_at: r.get(7)?,
                ended_at: r.get(8)?, pending_items: r.get(9)?, meta: r.get(10)?,
                instance_id: r.get(11)?, parent_run_id: r.get(12)?,
                last_ingest_seq: r.get(13)?, last_event_at: r.get(14)?, origin: r.get(15)?,
            }))?;
        let events: Vec<EventRow> = query_rows_with(&tx,
            "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key, ingest_seq, origin
             FROM agent_events ORDER BY received_at DESC, id DESC LIMIT ?1",
            rusqlite::params![EVENT_EXPORT_LIMIT],
            |r| Ok(EventRow {
                id: r.get(0)?, source_id: r.get(1)?, session_external_id: r.get(2)?,
                run_external_id: r.get(3)?, event_type: r.get(4)?, state: r.get(5)?,
                message: r.get(6)?, received_at: r.get(7)?, schema_version: r.get::<_, i64>(8)? as u32,
                event_id: r.get(9)?, instance_id: r.get(10)?, parent_run_id: r.get(11)?,
                occurred_at: r.get(12)?, transport: r.get(13)?, evidence_type: r.get(14)?,
                confidence: r.get(15)?, dedupe_key: r.get(16)?, ingest_seq: r.get(17)?,
                origin: r.get(18)?,
            }))?;
        let notifications: Vec<NotificationRowData> = query_rows(&tx,
            "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin FROM notification_history ORDER BY created_at DESC, id DESC LIMIT 500",
            |r| Ok(NotificationRowData {
                id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, body: r.get(3)?,
                ref_type: r.get(4)?, ref_id: r.get(5)?, occurrence: r.get(6)?,
                is_read: r.get::<_, i64>(7)? != 0, created_at: r.get(8)?,
                agent_origin: r.get(9)?,
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

/// 原子写入：临时文件 + rename。
/// 既有目标先轮换、替换失败再恢复——写入中断绝不破坏上一份有效文件。
fn write_json_atomic(path: &Path, content: &str) -> AppResult<()> {
    let tmp = path.with_extension("taskdock-tmp");
    std::fs::write(&tmp, content)?;
    crate::commands::backup::commit_file(&tmp, path)
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

fn backup_file_path(dir: &Path, kind: BackupKind) -> PathBuf {
    dir.join(format!(
        "backup-{}-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        kind.as_str()
    ))
}

fn backup_to_dir(
    data_dir: &Path,
    dir: &Path,
    db: &Db,
    kind: BackupKind,
) -> AppResult<(String, crate::commands::backup::BackupWriteResult)> {
    use crate::commands::backup::BackupSources;
    std::fs::create_dir_all(dir)?;
    let path = backup_file_path(dir, kind);
    let archive = crate::agents::retention::archive_dir(data_dir);
    let clipboard = data_dir.join("clipboard");
    let sources = BackupSources {
        archive_dir: if kind.is_full() {
            Some(archive.as_path())
        } else {
            None
        },
        clipboard_dir: Some(clipboard.as_path()),
    };
    let result = crate::commands::backup::write_bundle(db, sources, &path, kind)?;
    Ok((path.to_string_lossy().to_string(), result))
}

fn backup_now_inner(app: &tauri::AppHandle, db: &Db, kind: BackupKind) -> AppResult<String> {
    let data_dir = app_data(app)?;
    let dir = backup_dir(app)?;
    let (path, result) = backup_to_dir(&data_dir, &dir, db, kind)?;
    prune_backups(app, db)?;
    tracing::info!(
        "本地备份完成: {}（{}，部分={}，{} 字节，SHA-256 {}）",
        path,
        result.kind,
        result.partial,
        result.bytes,
        result.sha256
    );
    Ok(path)
}

/// 立即备份到应用数据目录。
/// `full=false`（默认）为快速备份：显式标记 partial，事件/通知按上限截断；
/// `full=true` 为完整备份：全部任务、全部受保护 Agent 事件、完整通知与事件归档。
#[tauri::command]
pub async fn backup_now(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    full: Option<bool>,
) -> AppResult<String> {
    let db = db.inner().clone();
    let kind = BackupKind::from_full_flag(full);
    tauri::async_runtime::spawn_blocking(move || backup_now_inner(&app, &db, kind))
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
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏写入中的临时文件（`.xxx.tmp-*`）与内部文件
        if !meta.is_file() || name.starts_with('.') {
            continue;
        }
        let bundle = crate::commands::backup::bundle_meta(&entry.path());
        out.push(serde_json::json!({
            "name": name,
            "size": meta.len(),
            "modified": chrono::DateTime::<chrono::Utc>::from(meta.modified()?).to_rfc3339(),
            // 旧版单文件 JSON 备份没有 kind/partial（null），仍可导入
            "kind": bundle.as_ref().and_then(|m| m.get("kind")).cloned().unwrap_or(serde_json::Value::Null),
            "partial": bundle.as_ref().and_then(|m| m.get("partial")).cloned().unwrap_or(serde_json::Value::Null),
            "totals": bundle.as_ref().and_then(|m| m.get("counts")).cloned().unwrap_or(serde_json::Value::Null),
            "truncated_tables": bundle.as_ref().and_then(|m| m.get("truncated_tables")).cloned().unwrap_or(serde_json::Value::Null),
            "extended_modules": bundle.as_ref().and_then(|m| m.get("extended_modules")).cloned().unwrap_or(serde_json::Value::Bool(false)),
        }));
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
        let name = entry.file_name().to_string_lossy().to_string();
        if meta.is_file() && !name.starts_with('.') {
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
        // 自动备份走快速备份：始终显式标记 partial，绝不伪装成完整备份。
        let path = backup_now_inner(app, db, BackupKind::Quick)?;
        tracing::info!("启动自动备份完成: {}", path);
        return Ok(Some(path));
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
    let arr = match data.get(key) {
        Some(v) => v
            .as_array()
            .ok_or_else(|| AppError::Validation(format!("{} 必须是数组", key)))?,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::with_capacity(arr.len());
    // 直接从借用行反序列化：不克隆整段数组与每一行（大备份可省数百 MB 峰值）。
    for (i, item) in arr.iter().enumerate() {
        let row: T = T::deserialize(item).map_err(|e| {
            AppError::Validation(format!("{}[{}] 字段缺失或类型不合法: {}", key, i, e))
        })?;
        out.push(row);
    }
    Ok(out)
}

/// 从内存 JSON 或落盘 JSONL 读取强类型行；错误信息与 `rows_of` 保持一致。
fn table_rows<T: serde::de::DeserializeOwned>(
    src: SectionSource<'_>,
    table: &str,
) -> AppResult<Vec<T>> {
    match src {
        SectionSource::Value(data) => rows_of(data, table),
        SectionSource::Dir(dir) => {
            let mut out = Vec::new();
            crate::commands::backup::for_each_spilled_row_typed(dir, table, |_i, row| {
                out.push(row);
                Ok(())
            })?;
            Ok(out)
        }
    }
}

fn events_of(src: SectionSource<'_>) -> AppResult<EventRows> {
    match src {
        SectionSource::Value(data) => Ok(EventRows::Memory(rows_of(data, "agent_events")?)),
        SectionSource::Dir(dir) => {
            let path = dir.join("agent_events.jsonl");
            if !path.exists() {
                return Ok(EventRows::Memory(Vec::new()));
            }
            Ok(EventRows::Spilled { path })
        }
    }
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

fn table_columns(db: &Db, table: &str) -> AppResult<Vec<ColumnSpec>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
        let rows = stmt.query_map([], |r| {
            Ok(ColumnSpec {
                name: r.get::<_, String>(1)?,
                not_null: r.get::<_, i64>(3)? != 0,
                has_default: r.get::<_, Option<String>>(4)?.is_some(),
                pk_order: r.get::<_, i64>(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

fn normalize_extended_value(
    table: &str,
    column: &str,
    value: &serde_json::Value,
) -> AppResult<serde_json::Value> {
    match value {
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => Ok(value.clone()),
        serde_json::Value::Object(obj) => {
            if obj.len() == 1 {
                if let Some(b64) = obj.get("$blob_b64").and_then(|v| v.as_str()) {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|_| {
                            AppError::Validation(format!("{}.{} 的 Base64 数据非法", table, column))
                        })?;
                    return Ok(value.clone());
                }
            }
            Err(AppError::Validation(format!(
                "{}.{} 是不支持的对象值",
                table, column
            )))
        }
        serde_json::Value::Array(_) => Err(AppError::Validation(format!(
            "{}.{} 是不支持的数组值",
            table, column
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn normalize_extended_row(
    table: &str,
    columns: &[ColumnSpec],
    known: &HashSet<&str>,
    required: &[&str],
    pk: &[&str],
    seen: &mut HashSet<String>,
    i: usize,
    row: &serde_json::Value,
) -> AppResult<serde_json::Map<String, serde_json::Value>> {
    let obj = row
        .as_object()
        .ok_or_else(|| AppError::Validation(format!("{}[{}] 必须是对象", table, i)))?;
    for key in obj.keys() {
        if !known.contains(key.as_str()) {
            return Err(AppError::Validation(format!(
                "{}[{}] 含未知列 {}（拒绝静默丢弃）",
                table, i, key
            )));
        }
    }
    for col in required {
        if !obj.contains_key(*col) || obj.get(*col) == Some(&serde_json::Value::Null) {
            return Err(AppError::Validation(format!(
                "{}[{}] 缺少必填列 {}",
                table, i, col
            )));
        }
    }
    let mut normalized = serde_json::Map::with_capacity(obj.len());
    for (key, value) in obj {
        let col = columns.iter().find(|c| c.name == *key).expect("已检查");
        if value.is_null() && col.not_null {
            return Err(AppError::Validation(format!(
                "{}[{}].{} 不能为空",
                table, i, key
            )));
        }
        normalized.insert(key.clone(), normalize_extended_value(table, key, value)?);
    }
    if !pk.is_empty() {
        let key = serde_json::to_string(
            &pk.iter()
                .map(|c| {
                    normalized
                        .get(*c)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>(),
        )?;
        if !seen.insert(key) {
            return Err(AppError::Validation(format!(
                "{} 存在重复主键行: {:?}",
                table, pk
            )));
        }
    }
    Ok(normalized)
}

/// 解析扩展模块行：列白名单来自目标库 schema，未知列/缺必填列/重复主键在写库前拒绝。
fn parse_extended(
    db: &Db,
    data: &serde_json::Value,
    src: SectionSource<'_>,
) -> AppResult<ExtendedModules> {
    let flag = data
        .get("extended_modules")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let present: Vec<&'static str> = crate::commands::backup::EXTENDED_TABLES
        .iter()
        .copied()
        .filter(|t| src.has_table(t))
        .collect();
    if !flag && present.is_empty() {
        return Ok(ExtendedModules::default());
    }
    if flag || !present.is_empty() {
        for table in crate::commands::backup::EXTENDED_TABLES {
            if !src.has_table(table) {
                return Err(AppError::Validation(format!(
                    "扩展模块必须完整提供，缺少扩展数据表 {}",
                    table
                )));
            }
        }
    }
    let mut modules = ExtendedModules {
        active: true,
        tables: BTreeMap::new(),
    };
    for table in crate::commands::backup::EXTENDED_TABLES {
        if !src.has_table(table) {
            continue;
        }
        let columns = table_columns(db, table)?;
        if columns.is_empty() {
            return Err(AppError::Validation(format!(
                "目标数据库缺少扩展表 {}（无法恢复）",
                table
            )));
        }
        let known: HashSet<&str> = columns.iter().map(|c| c.name.as_str()).collect();
        let required: Vec<&str> = columns
            .iter()
            .filter(|c| c.not_null && !c.has_default)
            .map(|c| c.name.as_str())
            .collect();
        let pk: Vec<&str> = {
            let mut cols: Vec<&ColumnSpec> = columns.iter().filter(|c| c.pk_order > 0).collect();
            cols.sort_by_key(|c| c.pk_order);
            cols.into_iter().map(|c| c.name.as_str()).collect()
        };
        let mut seen: HashSet<String> = HashSet::new();
        let mut rows = Vec::new();
        match src {
            SectionSource::Value(data) => {
                let arr = data
                    .get(*table)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| AppError::Validation(format!("{} 必须是数组", table)))?;
                rows.reserve(arr.len());
                for (i, row) in arr.iter().enumerate() {
                    rows.push(normalize_extended_row(
                        table, &columns, &known, &required, &pk, &mut seen, i, row,
                    )?);
                }
            }
            SectionSource::Dir(dir) => {
                crate::commands::backup::for_each_spilled_row(dir, table, |i, row| {
                    rows.push(normalize_extended_row(
                        table, &columns, &known, &required, &pk, &mut seen, i, &row,
                    )?);
                    Ok(())
                })?;
            }
        }
        modules.tables.insert(*table, rows);
    }
    Ok(modules)
}

/// 解析并校验导出文件（不写库）。
/// - 结构与必需字段：逐表反序列化为强类型行（serde 严格模式，缺字段即报错）；
/// - 数据版本：1（v0.3 旧格式，缺 Agent 表）/ 2（完整 Agent 格式）/
///   3（v0.4，含导航三表）/ 4（任务窗口配置）/ 5（Agent 因果水位）；
///   缺表或新增字段缺省按旧语义处理，旧备份不会被拒绝；
/// - 引用完整性：reminder→task、task→rule、link→task、run→session、
///   session/instance→source（文件内 ∪ 目标库既有）；
/// - v1 兼容：旧文件导出过 agent_runs 但没有 agent_sessions，为孤儿 run
///   合成占位会话，而不是抛外键错误。
fn parse_and_validate_src(
    db: &Db,
    data: &serde_json::Value,
    src: SectionSource<'_>,
) -> AppResult<ParsedImport> {
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
        tasks: table_rows(src, "tasks")?,
        rules: table_rows(src, "recurrence_rules")?,
        reminders: table_rows(src, "task_reminders")?,
        links: table_rows(src, "task_agent_links")?,
        categories: table_rows(src, "task_categories")?,
        sources: table_rows(src, "agent_sources")?,
        instances: table_rows(src, "agent_instances")?,
        sessions: table_rows(src, "agent_sessions")?,
        runs: table_rows(src, "agent_runs")?,
        events: events_of(src)?,
        notifications: table_rows(src, "notification_history")?,
        // v1/v2 文件没有这三张表 → 返回空表（向后兼容，不视为损坏）
        nav_targets: table_rows(src, "navigation_targets")?,
        task_nav_targets: table_rows(src, "task_navigation_targets")?,
        nav_logs: table_rows(src, "navigation_log")?,
        settings: data
            .get("settings")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default(),
        extended: parse_extended(db, data, src)?,
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
                    origin: "real".into(),
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
            if crate::commands::backup::EXCLUDED_SETTINGS.contains(&k.as_str()) {
                continue; // 本机安全项与恢复内部标记不导入
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

fn json_to_sql_value(value: &serde_json::Value) -> AppResult<rusqlite::types::Value> {
    use rusqlite::types::Value;
    Ok(match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(u) = n.as_u64() {
                if u > i64::MAX as u64 {
                    return Err(AppError::Validation("数值超出 SQLite INTEGER 范围".into()));
                }
                Value::Integer(u as i64)
            } else {
                Value::Real(
                    n.as_f64()
                        .ok_or_else(|| AppError::Validation("数值无法转换为 SQLite REAL".into()))?,
                )
            }
        }
        serde_json::Value::String(s) => Value::Text(s.clone()),
        serde_json::Value::Object(obj) => {
            use base64::Engine as _;
            let b64 = obj
                .get("$blob_b64")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::Validation("不支持的对象值".into()))?;
            Value::Blob(
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|_| AppError::Validation("Base64 数据非法".into()))?,
            )
        }
        serde_json::Value::Array(_) => return Err(AppError::Validation("不支持的数组值".into())),
    })
}

/// 事件唯一性冲突映射：把 SQLite 的约束错误还原成用户可读的重复提示。
///
/// 事件 id 与 dedupe_key 的唯一性由表结构自己保证（`agent_events.id` 主键 +
/// `idx_events_dedupe` 唯一索引），插入时命中约束即等价于「文件内重复」：
/// 导入前刚清空过 agent_events，库内不会有同 id 的历史行。
fn map_event_constraint_error(
    conn: &rusqlite::Connection,
    err: rusqlite::Error,
    id: &str,
) -> AppError {
    let is_unique = match &err {
        rusqlite::Error::SqliteFailure(e, _) => e.code == rusqlite::ErrorCode::ConstraintViolation,
        _ => false,
    };
    if !is_unique {
        return err.into();
    }
    let dup_id = conn
        .query_row(
            "SELECT 1 FROM agent_events WHERE id = ?1",
            rusqlite::params![id],
            |_| Ok(()),
        )
        .is_ok();
    if dup_id {
        AppError::Validation("agent_events 存在重复 id".into())
    } else {
        AppError::Validation("agent_events 存在重复 dedupe_key".into())
    }
}

fn insert_extended_rows(
    conn: &rusqlite::Connection,
    table: &str,
    rows: &[serde_json::Map<String, serde_json::Value>],
) -> AppResult<()> {
    for row in rows {
        let mut cols = Vec::with_capacity(row.len());
        let mut values = Vec::with_capacity(row.len());
        for (key, value) in row {
            cols.push(key.as_str());
            values.push(json_to_sql_value(value)?);
        }
        if cols.is_empty() {
            return Err(AppError::Validation(format!("{} 存在空行", table)));
        }
        let placeholders = (1..=cols.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            cols.join(","),
            placeholders
        );
        // 复用预编译语句：逐行重新编译 SQL 是十万级行导入的主要开销。
        conn.prepare_cached(&sql)?
            .execute(rusqlite::params_from_iter(values))?;
    }
    Ok(())
}

/// 导入前预检（不写库）：供恢复状态机在生成恢复点之前验证数据。
/// 返回解析结果，恢复流程可直接复用，避免对同一份大备份解析两次。
pub(crate) fn validate_import(db: &Db, data: &serde_json::Value) -> AppResult<ParsedImport> {
    parse_and_validate(db, data)
}

/// 分块备份的预检：元信息在 `data`，业务表行在 `rows_dir/<table>.jsonl`。
pub(crate) fn validate_bundle(
    db: &Db,
    data: &serde_json::Value,
    rows_dir: &Path,
) -> AppResult<ParsedImport> {
    parse_and_validate_src(db, data, SectionSource::Dir(rows_dir))
}

fn parse_and_validate(db: &Db, data: &serde_json::Value) -> AppResult<ParsedImport> {
    parse_and_validate_src(db, data, SectionSource::Value(data))
}

/// 导入核心：整体替换用户数据（校验 → 单事务）。任一步失败整体回滚，原库保持不变。
pub fn import_value(db: &Db, data: &serde_json::Value) -> AppResult<()> {
    import_value_with(db, data, &ImportOptions::default())
}

pub fn import_value_with(
    db: &Db,
    data: &serde_json::Value,
    options: &ImportOptions,
) -> AppResult<()> {
    let parsed = parse_and_validate(db, data)?;
    import_parsed_with(db, parsed, options)
}

/// 用预校验结果执行单事务导入（恢复状态机在预检后复用，避免二次解析）。
pub(crate) fn import_parsed_with(
    db: &Db,
    parsed: ParsedImport,
    options: &ImportOptions,
) -> AppResult<()> {
    if parsed.extended.active && !options.allow_extended {
        return Err(AppError::Validation(
            "该文件包含剪贴板/工作现场扩展模块与图片资产，必须通过分块备份恢复流程导入".into(),
        ));
    }
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let t_imp = std::time::Instant::now();
        let result = (|| -> AppResult<()> {
            // 旧备份（无扩展模块）恢复时，删除任务会级联删除剪贴板任务关联、
            // 并把工作现场 task_id 置空；先保存映射，待任务写回后恢复。
            // 只恢复「备份里仍然存在」的任务关联：任务已被旧备份删除时，
            // 关联按原语义消失，不能重新指向不存在的任务（外键失败）。
            let restored_task_ids: HashSet<&str> =
                parsed.tasks.iter().map(|t| t.id.as_str()).collect();
            let preserved_clip_links: Vec<(String, String, String, String, String)> = if parsed
                .extended
                .active
            {
                Vec::new()
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, task_id, target_type, target_id, created_at FROM clipboard_task_links",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                    ))
                })?;
                let all = rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)?;
                all.into_iter()
                    .filter(|(_, task_id, _, _, _): &(String, String, String, String, String)| {
                        restored_task_ids.contains(task_id.as_str())
                    })
                    .collect()
            };
            let preserved_ws_links: Vec<(String, String)> = if parsed.extended.active {
                Vec::new()
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, task_id FROM workspace_snapshots WHERE task_id IS NOT NULL",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                let all = rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)?;
                all.into_iter()
                    .filter(|(_, task_id): &(String, String)| {
                        restored_task_ids.contains(task_id.as_str())
                    })
                    .collect()
            };

            // 扩展模块先按依赖逆序清除（任务级联之前），再走旧表清除顺序。
            if parsed.extended.active {
                for table in crate::commands::backup::EXTENDED_TABLES.iter().rev() {
                    conn.execute(&format!("DELETE FROM {}", table), [])?;
                }
            }
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
                        adapter, icon, hidden, last_event_at, category, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                     ON CONFLICT(id) DO UPDATE SET
                       display_name = excluded.display_name, kind = excluded.kind,
                       enabled = excluded.enabled, verified = excluded.verified,
                       transport_verified = excluded.transport_verified, homepage = excluded.homepage,
                       note = excluded.note, config = excluded.config, adapter = excluded.adapter,
                       icon = excluded.icon, hidden = excluded.hidden,
                       last_event_at = excluded.last_event_at, category = excluded.category,
                       updated_at = excluded.updated_at,
                       created_at = excluded.created_at",
                    rusqlite::params![
                        s.id, s.display_name, s.kind, s.enabled as i64, s.verified as i64,
                        s.transport_verified as i64, s.homepage, s.note, s.config,
                        s.adapter, s.icon, s.hidden as i64, s.last_event_at, s.category,
                        s.created_at, s.updated_at,
                    ],
                )?;
            }
            for i in &parsed.instances {
                conn.execute(
                    "INSERT INTO agent_instances (id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, meta, origin)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![i.id, i.source_id, i.instance_key, i.display_name, i.exe_path, i.first_seen_at, i.last_seen_at, i.meta, i.origin],
                )?;
            }
            for s in &parsed.sessions {
                conn.execute(
                    "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id, origin)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![s.id, s.source_id, s.external_id, s.title, s.status, s.first_seen_at, s.last_seen_at, s.last_run_id, s.instance_id, s.origin],
                )?;
            }
            for r in &parsed.runs {
                conn.execute(
                    "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id, last_ingest_seq, last_event_at, origin)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                    rusqlite::params![r.id, r.session_id, r.source_id, r.external_run_id, r.task_title, r.status, r.started_at, r.updated_at, r.ended_at, r.pending_items, r.meta, r.instance_id, r.parent_run_id, r.last_ingest_seq, r.last_event_at, r.origin],
                )?;
            }
            {
                let mut stmt = conn.prepare(
                    "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key, ingest_seq, origin)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
                )?;
                parsed.events.for_each_ref(|_, e| {
                    stmt.execute(rusqlite::params![e.id, e.source_id, e.session_external_id, e.run_external_id, e.event_type, e.state, e.message, e.received_at, e.schema_version as i64, e.event_id, e.instance_id, e.parent_run_id, e.occurred_at, e.transport, e.evidence_type, e.confidence, e.dedupe_key, e.ingest_seq, e.origin])
                        .map_err(|err| map_event_constraint_error(conn, err, &e.id))?;
                    Ok(())
                })?;
            }
            tracing::info!(
                phase = "insert_events",
                ms = t_imp.elapsed().as_millis(),
                "导入阶段完成"
            );
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
            {
                let mut stmt = conn.prepare(
                    "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                )?;
                for n in &parsed.notifications {
                    stmt.execute(rusqlite::params![n.id, n.kind, n.title, n.body, n.ref_type, n.ref_id, n.occurrence, n.is_read as i64, n.created_at, n.agent_origin])?;
                }
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
                if crate::commands::backup::LOCAL_PRIVACY_SETTINGS.contains(&k.as_str()) {
                    // 剪贴板记录开关是本机隐私偏好，不随数据导入/恢复变更。
                    // 备份里存的是「备份那一刻」的值：用户后来关闭或暂停了记录，
                    // 恢复一份旧备份若把它写回去，等于在用户不知情时重新打开
                    // 剪贴板采集。缺省即开启的语义在这里尤其危险，必须保留本机当前值。
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
            // v6：扩展模块（依赖顺序由 backup::EXTENDED_TABLES 保证）
            if parsed.extended.active {
                for table in crate::commands::backup::EXTENDED_TABLES {
                    if let Some(rows) = parsed.extended.tables.get(table) {
                        insert_extended_rows(conn, table, rows)?;
                    }
                }
            } else {
                for (id, task_id, target_type, target_id, created_at) in &preserved_clip_links {
                    conn.execute(
                        "INSERT OR IGNORE INTO clipboard_task_links
                           (id, task_id, target_type, target_id, created_at)
                         VALUES (?1,?2,?3,?4,?5)",
                        rusqlite::params![id, task_id, target_type, target_id, created_at],
                    )?;
                }
                for (snapshot_id, task_id) in &preserved_ws_links {
                    conn.execute(
                        "UPDATE workspace_snapshots SET task_id = ?1 WHERE id = ?2 AND task_id IS NULL",
                        rusqlite::params![task_id, snapshot_id],
                    )?;
                }
            }
            if let Some(marker) = &options.commit_marker {
                conn.execute(
                    "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    rusqlite::params![
                        crate::commands::backup::RESTORE_COMMIT_KEY,
                        serde_json::to_string(marker)?,
                        now
                    ],
                )?;
            }
            // v12：旧备份没有 origin/category 列时全部按 real 读入，
            // 这里用与迁移相同的保守规则补齐（只标记可证明的测试数据）。
            crate::db::backfill_origin_labels(conn)?;
            tracing::info!(
                phase = "other_inserts_backfill",
                ms = t_imp.elapsed().as_millis(),
                "导入阶段完成"
            );
            // 最后一道闸门：SQLite 自己再查一遍外键（不信任上面的手写校验，
            // 也覆盖「手写校验没预料到的新引用」）。有任何残留 → 整体回滚。
            let violations: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check",
                [],
                |r| r.get(0),
            )?;
            tracing::info!(
                phase = "fk_check",
                ms = t_imp.elapsed().as_millis(),
                "导入阶段完成"
            );
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
                let t_commit = std::time::Instant::now();
                conn.execute_batch("COMMIT")?;
                tracing::info!(
                    phase = "commit",
                    ms = t_commit.elapsed().as_millis(),
                    "导入阶段完成"
                );
                Ok::<_, AppError>(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })?;
    // 恢复后立即抬高受理序号：备份里的水位可能高于本进程已分配值，
    // 否则恢复后收到的首个新事件会被错误判定为迟到（只能入流水、不改状态）。
    crate::agents::bump_ingest_seq(db.max_ingest_seq()?);
    Ok(())
}

fn import_data_inner(
    app: &tauri::AppHandle,
    db: &Db,
    path: &str,
    allow_partial: bool,
) -> AppResult<crate::commands::restore::RestoreOutcome> {
    let data_dir = app_data(app)?;
    let source = Path::new(path);
    if crate::commands::backup::is_bundle(source)? {
        let outcome = crate::commands::restore::restore_bundle(
            &data_dir,
            db,
            source,
            &crate::commands::restore::RestoreOptions {
                allow_partial,
                ..Default::default()
            },
        )?;
        tracing::info!(
            "分块备份恢复完成: session={} kind={} partial={} assets={} archives={}",
            outcome.session_id,
            outcome.backup_kind,
            outcome.partial,
            outcome.assets,
            outcome.archives
        );
        return Ok(outcome);
    }
    let raw = std::fs::read_to_string(source)?;
    let data: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("导出文件不是合法 JSON: {}", e)))?;
    let outcome = crate::commands::restore::restore_legacy_json(&data_dir, db, source, &data)?;
    tracing::info!("数据导入完成: {}（{}）", path, outcome.message);
    Ok(outcome)
}

/// 分块备份恢复：校验 → 完整恢复点 → 单事务替换 → 资产/归档提交；
/// 任一步失败自动回滚到恢复前状态（见 `restore` 模块的状态机）。
#[cfg(test)]
fn import_bundle_from(data_dir: &Path, db: &Db, source: &Path) -> AppResult<()> {
    crate::commands::restore::restore_bundle(
        data_dir,
        db,
        source,
        &crate::commands::restore::RestoreOptions::default(),
    )?;
    Ok(())
}

/// 从 JSON 文件导入（整体替换，导入前生成完整恢复点）。
/// 校验/备份/单事务导入全部在阻塞线程池执行，避免大文件卡住 UI 主线程。
/// `allow_partial`：分块备份若为快速（部分）备份，必须由用户显式确认后才允许恢复。
#[tauri::command]
pub async fn import_data(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    path: String,
    allow_partial: Option<bool>,
) -> AppResult<serde_json::Value> {
    let db = db.inner().clone();
    let allow_partial = allow_partial.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = import_data_inner(&app, &db, &path, allow_partial)?;
        serde_json::to_value(outcome).map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Agent(format!("导入任务中断: {}", e)))?
}

/// 导入前检查备份元信息：是否部分备份、截断了哪些表、是否包含扩展模块/资产。
/// 只读取头记录，不解析正文；旧版 JSON 仅检查应用标识与数据版本。
#[tauri::command]
pub fn inspect_backup(path: String) -> AppResult<serde_json::Value> {
    let source = Path::new(&path);
    if crate::commands::backup::is_bundle(source)? {
        return crate::commands::backup::bundle_meta(source).ok_or_else(|| {
            AppError::Validation("无法读取备份头信息（文件为空、已损坏或不是分块备份）".into())
        });
    }
    let raw = std::fs::read_to_string(source)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("导出文件不是合法 JSON: {}", e)))?;
    if value.get("app").and_then(|v| v.as_str()) != Some("task-dock") {
        return Err(AppError::Validation("不是 Task Dock 的导出文件".into()));
    }
    let count = |table: &str| {
        value
            .get(table)
            .and_then(|v| v.as_array())
            .map(|a| a.len() as i64)
            .unwrap_or(0)
    };
    Ok(serde_json::json!({
        "format": "legacy-json",
        "kind": "legacy",
        "partial": false,
        "export_version": value.get("version").cloned().unwrap_or(serde_json::Value::Null),
        "extended_modules": false,
        "preserved_modules": ["clipboard", "workspace", "actions"],
        "counts": {
            "tasks": count("tasks"),
            "agent_events": count("agent_events"),
            "notification_history": count("notification_history"),
            "navigation_targets": count("navigation_targets"),
        },
    }))
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
        assert_eq!(exported["version"], 5);
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

    /// v12：Agent 数据的可信来源分类必须随备份/恢复原样保留；
    /// 旧备份缺少该字段时，导入后按与迁移相同的保守规则回填。
    #[test]
    fn agent_origin_survives_backup_restore_and_old_backup_is_backfilled() {
        let db1 = memdb();
        let now = now_iso();
        db1.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at, origin)
                 VALUES ('bench-sess','bench','http-perf-t-session','','idle',?1,?1,'benchmark')",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, status, started_at, updated_at, origin)
                 VALUES ('bench-run','bench-sess','bench','http-perf-t-run','completed',?1,?1,'benchmark')",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, state, received_at, origin)
                 VALUES ('bench-ev','bench','http-perf-t-session','http-perf-t-run','completed',?1,'benchmark')",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO notification_history (id, kind, title, ref_type, ref_id, occurrence, created_at, agent_origin)
                 VALUES ('bench-n','agent_done','完成','agent_run','bench-run','bench-run:completed',?1,'benchmark')",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let backup = collect(&db1).unwrap();
        let db2 = memdb();
        import_value(&db2, &backup).unwrap();
        let origins = |db: &Db| -> (String, String, String, String) {
            db.with_conn(|c| {
                Ok((
                    c.query_row(
                        "SELECT origin FROM agent_sessions WHERE id='bench-sess'",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT origin FROM agent_runs WHERE id='bench-run'",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT origin FROM agent_events WHERE id='bench-ev'",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT agent_origin FROM notification_history WHERE id='bench-n'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap()
        };
        assert_eq!(
            origins(&db2),
            (
                "benchmark".into(),
                "benchmark".into(),
                "benchmark".into(),
                "benchmark".into()
            )
        );

        // 模拟旧备份：去掉 v12 字段后导入，回填规则应恢复可证明的分类
        let mut old = backup.clone();
        for key in [
            "agent_instances",
            "agent_sessions",
            "agent_runs",
            "agent_events",
        ] {
            for row in old[key].as_array_mut().unwrap() {
                row.as_object_mut().unwrap().remove("origin");
            }
        }
        for row in old["notification_history"].as_array_mut().unwrap() {
            row.as_object_mut().unwrap().remove("agent_origin");
        }
        for row in old["agent_sources"].as_array_mut().unwrap() {
            row.as_object_mut().unwrap().remove("category");
        }
        let db3 = memdb();
        import_value(&db3, &old).unwrap();
        assert_eq!(
            origins(&db3),
            (
                "benchmark".into(),
                "benchmark".into(),
                "benchmark".into(),
                "benchmark".into()
            ),
            "旧备份导入后必须按保守规则回填可证明的测试来源"
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

    /// 分块备份恢复：数据完整、归档提交到正式目录、恢复前自动生成完整恢复点、
    /// 恢复会话目录清理。恢复中断/回滚由 restore.rs 的状态机用例覆盖。
    #[test]
    fn bundle_restore_commits_archives_and_auto_backs_up() {
        let src = memdb();
        seed_full(&src);
        let data_dir = std::env::temp_dir().join(format!("td-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let archive = data_dir.join("src-archive");
        std::fs::create_dir_all(&archive).unwrap();
        std::fs::write(archive.join("agent-events-seed.jsonl"), "{\"id\":1}\n").unwrap();
        let bundle = data_dir.join("full.json");
        crate::commands::backup::write_bundle(
            &src,
            crate::commands::backup::BackupSources {
                archive_dir: Some(&archive),
                clipboard_dir: Some(&data_dir.join("clipboard")),
            },
            &bundle,
            BackupKind::Full,
        )
        .unwrap();

        let dst = memdb();
        seed_light(&dst);
        import_bundle_from(&data_dir, &dst, &bundle).unwrap();

        let tasks: i64 = dst
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tasks WHERE id = 'task-1'", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(tasks, 1, "恢复后的任务必须与备份一致");
        let restored = std::fs::read_to_string(
            crate::agents::retention::archive_dir(&data_dir).join("agent-events-seed.jsonl"),
        )
        .unwrap();
        assert_eq!(restored, "{\"id\":1}\n", "归档必须原样提交");
        let backups: Vec<_> = std::fs::read_dir(data_dir.join("backups"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .collect();
        assert_eq!(backups.len(), 1, "恢复前必须生成完整恢复点");
        let meta = crate::commands::backup::bundle_meta(&backups[0].path()).unwrap();
        assert_eq!(meta["partial"], false, "恢复前恢复点必须是完整备份");
        assert!(
            backups[0]
                .file_name()
                .to_string_lossy()
                .starts_with("restore-pre-"),
            "恢复点文件名必须可识别"
        );
        assert!(
            !data_dir.join("restore").exists(),
            "恢复后恢复日志与会话暂存目录必须清理"
        );
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
