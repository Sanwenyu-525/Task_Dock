//! 系统级命令：退出、自启动、窗口模式、热键开关。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents::AgentHub;
use crate::db::Db;
use crate::error::AppResult;

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    // 统一走异步排空（QUIESCING→DRAINING→STOPPED），完成后由后台任务真正退出；
    // 命令本身立即返回，不阻塞 UI/命令线程。
    crate::request_exit(&app);
}

/// 显示模式对应的窗口尺寸。
fn mode_size(mode: &str) -> (f64, f64) {
    match mode {
        "minimal" => (280.0, 140.0),
        "compact" => (400.0, 380.0),
        _ => (400.0, 560.0),
    }
}

/// 显示模式对应的最小尺寸（必须先放宽/收紧最小尺寸再 set_size，
/// 否则极简模式 280×140 会被常驻 minWidth=320 钳制）。
fn mode_min_size(mode: &str) -> (f64, f64) {
    match mode {
        "minimal" => (240.0, 96.0),
        "compact" => (340.0, 280.0),
        _ => (340.0, 340.0),
    }
}

/// 调整窗口尺寸到模式尺寸（含最小尺寸同步），托盘/命令/启动恢复共用。
pub fn set_mode_window_size<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>, mode: &str) {
    let (w, h) = mode_size(mode);
    let (mw, mh) = mode_min_size(mode);
    let _ = win.set_min_size(Some(tauri::LogicalSize::new(mw, mh)));
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
}

/// 应用显示模式（托盘菜单与命令共用）。
pub fn apply_mode_inner<R: tauri::Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    mode: &str,
) -> AppResult<()> {
    let mode = match mode {
        "minimal" | "compact" | "full" => mode.to_string(),
        _ => "full".to_string(),
    };
    db.set_setting("mode", serde_json::json!(mode))?;
    if let Some(win) = app.get_webview_window("main") {
        set_mode_window_size(&win, &mode);
    }
    let _ = app.emit("mode-changed", mode);
    Ok(())
}

#[tauri::command]
pub fn apply_mode(app: tauri::AppHandle, db: State<'_, Arc<Db>>, mode: String) -> AppResult<()> {
    apply_mode_inner(&app, &db, &mode)
}

/// 切换开机自启动（托盘菜单与命令共用）。
pub fn set_autostart_inner<R: tauri::Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    enabled: bool,
) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enabled {
        autostart
            .enable()
            .map_err(|e| crate::error::AppError::Agent(e.to_string()))?;
    } else {
        autostart
            .disable()
            .map_err(|e| crate::error::AppError::Agent(e.to_string()))?;
    }
    db.set_setting("autostart", serde_json::json!(enabled))?;
    Ok(enabled)
}

#[tauri::command]
pub fn set_autostart(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    enabled: bool,
) -> AppResult<bool> {
    set_autostart_inner(&app, &db, enabled)
}

#[tauri::command]
pub fn set_hotkeys_enabled(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    enabled: bool,
) -> AppResult<()> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    db.set_setting("hotkey_enabled", serde_json::json!(enabled))?;
    let gs = app.global_shortcut();
    if enabled {
        let _ = gs.register("Ctrl+Alt+T".parse::<Shortcut>().unwrap());
        let _ = gs.register("Ctrl+Shift+Space".parse::<Shortcut>().unwrap());
    } else {
        let _ = gs.unregister("Ctrl+Alt+T".parse::<Shortcut>().unwrap());
        let _ = gs.unregister("Ctrl+Shift+Space".parse::<Shortcut>().unwrap());
    }
    Ok(())
}

/// Agent 文件投递目录（文档与钩子脚本使用）。
#[tauri::command]
pub fn get_agent_inbox_dir(app: tauri::AppHandle) -> AppResult<String> {
    let dir = crate::app_data_dir(&app).join("agent-inbox");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(())
}

/// 设置窗口圆角半径（逻辑像素）并立即应用到 Win32 窗口区域。
///
/// 前端按视觉预设下发：dream-gradient 18px / liquid-glass 20px。
/// 返回值表示 Win32 区域是否真正应用成功（失败时 CSS 圆角仍在，
/// 只是原生背景可能在四角露出直角，由前端记录到验收日志）。
#[tauri::command]
pub fn apply_window_radius(app: AppHandle, radius: f64) -> AppResult<bool> {
    let applied_radius = crate::window_shape::set_radius(radius);
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| crate::error::AppError::Agent("主窗口不存在".into()))?;
    let applied = crate::window_shape::apply_on_main_thread(&win);
    tracing::debug!("窗口圆角 {}px，Win32 区域应用: {}", applied_radius, applied);
    Ok(applied)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WindowSnapState {
    pub edge: String, // left | right | top | bottom | none
    pub hidden: bool,
}

/// 贴边隐藏状态由前端维护并持久化（重启后恢复）。
#[tauri::command]
pub fn save_snap_state(db: State<'_, Arc<Db>>, state: WindowSnapState) -> AppResult<()> {
    db.set_setting("snap_state", serde_json::to_value(&state)?)
}

#[tauri::command]
pub fn get_snap_state(db: State<'_, Arc<Db>>) -> AppResult<Option<WindowSnapState>> {
    Ok(db
        .get_setting("snap_state")?
        .and_then(|v| serde_json::from_value(v).ok()))
}

/// 供调试：当前 Agent 总线健康状态。
#[tauri::command]
pub fn hub_health(hub: State<'_, std::sync::Arc<AgentHub>>) -> AppResult<serde_json::Value> {
    let snap = hub.snapshot()?;
    Ok(serde_json::json!({
        "sources": snap.sources.len(),
        "sessions": snap.sessions.len(),
        "runs": snap.runs.len(),
        "worst_state": hub.worst_state().as_str(),
    }))
}

/// 性能诊断快照：队列深度/容量、合并/采样/拒绝计数、延迟分位、HTTP 与文件投递、
/// SQLite 读延迟与事件表规模。单次查询轻量，受 `perf_diagnostics_enabled` 控制。
#[tauri::command]
pub fn performance_diagnostics(
    db: State<'_, Arc<Db>>,
    pipeline: State<'_, Arc<crate::agents::pipeline::IngestPipeline>>,
    hub: State<'_, Arc<AgentHub>>,
) -> AppResult<serde_json::Value> {
    let settings = crate::db::Settings::load(&db)?;
    if !settings.perf_diagnostics_enabled {
        return Ok(serde_json::json!({ "enabled": false }));
    }
    let snap = hub.snapshot()?;
    Ok(serde_json::json!({
        "enabled": true,
        "generated_at": crate::agents::now_iso(),
        "pipeline": pipeline.stats(),
        "http": crate::agents::http_ingest::stats_snapshot(),
        "file_drop": crate::agents::file_drop::stats_snapshot(),
        "sqlite": db.read_stats(),
        "retention": crate::agents::retention::retention_status(&db, &settings)?,
        "hub": {
            "sources": snap.sources.len(),
            "sessions": snap.sessions.len(),
            "runs": snap.runs.len(),
            "worst_state": hub.worst_state().as_str(),
        },
        // 前端刷新调度指标由前端 getAgentRefreshMetrics() 自行展示
        // （后端不伪造前端计数）。
    }))
}

// ── 窗口材质（毛玻璃）────────────────────────────────────────
//
// 说明：Tauri 原生 Window::set_effects 在 Windows 上会吞掉底层错误
// （tauri/src/vibrancy/windows.rs 的 apply_effects 返回 ()，set_effects 恒 Ok），
// 无法可靠判断是否生效。因此直接使用 window-vibrancy（Tauri 自身的
// Windows 传递依赖，零新增 crate）拿到真实 Result：
// - Win11（build ≥ 22000）：Mica（首选，性能好）
// - Win10 1803+（build ≥ 17134）：Acrylic
// - 更早/失败：返回 applied=false，前端回退 solid 不透明主题。

#[derive(Debug, Serialize)]
pub struct MaterialResult {
    /// 请求的材质
    pub material: String,
    /// 是否真正应用了原生效果
    pub applied: bool,
    /// 实际命中的效果名（mica / acrylic / none）
    pub effect: String,
    /// Windows 版本（含 build 号），供 UI 展示降级原因
    pub os_version: String,
}

/// Windows build 号（Win11 = 22000+，Acrylic = 1803/17134+）。
fn windows_build() -> u32 {
    // 不引入 winapi/winreg：ntdll 始终在进程内，直接取版本号
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetNtVersionNumbers(major: *mut u32, minor: *mut u32, build: *mut u32);
    }
    let (mut major, mut minor, mut build) = (0u32, 0u32, 0u32);
    unsafe { RtlGetNtVersionNumbers(&mut major, &mut minor, &mut build) };
    build & 0xFFFF
}

/// 在主线程上执行窗口材质调用（Win32 窗口操作统一走主线程）。
/// 带超时：主线程卡死/应用退出时不得无限等待。
fn run_material<F>(app: &AppHandle, f: F) -> bool
where
    F: FnOnce() -> bool + Send + 'static,
{
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or(false)
}

/// 应用/清除窗口原生材质效果。material: "solid" | "glass"。
/// 持久化由前端 update_settings 完成；这里只动窗口。
#[tauri::command]
pub fn apply_window_material(app: AppHandle, material: String) -> AppResult<MaterialResult> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| crate::error::AppError::Agent("主窗口不存在".into()))?;
    let build = windows_build();
    let os_version = format!("10.0.{}", build);

    if material != "glass" {
        let w = win.clone();
        let _ = run_material(&app, move || {
            window_vibrancy::clear_mica(&w).is_ok() | window_vibrancy::clear_acrylic(&w).is_ok()
        });
        return Ok(MaterialResult {
            material: "solid".into(),
            applied: false,
            effect: "none".into(),
            os_version,
        });
    }

    // Win11：Mica 优先
    if build >= 22000 {
        let w = win.clone();
        if run_material(&app, move || window_vibrancy::apply_mica(&w, None).is_ok()) {
            return Ok(MaterialResult {
                material: "glass".into(),
                applied: true,
                effect: "mica".into(),
                os_version,
            });
        }
    }
    // Win10 1803+：Acrylic
    if build >= 17134 {
        let w = win.clone();
        if run_material(&app, move || {
            window_vibrancy::apply_acrylic(&w, None).is_ok()
        }) {
            return Ok(MaterialResult {
                material: "glass".into(),
                applied: true,
                effect: "acrylic".into(),
                os_version,
            });
        }
    }
    // 不支持：确保无残留效果
    let w = win.clone();
    let _ = run_material(&app, move || {
        window_vibrancy::clear_mica(&w).is_ok() | window_vibrancy::clear_acrylic(&w).is_ok()
    });
    Ok(MaterialResult {
        material: "glass".into(),
        applied: false,
        effect: "none".into(),
        os_version,
    })
}
