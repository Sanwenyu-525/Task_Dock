//! 工作现场命令层：快照 CRUD、当前窗口捕获、后台恢复与取消。
//!
//! 恢复在 `spawn_blocking` 中串行执行（同一时刻只允许一个现场），
//! 前端通过 `workspace-restore-progress` / `workspace-changed` 事件获得逐项结果。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::workspace::{
    self, CaptureInput, RestoreStatus, SnapshotDetail, SnapshotSummary, MAX_SNAPSHOTS,
};

#[tauri::command]
pub fn workspace_list(
    db: State<'_, Arc<Db>>,
    task_id: Option<String>,
) -> AppResult<Vec<SnapshotSummary>> {
    workspace::list_snapshots(&db, task_id.as_deref())
}

#[tauri::command]
pub fn workspace_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<SnapshotDetail> {
    workspace::get_snapshot(&db, &id)
}

#[tauri::command]
pub fn workspace_create(db: State<'_, Arc<Db>>, input: CaptureInput) -> AppResult<SnapshotDetail> {
    workspace::create_snapshot(&db, &input)
}

/// 从任务已关联的导航目标自动生成现场（只读关联表，不启动任何程序）。
#[tauri::command]
pub fn workspace_capture_task(
    db: State<'_, Arc<Db>>,
    task_id: String,
    name: Option<String>,
    note: Option<String>,
) -> AppResult<SnapshotDetail> {
    let name = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "任务现场".to_string());
    workspace::capture_from_task(&db, &task_id, &name, note.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn workspace_rename(
    db: State<'_, Arc<Db>>,
    id: String,
    name: String,
    note: Option<String>,
) -> AppResult<()> {
    workspace::rename_snapshot(&db, &id, &name, note.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn workspace_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    workspace::delete_snapshot(&db, &id)
}

#[tauri::command]
pub fn workspace_prune(db: State<'_, Arc<Db>>, keep: Option<usize>) -> AppResult<usize> {
    workspace::prune_snapshots(&db, keep.unwrap_or(MAX_SNAPSHOTS))
}

#[tauri::command]
pub fn workspace_detach_task(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    workspace::detach_task(&db, &id)
}

/// 当前可捕获窗口（仅身份元数据：标题/类名/exe，不含任何窗口内容）。
#[tauri::command]
pub fn workspace_capture_windows() -> Vec<serde_json::Value> {
    workspace::visible_capture_windows()
}

#[tauri::command]
pub fn workspace_restore(db: State<'_, Arc<Db>>, app: AppHandle, id: String) -> AppResult<bool> {
    workspace::start_restore(db.inner().clone(), app, id)
}

#[tauri::command]
pub fn workspace_restore_cancel() {
    workspace::request_cancel();
}

#[tauri::command]
pub fn workspace_restore_status() -> RestoreStatus {
    workspace::restore_status()
}
