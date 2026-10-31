//! 液态玻璃右键菜单（v0.6）：独立透明弹出窗口 + 统一锚点定位。
//!
//! 取代原托盘原生 `Menu`（Windows 深灰系统样式）。悬浮栏右键与托盘右键
//! 共用同一个 `context-menu` 窗口（tauri.conf.json 声明、启动即创建并隐藏）：
//!
//! - **可回收**：窗口常驻复用，关闭只是 `hide()`，不存在反复创建/销毁的
//!   窗口与 WebView 泄漏；内容高度通过 `fit_context_menu` 一次性回传
//!   （宽度是设计常量，不回传，避免测量回环漂移）。
//! - **定位**：`place_menu` 纯函数 —— 菜单优先在锚点**上方**展开，
//!   空间不足翻到下方，仍放不下则收进工作区；水平方向以锚点为中心、
//!   左右越界时收进工作区。物理像素 = 逻辑尺寸 × 锚点所在显示器缩放，
//!   多显示器按 `monitor_from_point` 取工作区（100%~200% DPI 均按此换算）。
//! - **材质**：与主窗共用 `apply_material_to_window`（v0.6 整改）——
//!   Win11 + 区域裁剪 → blur（窗口自身合成，受 SetWindowRgn 约束），
//!   不再用 apply_acrylic（Win11 上是 DWM SystemBackdrop，会越过区域
//!   在圆角外画出灰蓝残影，见 docs/ui-themes/12-v06-window-corners.md）。
//! - **动作**：`context_menu_action` 与原托盘 `on_menu_event` 一一对应，
//!   复用同一批 inner 函数（apply_mode_inner / set_autostart_inner /
//!   request_exit），不创建第二份状态源；失败返回错误、成功才广播事件
//!   并回传最新快照（不虚假显示成功）。
//! - **关闭**：Escape（弹窗内处理）、点击有效菜单项、失焦（弹窗 Focused(false)）、
//!   **前台切换钩子**（EVENT_SYSTEM_FOREGROUND：点击桌面/其他应用时即使弹窗
//!   从未获得焦点也能收到通知，事件驱动、无轮询）。所有路径都经
//!   BLUR_TOKEN 延迟合并：右键重开时 show 取消未决关闭，不闪烁。

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::db::Db;

pub const WINDOW_LABEL: &str = "context-menu";
/// 后端 → 菜单窗口：即将在锚点处显示（刷新设置快照 + 重放入场动画 + 回传尺寸）。
pub const SHOW_EVENT: &str = "context-menu-show";

/// 菜单 CSS 圆角（逻辑像素），与 styles-context-menu.css 的 border-radius 一致。
pub const MENU_RADIUS: f64 = 16.0;
/// 菜单边缘与屏幕锚点的间距（物理像素）。
pub const ANCHOR_GAP: f64 = 8.0;
/// 工作区安全边距（物理像素）。
pub const EDGE_MARGIN: f64 = 6.0;
/// 失焦延迟关闭毫秒数：覆盖「主窗口夺焦 → contextmenu 重开」的竞态窗口。
pub const BLUR_CLOSE_DELAY_MS: u64 = 160;

/// 弹窗默认逻辑尺寸（与 tauri.conf.json 的 width/height 保持一致）。
/// 宽度是设计常量（250px，规范建议 230–250）；初始高度取内容上界，
/// 首开后 fit_context_menu 只收放**高度**到实测内容高度，
/// 宽度不再回环（避免 测量→set_size→再测量 的舍入漂移）。
const DEFAULT_SIZE: (f64, f64) = (250.0, 620.0);

/// 最近一次显示的锚点（屏幕物理坐标）。
static ANCHOR: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));
/// 菜单内容的逻辑高度（前端 fit_context_menu 回传后缓存；宽度恒为 DEFAULT_SIZE.0）。
static MENU_HEIGHT: Mutex<f64> = Mutex::new(620.0);
/// 失焦延迟关闭令牌：show/fit/hide 都会 bump 使未决任务失效。
static BLUR_TOKEN: AtomicU64 = AtomicU64::new(0);
/// 弹窗是否已应用原生材质（失败在下次显示时重试，不阻塞打开路径）。
static MATERIAL_APPLIED: AtomicBool = AtomicBool::new(false);
/// 弹窗 Win32 句柄（前台钩子回调里做 O(1) 比较，避免在回调内查询 Tauri 状态）。
static MENU_HWND: AtomicIsize = AtomicIsize::new(0);
/// 前台钩子回调使用的应用句柄（钩子只在此处取句柄，不做其他查询）。
static HOOK_APP: OnceLock<AppHandle> = OnceLock::new();

// ── 定位（纯函数，可单测）────────────────────────────────────

/// 工作区（物理像素，绝对屏幕坐标）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl WorkArea {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
}

/// 计算菜单窗口的物理位置。
///
/// - 垂直：优先**上方**（菜单底边在锚点上方 ANCHOR_GAP）；上方放不下改下方；
///   下方也放不下则贴工作区底边（极端小工作区再贴顶边）。
/// - 水平：以锚点为中心；右侧越界收右边，左侧越界收左边。
/// - `menu_logical` 为逻辑像素，按 `scale` 换算为物理像素（DPI 适配）。
pub fn place_menu(
    anchor: (f64, f64),
    menu_logical: (f64, f64),
    scale: f64,
    wa: WorkArea,
) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let mw = (menu_logical.0 * scale).round();
    let mh = (menu_logical.1 * scale).round();
    let wa_right = wa.x as f64 + wa.w as f64;
    let wa_bottom = wa.y as f64 + wa.h as f64;
    let min_x = wa.x as f64 + EDGE_MARGIN;
    let min_y = wa.y as f64 + EDGE_MARGIN;
    // 工作区比菜单还窄/矮时，clamp 区间退化为「贴起点边」而不是负坐标
    let max_x = (wa_right - EDGE_MARGIN - mw).max(min_x);
    let max_y = (wa_bottom - EDGE_MARGIN - mh).max(min_y);

    let top_above = anchor.1 - ANCHOR_GAP - mh;
    let top = if top_above >= min_y {
        top_above
    } else {
        let top_below = anchor.1 + ANCHOR_GAP;
        if top_below <= max_y {
            top_below
        } else {
            max_y
        }
    };

    let centered = anchor.0 - mw / 2.0;
    let left = if centered > max_x {
        max_x
    } else {
        centered.max(min_x)
    };

    (left.round() as i32, top.round() as i32)
}

// ── 窗口生命周期 ─────────────────────────────────────────────

/// 菜单弹窗的原生材质：**默认不挂**（v0.6 整改的真机矩阵结论）——
/// DWM blur/acrylic 都按整个窗口矩形合成、透明像素按黑处理，
/// 在区域圆角处留下黑楔；菜单玻璃由 CSS 半透明承担（桌面色彩可透出）。
/// 显式 `TASK_DOCK_GLASS_BACKEND` 时按指定后端应用（矩阵对照/回归用）。
/// 幂等，已处理则跳过；失败不阻塞打开。
pub fn apply_material(app: &AppHandle) {
    if MATERIAL_APPLIED.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = menu_window(app) else { return };
    let result = crate::commands::system::apply_menu_material(app, &win);
    MATERIAL_APPLIED.store(true, Ordering::Relaxed);
    tracing::debug!(
        effect = %result.effect,
        applied = result.applied,
        "右键菜单原生材质"
    );
}

fn menu_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn cached_size() -> (f64, f64) {
    (
        DEFAULT_SIZE.0,
        *MENU_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()),
    )
}

fn cancel_pending_blur_close() {
    BLUR_TOKEN.fetch_add(1, Ordering::SeqCst);
}

/// 失焦后延迟关闭。直接在 Focused(false) 里 hide 会打断
/// 「主窗口夺焦 → contextmenu 事件 → show 重开」的正常序列。
/// 主窗口夺焦（= 菜单外点击 / 右键重开）也走同一条延迟路径：
/// show 会 bump 令牌取消未决关闭，因此重开不闪烁。
pub fn schedule_blur_close(app: &AppHandle) {
    let token = BLUR_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(BLUR_CLOSE_DELAY_MS)).await;
        // 期间发生过 show/hide/再次失焦：本任务已过期
        if BLUR_TOKEN.load(Ordering::SeqCst) != token {
            return;
        }
        if let Some(win) = menu_window(&app) {
            // 焦点在延迟期间回到菜单（例如 show 紧随其后）则不关
            if win.is_visible().unwrap_or(false) && !win.is_focused().unwrap_or(true) {
                let _ = win.hide();
            }
        }
    });
}

// ── 前台切换钩子（事件驱动的「菜单外点击关闭」）──────────────
//
// 背景：点击桌面空白处/其他应用时，Windows 前台转移走；若弹窗因受限前台
// 策略从未真正获得焦点，它收不到自己的 Focused(false)，菜单就会残留。
// EVENT_SYSTEM_FOREGROUND（SetWinEventHook）在**前台窗口变化**时回调，
// 是操作系统的事件通知而非轮询；回调里只做 O(1) 句柄比较，实际关闭走
// 既有的延迟令牌路径（show 可取消，右键重开不闪烁）。

#[cfg(windows)]
mod foreground_hook {
    use super::{schedule_blur_close, HOOK_APP, MENU_HWND};
    use std::sync::atomic::Ordering;
    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Accessibility::SetWinEventHook;

    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
    const OBJID_WINDOW: i32 = 0;
    const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;

    /// 回调运行在安装线程（Tauri 主线程）的消息泵上：
    /// 只允许 O(1) 比较 + 令牌调度，禁止任何会泵消息的 Win32/Tauri 查询。
    unsafe extern "system" fn on_foreground(
        _hook: *mut core::ffi::c_void,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event != EVENT_SYSTEM_FOREGROUND || id_object != OBJID_WINDOW {
            return;
        }
        let fg = hwnd as isize;
        if fg == 0 || fg == MENU_HWND.load(Ordering::Relaxed) {
            // 前台切到菜单自身（show 后正常获得焦点）：不 bump 令牌，
            // 否则会取消正在等待的合法关闭。
            return;
        }
        if let Some(app) = HOOK_APP.get() {
            schedule_blur_close(app);
        }
    }

    /// 在主线程安装钩子（进程生命周期内有效；进程退出由系统回收）。
    pub fn install(app: &AppHandle) {
        let hook_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            HOOK_APP.set(hook_app).ok();
            let hook = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    std::ptr::null_mut(),
                    Some(on_foreground),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hook.is_null() {
                tracing::debug!(
                    "EVENT_SYSTEM_FOREGROUND 钩子安装失败（依赖 Focused 事件路径关闭）"
                );
            } else {
                tracing::debug!("前台切换钩子已安装（菜单外点击关闭）");
            }
        });
    }
}

#[cfg(not(windows))]
mod foreground_hook {
    pub fn install(_app: &AppHandle) {}
}

/// 解析锚点所在显示器的工作区与缩放；取不到时退回主显示器。
fn monitor_at(app: &AppHandle, anchor: (f64, f64)) -> Option<(WorkArea, f64)> {
    let from_point = app.monitor_from_point(anchor.0, anchor.1).ok().flatten();
    let monitor = from_point.or_else(|| {
        app.available_monitors()
            .ok()
            .and_then(|mons| {
                mons.into_iter().find(|m| {
                    let (p, s) = (m.position(), m.size());
                    anchor.0 >= p.x as f64
                        && anchor.0 < (p.x + s.width as i32) as f64
                        && anchor.1 >= p.y as f64
                        && anchor.1 < (p.y + s.height as i32) as f64
                })
            })
            .or_else(|| app.primary_monitor().ok().flatten())
    })?;
    let rect = monitor.work_area();
    Some((
        WorkArea::new(
            rect.position.x,
            rect.position.y,
            rect.size.width as i32,
            rect.size.height as i32,
        ),
        monitor.scale_factor(),
    ))
}

fn compute_position(
    app: &AppHandle,
    anchor: (f64, f64),
    size: (f64, f64),
) -> Option<PhysicalPosition<i32>> {
    let (wa, scale) = monitor_at(app, anchor)?;
    let (x, y) = place_menu(anchor, size, scale, wa);
    Some(PhysicalPosition::new(x, y))
}

/// 在锚点处显示菜单（托盘右键与悬浮栏右键共用）。
pub fn show_at(app: &AppHandle, anchor: (f64, f64)) {
    let Some(win) = menu_window(app) else {
        tracing::warn!("context-menu 窗口不存在（未在 tauri.conf.json 声明？）");
        return;
    };
    tracing::info!(anchor = ?anchor, "右键菜单：请求显示");
    *ANCHOR.lock().unwrap_or_else(|e| e.into_inner()) = anchor;
    // 右键重开：取消未决失焦关闭，避免「关闭-显示」竞态闪烁
    cancel_pending_blur_close();
    apply_material(app);
    if let Some(pos) = compute_position(app, anchor, cached_size()) {
        tracing::debug!(pos = ?pos, "右键菜单：定位完成");
        let _ = win.set_position(pos);
    }
    if let Err(e) = win.show() {
        tracing::warn!("显示右键菜单失败: {e}");
        return;
    }
    // 首次显示不一定触发 Resized 事件：显示时确保圆角区域与当前尺寸一致
    crate::window_shape::apply_with_radius(&win, MENU_RADIUS);
    let _ = win.set_focus();
    // 内容收到事件后刷新设置快照、重放入场动画并回传实测尺寸（fit）
    let _ = app.emit_to(WINDOW_LABEL, SHOW_EVENT, ());
}

/// 悬浮栏右键：锚定悬浮栏顶边中点（菜单优先在其上方展开）。
pub fn show_from_bar(app: &AppHandle) {
    tracing::debug!("右键菜单：收到悬浮栏显示请求");
    let anchor = app
        .get_webview_window("main")
        .and_then(|win| {
            let pos = win.outer_position().ok()?;
            let size = win.outer_size().ok()?;
            Some((pos.x as f64 + size.width as f64 / 2.0, pos.y as f64))
        })
        // 窗口几何取不到（异常早退场景）时退回光标位置
        .or_else(|| app.cursor_position().ok().map(|p| (p.x, p.y)));
    match anchor {
        Some(anchor) => show_at(app, anchor),
        None => tracing::warn!("右键菜单锚点不可用（主窗口与光标位置均不可得）"),
    }
}

pub fn hide(app: &AppHandle) {
    cancel_pending_blur_close();
    if let Some(win) = menu_window(app) {
        let _ = win.hide();
    }
}

/// 启动时挂接弹窗窗口事件：失焦延迟关闭 + 尺寸/DPI 变化重算圆角区域，
/// 预应用原生材质（失败不致命，show 时还会重试），
/// 安装前台切换钩子（点击桌面/其他应用关闭菜单，事件驱动），
/// 并在销毁时清理区域缓存。
pub fn init(app: &AppHandle) {
    if let Some(win) = menu_window(app) {
        if let Ok(h) = win.hwnd() {
            MENU_HWND.store(h.0 as isize, Ordering::Relaxed);
        }
        let w = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::Focused(false) => schedule_blur_close(w.app_handle()),
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                crate::window_shape::apply_with_radius(&w, MENU_RADIUS);
            }
            tauri::WindowEvent::Destroyed => {
                if let Ok(h) = w.hwnd() {
                    crate::window_shape::forget_window(h.0 as isize);
                }
                MENU_HWND.store(0, Ordering::Relaxed);
            }
            _ => {}
        });
        apply_material(app);
    }
    foreground_hook::install(app);
}

// ── 命令 ─────────────────────────────────────────────────────

/// 悬浮栏右键入口（前端作用域化 contextmenu 后调用）。
#[tauri::command]
pub fn show_context_menu(app: AppHandle) {
    show_from_bar(&app);
}

#[tauri::command]
pub fn hide_context_menu(app: AppHandle) {
    hide(&app);
}

/// 菜单内容把实测逻辑高度回传给后端：收放窗口**高度**并按锚点重新定位。
/// 宽度是设计常量（DEFAULT_SIZE.0），不由前端回传，避免测量回环漂移。
/// 高度未变化时不做任何事（重复 show 不会反复 resize）。
#[tauri::command]
pub fn fit_context_menu(app: AppHandle, height: f64) {
    let h = height.clamp(80.0, 900.0);
    let ch = *MENU_HEIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if (ch - h).abs() < 0.5 {
        return;
    }
    *MENU_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()) = h;
    let w = DEFAULT_SIZE.0;
    let Some(win) = menu_window(&app) else { return };
    let visible = win.is_visible().unwrap_or(false);
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
    if visible {
        let anchor = *ANCHOR.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = compute_position(&app, anchor, (w, h)) {
            let _ = win.set_position(pos);
        }
    }
}

/// 动作执行结果（v0.6 整改）：成功回传**最新设置快照**（菜单据此渲染勾选态，
/// 不做乐观更新）；失败返回可读原因 —— 主题/自启动失败时不会广播成功状态。
#[derive(Debug, Serialize)]
pub struct MenuActionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<MenuSnapshot>,
}

/// 菜单勾选态所需的最小设置快照（与前端 items.ts 的 MenuSnapshot 对应）。
#[derive(Debug, Serialize)]
pub struct MenuSnapshot {
    pub mode: String,
    pub theme: String,
    pub autostart: bool,
    pub visual_preset: String,
}

fn read_snapshot(db: &Db) -> Option<MenuSnapshot> {
    crate::db::Settings::load(db).ok().map(|s| MenuSnapshot {
        mode: s.mode,
        theme: s.theme,
        autostart: s.autostart,
        visual_preset: s.visual_preset,
    })
}

fn ok_result(db: &Db) -> MenuActionResult {
    MenuActionResult {
        ok: true,
        error: None,
        snapshot: read_snapshot(db),
    }
}

fn err_result(db: &Db, message: String) -> MenuActionResult {
    // 失败也回传**当前真实快照**：菜单不得显示虚假的勾选状态
    MenuActionResult {
        ok: false,
        error: Some(message),
        snapshot: read_snapshot(db),
    }
}

/// 菜单项动作：与前端 items.ts 的 action 字符串一一对应。
/// 复用原托盘 on_menu_event 的全部业务路径，不另起状态源。
/// 返回执行结果与最新快照；失败时错误信息进入现有日志与弹窗内联反馈。
#[tauri::command]
pub fn context_menu_action(
    app: AppHandle,
    db: tauri::State<'_, std::sync::Arc<Db>>,
    action: String,
) -> MenuActionResult {
    hide(&app);
    match action.as_str() {
        "show" => {
            crate::toggle_main(&app);
            ok_result(&db)
        }
        "quick-add" => {
            if let Some(win) = app.get_webview_window("main") {
                crate::show_and_focus(&win);
            }
            let _ = app.emit("focus-quick-add", ());
            ok_result(&db)
        }
        "mode:minimal" | "mode:compact" | "mode:full" => {
            let mode = action.trim_start_matches("mode:").to_string();
            match crate::commands::system::apply_mode_inner(&app, &db, &mode) {
                Ok(()) => ok_result(&db),
                Err(e) => {
                    tracing::warn!("切换显示模式失败: {e}");
                    err_result(&db, format!("切换显示模式失败：{e}"))
                }
            }
        }
        "theme:light" | "theme:dark" | "theme:system" => {
            let theme = action.trim_start_matches("theme:").to_string();
            // 只有持久化成功才广播 theme-changed（主窗与弹窗才应用新主题）
            match db.set_setting("theme", serde_json::json!(theme)) {
                Ok(()) => {
                    let _ = app.emit("theme-changed", theme);
                    ok_result(&db)
                }
                Err(e) => {
                    tracing::warn!("切换主题失败（不广播 theme-changed）: {e}");
                    err_result(&db, format!("切换主题失败：{e}"))
                }
            }
        }
        "autostart" => {
            let current = db
                .get_setting("autostart")
                .ok()
                .flatten()
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            match crate::commands::system::set_autostart_inner(&app, &db, !current) {
                Ok(_) => ok_result(&db),
                Err(e) => {
                    tracing::warn!("切换开机自启动失败: {e}");
                    err_result(&db, format!("切换开机自启动失败：{e}"))
                }
            }
        }
        "quit" => {
            crate::request_exit(&app);
            ok_result(&db)
        }
        other => {
            tracing::warn!("未知菜单动作: {other}");
            err_result(&db, format!("未知菜单动作：{other}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1080p 主屏工作区（任务栏占底部 48px）。
    fn wa_full_hd() -> WorkArea {
        WorkArea::new(0, 0, 1920, 1032)
    }

    #[test]
    fn places_above_anchor_horizontally_centered() {
        // 屏幕中部：菜单整体在锚点上方（底边 = 锚点 - gap）、水平居中
        let (x, y) = place_menu((960.0, 800.0), (252.0, 500.0), 1.0, wa_full_hd());
        assert_eq!(x, 960 - 126);
        assert_eq!(y, (800.0 - ANCHOR_GAP - 500.0) as i32);
        // 菜单完整落在工作区内
        assert!(y >= EDGE_MARGIN as i32);
        assert!(y + 500 <= 1032 - EDGE_MARGIN as i32);
    }

    #[test]
    fn flips_below_when_not_enough_space_above() {
        // 锚点靠近屏幕上缘：上方放不下 → 改到锚点下方
        let (_, y) = place_menu((960.0, 300.0), (252.0, 500.0), 1.0, wa_full_hd());
        assert_eq!(y, (300.0 + ANCHOR_GAP) as i32);
        // 下方放得下（菜单底边不越过工作区下缘）
        assert!(y + 500 <= 1032 - EDGE_MARGIN as i32);
    }

    #[test]
    fn clamps_to_work_area_when_nowhere_to_fit() {
        // 工作区比菜单矮：上下都放不下 → 收进工作区（贴顶边），不得出现负坐标
        let wa = WorkArea::new(0, 0, 800, 400);
        let (x, y) = place_menu((400.0, 200.0), (252.0, 500.0), 1.0, wa);
        assert_eq!(y, EDGE_MARGIN as i32);
        assert_eq!(x, 400 - 126);
    }

    #[test]
    fn clamps_horizontal_overflow_right() {
        // 锚点贴近右缘：居中会越出右缘 → 菜单右缘收进工作区
        let (x, _) = place_menu((1900.0, 500.0), (252.0, 500.0), 1.0, wa_full_hd());
        assert_eq!(x, 1920 - EDGE_MARGIN as i32 - 252);
    }

    #[test]
    fn clamps_horizontal_overflow_left() {
        // 锚点贴近左缘：居中会越出左缘 → 菜单左缘收进工作区
        let (x, _) = place_menu((60.0, 500.0), (252.0, 500.0), 1.0, wa_full_hd());
        assert_eq!(x, EDGE_MARGIN as i32);
    }

    #[test]
    fn converts_logical_size_by_monitor_scale() {
        // 150% 缩放：252×500 逻辑 → 378×750 物理
        let wa = WorkArea::new(0, 0, 2560, 1392);
        let (x, y) = place_menu((1280.0, 900.0), (252.0, 500.0), 1.5, wa);
        assert_eq!(x, 1280 - 189);
        assert_eq!(y, (900.0 - ANCHOR_GAP - 750.0) as i32);
    }

    #[test]
    fn honors_secondary_monitor_origin() {
        // 副屏（x 偏移 2560）：水平收进以**该屏**工作区为基准，而非主屏
        let wa = WorkArea::new(2560, 0, 1920, 1152);
        let (x, y) = place_menu((2560.0 + 960.0, 600.0), (252.0, 500.0), 1.0, wa);
        assert_eq!(x, 2560 + 960 - 126);
        assert_eq!(y, (600.0 - ANCHOR_GAP - 500.0) as i32);
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        let (x, y) = place_menu((960.0, 800.0), (252.0, 500.0), 0.0, wa_full_hd());
        assert_eq!(x, 960 - 126);
        assert_eq!(y, (800.0 - ANCHOR_GAP - 500.0) as i32);
    }
}
