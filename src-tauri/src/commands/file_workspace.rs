//! 文件工作区命令层：目录浏览、文件操作、缩略图。
//!
//! 与核心层的分工：命令层只做参数解析、受保护目录解析（应用数据目录）与
//! 打开/定位（opener / explorer），文件语义全部在 `file_workspace::` 核心。

use std::path::PathBuf;

use base64::Engine as _;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::file_workspace::{self as fw, FsOpReport};

/// 受保护目录：应用数据目录（隔离实例时为 TASK_DOCK_DATA_DIR）。
/// 文件工作区绝不读写自身数据目录（暂存架托管清理等内部语义不在此展开）。
fn protected_dirs(app: &AppHandle) -> Vec<PathBuf> {
    std::env::var_os("TASK_DOCK_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .into_iter()
        .collect()
}

#[tauri::command]
pub async fn fs_list_dir(
    app: AppHandle,
    path: String,
    show_hidden: bool,
    offset: Option<usize>,
) -> AppResult<fw::DirListing> {
    let path = fw::validate_abs_path(&path)?;
    // 只读命令同样要过受保护目录边界：目录列举会暴露应用数据目录里的
    // 数据库文件名、备份与 TLS 私钥目录结构，不能因为「不写文件」就放开。
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    let offset = offset.unwrap_or(0).min(fw::MAX_LIST_OFFSET);
    // 目录 IO 可能落在慢速/网络盘上：放到阻塞线程，避免占住 IPC 线程。
    tauri::async_runtime::spawn_blocking(move || fw::list_dir(&path, show_hidden, offset))
        .await
        .map_err(|e| AppError::Agent(format!("列目录任务失败: {e}")))?
}

#[tauri::command]
pub async fn fs_dir_signature(app: AppHandle, path: String) -> AppResult<fw::DirSignature> {
    let path = fw::validate_abs_path(&path)?;
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    tauri::async_runtime::spawn_blocking(move || fw::dir_signature(&path))
        .await
        .map_err(|e| AppError::Agent(format!("目录签名任务失败: {e}")))
}

#[tauri::command]
pub fn fs_places() -> AppResult<Vec<fw::Place>> {
    let mut places = fw::quick_places();
    places.extend(fw::drives());
    Ok(places)
}

/// 真实卷键（Volume GUID / 卷挂载根）；用于前端判断同卷默认移动、跨卷默认复制。
#[tauri::command]
pub fn fs_volume_keys(paths: Vec<String>) -> AppResult<Vec<Option<String>>> {
    if paths.len() > fw::MAX_OP_PATHS {
        return Err(AppError::Validation(format!("单批最多 {} 项", fw::MAX_OP_PATHS)));
    }
    Ok(fw::volume::volume_keys(&paths))
}

#[tauri::command]
pub fn fs_create_dir(app: AppHandle, parent: String, name: String) -> AppResult<String> {
    let parent = fw::validate_abs_path(&parent)?;
    fw::ensure_not_protected(&parent, &protected_dirs(&app))?;
    let target = fw::create_dir(&parent, &name)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_create_file(app: AppHandle, parent: String, name: String) -> AppResult<String> {
    let parent = fw::validate_abs_path(&parent)?;
    fw::ensure_not_protected(&parent, &protected_dirs(&app))?;
    let target = fw::create_file(&parent, &name)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_rename(app: AppHandle, path: String, new_name: String) -> AppResult<String> {
    let path = fw::validate_abs_path(&path)?;
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    let target = fw::rename(&path, &new_name)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 阻塞文件操作统一放阻塞线程（复制大目录不卡 async runtime）。
/// 宏必须定义在使用点之前；受保护目录在进入阻塞线程前解析一次。
macro_rules! fs_blocking {
    ($app:expr, $paths:expr, $body:expr) => {{
        let protected = protected_dirs(&$app);
        let paths = $paths;
        tauri::async_runtime::spawn_blocking(move || $body(paths, &protected))
            .await
            .map_err(|e| AppError::Agent(format!("文件操作任务失败: {e}")))?
    }};
}

/// 批量重命名（阻塞线程执行；逐项结果 + 真实部分失败，不静默覆盖）。
#[tauri::command]
pub async fn fs_batch_rename(
    app: AppHandle,
    items: Vec<fw::BatchRenameItem>,
    operation_id: Option<String>,
) -> AppResult<FsOpReport> {
    let started = std::time::Instant::now();
    let report = fs_blocking!(
        app,
        items,
        |items: Vec<fw::BatchRenameItem>, protected: &Vec<PathBuf>| {
            fw::batch_rename(&items, protected, operation_id.clone())
        }
    );
    emit_op_diagnostics(&report, "workspace_batch_rename", "rename", started.elapsed());
    Ok(report)
}

/// 只读 SHA-256（用户显式触发文件夹对比时调用；不打开目录即扫描）。
#[tauri::command]
pub async fn fs_hash_files(app: AppHandle, paths: Vec<String>) -> AppResult<Vec<fw::FsHashEntry>> {
    if paths.len() > fw::MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            fw::MAX_OP_PATHS
        )));
    }
    let result = fs_blocking!(app, paths, |paths: Vec<String>, protected: &Vec<PathBuf>| {
        fw::hash_files(&paths, protected)
    });
    Ok(result)
}

#[tauri::command]
pub async fn fs_copy_paths(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
    operation_id: Option<String>,
) -> AppResult<FsOpReport> {
    let target = fw::validate_abs_path(&target_dir)?;
    let conflict = fw::parse_conflict(&conflict)?;
    let started = std::time::Instant::now();
    let report = fs_blocking!(app, paths, |paths: Vec<String>,
                                                  protected: &Vec<PathBuf>| {
        fw::copy_paths(&paths, &target, conflict, operation_id.clone(), protected)
    })?;
    emit_op_diagnostics(&report, "workspace_copy", "copy", started.elapsed());
    Ok(report)
}

#[tauri::command]
pub async fn fs_move_paths(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
    operation_id: Option<String>,
) -> AppResult<FsOpReport> {
    let target = fw::validate_abs_path(&target_dir)?;
    let conflict = fw::parse_conflict(&conflict)?;
    let started = std::time::Instant::now();
    let report = fs_blocking!(app, paths, |paths: Vec<String>,
                                                  protected: &Vec<PathBuf>| {
        fw::move_paths(&paths, &target, conflict, operation_id.clone(), protected)
    })?;
    emit_op_diagnostics(&report, "workspace_move", "move", started.elapsed());
    Ok(report)
}

#[tauri::command]
pub async fn fs_delete_paths(
    app: AppHandle,
    paths: Vec<String>,
    permanent: bool,
    operation_id: Option<String>,
) -> AppResult<FsOpReport> {
    let started = std::time::Instant::now();
    let report = fs_blocking!(app, paths, |paths: Vec<String>,
                                                protected: &Vec<PathBuf>| {
        fw::delete_paths(&paths, permanent, operation_id.clone(), protected)
    })?;
    emit_op_diagnostics(
        &report,
        "workspace_delete",
        if permanent { "permanent" } else { "recycle" },
        started.elapsed(),
    );
    Ok(report)
}

/// 业务层权威结果写入诊断：成功也记一条 INFO（部分失败必须在诊断中心可见，
/// 不能只靠 Toast —— `Ok(report)` 对 IPC 是成功，对业务可能是部分失败）。
///
/// 计时从进入本命令算起（含阻塞线程排队），只用于定位「慢在哪一步」。
fn emit_op_diagnostics(
    report: &FsOpReport,
    action: &str,
    mode: &str,
    elapsed: std::time::Duration,
) {
    let duration_ms = elapsed.as_millis().min(u128::from(u64::MAX)) as u64;
    for event in fw::op_diagnostic_events(report, action, mode, duration_ms) {
        crate::diagnostics::emit(event);
    }
}

#[tauri::command]
pub async fn fs_stat(app: AppHandle, paths: Vec<String>) -> AppResult<Vec<fw::FsStat>> {
    if paths.len() > fw::MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            fw::MAX_OP_PATHS
        )));
    }
    let protected = protected_dirs(&app);
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<fw::FsStat>> {
        let mut out = Vec::with_capacity(paths.len());
        for raw in paths {
            let path = fw::validate_abs_path(&raw)?;
            fw::ensure_not_protected(&path, &protected)?;
            out.push(fw::stat_path(&path.to_string_lossy()));
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Agent(format!("读取属性任务失败: {e}")))?
}

/// 用系统默认程序打开文件/目录（opener 插件；路径先过本地路径校验）。
#[tauri::command]
pub fn fs_open(app: AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let target = crate::navigation::validate_local_path(&path)?;
    fw::ensure_not_protected(&target, &protected_dirs(&app))?;
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Validation(format!("打开失败: {e}")))
}

/// 在资源管理器中定位（explorer /select）；目录直接打开目录本身。
#[tauri::command]
pub fn fs_reveal(app: AppHandle, path: String) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let target = crate::navigation::validate_local_path(&path)?;
    fw::ensure_not_protected(&target, &protected_dirs(&app))?;
    if target.is_dir() {
        std::process::Command::new("explorer.exe")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| AppError::Validation(format!("打开资源管理器失败: {e}")))?;
        return Ok(());
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", target.to_string_lossy()))
        .spawn()
        .map_err(|e| AppError::Validation(format!("定位失败: {e}")))?;
    Ok(())
}

/// 缩略图（PNG data URL）；无处理器/失败返回 None（前端回落类型图标，不伪造占位成功）。
/// 并发上限与 LRU 缓存都在核心层（信号量 4 / 缓存 256）。
#[tauri::command]
pub async fn fs_thumbnail(app: AppHandle, path: String, max_px: u32) -> AppResult<Option<String>> {
    let path = fw::validate_abs_path(&path)?;
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    match fw::thumbnail::thumbnail_png(path, max_px).await {
        Some(bytes) => Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ))),
        None => Ok(None),
    }
}

/// 大图快速预览（不写 256px LRU 缓存，单张按需解码）。
#[tauri::command]
pub async fn fs_preview_image(app: AppHandle, path: String) -> AppResult<Option<String>> {
    let path = fw::validate_abs_path(&path)?;
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    match fw::thumbnail::preview_png(path, 1400).await {
        Some(bytes) => Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ))),
        None => Ok(None),
    }
}

/// 文本/代码只读预览（前 512 KiB，最多 2 MiB；二进制拒绝）。
#[tauri::command]
pub fn fs_read_text(app: AppHandle, path: String, max_bytes: Option<usize>) -> AppResult<fw::FsTextPreview> {
    let path = fw::validate_abs_path(&path)?;
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    fw::read_text_preview(&path, max_bytes.unwrap_or(512 * 1024))
}

/// 视频/音频快速预览 URL：短期 token + 自定义协议，支持 Range；不扩大 asset 协议范围。
#[tauri::command]
pub fn fs_preview_media_url(app: AppHandle, path: String) -> AppResult<String> {
    let path = fw::validate_abs_path(&path)?;
    fw::ensure_not_protected(&path, &protected_dirs(&app))?;
    fw::preview::register_media_url(&path)
}

/// 关闭/切换预览时释放媒体 token；失败不影响关闭流程。
#[tauri::command]
pub fn fs_release_preview_url(url: String) -> AppResult<()> {
    fw::preview::release_media_url(&url)
}
