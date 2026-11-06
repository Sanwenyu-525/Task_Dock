//! 资源清理 IPC：文件枚举和删除均放到 blocking worker，避免阻塞 WebView 主线程。

use std::sync::Arc;

use tauri::State;

use crate::audio::AudioService;
use crate::clipboard::ClipboardRuntime;
use crate::error::{AppError, AppResult};
use crate::resource_cleanup::{
    Category, ExecutionReport, Preview, ResourceCleanupState, ResourceSnapshot,
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
