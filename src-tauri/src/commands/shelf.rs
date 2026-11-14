//! 文件暂存架命令层：添加（文件/文件夹/链接/文本/从剪贴板）、列表、分组、
//! 更新、删除、清空、过期清理、存在性检查、打开/定位、预览、任务关联。
//!
//! 边界：
//! - 打开/定位复用剪贴板同款校验（`navigation::validate_local_path` / `validate_url`），
//!   路径来自库内数据，不信任前端回传；
//! - 复制路径 / 复制文件走剪贴板平台写入链路（自写登记，不回流记录）；
//! - 托管复制在 spawn_blocking 中流式执行，批量受并发闸限制。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

use crate::clipboard::platform::ClipboardPayload;
use crate::db::Settings;
use crate::diagnostics::Diagnostics;
use crate::error::{AppError, AppResult};
use crate::shelf::{self, ShelfState};

#[derive(Debug, Serialize)]
pub struct ShelfFailedEntry {
    pub path: String,
    pub reason: String,
    /// 稳定错误码（`AppError::code`）。可选，旧前端可忽略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 稳定错误分类（`AppError::category`），前端据此分级与聚合。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

impl ShelfFailedEntry {
    /// 单条失败从统一错误类型带出可机读分类；文案仍保持既有 `reason`。
    fn from_error(path: String, err: &AppError) -> Self {
        Self {
            path,
            reason: err.to_string(),
            code: Some(err.code().to_string()),
            category: Some(err.category().as_str().to_string()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ShelfAddReport {
    pub added: Vec<shelf::ShelfItem>,
    pub failed: Vec<ShelfFailedEntry>,
}

/// 主动粘贴当前剪贴板的结构化结果。
///
/// 与 `ShelfAddReport` 分开：粘贴是「来源 → 校验 → 保存」的一次完整操作，
/// 需要稳定的 operationId、来源/内容类型、跳过数、总失败码与是否需要用户处理。
/// 空/占用/不支持也走成功返回（`success=false`），让前端拿到可区分的协议字段，
/// 而不是只能解析错误文案。
#[derive(Debug, Serialize)]
pub struct ShelfPasteReport {
    pub operation_id: String,
    pub source: String,
    pub content_kind: String,
    pub added: Vec<shelf::ShelfItem>,
    pub added_ids: Vec<String>,
    pub failed: Vec<ShelfFailedEntry>,
    pub skipped: usize,
    /// 与已有条目同路径/同正文的条数；仅提示，不阻止本次保存。
    pub duplicates: usize,
    pub success: bool,
    pub partial: bool,
    pub requires_user_action: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Deserialize)]
pub struct ShelfUpdatePatch {
    pub display_name: Option<String>,
    pub favorite: Option<bool>,
    pub pinned: Option<bool>,
    /// Some(具体分组 id / "none")；None=不修改
    pub group_id: Option<String>,
    pub note: Option<String>,
    pub expire_at: Option<Option<String>>,
}

fn rt<'a>(root: &'a State<'_, Arc<ShelfState>>) -> &'a Arc<ShelfState> {
    root.inner()
}

// ── 列表 / 统计 / 分组 ──────────────────────────────────────

#[tauri::command]
pub fn shelf_list(
    state: State<'_, Arc<ShelfState>>,
    search: Option<String>,
    kind: Option<String>,
    group_id: Option<String>,
    favorite_only: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
    sort: Option<String>,
) -> AppResult<shelf::ShelfPage> {
    let st = rt(&state);
    let filter = shelf::ListFilter {
        search,
        kind: kind.unwrap_or_else(|| "all".into()),
        group_id: group_id.unwrap_or_else(|| "all".into()),
        favorite_only: favorite_only.unwrap_or(false),
        limit: limit.unwrap_or(100),
        offset: offset.unwrap_or(0),
        sort: sort.unwrap_or_default(),
    };
    shelf::list(&st.db, &filter)
}

#[tauri::command]
pub fn shelf_stats(state: State<'_, Arc<ShelfState>>) -> AppResult<shelf::ShelfStats> {
    let st = rt(&state);
    shelf::stats(&st.db, &st.root)
}

#[tauri::command]
pub fn shelf_groups(state: State<'_, Arc<ShelfState>>) -> AppResult<Vec<shelf::ShelfGroup>> {
    shelf::list_groups(&rt(&state).db)
}

#[tauri::command]
pub fn shelf_group_create(
    state: State<'_, Arc<ShelfState>>,
    name: String,
) -> AppResult<shelf::ShelfGroup> {
    shelf::group_create(&rt(&state).db, &name)
}

#[tauri::command]
pub fn shelf_group_rename(
    state: State<'_, Arc<ShelfState>>,
    id: String,
    name: String,
) -> AppResult<()> {
    shelf::group_rename(&rt(&state).db, &id, &name)
}

#[tauri::command]
pub fn shelf_group_delete(state: State<'_, Arc<ShelfState>>, id: String) -> AppResult<()> {
    shelf::group_delete(&rt(&state).db, &id)
}

// ── 添加 ────────────────────────────────────────────────────

/// 批量添加文件/文件夹（拖入、文件选择器共用）。
/// storage_mode: "reference"（不复制）| "managed"（复制到 shelf 目录）。
/// source_kind: "picker"（文件选择器）| "drag"（拖入）| "manual"。
/// 托管复制在阻塞线程中流式执行，受并发闸限制；单条失败不影响其余条目。
#[tauri::command]
pub async fn shelf_add_paths(
    state: State<'_, Arc<ShelfState>>,
    paths: Vec<String>,
    storage_mode: String,
    source_kind: Option<String>,
    group_id: Option<String>,
) -> AppResult<ShelfAddReport> {
    if paths.is_empty() {
        return Err(AppError::Validation("未提供任何路径".into()));
    }
    if paths.len() > 500 {
        return Err(AppError::Validation("单批最多添加 500 个路径".into()));
    }
    match storage_mode.as_str() {
        shelf::MODE_REFERENCE | shelf::MODE_MANAGED => {}
        other => return Err(AppError::Validation(format!("未知存储模式: {other}"))),
    }
    let source = match source_kind.as_deref() {
        None | Some("picker") => "picker",
        Some("drag") => "drag",
        Some("manual") => "manual",
        Some(other) => return Err(AppError::Validation(format!("未知来源类型: {other}"))),
    };
    let st = state.inner().clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let mut added = Vec::new();
        let mut failed = Vec::new();
        for raw in paths {
            let result = if storage_mode == shelf::MODE_MANAGED {
                let _permit = st.acquire_copy_permit();
                shelf::add_managed(&st.db, &st.root, &raw, source, group_id.as_deref())
            } else {
                let _permit = st.acquire_copy_permit();
                shelf::add_reference(&st.db, &st.root, &raw, source, group_id.as_deref())
            };
            match result {
                Ok(item) => added.push(item),
                Err(e) => failed.push(ShelfFailedEntry::from_error(raw, &e)),
            }
        }
        ShelfAddReport { added, failed }
    })
    .await
    .map_err(|e| AppError::Agent(format!("添加任务失败: {e}")))?;
    Ok(report)
}

#[tauri::command]
pub fn shelf_add_link(
    state: State<'_, Arc<ShelfState>>,
    url: String,
    group_id: Option<String>,
) -> AppResult<shelf::ShelfItem> {
    let st = rt(&state);
    shelf::add_link(&st.db, &url, group_id.as_deref())
}

#[tauri::command]
pub fn shelf_add_text(
    state: State<'_, Arc<ShelfState>>,
    text: String,
    group_id: Option<String>,
) -> AppResult<shelf::ShelfItem> {
    let st = rt(&state);
    shelf::add_text(&st.db, &text, "manual", group_id.as_deref())
}

/// 主动粘贴**当前系统剪贴板**到暂存架。
///
/// 与 `shelf_add_from_clipboard` 的关键区别：后者只消费剪贴板历史条目，
/// 历史监听关闭/暂停时不可用；本命令在用户按键或点击的当下读取实时剪贴板，
/// 不依赖 `clipboard_items`、不写系统剪贴板、不模拟 Ctrl+V、不抢其他应用焦点。
///
/// 内容优先级沿用 `clipboard::engine::classify`：文件 > 图片字节 > URL > HTML > 文本。
/// 用户主动粘贴时忽略“不进入剪贴板历史”标记（与在编辑器里 Ctrl+V 的语义一致），
/// 但仍受既有大小、数量、路径与托管配额限制。
///
/// 空内容 / 剪贴板被占用 / 格式不支持均以 `success=false` 的结构化报告返回，
/// 不抛 IPC 错误；只有内部任务失败才返回 `Err`。
#[tauri::command]
pub async fn shelf_paste_current(
    state: State<'_, Arc<ShelfState>>,
    storage_mode: Option<String>,
    group_id: Option<String>,
) -> AppResult<ShelfPasteReport> {
    let mode = storage_mode.unwrap_or_else(|| shelf::MODE_REFERENCE.into());
    match mode.as_str() {
        shelf::MODE_REFERENCE | shelf::MODE_MANAGED => {}
        other => return Err(AppError::Validation(format!("未知存储模式: {other}"))),
    }
    let st = state.inner().clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        // 实时读取与入库都在阻塞线程：OpenClipboard 有约 120ms 重试，
        // 不能占用 async 运行时工作线程。读取本身已由平台层进程级锁串行化。
        let read = crate::clipboard::platform::read_clipboard(true);
        let intake = shelf::ingest::ClipboardIntake::from_read(read);
        shelf::ingest::save(
            &st.db,
            &st.root,
            intake,
            &mode,
            "clipboard",
            group_id.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::Agent(format!("粘贴任务失败: {e}")))?;
    Ok(paste_report_from(report))
}

/// 截图/剪贴板图片直接暂存：只接受图片字节，复用粘贴的读取与托管链路。
///
/// 项目没有内置截图引擎：Windows 截图（Win+Shift+S、Snipaste 等）完成后图片在
/// 系统剪贴板，这里负责把它保存为独立托管副本，不依赖剪贴板历史开关。
#[tauri::command]
pub async fn shelf_paste_screenshot(
    state: State<'_, Arc<ShelfState>>,
    group_id: Option<String>,
) -> AppResult<ShelfPasteReport> {
    let st = state.inner().clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let read = crate::clipboard::platform::read_clipboard(true);
        let intake = shelf::ingest::ClipboardIntake::from_read(read);
        if matches!(&intake, shelf::ingest::ClipboardIntake::Image { .. }) {
            shelf::ingest::save(
                &st.db,
                &st.root,
                intake,
                shelf::MODE_MANAGED,
                "clipboard",
                group_id.as_deref(),
            )
        } else {
            // 明确区分「没有截图」与其他粘贴失败，不偷存文本/文件。
            shelf::ingest::IntakeOutcome::empty(
                "image",
                "CLIPBOARD_NO_IMAGE",
                "当前剪贴板没有截图图片。请先截图（如 Win+Shift+S），再点击暂存截图。".into(),
                false,
            )
        }
    })
    .await
    .map_err(|e| AppError::Agent(format!("截图暂存任务失败: {e}")))?;
    Ok(paste_report_from(report))
}

/// 资源管理器右键「发送到 Task Dock」的当前状态（HKCU 动词）。
#[tauri::command]
pub fn shelf_sendto_status() -> shelf::sendto::SendToStatus {
    shelf::sendto::status()
}

/// 启用右键发送：只写 HKCU，不需要管理员权限，不改文件关联。
#[tauri::command]
pub fn shelf_sendto_enable() -> AppResult<shelf::sendto::SendToStatus> {
    shelf::sendto::enable().map_err(AppError::Validation)
}

/// 停用右键发送并删除本应用创建的注册表项。
#[tauri::command]
pub fn shelf_sendto_disable() -> AppResult<()> {
    shelf::sendto::disable().map_err(AppError::Validation)
}

/// 入库结果 → 前端协议：成功/部分成功/总失败与跳过数在这里统一判定。
fn paste_report_from(report: shelf::ingest::IntakeOutcome) -> ShelfPasteReport {
    let added_ids = report.added.iter().map(|item| item.id.clone()).collect();
    let failed: Vec<ShelfFailedEntry> = report
        .failed
        .into_iter()
        .map(|failure| ShelfFailedEntry {
            path: failure.target,
            reason: failure.reason,
            code: Some(failure.code),
            category: Some(failure.category),
        })
        .collect();
    let success = !report.added.is_empty();
    ShelfPasteReport {
        operation_id: uuid::Uuid::new_v4().to_string(),
        source: "clipboard-current".into(),
        content_kind: report.content_kind.into(),
        added: report.added,
        added_ids,
        partial: success && (!failed.is_empty() || report.skipped > 0),
        requires_user_action: !failed.is_empty() || report.skipped > 0,
        success,
        failed,
        skipped: report.skipped,
        duplicates: report.duplicates,
        code: report.failure_code.map(str::to_string),
        retryable: report.retryable,
    }
}

/// 从剪贴板条目添加到暂存架：复制字节/内容生成**独立副本**。
/// 图片 → 托管 PNG 副本；文件列表 → 逐路径引用（managed 模式逐个复制）；
/// 文本/HTML → 文本条目；链接 → 链接条目。剪贴板历史清空不影响已添加内容。
#[tauri::command]
pub async fn shelf_add_from_clipboard(
    app: AppHandle,
    state: State<'_, Arc<ShelfState>>,
    item_ids: Vec<String>,
    storage_mode: String,
    group_id: Option<String>,
) -> AppResult<ShelfAddReport> {
    if item_ids.is_empty() {
        return Err(AppError::Validation("未选择剪贴板条目".into()));
    }
    if item_ids.len() > 200 {
        return Err(AppError::Validation("单批最多添加 200 个条目".into()));
    }
    match storage_mode.as_str() {
        shelf::MODE_REFERENCE | shelf::MODE_MANAGED => {}
        other => return Err(AppError::Validation(format!("未知存储模式: {other}"))),
    }
    let clip_root = app
        .try_state::<Arc<crate::clipboard::ClipboardRuntime>>()
        .map(|rt| rt.root.clone())
        .ok_or_else(|| AppError::Unavailable("剪贴板模块未就绪".into()))?;
    let st = state.inner().clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let mut added = Vec::new();
        let mut failed = Vec::new();
        for item_id in item_ids {
            let snapshot = match shelf::snapshot_clipboard_item(&st.db, &clip_root, &item_id) {
                Ok(s) => s,
                Err(e) => {
                    failed.push(ShelfFailedEntry::from_error(item_id, &e));
                    continue;
                }
            };
            match snapshot {
                shelf::ClipboardSnapshot::ImagePng { png } => {
                    let _permit = st.acquire_copy_permit();
                    match shelf::add_managed_png(
                        &st.db,
                        &st.root,
                        &png,
                        "剪贴板图片.png",
                        "clipboard",
                        group_id.as_deref(),
                    ) {
                        Ok(item) => added.push(item),
                        Err(e) => failed.push(ShelfFailedEntry::from_error(item_id, &e)),
                    }
                }
                shelf::ClipboardSnapshot::Paths { paths } => {
                    for raw in paths {
                        let result = if storage_mode == shelf::MODE_MANAGED {
                            let _permit = st.acquire_copy_permit();
                            shelf::add_managed(
                                &st.db,
                                &st.root,
                                &raw,
                                "clipboard",
                                group_id.as_deref(),
                            )
                        } else {
                            let _permit = st.acquire_copy_permit();
                            shelf::add_reference(
                                &st.db,
                                &st.root,
                                &raw,
                                "clipboard",
                                group_id.as_deref(),
                            )
                        };
                        match result {
                            Ok(item) => added.push(item),
                            Err(e) => failed.push(ShelfFailedEntry::from_error(raw, &e)),
                        }
                    }
                }
                shelf::ClipboardSnapshot::Text { text } => {
                    match shelf::add_text(&st.db, &text, "clipboard", group_id.as_deref()) {
                        Ok(item) => added.push(item),
                        Err(e) => failed.push(ShelfFailedEntry::from_error(item_id, &e)),
                    }
                }
                shelf::ClipboardSnapshot::Url { url } => {
                    match shelf::add_link(&st.db, &url, group_id.as_deref()) {
                        Ok(item) => added.push(item),
                        Err(e) => failed.push(ShelfFailedEntry::from_error(item_id, &e)),
                    }
                }
                shelf::ClipboardSnapshot::Unsupported { reason } => {
                    // 没有底层 AppError：使用稳定错误码表达「明确不支持」，
                    // 前端仍展示原始 reason。
                    failed.push(ShelfFailedEntry {
                        path: item_id,
                        reason,
                        code: Some("UNSUPPORTED".into()),
                        category: Some("unsupported".into()),
                    });
                }
            }
        }
        ShelfAddReport { added, failed }
    })
    .await
    .map_err(|e| AppError::Agent(format!("添加任务失败: {e}")))?;
    Ok(report)
}

// ── 更新 / 删除 / 清理 ──────────────────────────────────────

#[tauri::command]
pub fn shelf_update(
    state: State<'_, Arc<ShelfState>>,
    id: String,
    patch: ShelfUpdatePatch,
) -> AppResult<shelf::ShelfItem> {
    let st = rt(&state);
    let p = shelf::UpdatePatch {
        display_name: patch.display_name,
        favorite: patch.favorite,
        pinned: patch.pinned,
        group_id: patch.group_id.map(Some),
        note: patch.note,
        expire_at: patch.expire_at,
    };
    shelf::update(&st.db, &id, &p)
}

#[tauri::command]
pub fn shelf_delete(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
    include_protected: bool,
) -> AppResult<shelf::ShelfDeleteReport> {
    let st = rt(&state);
    shelf::delete_items(&st.db, &st.root, &ids, include_protected)
}

#[tauri::command]
pub fn shelf_clear(
    state: State<'_, Arc<ShelfState>>,
    include_protected: bool,
) -> AppResult<shelf::ShelfDeleteReport> {
    let st = rt(&state);
    shelf::clear(&st.db, &st.root, include_protected)
}

// ── 删除撤销（回收站）────────────────────────────────────────

/// 软删除：条目移入回收站（shelf_trash），托管副本在保留期内不删除，可撤销。
#[tauri::command]
pub fn shelf_trash_delete(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
    include_protected: bool,
) -> AppResult<shelf::trash::TrashDeleteReport> {
    shelf::trash::soft_delete(&rt(&state).db, &ids, include_protected)
}

/// 撤销一次删除（按批次恢复条目、标签与项目/任务关联）。
#[tauri::command]
pub fn shelf_trash_restore(
    state: State<'_, Arc<ShelfState>>,
    batch_id: String,
) -> AppResult<shelf::trash::TrashRestoreReport> {
    shelf::trash::restore(&rt(&state).db, batch_id.trim())
}

/// 清理回收站：指定批次或所有已过期批次。删除的是托管副本与快照，不可再撤销。
#[tauri::command]
pub async fn shelf_trash_purge(
    state: State<'_, Arc<ShelfState>>,
    batch_id: Option<String>,
) -> AppResult<shelf::trash::TrashPurgeReport> {
    let st = rt(&state).clone();
    let batch = batch_id
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    tauri::async_runtime::spawn_blocking(move || match batch {
        Some(batch_id) => shelf::trash::purge_batch(&st.db, &st.root, &batch_id),
        None => shelf::trash::purge_expired(&st.db, &st.root),
    })
    .await
    .map_err(|e| AppError::Unavailable(format!("回收站清理任务失败: {e}")))?
}

/// 回收站条数（用于诊断与「可撤销」提示，不暴露内容）。
#[tauri::command]
pub fn shelf_trash_count(state: State<'_, Arc<ShelfState>>) -> AppResult<i64> {
    shelf::trash::count(&rt(&state).db)
}

// ── 外部文件回收站（拖入垃圾桶）──────────────────────────────

/// 受保护目录：应用数据目录（隔离实例走 TASK_DOCK_DATA_DIR）与暂存架根。
fn recycle_protected_dirs(app: &AppHandle, st: &ShelfState) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR").map(std::path::PathBuf::from) {
        dirs.push(dir);
    } else if let Ok(dir) = app.path().app_data_dir() {
        dirs.push(dir);
    }
    dirs.push(st.root.clone());
    dirs
}

/// 只读预览：路径是否可安全移入 Windows 回收站，不执行任何删除。
#[tauri::command]
pub fn shelf_recycle_preview(
    app: AppHandle,
    state: State<'_, Arc<ShelfState>>,
    paths: Vec<String>,
) -> AppResult<shelf::recycle::RecyclePreview> {
    let st = rt(&state);
    Ok(shelf::recycle::preview(
        &paths,
        &recycle_protected_dirs(&app, st),
    ))
}

/// 执行回收站删除：逐项复核确认时的指纹，任何失败只报告，绝不永久删除。
#[tauri::command]
pub async fn shelf_recycle_execute(
    app: AppHandle,
    state: State<'_, Arc<ShelfState>>,
    paths: Vec<String>,
    expected: Vec<shelf::recycle::RecycleExpectation>,
) -> AppResult<shelf::recycle::RecycleReport> {
    let st = rt(&state).clone();
    let protected = recycle_protected_dirs(&app, &st);
    tauri::async_runtime::spawn_blocking(move || {
        shelf::recycle::execute(&paths, &expected, &protected)
    })
    .await
    .map_err(|e| AppError::Unavailable(format!("回收站任务失败: {e}")))?
}

/// 过期清理：dry_run 只返回预览（候选数/释放字节/受保护跳过数）。
/// 默认关闭（shelf_auto_cleanup_enabled），自动路径由调度器调用。
#[tauri::command]
pub fn shelf_cleanup(
    state: State<'_, Arc<ShelfState>>,
    dry_run: bool,
    include_protected: bool,
) -> AppResult<shelf::ShelfCleanupReport> {
    let st = rt(&state);
    let _maintenance = if dry_run {
        None
    } else {
        Some(
            st.try_acquire_maintenance_permit()
                .ok_or_else(|| AppError::Conflict("CLEANUP_BUSY".into()))?,
        )
    };
    let settings = Settings::load(&st.db).unwrap_or_default();
    shelf::cleanup_expired(&st.db, &st.root, &settings, dry_run, include_protected)
}

#[tauri::command]
pub fn shelf_check_exists(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
) -> AppResult<Vec<shelf::ShelfExistsReport>> {
    let st = rt(&state);
    if ids.len() > 500 {
        return Err(AppError::Validation("单批最多检查 500 个条目".into()));
    }
    shelf::check_exists(&st.db, &st.root, &ids)
}

// ── 打开 / 定位 / 预览 ──────────────────────────────────────

/// 打开条目：文件/图片 → 系统默认应用；文件夹 → 资源管理器；
/// 链接 → 统一外部 URL 机制（validate_url，取库内正文，不信任前端回传）。
#[tauri::command]
pub fn shelf_open_item(state: State<'_, Arc<ShelfState>>, id: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let st = rt(&state);
    let item = shelf::item(&st.db, &id)?;
    if item.kind == shelf::KIND_LINK {
        let url = item.content.clone().unwrap_or_default();
        crate::navigation::validate_url(&url)?;
        return st
            .app
            .opener()
            .open_url(url.trim(), None::<&str>)
            .map_err(|e| AppError::Validation(format!("打开链接失败: {e}")));
    }
    let (item, path) = shelf::resolve_item_file(&st.db, &st.root, &id)?;
    if item.kind == shelf::KIND_FOLDER {
        std::process::Command::new("explorer.exe")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::Validation(format!("打开资源管理器失败: {e}")))?;
        return Ok(());
    }
    let target = path.to_string_lossy().to_string();
    crate::navigation::validate_local_path(&target)?;
    st.app
        .opener()
        .open_path(target, None::<&str>)
        .map_err(|e| AppError::Validation(format!("打开文件失败: {e}")))
}

/// 资源管理器定位（/select）；文件夹直接打开所在目录。
#[tauri::command]
pub fn shelf_reveal_item(state: State<'_, Arc<ShelfState>>, id: String) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let st = rt(&state);
    let (item, path) = shelf::resolve_item_file(&st.db, &st.root, &id)?;
    if item.kind == shelf::KIND_FOLDER {
        std::process::Command::new("explorer.exe")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::Validation(format!("打开资源管理器失败: {e}")))?;
        return Ok(());
    }
    let target = path.to_string_lossy().to_string();
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{target}\""))
        .spawn()
        .map_err(|e| AppError::Validation(format!("定位失败: {e}")))?;
    Ok(())
}

/// 单条全量读取（含 content）：列表载荷不带大文本，跨模块转存等需要
/// 完整内容的场景先经此命令取权威行，再消费字段。
#[tauri::command]
pub fn shelf_get_item(
    state: State<'_, Arc<ShelfState>>,
    id: String,
) -> AppResult<shelf::ShelfItem> {
    shelf::item(&rt(&state).db, &id)
}

#[derive(Debug, Serialize)]
pub struct ShelfTextPayload {
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn shelf_read_text(
    state: State<'_, Arc<ShelfState>>,
    id: String,
) -> AppResult<ShelfTextPayload> {
    let st = rt(&state);
    let (content, truncated) = shelf::read_text(&st.db, &st.root, &id)?;
    Ok(ShelfTextPayload { content, truncated })
}

#[tauri::command]
pub fn shelf_read_image(
    state: State<'_, Arc<ShelfState>>,
    id: String,
    full: bool,
) -> AppResult<Option<String>> {
    let st = rt(&state);
    shelf::read_image_data_url(&st.db, &st.root, &id, full)
}

// ── 复制路径 / 复制文件（拖出替代）────────────────────────

fn collect_copy_paths(st: &ShelfState, ids: &[String]) -> AppResult<Vec<String>> {
    let mut paths = Vec::new();
    for id in ids {
        let item = shelf::item(&st.db, id)?;
        match item.storage_mode.as_str() {
            shelf::MODE_MANAGED => {
                let rel = item
                    .managed_path
                    .as_deref()
                    .ok_or_else(|| AppError::Validation("托管条目缺少文件路径".into()))?;
                let abs = st.root.join(shelf::safe_managed_rel(rel)?);
                if abs.exists() {
                    paths.push(abs.to_string_lossy().to_string());
                }
            }
            shelf::MODE_LINK => {
                if let Some(url) = &item.content {
                    paths.push(url.clone());
                }
            }
            _ => {
                if let Some(p) = &item.original_path {
                    if std::path::Path::new(p).exists() {
                        paths.push(p.clone());
                    }
                }
            }
        }
    }
    Ok(paths)
}

/// 复制路径为文本（换行分隔），写入系统剪贴板（自写登记，不回流记录）。
#[tauri::command]
pub fn shelf_copy_paths(state: State<'_, Arc<ShelfState>>, ids: Vec<String>) -> AppResult<u32> {
    let st = rt(&state);
    let paths = collect_copy_paths(st, &ids)?;
    if paths.is_empty() {
        return Err(AppError::Validation("所选条目没有可复制的路径".into()));
    }
    write_system_payload(
        &st.app,
        &ClipboardPayload::Text {
            text: paths.join("\r\n"),
            html: None,
        },
    )
}

/// 复制文件本体（CF_HDROP）到系统剪贴板：资源管理器 Ctrl+V 即得文件。
/// 与原生拖出并存，作为键盘可达与拖拽失败时的回退通道。
#[tauri::command]
pub fn shelf_copy_files(state: State<'_, Arc<ShelfState>>, ids: Vec<String>) -> AppResult<u32> {
    let st = rt(&state);
    let paths: Vec<String> = collect_copy_paths(st, &ids)?
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_file())
        .collect();
    if paths.is_empty() {
        return Err(AppError::Validation("所选条目没有可复制的文件".into()));
    }
    write_system_payload(&st.app, &ClipboardPayload::Files { paths })
}

/// 系统级拖出结果：effect 为目标实际接受的放置效果。
#[derive(Debug, Serialize)]
pub struct ShelfDragOutResult {
    pub effect: String,
    pub count: usize,
    pub missing_ids: Vec<String>,
}

/// 从暂存架卡片发起 Windows 原生文件拖出（OLE DoDragDrop）。
///
/// - 路径只从库内 `resolve_item_file` 解析，前端不能传任意路径；
/// - link/text/missing 条目跳过，全部不可拖才报错；
/// - 托管副本只允许复制，引用模式允许 Windows 默认的复制/移动；
/// - 拖拽必须回到 Tauri 主线程执行：OLE 拖拽循环依赖调用线程的输入队列
///   接管鼠标捕获，后台线程上跑时目标窗口收不到 `DragEnter`，表现为拖了
///   没反应、也画不出跟随光标的文件幽灵。
#[tauri::command]
pub async fn shelf_drag_out(
    app: AppHandle,
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
) -> AppResult<ShelfDragOutResult> {
    if ids.is_empty() {
        return Err(AppError::Validation("没有可拖出的条目".into()));
    }
    let st = rt(&state).clone();
    let mut resolved: Vec<(String, String, std::path::PathBuf)> = Vec::with_capacity(ids.len());
    for id in &ids {
        // 单条失效不阻断其他条目；全部失败时下面统一报错。
        if let Ok((item, path)) = shelf::resolve_item_file(&st.db, &st.root, id) {
            resolved.push((id.clone(), item.storage_mode, path));
        }
    }
    if resolved.is_empty() {
        return Err(AppError::Validation(
            "所选条目没有可拖出的文件（文件可能已失效）".into(),
        ));
    }
    let modes: Vec<&str> = resolved.iter().map(|(_, mode, _)| mode.as_str()).collect();
    let allow_move = shelf::drag_out::allow_move_for(&modes);
    let paths: Vec<std::path::PathBuf> =
        resolved.iter().map(|(_, _, path)| path.clone()).collect();
    let id_by_path: std::collections::HashMap<std::path::PathBuf, String> = resolved
        .into_iter()
        .map(|(id, _, path)| (path, id))
        .collect();

    // 单飞守卫随主线程任务一起持有：命令 future 被丢弃也不会提前放行第二次拖拽。
    let guard = shelf::drag_out::DragInFlightGuard::acquire()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _guard = guard;
        let result = shelf::drag_out::run_drag(&paths, allow_move);
        let _ = tx.send(result);
    })
    .map_err(|e| AppError::Unavailable(format!("无法调度拖拽到主线程: {e}")))?;

    let outcome = rx
        .await
        .map_err(|_| AppError::Unavailable("拖拽任务异常退出".into()))??;
    let missing_ids = outcome
        .missing_paths
        .iter()
        .filter_map(|path| {
            id_by_path
                .get(std::path::Path::new(path))
                .cloned()
        })
        .collect();
    Ok(ShelfDragOutResult {
        effect: outcome.effect,
        count: outcome.count,
        missing_ids,
    })
}

fn write_system_payload(app: &AppHandle, payload: &ClipboardPayload) -> AppResult<u32> {
    let rt = app
        .try_state::<Arc<crate::clipboard::ClipboardRuntime>>()
        .ok_or_else(|| AppError::Unavailable("剪贴板模块未就绪".into()))?;
    crate::clipboard::platform::write_payload_notifying(payload, &rt.self_write)
}

// ── 任务关联 ────────────────────────────────────────────────

#[tauri::command]
pub fn shelf_task_links(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
) -> AppResult<Vec<shelf::ShelfTaskLink>> {
    shelf::task_links(&rt(&state).db, &item_id)
}

#[tauri::command]
pub fn shelf_link_task(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
    task_id: String,
) -> AppResult<()> {
    shelf::link_task(&rt(&state).db, &item_id, &task_id)
}

#[tauri::command]
pub fn shelf_unlink_task(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
    task_id: String,
) -> AppResult<()> {
    shelf::unlink_task(&rt(&state).db, &item_id, &task_id)
}

#[tauri::command]
pub fn shelf_project_links(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
) -> AppResult<Vec<shelf::ShelfProjectLink>> {
    shelf::project_links(&rt(&state).db, &item_id)
}

#[tauri::command]
pub fn shelf_link_project(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
    project_id: String,
) -> AppResult<()> {
    shelf::link_project(&rt(&state).db, &item_id, &project_id)
}

#[tauri::command]
pub fn shelf_unlink_project(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
    project_id: String,
) -> AppResult<()> {
    shelf::unlink_project(&rt(&state).db, &item_id, &project_id)
}

/// 批量关联项目/任务：复用既有关系表，条目级失败以报告返回。
#[tauri::command]
pub fn shelf_batch_link(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
    target: String,
    target_id: String,
) -> AppResult<shelf::batch::BatchLinkReport> {
    shelf::batch::link_many(&rt(&state).db, &ids, &target, &target_id)
}

// ── 标签（v52）：批量打标、最近标签；只存关系 ─────────────────

#[tauri::command]
pub fn shelf_item_tags(
    state: State<'_, Arc<ShelfState>>,
    item_id: String,
) -> AppResult<Vec<String>> {
    shelf::tags::item_tags(&rt(&state).db, &item_id)
}

#[tauri::command]
pub fn shelf_tag_items(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
    tags: Vec<String>,
    mode: String,
) -> AppResult<shelf::tags::TagChangeReport> {
    match mode.as_str() {
        "add" => shelf::tags::add_tags(&rt(&state).db, &ids, &tags),
        "remove" => shelf::tags::remove_tags(&rt(&state).db, &ids, &tags),
        _ => Err(crate::error::AppError::Validation(
            "标签操作必须是 add 或 remove".into(),
        )),
    }
}

#[tauri::command]
pub fn shelf_recent_tags(
    state: State<'_, Arc<ShelfState>>,
    limit: Option<usize>,
) -> AppResult<Vec<shelf::tags::RecentTag>> {
    shelf::tags::recent_tags(&rt(&state).db, limit.unwrap_or(shelf::tags::MAX_RECENT_TAGS))
}

/// 重复内容检测：只提示，不自动合并/删除；结果写回哈希供下次复用。
#[tauri::command]
pub async fn shelf_duplicate_scan(
    state: State<'_, Arc<ShelfState>>,
    ids: Option<Vec<String>>,
) -> AppResult<shelf::dedup::DedupReport> {
    let rt = rt(&state).clone();
    let ids = ids.filter(|v| !v.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        shelf::dedup::scan(&rt.db, &rt.root, ids.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Unavailable(format!("重复检测任务失败: {e}")))?
}

// ── 可选收集规则（P3）：默认关闭，只支持可逆动作 ─────────────

/// 预览规则匹配；`rules` 可传未保存的草稿，省略时读已保存设置。
#[tauri::command]
pub fn shelf_rules_preview(
    state: State<'_, Arc<ShelfState>>,
    rules: Option<serde_json::Value>,
) -> AppResult<shelf::rules::RulePreview> {
    shelf::rules::preview(&rt(&state).db, rules.as_ref())
}

/// 应用已启用规则（加标签 / 归组）。是显式操作，不会在粘贴后自动执行。
#[tauri::command]
pub fn shelf_rules_apply(
    state: State<'_, Arc<ShelfState>>,
    ids: Option<Vec<String>>,
) -> AppResult<shelf::rules::RuleApplyReport> {
    let ids = ids.filter(|v| !v.is_empty());
    shelf::rules::apply(&rt(&state).db, ids.as_deref())
}

/// 对暂存架图片执行本地 OCR（复用剪贴板 OCR 引擎，不新增模型/服务）。
/// 只读取托管副本或引用原图的字节，不改动原图；识别结果由前端决定是否存为文本。
#[tauri::command]
pub async fn shelf_ocr_item(
    app: AppHandle,
    state: State<'_, Arc<ShelfState>>,
    id: String,
    request_id: String,
) -> AppResult<crate::clipboard::ocr::OcrReport> {
    let clipboard = app
        .try_state::<Arc<crate::clipboard::ClipboardRuntime>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| AppError::Unavailable("剪贴板 OCR 服务未就绪".into()))?;
    let st = state.inner().clone();
    let request = request_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let item = shelf::item(&st.db, &id)?;
        if item.kind != shelf::KIND_IMAGE {
            return Err(AppError::Validation("只有图片条目可以提取文字".into()));
        }
        let (_item, path) = shelf::resolve_item_file(&st.db, &st.root, &id)?;
        // 先看文件大小再整读：托管图片上限 2GB，直接 fs::read 会在解码预算检查前
        // 把整个文件读入内存。与剪贴板图片读取上限保持一致（64MB）。
        let size = std::fs::metadata(&path)
            .map(|m| m.len())
            .map_err(|e| AppError::Validation(format!("无法读取图片信息: {e}")))?;
        if size > crate::clipboard::MAX_IMAGE_BYTES as u64 {
            return Ok(crate::clipboard::ocr::OcrReport::too_large_file(size));
        }
        let bytes = std::fs::read(&path)?;
        Ok(clipboard.ocr.recognize_png(&bytes, &request))
    })
    .await
    .map_err(|e| AppError::Agent(format!("OCR 任务失败: {e}")))?
}

#[tauri::command]
pub fn shelf_ocr_cancel(app: AppHandle, request_id: String) -> AppResult<bool> {
    let clipboard = app
        .try_state::<Arc<crate::clipboard::ClipboardRuntime>>()
        .ok_or_else(|| AppError::Unavailable("剪贴板 OCR 服务未就绪".into()))?;
    Ok(clipboard.ocr.cancel(request_id.trim()))
}

// ── 文件操作（移动 / 复制 / 重定位） ────────────────────────

/// 移动原文件/文件夹到目标目录；managed、link、text 明确拒绝。
#[tauri::command]
pub async fn shelf_move_items(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
    target_dir: String,
    conflict_strategy: Option<String>,
    remove_after: Option<bool>,
) -> AppResult<shelf::fsops::ShelfOpReport> {
    let st = state.inner().clone();
    let strategy =
        shelf::fsops::parse_conflict_strategy(conflict_strategy.as_deref().unwrap_or("skip"))?;
    let remove_after = remove_after.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        shelf::fsops::move_items(&st.db, &st.root, &ids, &target_dir, strategy, remove_after)
    })
    .await
    .map_err(|e| AppError::Agent(format!("移动任务失败: {e}")))?
}

/// 复制到目标目录（含托管副本导出）；源文件始终保留。
#[tauri::command]
pub async fn shelf_copy_to(
    state: State<'_, Arc<ShelfState>>,
    ids: Vec<String>,
    target_dir: String,
    conflict_strategy: Option<String>,
    remove_after: Option<bool>,
) -> AppResult<shelf::fsops::ShelfOpReport> {
    let st = state.inner().clone();
    let strategy =
        shelf::fsops::parse_conflict_strategy(conflict_strategy.as_deref().unwrap_or("skip"))?;
    let remove_after = remove_after.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        // 复用现有复制并发闸：整批占用一个名额，避免与托管添加并发叠加 IO。
        let _permit = st.acquire_copy_permit();
        shelf::fsops::copy_items(&st.db, &st.root, &ids, &target_dir, strategy, remove_after)
    })
    .await
    .map_err(|e| AppError::Agent(format!("复制任务失败: {e}")))?
}

/// 失效引用条目重新指向用户选择的外部文件/文件夹。
#[tauri::command]
pub async fn shelf_relocate_item(
    state: State<'_, Arc<ShelfState>>,
    id: String,
    path: String,
) -> AppResult<shelf::ShelfItem> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shelf::fsops::relocate_item(&st.db, &id, &path))
        .await
        .map_err(|e| AppError::Agent(format!("重定位任务失败: {e}")))?
}

#[tauri::command]
pub async fn shelf_recent_dirs(
    state: State<'_, Arc<ShelfState>>,
) -> AppResult<Vec<shelf::fsops::ShelfRecentDir>> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shelf::fsops::list_recent_dirs(&st.db))
        .await
        .map_err(|e| AppError::Agent(format!("读取最近目录失败: {e}")))?
}

#[tauri::command]
pub fn shelf_recent_dir_pin(
    state: State<'_, Arc<ShelfState>>,
    path: String,
    pinned: bool,
) -> AppResult<()> {
    shelf::fsops::set_recent_dir_pinned(&rt(&state).db, &path, pinned)
}

#[tauri::command]
pub fn shelf_recent_dir_remove(state: State<'_, Arc<ShelfState>>, path: String) -> AppResult<()> {
    shelf::fsops::remove_recent_dir(&rt(&state).db, &path)
}

#[tauri::command]
pub fn shelf_recent_dirs_clear(state: State<'_, Arc<ShelfState>>) -> AppResult<()> {
    shelf::fsops::clear_recent_dirs(&rt(&state).db)
}

// ── 快捷投递目标（收集箱「文件投递」子页） ──────────────────
//
// 目标目录一律按 **id** 解析：前端只提交 `target_id` 与被拖入的路径列表，
// 真实目录从数据库读取，避免前端伪造目标路径把文件写到别处。

#[derive(Debug, Deserialize)]
pub struct DropTargetPatchArgs {
    pub name: Option<String>,
    pub path: Option<String>,
    pub show_in_capsule: Option<bool>,
    pub op_mode: Option<String>,
    pub conflict: Option<String>,
}

/// 列表一次探测各目录可用性（`is_dir`）；网络盘可能阻塞，放阻塞线程。
#[tauri::command]
pub async fn shelf_drop_targets_list(
    state: State<'_, Arc<ShelfState>>,
) -> AppResult<Vec<shelf::drop_targets::DropTarget>> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shelf::drop_targets::list(&st.db))
        .await
        .map_err(|e| AppError::Agent(format!("读取投递目标失败: {e}")))?
}

#[tauri::command]
pub async fn shelf_drop_target_create(
    state: State<'_, Arc<ShelfState>>,
    name: Option<String>,
    path: String,
    show_in_capsule: Option<bool>,
    op_mode: Option<String>,
    conflict: Option<String>,
) -> AppResult<shelf::drop_targets::DropTarget> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        shelf::drop_targets::create(
            &st.db,
            &st.root,
            name.as_deref().unwrap_or(""),
            &path,
            show_in_capsule.unwrap_or(true),
            op_mode.as_deref().unwrap_or(shelf::drop_targets::OP_COPY),
            conflict
                .as_deref()
                .unwrap_or(shelf::drop_targets::CONFLICT_RENAME),
        )
    })
    .await
    .map_err(|e| AppError::Agent(format!("添加投递目标失败: {e}")))?
}

#[tauri::command]
pub async fn shelf_drop_target_update(
    state: State<'_, Arc<ShelfState>>,
    id: String,
    patch: DropTargetPatchArgs,
) -> AppResult<shelf::drop_targets::DropTarget> {
    let st = state.inner().clone();
    let patch = shelf::drop_targets::DropTargetPatch {
        name: patch.name,
        path: patch.path,
        show_in_capsule: patch.show_in_capsule,
        op_mode: patch.op_mode,
        conflict: patch.conflict,
    };
    tauri::async_runtime::spawn_blocking(move || {
        shelf::drop_targets::update(&st.db, &st.root, &id, &patch)
    })
    .await
    .map_err(|e| AppError::Agent(format!("更新投递目标失败: {e}")))?
}

/// 只删配置行；真实目录与其内容一律不动。
#[tauri::command]
pub fn shelf_drop_target_delete(state: State<'_, Arc<ShelfState>>, id: String) -> AppResult<()> {
    shelf::drop_targets::delete(&rt(&state).db, &id)
}

#[tauri::command]
pub fn shelf_drop_target_move(
    state: State<'_, Arc<ShelfState>>,
    id: String,
    direction: String,
) -> AppResult<Vec<shelf::drop_targets::DropTarget>> {
    shelf::drop_targets::reorder(&rt(&state).db, &id, &direction)
}

/// 在资源管理器中打开目标目录（目录必须存在；不存在时明确报错，不静默失败）。
#[tauri::command]
pub async fn shelf_drop_target_open(
    state: State<'_, Arc<ShelfState>>,
    id: String,
) -> AppResult<()> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_, dir) = shelf::drop_targets::resolve_dir(&st.db, &st.root, &id)?;
        std::process::Command::new("explorer.exe")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| AppError::Validation(format!("打开资源管理器失败: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Agent(format!("打开目标目录失败: {e}")))?
}

/// 批次标识只用于操作日志归属：限制字符集与长度，避免脏值进入日志查询条件。
fn sanitize_batch_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        cleaned
    }
}

/// 把拖入的文件/文件夹直接投递到某个目标目录。
///
/// - 目标按 id 解析，前端不传目录字符串；
/// - 默认复制且保留源文件；目标配置为 move 时走「同卷改名 / 跨卷复制校验后删源」；
/// - 单条失败不影响其他独立条目，结果逐条返回；
/// - 返回前在 Rust 业务边界写诊断事件（`operation_id = batch_id`）：
///   IPC 成功但存在真实失败时，诊断中心仍能追踪；写日志失败绝不影响投递结果。
#[tauri::command]
pub async fn shelf_drop_to_directory(
    state: State<'_, Arc<ShelfState>>,
    diag: State<'_, Arc<Diagnostics>>,
    target_id: String,
    paths: Vec<String>,
    batch_id: Option<String>,
) -> AppResult<shelf::fsops::DropReport> {
    let st = state.inner().clone();
    let st_for_touch = st.clone();
    let batch = sanitize_batch_id(batch_id.as_deref().unwrap_or(""));
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let target = shelf::drop_targets::get(&st.db, &target_id)?;
        shelf::fsops::drop_paths(&st.db, &st.root, &target, &paths, &batch)
    })
    .await
    .map_err(|e| AppError::Agent(format!("文件投递任务失败: {e}")))?;
    if let Ok(report) = &result {
        if report.success > 0 {
            // 只更新「最近使用」展示时间；写失败不影响已完成的投递。
            shelf::drop_targets::touch_used(&st_for_touch.db, &report.target_id);
        }
        let elapsed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        for event in shelf::fsops::drop_diagnostic_events(report, elapsed) {
            // 非阻塞入队；队列满/日志降级只计数，不改变投递结果。
            let _ = diag.record(event);
        }
    }
    result
}

#[cfg(test)]
mod paste_report_tests {
    use super::*;

    fn item(id: &str) -> shelf::ShelfItem {
        shelf::ShelfItem {
            id: id.into(),
            kind: shelf::KIND_TEXT.into(),
            display_name: "片段".into(),
            source_kind: "clipboard".into(),
            storage_mode: shelf::MODE_REFERENCE.into(),
            original_path: None,
            managed_path: None,
            content: None,
            byte_size: 2,
            file_ext: None,
            favorite: false,
            pinned: false,
            exists_state: "ok".into(),
            group_id: None,
            scene_id: None,
            note: String::new(),
            expire_at: None,
            created_at: "2026-11-14T00:00:00Z".into(),
            updated_at: "2026-11-14T00:00:00Z".into(),
        }
    }

    fn outcome(added: Vec<shelf::ShelfItem>) -> shelf::ingest::IntakeOutcome {
        shelf::ingest::IntakeOutcome {
            content_kind: "text",
            added,
            failed: Vec::new(),
            skipped: 0,
            duplicates: 0,
            failure_code: None,
            retryable: false,
        }
    }

    #[test]
    fn success_has_ids_and_no_partial_flag() {
        let report = paste_report_from(outcome(vec![item("s1")]));
        assert!(report.success);
        assert!(!report.partial);
        assert!(!report.requires_user_action);
        assert_eq!(report.added_ids, vec!["s1".to_string()]);
        assert_eq!(report.source, "clipboard-current");
        assert!(report.code.is_none());
    }

    #[test]
    fn partial_keeps_success_true_and_requires_action() {
        let mut o = outcome(vec![item("s1")]);
        o.skipped = 2;
        o.failed.push(shelf::ingest::IntakeFailure {
            target: "C:/bad.txt".into(),
            reason: "路径不存在".into(),
            code: "NOT_FOUND".into(),
            category: "not_found".into(),
        });
        let report = paste_report_from(o);
        assert!(report.success);
        assert!(report.partial);
        assert!(report.requires_user_action);
        assert_eq!(report.skipped, 2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].code.as_deref(), Some("NOT_FOUND"));
    }

    #[test]
    fn total_failure_is_not_success_and_keeps_code() {
        let mut o = outcome(Vec::new());
        o.failed.push(shelf::ingest::IntakeFailure {
            target: String::new(),
            reason: "剪贴板被其他程序占用".into(),
            code: "CLIPBOARD_BUSY".into(),
            category: "service".into(),
        });
        o.failure_code = Some("CLIPBOARD_BUSY");
        o.retryable = true;
        let report = paste_report_from(o);
        assert!(!report.success);
        assert!(!report.partial);
        assert!(report.requires_user_action);
        assert!(report.retryable);
        assert_eq!(report.code.as_deref(), Some("CLIPBOARD_BUSY"));
    }
}
