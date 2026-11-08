//! 资源清理 IPC：文件枚举和删除均放到 blocking worker，避免阻塞 WebView 主线程。

use std::sync::Arc;

use tauri::State;

use crate::audio::AudioService;
use crate::clipboard::ClipboardRuntime;
use crate::error::{AppError, AppResult};
use crate::resource_cleanup::{
    Category, DiskScanReport, ExecutionReport, JunkCategory, JunkExecutionReport, JunkPreview,
    MemoryCatalog, MemoryReleaseReport, Preview, ProcessDiagnostics, ResourceCleanupState,
    ResourceSnapshot, StorageBreakdown,
};
use crate::shelf::ShelfState;

#[tauri::command]
pub async fn resource_snapshot(
    state: State<'_, Arc<ResourceCleanupState>>,
    clipboard: State<'_, Arc<ClipboardRuntime>>,
    shelf: State<'_, Arc<ShelfState>>,
    audio: State<'_, Arc<AudioService>>,
) -> AppResult<ResourceSnapshot> {
    let state = Arc::clone(&state);
    let clipboard = Arc::clone(&clipboard);
    let shelf = Arc::clone(&shelf);
    let audio = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || state.snapshot(&clipboard, &shelf, &audio))
        .await
        .map_err(|error| AppError::Unavailable(format!("资源快照线程异常: {error}")))
}

#[tauri::command]
pub async fn resource_cleanup_preview(
    state: State<'_, Arc<ResourceCleanupState>>,
    clipboard: State<'_, Arc<ClipboardRuntime>>,
    shelf: State<'_, Arc<ShelfState>>,
    audio: State<'_, Arc<AudioService>>,
    categories: Vec<Category>,
) -> AppResult<Preview> {
    let state = Arc::clone(&state);
    let clipboard = Arc::clone(&clipboard);
    let shelf = Arc::clone(&shelf);
    let audio = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || {
        state.preview(categories, &clipboard, &shelf, &audio)
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("资源扫描线程异常: {error}")))?
}

#[tauri::command]
pub async fn resource_cleanup_execute(
    state: State<'_, Arc<ResourceCleanupState>>,
    clipboard: State<'_, Arc<ClipboardRuntime>>,
    shelf: State<'_, Arc<ShelfState>>,
    audio: State<'_, Arc<AudioService>>,
    preview_id: String,
    categories: Vec<Category>,
) -> AppResult<ExecutionReport> {
    let state = Arc::clone(&state);
    let clipboard = Arc::clone(&clipboard);
    let shelf = Arc::clone(&shelf);
    let audio = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || {
        state.execute(preview_id, categories, &clipboard, &shelf, &audio)
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("资源清理线程异常: {error}")))?
}

/// 只读进程诊断：一次性枚举 + 指标读取，不结束进程、不读取命令行。
/// 冷启动为取 CPU 差分会在 blocking worker 内短采样一次（约 200ms），不阻塞主线程。
#[tauri::command]
pub async fn resource_process_diagnostics(
    state: State<'_, Arc<ResourceCleanupState>>,
) -> AppResult<ProcessDiagnostics> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.process_diagnostics())
        .await
        .map_err(|error| AppError::Unavailable(format!("进程诊断线程异常: {error}")))
}

/// 只读磁盘占用分布：只扫描应用数据目录，有界且不跟随链接。
#[tauri::command]
pub async fn resource_disk_usage(
    state: State<'_, Arc<ResourceCleanupState>>,
) -> AppResult<StorageBreakdown> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .disk_usage()
            .ok_or_else(|| AppError::Unavailable("资源目录未配置".into()))
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("磁盘占用扫描线程异常: {error}")))?
}

/// 只读磁盘空间分析：统计指定目录的直接子目录占用与最大文件。
/// 只读元数据；不删除、不写入、不打开文件内容；有界并可能返回 `truncated`。
#[tauri::command]
pub async fn resource_disk_analyze(path: String) -> AppResult<DiskScanReport> {
    tauri::async_runtime::spawn_blocking(move || crate::resource_cleanup::analyze_disk(&path))
        .await
        .map_err(|error| AppError::Unavailable(format!("空间分析线程异常: {error}")))?
}

/// 扫描用户级磁盘垃圾（回收站 / 临时文件 / 崩溃转储）：只读，不删除。
#[tauri::command]
pub async fn resource_junk_preview(
    state: State<'_, Arc<ResourceCleanupState>>,
    categories: Vec<JunkCategory>,
) -> AppResult<JunkPreview> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.preview_user_junk(categories))
        .await
        .map_err(|error| AppError::Unavailable(format!("垃圾扫描线程异常: {error}")))?
}

/// 执行用户级磁盘垃圾清理：只接受服务端预览 ID，预览一次性消费。
#[tauri::command]
pub async fn resource_junk_execute(
    state: State<'_, Arc<ResourceCleanupState>>,
    preview_id: String,
    categories: Vec<JunkCategory>,
) -> AppResult<JunkExecutionReport> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.execute_user_junk(preview_id, categories))
        .await
        .map_err(|error| AppError::Unavailable(format!("垃圾清理线程异常: {error}")))?
}

/// 应用自身可回收内存缓存目录（只读）。
#[tauri::command]
pub async fn resource_memory_catalog(
    state: State<'_, Arc<ResourceCleanupState>>,
    audio: State<'_, Arc<AudioService>>,
) -> AppResult<MemoryCatalog> {
    let state = Arc::clone(&state);
    let audio = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || state.memory_catalog(&audio))
        .await
        .map_err(|error| AppError::Unavailable(format!("内存目录线程异常: {error}")))
}

/// 释放应用自身的可回收内存缓存；返回每项实际释放量。
#[tauri::command]
pub async fn resource_memory_release(
    state: State<'_, Arc<ResourceCleanupState>>,
    audio: State<'_, Arc<AudioService>>,
) -> AppResult<MemoryReleaseReport> {
    let state = Arc::clone(&state);
    let audio = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || state.release_memory(&audio))
        .await
        .map_err(|error| AppError::Unavailable(format!("内存释放线程异常: {error}")))
}
