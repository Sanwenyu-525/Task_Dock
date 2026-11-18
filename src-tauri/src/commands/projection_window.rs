//! 投屏窗口伴随系统：Session ↔ scrcpy HWND ↔ TaskDock 投屏控制栏。
//!
//! 目标：把「手机投屏窗口」从一个普通 scrcpy 窗口升级为属于 TaskDock 的完整体验。
//! 本模块只做窗口层面的编排，**不复制**投屏、导航、截图能力：
//!
//! - 会话生命周期仍由 [`super::virtual_display::process::SessionManager`] 持有；
//! - 返回/Home/最近任务继续复用 `vd_nav`（本模块只把工具栏点击转成 sessionId + action）；
//! - 截图继续复用 `vd_screenshot` 的 Android 投屏链路，不截 HWND（避免黑屏/遮挡画面）。
//!
//! 控制栏本身是独立轻量 WebView 窗口（`toolbar.html`），由本模块创建、定位与销毁：
//! 普通窗口贴在 scrcpy 窗口外侧，最大化/全屏时进入窗口内部；全屏默认隐藏，
//! 鼠标靠近屏幕底部触发显示。窗口带 `WS_EX_TOOLWINDOW`（不进 Alt+Tab/任务栏）
//! 且不可聚焦（不抢 scrcpy 键盘焦点）。所有绑定以 **session_id** 为键，
//! 不使用 active_device / 全局最近会话，因此多 Session 不会串台。
//!
//! 几何计算（外置优先级、DPI 缩放、任务栏安全区）都是纯函数，见本文件测试。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::virtual_display::{process, VdSession};
use crate::error::{AppError, AppResult};

/// 后端 → 控制栏窗口：模式/锁定/展开状态变化。
pub const TOOLBAR_STATE_EVENT: &str = "vd-toolbar-state";
/// 控制栏截图完成 → 主窗口（用于复用现有截图预览）。
pub const SCREENSHOT_EVENT: &str = "vd-screenshot-captured";

/// 稳定产品级 AUMID：**不得**把 session_id 当 AUMID（会话是短生命周期的）。
pub const PROJECTION_AUMID: &str = "TaskDock.Projection";
/// 控制栏与 scrcpy 窗口的外置间距（逻辑像素）。
pub const TOOLBAR_GAP_LOGICAL: f64 = 8.0;
/// 普通窗口控制栏逻辑尺寸（竖向）。
pub const TOOLBAR_VERTICAL_LOGICAL: (f64, f64) = (56.0, 300.0);
/// 竖向展开（更多面板）额外宽度（逻辑像素）。
pub const TOOLBAR_VERTICAL_EXTRA: f64 = 208.0;
/// 最大化/全屏控制栏逻辑尺寸（横向）。
pub const TOOLBAR_HORIZONTAL_LOGICAL: (f64, f64) = (300.0, 56.0);
/// 横向展开（更多面板）额外高度（逻辑像素）。
pub const TOOLBAR_HORIZONTAL_EXTRA: f64 = 132.0;
/// 全屏底部触发带（逻辑像素）。
pub const FULLSCREEN_TRIGGER_LOGICAL: f64 = 28.0;
/// 全屏鼠标离开后的延迟隐藏时间。
pub const FULLSCREEN_HIDE_DELAY: Duration = Duration::from_millis(1200);
/// 等待 scrcpy 窗口出现的上限（略高于 SessionManager 的 25s 启动超时）。
const WINDOW_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
/// 控制栏 watcher 周期：只推进本 Session，状态不变时不调用 SetWindowPos。
const WATCH_INTERVAL: Duration = Duration::from_millis(120);

// ── 类型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionWindowMode {
    Normal,
    Maximized,
    Fullscreen,
}

impl ProjectionWindowMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Maximized => "maximized",
            Self::Fullscreen => "fullscreen",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionType {
    Mirror,
    Virtual,
}

/// 物理像素矩形（绝对屏幕坐标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub width: i32,
    pub height: i32,
}

impl WindowRect {
    pub fn from_ltrb(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
            width: (right - left).max(0),
            height: (bottom - top).max(0),
        }
    }

    pub fn from_xywh(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
            width,
            height,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolbarRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl ToolbarRect {
    fn contains(&self, point: (i32, i32)) -> bool {
        point.0 >= self.x
            && point.0 < self.x + self.width
            && point.1 >= self.y
            && point.1 < self.y + self.height
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolbarPlacement {
    Right,
    Left,
    Bottom,
    Top,
    Inside,
}

/// 窗口所在显示器的快照（物理像素）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorInfo {
    /// `\\.\DISPLAY1` 之类的设备名；不可用时为空串。
    pub id: String,
    /// 显示器完整区域（全屏判断用）。
    pub monitor: WindowRect,
    /// 工作区（已排除任务栏）。
    pub work: WindowRect,
    /// 窗口 DPI（96 的倍数即默认缩放）。
    pub dpi: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectionWindowBinding {
    pub session_id: String,
    pub scrcpy_hwnd: isize,
    pub toolbar_hwnd: isize,
    pub monitor_id: String,
    pub dpi: u32,
    pub mode: ProjectionWindowMode,
    pub toolbar_locked: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectionWindowError {
    #[error("会话不存在或已结束")]
    SessionMissing,
    #[error("未找到 scrcpy 窗口")]
    WindowNotFound,
    #[error("窗口无效：{0}")]
    InvalidWindow(String),
    #[error("控制栏窗口创建失败：{0}")]
    ToolbarUnavailable(String),
    #[error("当前平台不支持投屏窗口伴随系统")]
    Unsupported,
}

impl From<ProjectionWindowError> for AppError {
    fn from(value: ProjectionWindowError) -> Self {
        match value {
            ProjectionWindowError::SessionMissing => {
                AppError::NotFound("会话不存在或已结束".into())
            }
            ProjectionWindowError::WindowNotFound => {
                AppError::NotFound("未找到 scrcpy 窗口".into())
            }
            ProjectionWindowError::InvalidWindow(message) => AppError::Conflict(message),
            ProjectionWindowError::ToolbarUnavailable(message) => {
                AppError::Unavailable(format!("投屏控制栏不可用：{message}"))
            }
            ProjectionWindowError::Unsupported => {
                AppError::Unavailable("当前平台不支持投屏窗口伴随系统".into())
            }
        }
    }
}

// ── 纯几何计算（可单测）────────────────────────────────────

/// DPI → 物理像素尺寸（逻辑尺寸 × 缩放，四舍五入）。
pub fn scale_toolbar_size(logical: (f64, f64), dpi: u32) -> Size {
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    Size {
        width: (logical.0 * scale).round().max(1.0) as i32,
        height: (logical.1 * scale).round().max(1.0) as i32,
    }
}

/// 控制栏逻辑尺寸（普通窗口竖向，最大化/全屏横向）。
pub fn toolbar_logical_size(mode: ProjectionWindowMode) -> (f64, f64) {
    match mode {
        ProjectionWindowMode::Normal => TOOLBAR_VERTICAL_LOGICAL,
        _ => TOOLBAR_HORIZONTAL_LOGICAL,
    }
}

fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        return min;
    }
    value.clamp(min, max)
}

/// 外置控制栏位置：右侧 → 左侧 → 下方 → 上方 → 窗口内部。
///
/// `work` 必须是显示器**工作区**（已排除任务栏）；所有结果都收敛在工作区里。
pub fn calculate_external_toolbar_placement(
    window: WindowRect,
    work: WindowRect,
    toolbar: Size,
    gap: i32,
) -> (ToolbarRect, ToolbarPlacement) {
    let gap = gap.max(0);
    let max_x = work.right - toolbar.width;
    let max_y = work.bottom - toolbar.height;

    // 右侧：与窗口垂直居中。
    let right_x = window.right + gap;
    if right_x <= max_x {
        let y = window.top + (window.height - toolbar.height) / 2;
        return (
            ToolbarRect {
                x: clamp(right_x, work.left, max_x),
                y: clamp(y, work.top, max_y),
                width: toolbar.width,
                height: toolbar.height,
            },
            ToolbarPlacement::Right,
        );
    }

    // 左侧。
    let left_x = window.left - gap - toolbar.width;
    if left_x >= work.left {
        let y = window.top + (window.height - toolbar.height) / 2;
        return (
            ToolbarRect {
                x: clamp(left_x, work.left, max_x),
                y: clamp(y, work.top, max_y),
                width: toolbar.width,
                height: toolbar.height,
            },
            ToolbarPlacement::Left,
        );
    }

    // 下方：与窗口水平居中。
    let bottom_y = window.bottom + gap;
    if bottom_y <= max_y {
        let x = window.left + (window.width - toolbar.width) / 2;
        return (
            ToolbarRect {
                x: clamp(x, work.left, max_x),
                y: clamp(bottom_y, work.top, max_y),
                width: toolbar.width,
                height: toolbar.height,
            },
            ToolbarPlacement::Bottom,
        );
    }

    // 上方。
    let top_y = window.top - gap - toolbar.height;
    if top_y >= work.top {
        let x = window.left + (window.width - toolbar.width) / 2;
        return (
            ToolbarRect {
                x: clamp(x, work.left, max_x),
                y: clamp(top_y, work.top, max_y),
                width: toolbar.width,
                height: toolbar.height,
            },
            ToolbarPlacement::Top,
        );
    }

    (
        calculate_inside_toolbar_rect(window, work, toolbar, gap),
        ToolbarPlacement::Inside,
    )
}

/// 窗口内部的控制栏位置：底部居中，并收敛在工作区里。
pub fn calculate_inside_toolbar_rect(
    window: WindowRect,
    work: WindowRect,
    toolbar: Size,
    margin: i32,
) -> ToolbarRect {
    let margin = margin.max(0);
    let max_x = work.right - toolbar.width;
    let max_y = work.bottom - toolbar.height;
    let x = window.left + (window.width - toolbar.width) / 2;
    let y = window.bottom - toolbar.height - margin;
    ToolbarRect {
        x: clamp(x, work.left, max_x),
        y: clamp(y, work.top, max_y),
        width: toolbar.width,
        height: toolbar.height,
    }
}

/// 展开「更多」面板时的窗口矩形：竖向向左扩、横向向上扩，保持控制栏本身不动。
pub fn expand_toolbar_rect(
    bar: ToolbarRect,
    mode: ProjectionWindowMode,
    dpi: u32,
    work: WindowRect,
) -> ToolbarRect {
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    match mode {
        ProjectionWindowMode::Normal => {
            let extra = (TOOLBAR_VERTICAL_EXTRA * scale).round() as i32;
            let width = bar.width + extra;
            let x = clamp(bar.x - extra, work.left, work.right - width);
            ToolbarRect {
                x,
                y: bar.y,
                width,
                height: bar.height,
            }
        }
        _ => {
            let extra = (TOOLBAR_HORIZONTAL_EXTRA * scale).round() as i32;
            let height = bar.height + extra;
            let y = clamp(bar.y - extra, work.top, work.bottom - height);
            ToolbarRect {
                x: bar.x,
                y,
                width: bar.width,
                height,
            }
        }
    }
}

/// 全屏底部触发带：鼠标进入屏幕底部 `trigger_px` 即显示控制栏。
pub fn fullscreen_trigger_hit(
    monitor: WindowRect,
    cursor: Option<(i32, i32)>,
    trigger_px: i32,
) -> bool {
    let Some((x, y)) = cursor else {
        return false;
    };
    x >= monitor.left
        && x < monitor.right
        && y >= monitor.bottom - trigger_px.max(1)
        && y < monitor.bottom
}

/// 全屏控制栏可见性状态机（纯函数）：锁定/悬停/触发带 → 显示；
/// 否则在延迟到期后隐藏。返回 (是否可见, 新的隐藏截止时间)。
pub fn fullscreen_visibility_tick(
    locked: bool,
    cursor_in_toolbar: bool,
    cursor_in_trigger: bool,
    now: Instant,
    hide_deadline: Option<Instant>,
) -> (bool, Option<Instant>) {
    if locked || cursor_in_toolbar || cursor_in_trigger {
        return (true, Some(now + FULLSCREEN_HIDE_DELAY));
    }
    match hide_deadline {
        Some(deadline) if now < deadline => (true, hide_deadline),
        _ => (false, None),
    }
}

/// 统一窗口标题：不出现 "Task Dock"、serial、PID、IP 或 session id。
pub fn build_projection_window_title(
    device_name: &str,
    projection_type: ProjectionType,
    app_name: Option<&str>,
) -> String {
    let device = device_name.trim();
    let device = if device.is_empty() { "Android" } else { device };
    match projection_type {
        ProjectionType::Mirror => format!("TaskDock · {device} · 屏幕镜像"),
        ProjectionType::Virtual => {
            let app = app_name.map(str::trim).filter(|name| !name.is_empty());
            format!(
                "TaskDock · {device} · {}",
                app.unwrap_or("独立虚拟屏")
            )
        }
    }
}

// ── 注册表 ──────────────────────────────────────────────────

struct BindingState {
    binding: ProjectionWindowBinding,
    watcher_stop: Option<Arc<AtomicBool>>,
    expanded: bool,
}

/// Session → scrcpy HWND / Toolbar HWND 的唯一映射。
///
/// Key 必须是 session_id：不能用 device_name / active_device / last_session，
/// 否则两个投屏窗口会串台。
pub struct ProjectionWindowRegistry {
    map: Mutex<HashMap<String, BindingState>>,
}

impl ProjectionWindowRegistry {
    pub fn register(
        &self,
        session_id: &str,
        scrcpy_hwnd: isize,
    ) -> Result<(), ProjectionWindowError> {
        if scrcpy_hwnd == 0 {
            return Err(ProjectionWindowError::InvalidWindow(
                "scrcpy 窗口句柄为空".into(),
            ));
        }
        let monitor = get_window_monitor(scrcpy_hwnd)?;
        let mode = detect_projection_window_mode(scrcpy_hwnd);
        let mut map = self.map.lock().expect("projection registry");
        if let Some(state) = map.get_mut(session_id) {
            // 已绑定：只刷新窗口与显示器快照，绝不重建第二个 Toolbar。
            state.binding.scrcpy_hwnd = scrcpy_hwnd;
            state.binding.monitor_id = monitor.id;
            state.binding.dpi = monitor.dpi;
            state.binding.mode = mode;
            return Ok(());
        }
        map.insert(
            session_id.to_string(),
            BindingState {
                binding: ProjectionWindowBinding {
                    session_id: session_id.to_string(),
                    scrcpy_hwnd,
                    toolbar_hwnd: 0,
                    monitor_id: monitor.id,
                    dpi: monitor.dpi,
                    mode,
                    toolbar_locked: false,
                },
                watcher_stop: None,
                expanded: false,
            },
        );
        Ok(())
    }

    /// 测试与 attach 失败降级时使用：不触碰 Win32，只登记绑定。
    #[cfg(test)]
    pub(crate) fn insert_binding(&self, binding: ProjectionWindowBinding) {
        let mut map = self.map.lock().expect("projection registry");
        map.insert(
            binding.session_id.clone(),
            BindingState {
                binding,
                watcher_stop: None,
                expanded: false,
            },
        );
    }

    pub fn get(&self, session_id: &str) -> Option<ProjectionWindowBinding> {
        self.map
            .lock()
            .expect("projection registry")
            .get(session_id)
            .map(|state| state.binding.clone())
    }

    pub fn remove(&self, session_id: &str) {
        let removed = self
            .map
            .lock()
            .expect("projection registry")
            .remove(session_id);
        if let Some(state) = removed {
            if let Some(stop) = state.watcher_stop {
                stop.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn toolbar_hwnd(&self, session_id: &str) -> Option<isize> {
        self.get(session_id)
            .map(|binding| binding.toolbar_hwnd)
            .filter(|hwnd| *hwnd != 0)
    }

    pub fn scrcpy_hwnd(&self, session_id: &str) -> Option<isize> {
        self.get(session_id)
            .map(|binding| binding.scrcpy_hwnd)
            .filter(|hwnd| *hwnd != 0)
    }

    pub fn update_mode(&self, session_id: &str, mode: ProjectionWindowMode) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.binding.mode = mode;
        }
    }

    pub fn set_toolbar_hwnd(&self, session_id: &str, hwnd: isize) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.binding.toolbar_hwnd = hwnd;
        }
    }

    pub fn set_scrcpy_hwnd(&self, session_id: &str, hwnd: isize) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.binding.scrcpy_hwnd = hwnd;
        }
    }

    pub fn set_monitor(&self, session_id: &str, monitor: &MonitorInfo) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.binding.monitor_id = monitor.id.clone();
            state.binding.dpi = monitor.dpi;
        }
    }

    pub fn set_locked(&self, session_id: &str, locked: bool) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.binding.toolbar_locked = locked;
        }
    }

    pub fn locked(&self, session_id: &str) -> Option<bool> {
        self.get(session_id).map(|binding| binding.toolbar_locked)
    }

    pub fn set_expanded(&self, session_id: &str, expanded: bool) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.expanded = expanded;
        }
    }

    pub fn expanded(&self, session_id: &str) -> Option<bool> {
        self.map
            .lock()
            .expect("projection registry")
            .get(session_id)
            .map(|state| state.expanded)
    }

    /// 停掉 watcher 并登记停止标志；返回旧标志供调用方复核。
    fn replace_watcher_stop(
        &self,
        session_id: &str,
        stop: Arc<AtomicBool>,
    ) -> Option<Arc<AtomicBool>> {
        self.map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
            .and_then(|state| state.watcher_stop.replace(stop))
    }

    fn clear_watcher(&self, session_id: &str) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.watcher_stop = None;
        }
    }

    /// 一个 Session 只拥有一个 Toolbar：清理后返回是否确实移除过。
    pub fn cleanup(&self, session_id: &str) -> bool {
        let removed = self
            .map
            .lock()
            .expect("projection registry")
            .remove(session_id);
        let Some(state) = removed else {
            return false;
        };
        if let Some(stop) = state.watcher_stop {
            stop.store(true, Ordering::Relaxed);
        }
        if state.binding.toolbar_hwnd != 0 {
            close_toolbar_window(session_id);
        }
        true
    }

    pub fn session_ids(&self) -> Vec<String> {
        self.map
            .lock()
            .expect("projection registry")
            .keys()
            .cloned()
            .collect()
    }
}

fn registry() -> &'static ProjectionWindowRegistry {
    static REGISTRY: OnceLock<ProjectionWindowRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| ProjectionWindowRegistry {
        map: Mutex::new(HashMap::new()),
    })
}

/// 当前进程的 AppHandle：控制栏窗口只在真实应用内创建（测试环境为 None）。
static APP: OnceLock<AppHandle> = OnceLock::new();

fn app_handle() -> Option<AppHandle> {
    APP.get().cloned()
}

/// 启动时登记 AppHandle（必须在任何 vd_start 之前调用）。
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn toolbar_label(session_id: &str) -> String {
    format!("vd-toolbar-{session_id}")
}

/// 窗口 URL 不携带查询参数：session_id 从窗口 label（`vd-toolbar-<id>`）读取，
/// 避免 `WebviewUrl::App(PathBuf)` 对 `?query` 的路径语义差异。
fn toolbar_url() -> &'static str {
    "toolbar.html"
}

// ── 会话绑定与生命周期 ─────────────────────────────────────

/// `vd_start` 成功后调用：等 scrcpy 窗口真正就绪，再登记绑定、创建控制栏并启动 watcher。
/// 整个过程在后台线程执行，绝不阻塞 IPC 返回。同一 Session 只允许一个在途 attach。
pub fn spawn_attach(app: AppHandle, session_id: String) {
    // 记录 AppHandle：watcher / 清理线程只通过它访问 Tauri 窗口。
    init(&app);
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let in_flight = IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let Ok(mut guard) = in_flight.lock() else {
            return;
        };
        if !guard.insert(session_id.clone()) {
            return;
        }
    }
    let id = session_id.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("vd-toolbar-attach-{}", short_id(&session_id)))
        .spawn(move || {
            attach_worker(app, id.clone());
            if let Ok(mut guard) = in_flight.lock() {
                guard.remove(&id);
            }
        });
    if spawned.is_err() {
        if let Ok(mut guard) = in_flight.lock() {
            guard.remove(&session_id);
        }
        mark_toolbar_unavailable(&session_id, "控制栏绑定线程创建失败");
    }
}

fn short_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

fn attach_worker(app: AppHandle, session_id: String) {
    let deadline = Instant::now() + WINDOW_WAIT_TIMEOUT;
    let hwnd = loop {
        if Instant::now() >= deadline {
            mark_toolbar_unavailable(
                &session_id,
                "未在 20 秒内找到 scrcpy 窗口，控制栏未创建",
            );
            return;
        }
        let session = match process::manager().session(&session_id) {
            Ok(session) => session,
            // 会话已被移除/结束：不需要控制栏，也不留下任何窗口。
            Err(_) => return,
        };
        if !matches!(session.status.as_str(), "starting" | "running") {
            return;
        }
        if session.status == "running" {
            if let Ok(found) = find_scrcpy_window(&session_id) {
                break found;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    if !validate_scrcpy_window(&session_id, hwnd) {
        mark_toolbar_unavailable(&session_id, "scrcpy 窗口校验失败，控制栏未创建");
        return;
    }
    if let Err(error) = registry().register(&session_id, hwnd) {
        mark_toolbar_unavailable(&session_id, &format!("登记投屏窗口失败：{error}"));
        return;
    }

    // 品牌化：标题、图标与 AUMID。失败只降低品牌完整度，不阻断投屏。
    if let Ok(session) = process::manager().session(&session_id) {
        if let Err(error) = apply_taskdock_window_identity(hwnd, &session) {
            tracing::warn!(session = %short_id(&session_id), "投屏窗口品牌化失败: {error}");
            process::manager().append_warning(
                &session_id,
                "投屏窗口品牌化未完全生效（标题/图标可能仍显示 scrcpy）",
            );
        }
    }

    let toolbar_hwnd = match create_toolbar_on_main(&app, &session_id) {
        Ok(hwnd) => hwnd,
        Err(error) => {
            // 降级：scrcpy 继续可用，但 Session 明确标记控制栏不可用。
            mark_toolbar_unavailable(&session_id, &error.to_string());
            return;
        }
    };
    registry().set_toolbar_hwnd(&session_id, toolbar_hwnd);
    start_projection_window_watcher(&session_id);
    process::manager().set_toolbar_state(&session_id, "ready");

    // scrcpy 可能在窗口出现后再次设置自己的图标：800ms 后幂等重放一次（有界，不轮询）。
    std::thread::sleep(Duration::from_millis(800));
    if validate_scrcpy_window(&session_id, hwnd) {
        let _ = set_projection_window_icon(hwnd);
        let _ = set_projection_app_user_model_id(hwnd, &session_id);
    }
}

fn mark_toolbar_unavailable(session_id: &str, reason: &str) {
    tracing::warn!(session = %short_id(session_id), reason, "投屏控制栏不可用（降级为普通 scrcpy 窗口）");
    process::manager().set_toolbar_state(session_id, "unavailable");
    process::manager().append_warning(
        session_id,
        "投屏控制栏未能创建；仍可使用 scrcpy 窗口与其快捷键",
    );
}

/// SessionManager 生命周期钩子：会话结束/移除时由 process 子模块调用。
pub fn on_session_ended(session_id: &str) {
    registry().cleanup(session_id);
}

/// 应用退出：停止全部 watcher 并销毁控制栏（不触碰用户手动启动的 scrcpy）。
pub fn shutdown_all() {
    for session_id in registry().session_ids() {
        registry().cleanup(&session_id);
    }
}

// ── 控制栏窗口 ─────────────────────────────────────────────

fn create_toolbar_on_main(
    app: &AppHandle,
    session_id: &str,
) -> Result<isize, ProjectionWindowError> {
    let label = toolbar_label(session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        if let Ok(hwnd) = existing.hwnd() {
            return Ok(hwnd.0 as isize);
        }
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<isize, String>>();
    let app_for_main = app.clone();
    let label_for_main = label.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<isize, String> {
            if let Some(existing) = app_for_main.get_webview_window(&label_for_main) {
                let hwnd = existing
                    .hwnd()
                    .map_err(|error| format!("读取已有控制栏句柄失败：{error}"))?;
                return Ok(hwnd.0 as isize);
            }
            let window = tauri::WebviewWindowBuilder::new(
                &app_for_main,
                &label_for_main,
                tauri::WebviewUrl::App(toolbar_url().into()),
            )
            .title("TaskDock · 投屏控制栏")
            .inner_size(TOOLBAR_VERTICAL_LOGICAL.0, TOOLBAR_VERTICAL_LOGICAL.1)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|error| format!("创建控制栏窗口失败：{error}"))?;
            // 不抢焦点：tao 窗口状态机会在 show/set_size 时保留该标志。
            let _ = window.set_focusable(false);
            let hwnd = window
                .hwnd()
                .map_err(|error| format!("读取控制栏句柄失败：{error}"))?;
            Ok(hwnd.0 as isize)
        })();
        let _ = tx.send(result);
    })
    .map_err(|error| ProjectionWindowError::ToolbarUnavailable(error.to_string()))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| ProjectionWindowError::ToolbarUnavailable("创建控制栏窗口超时".into()))?
        .map_err(ProjectionWindowError::ToolbarUnavailable)
}

fn close_toolbar_window(session_id: &str) {
    let Some(app) = app_handle() else {
        return;
    };
    let label = toolbar_label(session_id);
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_main.get_webview_window(&label) {
            // destroy 绕过 CloseRequested：Session 结束时必须真正销毁，绝不残留控制栏。
            let _ = window.destroy();
        }
    });
}

/// 彻底清理一个 Session 的控制栏（幂等）。关闭 Session 时必须走到这里，
/// 不能使用 taskkill / killAllScrcpy 之类的全局杀进程方式。
pub fn destroy_toolbar(session_id: &str) -> bool {
    let removed = registry().cleanup(session_id);
    process::manager().set_toolbar_state(session_id, "closed");
    removed
}

/// 停止 watcher 并隐藏控制栏；不关闭 scrcpy，也不销毁窗口（可再次 attach）。
pub fn detach_toolbar(session_id: &str) -> bool {
    if let Some(binding) = registry().get(session_id) {
        if let Some(stop) = registry().replace_watcher_stop(
            session_id,
            Arc::new(AtomicBool::new(true)),
        ) {
            stop.store(true, Ordering::Relaxed);
        }
        if binding.toolbar_hwnd != 0 {
            win::set_visible(binding.toolbar_hwnd, false);
        }
        return true;
    }
    false
}

pub fn show_projection_toolbar(session_id: &str) {
    if let Some(binding) = registry().get(session_id) {
        if binding.toolbar_hwnd != 0 {
            win::set_visible(binding.toolbar_hwnd, true);
        }
    }
}

pub fn hide_projection_toolbar(session_id: &str) {
    if let Some(binding) = registry().get(session_id) {
        if binding.toolbar_hwnd != 0 {
            win::set_visible(binding.toolbar_hwnd, false);
        }
    }
}

/// 点击控制栏后恢复 scrcpy 焦点：控件本身 NOACTIVATE，执行命令后把输入焦点还给手机画面。
pub fn restore_projection_focus(session_id: &str) -> Result<(), String> {
    process::manager()
        .focus(session_id)
        .map(|_| ())
        .map_err(|error| error.user_message())
}

/// `vd_stop` 的统一收尾：先停 scrcpy，再停 watcher / 销毁控制栏。
pub fn close_projection_session(session_id: &str) -> AppResult<bool> {
    let stopped = process::manager().stop(session_id)?;
    destroy_toolbar(session_id);
    Ok(stopped)
}

// ── 窗口 watcher ───────────────────────────────────────────

/// 建立（或重建）本 Session 的控制栏跟随线程。只监听一个会话，状态不变不写窗口。
pub fn start_projection_window_watcher(session_id: &str) {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(previous) = registry().replace_watcher_stop(session_id, Arc::clone(&stop)) {
        previous.store(true, Ordering::Relaxed);
    }
    let id = session_id.to_string();
    let spawned = std::thread::Builder::new()
        .name(format!("vd-toolbar-watch-{}", short_id(session_id)))
        .spawn(move || watcher_loop(id, stop));
    if spawned.is_err() {
        registry().clear_watcher(session_id);
        mark_toolbar_unavailable(session_id, "控制栏跟随线程创建失败");
    }
}

fn watcher_loop(session_id: String, stop: Arc<AtomicBool>) {
    let mut last_rect: Option<ToolbarRect> = None;
    let mut last_visible = false;
    let mut last_mode: Option<ProjectionWindowMode> = None;
    let mut last_locked = false;
    let mut last_expanded = false;
    let mut hide_deadline: Option<Instant> = None;

    while !stop.load(Ordering::Relaxed) {
        let Some(binding) = registry().get(&session_id) else {
            break;
        };
        let Ok(session) = process::manager().session(&session_id) else {
            break;
        };
        if !matches!(session.status.as_str(), "starting" | "running" | "stopping") {
            break;
        }
        if binding.toolbar_hwnd == 0 {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }

        let hwnd = binding.toolbar_hwnd;
        if !win::is_valid_window(binding.scrcpy_hwnd)
            || !win::window_belongs_to(binding.scrcpy_hwnd, session.pid)
        {
            // scrcpy 窗口消失（关闭/重建）：先藏控制栏，并尝试按 PID 重新定位一次。
            if last_visible {
                win::set_visible(hwnd, false);
                last_visible = false;
                last_rect = None;
            }
            if let Ok(found) = find_scrcpy_window(&session_id) {
                registry().set_scrcpy_hwnd(&session_id, found);
            }
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }

        let Some(window_rect) = win::window_rect(binding.scrcpy_hwnd) else {
            std::thread::sleep(WATCH_INTERVAL);
            continue;
        };
        if win::is_minimized(binding.scrcpy_hwnd) {
            if last_visible {
                win::set_visible(hwnd, false);
                last_visible = false;
            }
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        let Some(monitor) = win::window_monitor(binding.scrcpy_hwnd) else {
            std::thread::sleep(WATCH_INTERVAL);
            continue;
        };

        let mode = win::detect_mode(binding.scrcpy_hwnd, &window_rect, &monitor.monitor);
        let locked = registry().locked(&session_id).unwrap_or(false);
        let expanded = registry().expanded(&session_id).unwrap_or(false);
        let scale = if monitor.dpi == 0 {
            1.0
        } else {
            monitor.dpi as f64 / 96.0
        };
        let gap = (TOOLBAR_GAP_LOGICAL * scale).round() as i32;
        let work = if mode == ProjectionWindowMode::Fullscreen {
            // 全屏覆盖任务栏：以显示器完整区域为准。
            monitor.monitor
        } else {
            monitor.work
        };
        let size = scale_toolbar_size(toolbar_logical_size(mode), monitor.dpi);
        let (target_bar, _placement) = match mode {
            ProjectionWindowMode::Normal => {
                calculate_external_toolbar_placement(window_rect, work, size, gap)
            }
            _ => (
                calculate_inside_toolbar_rect(window_rect, work, size, gap.max(8)),
                ToolbarPlacement::Inside,
            ),
        };
        let target = if expanded {
            expand_toolbar_rect(target_bar, mode, monitor.dpi, work)
        } else {
            target_bar
        };

        let cursor = win::cursor_pos();
        let visible = match mode {
            ProjectionWindowMode::Normal | ProjectionWindowMode::Maximized => true,
            ProjectionWindowMode::Fullscreen => {
                let trigger = (FULLSCREEN_TRIGGER_LOGICAL * scale).round() as i32;
                let hit = fullscreen_trigger_hit(monitor.monitor, cursor, trigger);
                let over = cursor.map(|point| target.contains(point)).unwrap_or(false);
                let (visible, next_deadline) = fullscreen_visibility_tick(
                    locked,
                    over,
                    hit,
                    Instant::now(),
                    hide_deadline,
                );
                hide_deadline = next_deadline;
                visible
            }
        };

        if last_rect != Some(target) {
            win::set_rect(hwnd, target);
            last_rect = Some(target);
        }
        if visible != last_visible {
            win::set_visible(hwnd, visible);
            last_visible = visible;
        }

        if last_mode != Some(mode) || last_locked != locked || last_expanded != expanded {
            registry().update_mode(&session_id, mode);
            registry().set_monitor(&session_id, &monitor);
            if let Some(app) = app_handle() {
                let payload = ToolbarStatePayload {
                    mode: mode.as_str().to_string(),
                    locked,
                    expanded,
                    visible,
                };
                let _ = app.emit_to(
                    toolbar_label(&session_id),
                    TOOLBAR_STATE_EVENT,
                    payload,
                );
            }
            last_mode = Some(mode);
            last_locked = locked;
            last_expanded = expanded;
        }

        std::thread::sleep(WATCH_INTERVAL);
    }

    if let Some(binding) = registry().get(&session_id) {
        if binding.toolbar_hwnd != 0 {
            win::set_visible(binding.toolbar_hwnd, false);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolbarStatePayload {
    pub mode: String,
    pub locked: bool,
    pub expanded: bool,
    pub visible: bool,
}

// ── 窗口查找 / 校验 / 品牌化 ───────────────────────────────

/// 按 Session 记录的 PID 查找 scrcpy 顶层窗口。
///
/// 优先使用标题（`--window-title` 写入）评分，面积兜底；不依赖固定标题，
/// 也不会命中其他 scrcpy 实例（PID 必须属于本 Session）。
pub fn find_scrcpy_window(session_id: &str) -> Result<isize, ProjectionWindowError> {
    let session = process::manager()
        .session(session_id)
        .map_err(|_| ProjectionWindowError::SessionMissing)?;
    if session.pid == 0 {
        return Err(ProjectionWindowError::SessionMissing);
    }
    win::find_scrcpy_window(session.pid, &session.title)
        .ok_or(ProjectionWindowError::WindowNotFound)
}

/// 校验 HWND 仍是本 Session 记录的 PID 的可见顶层窗口；任一失败即视为无效。
pub fn validate_scrcpy_window(session_id: &str, hwnd: isize) -> bool {
    if hwnd == 0 || !win::is_valid_window(hwnd) {
        return false;
    }
    let Ok(session) = process::manager().session(session_id) else {
        return false;
    };
    if matches!(session.status.as_str(), "stopped" | "error" | "disconnected") {
        return false;
    }
    win::window_belongs_to(hwnd, session.pid)
}

pub fn get_projection_window_rect(hwnd: isize) -> Result<WindowRect, ProjectionWindowError> {
    win::window_rect(hwnd)
        .ok_or_else(|| ProjectionWindowError::InvalidWindow("读取窗口矩形失败".into()))
}

/// 区分 normal / maximized / fullscreen：不能只比较宽度是否等于屏幕宽度。
pub fn detect_projection_window_mode(hwnd: isize) -> ProjectionWindowMode {
    let rect = win::window_rect(hwnd).unwrap_or(WindowRect::from_ltrb(0, 0, 0, 0));
    let monitor = win::window_monitor(hwnd)
        .map(|info| info.monitor)
        .unwrap_or(WindowRect::from_ltrb(0, 0, 0, 0));
    win::detect_mode(hwnd, &rect, &monitor)
}

pub fn get_window_monitor(hwnd: isize) -> Result<MonitorInfo, ProjectionWindowError> {
    win::window_monitor(hwnd)
        .ok_or_else(|| ProjectionWindowError::InvalidWindow("读取显示器信息失败".into()))
}

pub fn get_monitor_work_area(monitor: isize) -> Option<WindowRect> {
    win::monitor_work_area(monitor)
}

pub fn get_window_dpi(hwnd: isize) -> u32 {
    win::window_dpi(hwnd)
}

/// TaskDock 品牌身份：标题 + 大小图标 + AppUserModelID。
pub fn apply_taskdock_window_identity(
    hwnd: isize,
    session: &VdSession,
) -> Result<(), ProjectionWindowError> {
    if !win::is_valid_window(hwnd) {
        return Err(ProjectionWindowError::InvalidWindow(
            "窗口句柄无效，无法应用品牌身份".into(),
        ));
    }
    let projection_type = if session.mode == "virtual" {
        ProjectionType::Virtual
    } else {
        ProjectionType::Mirror
    };
    let title = build_projection_window_title(
        session.device_model.as_deref().unwrap_or("Android"),
        projection_type,
        session.app_label.as_deref(),
    );
    win::set_window_title(hwnd, &title);
    let mut failures: Vec<String> = Vec::new();
    if let Err(error) = set_projection_window_icon(hwnd) {
        failures.push(format!("图标：{error}"));
    }
    if let Err(error) = set_projection_app_user_model_id(hwnd, &session.id) {
        failures.push(format!("AUMID：{error}"));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        // 标题已经生效时，图标/AUMID 失败只报告，不把整个品牌化判失败。
        tracing::warn!(
            session = %short_id(&session.id),
            "投屏窗口品牌化部分失败: {}",
            failures.join("；")
        );
        Ok(())
    }
}

pub fn set_projection_window_icon(hwnd: isize) -> Result<(), ProjectionWindowError> {
    win::set_window_icon(hwnd)
}

/// 设置窗口的 AppUserModelID（任务栏身份）。
///
/// 注意：AUMID 是稳定的产品级标识，**不是** session_id；
/// session_id 只用于窗口内部关联（本函数参数仅用于日志/校验上下文）。
pub fn set_projection_app_user_model_id(
    hwnd: isize,
    session_id: &str,
) -> Result<(), ProjectionWindowError> {
    let _ = session_id;
    win::set_app_user_model_id(hwnd, PROJECTION_AUMID)
}

// ── Tauri 命令 ─────────────────────────────────────────────

#[tauri::command]
pub fn vd_session(session_id: String) -> AppResult<VdSession> {
    process::manager().session(&session_id)
}

#[tauri::command]
pub fn vd_toolbar_attach(session_id: String) -> AppResult<String> {
    // 已就绪：幂等返回；未就绪：触发一次真实 attach（失败会标记 unavailable）。
    if let Some(binding) = registry().get(&session_id) {
        if binding.toolbar_hwnd != 0 {
            return Ok("ready".into());
        }
    }
    let app = app_handle().ok_or_else(|| AppError::Unavailable("窗口服务尚未就绪".into()))?;
    spawn_attach(app, session_id);
    Ok("pending".into())
}

#[tauri::command]
pub fn vd_toolbar_detach(session_id: String) -> AppResult<bool> {
    Ok(detach_toolbar(&session_id))
}

/// 立即重新读取 HWND / 矩形 / 状态 / 显示器 / DPI，并重算控制栏位置。
#[tauri::command]
pub fn vd_toolbar_update(session_id: String) -> AppResult<bool> {
    let Some(binding) = registry().get(&session_id) else {
        return Ok(false);
    };
    if binding.toolbar_hwnd == 0 {
        return Ok(false);
    }
    let Ok(window_rect) = get_projection_window_rect(binding.scrcpy_hwnd) else {
        return Ok(false);
    };
    let Ok(monitor) = get_window_monitor(binding.scrcpy_hwnd) else {
        return Ok(false);
    };
    let mode = win::detect_mode(binding.scrcpy_hwnd, &window_rect, &monitor.monitor);
    let scale = if monitor.dpi == 0 {
        1.0
    } else {
        monitor.dpi as f64 / 96.0
    };
    let gap = (TOOLBAR_GAP_LOGICAL * scale).round() as i32;
    let work = if mode == ProjectionWindowMode::Fullscreen {
        monitor.monitor
    } else {
        monitor.work
    };
    let size = scale_toolbar_size(toolbar_logical_size(mode), monitor.dpi);
    let (bar, _) = match mode {
        ProjectionWindowMode::Normal => {
            calculate_external_toolbar_placement(window_rect, work, size, gap)
        }
        _ => (
            calculate_inside_toolbar_rect(window_rect, work, size, gap.max(8)),
            ToolbarPlacement::Inside,
        ),
    };
    let target = if registry().expanded(&session_id).unwrap_or(false) {
        expand_toolbar_rect(bar, mode, monitor.dpi, work)
    } else {
        bar
    };
    win::set_rect(binding.toolbar_hwnd, target);
    registry().update_mode(&session_id, mode);
    registry().set_monitor(&session_id, &monitor);
    Ok(true)
}

#[tauri::command]
pub fn vd_toolbar_destroy(session_id: String) -> AppResult<bool> {
    Ok(destroy_toolbar(&session_id))
}

#[tauri::command]
pub fn vd_toolbar_set_locked(session_id: String, locked: bool) -> AppResult<bool> {
    if registry().get(&session_id).is_none() {
        return Ok(false);
    }
    registry().set_locked(&session_id, locked);
    Ok(true)
}

#[tauri::command]
pub fn vd_toolbar_set_expanded(session_id: String, expanded: bool) -> AppResult<bool> {
    if registry().get(&session_id).is_none() {
        return Ok(false);
    }
    registry().set_expanded(&session_id, expanded);
    Ok(true)
}

/// 控制栏截图：复用 `vd_screenshot` 的 Android 投屏链路，并把结果广播给主窗口预览。
#[tauri::command]
pub fn vd_toolbar_screenshot(
    app: AppHandle,
    session_id: String,
) -> AppResult<super::virtual_display::VdScreenshot> {
    let shot = process::manager().screenshot(&session_id)?;
    let session = process::manager().session(&session_id)?;
    let payload = serde_json::json!({
        "session": session,
        "screenshot": shot,
    });
    if let Err(error) = app.emit(SCREENSHOT_EVENT, payload) {
        tracing::warn!("广播投屏截图失败（截图文件仍在临时目录）: {error}");
    }
    Ok(shot)
}

// ── Win32 ──────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::{
        MonitorInfo, ProjectionWindowError, ProjectionWindowMode, ToolbarRect, WindowRect,
    };

    use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITORINFOEXW,
        MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::ExtractIconExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, EnumWindows, GetCursorPos, GetWindow, GetWindowLongW,
        GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
        IsWindowVisible, IsZoomed, SendMessageW, SetWindowPos, SetWindowTextW, ShowWindowAsync,
        GWL_STYLE, GW_OWNER, HICON, ICON_BIG, ICON_SMALL, LR_DEFAULTCOLOR, SWP_NOACTIVATE,
        SWP_NOOWNERZORDER, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_SETICON, WS_CAPTION,
        WS_POPUP,
    };

    pub fn is_valid_window(hwnd: isize) -> bool {
        unsafe { IsWindow(hwnd as HWND) != 0 }
    }

    pub fn window_belongs_to(hwnd: isize, pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let mut owner = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd as HWND, &mut owner);
        }
        owner == pid
    }

    pub fn window_rect(hwnd: isize) -> Option<WindowRect> {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd as HWND, &mut rect) } == 0 {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(WindowRect::from_ltrb(
            rect.left, rect.top, rect.right, rect.bottom,
        ))
    }

    pub fn is_minimized(hwnd: isize) -> bool {
        unsafe { IsIconic(hwnd as HWND) != 0 }
    }

    pub fn window_dpi(hwnd: isize) -> u32 {
        let dpi = unsafe { GetDpiForWindow(hwnd as HWND) };
        if dpi == 0 {
            96
        } else {
            dpi
        }
    }

    pub fn window_monitor(hwnd: isize) -> Option<MonitorInfo> {
        let hmon = unsafe { MonitorFromWindow(hwnd as HWND, MONITOR_DEFAULTTONEAREST) };
        if hmon.is_null() {
            return None;
        }
        let mut info: MONITORINFOEXW = unsafe { std::mem::zeroed() };
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe {
            GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
        } == 0
        {
            return None;
        }
        let mi = &info.monitorInfo;
        Some(MonitorInfo {
            id: String::from_utf16_lossy(&info.szDevice)
                .trim_end_matches('\0')
                .to_string(),
            monitor: WindowRect::from_ltrb(
                mi.rcMonitor.left,
                mi.rcMonitor.top,
                mi.rcMonitor.right,
                mi.rcMonitor.bottom,
            ),
            work: WindowRect::from_ltrb(
                mi.rcWork.left,
                mi.rcWork.top,
                mi.rcWork.right,
                mi.rcWork.bottom,
            ),
            dpi: window_dpi(hwnd),
        })
    }

    pub fn monitor_work_area(monitor: isize) -> Option<WindowRect> {
        if monitor == 0 {
            return None;
        }
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if unsafe { GetMonitorInfoW(monitor as HMONITOR, &mut info) } == 0 {
            return None;
        }
        Some(WindowRect::from_ltrb(
            info.rcWork.left,
            info.rcWork.top,
            info.rcWork.right,
            info.rcWork.bottom,
        ))
    }

    /// normal / maximized / fullscreen。综合 WS_MAXIMIZE、边框样式与显示器矩形，
    /// 不把「宽度等于屏幕」单独当成全屏判据。
    pub fn detect_mode(
        hwnd: isize,
        rect: &WindowRect,
        monitor: &WindowRect,
    ) -> ProjectionWindowMode {
        if !is_valid_window(hwnd) {
            return ProjectionWindowMode::Normal;
        }
        if unsafe { IsZoomed(hwnd as HWND) } != 0 {
            return ProjectionWindowMode::Maximized;
        }
        let style = unsafe { GetWindowLongW(hwnd as HWND, GWL_STYLE) } as u32;
        let bordered = style & WS_CAPTION == WS_CAPTION;
        let popup = style & WS_POPUP == WS_POPUP;
        let covers = monitor.width > 0
            && (rect.left - monitor.left).abs() <= 2
            && (rect.top - monitor.top).abs() <= 2
            && (rect.right - monitor.right).abs() <= 2
            && (rect.bottom - monitor.bottom).abs() <= 2;
        // 最大化已由 IsZoomed 捕获；精确覆盖显示器且无标题栏/为弹出窗口即全屏。
        // 不能只用「宽高等于屏幕」判断，避免普通窗口恰好铺满时误判。
        if covers && (!bordered || popup) {
            return ProjectionWindowMode::Fullscreen;
        }
        ProjectionWindowMode::Normal
    }

    struct FindContext {
        pid: u32,
        title: Vec<u16>,
        best: isize,
        best_score: i64,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> i32 {
        let ctx = &mut *(lparam as *mut FindContext);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != ctx.pid || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        if !GetWindow(hwnd, GW_OWNER).is_null() {
            return 1;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return 1;
        }
        let area = (rect.right - rect.left).max(0) as i64 * (rect.bottom - rect.top).max(0) as i64;
        if area <= 0 {
            return 1;
        }
        let mut score = area;
        if !ctx.title.is_empty() {
            let mut buffer = [0u16; 512];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if len > 0 {
                let current = &buffer[..len as usize];
                let mut expected = ctx.title.as_slice();
                if expected.last() == Some(&0) {
                    expected = &expected[..expected.len() - 1];
                }
                if current == expected {
                    // 标题命中远高于面积：避免把同进程的辅助窗口当主窗口。
                    score += 1_000_000_000_000;
                }
            }
        }
        if score > ctx.best_score {
            ctx.best_score = score;
            ctx.best = hwnd as isize;
        }
        1
    }

    pub fn find_scrcpy_window(pid: u32, title: &str) -> Option<isize> {
        if pid == 0 {
            return None;
        }
        let mut title: Vec<u16> = title.encode_utf16().collect();
        title.push(0);
        let mut ctx = FindContext {
            pid,
            title,
            best: 0,
            best_score: -1,
        };
        unsafe {
            EnumWindows(Some(enum_cb), &mut ctx as *mut _ as isize);
        }
        (ctx.best != 0).then_some(ctx.best)
    }

    pub fn cursor_pos() -> Option<(i32, i32)> {
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            None
        } else {
            Some((point.x, point.y))
        }
    }

    pub fn set_rect(hwnd: isize, rect: ToolbarRect) {
        if hwnd == 0 {
            return;
        }
        unsafe {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
            );
        }
    }

    /// 显示/隐藏都不激活窗口：控制栏永远不把焦点从 scrcpy 抢走。
    pub fn set_visible(hwnd: isize, visible: bool) {
        if hwnd == 0 {
            return;
        }
        unsafe {
            ShowWindowAsync(hwnd as HWND, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }

    pub fn set_window_title(hwnd: isize, title: &str) {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            SetWindowTextW(hwnd as HWND, wide.as_ptr());
        }
    }

    /// TaskDock 正式产品图标（随二进制内嵌，不依赖 exe 资源 ID 或当前工作目录）。
    const TASKDOCK_ICON_ICO: &[u8] = include_bytes!("../../icons/icon.ico");

    fn embedded_icons() -> Option<(HICON, HICON)> {
        let bytes = TASKDOCK_ICON_ICO;
        if bytes.len() < 6 {
            return None;
        }
        let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        if count == 0 {
            return None;
        }
        let mut entries: Vec<(i32, i32, u32, usize)> = Vec::new();
        for index in 0..count {
            let offset = 6 + index * 16;
            if offset + 16 > bytes.len() {
                break;
            }
            let width = if bytes[offset] == 0 {
                256
            } else {
                bytes[offset] as i32
            };
            let height = if bytes[offset + 1] == 0 {
                256
            } else {
                bytes[offset + 1] as i32
            };
            let size = u32::from_le_bytes(match bytes[offset + 8..offset + 12].try_into() {
                Ok(value) => value,
                Err(_) => continue,
            }) as usize;
            let image_offset =
                u32::from_le_bytes(match bytes[offset + 12..offset + 16].try_into() {
                    Ok(value) => value,
                    Err(_) => continue,
                }) as usize;
            if size == 0 || image_offset.checked_add(size).map(|end| end > bytes.len()) != Some(false) {
                continue;
            }
            entries.push((width, height, size as u32, image_offset));
        }
        if entries.is_empty() {
            return None;
        }
        let large = entries
            .iter()
            .max_by_key(|(width, height, _, _)| (*width as i64) * (*height as i64))?;
        let small = entries
            .iter()
            .min_by_key(|(width, height, _, _)| {
                let size = (*width).min(*height);
                (size - 32).abs()
            })
            .unwrap_or(large);
        let create = |entry: &(i32, i32, u32, usize)| -> HICON {
            let (width, height, size, offset) = *entry;
            unsafe {
                CreateIconFromResourceEx(
                    bytes.as_ptr().add(offset),
                    size,
                    1,
                    0x0003_0000,
                    width,
                    height,
                    LR_DEFAULTCOLOR,
                )
            }
        };
        let large_icon = create(large);
        let small_icon = create(small);
        if large_icon.is_null() && small_icon.is_null() {
            None
        } else {
            Some((large_icon, small_icon))
        }
    }

    /// 用 TaskDock 正式产品图标替换 scrcpy 窗口图标（标题栏 / Alt+Tab / 任务栏）。
    pub fn set_window_icon(hwnd: isize) -> Result<(), ProjectionWindowError> {
        if !is_valid_window(hwnd) {
            return Err(ProjectionWindowError::InvalidWindow(
                "窗口句柄无效，无法设置图标".into(),
            ));
        }
        // 优先使用内嵌的正式图标；失败才退回当前 exe 的图标资源。
        let (large, small) = if let Some(icons) = embedded_icons() {
            icons
        } else {
            let exe = std::env::current_exe().map_err(|error| {
                ProjectionWindowError::InvalidWindow(format!("读取程序路径失败：{error}"))
            })?;
            let wide: Vec<u16> = exe
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut large = std::ptr::null_mut();
            let mut small = std::ptr::null_mut();
            let count = unsafe { ExtractIconExW(wide.as_ptr(), 0, &mut large, &mut small, 1) };
            if count == 0 || (large.is_null() && small.is_null()) {
                return Err(ProjectionWindowError::InvalidWindow(
                    "未找到可用的 TaskDock 图标资源".into(),
                ));
            }
            (large, small)
        };
        unsafe {
            if !large.is_null() {
                SendMessageW(hwnd as HWND, WM_SETICON, ICON_BIG as usize, large as isize);
            }
            if !small.is_null() {
                SendMessageW(hwnd as HWND, WM_SETICON, ICON_SMALL as usize, small as isize);
            }
            // 只有一个尺寸可用时，把同一图标同时用于大小图标，避免标题栏回退成默认图标。
            if large.is_null() && !small.is_null() {
                SendMessageW(hwnd as HWND, WM_SETICON, ICON_BIG as usize, small as isize);
            }
            if small.is_null() && !large.is_null() {
                SendMessageW(hwnd as HWND, WM_SETICON, ICON_SMALL as usize, large as isize);
            }
        }
        Ok(())
    }

    /// 设置窗口的 AppUserModelID（任务栏分组身份）。
    pub fn set_app_user_model_id(
        hwnd: isize,
        aumid: &str,
    ) -> Result<(), ProjectionWindowError> {
        set_app_user_model_id_inner(hwnd, aumid).map_err(ProjectionWindowError::InvalidWindow)
    }

    #[cfg(windows)]
    fn set_app_user_model_id_inner(hwnd: isize, aumid: &str) -> Result<(), String> {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::HWND as WHWND;
        use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
        use windows::Win32::System::Com::StructuredStorage::{
            PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
        };
        use windows::Win32::System::Com::{
            CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, CoUninitialize,
            COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::System::Variant::VT_LPWSTR;
        use windows::Win32::UI::Shell::PropertiesSystem::{
            IPropertyStore, SHGetPropertyStoreForWindow,
        };

        struct ComGuard(bool);
        impl Drop for ComGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() };
                }
            }
        }

        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        let _guard = ComGuard(initialized);

        unsafe {
            let store: IPropertyStore =
                SHGetPropertyStoreForWindow(WHWND(hwnd as *mut core::ffi::c_void))
                    .map_err(|error| format!("获取窗口属性存储失败：{error}"))?;
            let wide: Vec<u16> = aumid.encode_utf16().chain(std::iter::once(0)).collect();
            let bytes = wide.len() * std::mem::size_of::<u16>();
            let memory = CoTaskMemAlloc(bytes) as *mut u16;
            if memory.is_null() {
                return Err("分配 AUMID 内存失败".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), memory, wide.len());
            // 直接构造 PROPVARIANT，避免对 ManuallyDrop 联合字段做 DerefMut 赋值。
            let inner = PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    pwszVal: PWSTR(memory),
                },
            };
            let variant = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: std::mem::ManuallyDrop::new(inner),
                },
            };
            let result = store.SetValue(&PKEY_AppUserModel_ID, &variant);
            CoTaskMemFree(Some(memory as *const core::ffi::c_void));
            result.map_err(|error| format!("写入 AUMID 失败：{error}"))?;
            store
                .Commit()
                .map_err(|error| format!("提交 AUMID 失败：{error}"))?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod win {
    use super::{
        MonitorInfo, ProjectionWindowError, ProjectionWindowMode, ToolbarRect, WindowRect,
    };

    pub fn is_valid_window(_hwnd: isize) -> bool {
        false
    }
    pub fn window_belongs_to(_hwnd: isize, _pid: u32) -> bool {
        false
    }
    pub fn window_rect(_hwnd: isize) -> Option<WindowRect> {
        None
    }
    pub fn is_minimized(_hwnd: isize) -> bool {
        false
    }
    pub fn window_dpi(_hwnd: isize) -> u32 {
        96
    }
    pub fn window_monitor(_hwnd: isize) -> Option<MonitorInfo> {
        None
    }
    pub fn monitor_work_area(_monitor: isize) -> Option<WindowRect> {
        None
    }
    pub fn detect_mode(
        _hwnd: isize,
        _rect: &WindowRect,
        _monitor: &WindowRect,
    ) -> ProjectionWindowMode {
        ProjectionWindowMode::Normal
    }
    pub fn find_scrcpy_window(_pid: u32, _title: &str) -> Option<isize> {
        None
    }
    pub fn cursor_pos() -> Option<(i32, i32)> {
        None
    }
    pub fn set_rect(_hwnd: isize, _rect: ToolbarRect) {}
    pub fn set_visible(_hwnd: isize, _visible: bool) {}
    pub fn set_window_title(_hwnd: isize, _title: &str) {}
    pub fn set_window_icon(_hwnd: isize) -> Result<(), ProjectionWindowError> {
        Err(ProjectionWindowError::Unsupported)
    }
    pub fn set_app_user_model_id(
        _hwnd: isize,
        _aumid: &str,
    ) -> Result<(), ProjectionWindowError> {
        Err(ProjectionWindowError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work() -> WindowRect {
        WindowRect::from_ltrb(0, 0, 1920, 1040)
    }

    fn window() -> WindowRect {
        WindowRect::from_ltrb(200, 120, 1300, 900)
    }

    #[test]
    fn calculate_external_toolbar_right() {
        let (rect, placement) = calculate_external_toolbar_placement(
            window(),
            work(),
            Size { width: 56, height: 300 },
            8,
        );
        assert_eq!(placement, ToolbarPlacement::Right);
        assert_eq!(rect.x, 1308);
        assert_eq!(rect.y, 120 + (780 - 300) / 2);
        assert!(rect.x + rect.width <= work().right);
    }

    #[test]
    fn calculate_external_toolbar_left() {
        let window = WindowRect::from_ltrb(1500, 120, 1912, 900);
        let (rect, placement) = calculate_external_toolbar_placement(
            window,
            work(),
            Size { width: 56, height: 300 },
            8,
        );
        assert_eq!(placement, ToolbarPlacement::Left);
        assert_eq!(rect.x, 1500 - 8 - 56);
        assert!(rect.x >= 0);
    }

    #[test]
    fn calculate_external_toolbar_bottom() {
        let window = WindowRect::from_ltrb(0, 0, 1920, 900);
        let (rect, placement) = calculate_external_toolbar_placement(
            window,
            work(),
            Size { width: 300, height: 56 },
            8,
        );
        assert_eq!(placement, ToolbarPlacement::Bottom);
        assert_eq!(rect.y, 908);
        assert!(rect.y + rect.height <= work().bottom);
    }

    #[test]
    fn calculate_external_toolbar_top() {
        let window = WindowRect::from_ltrb(0, 80, 1920, 1000);
        let (rect, placement) = calculate_external_toolbar_placement(
            window,
            work(),
            Size { width: 300, height: 56 },
            8,
        );
        assert_eq!(placement, ToolbarPlacement::Top);
        assert_eq!(rect.y, 80 - 8 - 56);
        assert!(rect.y >= 0);
    }

    #[test]
    fn calculate_external_toolbar_inside_when_no_space() {
        let window = WindowRect::from_ltrb(0, 0, 1920, 1040);
        let (rect, placement) = calculate_external_toolbar_placement(
            window,
            work(),
            Size { width: 56, height: 300 },
            8,
        );
        assert_eq!(placement, ToolbarPlacement::Inside);
        assert!(rect.x >= 0 && rect.x + rect.width <= 1920);
        assert!(rect.y >= 0 && rect.y + rect.height <= 1040);
    }

    #[test]
    fn toolbar_position_with_taskbar_stays_in_work_area() {
        // 工作区底部被 40px 任务栏占用；控制栏不能压进任务栏。
        let work = WindowRect::from_ltrb(0, 0, 1920, 1040);
        let window = WindowRect::from_ltrb(0, 0, 1920, 900);
        let (rect, placement) = calculate_external_toolbar_placement(
            window,
            work,
            Size { width: 300, height: 56 },
            8,
        );
        assert_eq!(placement, ToolbarPlacement::Bottom);
        assert!(rect.y + rect.height <= 1040);
    }

    fn assert_scale(dpi: u32, expected: Size) {
        assert_eq!(
            scale_toolbar_size(TOOLBAR_VERTICAL_LOGICAL, dpi),
            expected,
            "DPI {dpi} 应缩放逻辑尺寸"
        );
    }

    #[test]
    fn toolbar_position_with_dpi_125() {
        assert_scale(120, Size { width: 70, height: 375 });
    }

    #[test]
    fn toolbar_position_with_dpi_150() {
        assert_scale(144, Size { width: 84, height: 450 });
    }

    #[test]
    fn toolbar_position_with_dpi_200() {
        assert_scale(192, Size { width: 112, height: 600 });
    }

    #[test]
    fn session_toolbar_binding_uses_session_key() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        registry.insert_binding(ProjectionWindowBinding {
            session_id: "session-a".into(),
            scrcpy_hwnd: 0x100,
            toolbar_hwnd: 0x200,
            monitor_id: r"\\.\DISPLAY1".into(),
            dpi: 96,
            mode: ProjectionWindowMode::Normal,
            toolbar_locked: false,
        });
        assert_eq!(registry.toolbar_hwnd("session-a"), Some(0x200));
        assert_eq!(registry.scrcpy_hwnd("session-a"), Some(0x100));
        assert!(registry.toolbar_hwnd("session-b").is_none());
    }

    #[test]
    fn session_toolbar_isolation_keeps_two_sessions_apart() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        for (id, scrcpy, toolbar) in [("a", 0x10, 0x20), ("b", 0x30, 0x40)] {
            registry.insert_binding(ProjectionWindowBinding {
                session_id: id.into(),
                scrcpy_hwnd: scrcpy,
                toolbar_hwnd: toolbar,
                monitor_id: String::new(),
                dpi: 96,
                mode: ProjectionWindowMode::Normal,
                toolbar_locked: false,
            });
        }
        registry.remove("a");
        assert_eq!(registry.toolbar_hwnd("b"), Some(0x40));
        assert!(registry.toolbar_hwnd("a").is_none());
    }

    #[test]
    fn destroy_toolbar_is_idempotent() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        registry.insert_binding(ProjectionWindowBinding {
            session_id: "idempotent".into(),
            scrcpy_hwnd: 0x1,
            toolbar_hwnd: 0,
            monitor_id: String::new(),
            dpi: 96,
            mode: ProjectionWindowMode::Normal,
            toolbar_locked: false,
        });
        assert!(registry.cleanup("idempotent"));
        assert!(!registry.cleanup("idempotent"));
    }

    #[test]
    fn window_titles_never_leak_internal_identity() {
        let title = build_projection_window_title("V2323A", ProjectionType::Mirror, None);
        assert_eq!(title, "TaskDock · V2323A · 屏幕镜像");
        assert!(!title.contains("Task Dock"));
        let virtual_title =
            build_projection_window_title("V2323A", ProjectionType::Virtual, Some("设置"));
        assert_eq!(virtual_title, "TaskDock · V2323A · 设置");
        let fallback = build_projection_window_title("", ProjectionType::Virtual, None);
        assert_eq!(fallback, "TaskDock · Android · 独立虚拟屏");
    }

    #[test]
    fn expand_rect_keeps_bar_position_and_stays_on_screen() {
        let bar = ToolbarRect {
            x: 1308,
            y: 300,
            width: 56,
            height: 300,
        };
        let expanded = expand_toolbar_rect(
            bar,
            ProjectionWindowMode::Normal,
            96,
            WindowRect::from_ltrb(0, 0, 1920, 1040),
        );
        assert_eq!(expanded.x + expanded.width, bar.x + bar.width);
        assert_eq!(expanded.y, bar.y);
        assert!(expanded.x >= 0);
    }

    #[test]
    fn fullscreen_trigger_zone_respects_bottom_edge() {
        let monitor = WindowRect::from_ltrb(0, 0, 1920, 1080);
        assert!(fullscreen_trigger_hit(monitor, Some((900, 1080 - 10)), 28));
        assert!(!fullscreen_trigger_hit(monitor, Some((900, 1080 - 60)), 28));
        assert!(!fullscreen_trigger_hit(monitor, Some((2200, 1070)), 28));
    }

    #[test]
    fn fullscreen_visibility_hides_after_delay_and_respects_lock() {
        let now = Instant::now();
        let (visible, deadline) =
            fullscreen_visibility_tick(false, false, false, now, None);
        assert!(!visible);
        assert!(deadline.is_none());

        let (visible, deadline) =
            fullscreen_visibility_tick(false, false, true, now, None);
        assert!(visible);
        let deadline = deadline.expect("显示后应记录隐藏截止时间");

        let (visible, _) = fullscreen_visibility_tick(
            false,
            false,
            false,
            deadline + Duration::from_millis(1),
            Some(deadline),
        );
        assert!(!visible, "超过延迟且未悬停时应隐藏");

        let (visible, _) =
            fullscreen_visibility_tick(true, false, false, now, None);
        assert!(visible, "锁定后不自动隐藏");
    }
}
