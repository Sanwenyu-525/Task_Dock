//! 功能生命周期统一契约（v0.15）。
//!
//! ## 目标
//!
//! 把「功能是否在后台干活」这件事收敛成一份可查询、可复核的事实，供模块页
//! 标题栏与资源管理「功能运行」分区共用。它**不创建第二套状态**：
//!
//! - **用户意图**：现有 SQLite 设置键（`clipboard_paused` / `reminders_paused` /
//!   `shelf_auto_cleanup_enabled` / `actions_enabled` / `tts_enabled` 等）；
//! - **实际运行**：各模块运行时探针（监听/维护线程、自动清理线程）；
//! - **有效状态**：由两者推导，`paused`/`stopped` 只在实际线程确实退出后成立；
//!   已发暂停/停止信号但仍在收尾时分别报告 `pausing`/`stopping`。
//!
//! ## 四类模块（与验收报告一致）
//!
//! - `resident`：常驻后台，支持独立暂停/恢复（clipboard / shelf_cleanup / reminders / voice）；
//! - `task`：任务级能力，暂停语义属于运行中的具体任务（workflows / focus / backup）；
//! - `ondemand`：纯按需执行，没有常驻后台，不提供无效暂停按钮；
//! - `shared`：共享基础设施（Agent 接入管线、诊断写入、全局热键、任务数据），
//!   不允许被单一模块直接停止，否则会丢失其他业务的数据。
//!
//! ## 硬约束
//!
//! - 探针只读：不写设置、不启动/停止线程；所有写操作仍走 `update_settings`；
//! - 不注册定时器、不轮询；前端只在需要时批量查询一次；
//! - 错误与细节只包含稳定代码/布尔/计数/键名，绝不包含剪贴板正文、文件路径或密钥。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::{Db, Settings};

pub const STATE_RUNNING: &str = "running";
pub const STATE_PAUSING: &str = "pausing";
pub const STATE_STOPPING: &str = "stopping";
pub const STATE_PAUSED: &str = "paused";
pub const STATE_STOPPED: &str = "stopped";
pub const STATE_IDLE: &str = "idle";
pub const STATE_ERROR: &str = "error";
pub const STATE_UNSUPPORTED: &str = "unsupported";

pub const CATEGORY_RESIDENT: &str = "resident";
pub const CATEGORY_TASK: &str = "task";
pub const CATEGORY_ONDEMAND: &str = "ondemand";
pub const CATEGORY_SHARED: &str = "shared";

/// 单个模块的生命周期快照（camelCase 直接给前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRuntimeStatus {
    /// 稳定模块 ID（前端本地化文案的键；不允许随 UI 文案变化）。
    pub id: &'static str,
    /// resident | task | ondemand | shared
    pub category: &'static str,
    /// 有效运行状态（见 STATE_*）。
    pub state: &'static str,
    /// 用户意图：running | paused | stopped。
    pub intent: &'static str,
    /// 是否支持在 UI 里暂停/恢复。纯按需与共享基础设施为 false。
    pub controllable: bool,
    /// 实际存在的后台活动标记（不是文案）。
    pub background: Vec<&'static str>,
    /// 模块特定事实（布尔/计数/稳定代码）；不含用户内容或本机路径。
    pub detail: serde_json::Value,
    /// 生命周期操作/运行失败原因（稳定代码或服务端安全文案）。
    pub error: Option<String>,
}

fn status(
    id: &'static str,
    category: &'static str,
    state: &'static str,
    intent: &'static str,
    controllable: bool,
    background: Vec<&'static str>,
    detail: serde_json::Value,
    error: Option<String>,
) -> ModuleRuntimeStatus {
    ModuleRuntimeStatus {
        id,
        category,
        state,
        intent,
        controllable,
        background,
        detail,
        error,
    }
}

/// 读取设置；失败时返回稳定错误码（不把 SQLite 原始错误冒泡给 UI 文案）。
fn load_settings(db: &Db) -> Result<Settings, String> {
    Settings::load(db).map_err(|_| "settings_unavailable".to_string())
}

/// 一次批量查询全部模块状态。
pub fn snapshot(app: &AppHandle, db: &Db) -> Vec<ModuleRuntimeStatus> {
    let settings = load_settings(db);
    let clipboard = clipboard_status(app, db);
    let shelf = shelf_status(app, &settings);
    let mut out = vec![
        clipboard,
        shelf,
        reminders_status(&settings),
        actions_status(&settings),
        voice_status(&settings),
        agents_status(app),
        diagnostics_status(),
        hotkeys_status(&settings),
        workflows_status(),
        focus_status(db),
        backup_status(&settings),
        workspace_status(&settings),
        widgets_status(app),
        apps_status(),
        history_status(),
        planning_status(),
        ocr_status(app),
        collection_status(),
    ];
    out.sort_by_key(|m| category_order(m.category));
    out
}

fn category_order(category: &str) -> u8 {
    match category {
        CATEGORY_RESIDENT => 0,
        CATEGORY_TASK => 1,
        CATEGORY_SHARED => 2,
        _ => 3,
    }
}

// ── 常驻后台模块 ─────────────────────────────────────────────

fn clipboard_status(app: &AppHandle, db: &Db) -> ModuleRuntimeStatus {
    let config = Settings::load_clipboard(db);
    let error = config.error.as_ref().map(|e| e.message().to_string());
    let enabled = config.error.is_none() && config.settings.clipboard_enabled;
    let paused = config.error.is_some() || config.settings.clipboard_paused;
    let runtime = app.try_state::<std::sync::Arc<crate::clipboard::ClipboardRuntime>>();
    let monitoring = runtime
        .as_ref()
        .map(|rt| rt.monitoring())
        .unwrap_or(false);
    let maintenance = runtime
        .as_ref()
        .map(|rt| rt.maintenance_running())
        .unwrap_or(false);
    let draining = runtime
        .as_ref()
        .map(|rt| rt.capture_draining())
        .unwrap_or(false);
    let paste_active = runtime
        .as_ref()
        .map(|rt| rt.paste.is_active())
        .unwrap_or(false);

    let intent = if !enabled {
        "stopped"
    } else if paused {
        "paused"
    } else {
        "running"
    };
    let state = clipboard_effective_state(enabled, paused, monitoring, maintenance, draining);

    let mut background = Vec::new();
    if monitoring {
        background.push("clipboard-monitor");
    }
    if maintenance || draining {
        background.push("clipboard-maintenance");
    }
    if paste_active {
        background.push("clipboard-paste");
    }
    let error_text = if state == STATE_ERROR && error.is_none() {
        Some("monitor_not_running".to_string())
    } else {
        error
    };
    status(
        "clipboard",
        CATEGORY_RESIDENT,
        state,
        intent,
        true,
        background,
        serde_json::json!({
            "enabled": enabled,
            "paused": paused,
            "monitoring": monitoring,
            "maintenance": maintenance,
            "draining": draining,
            "pasteActive": paste_active,
            "captureAllowed": config.capture_allowed(),
            "configOrigin": config.origin,
        }),
        error_text,
    )
}

/// 剪贴板有效状态推导（纯函数，便于验证「pausing 不等于 paused」）。
///
/// - 停用永远优先于暂停；
/// - 暂停后只要监听/维护/回收线程任一还活着，就只能报 `pausing`；
/// - 停用后线程仍在收尾时只能报 `stopping`，全部退出才是 `stopped`；
/// - 开启且未暂停但监听未运行时是 `error`，不能伪装成 running。
pub(crate) fn clipboard_effective_state(
    enabled: bool,
    paused: bool,
    monitoring: bool,
    maintenance: bool,
    draining: bool,
) -> &'static str {
    if !enabled {
        // 停用请求已接受，但监听/维护/回收线程仍存在：资源尚未释放，不能报 stopped。
        if monitoring || maintenance || draining {
            STATE_STOPPING
        } else {
            STATE_STOPPED
        }
    } else if paused {
        if monitoring || maintenance || draining {
            STATE_PAUSING
        } else {
            STATE_PAUSED
        }
    } else if monitoring {
        STATE_RUNNING
    } else {
        STATE_ERROR
    }
}

/// 暂存架自动清理有效状态推导（纯函数）。
pub(crate) fn shelf_effective_state(enabled: bool, running: bool) -> &'static str {
    if enabled {
        if running {
            STATE_RUNNING
        } else {
            STATE_ERROR
        }
    } else if running {
        // 关闭后线程还在执行最后一轮清理：资源尚未完全释放。
        STATE_PAUSING
    } else {
        STATE_PAUSED
    }
}

fn shelf_status(
    app: &AppHandle,
    settings: &Result<Settings, String>,
) -> ModuleRuntimeStatus {
    let state = app.try_state::<std::sync::Arc<crate::shelf::ShelfState>>();
    let running = state
        .as_ref()
        .map(|s| s.auto_cleanup_running())
        .unwrap_or(false);
    let error = state
        .as_ref()
        .and_then(|s| s.auto_cleanup_error())
        .map(|code| {
            // 清理失败只暴露稳定代码；原始错误可能包含本机路径，不进入 UI 载荷。
            if code.contains("启动失败") {
                "worker_start_failed".to_string()
            } else {
                "cleanup_failed".to_string()
            }
        });
    let (enabled, enabled_known) = match settings {
        Ok(s) => (s.shelf_auto_cleanup_enabled, true),
        Err(_) => (false, false),
    };
    let intent = if enabled { "running" } else { "paused" };
    let state_code = if !enabled_known {
        STATE_ERROR
    } else {
        shelf_effective_state(enabled, running)
    };
    let mut background = Vec::new();
    if running {
        background.push("shelf-auto-cleanup");
    }
    let error_text = if !enabled_known {
        Some("settings_unavailable".to_string())
    } else if enabled && !running {
        Some(error.unwrap_or_else(|| "worker_not_running".to_string()))
    } else {
        error
    };
    status(
        "shelf_cleanup",
        CATEGORY_RESIDENT,
        state_code,
        intent,
        true,
        background,
        serde_json::json!({
            "enabled": enabled,
            "running": running,
            "scope": "auto_cleanup_only",
        }),
        error_text,
    )
}

fn reminders_status(settings: &Result<Settings, String>) -> ModuleRuntimeStatus {
    let (paused, error) = match settings {
        Ok(s) => (s.reminders_paused, None),
        Err(code) => (false, Some(code.clone())),
    };
    let state = if error.is_some() {
        STATE_ERROR
    } else if paused {
        STATE_PAUSED
    } else {
        STATE_RUNNING
    };
    status(
        "reminders",
        CATEGORY_RESIDENT,
        state,
        if paused { "paused" } else { "running" },
        true,
        vec!["shared-scheduler-tick"],
        serde_json::json!({
            "paused": paused,
            // 暂停只拦提醒触发分支；共享 1 秒调度里的 Agent 清理/通知摘要/
            // 稍后提醒/专注推进继续运行。
            "sharedScheduler": true,
            "deferredOnResume": true,
        }),
        error,
    )
}

fn actions_status(settings: &Result<Settings, String>) -> ModuleRuntimeStatus {
    let (enabled, paused, error) = match settings {
        Ok(s) => (s.actions_enabled, s.actions_paused, None),
        Err(code) => (false, false, Some(code.clone())),
    };
    let intent = if !enabled {
        "stopped"
    } else if paused {
        "paused"
    } else {
        "running"
    };
    // 聚合是前端消费者门控的按需查询，没有常驻线程：启用且未暂停时是 idle，
    // 不能用 running +「无后台活动」自相矛盾。暂停只停自动刷新，手动查看仍可用。
    let state = if error.is_some() {
        STATE_ERROR
    } else if !enabled {
        STATE_STOPPED
    } else if paused {
        STATE_PAUSED
    } else {
        STATE_IDLE
    };
    status(
        "actions",
        CATEGORY_TASK,
        state,
        intent,
        true,
        Vec::new(),
        serde_json::json!({
            "enabled": enabled,
            "paused": paused,
            // 暂停/停用都不影响原始 Agent 事件入库；停用才会让 feed 返回空。
            "rawIngest": "unaffected",
            "consumerGated": true,
            "manualHistory": "available",
        }),
        error,
    )
}

fn voice_status(settings: &Result<Settings, String>) -> ModuleRuntimeStatus {
    let (tts_enabled, sound_enabled, error) = match settings {
        Ok(s) => (s.tts_enabled, s.audio_sound_enabled, None),
        Err(code) => (false, false, Some(code.clone())),
    };
    // 模块级暂停控制「自动语音播报」（tts_enabled）；提示音是独立的设置维度，
    // 不因暂停语音播报被一起改掉。引擎按需创建：开启但没有播报时是 idle，
    // 不把 lazy 谎报成常驻线程。
    let state = if error.is_some() {
        STATE_ERROR
    } else if !tts_enabled {
        STATE_PAUSED
    } else {
        STATE_IDLE
    };
    status(
        "voice",
        CATEGORY_RESIDENT,
        state,
        if tts_enabled { "running" } else { "paused" },
        true,
        Vec::new(),
        serde_json::json!({
            "ttsEnabled": tts_enabled,
            "soundEnabled": sound_enabled,
            "engine": "lazy",
        }),
        error,
    )
}

// ── 共享基础设施（不允许单模块停止）──────────────────────────

fn agents_status(app: &AppHandle) -> ModuleRuntimeStatus {
    let hub_ready = app
        .try_state::<std::sync::Arc<crate::agents::AgentHub>>()
        .is_some();
    // Hub 只是落库接口；真正接收关键事件的是有界接入管线的唯一消费者线程。
    // 仅凭 Hub 已创建就报 running，会在管线启动失败时误报“正常接收”。
    let pipeline = app.try_state::<std::sync::Arc<crate::agents::pipeline::IngestPipeline>>();
    let pipeline_running = pipeline
        .as_ref()
        .map(|p| p.is_running())
        .unwrap_or(false);
    let state = if hub_ready && pipeline_running {
        STATE_RUNNING
    } else {
        STATE_ERROR
    };
    let error = if !hub_ready {
        Some("agent_hub_unavailable".to_string())
    } else if !pipeline_running {
        Some("agent_pipeline_not_running".to_string())
    } else {
        None
    };
    status(
        "agents",
        CATEGORY_SHARED,
        state,
        "running",
        false,
        if pipeline_running {
            vec!["agent-ingest-pipeline", "agent-adapters"]
        } else {
            Vec::new()
        },
        serde_json::json!({
            "hubReady": hub_ready,
            "pipelineRunning": pipeline_running,
            // 外部 Agent 通过 Hook/HTTP/文件投递上报；停止接收会丢关键事件，
            // 因此只允许在 Agent 页面停用单个数据源，不提供模块级暂停。
            "stopWouldLoseEvents": true,
        }),
        error,
    )
}

fn diagnostics_status() -> ModuleRuntimeStatus {
    status(
        "diagnostics",
        CATEGORY_SHARED,
        STATE_RUNNING,
        "running",
        false,
        vec!["diagnostics-writer"],
        serde_json::json!({
            // 只有必需的最低限度错误记录常开；暂停资源页后仍可诊断暂停失败。
            "alwaysOn": true,
        }),
        None,
    )
}

fn hotkeys_status(settings: &Result<Settings, String>) -> ModuleRuntimeStatus {
    let enabled = settings
        .as_ref()
        .map(|s| s.hotkey_enabled)
        .unwrap_or(false);
    status(
        "hotkeys",
        CATEGORY_SHARED,
        if enabled { STATE_RUNNING } else { STATE_STOPPED },
        if enabled { "running" } else { "stopped" },
        false,
        if enabled {
            vec!["global-hotkey-registration"]
        } else {
            Vec::new()
        },
        serde_json::json!({
            // 每个动作的注册/注销由设置页的快捷键编辑器管理，不在此重复开关。
            "perAction": true,
        }),
        settings.as_ref().err().cloned(),
    )
}

// ── 任务级能力（暂停属于具体任务）──────────────────────────

fn workflows_status() -> ModuleRuntimeStatus {
    // 活动运行槽是引擎唯一的全局运行事实源：没有运行就是 idle，不猜测。
    let active = crate::workflows::engine::active_run();
    let (state, background) = match active.as_ref() {
        Some(run) if run.paused => (STATE_PAUSED, vec!["workflow-run"]),
        Some(_) => (STATE_RUNNING, vec!["workflow-run"]),
        None => (STATE_IDLE, Vec::new()),
    };
    status(
        "workflows",
        CATEGORY_TASK,
        state,
        "running",
        false,
        background,
        serde_json::json!({
            // 运行中的工作流在 Run 视图内暂停/继续，到达安全边界后停止推进；
            // 模块级暂停会与单次运行的生命周期冲突。
            "perRunPause": true,
            "runPaused": active.as_ref().map(|r| r.paused).unwrap_or(false),
            "cancelRequested": active.as_ref().map(|r| r.cancel_requested).unwrap_or(false),
        }),
        None,
    )
}

fn focus_status(db: &Db) -> ModuleRuntimeStatus {
    // 快照来自后端权威状态机（含启动恢复后的 paused 会话）；读失败如实报 error，
    // 不退化成 idle。查询只在生命周期快照请求时执行，不轮询。
    match crate::focus::snapshot(db) {
        Ok(snapshot) => {
            let active = snapshot.active.as_ref();
            let paused = active
                .map(|a| matches!(a.state, crate::focus::model::SessionState::Paused))
                .unwrap_or(false);
            let state = if active.is_none() {
                STATE_IDLE
            } else if paused {
                STATE_PAUSED
            } else {
                STATE_RUNNING
            };
            status(
                "focus",
                CATEGORY_TASK,
                state,
                "running",
                false,
                if active.is_some() {
                    vec!["focus-session"]
                } else {
                    Vec::new()
                },
                serde_json::json!({
                    "sessionLevel": true,
                    // 计时/休息/久坐与提醒共用 1 秒调度，但状态机属于用户当前会话。
                    "hasSession": active.is_some(),
                    "paused": paused,
                }),
                None,
            )
        }
        Err(_) => status(
            "focus",
            CATEGORY_TASK,
            STATE_ERROR,
            "running",
            false,
            Vec::new(),
            serde_json::json!({ "sessionLevel": true }),
            Some("focus_state_unavailable".to_string()),
        ),
    }
}

fn backup_status(settings: &Result<Settings, String>) -> ModuleRuntimeStatus {
    let enabled = settings.as_ref().map(|s| s.auto_backup).unwrap_or(false);
    status(
        "backup",
        CATEGORY_TASK,
        if enabled { STATE_IDLE } else { STATE_STOPPED },
        if enabled { "running" } else { "stopped" },
        false,
        Vec::new(),
        serde_json::json!({
            // 仅在启动时按 24 小时节流检查一次；没有常驻线程，无需暂停按钮。
            "startupOnly": true,
        }),
        settings.as_ref().err().cloned(),
    )
}

fn workspace_status(settings: &Result<Settings, String>) -> ModuleRuntimeStatus {
    let enabled = settings.as_ref().map(|s| s.workspace_enabled).unwrap_or(false);
    status(
        "workspace",
        CATEGORY_TASK,
        if enabled { STATE_IDLE } else { STATE_STOPPED },
        if enabled { "running" } else { "stopped" },
        false,
        Vec::new(),
        serde_json::json!({
            // 捕获/恢复由用户触发；关闭时取消进行中的恢复，不存在常驻轮询。
            "onDemandRestore": true,
        }),
        settings.as_ref().err().cloned(),
    )
}

// ── 纯按需模块（无后台可暂停）──────────────────────────────

fn widgets_status(app: &AppHandle) -> ModuleRuntimeStatus {
    // 只统计当前真实存在的微件 WebView 窗口；不枚举进程、不读窗口几何。
    let open = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(crate::widget_windows::WINDOW_PREFIX))
        .count();
    status(
        "widgets",
        CATEGORY_ONDEMAND,
        if open > 0 { STATE_RUNNING } else { STATE_IDLE },
        "running",
        false,
        if open > 0 {
            vec!["widget-windows"]
        } else {
            Vec::new()
        },
        serde_json::json!({
            // 每个桌面微件是独立窗口，按自身开关显示；事件驱动刷新，
            // 隐藏/关闭窗口即释放该窗口的渲染与订阅。
            "perWidget": true,
            "openWindows": open,
        }),
        None,
    )
}

fn apps_status() -> ModuleRuntimeStatus {
    // 取消注册表在扫描开始/结束时增减，是扫描是否正在运行的真实探针。
    let scanning = crate::navigation::app_discovery::active_scan_count();
    status(
        "apps",
        CATEGORY_ONDEMAND,
        if scanning > 0 { STATE_RUNNING } else { STATE_IDLE },
        "running",
        false,
        if scanning > 0 {
            vec!["app-scan"]
        } else {
            Vec::new()
        },
        serde_json::json!({
            "scan": "manual_with_cancel",
            "activeScans": scanning,
        }),
        None,
    )
}

fn history_status() -> ModuleRuntimeStatus {
    status(
        "history",
        CATEGORY_ONDEMAND,
        STATE_IDLE,
        "running",
        false,
        Vec::new(),
        serde_json::json!({ "query": "on_demand" }),
        None,
    )
}

fn planning_status() -> ModuleRuntimeStatus {
    status(
        "planning",
        CATEGORY_ONDEMAND,
        STATE_IDLE,
        "running",
        false,
        Vec::new(),
        serde_json::json!({ "query": "on_demand", "debouncedSync": true }),
        None,
    )
}

fn ocr_status(app: &AppHandle) -> ModuleRuntimeStatus {
    let busy = app
        .try_state::<std::sync::Arc<crate::clipboard::ClipboardRuntime>>()
        .as_ref()
        .map(|rt| rt.ocr.is_busy())
        .unwrap_or(false);
    ocr_status_from(busy)
}

/// OCR 状态推导（纯函数）：执行中必须是 running + `ocr-task`，不能固定 idle。
fn ocr_status_from(busy: bool) -> ModuleRuntimeStatus {
    status(
        "ocr",
        CATEGORY_ONDEMAND,
        if busy { STATE_RUNNING } else { STATE_IDLE },
        "running",
        false,
        if busy { vec!["ocr-task"] } else { Vec::new() },
        serde_json::json!({
            // 自动 OCR 设置尚未接入采集热路径；手动识别单任务、可取消。
            "autoOcr": false,
            "busy": busy,
            "manualCancel": true,
        }),
        None,
    )
}

fn collection_status() -> ModuleRuntimeStatus {
    status(
        "collection",
        CATEGORY_ONDEMAND,
        STATE_IDLE,
        "running",
        false,
        Vec::new(),
        serde_json::json!({ "capture": "user_initiated" }),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_pause_and_disable_are_distinct_states() {
        let mut settings = Settings::default();
        let normal = actions_status(&Ok(settings.clone()));
        assert_eq!(normal.state, STATE_IDLE, "无消费者时按需运行，不谎报常驻线程");
        assert_eq!(normal.intent, "running");
        assert!(normal.controllable);

        settings.actions_paused = true;
        let paused = actions_status(&Ok(settings.clone()));
        assert_eq!(paused.state, STATE_PAUSED);
        assert_eq!(paused.intent, "paused");

        settings.actions_enabled = false;
        let disabled = actions_status(&Ok(settings));
        assert_eq!(disabled.state, STATE_STOPPED);
        assert_eq!(disabled.intent, "stopped", "停用优先于暂停，不能被恢复按钮误导");
    }

    #[test]
    fn ocr_busy_is_running_not_idle() {
        let busy = ocr_status_from(true);
        assert_eq!(busy.state, STATE_RUNNING);
        assert_eq!(busy.background, vec!["ocr-task"]);
        assert_eq!(busy.detail["busy"], serde_json::json!(true));

        let idle = ocr_status_from(false);
        assert_eq!(idle.state, STATE_IDLE);
        assert!(idle.background.is_empty(), "idle 不能同时声明后台活动");
    }

    #[test]
    fn category_order_puts_resident_first_and_ondemand_last() {
        assert!(category_order(CATEGORY_RESIDENT) < category_order(CATEGORY_TASK));
        assert!(category_order(CATEGORY_TASK) < category_order(CATEGORY_SHARED));
        assert!(category_order(CATEGORY_SHARED) < category_order(CATEGORY_ONDEMAND));
    }

    #[test]
    fn shared_modules_are_never_controllable() {
        // 共享基础设施一旦可暂停，Agent 事件/诊断/热键会随单个模块的开关丢失。
        for category in [CATEGORY_RESIDENT, CATEGORY_TASK, CATEGORY_SHARED] {
            let m = status(
                "x",
                category,
                STATE_RUNNING,
                "running",
                category != CATEGORY_SHARED,
                Vec::new(),
                serde_json::json!({}),
                None,
            );
            if category == CATEGORY_SHARED {
                assert!(!m.controllable);
            }
        }
    }

    #[test]
    fn clipboard_paused_only_after_threads_exit() {
        // 已接受暂停但监听/维护线程还活着 → pausing，不能报告资源已释放。
        assert_eq!(
            clipboard_effective_state(true, true, true, false, false),
            STATE_PAUSING
        );
        assert_eq!(
            clipboard_effective_state(true, true, false, true, false),
            STATE_PAUSING
        );
        // 实例已从槽位移除、但异步回收线程还在 join 采集/入库线程
        assert_eq!(
            clipboard_effective_state(true, true, false, false, true),
            STATE_PAUSING
        );
        assert_eq!(
            clipboard_effective_state(true, true, false, false, false),
            STATE_PAUSED
        );
    }

    #[test]
    fn clipboard_disabled_and_missing_monitor_are_distinct() {
        assert_eq!(
            clipboard_effective_state(false, true, true, true, true),
            STATE_STOPPING,
            "停用已接受但线程仍在收尾：不能宣称资源已完全释放"
        );
        assert_eq!(
            clipboard_effective_state(false, true, false, false, false),
            STATE_STOPPED,
            "三个线程/回收任务都退出后才是 stopped"
        );
        assert_eq!(
            clipboard_effective_state(false, false, false, false, true),
            STATE_STOPPING,
            "仅有异步回收线程仍在 join 也算收尾中"
        );
        assert_eq!(
            clipboard_effective_state(true, false, false, true, false),
            STATE_ERROR,
            "开启且未暂停但监听未运行必须如实报告异常"
        );
        assert_eq!(
            clipboard_effective_state(true, false, true, false, false),
            STATE_RUNNING
        );
    }

    #[test]
    fn shelf_cleanup_reports_pausing_while_worker_finishes() {
        assert_eq!(shelf_effective_state(true, true), STATE_RUNNING);
        assert_eq!(shelf_effective_state(true, false), STATE_ERROR);
        assert_eq!(
            shelf_effective_state(false, true),
            STATE_PAUSING,
            "关闭后线程仍在收尾时不能显示已暂停"
        );
        assert_eq!(shelf_effective_state(false, false), STATE_PAUSED);
    }
}
