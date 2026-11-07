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
//! - **材质**：默认不挂原生材质（`apply_menu_material` 只清理残留），
//!   桌面模糊会越过区域在圆角外留下暗楔；表面可读性由 CSS 高不透明度
//!   柔光层承担（见 styles-context-menu.css）。
//! - **圆角**：Win32 区域使用与主窗同一套「CSS 圆角像素支撑形状」
//!   （`window_shape::apply_with_radius`），DWM 角偏好固定 DONOTROUND；
//!   区域成功后不再有第二层系统弧/系统边框（2026-11-04 真机修复）。
//! - **动作**：`context_menu_action` 与原托盘 `on_menu_event` 一一对应，
//!   复用同一批 inner 函数（apply_mode_inner / set_autostart_inner /
//!   request_exit），不创建第二份状态源；失败返回错误、成功才广播事件
//!   并回传最新快照（不虚假显示成功）。
//! - **关闭**：Escape（弹窗内处理）、点击有效菜单项、失焦（弹窗 Focused(false)）、
//!   **前台切换钩子**（EVENT_SYSTEM_FOREGROUND：点击桌面/其他应用时即使弹窗
//!   从未获得焦点也能收到通知，事件驱动、无轮询）。所有路径都经
//!   BLUR_TOKEN 延迟合并：右键重开时 show 取消未决关闭，不闪烁。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::db::Db;

pub const WINDOW_LABEL: &str = "context-menu";
/// 后端 → 菜单窗口：即将在锚点处显示（刷新设置快照 + 重放入场动画 + 回传尺寸）。
pub const SHOW_EVENT: &str = "context-menu-show";
/// 后端 → 主窗：执行一条极简标签菜单动作，载荷 `{ id, action }`。
/// 主窗必须用 `tab_menu_action_result` 回传**真实事务结果**。
pub const TAB_ACTION_EVENT: &str = "edge-tab-action";

/// 等待主窗事务结果的上限。
///
/// 覆盖：引擎忙等（1s）+ Edge Tab 恢复过渡（300ms）+ 拖动终态收口（≤2s）+
/// 尺寸/区域回读与稳定性复核。超时即明确失败（菜单保留并提示），
/// 不把「仍在执行」提前当成成功。
const TAB_ACTION_TIMEOUT: Duration = Duration::from_secs(8);
/// 在途标签菜单动作计数：期间抑制失焦自动关闭，否则失败反馈会被藏进
/// 已隐藏的菜单窗口（用户视角就是「点了没反应」）。成功后仍由动作路径隐藏。
static TAB_ACTION_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
/// 菜单动作请求 id（单调，用于把主窗结果对回等待中的命令）。
static NEXT_TAB_ACTION_ID: AtomicU64 = AtomicU64::new(1);

/// show 事件载荷：`tray` = 托盘/悬浮栏完整菜单，`tab` = 极简标签三项快捷菜单。
/// 两个变体共用同一个窗口与同一套键盘/关闭路径，只在条目与定位上不同。
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ShowPayload {
    pub variant: &'static str,
}

/// 下发给主窗的动作请求：`id` 必须随结果原样带回。
#[derive(Clone, Debug, Serialize)]
struct TabActionRequest {
    id: u64,
    action: String,
}

/// 主窗回传的事务结果。
#[derive(Debug)]
struct TabActionOutcome {
    ok: bool,
    error: Option<String>,
}

/// 等待中的动作请求。oneshot 一对一：结果只能兑现一次，重复回执被忽略。
fn pending_tab_actions(
) -> &'static Mutex<HashMap<u64, tokio::sync::oneshot::Sender<TabActionOutcome>>> {
    static PENDING: OnceLock<
        Mutex<HashMap<u64, tokio::sync::oneshot::Sender<TabActionOutcome>>>,
    > = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn take_pending_tab_action(id: u64) -> Option<tokio::sync::oneshot::Sender<TabActionOutcome>> {
    pending_tab_actions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id)
}

/// 兑现一条等待中的动作结果；返回 false 表示 id 不存在/已兑现（重复回执）。
fn complete_tab_action(id: u64, ok: bool, error: Option<String>) -> bool {
    let Some(tx) = take_pending_tab_action(id) else {
        return false;
    };
    tx.send(TabActionOutcome {
        error: error.filter(|e| !e.trim().is_empty()),
        ok,
    })
    .is_ok()
}

/// 在途守卫：Drop 时递减，任何提前返回都不会漏减。
struct TabActionInflight;

impl TabActionInflight {
    fn new() -> Self {
        TAB_ACTION_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for TabActionInflight {
    fn drop(&mut self) {
        TAB_ACTION_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 转发一次标签菜单动作并等待主窗事务结果。
///
/// - 主窗不存在/emit 失败 → 立即失败，不假装成功；
/// - 主窗收到但不回执（入口缺失、事件丢失）→ 8s 超时后明确失败；
/// - 主窗回传 ok → 只有事务真正提交才可能得到该结果（主窗侧 `restoreTab` /
///   `formSwitch` / `undock` 都解析真实返回）。
async fn run_tab_action(app: &AppHandle, action: String) -> Result<(), String> {
    if app.get_webview_window("main").is_none() {
        return Err("主窗口未就绪，操作未执行".to_string());
    }
    let id = NEXT_TAB_ACTION_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending_tab_actions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, tx);
    let _inflight = TabActionInflight::new();
    if let Err(e) = app.emit_to(
        "main",
        TAB_ACTION_EVENT,
        TabActionRequest {
            id,
            action,
        },
    ) {
        take_pending_tab_action(id);
        tracing::warn!("转发极简标签菜单动作失败: {e}");
        return Err("主窗口未就绪，操作未执行".to_string());
    }
    match tokio::time::timeout(TAB_ACTION_TIMEOUT, rx).await {
        Ok(Ok(outcome)) if outcome.ok => Ok(()),
        Ok(Ok(outcome)) => Err(outcome
            .error
            .unwrap_or_else(|| "操作未完成，请重试".to_string())),
        Ok(Err(_)) => Err("主窗口未响应，操作结果未知".to_string()),
        Err(_) => {
            take_pending_tab_action(id);
            tracing::warn!("极简标签菜单动作等待主窗结果超时: id={id}");
            Err("操作超时，窗口可能未完成切换".to_string())
        }
    }
}

/// 菜单 CSS 圆角（逻辑像素），与 styles-context-menu.css 的 border-radius 一致；
/// Win32 区域按该逻辑半径 × DPI 生成逐行像素支撑形状（不再用 GDI 硬边椭圆）。
pub const MENU_RADIUS: f64 = 16.0;
/// 菜单边缘与屏幕锚点的间距（物理像素）。
pub const ANCHOR_GAP: f64 = 8.0;
/// 工作区安全边距（物理像素）。
pub const EDGE_MARGIN: f64 = 6.0;
/// 失焦延迟关闭毫秒数：覆盖「主窗口夺焦 → contextmenu 重开」的竞态窗口。
pub const BLUR_CLOSE_DELAY_MS: u64 = 160;

/// 弹窗默认逻辑尺寸（与 tauri.conf.json 的 width/height 保持一致）。
/// 宽度是设计常量（250px，规范建议 230–250）；高度取内容自然高度，
/// 再按锚点所在显示器工作区收放（见 `resolve_menu_height`），
/// 宽度不再回环（避免 测量→set_size→再测量 的舍入漂移）。
const DEFAULT_SIZE: (f64, f64) = (250.0, 620.0);

/// 菜单的定位目标（决定弹出方向与尺寸收敛所用的工作区）。
#[derive(Clone, Copy, Debug)]
enum Target {
    /// 托盘/悬浮栏：以屏幕锚点为中心、优先向上展开。
    Anchor(f64, f64),
    /// 极简标签：按停靠边朝屏幕内部展开，不覆盖标签本身。
    Tab {
        tab: crate::tab_popups::ScreenRect,
        edge: u8,
    },
}

impl Target {
    /// 用于选择显示器与工作区的代表点（标签取中心）。
    fn point(self) -> (f64, f64) {
        match self {
            Target::Anchor(x, y) => (x, y),
            Target::Tab { tab, .. } => (
                tab.x as f64 + tab.w as f64 / 2.0,
                tab.y as f64 + tab.h as f64 / 2.0,
            ),
        }
    }
}

/// 最近一次显示的目标（屏幕物理坐标）。
static TARGET: Mutex<Target> = Mutex::new(Target::Anchor(0.0, 0.0));
/// 菜单内容的**自然高度**（逻辑像素，由前端按 scrollHeight 实测回传）。
/// 与「实际写入窗口的高度」分开：小屏被工作区裁剪时自然高度保持不变，
/// 回到大屏后可直接恢复，不会被裁剪值反向污染。
static MENU_NATURAL_HEIGHT: Mutex<f64> = Mutex::new(DEFAULT_SIZE.1);
/// 实际写入窗口的逻辑高度（= min(自然高度, 锚点所在显示器工作区可用高度)）。
static MENU_WINDOW_HEIGHT: Mutex<f64> = Mutex::new(DEFAULT_SIZE.1);
/// 内容自然高度的合理上界：只防异常 IPC 值，不当作窗口裁剪上限。
const MAX_NATURAL_HEIGHT: f64 = 2000.0;
/// 窗口最小可用高度；工作区比它还小时以工作区为准，绝不为凑最小值而溢出。
const MIN_WINDOW_HEIGHT: f64 = 80.0;
/// 失焦延迟关闭令牌：show/fit/hide 都会 bump 使未决任务失效。
static BLUR_TOKEN: AtomicU64 = AtomicU64::new(0);
/// 弹窗材质方案是否已初始化（失败在下次显示时重试，不阻塞打开路径）。
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

/// 锚点所在工作区能容纳的最大窗口高度（逻辑像素）。
///
/// 物理可用高度 = 工作区高度 − 上下各 `EDGE_MARGIN`；再按该显示器缩放换算回逻辑像素。
/// 这样窗口无论在高 DPI 小屏还是普通屏打开，都不会超出**工作区**（不是物理分辨率）。
pub fn max_window_height(wa: WorkArea, scale: f64) -> f64 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let available_phys = (wa.h as f64 - 2.0 * EDGE_MARGIN).max(1.0);
    (available_phys / scale).max(1.0)
}

/// 菜单窗口实际应取的高度：内容自然高度优先（不足不拉伸），
/// 超出锚点所在工作区时收进工作区，超出的内容由菜单内部滚动承担。
pub fn resolve_menu_height(natural: f64, wa: WorkArea, scale: f64) -> f64 {
    let natural = if natural.is_finite() {
        natural.clamp(MIN_WINDOW_HEIGHT, MAX_NATURAL_HEIGHT)
    } else {
        DEFAULT_SIZE.1
    };
    natural.min(max_window_height(wa, scale))
}

/// 以当前自然高度 + 目标所在显示器工作区算出窗口尺寸；取不到显示器时只按自然高度。
fn desired_size(app: &AppHandle) -> (f64, f64) {
    let natural = *MENU_NATURAL_HEIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let point = current_target().point();
    let height = match monitor_at(app, point) {
        Some((wa, scale)) => resolve_menu_height(natural, wa, scale),
        None => natural.clamp(MIN_WINDOW_HEIGHT, MAX_NATURAL_HEIGHT),
    };
    (DEFAULT_SIZE.0, height)
}

fn current_target() -> Target {
    *TARGET.lock().unwrap_or_else(|e| e.into_inner())
}

/// <0.5 逻辑像素视为同一高度：吸收测量/DPI 舍入，避免 fit ↔ resize 回环。
fn height_needs_resize(cached: f64, target: f64) -> bool {
    (cached - target).abs() >= 0.5
}

/// 只在高度实际变化时改窗口尺寸（<0.5 逻辑像素视为相同）：避免 fit ↔ resize 回环。
/// 返回是否真的调用了 `set_size`。
fn apply_window_height(win: &tauri::WebviewWindow, height: f64) -> bool {
    let mut cached = MENU_WINDOW_HEIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if !height_needs_resize(*cached, height) {
        return false;
    }
    if win
        .set_size(tauri::LogicalSize::new(DEFAULT_SIZE.0, height))
        .is_err()
    {
        return false;
    }
    *cached = height;
    true
}

/// DPI / 显示器变化后重算**可见**菜单的高度与位置（自然高度不变，只按新工作区收放）。
/// 只由 `ScaleFactorChanged` 调用；`Resized` 不调用，避免 set_size 自触发回环。
fn refit_visible(app: &AppHandle) {
    let Some(win) = menu_window(app) else { return };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    let target = current_target();
    let size = desired_size(app);
    apply_window_height(&win, size.1);
    if let Some(pos) = compute_position(app, target, size) {
        let _ = win.set_position(pos);
    }
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
    // 默认路径 effect=none 表示「按设计不挂原生材质」，视为已初始化；
    // 显式后端的清理/应用失败则留待下次显示重试，不伪装成功。
    if result.effect == "none" || result.applied {
        MATERIAL_APPLIED.store(true, Ordering::Relaxed);
    } else {
        tracing::debug!(effect = %result.effect, "右键菜单原生材质未生效，下次显示重试");
    }
    tracing::debug!(
        effect = %result.effect,
        applied = result.applied,
        "右键菜单原生材质"
    );
}

fn menu_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
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
        // 标签菜单动作正在主窗执行：此刻关闭会把失败反馈藏进不可见窗口。
        // 成功后由动作路径 hide；失败保持菜单可见，让用户读到原因。
        if TAB_ACTION_IN_FLIGHT.load(Ordering::SeqCst) > 0 {
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
    target: Target,
    size: (f64, f64),
) -> Option<PhysicalPosition<i32>> {
    let (wa, scale) = monitor_at(app, target.point())?;
    let (x, y) = match target {
        // 托盘/悬浮栏：锚点居中、优先向上（既有行为）
        Target::Anchor(ax, ay) => place_menu((ax, ay), size, scale, wa),
        // 极简标签：朝屏幕内部展开，永不覆盖贴边标签
        Target::Tab { tab, edge } => crate::tab_popups::place_beside(edge, tab, size, scale, wa),
    };
    Some(PhysicalPosition::new(x, y))
}

/// 在锚点处显示菜单（托盘右键与悬浮栏右键共用）。
pub fn show_at(app: &AppHandle, anchor: (f64, f64)) {
    show_target(app, Target::Anchor(anchor.0, anchor.1), "tray");
}

/// 在极简标签旁显示三项快捷菜单（同一窗口、同一套动作执行与关闭路径）。
pub fn show_at_tab(app: &AppHandle, tab: crate::tab_popups::ScreenRect, edge: u8) {
    show_target(app, Target::Tab { tab, edge }, "tab");
}

fn show_target(app: &AppHandle, target: Target, variant: &'static str) {
    let Some(win) = menu_window(app) else {
        tracing::warn!("context-menu 窗口不存在（未在 tauri.conf.json 声明？）");
        return;
    };
    tracing::info!(target = ?target, variant, "右键菜单：请求显示");
    *TARGET.lock().unwrap_or_else(|e| e.into_inner()) = target;
    // 右键重开：取消未决失焦关闭，避免「关闭-显示」竞态闪烁
    cancel_pending_blur_close();
    apply_material(app);
    // 显示前先按**目标所在显示器工作区**收放高度：小屏/高 DPI 下即使用户还没
    // 回传实测高度，也不会先显示一个超出工作区的窗口。
    let size = desired_size(app);
    apply_window_height(&win, size.1);
    if let Some(pos) = compute_position(app, target, size) {
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
    let _ = app.emit_to(WINDOW_LABEL, SHOW_EVENT, ShowPayload { variant });
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
            tauri::WindowEvent::Resized(_) => {
                crate::window_shape::apply_with_radius(&w, MENU_RADIUS);
            }
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                // DPI / 显示器变化：圆角按新 scale 重算，窗口高度与位置也按新工作区重算
                // （这里不调 fit_context_menu，避免与前端测量形成 resize 回环）。
                crate::window_shape::apply_with_radius(&w, MENU_RADIUS);
                refit_visible(w.app_handle());
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

#[tauri::command]
pub fn hide_context_menu(app: AppHandle) {
    hide(&app);
}

/// 菜单内容把实测**自然高度**回传给后端：实际窗口高度 =
/// min(自然高度, 锚点所在显示器工作区可用高度)，超出部分由菜单内部滚动承担。
/// 宽度是设计常量（DEFAULT_SIZE.0），不由前端回传，避免测量回环漂移。
/// 高度未变化时不做任何事（重复 show / 小屏钳制都不会反复 resize）。
#[tauri::command]
pub fn fit_context_menu(app: AppHandle, height: f64) {
    if !height.is_finite() {
        return;
    }
    // 自然高度只做合理性夹取，不再当作窗口裁剪上限：小屏回到大屏后可直接恢复。
    let natural = height.clamp(MIN_WINDOW_HEIGHT, MAX_NATURAL_HEIGHT);
    *MENU_NATURAL_HEIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = natural;

    let Some(win) = menu_window(&app) else { return };
    let target = current_target();
    let size = desired_size(&app);
    if !apply_window_height(&win, size.1) {
        // 自然高度变了但窗口高度未变（被工作区钳制）：不 resize、不重定位。
        return;
    }
    if win.is_visible().unwrap_or(false) {
        if let Some(pos) = compute_position(&app, target, size) {
            let _ = win.set_position(pos);
        }
    }
}

/// 动作执行结果（v0.6 整改）：成功回传**最新设置快照**（菜单据此渲染勾选态，
/// 不做乐观更新）并隐藏菜单；失败返回可读原因并保留菜单展示行内反馈 ——
/// 主题/自启动失败时不会广播成功状态，也不会显示虚假成功。
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
    /// 边缘吸附展示形态：capsule | full
    pub snap_display_mode: String,
}

fn read_snapshot(db: &Db) -> Option<MenuSnapshot> {
    crate::db::Settings::load(db).ok().map(|s| MenuSnapshot {
        mode: s.mode,
        theme: s.theme,
        autostart: s.autostart,
        visual_preset: s.visual_preset,
        snap_display_mode: s.snap_display_mode,
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
/// **成功才隐藏菜单**：失败保留菜单展示行内反馈（前端 role=alert）——
/// 若先隐藏，反馈就渲染在不可见窗口里，用户视角是「按了没反应」的静默失败。
#[tauri::command]
pub async fn context_menu_action(app: AppHandle, action: String) -> MenuActionResult {
    // async command 的 future 必须是 'static：`State<'_, T>` 是借用参数，
    // 不能出现在签名里。这里从 AppHandle 取一次并立即克隆 Arc，守卫在
    // 任何 await 之前释放。
    let db = std::sync::Arc::clone(app.state::<std::sync::Arc<Db>>().inner());
    let result = match action.as_str() {
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
        // 托盘右键入口：热键被占用/不可用时仍能打开快速捕获窗口（不创建新窗口实例）。
        "quick-capture" => {
            crate::quick_capture::toggle(&app);
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
        // 边缘吸附方式：只持久化偏好并广播；主窗口引擎负责原地切换（浮动窗口不移动）。
        "snap-form:capsule" | "snap-form:full" => {
            let form = action.trim_start_matches("snap-form:").to_string();
            match crate::commands::settings::validate_setting(
                "snap_display_mode",
                &serde_json::json!(form),
            ) {
                Ok(()) => match db.set_setting("snap_display_mode", serde_json::json!(form)) {
                    Ok(()) => {
                        let _ = app.emit("snap-form-changed", form);
                        ok_result(&db)
                    }
                    Err(e) => {
                        tracing::warn!("切换边缘吸附方式失败: {e}");
                        err_result(&db, format!("切换边缘吸附方式失败：{e}"))
                    }
                },
                Err(e) => err_result(&db, e.to_string()),
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
        // 极简标签三项：菜单只转发命令，吸附状态机与窗口几何全部留在主窗引擎
        // （`useEdgeSnap` 拥有唯一的恢复/展开/解除事务），这里不复制第二套业务逻辑。
        // **等待主窗事务的真实结果**：emit 成功只代表请求已送达，不代表窗口已切换。
        "tab:expand" | "tab:full" | "tab:undock" => {
            let forwarded = action.trim_start_matches("tab:").to_string();
            match run_tab_action(&app, forwarded).await {
                Ok(()) => ok_result(&db),
                Err(message) => {
                    tracing::warn!(%message, "极简标签菜单动作未完成");
                    err_result(&db, message)
                }
            }
        }
        other => {
            tracing::warn!("未知菜单动作: {other}");
            err_result(&db, format!("未知菜单动作：{other}"))
        }
    };
    // 失败路径必须保持菜单可见（行内反馈），成功才收起
    if result.ok {
        hide(&app);
    }
    result
}

/// 主窗回传标签菜单动作的**真实事务结果**（与 `TAB_ACTION_EVENT` 的 id 对应）。
///
/// 只兑现一次：重复/迟到回执返回 false 被忽略；等待方已超时也不影响。
/// 不在这里隐藏菜单——结果会返回给 `context_menu_action`，由它统一决定
/// 成功收起 / 失败保留并显示行内原因。
#[tauri::command]
pub fn tab_menu_action_result(id: u64, ok: bool, error: Option<String>) -> bool {
    complete_tab_action(id, ok, error)
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

    // ── 工作区高度约束（P2-02） ─────────────────────────────────

    fn wa_height(h: i32) -> WorkArea {
        WorkArea::new(0, 0, 1920, h)
    }

    #[test]
    fn natural_height_is_not_stretched_on_large_screens() {
        // 1920×1080（工作区 1032）：自然高度原样使用，不用工作区高度拉伸
        assert_eq!(resolve_menu_height(622.0, wa_height(1032), 1.0), 622.0);
        assert_eq!(resolve_menu_height(622.0, wa_height(1032), 1.25), 622.0);
    }

    #[test]
    fn clamps_on_1366x768_work_area_at_all_dpi() {
        // 1366×768：工作区 728 物理像素（100% 可容纳 716 逻辑 → 不裁剪）
        assert_eq!(resolve_menu_height(622.0, wa_height(728), 1.0), 622.0);
        // 125%：可用 (728-12)/1.25 = 572.8
        let at125 = resolve_menu_height(622.0, wa_height(728), 1.25);
        assert!((at125 - 572.8).abs() < 0.01, "125% actual={at125}");
        // 150%：477.33；200%：358
        let at150 = resolve_menu_height(622.0, wa_height(728), 1.5);
        assert!((at150 - (716.0 / 1.5)).abs() < 0.01, "150% actual={at150}");
        assert_eq!(resolve_menu_height(622.0, wa_height(728), 2.0), 358.0);
    }

    #[test]
    fn clamps_on_1280x720_work_area() {
        // 1280×720：工作区 680 → 100% 可容纳 668（622 不裁剪）
        assert_eq!(resolve_menu_height(622.0, wa_height(680), 1.0), 622.0);
        let at125 = resolve_menu_height(622.0, wa_height(680), 1.25);
        assert!((at125 - 534.4).abs() < 0.01, "125% actual={at125}");
        assert_eq!(resolve_menu_height(622.0, wa_height(680), 2.0), 334.0);
    }

    #[test]
    fn restores_natural_height_when_work_area_grows() {
        let small = resolve_menu_height(742.0, wa_height(728), 1.5);
        assert!(small < 742.0, "高 DPI 小屏必须收进工作区");
        let large = resolve_menu_height(742.0, wa_height(1032), 1.0);
        assert_eq!(large, 742.0, "回到大屏必须恢复自然高度，不被裁剪值污染");
    }

    #[test]
    fn tall_menu_at_bottom_corner_stays_inside_work_area() {
        let wa = wa_height(728);
        let h = resolve_menu_height(900.0, wa, 1.25);
        let (x, y) = place_menu((1900.0, 726.0), (DEFAULT_SIZE.0, h), 1.25, wa);
        let mw = (DEFAULT_SIZE.0 * 1.25).round() as i32;
        let mh = (h * 1.25).round() as i32;
        assert!(y >= EDGE_MARGIN as i32);
        assert!(y + mh <= 728 - EDGE_MARGIN as i32, "y={y} mh={mh}");
        assert!(x >= EDGE_MARGIN as i32);
        assert!(x + mw <= 1920 - EDGE_MARGIN as i32, "x={x} mw={mw}");
    }

    #[test]
    fn tiny_work_area_never_overflows() {
        // 极端小工作区：窗口取可用高度，不为了 MIN_WINDOW_HEIGHT 溢出工作区
        assert_eq!(resolve_menu_height(622.0, wa_height(100), 1.0), 88.0);
        assert_eq!(resolve_menu_height(622.0, wa_height(40), 1.0), 28.0);
    }

    #[test]
    fn fractional_dpi_rounds_into_work_area_exactly() {
        // 125%：572.8 逻辑 = 716 物理，恰好贴工作区下缘；不能因取整多出 1px
        let h = resolve_menu_height(622.0, wa_height(728), 1.25);
        assert_eq!((h * 1.25).round() as i32, 716);
        let (_, y) = place_menu((960.0, 720.0), (DEFAULT_SIZE.0, h), 1.25, wa_height(728));
        assert!(y + 716 <= 728 - EDGE_MARGIN as i32);
    }

    #[test]
    fn height_threshold_absorbs_subpixel_rounding() {
        // 0.4px 差异不 resize（防 fit↔resize 回环）；0.5px 起才更新
        assert!(!height_needs_resize(622.0, 622.4));
        assert!(!height_needs_resize(622.0, 621.6));
        assert!(height_needs_resize(622.0, 622.5));
        assert!(height_needs_resize(622.0, 621.5));
    }

    #[test]
    fn invalid_values_fall_back() {
        assert_eq!(
            resolve_menu_height(f64::NAN, wa_height(1032), 1.0),
            DEFAULT_SIZE.1
        );
        assert_eq!(max_window_height(wa_height(1032), 0.0), 1020.0);
        assert_eq!(
            resolve_menu_height(0.0, wa_height(1032), 1.0),
            MIN_WINDOW_HEIGHT
        );
    }

    // ── 标签菜单动作结果回执（P2-2）──────────────────────────────

    #[test]
    fn tab_action_result_is_correlated_and_consumed_once() {
        // 主窗回执必须精确对回请求 id，且只能兑现一次：重复/迟到回执不得
        // 再唤醒等待方（否则同一动作可能被当成两次执行结果）。
        let id = 9_876_543_210;
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        pending_tab_actions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);

        assert!(complete_tab_action(id, true, None));
        match rx.try_recv() {
            Ok(TabActionOutcome { ok, error }) => {
                assert!(ok);
                assert!(error.is_none());
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        assert!(
            !complete_tab_action(id, false, Some("late".to_string())),
            "重复回执必须被忽略"
        );
    }

    #[test]
    fn tab_action_result_for_unknown_id_is_ignored() {
        assert!(!complete_tab_action(1_234_567_891, false, None));
    }
}
