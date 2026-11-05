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
use crate::error::{AppError, AppResult};
use crate::shelf::{self, ShelfState};

#[derive(Debug, Serialize)]
pub struct ShelfFailedEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct ShelfAddReport {
    pub added: Vec<shelf::ShelfItem>,
    pub failed: Vec<ShelfFailedEntry>,
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
) -> AppResult<shelf::ShelfPage> {
    let st = rt(&state);
    let filter = shelf::ListFilter {
        search,
        kind: kind.unwrap_or_else(|| "all".into()),
        group_id: group_id.unwrap_or_else(|| "all".into()),
        favorite_only: favorite_only.unwrap_or(false),
        limit: limit.unwrap_or(100),
        offset: offset.unwrap_or(0),
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
                shelf::add_reference(&st.db, &st.root, &raw, source, group_id.as_deref())
            };
            match result {
                Ok(item) => added.push(item),
                Err(e) => failed.push(ShelfFailedEntry {
                    path: raw,
                    reason: e.to_string(),
                }),
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
                    failed.push(ShelfFailedEntry {
                        path: item_id,
                        reason: e.to_string(),
                    });
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
                        Err(e) => failed.push(ShelfFailedEntry {
                            path: item_id,
                            reason: e.to_string(),
                        }),
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
                            Err(e) => failed.push(ShelfFailedEntry {
                                path: raw,
                                reason: e.to_string(),
                            }),
                        }
                    }
                }
                shelf::ClipboardSnapshot::Text { text } => {
                    match shelf::add_text(&st.db, &text, "clipboard", group_id.as_deref()) {
                        Ok(item) => added.push(item),
                        Err(e) => failed.push(ShelfFailedEntry {
                            path: item_id,
                            reason: e.to_string(),
                        }),
                    }
                }
                shelf::ClipboardSnapshot::Url { url } => {
                    match shelf::add_link(&st.db, &url, group_id.as_deref()) {
                        Ok(item) => added.push(item),
                        Err(e) => failed.push(ShelfFailedEntry {
                            path: item_id,
                            reason: e.to_string(),
                        }),
                    }
                }
                shelf::ClipboardSnapshot::Unsupported { reason } => {
                    failed.push(ShelfFailedEntry {
                        path: item_id,
                        reason,
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

/// 过期清理：dry_run 只返回预览（候选数/释放字节/受保护跳过数）。
/// 默认关闭（shelf_auto_cleanup_enabled），自动路径由调度器调用。
#[tauri::command]
pub fn shelf_cleanup(
    state: State<'_, Arc<ShelfState>>,
    dry_run: bool,
    include_protected: bool,
) -> AppResult<shelf::ShelfCleanupReport> {
    let st = rt(&state);
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
pub fn shelf_get_item(state: State<'_, Arc<ShelfState>>, id: String) -> AppResult<shelf::ShelfItem> {
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
    write_system_payload(&st.app, &ClipboardPayload::Text {
        text: paths.join("\r\n"),
        html: None,
    })
}

/// 复制文件本体（CF_HDROP）到系统剪贴板：资源管理器 Ctrl+V 即得文件。
/// 这是系统级拖出未实现前的可用替代。
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

fn write_system_payload(
    app: &AppHandle,
    payload: &ClipboardPayload,
) -> AppResult<u32> {
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
    tauri::async_runtime::spawn_blocking(move || {
        shelf::fsops::relocate_item(&st.db, &id, &path)
    })
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
