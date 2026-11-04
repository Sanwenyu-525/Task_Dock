//! 系统级命令：退出、自启动、窗口模式、热键开关。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
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
    if let Err(e) = win.set_size(tauri::LogicalSize::new(w, h)) {
        // 原生拖拽循环期间 set_size 可能被拒绝；调用方需要回读验证（见前端 restoreModeSize）。
        tracing::warn!(mode, "设置模式窗口尺寸失败: {e}");
        return;
    }
    match win.outer_size() {
        Ok(size) => tracing::info!(
            mode,
            target_w = w,
            target_h = h,
            actual_w = size.width,
            actual_h = size.height,
            "模式窗口尺寸已应用"
        ),
        Err(e) => tracing::warn!(mode, "回读模式窗口尺寸失败: {e}"),
    }
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
    // 旧版总开关映射到「所有系统级快捷键」的启停，统一走快捷键管理器，
    // 不再各自直接调用插件，避免两套注册状态互相覆盖。
    let manager = crate::hotkeys::manager()
        .ok_or_else(|| crate::error::AppError::Unavailable("快捷键模块尚未初始化".to_string()))?;
    let outcome = manager.set_all_system_enabled(enabled)?;
    if !outcome.ok {
        // 部分失败：回退已改动的项，避免开关与实际注册状态不一致。
        let _ = manager.set_all_system_enabled(!enabled);
        let detail = outcome
            .results
            .iter()
            .filter(|result| !result.ok)
            .filter_map(|result| result.error.clone())
            .collect::<Vec<_>>()
            .join("；");
        return Err(crate::error::AppError::Unavailable(if detail.is_empty() {
            "部分系统级快捷键未能应用，已回退".to_string()
        } else {
            format!("部分系统级快捷键未能应用，已回退：{detail}")
        }));
    }
    db.set_setting("hotkey_enabled", serde_json::json!(enabled))?;
    crate::hotkeys::emit_changed(&app);
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
/// 前端按视觉预设下发：dream-gradient 18px / frosted 20px。
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

/// 胶囊几何常量：与前端 `src/lib/capsuleShape.ts` / `src/lib/capsuleLayout.ts`
/// 的 `WING_*` 是跨端契约（两端单测锁定；修改必须同步）。
///
/// 外框 = 平直主体 `LENGTH` + 两侧肩部 `CAPSULE_SHOULDER_CSS`（88）：
/// 224 + 2×88 = 400，与 CSS `.cap-v / .cap-h` 的 400px 和 SVG viewBox 一致。
/// 旧值 300 属于「外扩 26」时代的尺寸，会让 Rust 区域比 CSS 翼片高 38%（可见胶囊
/// 之外留下一条透明但可点击的命中带）。
pub const CAPSULE_THICKNESS_CSS: u32 = 56;
pub const CAPSULE_LENGTH_CSS: u32 = 224;

/// 胶囊区域写入的单调序号。前端在每次状态切换时自增并随请求下发；
/// IPC 命令可能并发执行，迟到的旧请求若先落到 `set_capsule` 会把区域改回旧形状。
/// 这里只允许「不小于已见最大序号」的请求通过，保证最终状态由最新请求决定。
/// 前端序号以页面加载时刻为基数（而非从 0 开始），WebView 重载后仍能保持单调。
static CAPSULE_APPLY_SEQ: AtomicU64 = AtomicU64::new(0);

/// 胶囊区域模式（分类胶囊）：
/// - `off`   ：恢复整窗圆角区域（未停靠 / 解除吸附）
/// - `rail`  ：只露出分类轨道（折叠态）
/// - `panel` ：露出「轨道 ∪ 功能面板」（展开态）
///
/// 窗口位置与尺寸在停靠期间**不变**，区域切换是唯一的状态变化——
/// 这是「鼠标在吸附条与悬浮窗口之间来回跳动」的结构性修复：
/// 命中区不再随窗口移动而移动。
#[tauri::command]
pub fn apply_window_capsule(app: AppHandle, mode: String, edge: String, seq: u64) -> AppResult<bool> {
    // 乱序保护：已有更高序号的请求落地过，本次旧请求直接丢弃，不再改写区域与原生层。
    if CAPSULE_APPLY_SEQ.fetch_max(seq, Ordering::SeqCst) > seq {
        tracing::debug!("忽略乱序的胶囊区域请求 seq={seq}");
        return Ok(false);
    }
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
    let entering = mode != "off";
    if entering {
        // 胶囊停靠态只用 CSS 玻璃：DWM 原生背景会越过区域，先把主窗的原生层停用
        // （解除吸附后恢复，见 restore_native_backdrop）。
        // 归属与 `window_shape::set_capsule` 同步：即使这次区域写入失败，
        // window_shape 里的胶囊参数仍然处于「已设置」，后续 apply 仍可能裁成轨道，
        // 因此原生层必须保持停用，直到 off 真正把区域恢复成整窗。
        set_capsule_owner(Some(hwnd));
        suspend_native_backdrop(&app, &win, hwnd);
    }
    let applied = crate::window_shape::apply_on_main_thread(&win);
    if !entering && applied {
        // 只有区域确实回到整窗才恢复原生背景：否则会立刻把原生底色画到
        // 仍是胶囊形状的窗口矩形之外（本任务修复的正是这种错配）。
        set_capsule_owner(None);
        restore_native_backdrop(&app, &win, hwnd, true);
    }
    tracing::debug!("胶囊区域 mode={mode}（edge={edge}）应用: {applied}");
    Ok(applied)
}

// ── 拖拽磁力（v0.7）──────────────────────────────────────────
//
// 吸引 / 阻力在原生 `WM_MOVING` 里完成（`crate::magnetic`）：系统模态移动循环
// 每帧给窗口一次"提议矩形"，改写它就能让窗口偏离鼠标 1:1 轨迹。
// 前端只下发**参数与停靠位**（低频、幂等），不参与逐帧移动——
// React 高频 `setPosition` 会与系统拖拽循环争抢窗口位置，必然抖动。

/// 磁力参数（CSS px）。`enabled=false` 时吸引与阻力**同时**失效，
/// 窗口完全按系统默认移动（`snap_enabled` 关闭必须彻底停用）。
///
/// 参数口径与前端 `src/lib/edgeSnap.ts` 的 `SNAP_MAGNET_*` 是跨端契约；
/// 越界/非法值按安全范围收敛，不写坏全局状态。
#[tauri::command]
pub fn set_magnetic_drag_config(enabled: bool, range: f64, max_lead: f64, release: f64) -> bool {
    let range = if range.is_finite() {
        range.clamp(8.0, 200.0)
    } else {
        56.0
    };
    let max_lead = if max_lead.is_finite() {
        max_lead.clamp(0.0, 64.0)
    } else {
        16.0
    };
    let release = if release.is_finite() {
        release.clamp(4.0, 200.0)
    } else {
        32.0
    };
    crate::magnetic::set_config(enabled, range, max_lead, release);
    crate::magnetic::installed()
}

/// 停靠位（物理像素，**齐平位置**）：`edge=null` 表示当前未停靠。
///
/// 阻力只对"已停靠且位置已知"的窗口生效；前端在停靠事务提交成功后调用，
/// 解除 / 关闭吸附 / 卸载引擎时传 `null` 清除。坐标非法时不写入，
/// 保持上一次状态（宁可没有阻力，也不按错误基准拉扯窗口）。
#[tauri::command]
pub fn set_magnetic_dock(edge: Option<String>, x: Option<f64>, y: Option<f64>) -> AppResult<bool> {
    let Some(edge) = edge else {
        crate::magnetic::set_dock(None, 0, 0);
        return Ok(true);
    };
    let id = match edge.as_str() {
        "left" => 0u8,
        "right" => 1,
        "top" => 2,
        "bottom" => 3,
        other => {
            return Err(crate::error::AppError::Validation(format!(
                "set_magnetic_dock.edge 非法: {other}（允许: left|right|top|bottom）"
            )))
        }
    };
    let (Some(x), Some(y)) = (x, y) else {
        return Ok(false);
    };
    if !x.is_finite() || !y.is_finite() {
        return Ok(false);
    }
    // 物理像素坐标：±2^23 之外不可能是真实窗口位置（防止 NaN/溢出写入）
    let (xi, yi) = (x.round(), y.round());
    if xi.abs() > 8_388_608.0 || yi.abs() > 8_388_608.0 {
        return Ok(false);
    }
    crate::magnetic::set_dock(crate::magnetic::Edge::from_id(id), xi as i32, yi as i32);
    Ok(true)
}

/// 拖离解除的鼠标锚定：请求原生在**拖拽循环内**把窗口恢复为 `mode` 的尺寸，
/// 并以「标题栏中心 = 光标」对齐（`magnetic::undock_anchor_rect`，含工作区钳制）。
///
/// **只有用户拖离胶囊的解除路径调用**：按钮解除 / 打开完整页 / 托盘唤回 /
/// 启动恢复等路径保持各自原有的定位策略，不得把窗口挪到鼠标下方。
/// `titlebar_css` 由前端从真实标题栏布局量取（不可测时回退其设计常量）。
/// 返回 false = 原生磁力层未安装（解除流程照常，由前端回退定位兜底）。
#[tauri::command]
pub fn set_undock_anchor(mode: String, titlebar_css: f64) -> bool {
    let mode = match mode.as_str() {
        "minimal" | "compact" | "full" => mode.as_str(),
        _ => "full",
    };
    let (w, h) = mode_size(mode);
    let tb = if titlebar_css.is_finite() {
        titlebar_css.clamp(16.0, 120.0)
    } else {
        41.0
    };
    crate::magnetic::request_undock_anchor(w, h, tb)
}

/// 查询锚定请求是否已在拖拽循环内应用（取后复位）。
/// false 时前端按**实际恢复后**的窗口尺寸自行定位（`undockAnchorTarget` 同口径）。
#[tauri::command]
pub fn take_undock_anchor_applied() -> bool {
    crate::magnetic::take_undock_anchor_applied()
}

/// 作废尚未应用的锚定请求（解除中止 / 区域清理失败回滚时防残留）。
#[tauri::command]
pub fn cancel_undock_anchor() {
    crate::magnetic::cancel_undock_anchor()
}

/// 前端首屏就绪：撤销启动阶段的 1×1 空白区域，让窗口按真实状态重算区域
/// （停靠恢复已完成 → 轨道；无恢复 → 整窗）。幂等。
///
/// 与 `show_main_window`（唤回：显示 + 聚焦 + snap-recall）职责不同：
/// 这条只做启动放行，不抢焦点、不触发唤回，也不会在未撤销时重复写区域。
#[tauri::command]
pub fn notify_ui_ready(app: AppHandle) -> bool {
    let cleared = crate::clear_startup_blank(&app);
    if cleared {
        tracing::debug!("前端首屏就绪，已撤销启动空白区域");
    }
    cleared
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
    /// 原生模糊是否真正生效（仅 mica / acrylic / blur 为 true）。
    /// 前端必须用它与 CSS 玻璃区分，不能把 applied 当原生。
    pub native: bool,
    /// 实际命中的效果名（mica / acrylic / blur / css / none）
    pub effect: String,
    /// Windows 版本（含 build 号），供 UI 展示降级原因
    pub os_version: String,
}

/// Windows build 号（Win11 = 22000+，Acrylic = 1803/17134+）。
pub(crate) fn windows_build() -> u32 {
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

// ── 胶囊停靠态的独立合成策略 ────────────────────────────────
//
// 真机像素证据（`tmp/acceptance/capsule-native-composition/`，2026-11-01）：
// 强制 `TASK_DOCK_GLASS_BACKEND=mica|acrylic` 时，即使 `GetWindowRgn` 回读只有轨道，
// DWM 的 SystemBackdrop 仍按**整个胶囊容器矩形**绘制——屏幕上表现为「胶囊上方/
// 周围一整块原生底色，桌面只能部分透出」。`SetWindowRgn` 只约束窗口自身合成层，
// 管不到 DWM 背景（与主窗圆角暗楔同源，见 docs/ui-themes/03-window-composition.md §3.0）。
//
// 因此胶囊停靠态使用**独立合成策略**：临时停用原生背景，只保留 CSS 玻璃；
// 期望效果记录在 desire 表，解除吸附（区域恢复整窗）后再恢复。
// 不新建窗口、不改系统级 DWM 设置，普通主窗的材质行为完全不变。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeBackdrop {
    None,
    Mica,
    Acrylic,
    Blur,
}

/// 主窗「未停靠时应当生效」的原生背景（由材质应用路径写入）。
static NATIVE_DESIRE: LazyLock<Mutex<HashMap<isize, NativeBackdrop>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 因胶囊停靠被临时停用的窗口（解除吸附时据此恢复）。
static NATIVE_SUSPENDED: LazyLock<Mutex<HashMap<isize, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 当前处于胶囊停靠态的主窗 hwnd（与 `window_shape::set_capsule` 同一入口写入）。
/// 用于「停靠期间切换材质」时拒绝重新挂原生层。
static CAPSULE_OWNER: LazyLock<Mutex<Option<isize>>> = LazyLock::new(|| Mutex::new(None));

fn hwnd_of<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

fn note_native_desire(hwnd: isize, effect: NativeBackdrop) {
    NATIVE_DESIRE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(hwnd, effect);
}

fn desired_backdrop(hwnd: isize) -> NativeBackdrop {
    NATIVE_DESIRE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&hwnd)
        .copied()
        .unwrap_or(NativeBackdrop::None)
}

fn capsule_active(hwnd: isize) -> bool {
    *CAPSULE_OWNER.lock().unwrap_or_else(|e| e.into_inner()) == Some(hwnd)
}

fn set_capsule_owner(hwnd: Option<isize>) {
    *CAPSULE_OWNER.lock().unwrap_or_else(|e| e.into_inner()) = hwnd;
}

fn clear_native_on_main<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
) -> bool {
    let w = win.clone();
    run_material(app, move || clear_native_materials(&w))
}

/// 胶囊停靠态的材质结果：原生层已停用，玻璃完全由 CSS 承担。
fn capsule_glass<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    hwnd: Option<isize>,
    os_version: String,
) -> MaterialResult {
    if let Some(h) = hwnd {
        suspend_native_backdrop(app, win, h);
    }
    MaterialResult {
        material: "glass".into(),
        applied: true,
        native: false,
        effect: "css".into(),
        os_version,
    }
}

/// 进入胶囊停靠态：清除原生背景（幂等；没有期望效果时不做任何事）。
fn suspend_native_backdrop<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    hwnd: isize,
) {
    let desired = desired_backdrop(hwnd);
    if desired == NativeBackdrop::None {
        return; // 本来就没有原生层（CSS 玻璃 / solid）
    }
    if NATIVE_SUSPENDED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&hwnd)
        .copied()
        .unwrap_or(false)
    {
        return; // 已停用
    }
    if clear_native_on_main(app, win) {
        NATIVE_SUSPENDED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(hwnd, true);
        tracing::debug!(
            hwnd,
            ?desired,
            "胶囊停靠：已暂停原生 DWM 背景（它不受 SetWindowRgn 约束）"
        );
    } else {
        tracing::warn!(
            hwnd,
            ?desired,
            "胶囊停靠：暂停原生 DWM 背景失败，胶囊容器矩形可能被整块原生底色覆盖"
        );
    }
}

/// 退出胶囊停靠态：按记录的期望效果恢复原生背景（幂等）。
///
/// 只有**区域确实恢复整窗**（调用方传入 verified）才恢复：区域写入失败时窗口仍是
/// 胶囊形状，此时挂原生层会立刻把整块原生底色画到区域之外。
fn restore_native_backdrop<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    hwnd: isize,
    verified: bool,
) {
    if !verified {
        return;
    }
    let was = NATIVE_SUSPENDED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&hwnd)
        .unwrap_or(false);
    if !was {
        return;
    }
    let desired = desired_backdrop(hwnd);
    let w = win.clone();
    let ok = run_material(app, move || match desired {
        NativeBackdrop::None => true,
        NativeBackdrop::Mica => window_vibrancy::apply_mica(&w, None).is_ok(),
        NativeBackdrop::Acrylic => window_vibrancy::apply_acrylic(&w, None).is_ok(),
        NativeBackdrop::Blur => window_vibrancy::apply_blur(&w, None).is_ok(),
    });
    if ok {
        tracing::debug!(hwnd, ?desired, "解除吸附：已恢复原生背景");
    } else {
        tracing::warn!(
            hwnd,
            ?desired,
            "解除吸附：恢复原生背景失败，界面回退 CSS 玻璃"
        );
    }
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
/// 圆角外直接透出桌面；CSS 玻璃用高不透明度霜面保证可读性，
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
/// material: "solid" | "glass"；`preset` 仅为调用契约保留：两套预设
/// （frosted / dream-gradient）共用同一原生材质策略，不再按预设名分支。
/// 持久化由调用方负责，这里只动窗口。
pub fn apply_material_to_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    material: &str,
    _preset: &str,
) -> MaterialResult {
    let build = windows_build();
    let os_version = format!("10.0.{}", build);
    let requested = glass_backend();
    // 预设不再影响原生后端：清透玻璃（2026-11 下线）曾在此强制 CSS 无原生层，
    // 现由两套预设共用默认策略（Win11+区域裁剪走 CSS，其余走 Acrylic 等）。
    let backend = effective_backend(&requested, build, region_clipping_enabled());
    // 胶囊停靠态：原生背景（Mica/Acrylic/blur）一律不挂到窗口——DWM 按整个窗口
    // 矩形绘制它，SetWindowRgn 裁不到（真机证据见文件上方「胶囊停靠态」小节）。
    // 只记录「未停靠时应生效」的效果，解除吸附后恢复；玻璃由 CSS 承担。
    let hwnd = hwnd_of(win);
    let in_capsule = hwnd.map(capsule_active).unwrap_or(false);

    if material != "glass" {
        if let Some(h) = hwnd {
            note_native_desire(h, NativeBackdrop::None);
        }
        let w = win.clone();
        let _ = run_material(app, move || clear_native_materials(&w));
        return MaterialResult {
            material: "solid".into(),
            applied: false,
            native: false,
            effect: "none".into(),
            os_version,
        };
    }

    // CSS 玻璃（Win11 + 区域裁剪的默认路径）：不挂任何原生材质。
    // 原生 blur/acr 层会越过区域圆角（暗楔），而 CSS 半透明没有原生层，
    // 圆角外直接透出桌面；CSS 玻璃用高不透明度霜面保证可读性
    // （见 styles-themes.css 的 `data-glass-render="css"`），视觉损失仅限「原生模糊」。
    if backend == "css" {
        if let Some(h) = hwnd {
            note_native_desire(h, NativeBackdrop::None);
        }
        let w = win.clone();
        let _ = run_material(app, move || clear_native_materials(&w));
        return MaterialResult {
            material: "glass".into(),
            applied: true,
            native: false,
            effect: "css".into(),
            os_version,
        };
    }

    // 区域裁剪兼容后端：系统背景由窗口自身合成，不会被 DWM 画到区域之外。
    if backend == "blur" || backend == "none" {
        let w = win.clone();
        let want_blur = backend == "blur";
        if want_blur {
            if let Some(h) = hwnd {
                note_native_desire(h, NativeBackdrop::Blur);
            }
        } else if let Some(h) = hwnd {
            note_native_desire(h, NativeBackdrop::None);
        }
        if want_blur && in_capsule {
            return capsule_glass(app, win, hwnd, os_version);
        }
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
            native: want_blur && ok,
            effect: if want_blur { "blur" } else { "none" }.into(),
            os_version,
        };
    }

    // 强制 Acrylic（Win11 上同样走 DWM SystemBackdrop，用于对照验证）。
    if backend == "acrylic" {
        if let Some(h) = hwnd {
            note_native_desire(h, NativeBackdrop::Acrylic);
        }
        if in_capsule {
            return capsule_glass(app, win, hwnd, os_version);
        }
        let w = win.clone();
        if run_material(app, move || {
            window_vibrancy::apply_acrylic(&w, None).is_ok()
        }) {
            return MaterialResult {
                material: "glass".into(),
                applied: true,
                native: true,
                effect: "acrylic".into(),
                os_version,
            };
        }
    }

    // Win11：Mica 优先
    if backend != "acrylic" && build >= 22000 {
        if let Some(h) = hwnd {
            note_native_desire(h, NativeBackdrop::Mica);
        }
        if in_capsule {
            return capsule_glass(app, win, hwnd, os_version);
        }
        let w = win.clone();
        if run_material(app, move || window_vibrancy::apply_mica(&w, None).is_ok()) {
            return MaterialResult {
                material: "glass".into(),
                applied: true,
                native: true,
                effect: "mica".into(),
                os_version,
            };
        }
    }
    // Win10 1803+：Acrylic
    if build >= 17134 {
        if let Some(h) = hwnd {
            note_native_desire(h, NativeBackdrop::Acrylic);
        }
        if in_capsule {
            return capsule_glass(app, win, hwnd, os_version);
        }
        let w = win.clone();
        if run_material(app, move || {
            window_vibrancy::apply_acrylic(&w, None).is_ok()
        }) {
            return MaterialResult {
                material: "glass".into(),
                applied: true,
                native: true,
                effect: "acrylic".into(),
                os_version,
            };
        }
    }
    // 不支持：确保无残留效果
    if let Some(h) = hwnd {
        note_native_desire(h, NativeBackdrop::None);
    }
    let w = win.clone();
    let _ = run_material(app, move || clear_native_materials(&w));
    MaterialResult {
        material: "glass".into(),
        applied: false,
        native: false,
        effect: "none".into(),
        os_version,
    }
}

/// 应用/清除窗口原生材质效果。material: "solid" | "glass"。
/// preset 仅为调用契约保留（缺省按当前默认预设 frosted）。
/// 持久化由前端 update_settings 完成；这里只动窗口。
#[tauri::command]
pub fn apply_window_material(
    app: AppHandle,
    material: String,
    preset: Option<String>,
) -> AppResult<MaterialResult> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| crate::error::AppError::Agent("主窗口不存在".into()))?;
    let preset = preset.unwrap_or_else(|| "frosted".into());
    Ok(apply_material_to_window(&app, &win, &material, &preset))
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
        // 弹窗始终按统一玻璃语义处理；preset 参数仅用于调用契约对齐。
        return apply_material_to_window(app, win, "glass", "frosted");
    }
    let w = win.clone();
    let _ = run_material(app, move || clear_native_materials(&w));
    MaterialResult {
        material: "glass".into(),
        applied: false,
        native: false,
        effect: "none".into(),
        os_version: format!("10.0.{}", windows_build()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_geometry_contract_matches_frontend() {
        // 跨端契约：与 src/lib/capsuleShape.ts / capsuleLayout.ts 同一组数字
        assert_eq!(CAPSULE_THICKNESS_CSS, 56);
        assert_eq!(CAPSULE_LENGTH_CSS, 224);
        assert_eq!(crate::window_shape::CAPSULE_SHOULDER_CSS, 88);
        for (scale, expect_t) in [(1.0f64, 56i32), (1.25, 70), (1.5, 84), (2.0, 112)] {
            let cap = crate::window_shape::CapsuleParams {
                edge: 0,
                thickness_css: CAPSULE_THICKNESS_CSS,
                length_css: CAPSULE_LENGTH_CSS,
                expanded: false,
            };
            // 断言**最终外框**：left 纵向 → width=厚度、
            // height=平直主体 + 2×肩部（88）
            let set = crate::window_shape::capsule_regions(2000, 1200, scale, &cap).unwrap();
            assert_eq!(set.rail.width, expect_t, "scale={scale}");
            // 主体与肩部**各自**取整后再相加（与 wing_metrics 一致），
            // 不能先加后乘：125% 下 round(110)=110、round(280)=280。
            assert_eq!(
                set.rail.height,
                (224.0f64 * scale).round() as i32 + 2 * (88.0f64 * scale).round() as i32,
                "scale={scale}"
            );
            // 区域是多边形而非外框矩形：外框缺角必须在区域之外
            let (nx, ny) = set.notch_probe.expect("应有缺角探针");
            let n = set.rail_polygon.len();
            let mut inside = false;
            for i in 0..n {
                let a = set.rail_polygon[i];
                let b = set.rail_polygon[(i + n - 1) % n];
                if (a.1 > ny) != (b.1 > ny) {
                    let x =
                        (b.0 - a.0) as f64 * (ny - a.1) as f64 / (b.1 - a.1) as f64 + a.0 as f64;
                    if (nx as f64) < x {
                        inside = !inside;
                    }
                }
            }
            assert!(!inside, "scale={scale} 缺角不得落在区域多边形内");
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

    /// 胶囊归属必须按 hwnd 隔离：右键菜单弹窗不得继承主窗的胶囊态，
    /// 否则菜单也会被当作「停靠中」而拒绝挂原生材质。
    #[test]
    fn capsule_owner_is_scoped_to_one_hwnd() {
        set_capsule_owner(Some(100));
        assert!(capsule_active(100));
        assert!(!capsule_active(200), "其他窗口不得继承胶囊归属");
        set_capsule_owner(None);
        assert!(!capsule_active(100), "解除吸附必须清空归属");
    }

    /// 期望原生背景按 hwnd 记录，缺省为 None（CSS 玻璃 / solid 不产生原生层）。
    #[test]
    fn native_desire_is_hwnd_scoped_and_defaults_to_none() {
        note_native_desire(100, NativeBackdrop::Mica);
        note_native_desire(200, NativeBackdrop::Acrylic);
        assert_eq!(desired_backdrop(100), NativeBackdrop::Mica);
        assert_eq!(desired_backdrop(200), NativeBackdrop::Acrylic);
        assert_eq!(
            desired_backdrop(300),
            NativeBackdrop::None,
            "未记录的窗口视为无原生层"
        );
        // 切回 solid / css 必须覆盖旧期望，解除吸附后不得恢复已弃用的效果
        note_native_desire(100, NativeBackdrop::None);
        assert_eq!(desired_backdrop(100), NativeBackdrop::None);
    }
}
