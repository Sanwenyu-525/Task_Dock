//! 设置命令：主题/模式/窗口位置/接入参数。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use crate::db::{Db, Settings};
use crate::error::{AppResult};

/// 允许前端修改的设置键（白名单，防注入任意键）。
const ALLOWED_KEYS: &[&str] = &[
    "theme", "mode", "material", "snap_enabled", "autostart", "hotkey_enabled",
    "http_enabled", "http_port", "mock_enabled",
    "notify_reminder", "notify_agent", "notify_muted",
    "overdue_grace_hours", "stale_run_minutes",
    "auto_backup", "backup_retain_days",
];

#[tauri::command]
pub fn get_settings(db: State<'_, Arc<Db>>) -> AppResult<Settings> {
    Settings::load(&db)
}

#[tauri::command]
pub fn update_settings(db: State<'_, Arc<Db>>, patch: serde_json::Value) -> AppResult<Settings> {
    let obj = patch
        .as_object()
        .ok_or_else(|| crate::error::AppError::Validation("设置必须是 JSON 对象".into()))?;
    for (k, v) in obj {
        if ALLOWED_KEYS.contains(&k.as_str()) {
            db.set_setting(k, v.clone())?;
        }
    }
    Settings::load(&db)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[tauri::command]
pub fn save_window_rect(db: State<'_, Arc<Db>>, rect: WindowRect) -> AppResult<()> {
    db.set_setting("window_rect", serde_json::to_value(&rect)?)
}

#[tauri::command]
pub fn get_window_rect(db: State<'_, Arc<Db>>) -> AppResult<Option<WindowRect>> {
    let v = db.get_setting("window_rect")?;
    match v {
        Some(v) => Ok(serde_json::from_value(v).ok()),
        None => Ok(None),
    }
}
