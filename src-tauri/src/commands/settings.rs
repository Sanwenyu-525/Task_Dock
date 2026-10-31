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
    "visual_preset",
    "snap_enabled",
    "autostart",
    "hotkey_enabled",
    "http_enabled",
    "http_port",
    "mock_enabled",
    "notify_reminder",
    "notify_agent",
    "notify_muted",
    "notify_burst_max",
    "notify_rate_window_secs",
    "notify_done_aggregate",
    // Agent 异常（waiting/failed）隐藏态胶囊提示音（v0.6 异常变响）
    "agent_alert_sound",
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
    // 模块独立启停（v0.5.2）
    "workspace_enabled",
    "actions_enabled",
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
    "clipboard_paste_interval_image_ms",
    "clipboard_paste_interval_html_ms",
    "clipboard_paste_interval_files_ms",
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
        "visual_preset" => enum_of(v, key, &["dream-gradient", "liquid-glass"]),
        "snap_enabled"
        | "autostart"
        | "hotkey_enabled"
        | "http_enabled"
        | "mock_enabled"
        | "notify_reminder"
        | "notify_agent"
        | "notify_muted"
        | "notify_done_aggregate"
        | "agent_alert_sound"
        | "auto_backup"
        | "nav_prefer_focus"
        | "nav_allow_launch"
        | "nav_fallback"
        | "nav_remember_window"
        | "workspace_enabled"
        | "actions_enabled"
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
        "notify_burst_max" => int_in_range(v, key, 1, 20),
        "notify_rate_window_secs" => int_in_range(v, key, 10, 3600),
        "backup_retain_days" => int_in_range(v, key, 1, 365),
        "nav_workspace_max" => int_in_range(v, key, 1, 20),
        "clipboard_group_window_secs" => int_in_range(v, key, 5, 600),
        "clipboard_retention_days" => int_in_range(v, key, 1, 3650),
        "clipboard_max_items" => int_in_range(v, key, 20, 50_000),
        "clipboard_max_storage_mb" => int_in_range(v, key, 16, 102_400),
        "clipboard_paste_interval_ms"
        | "clipboard_paste_interval_image_ms"
        | "clipboard_paste_interval_html_ms"
        | "clipboard_paste_interval_files_ms" => int_in_range(v, key, 100, 5_000),
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
    // 剪贴板配置异常时展示为已停用/已暂停，其他模块设置保持原值。
    Settings::load_display(&db)
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
    let updated = Settings::load_display(&db)?;
    // 模块级生命周期：关闭工作现场时停止正在进行的恢复；剪贴板启停同步监听线程
    if obj.contains_key("workspace_enabled") && !updated.workspace_enabled {
        crate::workspace::request_cancel();
    }
    if obj.contains_key("clipboard_enabled") {
        // 不能使用会静默默认的 Settings::load：配置损坏时它会把 enabled 读成 true，
        // 从而在用户不知情时重新开始采集。
        let config = Settings::load_clipboard(&db);
        if config.error.is_none() {
            if let Some(rt) = app.try_state::<Arc<crate::clipboard::ClipboardRuntime>>() {
                rt.inner().set_enabled(config.settings.clipboard_enabled);
            }
        }
    }
    // Hook 上报 CLI 依赖该文件读取端口/令牌/启停（失败不影响设置保存，CLI 会自动走文件回退）
    {
        let dir = crate::app_data_dir(&app);
        let _ = crate::agents::hook_cli::write_transport_config(
            &dir,
            updated.http_port,
            &updated.http_token,
            updated.http_enabled,
        );
    }
    Ok(updated)
}

/// 用户显式修复损坏的剪贴板配置。
///
/// 只重写无法解析的键；原始值备份到 `clipboard_config_corrupt_backup`，
/// 不静默删除。`resume=true` 表示用户明确要求修复后恢复自动记录。
#[tauri::command]
pub fn clipboard_repair_config(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    resume: bool,
) -> AppResult<Settings> {
    let config = Settings::repair_clipboard(&db, resume)?;
    match config.error.as_ref() {
        Some(error) => {
            tracing::warn!("剪贴板配置修复后仍不可用：{}", error.message());
        }
        None => {
            if let Some(rt) = app.try_state::<Arc<crate::clipboard::ClipboardRuntime>>() {
                rt.inner().set_enabled(config.settings.clipboard_enabled);
            }
        }
    }
    Settings::load_display(&db)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// window_rect 持久化的最低可见面积占比（与前端 lib/edgeSnap 口径一致）。
const WINDOW_RECT_VISIBLE_FRACTION: f64 = 0.6;

type MonitorBounds = (i32, i32, u32, u32);

/// rect 在单个显示器边界内的可见面积占比（物理像素，0.0~1.0）。
pub(crate) fn visible_fraction_on(rect: &WindowRect, m: &MonitorBounds) -> f64 {
    if rect.w == 0 || rect.h == 0 {
        return 0.0;
    }
    let ix0 = rect.x.max(m.0);
    let iy0 = rect.y.max(m.1);
    let ix1 = (rect.x + rect.w as i32).min(m.0 + m.2 as i32);
    let iy1 = (rect.y + rect.h as i32).min(m.1 + m.3 as i32);
    let iw = (ix1 - ix0).max(0) as f64;
    let ih = (iy1 - iy0).max(0) as f64;
    (iw * ih) / (rect.w as f64 * rect.h as f64)
}

/// rect 是否「大部分可见」（按全部显示器的可见总面积判定，跨屏窗口同样成立）。
/// 显示器列表为空（断连/获取失败）时保守返回 false。
/// 供 lib.rs 启动恢复与持久化命令共用（前端 lib/edgeSnap 同口径）。
pub(crate) fn is_rect_mostly_visible(rect: &WindowRect, monitors: &[MonitorBounds]) -> bool {
    if monitors.is_empty() || rect.w == 0 || rect.h == 0 {
        return false;
    }
    // visible_fraction_on 返回的是单屏占比（0.0~1.0），求和即「总可见占比」
    let visible: f64 = monitors.iter().map(|m| visible_fraction_on(rect, m)).sum();
    visible >= WINDOW_RECT_VISIBLE_FRACTION
}

#[tauri::command]
pub fn save_window_rect(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    rect: WindowRect,
) -> AppResult<()> {
    // 屏外坐标防御：贴边吸附隐藏、程序 setPosition 竞态等产生的不可见位置
    // 不得进入 window_rect（否则重启恢复会把窗口摆到屏幕外，用户找不回）。
    // 与前端持久化钩子的 isRectMostlyVisible 双保险。
    let monitors: Vec<MonitorBounds> = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    (
                        m.position().x,
                        m.position().y,
                        m.size().width,
                        m.size().height,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    // 拿不到显示器信息时保持旧行为（保存），由前端校验兜底
    if !monitors.is_empty() && !is_rect_mostly_visible(&rect, &monitors) {
        tracing::debug!(
            "拒绝保存屏外 window_rect: x={} y={} w={} h={}",
            rect.x,
            rect.y,
            rect.w,
            rect.h
        );
        return Ok(());
    }
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
        // v0.6 视觉预设：只接受两个已知值，其他一律拒绝（旧库缺失键走默认值）
        assert!(validate_setting("visual_preset", &serde_json::json!("dream-gradient")).is_ok());
        assert!(validate_setting("visual_preset", &serde_json::json!("liquid-glass")).is_ok());
        assert!(validate_setting("visual_preset", &serde_json::json!("neon")).is_err());
        assert!(validate_setting("visual_preset", &serde_json::json!(null)).is_err());
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

    #[test]
    fn window_rect_visibility_math() {
        let main = (0i32, 0i32, 1920u32, 1080u32);
        let left = (-1920i32, 0i32, 1920u32, 1080u32);
        // 完全在屏内
        assert!(is_rect_mostly_visible(
            &WindowRect {
                x: 100,
                y: 100,
                w: 400,
                h: 560
            },
            &[main]
        ));
        // 跨屏（主副屏各占 50%）按可见总面积判定 → 有效
        assert!(is_rect_mostly_visible(
            &WindowRect {
                x: -200,
                y: 100,
                w: 400,
                h: 560
            },
            &[main, left]
        ));
        // 贴边隐藏位（滑出左缘只留 12px）→ 拒绝
        assert!(!is_rect_mostly_visible(
            &WindowRect {
                x: -388,
                y: 300,
                w: 400,
                h: 560
            },
            &[main]
        ));
        // 显示器断连（空列表）→ 保守拒绝
        assert!(!is_rect_mostly_visible(
            &WindowRect {
                x: 100,
                y: 100,
                w: 400,
                h: 560
            },
            &[]
        ));
        // 无效矩形
        assert!(!is_rect_mostly_visible(
            &WindowRect {
                x: 0,
                y: 0,
                w: 0,
                h: 100
            },
            &[main]
        ));
        // 可见占比不足 60%
        assert!(!is_rect_mostly_visible(
            &WindowRect {
                x: 1200,
                y: 100,
                w: 1920,
                h: 560
            },
            &[main]
        ));
    }
}
