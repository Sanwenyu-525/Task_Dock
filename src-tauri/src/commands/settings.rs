//! 设置命令：主题/模式/窗口位置/接入参数。
//!
//! P1 修复：update_settings 旧实现不校验值（theme 可写成任意字符串、端口可写 99999、
//! 布尔可写字符串），非法值静默入库破坏运行时；未知键被静默忽略（假报成功）。
//! 现在逐键校验类型/范围/枚举，未知或非法键直接报校验错误。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

use crate::db::{normalized_visual_preset, Db, Settings};
use crate::error::{AppError, AppResult};

/// 允许前端修改的设置键（白名单，防注入任意键）。
const ALLOWED_KEYS: &[&str] = &[
    "theme",
    "mode",
    "material",
    "visual_preset",
    // 已废弃（2026-11）：清透预设下线后不再读取；保留键以兼容旧前端/旧备份，
    // 不做破坏性删除。
    "clear_foreground",
    "snap_enabled",
    "snap_display_mode",
    "autostart",
    "hotkey_enabled",
    "http_enabled",
    "http_port",
    // Agent MCP Server（v37）：外部 MCP 客户端 loopback bridge 开关，默认关闭
    "mcp_server_enabled",
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
    "clipboard_ocr_auto",
    // 全局快速捕获（v0.7）：上次选择的捕获类型
    "quick_capture_last_type",
    // 文件暂存架（v0.8）：过期清理与配额
    "shelf_auto_cleanup_enabled",
    "shelf_retention_days",
    "shelf_max_storage_mb",
    // 导航入口布局（v0.12）：完整面板 / 停靠胶囊各自的显隐与排序（版本化 JSON）
    "navigation_layout",
    // 统一提示音 / 语音播报 / 本地语音缓存（v0.13）
    "audio_sound_enabled",
    "audio_sound_volume",
    "audio_sound_agent_started",
    "audio_sound_agent_done",
    "audio_sound_agent_waiting",
    "audio_sound_agent_failed",
    "audio_sound_agent_disconnected",
    "audio_sound_task_due",
    "audio_sound_reminder",
    "tts_enabled",
    "tts_voice_pack_enabled",
    "tts_voice_pack_id",
    "tts_voice_route",
    "tts_voice_id",
    "tts_voice_gender",
    "tts_volume",
    "tts_rate",
    "tts_speak_source",
    "tts_speak_title",
    "tts_agent_started",
    "tts_agent_done",
    "tts_agent_waiting",
    "tts_agent_failed",
    "tts_agent_disconnected",
    "tts_task_due",
    "tts_reminder",
    "tts_cache_enabled",
    "tts_cache_max_mb",
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
        // 2026-11 收口：只接受 frosted | dream-gradient；历史值在写入前由
        // `normalize_patch` 映射为 frosted，未知值仍直接报校验错误。
        "visual_preset" => enum_of(v, key, &["frosted", "dream-gradient"]),
        // 已废弃键：仍接受合法枚举，但前端不再读取/写入该值。
        "clear_foreground" => enum_of(v, key, &["auto", "dark", "light"]),
        // 边缘吸附展示形态：胶囊隐藏（默认）| 完整面板
        "snap_display_mode" => enum_of(v, key, &["capsule", "full"]),
        "snap_enabled"
        | "autostart"
        | "hotkey_enabled"
        | "http_enabled"
        | "mcp_server_enabled"
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
        | "clipboard_sensitive_filter"
        | "clipboard_ocr_auto"
        // 统一提示音 / 语音播报 / 缓存（v0.13）
        | "audio_sound_enabled"
        | "audio_sound_agent_started"
        | "audio_sound_agent_done"
        | "audio_sound_agent_waiting"
        | "audio_sound_agent_failed"
        | "audio_sound_agent_disconnected"
        | "audio_sound_task_due"
        | "audio_sound_reminder"
        | "tts_enabled"
        | "tts_voice_pack_enabled"
        | "tts_speak_source"
        | "tts_speak_title"
        | "tts_agent_started"
        | "tts_agent_done"
        | "tts_agent_waiting"
        | "tts_agent_failed"
        | "tts_agent_disconnected"
        | "tts_task_due"
        | "tts_reminder"
        | "tts_cache_enabled" => bool_of(v, key),
        "audio_sound_volume" | "tts_volume" => int_in_range(v, key, 0, 100),
        "tts_rate" => int_in_range(v, key, 50, 200),
        "tts_cache_max_mb" => int_in_range(v, key, 1, 2048),
        "tts_voice_gender" => enum_of(v, key, &["auto", "female", "male"]),
        "tts_voice_route" => enum_of(v, key, &["auto", "system", "custom"]),
        "tts_voice_pack_id" => {
            let s = v
                .as_str()
                .ok_or_else(|| AppError::Validation("tts_voice_pack_id 必须是字符串".into()))?;
            if s.is_empty() || uuid::Uuid::parse_str(s).is_ok() {
                Ok(())
            } else {
                Err(AppError::Validation(
                    "tts_voice_pack_id 必须为空或有效语音包 ID".into(),
                ))
            }
        }
        // 系统语音唯一 ID 是自由字符串（Windows 生成的 ID），只做长度/控制字符边界校验
        "tts_voice_id" => {
            let s = v
                .as_str()
                .ok_or_else(|| AppError::Validation("tts_voice_id 必须是字符串".into()))?;
            if s.chars().count() > 256 {
                return Err(AppError::Validation("tts_voice_id 超过 256 字符".into()));
            }
            if s.chars().any(|c| c.is_control()) {
                return Err(AppError::Validation("tts_voice_id 含非法控制字符".into()));
            }
            Ok(())
        }
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
        // 快速捕获上次选择的类型（与 store::KINDS 保持一致）
        "quick_capture_last_type" => enum_of(v, key, &["task", "idea", "text", "todo", "link"]),
        // 文件暂存架（v0.8）
        "shelf_auto_cleanup_enabled" => bool_of(v, key),
        "shelf_retention_days" => int_in_range(v, key, 1, 3650),
        "shelf_max_storage_mb" => int_in_range(v, key, 64, 102_400),
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
        // 导航入口布局：结构边界校验（语义归一化/合并由前端注册中心负责）。
        // 拒绝超长列表与超长 ID，避免任意 JSON 灌入设置表。
        "navigation_layout" => {
            let obj = v
                .as_object()
                .ok_or_else(|| AppError::Validation("navigation_layout 必须是 JSON 对象".into()))?;
            if obj.get("version").and_then(|value| value.as_u64()).is_none() {
                return Err(AppError::Validation(
                    "navigation_layout.version 必须是正整数".into(),
                ));
            }
            for surface in ["left", "capsule"] {
                let list = obj
                    .get(surface)
                    .and_then(|value| value.as_array())
                    .ok_or_else(|| {
                        AppError::Validation(format!("navigation_layout.{} 必须是数组", surface))
                    })?;
                if list.len() > 64 {
                    return Err(AppError::Validation(format!(
                        "navigation_layout.{} 条目过多",
                        surface
                    )));
                }
                for id in list {
                    let text = id.as_str().ok_or_else(|| {
                        AppError::Validation(format!(
                            "navigation_layout.{} 只允许字符串 ID",
                            surface
                        ))
                    })?;
                    if text.chars().count() > 64 {
                        return Err(AppError::Validation(format!(
                            "navigation_layout.{} 存在超长 ID",
                            surface
                        )));
                    }
                }
            }
            Ok(())
        }
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

/// 写侧兼容映射：历史预设值（liquid-glass / clear）在入库前统一归一为 frosted。
/// 未知值保持原样，交给 `validate_setting` 报错，避免静默吞掉真正的非法输入。
fn normalize_patch(patch: &mut serde_json::Value) {
    let Some(obj) = patch.as_object_mut() else {
        return;
    };
    if let Some(v) = obj.get_mut("visual_preset") {
        if let Some(s) = v.as_str() {
            if s == "liquid-glass" || s == "clear" {
                *v = serde_json::Value::String(normalized_visual_preset(s).into());
            }
        }
    }
}

#[tauri::command]
pub fn update_settings(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    mut patch: serde_json::Value,
) -> AppResult<Settings> {
    normalize_patch(&mut patch);
    let obj = patch
        .as_object()
        .ok_or_else(|| AppError::Validation("设置必须是 JSON 对象".into()))?;
    // 先整体校验再写入：不留下半应用的脏设置
    for (k, v) in obj {
        validate_setting(k, v)?;
    }
    // 当前包 ID 与包删除串行化，并先拒绝不存在的 ID，避免保存悬挂引用。
    let _voice_gate = if let Some(pack_id) = obj
        .get("tts_voice_pack_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
    {
        let gate = crate::audio::voice_packs::asset_gate_read();
        if !crate::audio::voice_packs::pack_exists(&db, pack_id)? {
            return Err(AppError::NotFound("语音包不存在".into()));
        }
        Some(gate)
    } else {
        None
    };
    for (k, v) in obj {
        db.set_setting(k, v.clone())?;
        if k == "mcp_server_enabled" {
            if let Some(runtime) = app.try_state::<Arc<crate::mcp::bridge::McpRuntimeStatus>>() {
                runtime.inner().notify_settings_changed();
            }
        }
    }
    // 状态一致性校验（诊断用，不改变保存结果）：写入语句成功并不等于最终持久化正确
    // （事务回滚、并发覆盖、写入后又被旧值盖回都可能发生）。这里对本次 patch 逐键回读，
    // 只记录键名与不一致事实，**绝不记录设置值**（可能含端口/令牌等敏感内容）。
    for (k, expected) in obj {
        match db.get_setting(k) {
            Ok(Some(actual)) => {
                if &actual != expected {
                    crate::diagnostics::event(
                        crate::diagnostics::DiagLevel::Critical,
                        "settings",
                        "persist_verify",
                        "mismatch",
                    )
                    .status(crate::diagnostics::DiagStatus::Failed)
                    .error_code("DATA_INTEGRITY_ERROR")
                    .error_category("integrity")
                    .message("设置写入后回读不一致（保存命令返回成功但值与提交值不同）")
                    .metadata("key", serde_json::Value::String(k.clone()))
                    .emit();
                }
            }
            Ok(None) => {
                crate::diagnostics::event(
                    crate::diagnostics::DiagLevel::Critical,
                    "settings",
                    "persist_verify",
                    "missing",
                )
                .status(crate::diagnostics::DiagStatus::Failed)
                .error_code("DATA_INTEGRITY_ERROR")
                .error_category("integrity")
                .message("设置写入后回读为空（持久化可能未生效）")
                .metadata("key", serde_json::Value::String(k.clone()))
                .emit();
            }
            // 读取失败本身会由数据库错误路径暴露，这里不重复刷屏。
            Err(_) => {}
        }
    }
    // 主题/预设变更广播给所有窗口（通知窗口、右键菜单跟随；主窗 store 同值幂等）。
    // 与托盘/右键菜单路径（context_menu_action 单独 emit）保持同一事件契约。
    if let Some(theme) = obj.get("theme").and_then(|v| v.as_str()) {
        let _ = app.emit("theme-changed", theme.to_string());
    }
    if let Some(preset) = obj.get("visual_preset").and_then(|v| v.as_str()) {
        let _ = app.emit("visual-preset-changed", preset.to_string());
    }
    // 材质同样影响已打开的独立微件窗口（solid 回退不透明表面）。
    if let Some(material) = obj.get("material").and_then(|v| v.as_str()) {
        let _ = app.emit("material-changed", material.to_string());
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
    // 语音缓存容量变更：立即按 LRU 收敛到新上限，不必等下一次写入才清理。
    if obj.contains_key("tts_cache_max_mb") || obj.contains_key("tts_cache_enabled") {
        if let Some(svc) = app.try_state::<Arc<crate::audio::AudioService>>() {
            svc.inner().apply_policy(updated.tts_cache_max_mb);
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
        // 2026-11 视觉预设收口：只接受 frosted | dream-gradient
        assert!(validate_setting("visual_preset", &serde_json::json!("dream-gradient")).is_ok());
        assert!(validate_setting("visual_preset", &serde_json::json!("frosted")).is_ok());
        assert!(validate_setting("visual_preset", &serde_json::json!("liquid-glass")).is_err());
        assert!(validate_setting("visual_preset", &serde_json::json!("clear")).is_err());
        assert!(validate_setting("visual_preset", &serde_json::json!("neon")).is_err());
        // 已废弃键仍接受历史合法枚举（兼容旧前端），但前端不再读取
        assert!(validate_setting("clear_foreground", &serde_json::json!("auto")).is_ok());
        assert!(validate_setting("clear_foreground", &serde_json::json!("dark")).is_ok());
        assert!(validate_setting("clear_foreground", &serde_json::json!("light")).is_ok());
        assert!(validate_setting("clear_foreground", &serde_json::json!("system")).is_err());
        assert!(validate_setting("visual_preset", &serde_json::json!(null)).is_err());
    }

    #[test]
    fn legacy_preset_is_mapped_before_write() {
        // 写侧映射：历史值归一为 frosted；未知值保持原样交由校验拒绝。
        for (input, expected) in [
            ("liquid-glass", "frosted"),
            ("clear", "frosted"),
            ("frosted", "frosted"),
            ("dream-gradient", "dream-gradient"),
        ] {
            let mut patch = serde_json::json!({ "visual_preset": input });
            normalize_patch(&mut patch);
            assert_eq!(patch["visual_preset"], expected);
            assert!(validate_setting("visual_preset", &patch["visual_preset"]).is_ok());
        }

        let mut patch = serde_json::json!({ "visual_preset": "neon" });
        normalize_patch(&mut patch);
        assert!(validate_setting("visual_preset", &patch["visual_preset"]).is_err());
        // 其他键不受影响
        let mut patch = serde_json::json!({ "theme": "dark", "visual_preset": "clear" });
        normalize_patch(&mut patch);
        assert_eq!(patch["theme"], "dark");
        assert_eq!(patch["visual_preset"], "frosted");
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
    fn audio_settings_are_validated_and_allowlisted() {
        for key in [
            "audio_sound_enabled",
            "audio_sound_agent_started",
            "audio_sound_agent_done",
            "audio_sound_agent_waiting",
            "audio_sound_agent_failed",
            "audio_sound_agent_disconnected",
            "audio_sound_task_due",
            "audio_sound_reminder",
            "tts_enabled",
            "tts_voice_pack_enabled",
            "tts_voice_pack_id",
            "tts_voice_route",
            "tts_voice_id",
            "tts_voice_gender",
            "tts_volume",
            "tts_rate",
            "tts_speak_source",
            "tts_speak_title",
            "tts_agent_started",
            "tts_agent_done",
            "tts_agent_waiting",
            "tts_agent_failed",
            "tts_agent_disconnected",
            "tts_task_due",
            "tts_reminder",
            "tts_cache_enabled",
            "tts_cache_max_mb",
        ] {
            assert!(ALLOWED_KEYS.contains(&key), "{key} 必须可持久化");
        }
        assert!(validate_setting("audio_sound_volume", &serde_json::json!(70)).is_ok());
        assert!(validate_setting("audio_sound_volume", &serde_json::json!(101)).is_err());
        assert!(validate_setting("audio_sound_volume", &serde_json::json!("70")).is_err());
        assert!(validate_setting("tts_volume", &serde_json::json!(0)).is_ok());
        assert!(validate_setting("tts_rate", &serde_json::json!(50)).is_ok());
        assert!(validate_setting("tts_rate", &serde_json::json!(200)).is_ok());
        assert!(validate_setting("tts_rate", &serde_json::json!(201)).is_err());
        assert!(validate_setting("tts_cache_max_mb", &serde_json::json!(1)).is_ok());
        assert!(validate_setting("tts_cache_max_mb", &serde_json::json!(2048)).is_ok());
        assert!(validate_setting("tts_cache_max_mb", &serde_json::json!(0)).is_err());
        assert!(validate_setting("tts_voice_gender", &serde_json::json!("female")).is_ok());
        assert!(validate_setting("tts_voice_gender", &serde_json::json!("auto")).is_ok());
        assert!(validate_setting("tts_voice_gender", &serde_json::json!("robot")).is_err());
        assert!(validate_setting("tts_voice_pack_enabled", &serde_json::json!(true)).is_ok());
        assert!(validate_setting("tts_voice_pack_enabled", &serde_json::json!("true")).is_err());
        assert!(validate_setting("tts_voice_route", &serde_json::json!("auto")).is_ok());
        assert!(validate_setting("tts_voice_route", &serde_json::json!("custom")).is_ok());
        assert!(validate_setting("tts_voice_route", &serde_json::json!("invalid")).is_err());
        assert!(validate_setting("tts_voice_pack_id", &serde_json::json!("")).is_ok());
        assert!(validate_setting(
            "tts_voice_pack_id",
            &serde_json::json!(uuid::Uuid::new_v4().to_string())
        )
        .is_ok());
        assert!(validate_setting("tts_voice_pack_id", &serde_json::json!("../bad")).is_err());
        assert!(validate_setting("tts_voice_id", &serde_json::json!("Microsoft Huihui")).is_ok());
        assert!(validate_setting("tts_voice_id", &serde_json::json!("bad\u{0007}id")).is_err());
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
