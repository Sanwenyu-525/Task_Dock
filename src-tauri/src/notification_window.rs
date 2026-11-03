//! 自定义桌面通知窗口（v0.7）：独立透明 WebView，承载六状态液态玻璃通知卡片。
//!
//! 复用 context-menu 弹窗架构（tauri.conf.json 声明、启动即创建并隐藏、
//! 常驻复用，不按通知反复创建/销毁 WebView）：
//!
//! - **展示链路**：AgentHub::deliver_popups → `show_cards` → emit
//!   `notification-show`（结构化卡片载荷）→ 窗口渲染 → fit 回传收放高度；
//!   窗口不存在或发送失败时返回 false，由调用方兜底 OS toast（两路互斥）。
//! - **不抢焦点**：conf `focus:false` 之外，show 前显式置 WS_EX_NOACTIVATE
//!   （仅凭 focus:false 不能保证 Windows 不激活窗口）；鼠标交互照常送达。
//! - **定位**：光标所在显示器工作区右下角（work_area 已排除任务栏），
//!   逻辑尺寸 × 显示器缩放换算物理像素；取不到光标/显示器时退回主显示器。
//! - **稍后提醒**：等待卡「稍后提醒」把卡片暂存 SNOOZED（内存、上限 20），
//!   调度器每秒 `poll_snoozed` 把到期卡片重新送展示窗口（用户主动请求，
//!   不经 NotifyGate 额度；应用重启即丢弃，可接受）。
//! - **导航**：用户点击「查看详情/立即处理/通知中心」才允许激活主窗口并
//!   跳转对应标签页（notification-navigate 事件，主窗 App 订阅）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State};

use crate::agents::notify::Popup;
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const WINDOW_LABEL: &str = "notification";
/// 后端 → 通知窗口：追加一批允许展示的卡片。
pub const SHOW_EVENT: &str = "notification-show";
/// 通知窗口 → 主窗口：用户明确点击跳转后才激活主窗并切标签页。
pub const NAVIGATE_EVENT: &str = "notification-navigate";

/// 窗口宽度（逻辑像素）：360px 卡片 + 左右阴影余量。
pub const WINDOW_WIDTH: f64 = 400.0;
/// 窗口与工作区右/下边缘的间距（逻辑像素）。
pub const EDGE_MARGIN: f64 = 16.0;
/// fit 高度钳制（逻辑像素）：下限保证可见，上限约 5 张卡 + 余量。
pub const MIN_HEIGHT: f64 = 80.0;
pub const MAX_HEIGHT: f64 = 860.0;

/// 窗口当前逻辑高度（fit_notification_window 回传后缓存；宽度按显示器可用空间钳制）。
static STACK_HEIGHT: Mutex<f64> = Mutex::new(160.0);
/// 通知窗口前端是否已完成 `notification-show` 订阅（就绪前不显示窗口，走 OS toast 兜底）。
static UI_READY: AtomicBool = AtomicBool::new(false);
/// 本轮通知的目标显示器锚点：首次展示时确定，存续期间复用；隐藏/新一轮时才重新选择。
static ANCHOR: Mutex<Option<Anchor>> = Mutex::new(None);
/// 最近一次实际下发的窗口尺寸/位置：避免每次高度回传都重复 set_size/set_position。
static LAST_SET_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static LAST_SET_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);
/// 隐藏态首帧显示状态：内容已发送但窗口还没 show，等待前端首次测量（纯状态机，可单测）。
static SHOW_STATE: Mutex<PendingShowState> = Mutex::new(PendingShowState {
    pending: false,
    generation: 0,
});
/// 首帧兜底上限：前端异常未回传高度时，按当前缓存高度显示，保证通知不丢。
const SHOW_WATCHDOG_DELAY: Duration = Duration::from_millis(600);
/// 稍后提醒暂存：到期的卡片由调度器 tick 重新送展示（上限内保序）。
static SNOOZED: Mutex<Vec<(Popup, Instant)>> = Mutex::new(Vec::new());

// ── 载荷 ─────────────────────────────────────────────────────

/// 发给通知窗口的单张卡片。camelCase 与前端 notificationTypes.ts 对应；
/// 结构化字段只供窗口模板使用，OS toast 兜底仅取 title/body。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotificationCardPayload {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "sourceId", skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "refId", skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
    /// 事件原因/错误摘要（失败/等待卡展开详情用；OS toast 不使用）。
    #[serde(rename = "detail", skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl From<Popup> for NotificationCardPayload {
    fn from(p: Popup) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: p.kind,
            title: p.title,
            body: p.body,
            created_at: p.created_at,
            source_id: p.source_id,
            session_id: p.session_id,
            ref_id: p.ref_id,
            detail: p.detail,
        }
    }
}

impl From<NotificationCardPayload> for Popup {
    /// 稍后提醒回传的载荷还原为 Popup 重新送展示（id 由展示路径重新生成）。
    fn from(c: NotificationCardPayload) -> Self {
        Self {
            kind: c.kind,
            title: c.title,
            body: c.body,
            ref_id: c.ref_id,
            source_id: c.source_id,
            session_id: c.session_id,
            detail: c.detail,
            created_at: c.created_at,
        }
    }
}

// ── 定位（纯函数，可单测）────────────────────────────────────

/// 工作区（物理像素，绝对屏幕坐标），与 context_menu.rs 同构。
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

/// 显示器锚点身份：名称优先，几何用于名称缺失/重命名时兜底。
/// 锚点只在「新一轮通知首次展示」时选择，高度变化期间不重新按光标选屏。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// 显示器快照（纯数据，便于单测锚点解析）。
#[derive(Clone, Debug, PartialEq)]
pub struct MonitorInfo {
    pub anchor: Anchor,
    pub work_area: WorkArea,
    pub scale: f64,
}

/// 逻辑尺寸按工作区可用空间钳制：小屏/小工作区时窗口本体不超出可视区，
/// 内容由前端在窗口内部滚动承载（不以“坐标非负”作为可访问性通过依据）。
pub fn fit_logical_size(wa: WorkArea, size_logical: (f64, f64), scale: f64) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let max_w = ((wa.w as f64 / scale) - 2.0 * EDGE_MARGIN).max(1.0);
    let max_h = ((wa.h as f64 / scale) - 2.0 * EDGE_MARGIN).max(1.0);
    (size_logical.0.min(max_w).max(1.0), size_logical.1.min(max_h).max(1.0))
}

/// 计算通知窗口的物理位置：目标显示器工作区右下角。
/// 尺寸先按工作区钳制，空间不足时收进工作区；DPI 按显示器缩放换算。
pub fn place_stack(wa: WorkArea, size_logical: (f64, f64), scale: f64) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let (w, h) = fit_logical_size(wa, size_logical, scale);
    let mw = (w * scale).round();
    let mh = (h * scale).round();
    let margin = (EDGE_MARGIN * scale).round();
    let min_x = wa.x as f64 + margin;
    let min_y = wa.y as f64 + margin;
    let max_x = (wa.x as f64 + wa.w as f64 - margin - mw).max(min_x);
    let max_y = (wa.y as f64 + wa.h as f64 - margin - mh).max(min_y);
    (max_x.round() as i32, max_y.round() as i32)
}

/// 在显示器列表中找回锚点对应的显示器；名称优先，几何兜底。
pub fn find_anchor_monitor(monitors: &[MonitorInfo], anchor: &Anchor) -> Option<usize> {
    // 有名称时只按名称识别：显示器顺序/坐标变化仍能认回原屏；
    // 名称已不存在即视为该显示器断开，交给调用方重新选屏，
    // 不能因为几何巧合吸附到另一块显示器。
    if let Some(name) = anchor.name.as_ref() {
        return monitors
            .iter()
            .position(|m| m.anchor.name.as_ref() == Some(name));
    }
    // 平台不提供显示器名称时才退回几何匹配。
    monitors.iter().position(|m| {
        m.anchor.x == anchor.x
            && m.anchor.y == anchor.y
            && m.anchor.w == anchor.w
            && m.anchor.h == anchor.h
    })
}

/// 按光标点选择显示器；不命中时退回第一个（Tauri 通常主显示器在前）。
pub fn monitor_for_point(monitors: &[MonitorInfo], point: (f64, f64)) -> Option<usize> {
    if monitors.is_empty() {
        return None;
    }
    monitors
        .iter()
        .position(|m| {
            point.0 >= m.anchor.x as f64
                && point.0 < (m.anchor.x as i64 + m.anchor.w as i64) as f64
                && point.1 >= m.anchor.y as f64
                && point.1 < (m.anchor.y as i64 + m.anchor.h as i64) as f64
        })
        .or(Some(0))
}

fn monitor_infos(app: &AppHandle) -> Vec<MonitorInfo> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            let rect = m.work_area();
            MonitorInfo {
                anchor: Anchor {
                    name: m.name().cloned(),
                    x: p.x,
                    y: p.y,
                    w: s.width,
                    h: s.height,
                },
                work_area: WorkArea::new(
                    rect.position.x,
                    rect.position.y,
                    rect.size.width as i32,
                    rect.size.height as i32,
                ),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// 解析本轮锚点：
/// - force_new=false 且旧锚点仍存在 → 复用（仅刷新工作区/DPI 快照，不按光标重选屏）；
/// - 旧显示器断开 → 重新按光标/主显示器选择并更新锚点；
/// - force_new=true（新一轮首次展示）→ 重新选择。
fn resolve_anchor(app: &AppHandle, force_new: bool) -> Option<MonitorInfo> {
    let monitors = monitor_infos(app);
    if monitors.is_empty() {
        return None;
    }
    let mut guard = ANCHOR.lock().unwrap_or_else(|e| e.into_inner());
    if !force_new {
        if let Some(anchor) = guard.as_ref() {
            if let Some(index) = find_anchor_monitor(&monitors, anchor) {
                let info = monitors[index].clone();
                *guard = Some(info.anchor.clone());
                return Some(info);
            }
            tracing::info!("通知锚点显示器已断开，重新选择显示器");
        }
    }
    let point = app
        .cursor_position()
        .map(|p| (p.x, p.y))
        .unwrap_or((0.0, 0.0));
    let index = monitor_for_point(&monitors, point)?;
    let info = monitors[index].clone();
    *guard = Some(info.anchor.clone());
    Some(info)
}

fn set_size_if_changed(win: &tauri::WebviewWindow, size: (f64, f64)) {
    let mut last_size = LAST_SET_SIZE.lock().unwrap_or_else(|e| e.into_inner());
    let changed = last_size
        .map(|(w, h)| (w - size.0).abs() > 0.5 || (h - size.1).abs() > 0.5)
        .unwrap_or(true);
    if !changed {
        return;
    }
    if let Err(e) = win.set_size(LogicalSize::new(size.0, size.1)) {
        tracing::warn!("通知窗口尺寸设置失败: {e}");
    } else {
        *last_size = Some(size);
    }
}

fn set_pos_if_changed(win: &tauri::WebviewWindow, x: i32, y: i32) {
    let mut last_pos = LAST_SET_POS.lock().unwrap_or_else(|e| e.into_inner());
    let changed = last_pos.map(|(px, py)| px != x || py != y).unwrap_or(true);
    if !changed {
        return;
    }
    if let Err(e) = win.set_position(PhysicalPosition::new(x, y)) {
        tracing::warn!("通知窗口位置设置失败: {e}");
    } else {
        *last_pos = Some((x, y));
    }
}

/// 一步提交「位置 + 尺寸」。
///
/// `set_position` 与 `set_size` 是两次独立的窗口消息：窗口可见时中间态会露出
/// （底边先上移、高度还是旧的，画面悬空 1~3 帧），跨显示器时还可能出现残影。
/// 两者同时变化时改用一次 `SetWindowPos` 原子提交，避免可感知的位置跳动。
#[cfg(windows)]
fn set_rect_atomic(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    size: (f64, f64),
    scale: f64,
) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    let Ok(hwnd) = win.hwnd() else {
        return false;
    };
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let w = (size.0 * scale).round() as i32;
    let h = (size.1 * scale).round() as i32;
    let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    let ok = unsafe { SetWindowPos(hwnd.0, Default::default(), x, y, w, h, flags) };
    ok != 0
}

#[cfg(not(windows))]
fn set_rect_atomic(
    _win: &tauri::WebviewWindow,
    _x: i32,
    _y: i32,
    _size: (f64, f64),
    _scale: f64,
) -> bool {
    false
}

fn apply_geometry(win: &tauri::WebviewWindow, info: &MonitorInfo) {
    let requested = (WINDOW_WIDTH, cached_height());
    let size = fit_logical_size(info.work_area, requested, info.scale);
    let (x, y) = place_stack(info.work_area, requested, info.scale);

    let prev_size = *LAST_SET_SIZE.lock().unwrap_or_else(|e| e.into_inner());
    let prev_pos = *LAST_SET_POS.lock().unwrap_or_else(|e| e.into_inner());
    let size_changed = prev_size
        .map(|(w, h)| (w - size.0).abs() > 0.5 || (h - size.1).abs() > 0.5)
        .unwrap_or(true);
    let pos_changed = prev_pos.map(|(px, py)| px != x || py != y).unwrap_or(true);
    if !size_changed && !pos_changed {
        return;
    }

    // 位置与尺寸同时变化：一次 SetWindowPos 原子提交，避免两步之间的可见中间态。
    if size_changed && pos_changed && set_rect_atomic(win, x, y, size, info.scale) {
        *LAST_SET_SIZE.lock().unwrap_or_else(|e| e.into_inner()) = Some(size);
        *LAST_SET_POS.lock().unwrap_or_else(|e| e.into_inner()) = Some((x, y));
        return;
    }

    // 右下角锚点：增高时先把窗口上移到最终顶边，再向下增高，避免内容先越出工作区；
    // 缩小时先收高度再下移，避免旧高度短暂压进任务栏。首次展示窗口隐藏，顺序无影响。
    let growing = prev_size.map(|(_, h)| size.1 > h + 0.5).unwrap_or(false);
    if growing {
        set_pos_if_changed(win, x, y);
        set_size_if_changed(win, size);
    } else {
        set_size_if_changed(win, size);
        set_pos_if_changed(win, x, y);
    }
}

fn reset_round_geometry() {
    *ANCHOR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *LAST_SET_SIZE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *LAST_SET_POS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn cached_height() -> f64 {
    *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner())
}

// ── 首帧显示状态（纯状态机，可单测）──────────────────────────

/// 隐藏态「等待前端首帧测量后再显示」的待显示状态。
///
/// 背景：窗口以 160 逻辑像素高度隐藏着，`show_cards` 若立刻 show，首批渲染会在
/// 160px 视口下先显示一帧（卡片底部被裁），约 46ms 后 fit 才把窗口增高。
/// 因此隐藏态改为：只设初始几何 + emit 内容，把 show 推迟到首次 fit（或兜底 watchdog）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PendingShowState {
    /// 是否存在「窗口隐藏、等待首次测量」的待显示轮次。
    pub pending: bool,
    /// 轮次号：隐藏态展示置位、hide/销毁时递增；用于丢弃上一轮的迟到回调。
    pub generation: u64,
}

/// 判定一次几何回传（fit）或 watchdog 到期是否应触发 show：
/// - 窗口已可见：不再 show（避免重复 show / 重复抢焦点）；
/// - 无 pending：本轮已显示或已 hide，迟到回传丢弃；
/// - 轮次不匹配：属于上一轮的迟到回调，丢弃且不得清掉当前轮标记。
pub fn decide_show_after_fit(
    pending: bool,
    generation: u64,
    fit_generation: u64,
    visible: bool,
) -> bool {
    !visible && pending && generation == fit_generation
}

impl PendingShowState {
    /// 隐藏态展示前登记。本轮已有 pending 时返回 None：复用已有标记与 watchdog，
    /// 不重复起定时器；首次登记递增轮次号并返回给调用方启动一次性 watchdog。
    fn arm(&mut self) -> Option<u64> {
        if self.pending {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        self.pending = true;
        Some(self.generation)
    }

    /// 隐藏/销毁/发送失败：清标记并推进轮次号，让迟到的 fit/watchdog 全部失效。
    fn cancel(&mut self) {
        self.pending = false;
        self.generation = self.generation.wrapping_add(1);
    }

    /// 消费待显示标记：只有决定显示（或窗口已可见）才清除，避免重复 show。
    fn take(&mut self, caller_generation: u64, visible: bool) -> bool {
        let show = decide_show_after_fit(self.pending, self.generation, caller_generation, visible);
        if self.pending && (show || visible) {
            self.pending = false;
        }
        show
    }
}

fn show_state() -> std::sync::MutexGuard<'static, PendingShowState> {
    SHOW_STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 登记待显示轮次；Some(generation) 表示调用方应启动一次性 watchdog。
fn arm_pending_show() -> Option<u64> {
    show_state().arm()
}

/// 当前轮次号（fit 命令不带轮次号，正常路径下即「归属当前轮」）。
fn current_show_generation() -> u64 {
    show_state().generation
}

/// 消费待显示标记（fit 与 watchdog 共用）。
fn take_pending_show(caller_generation: u64, visible: bool) -> bool {
    show_state().take(caller_generation, visible)
}

/// 撤销待显示（hide / 窗口销毁 / 事件发送失败）。
fn cancel_pending_show() {
    show_state().cancel();
}

/// 通知窗口前端完成订阅后由前端调用；未就绪时不显示窗口，交由 OS 通知兜底，
/// 避免“窗口已显示但没人消费事件”以及随后重复弹 OS toast。
#[tauri::command]
pub fn notification_ui_ready() {
    UI_READY.store(true, Ordering::SeqCst);
}

// ── 展示 ─────────────────────────────────────────────────────

/// 把一批已放行的弹窗送入自定义通知窗口。
/// 返回 false 表示窗口路径不可用（窗口不存在/事件发送失败），
/// 调用方据此兜底 OS toast；绝不部分成功。
pub fn show_cards(app: &AppHandle, popups: &[Popup]) -> bool {
    if popups.is_empty() {
        return true;
    }
    if !UI_READY.load(Ordering::SeqCst) {
        tracing::info!("通知窗口前端尚未就绪，OS 通知兜底（不显示空窗口）");
        return false;
    }
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        tracing::debug!("notification 窗口不存在，OS 通知兜底");
        return false;
    };
    let payload: Vec<NotificationCardPayload> = popups
        .iter()
        .cloned()
        .map(NotificationCardPayload::from)
        .collect();
    let was_visible = win.is_visible().unwrap_or(false);
    if !was_visible {
        // 新一轮通知：允许重新选屏，并丢弃上一轮的高度/位置缓存。
        reset_round_geometry();
        *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()) = 160.0;
    }
    ensure_noactivate(&win);
    if let Some(info) = resolve_anchor(app, !was_visible) {
        apply_geometry(&win, &info);
    }
    // 隐藏态先登记「待首帧测量」再发内容：emit 失败必须撤销，否则 watchdog 会显示空窗口。
    let armed = if was_visible {
        None
    } else {
        arm_pending_show()
    };
    // 内容事件在窗口显示前发送：窗口隐藏时前端栈为空，透明窗口不存在旧内容闪现。
    if let Err(e) = app.emit_to(WINDOW_LABEL, SHOW_EVENT, payload) {
        tracing::warn!("通知窗口事件发送失败，OS 通知兜底: {e}");
        if armed.is_some() {
            cancel_pending_show();
        }
        return false;
    }
    if was_visible {
        // 已可见：内容追加即可，重复 show 只会重复置顶/激活，不做无意义调用。
        return true;
    }
    // 隐藏态：不在 160 逻辑像素视口下抢先显示——等前端首帧测量回传（fit）应用最终
    // 几何后再 show，避免卡片底部先被裁掉一帧；前端异常未回传时由一次性 watchdog 兜底。
    if let Some(generation) = armed {
        spawn_show_watchdog(app, generation);
    }
    true
}

/// 不抢焦点：确保顶层窗口带 WS_EX_NOACTIVATE。
///
/// 主路径是 init 时 `set_focusable(false)`，把「不可聚焦」交给 tao 窗口状态机——
/// 它在 show/hide/set_size 重算样式时按 FOCUSABLE 标志保留该位；手写 EXSTYLE 会被
/// 状态机下一次 apply_diff 整段覆盖。这里只做显示后的兜底校验：位被清掉时补一次并
/// 读回确认，仍失败只记录警告，不阻塞通知展示、不重复重试。
#[cfg(windows)]
fn ensure_noactivate(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
        if ex & (WS_EX_NOACTIVATE as isize) != 0 {
            return;
        }
        SetWindowLongPtrW(hwnd.0, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE as isize);
        let after = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
        if after & (WS_EX_NOACTIVATE as isize) == 0 {
            tracing::warn!(
                "通知窗口 WS_EX_NOACTIVATE 未生效（before=0x{ex:X} after=0x{after:X}），可能抢焦点"
            );
        }
    }
}

#[cfg(not(windows))]
fn ensure_noactivate(_win: &tauri::WebviewWindow) {}

/// 显示通知窗口：显示后再兜底校验一次不可聚焦（幂等）。
fn show_window(win: &tauri::WebviewWindow) {
    if let Err(e) = win.show() {
        tracing::warn!("显示通知窗口失败: {e}");
        return;
    }
    ensure_noactivate(win);
}

/// 一次性兜底：前端异常未上报高度时，≤600ms 后按当前缓存高度显示窗口（通知不丢）。
/// 只有本轮仍处于待显示且轮次号匹配才显示——hide()/新一轮会推进轮次号使其自动失效；
/// 不常驻轮询、不重复起定时器，任务结束即释放。
fn spawn_show_watchdog(app: &AppHandle, generation: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_WATCHDOG_DELAY).await;
        let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        let visible = win.is_visible().unwrap_or(false);
        let show = take_pending_show(generation, visible);
        if show {
            tracing::debug!("通知窗口首帧测量未回传，watchdog 按当前高度兜底显示");
            show_window(&win);
        }
    });
}

/// 通知栈为空时由前端调用：隐藏窗口但保留 WebView 常驻复用。
pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.hide();
    }
    // 本轮结束：下一轮通知允许重新选择显示器，并从 160 逻辑像素起算。
    reset_round_geometry();
    *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()) = 160.0;
    // 本轮作废：清除待显示标记并推进轮次号，隐藏后到达的迟到 fit/watchdog 不得再 show。
    cancel_pending_show();
}

/// 启动时挂接窗口事件（销毁时重置缓存，保持与窗口生命周期同步）。
pub fn init(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        // 不抢焦点：把「不可聚焦」交给 tao 的窗口状态机维护。它会依据 FOCUSABLE 标志
        // 在每次 show/hide/set_size 重算样式时带上 WS_EX_NOACTIVATE；手写 EXSTYLE 位会
        // 被下一次 apply_diff 整段覆盖，因此这里在窗口创建阶段就把标志落进状态机。
        if let Err(err) = win.set_focusable(false) {
            tracing::warn!("通知窗口设置不可聚焦失败，显示前将回退为手动确保样式: {err}");
        }
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                UI_READY.store(false, Ordering::SeqCst);
                SNOOZED.lock().unwrap_or_else(|e| e.into_inner()).clear();
                reset_round_geometry();
                *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()) = 160.0;
                cancel_pending_show();
            }
        });
    }
}

// ── 稍后提醒 ─────────────────────────────────────────────────

/// 调度器每秒调用：把到期卡片重新送展示窗口（用户主动请求，不经额度）。
pub fn poll_snoozed(app: &AppHandle) {
    let mut guard = SNOOZED.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_empty() {
        return;
    }
    let mut due = Vec::new();
    guard.retain(|(card, at)| {
        if Instant::now() >= *at {
            due.push(card.clone());
            false
        } else {
            true
        }
    });
    drop(guard);
    if !due.is_empty() {
        show_cards(app, &due);
    }
}

// ── 命令 ─────────────────────────────────────────────────────

/// 前端回传实测内容高度：收放窗口**高度**并保持本轮显示器锚点不动。
/// 只在当前锚定显示器内调整，不因鼠标移到别的屏幕而跨屏；宽度按工作区钳制。
#[tauri::command]
pub fn fit_notification_window(app: AppHandle, height: f64) {
    let h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()) = h;
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    // 即使高度未变，也重新按锚点应用几何：覆盖工作区/DPI/显示器变化。
    if let Some(info) = resolve_anchor(&app, false) {
        apply_geometry(&win, &info);
    }
    // 首帧测量完成：隐藏态的窗口此刻才显示，用的就是刚下发的最终高度/位置，
    // 不会再出现 160px 视口下先显示一帧的裁切；已可见时只收放高度，不重复 show。
    let generation = current_show_generation();
    let visible = win.is_visible().unwrap_or(false);
    let show = take_pending_show(generation, visible);
    if show {
        show_window(&win);
    }
}

#[tauri::command]
pub fn hide_notification_window(app: AppHandle) {
    hide(&app);
}

/// 等待卡「稍后提醒」：按卡片载荷原样暂存，到期后整卡重新展示。
/// 分钟数钳制 1~1440；暂存上限 20，超出丢弃最早一条（都是用户主动请求）。
#[tauri::command]
pub fn notification_snooze(card: NotificationCardPayload, minutes: Option<u32>) {
    let minutes = minutes.unwrap_or(10).clamp(1, 1440);
    let mut guard = SNOOZED.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= 20 {
        guard.remove(0);
    }
    guard.push((
        card.into(),
        Instant::now() + Duration::from_secs(minutes as u64 * 60),
    ));
}

/// 用户点击跳转时返回的结构化结果：页面跳转成功与「定位到具体业务对象」分别如实反馈。
#[derive(Debug, Clone, Serialize)]
pub struct NotificationNavigateResult {
    pub tab: String,
    pub located: bool,
    #[serde(rename = "externalSessionId", skip_serializing_if = "Option::is_none")]
    pub external_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

struct ResolvedSession {
    external_session_id: String,
    run_matched: bool,
}

/// 把通知里的内部会话/轮次 ID 解析成可用于「已有 Agent 会话导航」的对象。
/// 兼容两种输入：agent_sessions.id（通知载荷实际使用的值）或 external_id。
fn resolve_session(
    db: &Db,
    source: &str,
    session: &str,
    ref_id: Option<&str>,
) -> AppResult<Option<ResolvedSession>> {
    use rusqlite::OptionalExtension;
    let external = db.with_conn(|conn| {
        conn.query_row(
            "SELECT external_id FROM agent_sessions WHERE id = ?1 AND source_id = ?2",
            rusqlite::params![session, source],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppError::from)
    })?;
    let external = match external {
        Some(id) => id,
        None => {
            let exists: i64 = db.with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                    rusqlite::params![source, session],
                    |row| row.get(0),
                )
                .map_err(AppError::from)
            })?;
            if exists == 0 {
                return Ok(None);
            }
            session.to_string()
        }
    };
    let run_matched = match ref_id {
        Some(id) => {
            let found: i64 = db.with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_runs WHERE id = ?1 AND session_id = ?2 AND source_id = ?3",
                    rusqlite::params![id, session, source],
                    |row| row.get(0),
                )
                .map_err(AppError::from)
            })?;
            found > 0
        }
        None => false,
    };
    Ok(Some(ResolvedSession {
        external_session_id: external,
        run_matched,
    }))
}

/// 用户点击跳转（查看详情/立即处理/通知中心）：激活主窗口、切换标签页，
/// 并在有可靠 ID 时复用已有 Agent 会话导航定位到对应会话/轮次。
/// 只有这条用户主动路径允许夺取焦点；通知出现本身绝不调用。
#[tauri::command]
pub async fn notification_navigate(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    target: String,
    source_id: Option<String>,
    session_id: Option<String>,
    ref_id: Option<String>,
) -> AppResult<NotificationNavigateResult> {
    if let Some(win) = app.get_webview_window("main") {
        crate::show_and_focus(&win);
    }
    let tab = match target.as_str() {
        "history" => "history",
        "tasks" => "tasks",
        _ => "agents",
    };

    let mut located = true;
    let mut external_session_id = None;
    let mut reason = None;
    let mut focus = serde_json::Map::new();

    if tab == "agents" {
        match (source_id.clone(), session_id.clone()) {
            (Some(source), Some(session)) => {
                let db = db.inner().clone();
                let nav_source = source.clone();
                let nav_session = session.clone();
                let nav_ref_id = ref_id.clone();
                let outcome = tauri::async_runtime::spawn_blocking(move || {
                    let resolved = resolve_session(
                        &db,
                        &nav_source,
                        &nav_session,
                        nav_ref_id.as_deref(),
                    )?;
                    if let Some(r) = resolved {
                        let settings = crate::db::Settings::load(&db).unwrap_or_default();
                        let nav = crate::navigation::agent_navigation::resume_session(
                            &db,
                            &nav_source,
                            &r.external_session_id,
                            &settings,
                        );
                        let reason = if nav.success {
                            None
                        } else {
                            Some(
                                nav.reason
                                    .unwrap_or_else(|| "外部 Agent 会话恢复未成功".into()),
                            )
                        };
                        Ok::<_, AppError>(Some((r, reason)))
                    } else {
                        Ok(None)
                    }
                })
                .await
                .map_err(|e| AppError::Agent(format!("导航任务执行失败: {e}")))??;

                match outcome {
                    Some((resolved, resume_reason)) => {
                        focus.insert("sourceId".into(), source.clone().into());
                        focus.insert("sessionId".into(), session.clone().into());
                        if let Some(id) = ref_id.as_deref() {
                            focus.insert("refId".into(), id.into());
                        }
                        external_session_id = Some(resolved.external_session_id);
                        if !resolved.run_matched {
                            reason = Some("未找到对应轮次记录，已定位到会话".into());
                        } else if resume_reason.is_some() {
                            reason = resume_reason;
                        }
                    }
                    None => {
                        located = false;
                        reason = Some("本地无此会话记录（可能已清理），已打开 Agent 页面".into());
                    }
                }
            }
            _ => {
                if ref_id.is_some() {
                    located = false;
                    reason = Some("缺少会话信息，无法定位到具体轮次，已打开 Agent 页面".into());
                } else {
                    reason = Some("已打开 Agent 页面（该通知未关联可定位的会话）".into());
                }
            }
        }
    }

    let mut payload = serde_json::Map::new();
    payload.insert("tab".into(), tab.into());
    for (key, value) in focus {
        payload.insert(key, value);
    }
    let _ = app.emit_to(
        "main",
        NAVIGATE_EVENT,
        serde_json::Value::Object(payload),
    );

    Ok(NotificationNavigateResult {
        tab: tab.to_string(),
        located,
        external_session_id,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1080p 主屏工作区（任务栏占底部 48px）。
    fn wa_full_hd() -> WorkArea {
        WorkArea::new(0, 0, 1920, 1032)
    }

    #[test]
    fn places_bottom_right_inside_work_area() {
        let (x, y) = place_stack(wa_full_hd(), (400.0, 300.0), 1.0);
        assert_eq!(x, 1920 - 16 - 400);
        assert_eq!(y, 1032 - 16 - 300);
    }

    #[test]
    fn clamps_when_work_area_smaller_than_stack() {
        let wa = WorkArea::new(0, 0, 300, 200);
        let (x, y) = place_stack(wa, (400.0, 300.0), 1.0);
        // 收进工作区（贴 margin 起点），不出现负坐标
        assert_eq!(x, 16);
        assert_eq!(y, 16);
        // 坐标非负不等于可访问：窗口尺寸也必须落进工作区，内容不被截到屏幕外
        let (w, h) = fit_logical_size(wa, (400.0, 300.0), 1.0);
        assert_eq!((w, h), (268.0, 168.0));
        assert!(x as f64 + w <= wa.w as f64);
        assert!(y as f64 + h <= wa.h as f64);
    }

    #[test]
    fn tiny_work_area_still_yields_positive_accessible_window() {
        let wa = WorkArea::new(0, 0, 40, 30);
        let (w, h) = fit_logical_size(wa, (400.0, 300.0), 1.0);
        assert_eq!((w, h), (8.0, 1.0));
        let (x, y) = place_stack(wa, (400.0, 300.0), 1.0);
        assert!(x >= 0 && y >= 0);
    }

    fn monitor(name: &str, x: i32, scale: f64) -> MonitorInfo {
        MonitorInfo {
            anchor: Anchor {
                name: Some(name.into()),
                x,
                y: 0,
                w: 1920,
                h: 1080,
            },
            work_area: WorkArea::new(x, 0, 1920, 1032),
            scale,
        }
    }

    #[test]
    fn anchor_stays_on_first_monitor_when_cursor_moves_to_second() {
        let monitors = vec![monitor("DISPLAY1", 0, 1.0), monitor("DISPLAY2", 1920, 1.25)];
        let anchor = monitors[0].anchor.clone();
        // 高度变化/展开期间再次解析：即使光标已在第二屏，也必须命中原锚点
        let first = find_anchor_monitor(&monitors, &anchor).unwrap();
        let second = find_anchor_monitor(&monitors, &monitor("DISPLAY2", 1920, 1.25).anchor).unwrap();
        assert_eq!(first, 0);
        assert_eq!(second, 1);
        // 按光标点仍能选到第二屏（仅用于新一轮/锚点失效时重新选择）
        assert_eq!(monitor_for_point(&monitors, (2500.0, 500.0)), Some(1));
        assert_eq!(monitor_for_point(&monitors, (500.0, 500.0)), Some(0));
    }

    #[test]
    fn anchor_survives_monitor_reposition_by_name_and_falls_back_when_gone() {
        let monitors = vec![monitor("DISPLAY2", 0, 1.0), monitor("DISPLAY1", 1920, 1.0)];
        let anchor = Anchor {
            name: Some("DISPLAY1".into()),
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        };
        // 显示器顺序/坐标变化，但名称仍可识别 → 仍锚定原屏
        assert_eq!(find_anchor_monitor(&monitors, &anchor), Some(1));
        // 显示器断开 → 无匹配，由调用方重新选屏
        let gone = Anchor {
            name: Some("DISPLAY9".into()),
            ..anchor
        };
        assert_eq!(find_anchor_monitor(&monitors, &gone), None);
    }

    #[test]
    fn dpi_change_recomputes_size_within_work_area() {
        let wa = WorkArea::new(0, 0, 2560, 1440);
        // 150% → 200%：同样逻辑尺寸在物理上占更大空间，但仍在工作区内
        let (w150, h150) = fit_logical_size(wa, (400.0, 700.0), 1.5);
        let (w200, h200) = fit_logical_size(wa, (400.0, 700.0), 2.0);
        assert_eq!((w150, h150), (400.0, 700.0));
        assert_eq!((w200, h200), (400.0, 688.0));
    }

    #[test]
    fn honors_secondary_monitor_origin() {
        let wa = WorkArea::new(2560, 0, 1920, 1032);
        let (x, y) = place_stack(wa, (400.0, 300.0), 1.0);
        assert_eq!(x, 2560 + 1920 - 16 - 400);
        assert_eq!(y, 1032 - 16 - 300);
    }

    #[test]
    fn converts_logical_size_by_monitor_scale() {
        // 150% 缩放：400×300 逻辑 → 600×450 物理
        let wa = WorkArea::new(0, 0, 2560, 1392);
        let (x, y) = place_stack(wa, (400.0, 300.0), 1.5);
        assert_eq!(x, (2560.0 - 24.0 - 600.0) as i32);
        assert_eq!(y, (1392.0 - 24.0 - 450.0) as i32);
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        let (x, y) = place_stack(wa_full_hd(), (400.0, 300.0), 0.0);
        assert_eq!(x, 1920 - 16 - 400);
        assert_eq!(y, 1032 - 16 - 300);
    }

    // ── 首帧显示状态机（延迟 show 到首次 fit）──────────────

    #[test]
    fn hidden_show_triggers_single_show_on_first_fit() {
        let mut state = PendingShowState::default();
        let generation = state.arm().expect("隐藏态首次展示必须登记待显示");
        assert!(state.pending);
        // 首次 fit（首帧布局测量回传）：应用几何后显示一次
        assert!(state.take(generation, false));
        assert!(!state.pending);
        // 动画/字体/尺寸变化带来的重复 fit：不再 show
        assert!(!state.take(generation, false));
    }

    #[test]
    fn already_visible_window_never_shows_again() {
        let mut state = PendingShowState::default();
        let generation = state.arm().unwrap();
        // 窗口已可见（如 watchdog 已兜底显示）：fit 只收放高度，不重复 show
        assert!(!state.take(generation, true));
        // 残留标记必须清掉，否则窗口隐藏后会被旧标记误显示
        assert!(!state.pending);
        assert!(!state.take(generation, true));
    }

    #[test]
    fn late_fit_after_hide_does_not_show() {
        let mut state = PendingShowState::default();
        let generation = state.arm().unwrap();
        // hide()：清标记并推进轮次号
        state.cancel();
        // 上一轮的迟到 fit：不得把已隐藏的窗口重新显示
        assert!(!state.take(generation, false));
        // 即使带着 hide 后的新轮次号，也没有待显示标记
        assert!(!state.take(generation.wrapping_add(1), false));
        assert!(!state.pending);
    }

    #[test]
    fn stale_generation_does_not_show_and_keeps_current_pending() {
        let mut state = PendingShowState::default();
        let old_generation = state.arm().unwrap();
        state.cancel();
        let new_generation = state.arm().unwrap();
        assert_ne!(old_generation, new_generation);
        // 上一轮迟到 fit：不显示，且不得清掉当前轮标记
        assert!(!state.take(old_generation, false));
        assert!(state.pending);
        // 当前轮 fit 才显示
        assert!(state.take(new_generation, false));
        assert!(!state.pending);
    }

    #[test]
    fn repeated_arm_within_round_reuses_watchdog() {
        let mut state = PendingShowState::default();
        let first = state.arm().expect("首次登记应返回轮次号以启动 watchdog");
        // 同一轮追加批次：不重复登记、不重复起定时器
        assert_eq!(state.arm(), None);
        assert_eq!(state.arm(), None);
        assert_eq!(state.generation, first);
    }

    #[test]
    fn watchdog_shows_only_while_round_still_pending() {
        // 到期仍未收到 fit：按当前缓存高度兜底显示
        let mut pending = PendingShowState::default();
        let generation = pending.arm().unwrap();
        assert!(decide_show_after_fit(
            pending.pending,
            pending.generation,
            generation,
            false
        ));
        // 期间用户已关闭通知（hide）：旧 watchdog 失效，不得重新弹窗
        let mut hidden = PendingShowState::default();
        let hidden_generation = hidden.arm().unwrap();
        hidden.cancel();
        assert!(!decide_show_after_fit(
            hidden.pending,
            hidden.generation,
            hidden_generation,
            false
        ));
        // hide 后又来了新一轮：旧 watchdog 的轮次号不匹配，交给新一轮自己的 fit/watchdog
        let mut next = PendingShowState::default();
        let stale = next.arm().unwrap();
        next.cancel();
        let current = next.arm().unwrap();
        assert!(!decide_show_after_fit(
            next.pending,
            next.generation,
            stale,
            false
        ));
        assert!(decide_show_after_fit(
            next.pending,
            next.generation,
            current,
            false
        ));
    }

    #[test]
    fn payload_roundtrips_through_snooze_shape() {
        // 前端稍后提醒会把整卡原样回传：序列化形态必须无信息丢失
        let card = NotificationCardPayload {
            id: "n1".into(),
            kind: "agent_waiting".into(),
            title: "Agent 等待处理".into(),
            body: "codex · 等待确认".into(),
            created_at: "2026-11-03T00:00:00+00:00".into(),
            source_id: Some("codex".into()),
            session_id: Some("s1".into()),
            ref_id: Some("r1".into()),
            detail: Some("等待确认发布范围".into()),
        };
        let json = serde_json::to_string(&card).unwrap();
        let back: NotificationCardPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(card, back);
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"sourceId\""));
        assert!(json.contains("\"detail\""));
    }
}
