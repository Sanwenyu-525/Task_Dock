//! 专注与休息命令：状态查询、会话控制、历史与偏好。
//!
//! 全部状态在 Rust 侧权威维护；前端只读快照 + 共享时钟推算展示。
//! 结束专注不会改动任务状态（不调用 tasks 的 toggle/update）。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::focus::{
    FocusHistoryItem, FocusPrefs, FocusPrefsPatch, FocusSnapshot,
};

#[tauri::command]
pub fn focus_snapshot(db: State<'_, Arc<Db>>) -> AppResult<FocusSnapshot> {
    crate::focus::snapshot(db.as_ref())
}

#[tauri::command]
pub fn focus_history(
    db: State<'_, Arc<Db>>,
    limit: Option<u32>,
) -> AppResult<Vec<FocusHistoryItem>> {
    crate::focus::history(db.as_ref(), limit.unwrap_or(20))
}

#[tauri::command]
pub fn focus_start(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    task_id: Option<String>,
) -> AppResult<FocusSnapshot> {
    crate::focus::start(&app, db.as_ref(), task_id)
}

#[tauri::command]
pub fn focus_start_break(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<FocusSnapshot> {
    crate::focus::start_break(&app, db.as_ref())
}

#[tauri::command]
pub fn focus_pause(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<FocusSnapshot> {
    crate::focus::pause(&app, db.as_ref())
}

#[tauri::command]
pub fn focus_resume(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<FocusSnapshot> {
    crate::focus::resume(&app, db.as_ref())
}

#[tauri::command]
pub fn focus_finish(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<FocusSnapshot> {
    crate::focus::finish(&app, db.as_ref())
}

#[tauri::command]
pub fn focus_cancel(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<FocusSnapshot> {
    crate::focus::cancel(&app, db.as_ref())
}

#[tauri::command]
pub fn focus_extend_break(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    minutes: u32,
) -> AppResult<FocusSnapshot> {
    crate::focus::extend_break(&app, db.as_ref(), minutes)
}

#[tauri::command]
pub fn focus_skip_break(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<FocusSnapshot> {
    crate::focus::skip_break(&app, db.as_ref())
}

#[tauri::command]
pub fn focus_update_prefs(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    patch: FocusPrefsPatch,
) -> AppResult<FocusPrefs> {
    crate::focus::update_prefs(&app, db.as_ref(), patch)
}

#[tauri::command]
pub fn focus_snooze_sedentary(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    minutes: u32,
) -> AppResult<FocusSnapshot> {
    crate::focus::snooze_sedentary(&app, db.as_ref(), minutes)
}
