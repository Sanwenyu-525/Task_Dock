//! 设置命令：主题/模式/窗口位置/接入参数。
//!
//! P1 修复：update_settings 旧实现不校验值（theme 可写成任意字符串、端口可写 99999、
//! 布尔可写字符串），非法值静默入库破坏运行时；未知键被静默忽略（假报成功）。
//! 现在逐键校验类型/范围/枚举，未知或非法键直接报校验错误。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

/// 允许前端修改的设置键（白名单，防注入任意键）。
const ALLOWED_KEYS: &[&str] = &[
    "theme",
    "mode",
    "material",
    "snap_enabled",
    "autostart",
    "hotkey_enabled",
    "http_enabled",
    "http_port",
    "mock_enabled",
    "notify_reminder",
    "notify_agent",
    "notify_muted",
    "overdue_grace_hours",
    "stale_run_minutes",
    "auto_backup",
    "backup_retain_days",
    // 导航偏好（v0.4）
    "nav_prefer_focus",
    "nav_allow_launch",
    "nav_fallback",
    "nav_remember_window",
    "nav_default_browser",
    "nav_workspace_max",
    // 本地结构化状态（窗口记忆：类名+标题，不含 HWND）
    "nav_window_memory",
    // 智能剪贴板（v0.5）
    "clipboard_enabled",
    "clipboard_paused",
    "clipboard_capture_images",
    "clipboard_capture_files",
    "clipboard_capture_html",
    "clipboard_auto_group",
    "clipboard_group_window_secs",
    "clipboard_retention_days",
    "clipboard_max_items",
    "clipboard_max_storage_mb",
    "clipboard_exclude_apps",
    "clipboard_paste_interval_ms",
    "clipboard_sensitive_filter",
];

fn enum_of(v: &serde_json::Value, key: &str, allowed: &[&str]) -> AppResult<()> {
    let s = v
        .as_str()
        .ok_or_else(|| AppError::Validation(format!("{} 必须是字符串", key)))?;
    if allowed.contains(&s) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "{} 只允许 {} 之一，收到 {:?}",
            key,
            allowed.join(" | "),
            s
        )))
    }
}

fn bool_of(v: &serde_json::Value, key: &str) -> AppResult<()> {
    v.as_bool()
        .map(|_| ())
        .ok_or_else(|| AppError::Validation(format!("{} 必须是布尔值", key)))
}

fn int_in_range(v: &serde_json::Value, key: &str, min: i64, max: i64) -> AppResult<()> {
    let n = v
        .as_i64()
        .ok_or_else(|| AppError::Validation(format!("{} 必须是整数", key)))?;
    if !(min..=max).contains(&n) {
        return Err(AppError::Validation(format!(
            "{} 必须在 {}..={} 之间，收到 {}",
            key, min, max, n
        )));
    }
    Ok(())
}

/// 单键校验：类型、范围、合法枚举值。
pub fn validate_setting(key: &str, v: &serde_json::Value) -> AppResult<()> {
    match key {
        "theme" => enum_of(v, key, &["system", "light", "dark"]),
        "mode" => enum_of(v, key, &["minimal", "compact", "full"]),
        "material" => enum_of(v, key, &["solid", "glass"]),
        "snap_enabled"
        | "autostart"
        | "hotkey_enabled"
        | "http_enabled"
        | "mock_enabled"
        | "notify_reminder"
        | "notify_agent"
        | "notify_muted"
        | "auto_backup"
        | "nav_prefer_focus"
        | "nav_allow_launch"
        | "nav_fallback"
        | "nav_remember_window"
        | "clipboard_enabled"
        | "clipboard_paused"
        | "clipboard_capture_images"
        | "clipboard_capture_files"
        | "clipboard_capture_html"
        | "clipboard_auto_group"
        | "clipboard_sensitive_filter" => bool_of(v, key),
        "http_port" => int_in_range(v, key, 1, 65535),
        "overdue_grace_hours" => int_in_range(v, key, 0, 24 * 60),
        "stale_run_minutes" => int_in_range(v, key, 1, 24 * 60),
        "backup_retain_days" => int_in_range(v, key, 1, 365),
        "nav_workspace_max" => int_in_range(v, key, 1, 20),
        "clipboard_group_window_secs" => int_in_range(v, key, 5, 600),
        "clipboard_retention_days" => int_in_range(v, key, 1, 3650),
        "clipboard_max_items" => int_in_range(v, key, 20, 50_000),
        "clipboard_max_storage_mb" => int_in_range(v, key, 16, 102_400),
        "clipboard_paste_interval_ms" => int_in_range(v, key, 100, 5_000),
        // 排除名单：逗号/换行分隔的 exe 名或路径（长度受限、无控制字符注入）
        "clipboard_exclude_apps" => {
            let s = v.as_str().ok_or_else(|| {
                AppError::Validation("clipboard_exclude_apps 必须是字符串".into())
            })?;
            if s.chars().count() > 4096 {
                return Err(AppError::Validation(
                    "clipboard_exclude_apps 超过 4096 字符".into(),
                ));
            }
            if s.chars()
                .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
            {
                return Err(AppError::Validation(
                    "clipboard_exclude_apps 含非法控制字符".into(),
                ));
            }
            Ok(())
        }
        // 默认浏览器 app_key：指向 navigation_targets 的稳定身份（长度受限的自由字符串）
        "nav_default_browser" => {
            let s = v
                .as_str()
                .ok_or_else(|| AppError::Validation("nav_default_browser 必须是字符串".into()))?;
            if s.chars().count() > 512 {
                return Err(AppError::Validation("nav_default_browser 过长".into()));
            }
            Ok(())
        }
        // 结构化本地状态（非用户偏好）：只验证是对象
        "window_rect" | "snap_state" | "nav_window_memory" => v
            .as_object()
            .map(|_| ())
            .ok_or_else(|| AppError::Validation(format!("{} 必须是 JSON 对象", key))),
        _ => Err(AppError::Validation(format!(
            "未知设置键: {}（允许: {}）",
            key,
            ALLOWED_KEYS.join(", ")
        ))),
    }
}

#[tauri::command]
pub fn get_settings(db: State<'_, Arc<Db>>) -> AppResult<Settings> {
    Settings::load(&db)
}

#[tauri::command]
pub fn update_settings(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    patch: serde_json::Value,
) -> AppResult<Settings> {
    let obj = patch
        .as_object()
        .ok_or_else(|| AppError::Validation("设置必须是 JSON 对象".into()))?;
    // 先整体校验再写入：不留下半应用的脏设置
    for (k, v) in obj {
        validate_setting(k, v)?;
    }
    for (k, v) in obj {
        db.set_setting(k, v.clone())?;
    }
    let updated = Settings::load(&db)?;
    // Hook 上报 CLI 依赖该文件读取端口/令牌/启停（失败不影响设置保存，CLI 会自动走文件回退）
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = crate::agents::hook_cli::write_transport_config(
            &dir,
            updated.http_port,
            &updated.http_token,
            updated.http_enabled,
        );
    }
    Ok(updated)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_are_enforced() {
        assert!(validate_setting("theme", &serde_json::json!("dark")).is_ok());
        assert!(validate_setting("theme", &serde_json::json!("banana")).is_err());
        assert!(validate_setting("mode", &serde_json::json!("compact")).is_ok());
        assert!(validate_setting("material", &serde_json::json!("glass")).is_ok());
        assert!(validate_setting("material", &serde_json::json!(3)).is_err());
    }

    #[test]
    fn booleans_and_ranges_are_enforced() {
        assert!(validate_setting("http_enabled", &serde_json::json!(true)).is_ok());
        assert!(validate_setting("http_enabled", &serde_json::json!("true")).is_err());
        assert!(validate_setting("http_port", &serde_json::json!(47821)).is_ok());
        assert!(validate_setting("http_port", &serde_json::json!(0)).is_err());
        assert!(validate_setting("http_port", &serde_json::json!(65536)).is_err());
        assert!(validate_setting("http_port", &serde_json::json!("47821")).is_err());
        assert!(validate_setting("stale_run_minutes", &serde_json::json!(15)).is_ok());
        assert!(validate_setting("stale_run_minutes", &serde_json::json!(0)).is_err());
        assert!(validate_setting("backup_retain_days", &serde_json::json!(7)).is_ok());
        assert!(validate_setting("backup_retain_days", &serde_json::json!(366)).is_err());
        assert!(validate_setting("overdue_grace_hours", &serde_json::json!(24)).is_ok());
    }

    #[test]
    fn unknown_key_rejected() {
        let err = validate_setting("evil_key", &serde_json::json!(1)).unwrap_err();
        assert!(
            err.to_string().contains("未知设置键"),
            "未知键不得被静默忽略"
        );
    }
}
