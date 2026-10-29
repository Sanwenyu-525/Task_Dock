//! 工作现场：把任务关联的应用/网址/文件/目录/Agent 会话存为快照，需要时按顺序恢复。
//!
//! 边界（对应需求「不采集隐私」）：
//! - 只保存窗口类名/标题/进程 exe、用户显式登记的路径与网址；不读窗口内容、不截图；
//! - 不持久化 HWND/PID（重启后无意义），恢复时按窗口身份重新匹配；
//! - 恢复动作全部走既有 `navigation` 路由器（重校验目标、如实返回验证级别）；
//! - 每项独立反馈，单项失败不阻断；「已发出启动请求」绝不标成「窗口已恢复」；
//! - 缺失文件 / 已卸载程序 / 已消失的 Agent 会话 → skipped 并给出原因。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::navigation::{
    self, router, target_resolver, window_manager, NavigationResult, VerificationLevel,
    ACTION_OPEN_APP, ACTION_OPEN_DIRECTORY, ACTION_OPEN_FILE, ACTION_OPEN_URL,
    ACTION_RESUME_SESSION,
};

pub const MAX_ITEMS_PER_SNAPSHOT: usize = 30;
pub const MAX_SNAPSHOTS: usize = 100;
const RESTORE_INTERVAL_MS: u64 = 350;

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotSummary {
    pub id: String,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub name: String,
    pub note: String,
    pub source: String,
    pub item_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_restored_at: Option<String>,
    pub restore_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotItem {
    pub id: String,
    pub snapshot_id: String,
    pub display_order: i64,
    pub item_kind: String,
    pub display_name: String,
    pub target_id: Option<String>,
    pub app_key: String,
    pub exe_path: String,
    pub launch_args: String,
    pub working_dir: String,
    pub app_user_model_id: String,
    pub url: String,
    pub path: String,
    pub agent_source_id: String,
    pub agent_session_id: String,
    pub window_title_hint: String,
    pub window_class: String,
    pub window_title: String,
    pub restore_note: String,
    pub last_result: String,
    pub last_verification: String,
    pub last_restored_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotDetail {
    #[serde(flatten)]
    pub summary: SnapshotSummary,
    pub items: Vec<SnapshotItem>,
}

/// 手动捕获条目（窗口捕获用 `window_hwnd`，后端按句柄重新读取身份，不信任前端标题）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SnapshotItemInput {
    pub item_kind: String,
    pub display_name: String,
    #[serde(default)]
    pub target_id: Option<String>,
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
    pub window_class: String,
    #[serde(default)]
    pub window_title: String,
    #[serde(default)]
    pub restore_note: String,
    /// 从当前窗口列表捕获时使用（仅内存，不落库）
    #[serde(default)]
    pub window_hwnd: Option<isize>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CaptureInput {
    #[serde(default)]
    pub task_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub source: Option<String>,
    /// 直接条目
    #[serde(default)]
    pub items: Vec<SnapshotItemInput>,
    /// 勾选的当前窗口句柄
    #[serde(default)]
    pub window_hwnds: Vec<isize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreItemResult {
    pub item_id: String,
    pub display_name: String,
    pub item_kind: String,
    pub outcome: String, // restored | skipped | failed | cancelled
    pub action: Option<String>,
    pub verification_level: String,
    pub fallback_used: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RestoreSummary {
    pub snapshot_id: String,
    pub total: usize,
    pub restored: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: usize,
    pub items: Vec<RestoreItemResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreStatus {
    pub running: bool,
    pub snapshot_id: Option<String>,
    pub cancel_requested: bool,
}

// ── 查询 ────────────────────────────────────────────────────

const SNAPSHOT_SELECT: &str =
    "SELECT s.id, s.task_id, t.title, s.name, s.note, s.source, s.item_count,
    s.created_at, s.updated_at, s.last_restored_at, s.restore_count
    FROM workspace_snapshots s LEFT JOIN tasks t ON t.id = s.task_id";

fn row_summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotSummary> {
    Ok(SnapshotSummary {
        id: r.get(0)?,
        task_id: r.get(1)?,
        task_title: r.get(2)?,
        name: r.get(3)?,
        note: r.get(4)?,
        source: r.get(5)?,
        item_count: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        last_restored_at: r.get(9)?,
        restore_count: r.get(10)?,
    })
}

pub fn list_snapshots(db: &Db, task_id: Option<&str>) -> AppResult<Vec<SnapshotSummary>> {
    db.with_read(|conn| {
        let mut out = Vec::new();
        match task_id {
            Some(id) => {
                let mut stmt = conn.prepare(&format!(
                    "{} WHERE s.task_id = ?1 ORDER BY s.updated_at DESC LIMIT 200",
                    SNAPSHOT_SELECT
                ))?;
                let rows = stmt.query_map(params![id], row_summary)?;
                for r in rows {
                    out.push(r?);
                }
            }
            None => {
                let mut stmt = conn.prepare(&format!(
                    "{} ORDER BY s.updated_at DESC LIMIT 200",
                    SNAPSHOT_SELECT
                ))?;
                let rows = stmt.query_map([], row_summary)?;
                for r in rows {
                    out.push(r?);
                }
            }
        }
        Ok(out)
    })
}

fn item_rows(conn: &rusqlite::Connection, snapshot_id: &str) -> AppResult<Vec<SnapshotItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, snapshot_id, display_order, item_kind, display_name, target_id, app_key,
            exe_path, launch_args, working_dir, app_user_model_id, url, path,
            agent_source_id, agent_session_id, window_title_hint, window_class, window_title,
            restore_note, last_result, last_verification, last_restored_at
         FROM workspace_snapshot_items WHERE snapshot_id = ?1 ORDER BY display_order, rowid",
    )?;
    let rows = stmt.query_map(params![snapshot_id], |r| {
        Ok(SnapshotItem {
            id: r.get(0)?,
            snapshot_id: r.get(1)?,
            display_order: r.get(2)?,
            item_kind: r.get(3)?,
            display_name: r.get(4)?,
            target_id: r.get(5)?,
            app_key: r.get(6)?,
            exe_path: r.get(7)?,
            launch_args: r.get(8)?,
            working_dir: r.get(9)?,
            app_user_model_id: r.get(10)?,
            url: r.get(11)?,
            path: r.get(12)?,
            agent_source_id: r.get(13)?,
            agent_session_id: r.get(14)?,
            window_title_hint: r.get(15)?,
            window_class: r.get(16)?,
            window_title: r.get(17)?,
            restore_note: r.get(18)?,
            last_result: r.get(19)?,
            last_verification: r.get(20)?,
            last_restored_at: r.get(21)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_snapshot(db: &Db, id: &str) -> AppResult<SnapshotDetail> {
    db.with_read(|conn| {
        let summary = conn
            .query_row(
                &format!("{} WHERE s.id = ?1", SNAPSHOT_SELECT),
                params![id],
                row_summary,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("工作现场不存在".into()))?;
        let items = item_rows(conn, id)?;
        Ok(SnapshotDetail { summary, items })
    })
}

// ── 创建 / 维护 ─────────────────────────────────────────────

fn norm_kind(kind: &str) -> AppResult<&'static str> {
    match kind.trim() {
        "application" => Ok("application"),
        "url" => Ok("url"),
        "file" => Ok("file"),
        "directory" => Ok("directory"),
        "agent_session" => Ok("agent_session"),
        other => Err(AppError::Validation(format!("未知现场条目类型: {}", other))),
    }
}

/// 捕获阶段的校验只拒绝「必然无法执行/有注入风险」的数据：
/// URL 白名单、路径必须绝对、ID 字符集；不要求文件此刻存在（移动盘/网络盘可稍后恢复）。
fn validate_capture_item(item: &SnapshotItemInput) -> AppResult<SnapshotItemInput> {
    let mut it = item.clone();
    it.item_kind = norm_kind(&it.item_kind)?.to_string();
    it.display_name = it.display_name.trim().to_string();
    if it.display_name.is_empty() {
        it.display_name = match it.item_kind.as_str() {
            "url" => it.url.trim().to_string(),
            "file" | "directory" => it.path.trim().to_string(),
            _ => "未命名".into(),
        };
    }
    if it.display_name.chars().count() > 120 {
        return Err(AppError::Validation("现场条目名称超过 120 字符".into()));
    }
    match it.item_kind.as_str() {
        "application" => {
            if it.exe_path.trim().is_empty() && it.app_user_model_id.trim().is_empty() {
                return Err(AppError::Validation(
                    "应用条目必须提供 exe 路径或 AUMID".into(),
                ));
            }
            if !it.exe_path.trim().is_empty() {
                let p = std::path::Path::new(it.exe_path.trim());
                if !p.is_absolute() {
                    return Err(AppError::Validation("应用路径必须是绝对路径".into()));
                }
            }
            if !it.app_user_model_id.trim().is_empty() {
                navigation::validate_aumid(&it.app_user_model_id)?;
            }
            navigation::validate_launch_args(&it.launch_args)?;
        }
        "url" => navigation::validate_url(&it.url)?,
        "file" | "directory" => {
            let p = std::path::Path::new(it.path.trim());
            if it.path.trim().is_empty() || !p.is_absolute() {
                return Err(AppError::Validation("文件/目录必须是绝对路径".into()));
            }
        }
        "agent_session" => {
            if it.agent_source_id.trim().is_empty() || it.agent_session_id.trim().is_empty() {
                return Err(AppError::Validation(
                    "Agent 会话必须同时提供来源与会话 ID".into(),
                ));
            }
            crate::agents::validate_session_id(it.agent_session_id.trim())?;
        }
        _ => unreachable!(),
    }
    it.window_hwnd = None;
    Ok(it)
}

fn capture_window_items(hwnds: &[isize]) -> Vec<SnapshotItemInput> {
    if hwnds.is_empty() {
        return Vec::new();
    }
    let windows = window_manager::top_windows_force();
    let mut out = Vec::new();
    for hwnd in hwnds {
        let Some(w) = windows.iter().find(|w| w.hwnd == *hwnd) else {
            continue;
        };
        let exe = w.exe_path.clone().unwrap_or_default();
        if exe.is_empty() {
            // 无 exe 身份的窗口（UWP 等）无法安全重启，只记录提示，不伪造可恢复
            continue;
        }
        out.push(SnapshotItemInput {
            item_kind: "application".into(),
            display_name: if w.title.trim().is_empty() {
                std::path::Path::new(&exe)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| exe.clone())
            } else {
                w.title.clone()
            },
            exe_path: exe,
            window_class: w.class_name.clone(),
            window_title: w.title.clone(),
            restore_note: "仅恢复窗口位置/前台，不恢复窗口内的文档内容".into(),
            ..Default::default()
        });
    }
    out
}

fn dedupe_items(items: Vec<SnapshotItemInput>) -> Vec<SnapshotItemInput> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for it in items {
        let key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            it.item_kind,
            it.exe_path.trim().to_ascii_lowercase(),
            it.url.trim(),
            it.path.trim().to_ascii_lowercase(),
            it.agent_source_id.trim(),
            it.agent_session_id.trim()
        );
        if seen.insert(key) {
            out.push(it);
        }
    }
    out
}

/// 从任务已关联的导航目标自动生成快照：只读关联表，不启动任何程序。
pub fn capture_from_task(
    db: &Db,
    task_id: &str,
    name: &str,
    note: &str,
) -> AppResult<SnapshotDetail> {
    let links = target_resolver::task_targets(db, task_id)?;
    if links.is_empty() {
        return Err(AppError::Validation(
            "该任务尚未关联任何应用/网页/文件，无法捕获工作现场".into(),
        ));
    }
    let mut items = Vec::new();
    for l in links {
        let t = &l.target;
        // 有运行中窗口时记录窗口身份，恢复时优先唤醒同一个窗口
        let window = if t.target_type == "application" && !t.exe_path.is_empty() {
            window_manager::windows_for_exe(&t.exe_path)
                .into_iter()
                .max_by_key(|w| w.title.chars().count())
        } else {
            None
        };
        items.push(SnapshotItemInput {
            item_kind: t.target_type.clone(),
            display_name: t.display_name.clone(),
            target_id: Some(t.id.clone()),
            exe_path: t.exe_path.clone(),
            launch_args: t.launch_args.clone(),
            working_dir: t.working_dir.clone(),
            app_user_model_id: t.app_user_model_id.clone(),
            url: t.url.clone(),
            path: t.path.clone(),
            agent_source_id: t.agent_source_id.clone(),
            agent_session_id: t.agent_session_id.clone(),
            window_title_hint: t.window_title_hint.clone(),
            window_class: window
                .as_ref()
                .map(|w| w.class_name.clone())
                .unwrap_or_default(),
            window_title: window.as_ref().map(|w| w.title.clone()).unwrap_or_default(),
            restore_note: match t.target_type.as_str() {
                "url" => "浏览器标签页内容由浏览器接管，仅能确认打开了网址".into(),
                "file" => "由系统默认程序打开，是否成功由系统决定".into(),
                "agent_session" => "仅能按 Agent 支持的层级恢复；不支持深度链接时会降级".into(),
                _ => String::new(),
            },
            window_hwnd: None,
        });
    }
    let input = CaptureInput {
        task_id: Some(task_id.to_string()),
        name: name.to_string(),
        note: note.to_string(),
        source: Some("task".into()),
        items,
        window_hwnds: Vec::new(),
    };
    create_snapshot(db, &input)
}

/// 创建快照（单事务）。条目上限 30；同一现场内按身份去重。
pub fn create_snapshot(db: &Db, input: &CaptureInput) -> AppResult<SnapshotDetail> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::Validation(
            "现场名称不能为空且不超过 80 字符".into(),
        ));
    }
    let source = match input.source.as_deref() {
        Some("task") => "task",
        _ => "manual",
    };
    if let Some(task_id) = &input.task_id {
        db.with_conn(|conn| {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE id = ?1",
                params![task_id],
                |r| r.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound("关联任务不存在".into()));
            }
            Ok(())
        })?;
    }
    let mut items: Vec<SnapshotItemInput> = Vec::new();
    for it in &input.items {
        items.push(validate_capture_item(it)?);
    }
    items.extend(capture_window_items(&input.window_hwnds));
    let items = dedupe_items(items);
    if items.is_empty() {
        return Err(AppError::Validation("现场至少需要一条有效条目".into()));
    }
    if items.len() > MAX_ITEMS_PER_SNAPSHOT {
        return Err(AppError::Validation(format!(
            "单个现场最多 {} 项",
            MAX_ITEMS_PER_SNAPSHOT
        )));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO workspace_snapshots
               (id, task_id, name, note, source, item_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id,
                input.task_id,
                name,
                input.note.trim(),
                source,
                items.len() as i64,
                now
            ],
        )?;
        for (order, it) in items.iter().enumerate() {
            tx.execute(
                "INSERT INTO workspace_snapshot_items
                   (id, snapshot_id, display_order, item_kind, display_name, target_id, app_key,
                    exe_path, launch_args, working_dir, app_user_model_id, url, path,
                    agent_source_id, agent_session_id, window_title_hint, window_class, window_title, restore_note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    id,
                    order as i64,
                    it.item_kind,
                    it.display_name,
                    it.target_id,
                    it.exe_path.trim(),
                    it.launch_args.trim(),
                    it.working_dir.trim(),
                    it.app_user_model_id.trim(),
                    it.url.trim(),
                    it.path.trim(),
                    it.agent_source_id.trim(),
                    it.agent_session_id.trim(),
                    it.window_title_hint.trim(),
                    it.window_class.trim(),
                    it.window_title.trim(),
                    it.restore_note.trim(),
                ],
            )?;
        }
        tx.commit()?;
        Ok::<_, AppError>(())
    })?;
    prune_snapshots(db, MAX_SNAPSHOTS)?;
    get_snapshot(db, &id)
}

pub fn rename_snapshot(db: &Db, id: &str, name: &str, note: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::Validation(
            "现场名称不能为空且不超过 80 字符".into(),
        ));
    }
    let now = now_iso();
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE workspace_snapshots SET name = ?1, note = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, note.trim(), now, id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("工作现场不存在".into()));
        }
        Ok(())
    })
}

pub fn delete_snapshot(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let n = conn.execute("DELETE FROM workspace_snapshots WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(AppError::NotFound("工作现场不存在".into()));
        }
        Ok(())
    })
}

/// 保留最新 `keep` 个现场（超出按 updated_at 清理最旧，级联删除条目）。
pub fn prune_snapshots(db: &Db, keep: usize) -> AppResult<usize> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM workspace_snapshots WHERE id IN (
               SELECT id FROM workspace_snapshots ORDER BY updated_at DESC LIMIT -1 OFFSET ?1
             )",
            params![keep as i64],
        )?;
        Ok(n)
    })
}

/// 解绑任务（删除任务时 task_id 自动 SET NULL；这里用于用户显式改为独立现场）。
pub fn detach_task(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE workspace_snapshots SET task_id = NULL, updated_at = ?1 WHERE id = ?2",
            params![now_iso(), id],
        )?;
        Ok(())
    })
}

// ── 恢复 ────────────────────────────────────────────────────

struct RestoreSlot {
    snapshot_id: String,
    cancel: Arc<AtomicBool>,
}

static RESTORE: OnceLock<Mutex<Option<RestoreSlot>>> = OnceLock::new();

fn restore_slot() -> &'static Mutex<Option<RestoreSlot>> {
    RESTORE.get_or_init(|| Mutex::new(None))
}

pub fn restore_status() -> RestoreStatus {
    let guard = restore_slot().lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(s) => RestoreStatus {
            running: true,
            snapshot_id: Some(s.snapshot_id.clone()),
            cancel_requested: s.cancel.load(Ordering::Acquire),
        },
        None => RestoreStatus {
            running: false,
            snapshot_id: None,
            cancel_requested: false,
        },
    }
}

pub fn request_cancel() {
    let guard = restore_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.as_ref() {
        s.cancel.store(true, Ordering::Release);
    }
}

fn from_nav(item: &SnapshotItem, r: &NavigationResult) -> RestoreItemResult {
    RestoreItemResult {
        item_id: item.id.clone(),
        display_name: item.display_name.clone(),
        item_kind: item.item_kind.clone(),
        outcome: if r.success { "restored" } else { "failed" }.into(),
        action: r
            .actual_action
            .clone()
            .or_else(|| Some(r.requested_action.clone())),
        verification_level: r.verification_level.clone(),
        fallback_used: r.fallback_used,
        reason: r.reason.clone(),
    }
}

fn skipped(item: &SnapshotItem, reason: impl Into<String>) -> RestoreItemResult {
    RestoreItemResult {
        item_id: item.id.clone(),
        display_name: item.display_name.clone(),
        item_kind: item.item_kind.clone(),
        outcome: "skipped".into(),
        action: None,
        verification_level: VerificationLevel::None.as_str().into(),
        fallback_used: false,
        reason: Some(reason.into()),
    }
}

fn failed(item: &SnapshotItem, reason: impl Into<String>) -> RestoreItemResult {
    RestoreItemResult {
        item_id: item.id.clone(),
        display_name: item.display_name.clone(),
        item_kind: item.item_kind.clone(),
        outcome: "failed".into(),
        action: None,
        verification_level: VerificationLevel::None.as_str().into(),
        fallback_used: false,
        reason: Some(reason.into()),
    }
}

/// 确保条目有可执行的导航目标：优先复用原 target_id，目标被删/失效时按身份幂等重建。
/// 返回 Err 说明无法安全重建（如 exe 已不存在）。
fn ensure_target(db: &Db, item: &SnapshotItem) -> AppResult<String> {
    if let Some(tid) = item.target_id.as_deref() {
        if let Ok(Some(t)) = target_resolver::get_target(db, tid) {
            if t.target_type == item.item_kind {
                return Ok(t.id);
            }
        }
    }
    let mut input = target_resolver::TargetInput {
        target_type: item.item_kind.clone(),
        display_name: item.display_name.clone(),
        exe_path: item.exe_path.clone(),
        launch_args: item.launch_args.clone(),
        working_dir: item.working_dir.clone(),
        app_user_model_id: item.app_user_model_id.clone(),
        url: item.url.clone(),
        path: item.path.clone(),
        agent_source_id: item.agent_source_id.clone(),
        agent_session_id: item.agent_session_id.clone(),
        window_title_hint: item.window_title_hint.clone(),
        overwrite_name: false,
        ..Default::default()
    };
    if input.display_name.trim().is_empty() {
        input.display_name = item.display_name.clone();
    }
    let t = target_resolver::save_target(db, &input)?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE workspace_snapshot_items SET target_id = ?1, app_key = ?2 WHERE id = ?3",
            params![t.id, t.app_key, item.id],
        )?;
        Ok::<_, AppError>(())
    })?;
    Ok(t.id)
}

fn focus_matching_window(item: &SnapshotItem) -> Option<(window_manager::WindowInfo, bool)> {
    let windows = window_manager::top_windows_force();
    let exe = item.exe_path.trim().to_ascii_lowercase();
    if !item.window_class.is_empty() {
        // 1) 类名 + 标题 + exe 全匹配：最可信
        if let Some(w) = windows.iter().find(|w| {
            w.class_name == item.window_class
                && w.title == item.window_title
                && (exe.is_empty() || w.exe_path.as_deref() == Some(exe.as_str()))
        }) {
            return Some((w.clone(), false));
        }
        // 2) 类名 + exe（标题已变化，如编辑器换了文件名）
        if let Some(w) = windows.iter().find(|w| {
            w.class_name == item.window_class
                && (exe.is_empty() || w.exe_path.as_deref() == Some(exe.as_str()))
        }) {
            return Some((w.clone(), true));
        }
    }
    if !exe.is_empty() {
        if let Some(w) = windows
            .iter()
            .filter(|w| w.exe_path.as_deref() == Some(exe.as_str()))
            .max_by_key(|w| w.title.chars().count())
        {
            return Some((w.clone(), true));
        }
    }
    None
}

fn do_restore_item(db: &Db, app: &AppHandle, item: &SnapshotItem) -> RestoreItemResult {
    match item.item_kind.as_str() {
        "application" => {
            // 先尝试唤醒已有窗口，绝不重复启动
            if let Some((w, fallback)) = focus_matching_window(item) {
                return match window_manager::focus_window(w.hwnd) {
                    Ok(window_manager::FocusOutcome::Confirmed) => RestoreItemResult {
                        item_id: item.id.clone(),
                        display_name: item.display_name.clone(),
                        item_kind: item.item_kind.clone(),
                        outcome: "restored".into(),
                        action: Some("focus_window".into()),
                        verification_level: VerificationLevel::WindowConfirmed.as_str().into(),
                        fallback_used: fallback,
                        reason: if fallback {
                            Some("按进程/窗口类复用（标题已变化）".into())
                        } else {
                            None
                        },
                    },
                    Ok(window_manager::FocusOutcome::Unverified) => RestoreItemResult {
                        item_id: item.id.clone(),
                        display_name: item.display_name.clone(),
                        item_kind: item.item_kind.clone(),
                        outcome: "restored".into(),
                        action: Some("focus_window".into()),
                        verification_level: VerificationLevel::WindowVisible.as_str().into(),
                        fallback_used: fallback,
                        reason: Some("窗口已找到但未能确认置前（可能被系统焦点保护拒绝）".into()),
                    },
                    Err(e) => failed(item, format!("唤醒窗口失败: {}", e.reason_cn())),
                };
            }
            let exe_missing = !item.app_user_model_id.trim().is_empty()
                && item.exe_path.trim().is_empty()
                || (!item.exe_path.trim().is_empty()
                    && !std::path::Path::new(item.exe_path.trim()).exists());
            if exe_missing && item.app_user_model_id.trim().is_empty() {
                return skipped(item, format!("程序不存在或已卸载: {}", item.exe_path));
            }
            match ensure_target(db, item) {
                Ok(tid) => {
                    let r = router::navigate(
                        db,
                        app,
                        &tid,
                        &router::NavigateOptions {
                            action: Some(ACTION_OPEN_APP.into()),
                            ..Default::default()
                        },
                    );
                    if r.success && r.verification_level == VerificationLevel::None.as_str() {
                        // 防御：成功但无证据时按「启动请求已提交」标注，不虚报窗口恢复
                        RestoreItemResult {
                            verification_level: VerificationLevel::LaunchRequested.as_str().into(),
                            ..from_nav(item, &r)
                        }
                    } else {
                        from_nav(item, &r)
                    }
                }
                Err(e) => skipped(item, e.to_string()),
            }
        }
        "url" => match ensure_target(db, item) {
            Ok(tid) => from_nav(
                item,
                &router::navigate(
                    db,
                    app,
                    &tid,
                    &router::NavigateOptions {
                        action: Some(ACTION_OPEN_URL.into()),
                        ..Default::default()
                    },
                ),
            ),
            Err(e) => skipped(item, e.to_string()),
        },
        "file" => {
            if !std::path::Path::new(item.path.trim()).is_file() {
                return skipped(item, format!("文件不存在: {}", item.path));
            }
            match ensure_target(db, item) {
                Ok(tid) => from_nav(
                    item,
                    &router::navigate(
                        db,
                        app,
                        &tid,
                        &router::NavigateOptions {
                            action: Some(ACTION_OPEN_FILE.into()),
                            ..Default::default()
                        },
                    ),
                ),
                Err(e) => skipped(item, e.to_string()),
            }
        }
        "directory" => {
            if !std::path::Path::new(item.path.trim()).is_dir() {
                return skipped(item, format!("目录不存在: {}", item.path));
            }
            match ensure_target(db, item) {
                Ok(tid) => from_nav(
                    item,
                    &router::navigate(
                        db,
                        app,
                        &tid,
                        &router::NavigateOptions {
                            action: Some(ACTION_OPEN_DIRECTORY.into()),
                            ..Default::default()
                        },
                    ),
                ),
                Err(e) => skipped(item, e.to_string()),
            }
        }
        "agent_session" => {
            let alive: i64 = match db.with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                    params![item.agent_source_id, item.agent_session_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            }) {
                Ok(n) => n,
                Err(e) => return failed(item, e.to_string()),
            };
            if alive == 0 {
                return skipped(item, "本地已无该 Agent 会话记录，无法恢复");
            }
            match ensure_target(db, item) {
                Ok(tid) => from_nav(
                    item,
                    &router::navigate(
                        db,
                        app,
                        &tid,
                        &router::NavigateOptions {
                            action: Some(ACTION_RESUME_SESSION.into()),
                            ..Default::default()
                        },
                    ),
                ),
                Err(e) => skipped(item, e.to_string()),
            }
        }
        other => failed(item, format!("未知条目类型: {}", other)),
    }
}

fn persist_item_result(db: &Db, snapshot_id: &str, r: &RestoreItemResult) {
    let now = now_iso();
    let _ = db.with_conn(|conn| {
        conn.execute(
            "UPDATE workspace_snapshot_items
               SET last_result = ?1, last_verification = ?2, last_restored_at = ?3
             WHERE id = ?4 AND snapshot_id = ?5",
            params![r.outcome, r.verification_level, now, r.item_id, snapshot_id],
        )?;
        Ok::<_, AppError>(())
    });
}

fn finish_snapshot(db: &Db, snapshot_id: &str) {
    let now = now_iso();
    let _ = db.with_conn(|conn| {
        conn.execute(
            "UPDATE workspace_snapshots
               SET last_restored_at = ?1, restore_count = restore_count + 1, updated_at = ?1
             WHERE id = ?2",
            params![now, snapshot_id],
        )?;
        Ok::<_, AppError>(())
    });
}

/// 同步执行恢复（命令层放到阻塞线程，避免卡 UI）。
/// 取消只在项间生效：已发出的启动请求无法撤回。
pub fn restore_snapshot(
    db: &Db,
    app: &AppHandle,
    snapshot_id: &str,
    cancel: &AtomicBool,
) -> AppResult<RestoreSummary> {
    let detail = get_snapshot(db, snapshot_id)?;
    let total = detail.items.len();
    let mut summary = RestoreSummary {
        snapshot_id: snapshot_id.to_string(),
        total,
        ..Default::default()
    };
    let _ = app.emit(
        "workspace-restore-progress",
        serde_json::json!({
            "snapshot_id": snapshot_id, "index": 0, "total": total,
            "phase": "started", "item_id": null
        }),
    );
    for (i, item) in detail.items.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            summary.cancelled += total - i;
            for rest in &detail.items[i..] {
                let r = RestoreItemResult {
                    item_id: rest.id.clone(),
                    display_name: rest.display_name.clone(),
                    item_kind: rest.item_kind.clone(),
                    outcome: "cancelled".into(),
                    action: None,
                    verification_level: VerificationLevel::None.as_str().into(),
                    fallback_used: false,
                    reason: Some("用户取消，尚未执行".into()),
                };
                persist_item_result(db, snapshot_id, &r);
                summary.items.push(r);
            }
            break;
        }
        let _ = app.emit(
            "workspace-restore-progress",
            serde_json::json!({
                "snapshot_id": snapshot_id, "index": i, "total": total,
                "phase": "running", "item_id": item.id, "display_name": item.display_name
            }),
        );
        let r = do_restore_item(db, app, item);
        match r.outcome.as_str() {
            "restored" => summary.restored += 1,
            "failed" => summary.failed += 1,
            _ => summary.skipped += 1,
        }
        persist_item_result(db, snapshot_id, &r);
        let _ = app.emit(
            "workspace-restore-progress",
            serde_json::json!({
                "snapshot_id": snapshot_id, "index": i, "total": total,
                "phase": "item-done", "item_id": item.id, "result": r
            }),
        );
        summary.items.push(r);
        if i + 1 < total {
            // 间隔可被取消打断，避免用户等 30×350ms 才能停
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(RESTORE_INTERVAL_MS);
            while std::time::Instant::now() < deadline {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    // 取消后剩余项已在循环内逐条持久化，这里不再重复写入
    finish_snapshot(db, snapshot_id);
    let _ = app.emit(
        "workspace-restore-progress",
        serde_json::json!({
            "snapshot_id": snapshot_id, "index": total, "total": total,
            "phase": "done", "summary": summary
        }),
    );
    let _ = app.emit(
        "workspace-changed",
        serde_json::json!({ "kind": "restored" }),
    );
    Ok(summary)
}

/// 启动后台恢复：同一时刻只允许一个现场（避免多个任务争抢前台）。
/// 返回 false 表示已有恢复在进行。
pub fn start_restore(db: Arc<Db>, app: AppHandle, snapshot_id: String) -> AppResult<bool> {
    let mut guard = restore_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.as_ref() {
        if !s.cancel.load(Ordering::Acquire) {
            return Err(AppError::Conflict(
                "已有工作现场正在恢复，请等待完成或先取消".into(),
            ));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *guard = Some(RestoreSlot {
        snapshot_id: snapshot_id.clone(),
        cancel: cancel.clone(),
    });
    drop(guard);

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = restore_snapshot(&db, &app2, &snapshot_id, &cancel);
        if let Err(e) = &result {
            let _ = app2.emit(
                "workspace-restore-progress",
                serde_json::json!({
                    "snapshot_id": snapshot_id, "phase": "error",
                    "error": e.to_string()
                }),
            );
        }
        let mut guard = restore_slot().lock().unwrap_or_else(|e| e.into_inner());
        if guard
            .as_ref()
            .map(|s| s.snapshot_id == snapshot_id)
            .unwrap_or(false)
        {
            *guard = None;
        }
    });
    Ok(true)
}

/// 当前前台窗口的可捕获列表（工作现场选择器用）。只返回身份元数据。
pub fn visible_capture_windows() -> Vec<serde_json::Value> {
    window_manager::top_windows_force()
        .into_iter()
        .filter(|w| !w.title.trim().is_empty())
        .take(80)
        .map(|w| {
            serde_json::json!({
                "hwnd": w.hwnd,
                "title": w.title,
                "class_name": w.class_name,
                "exe_path": w.exe_path,
                "is_minimized": w.is_minimized,
            })
        })
        .collect()
}

/// 命令层便捷函数：让 Tauri 状态能取到 Db。
pub fn db_from(app: &AppHandle) -> Option<Arc<Db>> {
    app.try_state::<Arc<Db>>().map(|s| s.inner().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn task(db: &Db) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?1, '现场任务', 'now', 'now')",
                params![id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        id
    }

    fn item(kind: &str, name: &str) -> SnapshotItemInput {
        match kind {
            "url" => SnapshotItemInput {
                item_kind: kind.into(),
                display_name: name.into(),
                url: "https://example.com/doc".into(),
                ..Default::default()
            },
            "directory" => SnapshotItemInput {
                item_kind: kind.into(),
                display_name: name.into(),
                path: std::env::temp_dir().to_string_lossy().to_string(),
                ..Default::default()
            },
            _ => SnapshotItemInput {
                item_kind: kind.into(),
                display_name: name.into(),
                exe_path: "C:\\Windows\\notepad.exe".into(),
                ..Default::default()
            },
        }
    }

    fn capture(task_id: Option<&str>, items: Vec<SnapshotItemInput>) -> CaptureInput {
        CaptureInput {
            task_id: task_id.map(|s| s.to_string()),
            name: "测试现场".into(),
            note: "说明".into(),
            source: None,
            items,
            window_hwnds: vec![],
        }
    }

    #[test]
    fn create_list_and_delete_snapshot() {
        let db = memdb();
        let t = task(&db);
        let detail = create_snapshot(&db, &capture(Some(&t), vec![item("url", "文档")])).unwrap();
        assert_eq!(detail.summary.item_count, 1);
        assert_eq!(detail.summary.task_id.as_deref(), Some(t.as_str()));
        assert_eq!(detail.items[0].item_kind, "url");
        let list = list_snapshots(&db, Some(&t)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].task_title.as_deref(), Some("现场任务"));
        rename_snapshot(&db, &detail.summary.id, "新名称", "新说明").unwrap();
        assert_eq!(
            get_snapshot(&db, &detail.summary.id).unwrap().summary.name,
            "新名称"
        );
        delete_snapshot(&db, &detail.summary.id).unwrap();
        assert!(get_snapshot(&db, &detail.summary.id).is_err());
    }

    #[test]
    fn invalid_items_rejected() {
        let db = memdb();
        // 非 http(s) 协议
        let mut bad = item("url", "危险");
        bad.url = "file:///C:/Windows/system32/cmd.exe".into();
        assert!(create_snapshot(&db, &capture(None, vec![bad])).is_err());
        // 相对路径
        let mut bad = item("directory", "相对");
        bad.path = "some/relative".into();
        assert!(create_snapshot(&db, &capture(None, vec![bad])).is_err());
        // 未知类型
        assert!(create_snapshot(&db, &capture(None, vec![item("window", "x")])).is_err());
        // 未知任务
        assert!(create_snapshot(&db, &capture(Some("nope"), vec![item("url", "x")])).is_err());
    }

    #[test]
    fn items_are_deduped_and_capped() {
        let db = memdb();
        let same = vec![item("url", "文档"), item("url", "文档")];
        let d = create_snapshot(&db, &capture(None, same)).unwrap();
        assert_eq!(d.items.len(), 1, "同身份条目去重");
        let many: Vec<_> = (0..(MAX_ITEMS_PER_SNAPSHOT + 1))
            .map(|i| {
                let mut it = item("url", &format!("文档{}", i));
                it.url = format!("https://example.com/{}", i);
                it
            })
            .collect();
        assert!(
            create_snapshot(&db, &capture(None, many)).is_err(),
            "超过上限应拒绝"
        );
    }

    #[test]
    fn deleting_task_keeps_snapshot_but_detaches() {
        let db = memdb();
        let t = task(&db);
        let d = create_snapshot(&db, &capture(Some(&t), vec![item("url", "文档")])).unwrap();
        db.with_conn(|c| {
            c.execute("DELETE FROM tasks WHERE id = ?1", params![t])?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let got = get_snapshot(&db, &d.summary.id).unwrap();
        assert!(
            got.summary.task_id.is_none(),
            "删除任务不销毁现场，降级为独立快照"
        );
    }

    #[test]
    fn capture_from_task_copies_targets_and_rejects_empty() {
        let db = memdb();
        let t = task(&db);
        assert!(capture_from_task(&db, &t, "空", "").is_err());
        let target = target_resolver::save_target(
            &db,
            &target_resolver::TargetInput {
                target_type: "url".into(),
                display_name: "文档".into(),
                url: "https://example.com".into(),
                ..Default::default()
            },
        )
        .unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO task_navigation_targets (id, task_id, target_id, display_order, is_default, launch_behavior, created_at)
                 VALUES (?1, ?2, ?3, 0, 0, 'default', 'now')",
                params![uuid::Uuid::new_v4().to_string(), t, target.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let d = capture_from_task(&db, &t, "自动现场", "说明").unwrap();
        assert_eq!(d.summary.source, "task");
        assert_eq!(d.items.len(), 1);
        assert_eq!(d.items[0].target_id.as_deref(), Some(target.id.as_str()));
    }

    #[test]
    fn prune_keeps_newest() {
        let db = memdb();
        for i in 0..5 {
            let mut input = capture(None, vec![item("url", &format!("文档{}", i))]);
            input.items[0].url = format!("https://example.com/{}", i);
            create_snapshot(&db, &input).unwrap();
        }
        assert_eq!(prune_snapshots(&db, 2).unwrap(), 3);
        assert_eq!(list_snapshots(&db, None).unwrap().len(), 2);
    }
}
