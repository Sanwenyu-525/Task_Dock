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
pub fn fs_list_dir(path: String, show_hidden: bool) -> AppResult<fw::DirListing> {
    fw::list_dir(&fw::validate_abs_path(&path)?, show_hidden)
}

#[tauri::command]
pub fn fs_dir_signature(path: String) -> AppResult<fw::DirSignature> {
    Ok(fw::dir_signature(&fw::validate_abs_path(&path)?))
}

#[tauri::command]
pub fn fs_places() -> AppResult<Vec<fw::Place>> {
    let mut places = fw::quick_places();
    places.extend(fw::drives());
    Ok(places)
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
macro_rules! fs_blocking {
    ($app:expr, $paths:expr, $body:expr) => {{
        let protected = protected_dirs(&$app);
        let paths = $paths;
        tauri::async_runtime::spawn_blocking(move || $body(paths, &protected))
            .await
            .map_err(|e| AppError::Agent(format!("文件操作任务失败: {e}")))?
    }};
}

#[tauri::command]
pub async fn fs_copy_paths(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
) -> AppResult<FsOpReport> {
    let target = fw::validate_abs_path(&target_dir)?;
    let conflict = fw::parse_conflict(&conflict)?;
    fs_blocking!(app, paths, |paths: Vec<String>,
                              protected: &Vec<PathBuf>| {
        fw::copy_paths(&paths, &target, conflict, protected)
    })
}

#[tauri::command]
pub async fn fs_move_paths(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: String,
) -> AppResult<FsOpReport> {
    let target = fw::validate_abs_path(&target_dir)?;
    let conflict = fw::parse_conflict(&conflict)?;
    fs_blocking!(app, paths, |paths: Vec<String>,
                              protected: &Vec<PathBuf>| {
        fw::move_paths(&paths, &target, conflict, protected)
    })
}

#[tauri::command]
pub async fn fs_delete_paths(
    app: AppHandle,
    paths: Vec<String>,
    permanent: bool,
) -> AppResult<FsOpReport> {
    fs_blocking!(app, paths, |paths: Vec<String>,
                              protected: &Vec<PathBuf>| {
        fw::delete_paths(&paths, permanent, protected)
    })
}

#[tauri::command]
pub fn fs_stat(paths: Vec<String>) -> AppResult<Vec<fw::FsStat>> {
    if paths.len() > fw::MAX_OP_PATHS {
        return Err(AppError::Validation(format!(
            "单批最多 {} 项",
            fw::MAX_OP_PATHS
        )));
    }
    Ok(paths.iter().map(|p| fw::stat_path(p)).collect())
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
pub fn fs_reveal(path: String) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let target = crate::navigation::validate_local_path(&path)?;
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
pub async fn fs_thumbnail(path: String, max_px: u32) -> AppResult<Option<String>> {
    let path = fw::validate_abs_path(&path)?;
    match fw::thumbnail::thumbnail_png(path, max_px).await {
        Some(bytes) => Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ))),
        None => Ok(None),
    }
}
