//! 流式分块备份（JSONL bundle）与完整性校验。
//!
//! 格式（每行一个 JSON，最后一行是完整性校验行）：
//! - header：格式版本、备份类型（quick/full）、是否部分、导出时间、各表行数；
//! - section：`rows` 分块（默认 500 行/块），事件/通知可达到十万级而不占满内存；
//! - archive：事件归档 JSONL 按 1 MiB 文本块写入，导入时先落暂存目录并校验 SHA-256；
//! - integrity：对所有前序行（含换行）的 SHA-256，缺行/截断/篡改一律拒绝。
//!
//! 可靠性：
//! - 先写临时文件，完成后原子替换；目标已存在时先轮换为 `.previous`，
//!   替换失败会恢复旧文件，失败绝不覆盖有效备份；
//! - 快速备份始终标记 partial=true（不含完整事件/通知/归档），完整备份缺任何数据即报错；
//! - 导入先校验完整性、结构与引用，再自动备份当前数据、单事务替换，归档暂存后提交。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use chrono::SecondsFormat;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::commands::data::{self, EventRow, RunRow, TaskRow};
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const BUNDLE_FORMAT: &str = "taskdock-bundle";
pub const BUNDLE_VERSION: i64 = 1;
pub const MANIFEST_VERSION: i64 = 2;
const CHUNK_ROWS: usize = 500;
const ARCHIVE_CHUNK_BYTES: usize = 1024 * 1024;
const ASSET_CHUNK_BYTES: usize = 512 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

pub const QUICK_EVENT_LIMIT: i64 = 20_000;
pub const QUICK_NOTIFICATION_LIMIT: i64 = 500;
pub const QUICK_NAV_LOG_LIMIT: i64 = 500;
pub const QUICK_CLIPBOARD_ITEM_LIMIT: i64 = 2_000;
pub const QUICK_CLIPBOARD_PASTE_LIMIT: i64 = 500;

/// 恢复提交标记：与业务数据同事务写入，用于崩溃恢复判定。
pub const RESTORE_COMMIT_KEY: &str = "restore_commit_id";
/// 本机安全项与恢复内部标记：绝不进入任何导出文件。
pub const EXCLUDED_SETTINGS: &[&str] = &["http_token", RESTORE_COMMIT_KEY];
/// 设备相关设置：允许导出，但恢复后仍需按本机窗口/自启动状态重新校验。
pub const DEVICE_SPECIFIC_SETTINGS: &[&str] = &[
    "window_rect",
    "snap_state",
    "nav_window_memory",
    "autostart",
];

/// 全量用户业务表（迁移新增用户数据表必须在此声明，schema 覆盖测试会强制失败）。
pub const EXTENDED_TABLES: &[&str] = &[
    "clipboard_items",
    "clipboard_assets",
    "clipboard_groups",
    "clipboard_group_items",
    "clipboard_task_links",
    "clipboard_paste_jobs",
    "workspace_snapshots",
    "workspace_snapshot_items",
    "action_acks",
    "clipboard_snapshot_links",
];

/// 备份分类：决定快速备份策略与恢复顺序。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BackupTableRule {
    pub table: &'static str,
    pub class: &'static str,
    /// all = 全量；recent = 按上限截断；protected = 最近 + 受保护行
    pub quick_policy: &'static str,
    /// 恢复写入顺序（小的先写，满足外键依赖）
    pub restore_order: u32,
    pub depends_on: &'static [&'static str],
    /// true = 使用通用行格式（扩展模块）
    pub extended: bool,
}

macro_rules! rule {
    ($table:expr, $class:expr, $quick:expr, $order:expr, $dep:expr, $ext:expr) => {
        BackupTableRule {
            table: $table,
            class: $class,
            quick_policy: $quick,
            restore_order: $order,
            depends_on: $dep,
            extended: $ext,
        }
    };
}

pub const BACKUP_TABLES: &[BackupTableRule] = &[
    rule!("task_categories", "core", "all", 10, &[], false),
    rule!("recurrence_rules", "core", "all", 20, &[], false),
    rule!("tasks", "core", "all", 30, &["recurrence_rules"], false),
    rule!("task_reminders", "core", "all", 40, &["tasks"], false),
    rule!("agent_sources", "agent", "all", 50, &[], false),
    rule!(
        "agent_instances",
        "agent",
        "all",
        60,
        &["agent_sources"],
        false
    ),
    rule!(
        "agent_sessions",
        "agent",
        "all",
        70,
        &["agent_sources", "agent_instances"],
        false
    ),
    rule!(
        "agent_runs",
        "agent",
        "all",
        80,
        &["agent_sessions", "agent_sources"],
        false
    ),
    rule!("agent_events", "agent", "protected", 90, &[], false),
    rule!("task_agent_links", "core", "all", 100, &["tasks"], false),
    rule!("notification_history", "agent", "recent", 110, &[], false),
    rule!("navigation_targets", "navigation", "all", 120, &[], false),
    rule!(
        "task_navigation_targets",
        "navigation",
        "all",
        130,
        &["tasks", "navigation_targets"],
        false
    ),
    rule!("navigation_log", "navigation", "recent", 140, &[], false),
    rule!("clipboard_items", "clipboard", "recent", 150, &[], true),
    rule!(
        "clipboard_assets",
        "clipboard",
        "recent",
        160,
        &["clipboard_items"],
        true
    ),
    rule!("clipboard_groups", "clipboard", "all", 170, &[], true),
    rule!(
        "clipboard_group_items",
        "clipboard",
        "recent",
        180,
        &["clipboard_groups", "clipboard_items"],
        true
    ),
    rule!(
        "clipboard_task_links",
        "clipboard",
        "recent",
        190,
        &["tasks", "clipboard_items", "clipboard_groups"],
        true
    ),
    rule!(
        "clipboard_paste_jobs",
        "clipboard",
        "recent",
        200,
        &["clipboard_groups"],
        true
    ),
    rule!(
        "workspace_snapshots",
        "workspace",
        "all",
        210,
        &["tasks"],
        true
    ),
    rule!(
        "workspace_snapshot_items",
        "workspace",
        "all",
        220,
        &["workspace_snapshots"],
        true
    ),
    rule!(
        "clipboard_snapshot_links",
        "workspace",
        "recent",
        230,
        &["workspace_snapshots", "clipboard_items", "clipboard_groups"],
        true
    ),
    rule!("action_acks", "action", "all", 240, &[], true),
    rule!("application_settings", "settings", "all", 250, &[], false),
];

pub fn table_rule(table: &str) -> Option<&'static BackupTableRule> {
    BACKUP_TABLES.iter().find(|r| r.table == table)
}

pub fn is_extended_table(table: &str) -> bool {
    EXTENDED_TABLES.contains(&table)
}

/// 备份来源目录：归档与剪贴板资产。
#[derive(Debug, Clone, Copy, Default)]
pub struct BackupSources<'a> {
    pub archive_dir: Option<&'a Path>,
    pub clipboard_dir: Option<&'a Path>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupKind {
    Quick,
    Full,
}

impl BackupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quick => "quick",
            Self::Full => "full",
        }
    }

    pub fn from_full_flag(full: Option<bool>) -> Self {
        if full.unwrap_or(false) {
            Self::Full
        } else {
            Self::Quick
        }
    }

    pub fn is_full(self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Debug, Clone)]
pub struct BackupWriteResult {
    pub path: PathBuf,
    pub kind: &'static str,
    pub partial: bool,
    pub bytes: u64,
    pub sha256: String,
    pub counts: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct StagedArchive {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct StagedAsset {
    /// 相对剪贴板根目录的路径（images/... 或 thumbs/...）
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub struct ReadBackup {
    /// 仅元信息与设置（不含业务表行）：行数据按表落到 `rows_dir`，避免整包 JSON 树常驻。
    pub data: serde_json::Value,
    /// 每张表一个 JSONL 文件（`<table>.jsonl`）；空表也保留文件以表达「显式存在」。
    pub rows_dir: PathBuf,
    pub kind: String,
    pub partial: bool,
    pub counts: serde_json::Value,
    pub archives: Vec<StagedArchive>,
    pub assets: Vec<StagedAsset>,
    /// 新格式 bundle 明确携带扩展模块（剪贴板/工作现场/行动中心）。
    pub extended: bool,
    pub manifest_version: i64,
}

fn sha_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 原子替换：目标存在先轮换，替换失败恢复旧文件；旧文件永不先删。
pub(crate) fn commit_file(tmp: &Path, target: &Path) -> AppResult<()> {
    if !target.exists() {
        std::fs::rename(tmp, target)?;
        return Ok(());
    }
    let backup = target.with_extension(format!(
        "previous-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    std::fs::rename(target, &backup)?;
    if let Err(e) = std::fs::rename(tmp, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(e.into());
    }
    let _ = std::fs::remove_file(&backup);
    Ok(())
}

struct BundleWriter {
    path: PathBuf,
    file: BufWriter<File>,
    hasher: Sha256,
    bytes: u64,
}

impl BundleWriter {
    fn create(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = File::create(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            file: BufWriter::new(file),
            hasher: Sha256::new(),
            bytes: 0,
        })
    }

    fn line<T: Serialize>(&mut self, value: &T) -> AppResult<()> {
        let mut buf = serde_json::to_vec(value)?;
        buf.push(b'\n');
        if buf.len() > MAX_LINE_BYTES {
            return Err(AppError::Validation(format!(
                "备份记录行超过 {} 字节上限",
                MAX_LINE_BYTES
            )));
        }
        self.hasher.update(&buf);
        self.file.write_all(&buf)?;
        self.bytes += buf.len() as u64;
        Ok(())
    }

    fn finish(mut self, footer: &serde_json::Value, sha256: &str) -> AppResult<(u64, String)> {
        let mut value = footer.clone();
        if let Some(obj) = value.as_object_mut() {
            obj.insert("sha256".into(), serde_json::Value::String(sha256.into()));
            obj.insert(
                "algorithm".into(),
                serde_json::Value::String("sha256".into()),
            );
        }
        let mut buf = serde_json::to_vec(&value)?;
        buf.push(b'\n');
        self.file.write_all(&buf)?;
        self.file.flush()?;
        self.file.get_ref().sync_all()?;
        Ok((self.bytes, sha256.to_string()))
    }

    fn abort(self) {
        drop(self.file);
        let _ = std::fs::remove_file(&self.path);
    }
}

fn count(conn: &Connection, table: &str) -> AppResult<i64> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
        .map_err(AppError::from)
}

fn table_counts(conn: &Connection) -> AppResult<BTreeMap<String, i64>> {
    let mut out = BTreeMap::new();
    for rule in BACKUP_TABLES {
        out.insert(rule.table.to_string(), count(conn, rule.table)?);
    }
    Ok(out)
}

/// SQLite 值 → JSON。BLOB 使用带标记的 Base64 对象，读取时无损还原。
fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Value::from(f),
        ValueRef::Text(t) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::json!({
            "$blob_b64": base64::engine::general_purpose::STANDARD.encode(b)
        }),
    }
}

fn quick_item_sql() -> String {
    format!(
        "SELECT id FROM clipboard_items WHERE favorite = 1 OR pinned = 1 OR id IN (SELECT id FROM clipboard_items ORDER BY last_seen_at DESC, id DESC LIMIT {})",
        QUICK_CLIPBOARD_ITEM_LIMIT
    )
}

fn generic_sql(table: &str, kind: BackupKind) -> AppResult<String> {
    if kind.is_full() {
        return Ok(format!("SELECT * FROM {} ORDER BY rowid", table));
    }
    let items = quick_item_sql();
    let sql = match table {
        "clipboard_items" => format!(
            "SELECT * FROM clipboard_items WHERE favorite = 1 OR pinned = 1 OR id IN (SELECT id FROM clipboard_items ORDER BY last_seen_at DESC, id DESC LIMIT {}) ORDER BY rowid",
            QUICK_CLIPBOARD_ITEM_LIMIT
        ),
        "clipboard_assets" => format!(
            "SELECT * FROM clipboard_assets WHERE item_id IN ({}) ORDER BY rowid",
            items
        ),
        "clipboard_groups" => "SELECT * FROM clipboard_groups ORDER BY rowid".to_string(),
        "clipboard_group_items" => format!(
            "SELECT * FROM clipboard_group_items WHERE item_id IN ({}) ORDER BY rowid",
            items
        ),
        "clipboard_task_links" => format!(
            "SELECT * FROM clipboard_task_links WHERE (target_type = 'group' AND target_id IN (SELECT id FROM clipboard_groups)) OR (target_type = 'item' AND target_id IN ({})) ORDER BY rowid",
            items
        ),
        "clipboard_paste_jobs" => format!(
            "SELECT * FROM clipboard_paste_jobs WHERE id IN (SELECT id FROM clipboard_paste_jobs ORDER BY started_at DESC, id DESC LIMIT {}) ORDER BY rowid",
            QUICK_CLIPBOARD_PASTE_LIMIT
        ),
        "workspace_snapshots"
        | "workspace_snapshot_items"
        | "action_acks" => format!("SELECT * FROM {} ORDER BY rowid", table),
        "clipboard_snapshot_links" => format!(
            "SELECT * FROM clipboard_snapshot_links WHERE (target_type = 'group' AND target_id IN (SELECT id FROM clipboard_groups)) OR (target_type = 'item' AND target_id IN ({})) ORDER BY rowid",
            items
        ),
        other => {
            return Err(AppError::Validation(format!(
                "扩展表缺少备份策略: {}",
                other
            )))
        }
    };
    Ok(sql)
}

/// 流式写通用表；返回导出行数。
fn write_generic_table(
    writer: &mut BundleWriter,
    conn: &Connection,
    table: &str,
    kind: BackupKind,
) -> AppResult<usize> {
    let sql = generic_sql(table, kind)?;
    let mut stmt = conn.prepare(&sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([])?;
    let mut buf: Vec<serde_json::Value> = Vec::with_capacity(CHUNK_ROWS);
    let mut total = 0usize;
    while let Some(row) = rows.next()? {
        let mut map = serde_json::Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            map.insert(name.clone(), value_to_json(row.get_ref(i)?));
        }
        buf.push(serde_json::Value::Object(map));
        if buf.len() >= CHUNK_ROWS {
            writer.line(&Section {
                record: "section",
                table,
                rows: &buf,
            })?;
            total += buf.len();
            buf.clear();
        }
    }
    if !buf.is_empty() {
        writer.line(&Section {
            record: "section",
            table,
            rows: &buf,
        })?;
        total += buf.len();
    } else if total == 0 {
        // 扩展表即使为空也显式写 section：新格式必须能区分「空表」与「缺表」。
        writer.line(&Section {
            record: "section",
            table,
            rows: &[] as &[serde_json::Value],
        })?;
    }
    Ok(total)
}

fn write_rows<T, I>(
    writer: &mut BundleWriter,
    table: &str,
    rows: I,
    chunk: usize,
) -> AppResult<usize>
where
    T: Serialize,
    I: Iterator<Item = AppResult<T>>,
{
    let mut buf: Vec<T> = Vec::with_capacity(chunk);
    let mut total = 0usize;
    for row in rows {
        buf.push(row?);
        if buf.len() >= chunk {
            writer.line(&Section {
                record: "section",
                table,
                rows: &buf,
            })?;
            total += buf.len();
            buf.clear();
        }
    }
    if !buf.is_empty() {
        writer.line(&Section {
            record: "section",
            table,
            rows: &buf,
        })?;
        total += buf.len();
    }
    Ok(total)
}

#[derive(Serialize)]
struct Section<'a, T> {
    record: &'static str,
    table: &'a str,
    rows: &'a [T],
}

fn write_small_sections(writer: &mut BundleWriter, tx: &Connection) -> AppResult<()> {
    {
        let mut stmt = tx.prepare("SELECT id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at FROM tasks ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(TaskRow {
                id: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                priority: r.get(3)?,
                status: r.get(4)?,
                category: r.get(5)?,
                tags: r.get(6)?,
                due_at: r.get(7)?,
                remind_at: r.get(8)?,
                advance_minutes: r.get(9)?,
                recurrence_rule_id: r.get(10)?,
                created_at: r.get(11)?,
                updated_at: r.get(12)?,
                completed_at: r.get(13)?,
            })
        })?;
        write_rows(
            writer,
            "tasks",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, freq, interval, by_weekday, by_monthday, until, anchor, created_at FROM recurrence_rules ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::RuleRow {
                id: r.get(0)?,
                freq: r.get(1)?,
                interval: r.get(2)?,
                by_weekday: r.get(3)?,
                by_monthday: r.get(4)?,
                until: r.get(5)?,
                anchor: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?;
        write_rows(
            writer,
            "recurrence_rules",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, task_id, remind_at, occurrence, kind, fired, fired_at FROM task_reminders ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::ReminderRow {
                id: r.get(0)?,
                task_id: r.get(1)?,
                remind_at: r.get(2)?,
                occurrence: r.get(3)?,
                kind: r.get(4)?,
                fired: r.get::<_, i64>(5)? != 0,
                fired_at: r.get(6)?,
            })
        })?;
        write_rows(
            writer,
            "task_reminders",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, task_id, source_id, session_external_id, run_external_id, created_at, origin FROM task_agent_links ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::LinkRow {
                id: r.get(0)?,
                task_id: r.get(1)?,
                source_id: r.get(2)?,
                session_external_id: r.get(3)?,
                run_external_id: r.get(4)?,
                created_at: r.get(5)?,
                origin: r.get(6)?,
            })
        })?;
        write_rows(
            writer,
            "task_agent_links",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare(
            "SELECT id, name, color, sort_order, created_at FROM task_categories ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(data::CategoryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                sort_order: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        write_rows(
            writer,
            "task_categories",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, display_name, kind, enabled, verified, transport_verified, homepage, note, config, adapter, icon, hidden, last_event_at, category, created_at, updated_at FROM agent_sources ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::SourceRow {
                id: r.get(0)?,
                display_name: r.get(1)?,
                kind: r.get(2)?,
                enabled: r.get::<_, i64>(3)? != 0,
                verified: r.get::<_, i64>(4)? != 0,
                transport_verified: r.get::<_, i64>(5)? != 0,
                homepage: r.get(6)?,
                note: r.get(7)?,
                config: r.get(8)?,
                adapter: r.get(9)?,
                icon: r.get(10)?,
                hidden: r.get::<_, i64>(11)? != 0,
                last_event_at: r.get(12)?,
                category: r.get(13)?,
                created_at: r.get(14)?,
                updated_at: r.get(15)?,
            })
        })?;
        write_rows(
            writer,
            "agent_sources",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, meta, origin FROM agent_instances ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::InstanceRow {
                id: r.get(0)?,
                source_id: r.get(1)?,
                instance_key: r.get(2)?,
                display_name: r.get(3)?,
                exe_path: r.get(4)?,
                first_seen_at: r.get(5)?,
                last_seen_at: r.get(6)?,
                meta: r.get(7)?,
                origin: r.get(8)?,
            })
        })?;
        write_rows(
            writer,
            "agent_instances",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id, origin FROM agent_sessions ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::SessionRow {
                id: r.get(0)?,
                source_id: r.get(1)?,
                external_id: r.get(2)?,
                title: r.get(3)?,
                status: r.get(4)?,
                first_seen_at: r.get(5)?,
                last_seen_at: r.get(6)?,
                last_run_id: r.get(7)?,
                instance_id: r.get(8)?,
                origin: r.get(9)?,
            })
        })?;
        write_rows(
            writer,
            "agent_sessions",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id, last_ingest_seq, last_event_at, origin FROM agent_runs ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(RunRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                source_id: r.get(2)?,
                external_run_id: r.get(3)?,
                task_title: r.get(4)?,
                status: r.get(5)?,
                started_at: r.get(6)?,
                updated_at: r.get(7)?,
                ended_at: r.get(8)?,
                pending_items: r.get(9)?,
                meta: r.get(10)?,
                instance_id: r.get(11)?,
                parent_run_id: r.get(12)?,
                last_ingest_seq: r.get(13)?,
                last_event_at: r.get(14)?,
                origin: r.get(15)?,
            })
        })?;
        write_rows(
            writer,
            "agent_runs",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, display_name, target_type, app_key, exe_path, launch_args, working_dir, app_user_model_id, url, path, agent_source_id, agent_session_id, window_title_hint, icon, category, favorite, hidden, last_used_at, use_count, created_at, updated_at FROM navigation_targets ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::NavTargetRowData {
                id: r.get(0)?,
                display_name: r.get(1)?,
                target_type: r.get(2)?,
                app_key: r.get(3)?,
                exe_path: r.get(4)?,
                launch_args: r.get(5)?,
                working_dir: r.get(6)?,
                app_user_model_id: r.get(7)?,
                url: r.get(8)?,
                path: r.get(9)?,
                agent_source_id: r.get(10)?,
                agent_session_id: r.get(11)?,
                window_title_hint: r.get(12)?,
                icon: r.get(13)?,
                category: r.get(14)?,
                favorite: r.get::<_, i64>(15)? != 0,
                hidden: r.get::<_, i64>(16)? != 0,
                last_used_at: r.get(17)?,
                use_count: r.get(18)?,
                created_at: r.get(19)?,
                updated_at: r.get(20)?,
            })
        })?;
        write_rows(
            writer,
            "navigation_targets",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    {
        let mut stmt = tx.prepare("SELECT id, task_id, target_id, display_order, is_default, launch_behavior, created_at, window_identity, window_fallback FROM task_navigation_targets ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(data::TaskNavTargetRowData {
                id: r.get(0)?,
                task_id: r.get(1)?,
                target_id: r.get(2)?,
                display_order: r.get(3)?,
                is_default: r.get::<_, i64>(4)? != 0,
                launch_behavior: r.get(5)?,
                created_at: r.get(6)?,
                window_identity: r.get(7)?,
                window_fallback: r.get(8)?,
            })
        })?;
        write_rows(
            writer,
            "task_navigation_targets",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )?;
    }
    Ok(())
}

fn write_settings(writer: &mut BundleWriter, tx: &Connection) -> AppResult<usize> {
    let mut map = serde_json::Map::new();
    let sql = format!(
        "SELECT key, value FROM application_settings WHERE key NOT IN ({}) ORDER BY key",
        EXCLUDED_SETTINGS
            .iter()
            .map(|k| format!("'{}'", k))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut stmt = tx.prepare(&sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        map.insert(
            k,
            serde_json::from_str(&v).unwrap_or(serde_json::Value::Null),
        );
    }
    let keys = map.len();
    writer.line(&serde_json::json!({
        "record": "section",
        "table": "settings",
        "value": map,
    }))?;
    Ok(keys)
}

fn write_events(writer: &mut BundleWriter, tx: &Connection, limit: i64) -> AppResult<usize> {
    // 快速备份：最近 N 条 + 全部受保护的未结束事件（running/waiting），
    // 避免「轮次还在进行，但它的早期事件已被时间窗口截掉」。
    let sql = if limit > 0 {
        "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key, ingest_seq, origin FROM agent_events
         WHERE id IN (
             SELECT id FROM (
                 SELECT id FROM agent_events ORDER BY received_at DESC, id DESC LIMIT ?1
             )
             UNION
             SELECT id FROM agent_events WHERE state IN ('running','waiting')
         )
         ORDER BY received_at ASC, id ASC"
    } else {
        "SELECT id, source_id, session_external_id, run_external_id, event_type, state, message, received_at, schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key, ingest_seq, origin FROM agent_events ORDER BY id"
    };
    let mut stmt = tx.prepare(sql)?;
    let map = |r: &rusqlite::Row<'_>| {
        Ok(EventRow {
            id: r.get(0)?,
            source_id: r.get(1)?,
            session_external_id: r.get(2)?,
            run_external_id: r.get(3)?,
            event_type: r.get(4)?,
            state: r.get(5)?,
            message: r.get(6)?,
            received_at: r.get(7)?,
            schema_version: r.get::<_, i64>(8)? as u32,
            event_id: r.get(9)?,
            instance_id: r.get(10)?,
            parent_run_id: r.get(11)?,
            occurred_at: r.get(12)?,
            transport: r.get(13)?,
            evidence_type: r.get(14)?,
            confidence: r.get(15)?,
            dedupe_key: r.get(16)?,
            ingest_seq: r.get(17)?,
            origin: r.get(18)?,
        })
    };
    if limit > 0 {
        let rows = stmt.query_map(rusqlite::params![limit], map)?;
        write_rows(
            writer,
            "agent_events",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )
    } else {
        let rows = stmt.query_map([], map)?;
        write_rows(
            writer,
            "agent_events",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )
    }
}

fn write_notifications(writer: &mut BundleWriter, tx: &Connection, limit: i64) -> AppResult<usize> {
    let sql = if limit > 0 {
        "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin FROM notification_history ORDER BY created_at DESC, id DESC LIMIT ?1"
    } else {
        "SELECT id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin FROM notification_history ORDER BY id"
    };
    let mut stmt = tx.prepare(sql)?;
    let map = |r: &rusqlite::Row<'_>| {
        Ok(data::NotificationRowData {
            id: r.get(0)?,
            kind: r.get(1)?,
            title: r.get(2)?,
            body: r.get(3)?,
            ref_type: r.get(4)?,
            ref_id: r.get(5)?,
            occurrence: r.get(6)?,
            is_read: r.get::<_, i64>(7)? != 0,
            created_at: r.get(8)?,
            agent_origin: r.get(9)?,
        })
    };
    if limit > 0 {
        let rows = stmt.query_map(rusqlite::params![limit], map)?;
        write_rows(
            writer,
            "notification_history",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )
    } else {
        let rows = stmt.query_map([], map)?;
        write_rows(
            writer,
            "notification_history",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )
    }
}

fn write_nav_logs(writer: &mut BundleWriter, tx: &Connection, limit: i64) -> AppResult<usize> {
    let sql = if limit > 0 {
        "SELECT id, target_id, target_name, requested_action, actual_action, success, fallback_used, reason, verification_level, created_at FROM navigation_log ORDER BY created_at DESC, id DESC LIMIT ?1"
    } else {
        "SELECT id, target_id, target_name, requested_action, actual_action, success, fallback_used, reason, verification_level, created_at FROM navigation_log ORDER BY id"
    };
    let mut stmt = tx.prepare(sql)?;
    let map = |r: &rusqlite::Row<'_>| {
        Ok(data::NavLogRowData {
            id: r.get(0)?,
            target_id: r.get(1)?,
            target_name: r.get(2)?,
            requested_action: r.get(3)?,
            actual_action: r.get(4)?,
            success: r.get::<_, i64>(5)? != 0,
            fallback_used: r.get::<_, i64>(6)? != 0,
            reason: r.get(7)?,
            verification_level: r.get(8)?,
            created_at: r.get(9)?,
        })
    };
    if limit > 0 {
        let rows = stmt.query_map(rusqlite::params![limit], map)?;
        write_rows(
            writer,
            "navigation_log",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )
    } else {
        let rows = stmt.query_map([], map)?;
        write_rows(
            writer,
            "navigation_log",
            rows.map(|r| r.map_err(AppError::from)),
            CHUNK_ROWS,
        )
    }
}

fn hash_file(path: &Path) -> AppResult<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; ARCHIVE_CHUNK_BYTES];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((size, sha_hex(hasher)))
}

#[derive(Serialize)]
struct ArchiveChunk<'a> {
    record: &'static str,
    name: &'a str,
    size: u64,
    sha256: &'a str,
    chunk: u32,
    data: &'a str,
}

fn write_archive(writer: &mut BundleWriter, path: &Path, name: &str) -> AppResult<u64> {
    let (size, sha) = hash_file(path)?;
    let mut file = File::open(path)?;
    let mut chunk = 0u32;
    let mut pending: Vec<u8> = Vec::new();
    let mut emitted_any = false;
    loop {
        let mut buf = vec![0u8; ARCHIVE_CHUNK_BYTES];
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid > 0 {
            let text = std::str::from_utf8(&pending[..valid])
                .map_err(|_| AppError::Validation("归档文件不是合法 UTF-8".into()))?;
            writer.line(&ArchiveChunk {
                record: "archive",
                name,
                size,
                sha256: &sha,
                chunk,
                data: text,
            })?;
            chunk += 1;
            emitted_any = true;
            pending.drain(..valid);
        }
        if pending.len() > MAX_LINE_BYTES {
            return Err(AppError::Validation("归档内容无法按 UTF-8 分块".into()));
        }
    }
    if !pending.is_empty() {
        let text = std::str::from_utf8(&pending)
            .map_err(|_| AppError::Validation("归档文件不是合法 UTF-8".into()))?;
        writer.line(&ArchiveChunk {
            record: "archive",
            name,
            size,
            sha256: &sha,
            chunk,
            data: text,
        })?;
        emitted_any = true;
    }
    if !emitted_any {
        writer.line(&ArchiveChunk {
            record: "archive",
            name,
            size,
            sha256: &sha,
            chunk: 0,
            data: "",
        })?;
    }
    Ok(size)
}

/// 剪贴板资产相对路径校验：仅允许 `images/<name>.png` 与 `thumbs/<name>.png`。
pub(crate) fn safe_asset_rel(rel: &str) -> AppResult<&Path> {
    if rel.is_empty() || rel.contains(['\\', '\0']) {
        return Err(AppError::Validation("资产路径为空或包含非法字符".into()));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(AppError::Validation("资产路径不得为绝对路径".into()));
    }
    let comps: Vec<Component<'_>> = path.components().collect();
    if comps.len() != 2 || !comps.iter().all(|c| matches!(c, Component::Normal(_))) {
        return Err(AppError::Validation(format!("资产路径结构非法: {}", rel)));
    }
    let dir = comps[0].as_os_str().to_string_lossy();
    if dir != "images" && dir != "thumbs" {
        return Err(AppError::Validation(format!("资产路径目录非法: {}", rel)));
    }
    if !rel.ends_with(".png") {
        return Err(AppError::Validation(format!("资产不是 PNG: {}", rel)));
    }
    Ok(path)
}

#[derive(Serialize)]
struct AssetChunk<'a> {
    record: &'static str,
    path: &'a str,
    size: u64,
    sha256: &'a str,
    chunk: u32,
    data: &'a str,
}

/// 把单个资产文件分块（Base64）写入 bundle；返回字节数。
fn write_asset(writer: &mut BundleWriter, root: &Path, rel: &str) -> AppResult<u64> {
    safe_asset_rel(rel)?;
    let abs = root.join(rel);
    let (size, sha) = hash_file(&abs)?;
    let mut file = File::open(&abs)?;
    let mut chunk = 0u32;
    let mut emitted = false;
    loop {
        let mut buf = vec![0u8; ASSET_CHUNK_BYTES];
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        buf.truncate(n);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf);
        writer.line(&AssetChunk {
            record: "asset",
            path: rel,
            size,
            sha256: &sha,
            chunk,
            data: &encoded,
        })?;
        chunk += 1;
        emitted = true;
    }
    if !emitted {
        writer.line(&AssetChunk {
            record: "asset",
            path: rel,
            size,
            sha256: &sha,
            chunk: 0,
            data: "",
        })?;
    }
    Ok(size)
}

fn list_archive_files(dir: &Path) -> AppResult<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.metadata()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".jsonl") {
            out.push((name, entry.path()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// 写备份（quick/full）。返回实际文件大小与 SHA-256。
pub fn write_bundle(
    db: &Db,
    sources: BackupSources<'_>,
    target: &Path,
    kind: BackupKind,
) -> AppResult<BackupWriteResult> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("backup"),
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let mut writer = BundleWriter::create(&tmp)?;
    let result = db.with_read(|conn| {
            let tx = conn.unchecked_transaction()?;
            let totals = table_counts(&tx)?;
            let event_limit = if kind.is_full() { -1 } else { QUICK_EVENT_LIMIT };
            let notif_limit = if kind.is_full() {
                -1
            } else {
                QUICK_NOTIFICATION_LIMIT
            };
            let nav_limit = if kind.is_full() {
                -1
            } else {
                QUICK_NAV_LOG_LIMIT
            };
            let mut partial_reasons: Vec<String> = Vec::new();
            let mut truncated_tables: Vec<&'static str> = Vec::new();
            let partial = kind == BackupKind::Quick;
            if partial {
                partial_reasons.push(
                    "快速备份：事件/通知/导航流水与剪贴板历史按上限截断（running/waiting 事件全量保留），且不包含事件归档".into(),
                );
                for (table, limit) in [
                    ("agent_events", QUICK_EVENT_LIMIT),
                    ("notification_history", QUICK_NOTIFICATION_LIMIT),
                    ("navigation_log", QUICK_NAV_LOG_LIMIT),
                    ("clipboard_items", QUICK_CLIPBOARD_ITEM_LIMIT),
                    ("clipboard_paste_jobs", QUICK_CLIPBOARD_PASTE_LIMIT),
                ] {
                    let total = *totals.get(table).unwrap_or(&0);
                    if total > limit {
                        truncated_tables.push(table);
                        partial_reasons.push(format!(
                            "{} 共 {} 条，仅导出最近 {} 条",
                            table, total, limit
                        ));
                    }
                }
            }
            let exported_at = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            writer.line(&serde_json::json!({
                "record": "header",
                "app": "task-dock",
                "format": BUNDLE_FORMAT,
                "bundle_version": BUNDLE_VERSION,
                "manifest_version": MANIFEST_VERSION,
                "extended_modules": true,
                "export_version": data::EXPORT_VERSION,
                "backup_kind": kind.as_str(),
                "partial": partial,
                "partial_reasons": partial_reasons,
                "exported_at": exported_at,
                "totals": totals,
                "truncated_tables": truncated_tables,
                "registry": BACKUP_TABLES,
                "excluded_settings": EXCLUDED_SETTINGS,
                "device_specific_settings": DEVICE_SPECIFIC_SETTINGS,
            }))?;

            write_small_sections(&mut writer, &tx)?;
            let events = write_events(&mut writer, &tx, event_limit)?;
            let notifications = write_notifications(&mut writer, &tx, notif_limit)?;
            let nav_logs = write_nav_logs(&mut writer, &tx, nav_limit)?;
            let settings = write_settings(&mut writer, &tx)?;

            let mut counts: BTreeMap<String, i64> = BTreeMap::new();
            for rule in BACKUP_TABLES {
                if rule.table == "application_settings" {
                    counts.insert(rule.table.to_string(), settings as i64);
                } else if is_extended_table(rule.table) {
                    // 扩展表稍后统一写入
                } else {
                    counts.insert(rule.table.to_string(), count(&tx, rule.table)?);
                }
            }
            counts.insert("agent_events".into(), events as i64);
            counts.insert("notification_history".into(), notifications as i64);
            counts.insert("navigation_log".into(), nav_logs as i64);

            for table in EXTENDED_TABLES {
                let n = write_generic_table(&mut writer, &tx, table, kind)?;
                counts.insert((*table).to_string(), n as i64);
            }

            // 图片资产：完整备份必须包含所有被引用的原图/缩略图；
            // 快速备份只打包被导出条目引用的资产，绝不恢复出无文件的剪贴板行。
            let mut assets = 0usize;
            let mut asset_bytes = 0u64;
            let mut asset_paths: Vec<String> = Vec::new();
            {
                let sql = if kind.is_full() {
                    "SELECT path FROM clipboard_assets ORDER BY path".to_string()
                } else {
                    format!(
                        "SELECT path FROM clipboard_assets WHERE item_id IN ({}) ORDER BY path",
                        quick_item_sql()
                    )
                };
                let mut stmt = tx.prepare(&sql)?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                for row in rows {
                    asset_paths.push(row?);
                }
            }
            if let Some(root) = sources.clipboard_dir {
                for rel in &asset_paths {
                    match write_asset(&mut writer, root, rel) {
                        Ok(size) => {
                            assets += 1;
                            asset_bytes += size;
                        }
                        Err(e) => {
                            return Err(AppError::Validation(format!(
                                "剪贴板资产缺失或不可读（{}）：{}",
                                rel, e
                            )));
                        }
                    }
                }
            } else if !asset_paths.is_empty() {
                return Err(AppError::Validation(format!(
                    "备份缺少剪贴板资产目录，无法打包 {} 个图片文件",
                    asset_paths.len()
                )));
            }
            counts.insert("assets".into(), assets as i64);
            counts.insert("asset_bytes".into(), asset_bytes as i64);

            let mut archives = 0usize;
            let mut archive_bytes = 0u64;
            if kind.is_full() {
                if let Some(dir) = sources.archive_dir {
                    for (name, path) in list_archive_files(dir)? {
                        archive_bytes += write_archive(&mut writer, &path, &name)?;
                        archives += 1;
                    }
                }
            }
            counts.insert("archives".into(), archives as i64);
            counts.insert("archive_bytes".into(), archive_bytes as i64);

            tx.commit()?;
            Ok((serde_json::to_value(&counts)?, partial))
    });
    let (counts, partial) = match result {
        Ok(v) => v,
        Err(e) => {
            writer.abort();
            return Err(e);
        }
    };
    let sha = sha_hex(writer.hasher.clone());
    let footer = serde_json::json!({
        "record": "integrity",
        "counts": counts,
    });
    let finished = writer.finish(&footer, &sha);
    let (bytes, sha256) = match finished {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = commit_file(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(BackupWriteResult {
        path: target.to_path_buf(),
        kind: kind.as_str(),
        partial,
        bytes,
        sha256,
        counts,
    })
}

// ── 读取 / 校验 ────────────────────────────────────────────

fn unsafe_archive_name(name: &str) -> bool {
    name.is_empty()
        || !name.ends_with(".jsonl")
        || name.contains(['/', '\\'])
        || name == "."
        || name == ".."
}

struct ArchiveSink {
    name: String,
    path: PathBuf,
    expected_size: u64,
    expected_sha: String,
    /// 只校验不落盘时为 None（回滚数据库不需要再复制一份归档）。
    file: Option<BufWriter<File>>,
    hasher: Sha256,
    next_chunk: u32,
    written: u64,
}

impl ArchiveSink {
    fn finish(mut self, staged: &mut Vec<StagedArchive>) -> AppResult<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
            file.get_ref().sync_all()?;
        }
        let sha = sha_hex(self.hasher);
        if self.written != self.expected_size {
            return Err(AppError::Validation(format!(
                "归档 {} 大小不符：期望 {}，实际 {}",
                self.name, self.expected_size, self.written
            )));
        }
        if sha != self.expected_sha {
            return Err(AppError::Validation(format!(
                "归档 {} 校验失败（SHA-256 不一致）",
                self.name
            )));
        }
        staged.push(StagedArchive {
            name: self.name,
            path: self.path,
            size: self.written,
            sha256: sha,
        });
        Ok(())
    }
}

struct AssetSink {
    rel: String,
    path: PathBuf,
    expected_size: u64,
    expected_sha: String,
    file: Option<BufWriter<File>>,
    hasher: Sha256,
    next_chunk: u32,
    written: u64,
}

impl AssetSink {
    fn finish(mut self, staged: &mut Vec<StagedAsset>) -> AppResult<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
            file.get_ref().sync_all()?;
        }
        let sha = sha_hex(self.hasher);
        if self.written != self.expected_size {
            return Err(AppError::Validation(format!(
                "剪贴板资产 {} 大小不符：期望 {}，实际 {}",
                self.rel, self.expected_size, self.written
            )));
        }
        if sha != self.expected_sha {
            return Err(AppError::Validation(format!(
                "剪贴板资产 {} 校验失败（SHA-256 不一致）",
                self.rel
            )));
        }
        staged.push(StagedAsset {
            rel: self.rel,
            path: self.path,
            size: self.written,
            sha256: sha,
        });
        Ok(())
    }
}

/// 读取并校验备份；归档与剪贴板资产写入 `staging_dir`（只有对应记录时才创建），
/// 业务表行按表写入 `staging_dir/rows/`（JSONL），内存中只保留元信息与设置。
pub fn read_bundle(path: &Path, staging_dir: &Path) -> AppResult<ReadBackup> {
    read_bundle_impl(path, staging_dir, &staging_dir.join("rows"), true)
}

/// 只校验与解析，不把归档/资产落盘（回滚数据库时使用，避免磁盘被二次复制打满）；
/// 表行仍落到 `rows_dir`（由调用方指定并在会话清理时删除）。
pub(crate) fn read_bundle_data_only(path: &Path, rows_dir: &Path) -> AppResult<ReadBackup> {
    read_bundle_impl(path, Path::new(""), rows_dir, false)
}

/// 按行读取但先检查长度上限：超长行在分配前就被拒绝，避免恶意/损坏备份撑爆内存。
/// `buf` 由调用方复用，避免逐行重新分配；返回 true 表示读到了完整一行。
fn read_line_limited(
    reader: &mut impl BufRead,
    max: usize,
    line_no: usize,
    buf: &mut Vec<u8>,
) -> AppResult<bool> {
    buf.clear();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            if buf.is_empty() {
                return Ok(false);
            }
            break;
        }
        let take = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => i + 1,
            None => chunk.len(),
        };
        if buf.len() + take > max {
            return Err(AppError::Validation(format!(
                "备份第 {} 行超过 {} 字节上限",
                line_no, max
            )));
        }
        buf.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if buf.last() == Some(&b'\n') {
            break;
        }
    }
    if std::str::from_utf8(buf).is_err() {
        return Err(AppError::Validation(format!(
            "备份第 {} 行不是合法 UTF-8",
            line_no
        )));
    }
    Ok(true)
}

/// 暂存行缓冲区的 UTF-8 解码（`read_line_limited` 已校验过合法性）。
fn line_str(buf: &[u8], line_no: usize) -> AppResult<&str> {
    std::str::from_utf8(buf)
        .map_err(|_| AppError::Validation(format!("备份第 {} 行不是合法 UTF-8", line_no)))
}

/// 顺序遍历某张表落到暂存目录的 JSONL 行（文件不存在视为空表）。
pub(crate) fn for_each_spilled_row(
    rows_dir: &Path,
    table: &str,
    mut f: impl FnMut(usize, serde_json::Value) -> AppResult<()>,
) -> AppResult<()> {
    let path = rows_dir.join(format!("{}.jsonl", table));
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line_no = 0usize;
    let mut buf: Vec<u8> = Vec::new();
    while read_line_limited(&mut reader, MAX_LINE_BYTES, line_no + 1, &mut buf)? {
        line_no += 1;
        if buf.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let row: serde_json::Value =
            serde_json::from_str(line_str(&buf, line_no)?).map_err(|e| {
                AppError::Validation(format!(
                    "{} 表暂存第 {} 行不是合法 JSON: {}",
                    table, line_no, e
                ))
            })?;
        f(line_no - 1, row)?;
    }
    Ok(())
}

/// 顺序遍历某张表的 JSONL 行，直接反序列化为目标类型。
///
/// 与 `for_each_spilled_row` 的差别只在于中间表示：这里不构造
/// `serde_json::Value` 树，十万级行可少一次全量分配与一次字段遍历。
pub(crate) fn for_each_spilled_row_typed<T: serde::de::DeserializeOwned>(
    rows_dir: &Path,
    table: &str,
    mut f: impl FnMut(usize, T) -> AppResult<()>,
) -> AppResult<()> {
    let path = rows_dir.join(format!("{}.jsonl", table));
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line_no = 0usize;
    let mut buf: Vec<u8> = Vec::new();
    while read_line_limited(&mut reader, MAX_LINE_BYTES, line_no + 1, &mut buf)? {
        line_no += 1;
        if buf.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let row: T = serde_json::from_str(line_str(&buf, line_no)?).map_err(|e| {
            AppError::Validation(format!(
                "{}[{}] 字段缺失或类型不合法: {}",
                table,
                line_no - 1,
                e
            ))
        })?;
        f(line_no - 1, row)?;
    }
    Ok(())
}

/// section 行的快速解析：行内容保留原始 JSON 文本（不构造中间 Value 树）。
///
/// 十万级行的 section 每行 500 条，逐行构造 Value 再重写是分块备份的主要开销；
/// 这里借 `RawValue` 直接借用原始文本，落盘时原样写出。
#[derive(serde::Deserialize)]
struct RawSectionLine<'a> {
    #[serde(borrow)]
    table: &'a str,
    #[serde(borrow)]
    rows: Vec<&'a serde_json::value::RawValue>,
}

/// 解析 section 行的快速路径；形状不标准时返回 None，由调用方回退到通用解析。
fn parse_raw_section(line: &str) -> Option<RawSectionLine<'_>> {
    serde_json::from_str::<RawSectionLine>(line).ok()
}

/// 按原始文本判定记录类型。
///
/// 分块备份由本模块写出，`record` 永远是第一个字段且不含转义；
/// 判定不出来（外来文件、字段顺序不同）时返回 None，由调用方回退到通用解析。
fn peek_record(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("{\"record\":\"")?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn read_bundle_impl(
    path: &Path,
    staging_dir: &Path,
    rows_dir: &Path,
    materialize: bool,
) -> AppResult<ReadBackup> {
    // 重试用同一行目录时必须先清空：残留的旧表文件会被误读成这次备份的行。
    if rows_dir.exists() {
        std::fs::remove_dir_all(rows_dir)?;
    }
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut header: Option<serde_json::Value> = None;
    let mut section_counts: HashMap<String, usize> = HashMap::new();
    let mut section_writers: HashMap<String, BufWriter<File>> = HashMap::new();
    let mut settings = serde_json::Map::new();
    let mut sinks: HashMap<String, ArchiveSink> = HashMap::new();
    let mut staged: Vec<StagedArchive> = Vec::new();
    let mut asset_sinks: HashMap<String, AssetSink> = HashMap::new();
    let mut staged_assets: Vec<StagedAsset> = Vec::new();
    let mut asset_records = 0usize;
    let mut integrity: Option<serde_json::Value> = None;
    let mut line_no = 0usize;
    let mut line_buf: Vec<u8> = Vec::new();

    loop {
        if !read_line_limited(&mut reader, MAX_LINE_BYTES, line_no + 1, &mut line_buf)? {
            break;
        }
        line_no += 1;
        if line_buf.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let line = line_str(&line_buf, line_no)?;
        if integrity.is_some() {
            return Err(AppError::Validation(
                "备份完整性校验行之后存在多余数据（文件可能被追加）".into(),
            ));
        }
        // 快路径：section 行的行内容按原始 JSON 文本捕获，
        // 省掉「整行 Value 树 + 每行重写」的一次全量分配与转义。
        // 记录类型按原始文本判定；判定不了或形状不标准时回退到通用解析。
        if peek_record(line) == Some("section") {
            if let Some(parsed) = parse_raw_section(line) {
                if parsed.table != "settings" {
                    if header.is_none() {
                        return Err(AppError::Validation("备份缺少头记录".into()));
                    }
                    if table_rule(parsed.table).is_none() {
                        return Err(AppError::Validation(format!(
                            "备份包含未登记的数据表 {}（拒绝静默丢失或覆盖）",
                            parsed.table
                        )));
                    }
                    hasher.update(line.as_bytes());
                    std::fs::create_dir_all(rows_dir)?;
                    if !section_writers.contains_key(parsed.table) {
                        // 空 section 也创建文件：完整扩展模块必须能区分「空表」与「缺表」
                        let file = File::create(rows_dir.join(format!("{}.jsonl", parsed.table)))?;
                        section_writers.insert(
                            parsed.table.to_string(),
                            BufWriter::with_capacity(1024 * 1024, file),
                        );
                    }
                    let sink = section_writers.get_mut(parsed.table).expect("刚插入");
                    for row in &parsed.rows {
                        sink.write_all(row.get().as_bytes())?;
                        sink.write_all(b"\n")?;
                    }
                    *section_counts.entry(parsed.table.to_string()).or_insert(0) +=
                        parsed.rows.len();
                    continue;
                }
            }
        }
        let value: serde_json::Value = serde_json::from_str(line.trim_end()).map_err(|e| {
            AppError::Validation(format!("备份第 {} 行不是合法 JSON: {}", line_no, e))
        })?;
        let record = value
            .get("record")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Validation(format!("备份第 {} 行缺少 record", line_no)))?
            .to_string();
        if record == "integrity" {
            let expect = value
                .get("sha256")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::Validation("完整性行缺少 sha256".into()))?;
            let got = sha_hex(hasher.clone());
            if !expect.eq_ignore_ascii_case(&got) {
                return Err(AppError::Validation(
                    "备份完整性校验失败：内容哈希不一致（文件损坏或被修改）".into(),
                ));
            }
            integrity = Some(value);
            continue;
        }
        hasher.update(line.as_bytes());
        match record.as_str() {
            "header" => {
                if header.is_some() || line_no != 1 {
                    return Err(AppError::Validation("备份头必须且只能出现在第一行".into()));
                }
                if value.get("app").and_then(|v| v.as_str()) != Some("task-dock")
                    || value.get("format").and_then(|v| v.as_str()) != Some(BUNDLE_FORMAT)
                {
                    return Err(AppError::Validation("不是 Task Dock 分块备份文件".into()));
                }
                let bv = value
                    .get("bundle_version")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if bv != BUNDLE_VERSION {
                    return Err(AppError::Validation(format!(
                        "不支持的备份容器版本: {}",
                        bv
                    )));
                }
                let ev = value
                    .get("export_version")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if !(1..=data::EXPORT_VERSION).contains(&ev) {
                    return Err(AppError::Validation(format!("不支持的数据版本: {}", ev)));
                }
                header = Some(value);
            }
            "section" => {
                if header.is_none() {
                    return Err(AppError::Validation("备份缺少头记录".into()));
                }
                let table = value
                    .get("table")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::Validation("section 缺少 table".into()))?;
                if table == "settings" {
                    if let Some(obj) = value.get("value").and_then(|v| v.as_object()) {
                        settings = obj.clone();
                    }
                    continue;
                }
                if table_rule(table).is_none() {
                    return Err(AppError::Validation(format!(
                        "备份包含未登记的数据表 {}（拒绝静默丢失或覆盖）",
                        table
                    )));
                }
                let rows = value
                    .get("rows")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| AppError::Validation(format!("{} section 缺少 rows", table)))?;
                std::fs::create_dir_all(rows_dir)?;
                if !section_writers.contains_key(table) {
                    // 空 section 也创建文件：完整扩展模块必须能区分「空表」与「缺表」
                    let file = File::create(rows_dir.join(format!("{}.jsonl", table)))?;
                    section_writers.insert(
                        table.to_string(),
                        BufWriter::with_capacity(1024 * 1024, file),
                    );
                }
                let sink = section_writers.get_mut(table).expect("刚插入");
                for row in rows {
                    serde_json::to_writer(&mut *sink, row).map_err(|e| {
                        AppError::Validation(format!(
                            "备份第 {} 行 {} 表数据无法写入暂存: {}",
                            line_no, table, e
                        ))
                    })?;
                    sink.write_all(b"\n")?;
                }
                *section_counts.entry(table.to_string()).or_insert(0) += rows.len();
            }
            "archive" => {
                if header.is_none() {
                    return Err(AppError::Validation("备份缺少头记录".into()));
                }
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if unsafe_archive_name(name) {
                    return Err(AppError::Validation(format!("非法归档文件名: {}", name)));
                }
                let size = value.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                let sha = value
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let chunk = value.get("chunk").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let content = value.get("data").and_then(|v| v.as_str()).unwrap_or("");
                let sink = match sinks.get_mut(name) {
                    Some(s) if chunk == s.next_chunk => s,
                    Some(_) => {
                        return Err(AppError::Validation(format!("归档 {} 分块顺序错误", name)))
                    }
                    None => {
                        if chunk != 0 {
                            return Err(AppError::Validation(format!("归档 {} 缺少首块", name)));
                        }
                        if staged.iter().any(|a| a.name == name) {
                            return Err(AppError::Validation(format!(
                                "归档 {} 重复出现（文件名冲突）",
                                name
                            )));
                        }
                        let (dest, file) = if materialize {
                            std::fs::create_dir_all(staging_dir)?;
                            let dest = staging_dir.join(name);
                            let f = File::create(&dest)?;
                            (dest, Some(BufWriter::new(f)))
                        } else {
                            (PathBuf::new(), None)
                        };
                        sinks.insert(
                            name.to_string(),
                            ArchiveSink {
                                name: name.to_string(),
                                path: dest,
                                expected_size: size,
                                expected_sha: sha.to_string(),
                                file,
                                hasher: Sha256::new(),
                                next_chunk: 0,
                                written: 0,
                            },
                        );
                        sinks.get_mut(name).expect("刚插入")
                    }
                };
                if let Some(file) = sink.file.as_mut() {
                    file.write_all(content.as_bytes())?;
                }
                sink.hasher.update(content.as_bytes());
                sink.written += content.len() as u64;
                sink.next_chunk += 1;
                if sink.written > sink.expected_size {
                    return Err(AppError::Validation(format!(
                        "归档 {} 写入超过声明大小",
                        sink.name
                    )));
                }
                if sink.written == sink.expected_size {
                    let sink = sinks.remove(name).expect("存在");
                    sink.finish(&mut staged)?;
                }
            }
            "asset" => {
                if header.is_none() {
                    return Err(AppError::Validation("备份缺少头记录".into()));
                }
                let rel = value
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                safe_asset_rel(rel)?;
                let size = value.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                let sha = value
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(AppError::Validation(format!(
                        "剪贴板资产 {} 缺少有效 SHA-256",
                        rel
                    )));
                }
                let chunk = value.get("chunk").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let content = value.get("data").and_then(|v| v.as_str()).unwrap_or("");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(content)
                    .map_err(|_| {
                        AppError::Validation(format!("剪贴板资产 {} 的 Base64 数据非法", rel))
                    })?;
                let sink = match asset_sinks.get_mut(rel) {
                    Some(s) if chunk == s.next_chunk => s,
                    Some(_) => {
                        return Err(AppError::Validation(format!(
                            "剪贴板资产 {} 分块顺序错误",
                            rel
                        )))
                    }
                    None => {
                        if chunk != 0 || staged_assets.iter().any(|a| a.rel == rel) {
                            return Err(AppError::Validation(format!(
                                "剪贴板资产 {} 缺少首块或路径重复",
                                rel
                            )));
                        }
                        let (dest, file) = if materialize {
                            let dest = staging_dir.join("assets").join(rel);
                            if let Some(parent) = dest.parent() {
                                std::fs::create_dir_all(parent)?;
                            }
                            let f = File::create(&dest)?;
                            (dest, Some(BufWriter::new(f)))
                        } else {
                            (PathBuf::new(), None)
                        };
                        asset_sinks.insert(
                            rel.to_string(),
                            AssetSink {
                                rel: rel.to_string(),
                                path: dest,
                                expected_size: size,
                                expected_sha: sha.to_string(),
                                file,
                                hasher: Sha256::new(),
                                next_chunk: 0,
                                written: 0,
                            },
                        );
                        asset_sinks.get_mut(rel).expect("刚插入")
                    }
                };
                if let Some(file) = sink.file.as_mut() {
                    file.write_all(&bytes)?;
                }
                sink.hasher.update(&bytes);
                sink.written += bytes.len() as u64;
                sink.next_chunk += 1;
                if sink.written > sink.expected_size {
                    return Err(AppError::Validation(format!(
                        "剪贴板资产 {} 写入超过声明大小",
                        sink.rel
                    )));
                }
                if sink.written == sink.expected_size {
                    let sink = asset_sinks.remove(rel).expect("存在");
                    sink.finish(&mut staged_assets)?;
                    asset_records += 1;
                }
            }
            other => return Err(AppError::Validation(format!("未知备份记录类型: {}", other))),
        }
    }

    for (table, writer) in section_writers.iter_mut() {
        writer
            .flush()
            .map_err(|e| AppError::Validation(format!("{} 表数据写入暂存失败: {}", table, e)))?;
    }
    section_writers.clear();

    let header = header.ok_or_else(|| AppError::Validation("备份文件为空".into()))?;
    let integrity = integrity
        .ok_or_else(|| AppError::Validation("备份文件不完整（缺少完整性校验行）".into()))?;
    if !sinks.is_empty() {
        return Err(AppError::Validation(format!(
            "备份不完整：{} 个归档分块缺失",
            sinks.len()
        )));
    }
    if !asset_sinks.is_empty() {
        return Err(AppError::Validation(format!(
            "备份不完整：{} 个剪贴板资产分块缺失",
            asset_sinks.len()
        )));
    }
    let manifest_version = header
        .get("manifest_version")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    if manifest_version > MANIFEST_VERSION {
        return Err(AppError::Validation(format!(
            "备份清单版本 {} 高于当前支持的 {}，请升级应用后再恢复",
            manifest_version, MANIFEST_VERSION
        )));
    }
    let extended = header
        .get("extended_modules")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // 行数与完整性行一致，防止“合法哈希 + 截断 section”的自洽文件
    let counts = integrity
        .get("counts")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    for rule in BACKUP_TABLES {
        let table = rule.table;
        if table == "application_settings" {
            if let Some(expect) = counts.get(table).and_then(|v| v.as_i64()) {
                if expect != settings.len() as i64 {
                    return Err(AppError::Validation(format!(
                        "设置项数与完整性记录不一致：期望 {}，实际 {}",
                        expect,
                        settings.len()
                    )));
                }
            }
            continue;
        }
        if rule.extended && !extended {
            continue;
        }
        if rule.extended && !section_counts.contains_key(table) && counts.get(table).is_some() {
            return Err(AppError::Validation(format!(
                "备份缺少扩展数据表 {}（新格式备份必须完整声明）",
                table
            )));
        }
        let actual = section_counts.get(table).copied().unwrap_or(0) as i64;
        let expect = counts.get(table).and_then(|v| v.as_i64()).unwrap_or(-1);
        if expect >= 0 && expect != actual {
            return Err(AppError::Validation(format!(
                "{} 行数与完整性记录不一致：期望 {}，实际 {}",
                table, expect, actual
            )));
        }
    }

    // 资产校验：每个数据库引用必须有同名文件且大小/哈希一致；也不接受未引用的多余文件。
    let mut asset_by_rel: HashMap<&str, &StagedAsset> = HashMap::new();
    for asset in &staged_assets {
        asset_by_rel.insert(asset.rel.as_str(), asset);
    }
    let mut referenced: HashSet<String> = HashSet::new();
    if extended {
        for_each_spilled_row(rows_dir, "clipboard_assets", |index, row| {
            let raw = row.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
                AppError::Validation(format!("clipboard_assets 第 {} 行缺少 path", index + 1))
            })?;
            safe_asset_rel(raw)?;
            let asset = asset_by_rel
                .get(raw)
                .ok_or_else(|| AppError::Validation(format!("备份缺少剪贴板资产文件: {}", raw)))?;
            if let Some(expected) = row.get("byte_size").and_then(|v| v.as_i64()) {
                if expected > 0 && expected as u64 != asset.size {
                    return Err(AppError::Validation(format!(
                        "剪贴板资产 {} 大小与数据库记录不一致：记录 {}，实际 {}",
                        raw, expected, asset.size
                    )));
                }
            }
            referenced.insert(raw.to_string());
            Ok(())
        })?;
        for asset in &staged_assets {
            if !referenced.contains(&asset.rel) {
                return Err(AppError::Validation(format!(
                    "备份包含未被数据库引用的剪贴板资产: {}",
                    asset.rel
                )));
            }
        }
        let advertised = counts.get("assets").and_then(|v| v.as_i64()).unwrap_or(-1);
        if advertised >= 0 && advertised != asset_records as i64 {
            return Err(AppError::Validation(format!(
                "剪贴板资产数量与完整性记录不一致：期望 {}，实际 {}",
                advertised, asset_records
            )));
        }
        let advertised_bytes = counts
            .get("asset_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(u64::MAX);
        let actual_bytes: u64 = staged_assets.iter().map(|a| a.size).sum();
        if advertised_bytes != u64::MAX && advertised_bytes != actual_bytes {
            return Err(AppError::Validation(format!(
                "剪贴板资产总字节与完整性记录不一致：期望 {}，实际 {}",
                advertised_bytes, actual_bytes
            )));
        }
    } else if !staged_assets.is_empty() {
        return Err(AppError::Validation(
            "旧格式备份不应包含剪贴板资产记录".into(),
        ));
    }

    // 内存中只保留元信息与设置；业务表行已按表落到 rows_dir。
    let data = serde_json::json!({
        "app": "task-dock",
        "version": header.get("export_version").and_then(|v| v.as_i64()).unwrap_or(0),
        "exported_at": header.get("exported_at").cloned().unwrap_or(serde_json::Value::Null),
        "backup_kind": header.get("backup_kind").cloned().unwrap_or(serde_json::Value::Null),
        "partial": header.get("partial").cloned().unwrap_or(serde_json::Value::Bool(true)),
        "manifest_version": manifest_version,
        "extended_modules": extended,
        "bundle_payload_sha256": integrity.get("sha256").cloned().unwrap_or(serde_json::Value::Null),
        "asset_manifest": serde_json::Value::Array(
            staged_assets
                .iter()
                .map(|a| {
                    serde_json::json!({
                        "path": a.rel,
                        "size": a.size,
                        "sha256": a.sha256,
                    })
                })
                .collect(),
        ),
        "settings": serde_json::Value::Object(settings),
    });
    Ok(ReadBackup {
        data,
        rows_dir: rows_dir.to_path_buf(),
        kind: header
            .get("backup_kind")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        partial: header
            .get("partial")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        counts,
        archives: staged,
        assets: staged_assets,
        extended,
        manifest_version,
    })
}

/// 读取首行元信息（备份列表展示用；不校验整个文件）。
pub fn bundle_meta(path: &Path) -> Option<serde_json::Value> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let value: serde_json::Value = serde_json::from_str(line.trim_end()).ok()?;
    if value.get("format").and_then(|v| v.as_str()) != Some(BUNDLE_FORMAT) {
        return None;
    }
    Some(serde_json::json!({
        "format": "bundle",
        "kind": value.get("backup_kind").cloned().unwrap_or(serde_json::Value::Null),
        "partial": value.get("partial").cloned().unwrap_or(serde_json::Value::Bool(true)),
        "partial_reasons": value.get("partial_reasons").cloned().unwrap_or(serde_json::Value::Null),
        "truncated_tables": value.get("truncated_tables").cloned().unwrap_or(serde_json::Value::Null),
        "counts": value.get("totals").cloned().unwrap_or(serde_json::Value::Null),
        "manifest_version": value.get("manifest_version").cloned().unwrap_or(serde_json::Value::Null),
        "extended_modules": value.get("extended_modules").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "exported_at": value.get("exported_at").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

/// 流式计算文件大小与 SHA-256（恢复续跑时校验目标文件是否已是提交内容）。
pub(crate) fn sha256_file(path: &Path) -> AppResult<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((size, sha_hex(hasher)))
}

pub fn is_bundle(path: &Path) -> AppResult<bool> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    if first.trim().is_empty() {
        return Ok(false);
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(first.trim_end()) {
        return Ok(v.get("format").and_then(|x| x.as_str()) == Some(BUNDLE_FORMAT));
    }
    Ok(false)
}

/// 把校验过的归档从暂存目录提交到正式归档目录（逐个原子替换）。
pub fn commit_archives(staged: &[StagedArchive], target_dir: &Path) -> AppResult<usize> {
    std::fs::create_dir_all(target_dir)?;
    let mut moved = 0usize;
    for archive in staged {
        let dest = target_dir.join(&archive.name);
        commit_file(&archive.path, &dest)?;
        moved += 1;
    }
    Ok(moved)
}

/// 把校验过的剪贴板资产从暂存目录提交到剪贴板根目录（逐个原子替换）。
pub fn commit_assets(staged: &[StagedAsset], target_root: &Path) -> AppResult<usize> {
    let mut moved = 0usize;
    for asset in staged {
        safe_asset_rel(&asset.rel)?;
        let dest = target_root.join(&asset.rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        commit_file(&asset.path, &dest)?;
        moved += 1;
    }
    Ok(moved)
}

/// 把单个文件复制到目标（恢复前把将被覆盖的资产/归档留底）。
pub(crate) fn preserve_file(src: &Path, dest: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::now_iso;
    use crate::commands::restore::{restore_bundle, RestoreOptions, RestoreState};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-backup-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_minimal(db: &Db) {
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at) VALUES ('t1','任务','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO notification_history (id,kind,title,body,ref_type,ref_id,occurrence,is_read,created_at) VALUES ('n1','task_due','提醒','',NULL,NULL,NULL,0,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
    }

    fn write_then_read(db: &Db, kind: BackupKind) -> (PathBuf, ReadBackup, PathBuf) {
        let dir = temp_dir("roundtrip");
        let target = dir.join("backup.json");
        write_bundle(db, BackupSources::default(), &target, kind).unwrap();
        let staging = dir.join("staging");
        let read = read_bundle(&target, &staging).unwrap();
        (target, read, dir)
    }

    fn spilled_rows(read: &ReadBackup, table: &str) -> Vec<serde_json::Value> {
        let mut rows = Vec::new();
        for_each_spilled_row(&read.rows_dir, table, |_, row| {
            rows.push(row);
            Ok(())
        })
        .unwrap();
        rows
    }

    fn import_read(db: &Db, read: &ReadBackup) -> AppResult<()> {
        let parsed = data::validate_bundle(db, &read.data, &read.rows_dir)?;
        data::import_parsed_with(
            db,
            parsed,
            &data::ImportOptions {
                allow_extended: true,
                commit_marker: None,
            },
        )
    }

    #[test]
    fn bundle_roundtrip_restores_rows_and_integrity() {
        let db = memdb();
        seed_minimal(&db);
        let (_, read, dir) = write_then_read(&db, BackupKind::Full);
        assert_eq!(spilled_rows(&read, "tasks").len(), 1);
        assert_eq!(spilled_rows(&read, "notification_history").len(), 1);
        assert_eq!(read.counts["archives"], 0);
        assert_eq!(read.kind, "full");
        assert!(!read.partial);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn quick_backup_is_explicitly_partial_and_truncates_events() {
        let db = memdb();
        seed_minimal(&db);
        db.with_conn(|c| {
            for i in 0..QUICK_EVENT_LIMIT + 5 {
                c.execute(
                    "INSERT INTO agent_events (id,source_id,session_external_id,event_type,state,received_at) VALUES (?1,'codex','s','status','completed',?2)",
                    rusqlite::params![
                        format!("e{:05}", i),
                        format!(
                            "2026-10-30T{:02}:{:02}:{:02}+00:00",
                            10 + i / 3600,
                            (i / 60) % 60,
                            i % 60
                        )
                    ],
                )?;
            }
            // 进行中的受保护事件：时间很旧，但仍必须完整进入快速备份
            for i in 0..3 {
                c.execute(
                    "INSERT INTO agent_events (id,source_id,session_external_id,event_type,state,received_at) VALUES (?1,'codex','s','status','running',?2)",
                    rusqlite::params![format!("live-{}", i), format!("2020-01-01T00:00:0{}+00:00", i)],
                )?;
            }
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        let (target, read, dir) = write_then_read(&db, BackupKind::Quick);
        let rows = spilled_rows(&read, "agent_events");
        assert_eq!(
            rows.len(),
            QUICK_EVENT_LIMIT as usize + 3,
            "最近 20000 条 + 全部 running 事件"
        );
        for i in 0..3 {
            assert!(
                rows.iter().any(|r| r["id"] == format!("live-{}", i)),
                "受保护的进行中事件不得被时间窗口截掉"
            );
        }
        assert!(read.partial, "快速备份必须标记为部分");
        assert_eq!(read.kind, "quick");
        let meta = bundle_meta(&target).unwrap();
        assert_eq!(meta["partial"], true);
        assert_eq!(
            meta["counts"]["agent_events"],
            QUICK_EVENT_LIMIT + 8,
            "元信息展示数据库总量，partial 表明导出已截断"
        );
        // 完整备份不截断
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn full_backup_includes_all_events_and_notifications() {
        let db = memdb();
        seed_minimal(&db);
        db.with_conn(|c| {
            for i in 0..1_500 {
                c.execute(
                    "INSERT INTO agent_events (id,source_id,session_external_id,event_type,state,received_at) VALUES (?1,'codex','s','status','running',?2)",
                    rusqlite::params![format!("e{}", i), now_iso()],
                )?;
            }
            for i in 0..600 {
                c.execute(
                    "INSERT INTO notification_history (id,kind,title,body,ref_type,ref_id,occurrence,is_read,created_at) VALUES (?1,'k','t','',NULL,NULL,NULL,0,?2)",
                    rusqlite::params![format!("x{}", i), now_iso()],
                )?;
            }
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        let (_, read, dir) = write_then_read(&db, BackupKind::Full);
        assert_eq!(spilled_rows(&read, "agent_events").len(), 1_500);
        assert_eq!(spilled_rows(&read, "notification_history").len(), 601);
        assert!(!read.partial);
        std::fs::remove_dir_all(dir).ok();
    }

    fn rewrite_lines(src: &Path, dst: &Path, mutate: impl Fn(&mut Vec<serde_json::Value>)) {
        let raw = std::fs::read_to_string(src).unwrap();
        let mut lines: Vec<serde_json::Value> = raw
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        // 完整性行（最后一行）也交给调用方改（例如行数），改完再重算哈希。
        mutate(&mut lines);
        let mut footer = lines.pop().unwrap();
        let mut hasher = Sha256::new();
        let mut out = String::new();
        for line in &lines {
            let s = serde_json::to_string(line).unwrap() + "\n";
            hasher.update(s.as_bytes());
            out.push_str(&s);
        }
        footer["sha256"] = serde_json::Value::String(sha_hex(hasher));
        out.push_str(&serde_json::to_string(&footer).unwrap());
        out.push('\n');
        std::fs::write(dst, out).unwrap();
    }

    #[test]
    fn truncated_bundle_is_rejected() {
        let db = memdb();
        seed_minimal(&db);
        let (target, _, dir) = write_then_read(&db, BackupKind::Full);
        let raw = std::fs::read_to_string(&target).unwrap();
        let mut lines: Vec<&str> = raw.lines().collect();
        lines.pop();
        std::fs::write(&target, lines.join("\n") + "\n").unwrap();
        let err = read_bundle(&target, &dir.join("staging")).unwrap_err();
        assert!(err.to_string().contains("完整性校验行"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tampered_bundle_is_rejected_before_restore() {
        let db = memdb();
        seed_minimal(&db);
        let (target, _, dir) = write_then_read(&db, BackupKind::Full);
        let raw = std::fs::read_to_string(&target).unwrap();
        let tampered = raw.replacen("\"任务\"", "\"被篡改\"", 1);
        std::fs::write(&target, tampered).unwrap();
        let err = read_bundle(&target, &dir.join("staging")).unwrap_err();
        assert!(err.to_string().contains("完整性校验失败"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn archives_are_chunked_restored_and_hash_checked() {
        let db = memdb();
        seed_minimal(&db);
        let dir = temp_dir("archives");
        let archive = dir.join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        // >1 MiB 且含中文：必须跨多个块，且块边界不能切断 UTF-8 字符
        let body = (0..60_000)
            .map(|i| format!("{{\"id\":{},\"text\":\"事件归档\"}}\n", i))
            .collect::<String>();
        std::fs::write(archive.join("agent-events-1.jsonl"), &body).unwrap();
        std::fs::write(archive.join("agent-events-2.jsonl"), "").unwrap();
        std::fs::write(archive.join("ignored.txt"), "x").unwrap();
        let target = dir.join("backup.json");
        let result = write_bundle(
            &db,
            BackupSources {
                archive_dir: Some(&archive),
                clipboard_dir: None,
            },
            &target,
            BackupKind::Full,
        )
        .unwrap();
        assert_eq!(result.counts["archives"], 2);
        let staging = dir.join("staging");
        let read = read_bundle(&target, &staging).unwrap();
        assert_eq!(read.archives.len(), 2);
        let restored = std::fs::read_to_string(staging.join("agent-events-1.jsonl")).unwrap();
        assert_eq!(restored, body);
        assert_eq!(
            std::fs::read_to_string(staging.join("agent-events-2.jsonl")).unwrap(),
            ""
        );
        let out = dir.join("archive-restored");
        assert_eq!(commit_archives(&read.archives, &out).unwrap(), 2);
        assert_eq!(
            std::fs::read_to_string(out.join("agent-events-1.jsonl")).unwrap(),
            body
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_archive_is_rejected_even_with_valid_integrity_line() {
        let db = memdb();
        seed_minimal(&db);
        let dir = temp_dir("archive-corrupt");
        let archive = dir.join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        std::fs::write(archive.join("a.jsonl"), "{\"id\":1}\n").unwrap();
        let target = dir.join("backup.json");
        write_bundle(
            &db,
            BackupSources {
                archive_dir: Some(&archive),
                clipboard_dir: None,
            },
            &target,
            BackupKind::Full,
        )
        .unwrap();
        let bad = dir.join("bad.json");
        rewrite_lines(&target, &bad, |lines| {
            for line in lines.iter_mut() {
                if line.get("record").and_then(|v| v.as_str()) == Some("archive") {
                    line["data"] = json!("{\"id\":2}\n");
                    break;
                }
            }
        });
        let err = read_bundle(&bad, &dir.join("staging")).unwrap_err();
        assert!(
            err.to_string().contains("归档") && err.to_string().contains("校验"),
            "实际错误: {}",
            err
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn invalid_row_fails_validation_and_leaves_target_db_untouched() {
        let src = memdb();
        seed_minimal(&src);
        let (target, _, dir) = write_then_read(&src, BackupKind::Full);
        let bad = dir.join("bad.json");
        rewrite_lines(&target, &bad, |lines| {
            for line in lines.iter_mut() {
                if line.get("table").and_then(|v| v.as_str()) == Some("agent_runs") {
                    if let Some(rows) = line.get_mut("rows").and_then(|v| v.as_array_mut()) {
                        rows.clear();
                    }
                }
                if line.get("table").and_then(|v| v.as_str()) == Some("tasks") {
                    if let Some(rows) = line.get_mut("rows").and_then(|v| v.as_array_mut()) {
                        for row in rows {
                            row["recurrence_rule_id"] = json!("missing-rule");
                        }
                    }
                }
            }
        });
        let read = read_bundle(&bad, &dir.join("staging")).unwrap();
        let dst = memdb();
        dst.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at) VALUES ('keep','保留','',0,'pending','','[]',0,?1,?1)",
                rusqlite::params![now_iso()],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        assert!(data::validate_bundle(&dst, &read.data, &read.rows_dir).is_err());
        let kept: String = dst
            .with_conn(|c| {
                c.query_row("SELECT id FROM tasks", [], |r| r.get(0))
                    .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(kept, "keep", "恢复失败不得改动原库");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn duplicate_event_ids_and_dedupe_keys_are_rejected_without_touching_target() {
        let src = memdb();
        seed_minimal(&src);
        let now = now_iso();
        src.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_events (id,source_id,session_external_id,event_type,state,received_at,dedupe_key) VALUES ('ev-1','codex','s1','status','completed',?1,'dk-1')",
                rusqlite::params![now],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        let (target, _, dir) = write_then_read(&src, BackupKind::Full);

        // 同一 id 出现两次：必须在写库阶段被拒绝，且目标库保持原样。
        let dup_id = dir.join("dup-id.json");
        rewrite_lines(&target, &dup_id, |lines| {
            for line in lines.iter_mut() {
                if line.get("table").and_then(|v| v.as_str()) == Some("agent_events") {
                    if let Some(rows) = line.get_mut("rows").and_then(|v| v.as_array_mut()) {
                        let first = rows[0].clone();
                        rows.push(first);
                    }
                }
                // 完整性行里的行数也要一起改，否则先被行数校验挡下（测不到重复检测）。
                if line.get("record").and_then(|v| v.as_str()) == Some("integrity") {
                    line["counts"]["agent_events"] = json!(2);
                }
            }
        });
        let read = read_bundle(&dup_id, &dir.join("staging")).unwrap();
        let dst = memdb();
        dst.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at) VALUES ('keep','保留','',0,'pending','','[]',0,?1,?1)",
                rusqlite::params![now_iso()],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        let err = import_read(&dst, &read).unwrap_err();
        assert!(
            err.to_string().contains("重复 id"),
            "重复 id 必须被拒绝，实际错误: {}",
            err
        );
        let kept: String = dst
            .with_conn(|c| {
                c.query_row("SELECT id FROM tasks", [], |r| r.get(0))
                    .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(kept, "keep", "拒绝重复事件不得改动原库");
        let events: i64 = dst
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))
                    .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(events, 0, "被拒绝的导入不得留下事件行");

        // dedupe_key 重复（id 不同）：同样必须被拒绝。
        let dup_key = dir.join("dup-key.json");
        rewrite_lines(&target, &dup_key, |lines| {
            for line in lines.iter_mut() {
                if line.get("table").and_then(|v| v.as_str()) == Some("agent_events") {
                    if let Some(rows) = line.get_mut("rows").and_then(|v| v.as_array_mut()) {
                        let mut second = rows[0].clone();
                        second["id"] = json!("ev-2");
                        rows.push(second);
                    }
                }
                if line.get("record").and_then(|v| v.as_str()) == Some("integrity") {
                    line["counts"]["agent_events"] = json!(2);
                }
            }
        });
        let read = read_bundle(&dup_key, &dir.join("staging")).unwrap();
        let err = import_read(&dst, &read).unwrap_err();
        assert!(
            err.to_string().contains("重复 dedupe_key"),
            "重复 dedupe_key 必须被拒绝，实际错误: {}",
            err
        );
        let events: i64 = dst
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))
                    .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(events, 0, "被拒绝的导入不得留下事件行");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn failed_replace_never_destroys_existing_backup() {
        let dir = temp_dir("replace");
        let target = dir.join("backup.json");
        std::fs::write(&target, "old-valid").unwrap();
        let missing = dir.join("missing.tmp");
        assert!(commit_file(&missing, &target).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old-valid");
        std::fs::write(dir.join("new.tmp"), "new-valid").unwrap();
        commit_file(&dir.join("new.tmp"), &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new-valid");
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().contains("previous"))
                .count(),
            0
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn export_import_export_is_consistent() {
        let src = memdb();
        seed_minimal(&src);
        src.with_conn(|c| {
            for i in 0..300 {
                c.execute(
                    "INSERT INTO agent_events (id,source_id,session_external_id,event_type,state,received_at,ingest_seq) VALUES (?1,'codex','s','status','completed',?2,?3)",
                    rusqlite::params![format!("e{}", i), now_iso(), i as i64 + 1],
                )?;
            }
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        let dir1 = temp_dir("rt1");
        let b1 = dir1.join("b1.json");
        write_bundle(&src, BackupSources::default(), &b1, BackupKind::Full).unwrap();
        let read1 = read_bundle(&b1, &dir1.join("staging")).unwrap();
        let dst = memdb();
        import_read(&dst, &read1).unwrap();
        let dir2 = temp_dir("rt2");
        let b2 = dir2.join("b2.json");
        write_bundle(&dst, BackupSources::default(), &b2, BackupKind::Full).unwrap();
        let read2 = read_bundle(&b2, &dir2.join("staging")).unwrap();
        assert_eq!(spilled_rows(&read1, "tasks"), spilled_rows(&read2, "tasks"));
        assert_eq!(
            spilled_rows(&read1, "agent_events"),
            spilled_rows(&read2, "agent_events")
        );
        assert_eq!(read2.counts["agent_events"], 300);
        std::fs::remove_dir_all(dir1).ok();
        std::fs::remove_dir_all(dir2).ok();
    }

    #[test]
    fn runs_watermarks_survive_roundtrip() {
        let src = memdb();
        src.with_conn(|c| {
            let now = now_iso();
            c.execute(
                "INSERT INTO agent_sources (id,display_name,kind,enabled,verified,transport_verified,homepage,note,config,adapter,icon,hidden,created_at,updated_at) VALUES ('codex','Codex','cli',1,1,1,'','','','','',0,?1,?1) ON CONFLICT(id) DO NOTHING",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO agent_sessions (id,source_id,external_id,title,status,first_seen_at,last_seen_at) VALUES ('s1','codex','ext','','running',?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO agent_runs (id,session_id,source_id,external_run_id,task_title,status,started_at,updated_at,last_ingest_seq,last_event_at) VALUES ('r1','s1','codex','ext-r','','waiting',?1,?1,987654321,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        let (_, read, dir) = write_then_read(&src, BackupKind::Full);
        assert_eq!(
            spilled_rows(&read, "agent_runs")[0]["last_ingest_seq"],
            987654321i64
        );
        let dst = memdb();
        import_read(&dst, &read).unwrap();
        let seq: i64 = dst
            .with_conn(|c| {
                c.query_row(
                    "SELECT last_ingest_seq FROM agent_runs WHERE id = 'r1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(seq, 987654321);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn backup_registry_covers_every_schema_table() {
        let db = memdb();
        let tables: Vec<String> = db
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        let mut seen = HashSet::new();
        for table in &tables {
            let rule = table_rule(table).unwrap_or_else(|| {
                panic!(
                    "数据库表 {} 未在 BACKUP_TABLES 登记：新增用户数据表必须声明备份策略",
                    table
                )
            });
            assert!(seen.insert(rule.table), "备份注册表重复登记 {}", table);
            assert_eq!(
                is_extended_table(table),
                rule.extended,
                "{} 的 extended 标记与注册表不一致",
                table
            );
        }
        for rule in BACKUP_TABLES {
            assert!(
                tables.iter().any(|t| t == rule.table),
                "备份注册表登记了不存在的表 {}",
                rule.table
            );
        }
    }

    fn seed_clipboard(db: &Db, root: &Path) {
        std::fs::create_dir_all(root.join("images")).unwrap();
        std::fs::create_dir_all(root.join("thumbs")).unwrap();
        let img = b"\x89PNG\r\n\x1a\nimage-bytes-12345";
        let thumb = b"\x89PNG\r\n\x1a\nthumb";
        std::fs::write(root.join("images/i1.png"), img).unwrap();
        std::fs::write(root.join("thumbs/i1.png"), thumb).unwrap();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at) VALUES ('t1','任务','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_items (id,kind,text,html,preview,content_hash,byte_size,source_app,source_title,image_width,image_height,file_paths,favorite,pinned,copy_count,created_at,last_seen_at)
                 VALUES ('i1','image','','','','hash-1',?1,'','',10,10,'[]',0,0,1,?2,?2)",
                rusqlite::params![img.len() as i64, now],
            )?;
            c.execute(
                "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at) VALUES ('a1','i1','image','images/i1.png',?1,10,10,?2)",
                rusqlite::params![img.len() as i64, now],
            )?;
            c.execute(
                "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at) VALUES ('a2','i1','thumb','thumbs/i1.png',?1,10,10,?2)",
                rusqlite::params![thumb.len() as i64, now],
            )?;
            c.execute(
                "INSERT INTO clipboard_groups (id,name,mode,status,favorite,pinned,created_at,updated_at) VALUES ('g1','组','manual','collecting',0,0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_group_items (group_id,item_id,position,origin,added_at) VALUES ('g1','i1',0,'manual',?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_task_links (id,task_id,target_type,target_id,created_at) VALUES ('cl1','t1','item','i1',?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_paste_jobs (id,group_id,target_title,target_exe,status,total,sent,started_at,message,remaining_items,restored) VALUES ('pj1','g1','','','completed',1,1,?1,'','[]',0)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO workspace_snapshots (id,task_id,name,note,source,item_count,created_at,updated_at) VALUES ('w1','t1','现场','','manual',1,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO workspace_snapshot_items (id,snapshot_id,display_order,item_kind,display_name,app_key,exe_path,launch_args,working_dir,app_user_model_id,url,path,agent_source_id,agent_session_id,window_title_hint,window_class,window_title,restore_note,last_result,last_verification)
                 VALUES ('wi1','w1',0,'file','文件','','','','','','','C:/tmp/a.txt','','','','','','','','')",
                [],
            )?;
            c.execute(
                "INSERT INTO action_acks (event_id,acked_at) VALUES ('ev-1',?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_snapshot_links (id,snapshot_id,target_type,target_id,created_at) VALUES ('csl1','w1','item','i1',?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn full_bundle_packages_and_restores_clipboard_assets_and_modules() {
        let dir = temp_dir("clipboard-full");
        let root = dir.join("clipboard");
        let db = memdb();
        seed_clipboard(&db, &root);
        let target = dir.join("full.json");
        let written = write_bundle(
            &db,
            BackupSources {
                archive_dir: None,
                clipboard_dir: Some(&root),
            },
            &target,
            BackupKind::Full,
        )
        .unwrap();
        assert_eq!(written.counts["clipboard_items"], 1);
        assert_eq!(written.counts["assets"], 2);
        let read = read_bundle(&target, &dir.join("staging")).unwrap();
        assert_eq!(read.assets.len(), 2);
        assert!(read.extended);
        assert_eq!(spilled_rows(&read, "workspace_snapshots")[0]["id"], "w1");
        assert_eq!(spilled_rows(&read, "action_acks")[0]["event_id"], "ev-1");
        assert_eq!(
            spilled_rows(&read, "clipboard_group_items")[0]["item_id"],
            "i1"
        );
        let dst = memdb();
        import_read(&dst, &read).unwrap();
        let restored_root = dir.join("clipboard-restored");
        assert_eq!(commit_assets(&read.assets, &restored_root).unwrap(), 2);
        assert_eq!(
            std::fs::read(restored_root.join("images/i1.png")).unwrap(),
            b"\x89PNG\r\n\x1a\nimage-bytes-12345"
        );
        let count: i64 = dst
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM clipboard_items", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(count, 1);
        let link_task: String = dst
            .with_conn(|c| {
                c.query_row(
                    "SELECT task_id FROM clipboard_task_links WHERE id='cl1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(link_task, "t1");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn full_bundle_fails_when_referenced_asset_is_missing() {
        let dir = temp_dir("clipboard-missing");
        let root = dir.join("clipboard");
        let db = memdb();
        seed_clipboard(&db, &root);
        std::fs::remove_file(root.join("thumbs/i1.png")).unwrap();
        let target = dir.join("full.json");
        let err = write_bundle(
            &db,
            BackupSources {
                archive_dir: None,
                clipboard_dir: Some(&root),
            },
            &target,
            BackupKind::Full,
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("剪贴板资产缺失"),
            "实际错误: {}",
            err
        );
        assert!(!target.exists(), "失败不得留下不完整备份");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tampered_asset_is_rejected_even_with_recomputed_integrity() {
        let dir = temp_dir("asset-tamper");
        let root = dir.join("clipboard");
        let db = memdb();
        seed_clipboard(&db, &root);
        let target = dir.join("full.json");
        write_bundle(
            &db,
            BackupSources {
                archive_dir: None,
                clipboard_dir: Some(&root),
            },
            &target,
            BackupKind::Full,
        )
        .unwrap();
        let bad = dir.join("bad.json");
        rewrite_lines(&target, &bad, |lines| {
            for line in lines.iter_mut() {
                if line.get("record").and_then(|v| v.as_str()) == Some("asset")
                    && line.get("path").and_then(|v| v.as_str()) == Some("images/i1.png")
                {
                    line["data"] = json!("AAAA");
                    break;
                }
            }
        });
        let err = read_bundle(&bad, &dir.join("staging")).unwrap_err();
        assert!(
            err.to_string().contains("剪贴板资产") && err.to_string().contains("校验"),
            "实际错误: {}",
            err
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn legacy_restore_preserves_clipboard_and_workspace_modules() {
        let db = memdb();
        let root = temp_dir("legacy-preserve");
        seed_clipboard(&db, &root);
        // 旧版 JSON：只有任务/Agent 等旧表，没有扩展模块键
        let data = json!({
            "app": "task-dock",
            "version": 5,
            "exported_at": now_iso(),
            "tasks": [{
                "id": "t1", "title": "任务-新", "description": "", "priority": 2,
                "status": "pending", "category": "", "tags": "[]", "due_at": null,
                "remind_at": null, "advance_minutes": 0, "recurrence_rule_id": null,
                "created_at": now_iso(), "updated_at": now_iso(), "completed_at": null
            }],
            "recurrence_rules": [], "task_reminders": [], "task_agent_links": [],
            "task_categories": [], "agent_sources": [], "agent_instances": [],
            "agent_sessions": [], "agent_runs": [], "agent_events": [],
            "notification_history": [], "navigation_targets": [],
            "task_navigation_targets": [], "navigation_log": [], "settings": {}
        });
        data::import_value(&db, &data).unwrap();
        let (items, links, snapshots, ws_task): (i64, i64, i64, Option<String>) = db
            .with_conn(|c| {
                Ok((
                    c.query_row("SELECT COUNT(*) FROM clipboard_items", [], |r| r.get(0))?,
                    c.query_row("SELECT COUNT(*) FROM clipboard_task_links", [], |r| {
                        r.get(0)
                    })?,
                    c.query_row("SELECT COUNT(*) FROM workspace_snapshots", [], |r| r.get(0))?,
                    c.query_row(
                        "SELECT task_id FROM workspace_snapshots WHERE id='w1'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(items, 1, "旧备份恢复不得删除剪贴板历史");
        assert_eq!(links, 1, "任务仍存在时关联必须恢复");
        assert_eq!(snapshots, 1, "旧备份恢复不得删除工作现场");
        assert_eq!(ws_task.as_deref(), Some("t1"), "工作现场任务关联必须恢复");
        let title: String = db
            .with_conn(|c| {
                c.query_row("SELECT title FROM tasks WHERE id='t1'", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(title, "任务-新");
        std::fs::remove_dir_all(root).ok();
    }

    // ── 大规模端到端验收 ──────────────────────────────────────────────
    // 100k 事件 / 10k 通知 / 5k 剪贴板条目 / 250 张真实 PNG（500 个资产）/ 100 个工作现场/
    // 真实归档与完整设置；备份后通过 restore_bundle 做一次完整恢复并逐项比对。
    // 手动运行（建议 Release，测量才有意义）：
    //   cargo test --release --lib commands::backup::tests::full_backup_100k_events_10k_notifications_roundtrip -- --ignored --nocapture
    const SCALE_SOURCE: &str = "scale-agent";
    const SCALE_EVENTS: i64 = 100_000;
    const SCALE_NOTIFICATIONS: i64 = 10_000;
    const SCALE_CLIP_ITEMS: i64 = 5_000;
    const SCALE_IMAGES: usize = 250;
    const SCALE_WORKSPACES: i64 = 100;
    const SCALE_SECRET: &str = "SCALE-SECRET-TOKEN-DO-NOT-EXPORT-7f3a";
    const TARGET_LOCAL_TOKEN: &str = "TARGET-LOCAL-TOKEN-KEEP-ME";

    struct ScaleSeed {
        image_rels: Vec<String>,
        archive_names: Vec<String>,
        settings: Vec<(String, serde_json::Value)>,
    }

    fn seed_full_scale(db: &Db, clipboard_root: &Path, archive_root: &Path) -> ScaleSeed {
        std::fs::create_dir_all(clipboard_root.join("images")).unwrap();
        std::fs::create_dir_all(clipboard_root.join("thumbs")).unwrap();
        std::fs::create_dir_all(archive_root).unwrap();

        let mut image_rels = Vec::with_capacity(SCALE_IMAGES * 2);
        for i in 0..SCALE_IMAGES {
            let mut rgba = vec![0u8; 96 * 96 * 4];
            for (px, px4) in rgba.chunks_exact_mut(4).enumerate() {
                let x = (px % 96) as u8;
                let y = (px / 96) as u8;
                px4[0] = x.wrapping_mul(3).wrapping_add(i as u8);
                px4[1] = y.wrapping_mul(5).wrapping_add((i * 2) as u8);
                px4[2] = x ^ y;
                px4[3] = 255;
            }
            let png = crate::clipboard::image::encode_png(&rgba, 96, 96).unwrap();
            let img_rel = format!("images/img-{i:03}.png");
            std::fs::write(clipboard_root.join(&img_rel), &png).unwrap();

            let mut thumb_rgba = vec![0u8; 32 * 32 * 4];
            for (px, px4) in thumb_rgba.chunks_exact_mut(4).enumerate() {
                let x = (px % 32) as u8;
                let y = (px / 32) as u8;
                px4[0] = x.wrapping_add(i as u8);
                px4[1] = y;
                px4[2] = (x ^ y).wrapping_add(1);
                px4[3] = 255;
            }
            let thumb = crate::clipboard::image::encode_png(&thumb_rgba, 32, 32).unwrap();
            let thumb_rel = format!("thumbs/img-{i:03}.png");
            std::fs::write(clipboard_root.join(&thumb_rel), &thumb).unwrap();

            image_rels.push(img_rel);
            image_rels.push(thumb_rel);
        }

        let mut archive_names = Vec::new();
        for (a, day) in [(0usize, 29u32), (1usize, 28u32)] {
            let name = format!("events-2026-10-{day:02}.jsonl");
            let file = File::create(archive_root.join(&name)).unwrap();
            let mut out = BufWriter::new(file);
            for i in 0..40_000 {
                writeln!(
                    out,
                    "{{\"id\":\"arch-{a}-{i}\",\"state\":\"completed\",\"seq\":{i}}}"
                )
                .unwrap();
            }
            out.flush().unwrap();
            archive_names.push(name);
        }

        let settings: Vec<(String, serde_json::Value)> = vec![
            ("theme", json!("dark")),
            ("mode", json!("compact")),
            ("material", json!("solid")),
            ("auto_backup", json!(false)),
            ("backup_retain_days", json!(30)),
            ("clipboard_enabled", json!(true)),
            ("clipboard_retention_days", json!(90)),
            ("clipboard_max_items", json!(5_000)),
            ("clipboard_max_storage_mb", json!(1_024)),
            ("workspace_enabled", json!(true)),
            ("actions_enabled", json!(true)),
            ("notify_agent", json!(false)),
            ("http_port", json!(47_654)),
            ("nav_prefer_focus", json!(false)),
            (
                "window_rect",
                json!({"x": 10, "y": 20, "width": 1280, "height": 800}),
            ),
            ("snap_state", json!({"edge": "right", "offset": 12})),
            ("nav_window_memory", json!({"nav-000": {"x": 1, "y": 2}})),
            ("autostart", json!(true)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();

        db.with_conn(|c| {
            let now = now_iso();
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO agent_sources (id,display_name,kind,enabled,verified,transport_verified,homepage,note,config,adapter,icon,hidden,last_event_at,created_at,updated_at)
                 VALUES (?1,?2,'transport',1,1,1,'','','{}','scale','',0,?3,?3,?3)",
                rusqlite::params![SCALE_SOURCE, "Scale Agent", now],
            )?;
            tx.execute(
                "INSERT INTO agent_instances (id,source_id,instance_key,display_name,exe_path,first_seen_at,last_seen_at,meta)
                 VALUES ('scale-inst',?1,'inst-key','Scale Instance','',?2,?2,'{}')",
                rusqlite::params![SCALE_SOURCE, now],
            )?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO agent_sessions (id,source_id,external_id,title,status,first_seen_at,last_seen_at,last_run_id,instance_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?6,NULL,'scale-inst')",
                )?;
                for i in 0..10i64 {
                    stmt.execute(rusqlite::params![
                        format!("s-{i}"),
                        SCALE_SOURCE,
                        format!("ext-s-{i}"),
                        format!("规模会话 {i}"),
                        if i == 0 { "running" } else { "idle" },
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO agent_runs (id,session_id,source_id,external_run_id,task_title,status,started_at,updated_at,ended_at,pending_items,meta,instance_id,parent_run_id,last_ingest_seq,last_event_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?7,NULL,'[]','{}','scale-inst',NULL,?8,?7)",
                )?;
                for i in 0..100i64 {
                    stmt.execute(rusqlite::params![
                        format!("r-{i:03}"),
                        format!("s-{}", i % 10),
                        SCALE_SOURCE,
                        format!("ext-r-{i:03}"),
                        format!("规模轮次 {i}"),
                        if i == 99 { "running" } else { "completed" },
                        now,
                        (i + 1) * 1_000,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO agent_events (id,source_id,session_external_id,run_external_id,event_type,state,message,received_at,schema_version,event_id,instance_id,parent_run_id,occurred_at,transport,evidence_type,confidence,dedupe_key,ingest_seq)
                     VALUES (?1,'scale-agent',?2,?3,'status',?4,'progress',?5,2,?1,'scale-inst',NULL,?5,'http','observed',1.0,?1,?6)",
                )?;
                for i in 0..SCALE_EVENTS {
                    let seq = i + 1;
                    stmt.execute(rusqlite::params![
                        format!("ev-{i:06}"),
                        format!("ext-s-{}", i % 10),
                        format!("ext-r-{:03}", i % 100),
                        if seq % 3 == 0 { "completed" } else { "running" },
                        now,
                        seq,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO notification_history (id,kind,title,body,ref_type,ref_id,occurrence,is_read,created_at)
                     VALUES (?1,'scale','规模验收通知','',NULL,NULL,NULL,?2,?3)",
                )?;
                for i in 0..SCALE_NOTIFICATIONS {
                    stmt.execute(rusqlite::params![format!("nt-{i:05}"), i % 2, now])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO task_categories (id,name,color,sort_order,created_at)
                     VALUES (?1,?2,'#6366f1',?3,?4)",
                )?;
                for i in 0..10 {
                    stmt.execute(rusqlite::params![
                        format!("cat-{i}"),
                        format!("分类 {i}"),
                        i,
                        now
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO recurrence_rules (id,freq,interval,by_weekday,by_monthday,until,anchor,created_at)
                     VALUES (?1,'daily',1,'[]',NULL,NULL,'',?2)",
                )?;
                for i in 0..10 {
                    stmt.execute(rusqlite::params![format!("rr-{i}"), now])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO tasks (id,title,description,priority,status,category,tags,due_at,remind_at,advance_minutes,recurrence_rule_id,created_at,updated_at,completed_at)
                     VALUES (?1,?2,'',?3,?4,?5,'[]',?6,NULL,0,?7,?8,?8,?9)",
                )?;
                for i in 0..1_000i64 {
                    let completed = i % 10 == 0;
                    stmt.execute(rusqlite::params![
                        format!("t-{i:04}"),
                        format!("规模任务 {i}"),
                        i % 4,
                        if completed { "completed" } else { "pending" },
                        format!("cat-{}", i % 10),
                        format!("2026-11-{:02}T09:00:00+00:00", (i % 28) + 1),
                        format!("rr-{}", i % 10),
                        now,
                        if completed { Some(now.clone()) } else { None },
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO task_reminders (id,task_id,remind_at,occurrence,kind,fired,fired_at)
                     VALUES (?1,?2,?3,?4,'due',?5,?6)",
                )?;
                for i in 0..200i64 {
                    stmt.execute(rusqlite::params![
                        format!("rem-{i:03}"),
                        format!("t-{i:04}"),
                        format!("2026-11-{:02}T10:00:00+00:00", (i % 28) + 1),
                        format!("occ-{i}"),
                        i % 2,
                        if i % 2 == 0 { Some(now.clone()) } else { None },
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO task_agent_links (id,task_id,source_id,session_external_id,run_external_id,created_at,origin)
                     VALUES (?1,?2,'scale-agent',?3,?4,?5,'user')",
                )?;
                for i in 0..100i64 {
                    stmt.execute(rusqlite::params![
                        format!("tal-{i:03}"),
                        format!("t-{i:04}"),
                        format!("ext-s-{}", i % 10),
                        format!("ext-r-{i:03}"),
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO navigation_targets (id,display_name,target_type,app_key,exe_path,launch_args,working_dir,app_user_model_id,url,path,agent_source_id,agent_session_id,window_title_hint,icon,category,favorite,hidden,last_used_at,use_count,created_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,'','','',?6,?7,?8,?9,'','','',0,0,?10,0,?10,?10)",
                )?;
                for i in 0..100i64 {
                    let (kind, app_key, exe, url, path, src, sess) = match i % 5 {
                        0 => (
                            "url",
                            format!("https://example.com/{i}"),
                            String::new(),
                            format!("https://example.com/{i}"),
                            String::new(),
                            String::new(),
                            String::new(),
                        ),
                        1 => (
                            "file",
                            format!("c:/scale/file-{i}.txt"),
                            String::new(),
                            String::new(),
                            format!("C:/scale/file-{i}.txt"),
                            String::new(),
                            String::new(),
                        ),
                        2 => (
                            "directory",
                            format!("c:/scale/dir-{i}"),
                            String::new(),
                            String::new(),
                            format!("C:/scale/dir-{i}"),
                            String::new(),
                            String::new(),
                        ),
                        3 => (
                            "application",
                            format!("c:/apps/app-{i}.exe"),
                            format!("C:/Apps/app-{i}.exe"),
                            String::new(),
                            String::new(),
                            String::new(),
                            String::new(),
                        ),
                        _ => (
                            "agent_session",
                            format!("scale-agent/ext-s-{}", i % 10),
                            String::new(),
                            String::new(),
                            String::new(),
                            SCALE_SOURCE.to_string(),
                            format!("ext-s-{}", i % 10),
                        ),
                    };
                    stmt.execute(rusqlite::params![
                        format!("nav-{i:03}"),
                        format!("目标 {i}"),
                        kind,
                        app_key,
                        exe,
                        url,
                        path,
                        src,
                        sess,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO task_navigation_targets (id,task_id,target_id,display_order,is_default,launch_behavior,created_at,window_identity,window_fallback)
                     VALUES (?1,?2,?3,0,?4,'default',?5,NULL,'reselect')",
                )?;
                for i in 0..100i64 {
                    stmt.execute(rusqlite::params![
                        format!("tnt-{i:03}"),
                        format!("t-{:04}", i + 100),
                        format!("nav-{i:03}"),
                        (i == 0) as i64,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO navigation_log (id,target_id,target_name,requested_action,actual_action,success,fallback_used,reason,verification_level,created_at)
                     VALUES (?1,?2,?3,'launch','launch',1,0,'','observed',?4)",
                )?;
                for i in 0..500i64 {
                    stmt.execute(rusqlite::params![
                        format!("nl-{i:04}"),
                        format!("nav-{:03}", i % 100),
                        format!("目标 {}", i % 100),
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_items (id,kind,text,html,preview,content_hash,byte_size,source_app,source_title,image_width,image_height,file_paths,favorite,pinned,copy_count,created_at,last_seen_at)
                     VALUES (?1,?2,?3,'',?4,?5,?6,'scale','Scale App',?7,?8,'[]',?9,?10,1,?11,?11)",
                )?;
                for i in 0..SCALE_CLIP_ITEMS {
                    let image = (i as usize) < SCALE_IMAGES;
                    let (kind, text, preview, width, height, byte_size) = if image {
                        let idx = i as usize;
                        let size = std::fs::metadata(
                            clipboard_root.join(format!("images/img-{idx:03}.png")),
                        )
                        .unwrap()
                        .len() as i64;
                        (
                            "image",
                            String::new(),
                            format!("[image {idx}]"),
                            Some(96i64),
                            Some(96i64),
                            size,
                        )
                    } else {
                        let text = format!(
                            "剪贴板文本 {i} 真实内容用于规模验收 {}",
                            "x".repeat(40)
                        );
                        let byte_size = text.len() as i64;
                        (
                            "text",
                            text.clone(),
                            text.chars().take(40).collect::<String>(),
                            None,
                            None,
                            byte_size,
                        )
                    };
                    stmt.execute(rusqlite::params![
                        format!("c-{i:04}"),
                        kind,
                        text,
                        preview,
                        format!("hash-{i:05}"),
                        byte_size,
                        width,
                        height,
                        (i % 100 == 0) as i64,
                        (i % 137 == 0) as i64,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                )?;
                for idx in 0..SCALE_IMAGES {
                    let item = format!("c-{idx:04}");
                    let img_rel = format!("images/img-{idx:03}.png");
                    let thumb_rel = format!("thumbs/img-{idx:03}.png");
                    let img_size = std::fs::metadata(clipboard_root.join(&img_rel))
                        .unwrap()
                        .len() as i64;
                    let thumb_size = std::fs::metadata(clipboard_root.join(&thumb_rel))
                        .unwrap()
                        .len() as i64;
                    stmt.execute(rusqlite::params![
                        format!("ca-img-{idx:03}"),
                        &item,
                        "image",
                        &img_rel,
                        img_size,
                        96i64,
                        96i64,
                        now,
                    ])?;
                    stmt.execute(rusqlite::params![
                        format!("ca-thumb-{idx:03}"),
                        &item,
                        "thumb",
                        &thumb_rel,
                        thumb_size,
                        32i64,
                        32i64,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_groups (id,name,mode,status,favorite,pinned,created_at,updated_at,closed_at)
                     VALUES (?1,?2,'manual','closed',?3,0,?4,?4,?4)",
                )?;
                for i in 0..50i64 {
                    stmt.execute(rusqlite::params![
                        format!("g-{i:03}"),
                        format!("分组 {i}"),
                        (i % 5 == 0) as i64,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_group_items (group_id,item_id,position,origin,added_at)
                     VALUES (?1,?2,?3,'manual',?4)",
                )?;
                for i in 0..500i64 {
                    stmt.execute(rusqlite::params![
                        format!("g-{:03}", i / 10),
                        format!("c-{i:04}"),
                        i % 10,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_task_links (id,task_id,target_type,target_id,created_at)
                     VALUES (?1,?2,?3,?4,?5)",
                )?;
                for i in 0..100i64 {
                    let (target_type, target_id) = if i < 50 {
                        ("group", format!("g-{i:03}"))
                    } else {
                        ("item", format!("c-{:04}", i - 50))
                    };
                    stmt.execute(rusqlite::params![
                        format!("ctl-{i:03}"),
                        format!("t-{:04}", i + 200),
                        target_type,
                        target_id,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_paste_jobs (id,group_id,target_title,target_exe,status,total,sent,started_at,ended_at,message,remaining_items,restored)
                     VALUES (?1,?2,'目标窗口','target.exe','done',4,4,?3,?3,'','[]',0)",
                )?;
                for i in 0..100i64 {
                    stmt.execute(rusqlite::params![
                        format!("pj-{i:03}"),
                        format!("g-{:03}", i % 50),
                        now,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO workspace_snapshots (id,task_id,name,note,source,item_count,created_at,updated_at,last_restored_at,restore_count)
                     VALUES (?1,?2,?3,'','task',4,?4,?4,?4,?5)",
                )?;
                for i in 0..SCALE_WORKSPACES {
                    stmt.execute(rusqlite::params![
                        format!("ws-{i:03}"),
                        format!("t-{:04}", i + 300),
                        format!("工作现场 {i}"),
                        now,
                        i,
                    ])?;
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO workspace_snapshot_items (id,snapshot_id,display_order,item_kind,display_name,target_id,app_key,exe_path,launch_args,working_dir,app_user_model_id,url,path,agent_source_id,agent_session_id,window_title_hint,window_class,window_title,restore_note,last_result,last_verification,last_restored_at)
                     VALUES (?1,?2,?3,?4,?5,?6,'','','','','',?7,?8,'','','','','','','','observed',?9)",
                )?;
                for i in 0..SCALE_WORKSPACES {
                    for j in 0..4i64 {
                        let nav = format!("nav-{:03}", (i * 4 + j) % 100);
                        let (kind, url, path) = match j {
                            0 => ("application", String::new(), String::new()),
                            1 => ("url", format!("https://example.com/ws/{i}/{j}"), String::new()),
                            2 => (
                                "file",
                                String::new(),
                                format!("C:/scale/ws/{i}/file-{j}.txt"),
                            ),
                            _ => ("directory", String::new(), format!("C:/scale/ws/{i}/dir-{j}")),
                        };
                        stmt.execute(rusqlite::params![
                            format!("wsi-{i:03}-{j}"),
                            format!("ws-{i:03}"),
                            j,
                            kind,
                            format!("现场项 {i}-{j}"),
                            nav,
                            url,
                            path,
                            now,
                        ])?;
                    }
                }
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO clipboard_snapshot_links (id,snapshot_id,target_type,target_id,created_at)
                     VALUES (?1,?2,?3,?4,?5)",
                )?;
                for i in 0..100i64 {
                    let (target_type, target_id) = if i < 50 {
                        ("item", format!("c-{i:04}"))
                    } else {
                        ("group", format!("g-{:03}", i - 50))
                    };
                    stmt.execute(rusqlite::params![
                        format!("csl-{i:03}"),
                        format!("ws-{i:03}"),
                        target_type,
                        target_id,
                        now,
                    ])?;
                }
            }
            {
                let mut stmt =
                    tx.prepare("INSERT INTO action_acks (event_id,acked_at) VALUES (?1,?2)")?;
                // 不与 agent_events 的 ev-* 撞 ID：导入后的 origin 回填会把事件级
                // ack 展开成 run: 级 ack，撞 ID 会让「恢复后行数一致」断言失真。
                for i in 0..500i64 {
                    stmt.execute(rusqlite::params![format!("ack-{i:06}"), now])?;
                }
            }
            for (k, v) in &settings {
                tx.execute(
                    "INSERT INTO application_settings (key,value,updated_at) VALUES (?1,?2,?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    rusqlite::params![k, serde_json::to_string(v).expect("设置序列化"), now],
                )?;
            }
            tx.execute(
                "INSERT INTO application_settings (key,value,updated_at) VALUES ('http_token',?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                rusqlite::params![format!("\"{}\"", SCALE_SECRET), now],
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        ScaleSeed {
            image_rels,
            archive_names,
            settings,
        }
    }

    fn seed_restore_target(db: &Db, clipboard_root: &Path) {
        std::fs::create_dir_all(clipboard_root.join("images")).unwrap();
        // 无资产表引用的旧文件：恢复提交时必须被同路径的新资产原子替换
        std::fs::write(clipboard_root.join("images/img-000.png"), b"STALE-IMAGE").unwrap();
        db.with_conn(|c| {
            let now = now_iso();
            c.execute(
                "INSERT INTO tasks (id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at)
                 VALUES ('orig-task','原始任务','',2,'pending','','[]',0,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_items (id,kind,text,html,preview,content_hash,byte_size,source_app,source_title,file_paths,created_at,last_seen_at)
                 VALUES ('target-item','text','本机旧内容','','旧内容','target-hash',12,'','','[]',?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO application_settings (key,value,updated_at) VALUES ('http_token',?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                rusqlite::params![format!("\"{}\"", TARGET_LOCAL_TOKEN), now],
            )?;
            c.execute(
                "INSERT INTO application_settings (key,value,updated_at) VALUES ('theme','\"light\"',?1)
                 ON CONFLICT(key) DO UPDATE SET value = '\"light\"', updated_at = excluded.updated_at",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[derive(Default, Serialize, Clone)]
    struct LatencyStats {
        n: usize,
        p50_us: u64,
        p95_us: u64,
        p99_us: u64,
        max_us: u64,
        errors: usize,
    }

    struct MonitorOutput {
        stats: LatencyStats,
        max_ws: usize,
    }

    struct MonitorHandle {
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<MonitorOutput>>,
    }

    fn percentile(sorted: &[u64], p: f64) -> u64 {
        if sorted.is_empty() {
            return 0;
        }
        let idx = (((sorted.len() - 1) as f64) * p).round() as usize;
        sorted[idx.min(sorted.len() - 1)]
    }

    fn mem_snapshot() -> (usize, usize) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
            };
            use windows_sys::Win32::System::Threading::GetCurrentProcess;
            let mut counters = PROCESS_MEMORY_COUNTERS {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                ..Default::default()
            };
            if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0 {
                return (counters.WorkingSetSize, counters.PeakWorkingSetSize);
            }
            (0, 0)
        }
        #[cfg(not(windows))]
        {
            (0, 0)
        }
    }

    impl MonitorHandle {
        fn start(db: Arc<Db>) -> Self {
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let handle = std::thread::spawn(move || {
                let baseline_ws = mem_snapshot().0;
                let mut max_ws = baseline_ws;
                let mut samples: Vec<u64> = Vec::new();
                let mut errors = 0usize;
                while !flag.load(AtomicOrdering::Relaxed) {
                    let (ws, _) = mem_snapshot();
                    max_ws = max_ws.max(ws);
                    let started = Instant::now();
                    let query = db.with_read(|c| {
                        c.query_row(
                            "SELECT COUNT(*) FROM tasks WHERE status='pending'",
                            [],
                            |r| r.get::<_, i64>(0),
                        )
                        .map_err(AppError::from)
                    });
                    match query {
                        Ok(_) => samples.push(started.elapsed().as_micros() as u64),
                        Err(_) => errors += 1,
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let mut stats = LatencyStats {
                    n: samples.len(),
                    errors,
                    ..Default::default()
                };
                if !samples.is_empty() {
                    samples.sort_unstable();
                    stats.p50_us = percentile(&samples, 0.50);
                    stats.p95_us = percentile(&samples, 0.95);
                    stats.p99_us = percentile(&samples, 0.99);
                    stats.max_us = *samples.last().unwrap();
                }
                MonitorOutput { stats, max_ws }
            });
            Self {
                stop,
                handle: Some(handle),
            }
        }

        fn stop(mut self) -> MonitorOutput {
            self.stop.store(true, AtomicOrdering::Relaxed);
            self.handle.take().unwrap().join().unwrap()
        }
    }

    fn query_i64(db: &Db, sql: &str) -> i64 {
        db.with_read(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
            .unwrap()
    }

    fn expect_str0(db: &Db, sql: &str) -> String {
        db.with_read(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
            .unwrap()
    }

    fn expect_str1(db: &Db, sql: &str, p: &str) -> String {
        db.with_read(|c| c.query_row(sql, [p], |r| r.get(0)).map_err(AppError::from))
            .unwrap()
    }

    fn query_setting(db: &Db, key: &str) -> Option<serde_json::Value> {
        db.with_read(|c| {
            Ok(c.query_row(
                "SELECT value FROM application_settings WHERE key = ?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok()))
        })
        .unwrap()
    }

    fn file_contains_line(path: &Path, needle: &str) -> bool {
        let file = File::open(path).expect("打开备份文件");
        BufReader::new(file)
            .lines()
            .any(|line| line.map(|l| l.contains(needle)).unwrap_or(false))
    }

    #[ignore = "十万级事件真实备份/恢复验收，手动运行（建议 --release）"]
    #[test]
    fn full_backup_100k_events_10k_notifications_roundtrip() {
        let src_root = temp_dir("scale-src");
        let dst_root = temp_dir("scale-dst");
        let src_clip = src_root.join("clipboard");
        let src_archive = src_root.join("archive");
        let dst_clip = dst_root.join("clipboard");

        let src_db = Arc::new(Db::open(&src_root.join("taskdock.db")).unwrap());
        let started = Instant::now();
        let seed = seed_full_scale(src_db.as_ref(), &src_clip, &src_archive);
        let seed_ms = started.elapsed().as_millis();
        let source_counts = src_db.with_read(table_counts).unwrap();
        let source_db_bytes = std::fs::metadata(src_root.join("taskdock.db"))
            .map(|m| m.len())
            .unwrap_or(0);

        let dst_db = Arc::new(Db::open(&dst_root.join("taskdock.db")).unwrap());
        seed_restore_target(dst_db.as_ref(), &dst_clip);

        let bundle = src_root.join("full-scale.json");
        let mem_baseline = mem_snapshot();
        let mon = MonitorHandle::start(src_db.clone());
        let started = Instant::now();
        let written = write_bundle(
            src_db.as_ref(),
            BackupSources {
                archive_dir: Some(&src_archive),
                clipboard_dir: Some(&src_clip),
            },
            &bundle,
            BackupKind::Full,
        )
        .unwrap();
        let backup_ms = started.elapsed().as_millis();
        let monitor_backup = mon.stop();
        let mem_after_backup = mem_snapshot();

        assert_eq!(written.kind, "full");
        assert!(!written.partial);
        assert_eq!(written.counts["agent_events"].as_i64(), Some(SCALE_EVENTS));
        assert_eq!(
            written.counts["notification_history"].as_i64(),
            Some(SCALE_NOTIFICATIONS)
        );
        assert_eq!(
            written.counts["clipboard_items"].as_i64(),
            Some(SCALE_CLIP_ITEMS)
        );
        assert_eq!(
            written.counts["clipboard_assets"].as_i64(),
            Some((SCALE_IMAGES * 2) as i64)
        );
        assert_eq!(
            written.counts["workspace_snapshots"].as_i64(),
            Some(SCALE_WORKSPACES)
        );
        assert_eq!(
            written.counts["workspace_snapshot_items"].as_i64(),
            Some(SCALE_WORKSPACES * 4)
        );
        assert_eq!(written.counts["action_acks"].as_i64(), Some(500));
        assert_eq!(
            written.counts["clipboard_snapshot_links"].as_i64(),
            Some(100)
        );
        assert_eq!(
            written.counts["assets"].as_i64(),
            Some((SCALE_IMAGES * 2) as i64)
        );
        assert_eq!(written.counts["archives"].as_i64(), Some(2));
        assert!(
            written.bytes > 20 * 1024 * 1024,
            "十万事件完整备份不应只有 {} 字节",
            written.bytes
        );
        assert!(
            !file_contains_line(&bundle, SCALE_SECRET),
            "http_token 等本机安全项绝不能被导出"
        );
        assert!(
            file_contains_line(&bundle, "window_rect") && file_contains_line(&bundle, "autostart"),
            "窗口/自启动等设备相关设置必须进入备份"
        );
        drop(src_db);

        let mem_before_restore = mem_snapshot();
        let mon = MonitorHandle::start(dst_db.clone());
        let started = Instant::now();
        let outcome = restore_bundle(
            &dst_root,
            dst_db.as_ref(),
            &bundle,
            &RestoreOptions::default(),
        )
        .unwrap();
        let restore_ms = started.elapsed().as_millis();
        let monitor_restore = mon.stop();
        let mem_after_restore = mem_snapshot();

        assert_eq!(outcome.state, RestoreState::Completed);
        assert_eq!(outcome.backup_kind, "full");
        assert!(!outcome.partial);
        assert!(!outcome.extended_preserved);
        assert_eq!(outcome.assets, SCALE_IMAGES * 2);
        assert_eq!(outcome.archives, 2);
        let pre_backup = outcome.pre_backup.clone().expect("必须生成恢复点");
        assert!(Path::new(&pre_backup).exists(), "恢复点必须保留");
        let pre_meta = bundle_meta(Path::new(&pre_backup)).expect("恢复点必须是合法分块备份");
        assert_eq!(pre_meta["kind"], "full");
        assert_eq!(
            pre_meta["counts"]["tasks"], 1,
            "恢复点必须包含被替换前的数据"
        );
        assert!(
            !dst_root.join("restore").exists(),
            "恢复完成后必须清理恢复日志与会话目录"
        );

        let dst_counts = dst_db.with_read(table_counts).unwrap();
        assert_eq!(dst_counts.len(), source_counts.len());
        for (table, expect) in &source_counts {
            assert_eq!(
                dst_counts.get(table).copied().unwrap_or(-1),
                *expect,
                "表 {table} 恢复后行数不一致"
            );
        }
        assert_eq!(
            query_i64(&dst_db, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
            0,
            "恢复后存在外键引用不一致"
        );
        assert_eq!(expect_str0(&dst_db, "PRAGMA integrity_check"), "ok");
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COALESCE(MAX(ingest_seq), 0) FROM agent_events"
            ),
            SCALE_EVENTS,
            "事件受理水位必须在恢复后保持"
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COALESCE(MAX(last_ingest_seq), 0) FROM agent_runs"
            ),
            SCALE_EVENTS,
            "轮次水位必须在恢复后保持"
        );
        assert_eq!(
            query_i64(&dst_db, "SELECT COUNT(*) FROM tasks WHERE id = 'orig-task'"),
            0,
            "完整恢复必须整体替换旧任务"
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COUNT(*) FROM clipboard_items WHERE id = 'target-item'"
            ),
            0,
            "完整恢复必须整体替换旧剪贴板数据"
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT category FROM tasks WHERE id = ?1",
                "t-0000"
            ),
            "cat-0"
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT recurrence_rule_id FROM tasks WHERE id = ?1",
                "t-0000"
            ),
            "rr-0"
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT task_id FROM task_reminders WHERE id = ?1",
                "rem-000"
            ),
            "t-0000"
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT task_id FROM task_agent_links WHERE id = ?1",
                "tal-000"
            ),
            "t-0000"
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT task_id || '|' || target_id FROM task_navigation_targets WHERE id = ?1",
                "tnt-000"
            ),
            "t-0100|nav-000"
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COUNT(*) FROM clipboard_assets WHERE item_id = 'c-0000'"
            ),
            2
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COUNT(*) FROM clipboard_group_items WHERE group_id = 'g-000'"
            ),
            10
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT task_id || '|' || target_id FROM clipboard_task_links WHERE id = ?1",
                "ctl-000"
            ),
            "t-0200|g-000"
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT task_id FROM workspace_snapshots WHERE id = ?1",
                "ws-000"
            ),
            "t-0300"
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COUNT(*) FROM workspace_snapshot_items WHERE snapshot_id = 'ws-000'"
            ),
            4
        );
        assert_eq!(
            expect_str1(
                &dst_db,
                "SELECT target_id FROM clipboard_snapshot_links WHERE id = ?1",
                "csl-000"
            ),
            "c-0000"
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COUNT(*) FROM action_acks WHERE event_id = 'ack-000499'"
            ),
            1
        );
        assert_eq!(
            query_i64(
                &dst_db,
                "SELECT COUNT(*) FROM notification_history WHERE id = 'nt-09999'"
            ),
            1
        );

        // 每个资产文件都要恢复为与来源逐字节一致（SHA-256 + 大小 + 数据库记录）。
        let mut asset_rows = 0usize;
        dst_db
            .with_read(|c| {
                let mut stmt =
                    c.prepare("SELECT path, byte_size FROM clipboard_assets ORDER BY path")?;
                let rows =
                    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
                for row in rows {
                    let (rel, size) = row?;
                    asset_rows += 1;
                    let (src_size, src_sha) = sha256_file(&src_clip.join(&rel))?;
                    let dst_file = dst_clip.join(&rel);
                    assert!(dst_file.exists(), "恢复后缺少剪贴板资产文件: {rel}");
                    let (dst_size, dst_sha) = sha256_file(&dst_file)?;
                    assert_eq!(src_size, dst_size, "资产 {rel} 大小不一致");
                    assert_eq!(src_sha, dst_sha, "资产 {rel} SHA-256 不一致");
                    assert_eq!(size as u64, dst_size, "资产 {rel} 数据库大小不一致");
                }
                Ok::<_, AppError>(())
            })
            .unwrap();
        assert_eq!(asset_rows, SCALE_IMAGES * 2);
        for rel in &seed.image_rels {
            let (_, src_sha) = sha256_file(&src_clip.join(rel)).unwrap();
            let (_, dst_sha) = sha256_file(&dst_clip.join(rel)).unwrap();
            assert_eq!(src_sha, dst_sha, "资产文件 {rel} 未完整恢复");
        }

        let dst_archive = crate::agents::retention::archive_dir(&dst_root);
        for name in &seed.archive_names {
            let (src_size, src_sha) = sha256_file(&src_archive.join(name)).unwrap();
            let (dst_size, dst_sha) = sha256_file(&dst_archive.join(name)).unwrap();
            assert_eq!(src_size, dst_size, "归档 {name} 大小不一致");
            assert_eq!(src_sha, dst_sha, "归档 {name} SHA-256 不一致");
        }

        for (k, v) in &seed.settings {
            let restored =
                query_setting(&dst_db, k).unwrap_or_else(|| panic!("恢复后缺少设置 {k}"));
            assert_eq!(&restored, v, "设置 {k} 未按备份恢复");
        }
        assert_eq!(
            query_setting(&dst_db, "http_token"),
            Some(json!(TARGET_LOCAL_TOKEN)),
            "目标库本机令牌绝不能被备份覆盖"
        );
        assert_eq!(query_setting(&dst_db, "theme"), Some(json!("dark")));
        assert!(
            query_setting(&dst_db, RESTORE_COMMIT_KEY).is_none(),
            "恢复完成后必须清理提交标记"
        );

        let dst_db_bytes = std::fs::metadata(dst_root.join("taskdock.db"))
            .map(|m| m.len())
            .unwrap_or(0)
            + std::fs::metadata(dst_root.join("taskdock.db-wal"))
                .map(|m| m.len())
                .unwrap_or(0);
        let peak_ws = mem_after_restore
            .1
            .max(monitor_backup.max_ws)
            .max(monitor_restore.max_ws);

        let mb = |bytes: usize| (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0;
        let evidence = json!({
            "test": "full_backup_100k_events_10k_notifications_roundtrip",
            "generated_at": now_iso(),
            "seed": {
                "ms": seed_ms,
                "events": SCALE_EVENTS,
                "notifications": SCALE_NOTIFICATIONS,
                "clipboard_items": SCALE_CLIP_ITEMS,
                "clipboard_image_items": SCALE_IMAGES,
                "clipboard_assets": SCALE_IMAGES * 2,
                "workspaces": SCALE_WORKSPACES,
                "tasks": 1_000,
            },
            "backup": {
                "ms": backup_ms,
                "bytes": written.bytes,
                "sha256": written.sha256,
                "counts": written.counts.clone(),
                "sqlite_read_latency_us": monitor_backup.stats.clone(),
                "observed_max_ws_bytes": monitor_backup.max_ws,
            },
            "restore": {
                "ms": restore_ms,
                "state": outcome.state.as_str(),
                "assets": outcome.assets,
                "archives": outcome.archives,
                "partial": outcome.partial,
                "backup_kind": outcome.backup_kind,
                "pre_backup": outcome.pre_backup.clone(),
                "sqlite_read_latency_us": monitor_restore.stats.clone(),
                "observed_max_ws_bytes": monitor_restore.max_ws,
            },
            "memory_mb": {
                "baseline": mb(mem_baseline.0),
                "after_backup": mb(mem_after_backup.0),
                "before_restore": mb(mem_before_restore.0),
                "after_restore": mb(mem_after_restore.0),
                "observed_peak": mb(peak_ws),
            },
            "sizes": {
                "source_db_bytes": source_db_bytes,
                "dst_db_bytes": dst_db_bytes,
                "bundle_bytes": written.bytes,
            },
        });
        let evidence_json = serde_json::to_string_pretty(&evidence).unwrap();
        let evidence_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("acceptance");
        std::fs::create_dir_all(&evidence_dir).unwrap();
        let evidence_path = evidence_dir.join("v05-scale-100k.json");
        std::fs::write(&evidence_path, &evidence_json).unwrap();

        eprintln!(
            "SCALE backup: bytes={} ms={} assets={} archives={} sha256={}",
            written.bytes, backup_ms, outcome.assets, outcome.archives, written.sha256
        );
        eprintln!(
            "SCALE restore: ms={} state={} pre_backup={}",
            restore_ms,
            outcome.state.as_str(),
            pre_backup
        );
        eprintln!(
            "SCALE memory_mb: baseline={} after_backup={} before_restore={} after_restore={} observed_peak={}",
            mb(mem_baseline.0),
            mb(mem_after_backup.0),
            mb(mem_before_restore.0),
            mb(mem_after_restore.0),
            mb(peak_ws)
        );
        eprintln!(
            "SCALE sqlite_latency_us backup: n={} p50={} p95={} p99={} max={} errors={}",
            monitor_backup.stats.n,
            monitor_backup.stats.p50_us,
            monitor_backup.stats.p95_us,
            monitor_backup.stats.p99_us,
            monitor_backup.stats.max_us,
            monitor_backup.stats.errors
        );
        eprintln!(
            "SCALE sqlite_latency_us restore: n={} p50={} p95={} p99={} max={} errors={}",
            monitor_restore.stats.n,
            monitor_restore.stats.p50_us,
            monitor_restore.stats.p95_us,
            monitor_restore.stats.p99_us,
            monitor_restore.stats.max_us,
            monitor_restore.stats.errors
        );
        eprintln!("SCALE_EVIDENCE_FILE {}", evidence_path.display());
        eprintln!(
            "SCALE_EVIDENCE {}",
            serde_json::to_string(&evidence).unwrap()
        );

        drop(dst_db);
        std::fs::remove_dir_all(&src_root).ok();
        std::fs::remove_dir_all(&dst_root).ok();
    }
}
