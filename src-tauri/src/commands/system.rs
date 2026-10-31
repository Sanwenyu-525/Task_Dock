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
        // 复用 show_and_focus：吸附隐藏态（窗口物理位置在屏外）时
        // 会下发 snap-recall 让前端引擎安全展开，仅 show/focus 找不回窗口。
        crate::show_and_focus(&win);
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

/// 胶囊几何常量：与前端 `src/lib/capsuleLayout.ts` 的 CAPSULE_* 跨端契约
/// （两端单测锁定；修改必须同步）。
pub const CAPSULE_THICKNESS_CSS: u32 = 56;
pub const CAPSULE_LENGTH_CSS: u32 = 300;

/// 胶囊区域模式（分类胶囊）：
/// - `off`   ：恢复整窗圆角区域（未停靠 / 解除吸附）
/// - `rail`  ：只露出分类轨道（折叠态）
/// - `panel` ：露出「轨道 ∪ 功能面板」（展开态）
///
/// 窗口位置与尺寸在停靠期间**不变**，区域切换是唯一的状态变化——
/// 这是「鼠标在吸附条与悬浮窗口之间来回跳动」的结构性修复：
/// 命中区不再随窗口移动而移动。
#[tauri::command]
pub fn apply_window_capsule(app: AppHandle, mode: String, edge: String) -> AppResult<bool> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| crate::error::AppError::Agent("主窗口不存在".into()))?;
    let hwnd = win
        .hwnd()
        .map(|h| h.0 as isize)
        .map_err(|e| crate::error::AppError::Agent(format!("无法获取主窗口句柄: {e}")))?;
    match mode.as_str() {
        "off" => crate::window_shape::set_capsule(hwnd, None),
        "rail" | "panel" => {
            let edge_id = match edge.as_str() {
                "left" => 0,
                "right" => 1,
                "top" => 2,
                "bottom" => 3,
                other => {
                    return Err(crate::error::AppError::Validation(format!(
                        "apply_window_capsule.edge 非法: {other}（允许: left|right|top|bottom）"
                    )));
                }
            };
            crate::window_shape::set_capsule(
                hwnd,
                Some(crate::window_shape::CapsuleParams {
                    edge: edge_id,
                    thickness_css: CAPSULE_THICKNESS_CSS,
                    length_css: CAPSULE_LENGTH_CSS,
                    expanded: mode == "panel",
                }),
            );
        }
        other => {
            return Err(crate::error::AppError::Validation(format!(
                "apply_window_capsule.mode 非法: {other}（允许: off|rail|panel）"
            )));
        }
    }
    let applied = crate::window_shape::apply_on_main_thread(&win);
    tracing::debug!("胶囊区域 mode={mode}（edge={edge}）应用: {applied}");
    Ok(applied)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WindowSnapState {
    pub edge: String, // left | right | top | bottom | none
    pub hidden: bool,
    /// 胶囊沿边中心（物理像素）：left/right 用 y，top/bottom 用 x。
    /// 可选——旧版本记录没有该字段，缺失时按当前窗口中心重新停靠。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<f64>,
}

impl WindowSnapState {
    /// edge 白名单校验：垃圾值不得入库（重启恢复按该值直接停靠）。
    pub fn is_valid(&self) -> bool {
        matches!(
            self.edge.as_str(),
            "left" | "right" | "top" | "bottom" | "none"
        )
    }
}

/// 贴边隐藏状态由前端维护并持久化（重启后恢复）。
#[tauri::command]
pub fn save_snap_state(db: State<'_, Arc<Db>>, state: WindowSnapState) -> AppResult<()> {
    if !state.is_valid() {
        return Err(crate::error::AppError::Validation(format!(
            "snap_state.edge 非法: {}（允许: left|right|top|bottom|none）",
            state.edge
        )));
    }
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
// - Win11 + 区域裁剪（默认）：**CSS 玻璃**（不挂原生材质，避免圆角暗楔）
// - Win11 关闭区域裁剪（矩阵对照）：Mica
// - Win10 1803+（build ≥ 17134）：Acrylic
// - 更早/失败：返回 applied=false，前端回退 solid 不透明主题。

#[derive(Debug, Serialize)]
pub struct MaterialResult {
    /// 请求的材质
    pub material: String,
    /// 是否应用了玻璃效果（原生材质或 CSS 半透明均计为 true；
    /// CSS 模式下桌面仍可透出，只是不做原生模糊）
    pub applied: bool,
    /// 实际命中的效果名（mica / acrylic / blur / css / none）
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
fn run_material<R: tauri::Runtime, F>(app: &AppHandle<R>, f: F) -> bool
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

/// 原生玻璃后端选择（环境变量，矩阵对照/回归用）。
fn glass_backend() -> String {
    std::env::var("TASK_DOCK_GLASS_BACKEND")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "auto".into())
}

fn clear_native_materials<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> bool {
    window_vibrancy::clear_mica(win).is_ok()
        | window_vibrancy::clear_acrylic(win).is_ok()
        | window_vibrancy::clear_blur(win).is_ok()
}

/// Win32 区域裁剪是否启用（口径与 window_shape::flag 一致）。
fn region_clipping_enabled() -> bool {
    std::env::var("TASK_DOCK_WINDOW_REGION")
        .map(|v| v != "0")
        .unwrap_or(true)
}

/// 原生玻璃后端选择（真机矩阵验收用）。
/// - `auto`：Win11 且区域裁剪开启 → **css**（不挂原生材质，CSS 玻璃）；
///   Win11 未裁剪 → Mica；Win10 → Acrylic
/// - `mica` / `acrylic` / `blur` / `css` / `none`：强制指定后端（矩阵对照/回归用）
///
/// 为什么默认不是 blur：Win11（build ≥ 22621）的 legacy
/// `ACCENT_ENABLE_BLURBEHIND` 由 DWM 按**整个窗口矩形**合成，`SetWindowRgn`
/// 裁不到它；圆角外会留下暗/亮楔形（真机像素：blur 角部 [1,11,1]、
/// acrylic [84,84,84]，无原生材质时同位置干净）。CSS 半透明玻璃没有原生层，
/// 圆角外直接透出桌面，且 liquid 的 `--window-fill` 本就 76–86% 不透明，
/// 视觉损失仅限于「原生模糊」这一层。显式指定的后端原样保留，供矩阵对照。
fn effective_backend(requested: &str, build: u32, region_enabled: bool) -> String {
    match requested {
        "mica" | "acrylic" | "blur" | "css" | "none" => requested.to_string(),
        _ if build >= 22000 && region_enabled => "css".to_string(),
        _ => "auto".to_string(),
    }
}

/// 对**任意**应用窗口应用/清除原生材质（主窗与右键菜单弹窗共用）。
/// 后端选择走同一套 `effective_backend`：Win11 + 区域裁剪 → css（CSS 玻璃，
/// 无原生层），Win10 → Acrylic，显式后端原样保留供矩阵对照。
/// material: "solid" | "glass"；持久化由调用方负责，这里只动窗口。
pub fn apply_material_to_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    material: &str,
) -> MaterialResult {
    let build = windows_build();
    let os_version = format!("10.0.{}", build);
    let backend = effective_backend(&glass_backend(), build, region_clipping_enabled());

    if material != "glass" {
        let w = win.clone();
        let _ = run_material(app, move || clear_native_materials(&w));
        return MaterialResult {
            material: "solid".into(),
            applied: false,
            effect: "none".into(),
            os_version,
        };
    }

    // CSS 玻璃（Win11 + 区域裁剪的默认路径）：不挂任何原生材质。
    // 原生 blur/acr 层会越过区域圆角（暗楔），而 CSS 半透明没有原生层，
    // 圆角外直接透出桌面；liquid 的 window-fill 本就 76–86% 不透明，
    // 停用原生模糊的视觉损失有限，且彻底消除暗楔。
    if backend == "css" {
        let w = win.clone();
        let _ = run_material(app, move || clear_native_materials(&w));
        return MaterialResult {
            material: "glass".into(),
            applied: true,
            effect: "css".into(),
            os_version,
        };
    }

    // 区域裁剪兼容后端：系统背景由窗口自身合成，不会被 DWM 画到区域之外。
    if backend == "blur" || backend == "none" {
        let w = win.clone();
        let want_blur = backend == "blur";
        let ok = run_material(app, move || {
            let _ = window_vibrancy::clear_mica(&w);
            let _ = window_vibrancy::clear_acrylic(&w);
            if want_blur {
                window_vibrancy::apply_blur(&w, None).is_ok()
            } else {
                true
            }
        });
        return MaterialResult {
            material: "glass".into(),
            applied: want_blur && ok,
            effect: if want_blur { "blur" } else { "none" }.into(),
            os_version,
        };
    }

    // 强制 Acrylic（Win11 上同样走 DWM SystemBackdrop，用于对照验证）。
    if backend == "acrylic" {
        let w = win.clone();
        if run_material(app, move || {
            window_vibrancy::apply_acrylic(&w, None).is_ok()
        }) {
            return MaterialResult {
                material: "glass".into(),
                applied: true,
                effect: "acrylic".into(),
                os_version,
            };
        }
    }

    // Win11：Mica 优先
    if backend != "acrylic" && build >= 22000 {
        let w = win.clone();
        if run_material(app, move || window_vibrancy::apply_mica(&w, None).is_ok()) {
            return MaterialResult {
                material: "glass".into(),
                applied: true,
                effect: "mica".into(),
                os_version,
            };
        }
    }
    // Win10 1803+：Acrylic
    if build >= 17134 {
        let w = win.clone();
        if run_material(app, move || {
            window_vibrancy::apply_acrylic(&w, None).is_ok()
        }) {
            return MaterialResult {
                material: "glass".into(),
                applied: true,
                effect: "acrylic".into(),
                os_version,
            };
        }
    }
    // 不支持：确保无残留效果
    let w = win.clone();
    let _ = run_material(app, move || clear_native_materials(&w));
    MaterialResult {
        material: "glass".into(),
        applied: false,
        effect: "none".into(),
        os_version,
    }
}

/// 应用/清除窗口原生材质效果。material: "solid" | "glass"。
/// 持久化由前端 update_settings 完成；这里只动窗口。
#[tauri::command]
pub fn apply_window_material(app: AppHandle, material: String) -> AppResult<MaterialResult> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| crate::error::AppError::Agent("主窗口不存在".into()))?;
    Ok(apply_material_to_window(&app, &win, &material))
}

/// 右键菜单弹窗的材质策略（真机矩阵结论，visual-remediation/native-composition）：
/// **默认不挂任何原生材质**。DWM 的 blur/acrylic 层按整个窗口矩形合成，
/// 透明像素按黑处理 —— 区域裁剪管不到它，半透明玻璃的圆角外/圆角带处
/// 必然出现黑楔（真机像素：blur 角部 [12,12,12]、acrylic [84,84,84]，
/// 无材质时同位置干净）。菜单玻璃由 CSS 半透明承担，桌面色彩仍可透出。
/// 显式设置 `TASK_DOCK_GLASS_BACKEND` 时按指定后端应用（矩阵对照/回归用）。
pub fn apply_menu_material<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
) -> MaterialResult {
    let forced = std::env::var("TASK_DOCK_GLASS_BACKEND")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if forced {
        return apply_material_to_window(app, win, "glass");
    }
    let w = win.clone();
    let _ = run_material(app, move || clear_native_materials(&w));
    MaterialResult {
        material: "glass".into(),
        applied: false,
        effect: "none".into(),
        os_version: format!("10.0.{}", windows_build()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_geometry_contract_matches_frontend() {
        // 跨端契约：与 src/lib/capsuleLayout.ts 的 CAPSULE_RAIL_THICKNESS/LENGTH 一致
        assert_eq!(CAPSULE_THICKNESS_CSS, 56);
        assert_eq!(CAPSULE_LENGTH_CSS, 300);
        for (scale, expect_t) in [(1.0f64, 56i32), (1.25, 70), (1.5, 84), (2.0, 112)] {
            let cap = crate::window_shape::CapsuleParams {
                edge: 0,
                thickness_css: CAPSULE_THICKNESS_CSS,
                length_css: CAPSULE_LENGTH_CSS,
                expanded: false,
            };
            // 断言**最终矩形**：left 纵向 → width=厚度、height=长度
            let set = crate::window_shape::capsule_regions(2000, 1200, scale, &cap).unwrap();
            assert_eq!(set.rail.width, expect_t, "scale={scale}");
            assert_eq!(
                set.rail.height,
                (300.0f64 * scale).round() as i32,
                "scale={scale}"
            );
        }
    }

    #[test]
    fn snap_state_edge_whitelist() {
        assert!(WindowSnapState {
            edge: "left".into(),
            hidden: true,
            center: None
        }
        .is_valid());
        assert!(WindowSnapState {
            edge: "none".into(),
            hidden: false,
            center: Some(540.0)
        }
        .is_valid());
        assert!(!WindowSnapState {
            edge: "banana".into(),
            hidden: true,
            center: None
        }
        .is_valid());
        assert!(!WindowSnapState {
            edge: String::new(),
            hidden: false,
            center: None
        }
        .is_valid());
    }

    #[test]
    fn win11_auto_backend_uses_css_when_region_clipping() {
        // 区域裁剪 + Win11：Mica/Acrylic 与 legacy blur 都会越过区域圆角留下暗楔，
        // 默认改为无原生材质的 CSS 玻璃（桌面经半透明 tint 透出）。
        assert_eq!(effective_backend("auto", 26100, true), "css");
        // 关闭区域（矩阵对照）时才允许 DWM SystemBackdrop
        assert_eq!(effective_backend("auto", 26100, false), "auto");
        // Win10 的 Acrylic 走 SetWindowCompositionAttribute，不受此限制
        assert_eq!(effective_backend("auto", 19045, true), "auto");
    }

    #[test]
    fn explicit_backend_is_never_rewritten() {
        for backend in ["mica", "acrylic", "blur", "css", "none"] {
            assert_eq!(effective_backend(backend, 26100, true), backend);
            assert_eq!(effective_backend(backend, 26100, false), backend);
        }
        // 未知值按 auto 处理，保持原有容错
        assert_eq!(effective_backend("weird", 26100, true), "css");
        assert_eq!(effective_backend("weird", 26100, false), "auto");
    }
}
