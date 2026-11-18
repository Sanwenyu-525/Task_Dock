//! 投屏窗口伴随系统：Session ↔ scrcpy HWND ↔ TaskDock 投屏控制栏。
//!
//! 目标：把「手机投屏窗口」从一个普通 scrcpy 窗口升级为属于 TaskDock 的完整体验。
//! 本模块只做窗口层面的编排，**不复制**投屏、导航、截图能力：
//!
//! - 会话生命周期仍由 [`super::virtual_display::process::SessionManager`] 持有；
//! - 返回/Home/最近任务继续复用 `vd_nav`（本模块只把工具栏点击转成 sessionId + action）；
//! - 截图继续复用 `vd_screenshot` 的 Android 投屏链路，不截 HWND（避免黑屏/遮挡画面）。
//!
//! 一体化架构（方案 A，真机 PoC 验证）：控制栏 WebView（`toolbar.html`）在
//! attach 阶段转为 scrcpy 窗口的 `WS_CHILD`（跨进程 SetParent），与视频画面共享
//! 同一个顶层窗口的层级、遮挡、最小化与生命周期——**不再存在独立的置顶顶层
//! 导航窗口**。布局（Side/Bottom/Compact）由 `projection_layout.rs` 纯函数计算，
//! watcher 周期应用；窗口吸附（Side 扩宽 / Bottom 增高）与子窗口定位都有去抖。
//! 所有绑定以 **session_id** 为键，不使用 active_device / 全局最近会话，
//! 因此多 Session 不会串台；`vd_projection_dispatch` 统一做会话归属校验后
//! 复用 `vd_nav`，导航能力限制（虚拟屏最近任务拒绝）保持不变。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::virtual_display::{process, VdSession};
use crate::error::{AppError, AppResult};
use super::projection_layout::{
    bottom_client_height, calculate_projection_layout, dpi_scale, should_use_bottom_layout,
    should_use_side_layout, side_client_width, LayoutSize, ProjectionLayoutCapabilities,
    ProjectionLayoutConstraints, ProjectionLayoutMode,
};

/// 后端 → 控制栏窗口：窗口形态与一体化布局模式变化。
pub const TOOLBAR_STATE_EVENT: &str = "vd-toolbar-state";
/// 控制栏截图完成 → 主窗口（用于复用现有截图预览）。
pub const SCREENSHOT_EVENT: &str = "vd-screenshot-captured";

/// 稳定产品级 AUMID：**不得**把 session_id 当 AUMID（会话是短生命周期的）。
pub const PROJECTION_AUMID: &str = "TaskDock.Projection";
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
    /// 挂载时捕获的视频真实尺寸（物理 px，取自 scrcpy 初始 ClientRect 纵横比）。
    video_size: Option<(f64, f64)>,
    /// 控制栏是否已挂载为 scrcpy 子窗口。
    attached: bool,
    /// 最近一次下发给前端的布局模式。
    layout_mode: Option<&'static str>,
    /// 布局去抖缓存：只在外框/子矩形真正变化时才发 Win32 调用。
    layout_cache: LayoutCache,
}

/// 布局循环的去抖状态（物理 px）。
#[derive(Default, Clone, Copy)]
struct LayoutCache {
    /// 最近观察到的 scrcpy 外框尺寸。
    last_outer: (i32, i32),
    /// 我们最近一次主动吸附的目标外框（用于区分「自己改的」与「scrcpy 旋转自适配」）。
    expected_outer: Option<(i32, i32)>,
    /// 最近应用到导航子窗口的矩形。
    last_child: Option<(i32, i32, i32, i32)>,
}

impl LayoutCache {
    fn outer_changed(&mut self, outer: (i32, i32)) -> bool {
        if self.last_outer == outer {
            return false;
        }
        self.last_outer = outer;
        true
    }
}

/// Session → scrcpy HWND / 导航子窗口 HWND 的唯一映射。
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
                video_size: None,
                attached: false,
                layout_mode: None,
                layout_cache: LayoutCache::default(),
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
                    video_size: None,
                    attached: false,
                    layout_mode: None,
                    layout_cache: LayoutCache::default(),
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

    // ── 一体化布局状态 ────────────────────────────────────────

    pub fn set_video_size(&self, session_id: &str, size: (f64, f64)) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.video_size = Some(size);
        }
    }

    pub fn video_size(&self, session_id: &str) -> Option<(f64, f64)> {
        self.map
            .lock()
            .expect("projection registry")
            .get(session_id)
            .and_then(|state| state.video_size)
    }

    pub fn set_attached(&self, session_id: &str, attached: bool) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.attached = attached;
        }
    }

    pub fn is_attached(&self, session_id: &str) -> bool {
        self.map
            .lock()
            .expect("projection registry")
            .get(session_id)
            .map(|state| state.attached)
            .unwrap_or(false)
    }

    pub fn set_layout_mode(&self, session_id: &str, mode: &'static str) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.layout_mode = Some(mode);
        }
    }

    pub fn layout_mode(&self, session_id: &str) -> Option<&'static str> {
        self.map
            .lock()
            .expect("projection registry")
            .get(session_id)
            .and_then(|state| state.layout_mode)
    }

    /// 按窗口句柄反查 session_id（HWND → Session，用于窗口级动作归属校验）。
    pub fn resolve_session_by_hwnd(&self, hwnd: isize) -> Option<String> {
        let map = self.map.lock().expect("projection registry");
        map.iter()
            .find(|(_, state)| {
                state.binding.scrcpy_hwnd == hwnd || state.binding.toolbar_hwnd == hwnd
            })
            .map(|(id, _)| id.clone())
    }

    /// 读取布局去抖缓存（拷贝语义，避免在锁内做 Win32 调用）。
    pub fn layout_cache(&self, session_id: &str) -> LayoutCache {
        self.map
            .lock()
            .expect("projection registry")
            .get(session_id)
            .map(|state| state.layout_cache)
            .unwrap_or_default()
    }

    pub fn set_layout_cache(&self, session_id: &str, cache: LayoutCache) {
        if let Some(state) = self
            .map
            .lock()
            .expect("projection registry")
            .get_mut(session_id)
        {
            state.layout_cache = cache;
        }
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
        if let Err(error) = apply_projection_window_identity(hwnd, &session) {
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

    // 一体化第一步：捕获视频真实尺寸。此刻 scrcpy 窗口还未被我们扩展，
    // ClientRect 纵横比 == 视频纵横比（scrcpy 初始把窗口精确适配到视频）。
    let Some((client_w, client_h)) = win::client_size(hwnd) else {
        close_toolbar_window(&session_id);
        mark_toolbar_unavailable(&session_id, "无法读取投屏窗口客户区，控制栏未创建");
        return;
    };
    registry().set_video_size(&session_id, (client_w as f64, client_h as f64));

    // 一体化第二步：控制栏挂载为 scrcpy 子窗口（WS_CHILD + SetParent）。
    // 从此控制栏与视频共享同一个顶层窗口的层级/遮挡/最小化/生命周期。
    if let Err(error) = win::attach_as_child(toolbar_hwnd, hwnd) {
        close_toolbar_window(&session_id);
        mark_toolbar_unavailable(&session_id, &error.to_string());
        return;
    }
    registry().set_attached(&session_id, true);

    // 一体化第三步：首次布局（扩展窗口宽度给导航列 + 定位子窗口 + 显示）。
    if let Err(error) = update_projection_layout(&session_id) {
        registry().set_attached(&session_id, false);
        win::detach_child(toolbar_hwnd);
        close_toolbar_window(&session_id);
        mark_toolbar_unavailable(&session_id, &error.to_string());
        return;
    }
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
            // 初始尺寸 = 导航列 + Tooltip 溢出区（挂载后由布局精确设定）。
            .inner_size(
                super::projection_layout::NAV_COLUMN_LOGICAL
                    + super::projection_layout::TOOLTIP_PAD_LOGICAL,
                320.0,
            )
            .decorations(false)
            .transparent(true)
            .shadow(false)
            // 一体化架构：控制栏是 scrcpy 窗口的 WS_CHILD，**禁止**独立置顶
            // （HWND_TOPMOST 会让导航栏在其他窗口遮挡投屏时仍然浮在上面 = P0#2）。
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

/// `vd_stop` 的统一收尾：**先销毁控制栏子窗口，再停 scrcpy**。
///
/// 顺序不能反：控制栏已挂载为 scrcpy 窗口的 `WS_CHILD`，父窗口销毁时系统会
/// 连带销毁跨进程子窗口——必须先在自己手里 destroy 子窗口，再让 scrcpy 退出。
pub fn close_projection_session(session_id: &str) -> AppResult<bool> {
    destroy_toolbar(session_id);
    let stopped = process::manager().stop(session_id)?;
    Ok(stopped)
}

// ── 窗口 watcher ───────────────────────────────────────────

/// 建立（或重建）本 Session 的布局跟随线程。只监听一个会话，状态不变不写窗口。
pub fn start_projection_window_watcher(session_id: &str) {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(previous) = registry().replace_watcher_stop(session_id, Arc::clone(&stop)) {
        previous.store(true, Ordering::Relaxed);
    }
    let id = session_id.to_string();
    let spawned = std::thread::Builder::new()
        .name(format!("vd-toolbar-watch-{}", short_id(session_id)))
        .spawn(move || projection_layout_loop(id, stop));
    if spawned.is_err() {
        registry().clear_watcher(session_id);
        mark_toolbar_unavailable(session_id, "投屏布局跟随线程创建失败");
    }
}

/// 布局循环：一体化架构下控制栏是 scrcpy 的子窗口，循环只负责
/// 「视频尺寸跟踪 → 模式判定 → 窗口吸附 → 子窗口定位 → 模式广播」。
/// 不再存在独立顶层窗口的置顶/外置定位/全屏自动隐藏逻辑。
fn projection_layout_loop(session_id: String, stop: Arc<AtomicBool>) {
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
        if binding.toolbar_hwnd == 0 || !registry().is_attached(&session_id) {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }

        if !win::is_valid_window(binding.scrcpy_hwnd)
            || !win::window_belongs_to(binding.scrcpy_hwnd, session.pid)
        {
            // scrcpy 窗口消失（关闭/重建）：按 PID 重新定位一次。
            if let Ok(found) = find_scrcpy_window(&session_id) {
                registry().set_scrcpy_hwnd(&session_id, found);
            }
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }

        // 视频尺寸跟踪：窗口外框变化且不是我们主动吸附的 → scrcpy 旋转自适配，
        // 此刻 ClientRect == 视频纵横比，重新捕获（最大化状态除外，见 update 内说明）。
        let mut cache = registry().layout_cache(&session_id);
        if let Some(outer) = win::window_rect(binding.scrcpy_hwnd) {
            let outer_size = (outer.width, outer.height);
            if cache.outer_changed(outer_size) {
                let ours = cache.expected_outer == Some(outer_size);
                if !ours && !win::is_zoomed(binding.scrcpy_hwnd) {
                    if let Some((cw, ch)) = win::client_size(binding.scrcpy_hwnd) {
                        registry().set_video_size(&session_id, (cw as f64, ch as f64));
                    }
                }
            }
        }
        registry().set_layout_cache(&session_id, cache);

        // 最小化时子窗口随父窗口一起隐藏，无需任何动作。
        let _ = update_projection_layout(&session_id);

        std::thread::sleep(WATCH_INTERVAL);
    }
}

/// 布局一轮：模式判定 → 窗口吸附（Side 扩宽 / Bottom 增高）→ 定位导航子窗口
/// → 模式变化广播。attach 后首轮调用 + watcher 周期调用；只做有界 Win32 写。
pub fn update_projection_layout(
    session_id: &str,
) -> Result<(), ProjectionWindowError> {
    let Some(binding) = registry().get(session_id) else {
        return Err(ProjectionWindowError::InvalidWindow("会话未绑定窗口".into()));
    };
    if !registry().is_attached(session_id) || binding.toolbar_hwnd == 0 {
        return Ok(());
    }
    let Ok(session) = process::manager().session(session_id) else {
        return Err(ProjectionWindowError::InvalidWindow("会话不存在".into()));
    };
    if !win::is_valid_window(binding.scrcpy_hwnd)
        || !win::window_belongs_to(binding.scrcpy_hwnd, session.pid)
    {
        return Err(ProjectionWindowError::InvalidWindow("scrcpy 窗口已失效".into()));
    }
    let Some((client_w, client_h)) = win::client_size(binding.scrcpy_hwnd) else {
        return Err(ProjectionWindowError::InvalidWindow("无法读取客户区".into()));
    };
    let Some(video_size) = registry().video_size(session_id) else {
        return Err(ProjectionWindowError::InvalidWindow("视频尺寸未捕获".into()));
    };
    let Some(monitor) = win::window_monitor(binding.scrcpy_hwnd) else {
        return Err(ProjectionWindowError::InvalidWindow("无法读取显示器".into()));
    };
    let Some(outer) = win::window_rect(binding.scrcpy_hwnd) else {
        return Err(ProjectionWindowError::InvalidWindow("无法读取外框".into()));
    };

    let video = LayoutSize { w: video_size.0, h: video_size.1 };
    let client = LayoutSize {
        w: client_w as f64,
        h: client_h as f64,
    };
    let dpi = win::window_dpi(binding.scrcpy_hwnd);
    let zoomed = win::is_zoomed(binding.scrcpy_hwnd);
    let window_mode = win::detect_mode(binding.scrcpy_hwnd, &outer, &monitor.monitor);
    // 约束来源：最大化/全屏时 Windows 管理尺寸，约束取显示器；普通窗口取工作区。
    let managed_by_os = zoomed || window_mode == ProjectionWindowMode::Fullscreen;
    let (max_w, max_h) = if managed_by_os {
        (
            monitor.monitor.width as f64,
            monitor.monitor.height as f64,
        )
    } else {
        (monitor.work.width as f64, monitor.work.height as f64)
    };
    let constraints = ProjectionLayoutConstraints {
        max_client_w: Some(max_w),
        max_client_h: Some(max_h),
    };
    let capabilities = ProjectionLayoutCapabilities::default();

    // 模式判定 + 吸附目标（纯函数，见测试）。
    let (layout_mode, target_client) = decide_projection_update(
        client,
        video,
        dpi,
        managed_by_os,
        Some(max_w),
        Some(max_h),
    );

    // 窗口吸附：只在外框真正变化时调用 SetWindowPos（避免每 120ms 抖动）。
    let frame_w = outer.width - client_w;
    let frame_h = outer.height - client_h;
    let target_outer = (
        (target_client.w + frame_w as f64).round() as i32,
        (target_client.h + frame_h as f64).round() as i32,
    );
    let mut cache = registry().layout_cache(session_id);
    let mut expected_outer = cache.expected_outer;
    if target_outer != (outer.width, outer.height) {
        if win::set_outer_size(binding.scrcpy_hwnd, target_outer.0, target_outer.1) {
            expected_outer = Some(target_outer);
            cache.last_child = None; // 客户区变化后子矩形必然重算。
        }
    } else {
        expected_outer = None;
    }

    // 按目标客户区计算布局并定位导航子窗口。
    let layout = calculate_projection_layout(
        target_client,
        video,
        dpi,
        capabilities,
        constraints,
    );
    let child_rect = (
        layout.navigation_rect.x.round() as i32,
        layout.navigation_rect.y.round() as i32,
        layout.navigation_rect.w.round() as i32,
        layout.navigation_rect.h.round() as i32,
    );
    if cache.last_child != Some(child_rect) {
        win::set_child_rect(
            binding.toolbar_hwnd,
            child_rect.0,
            child_rect.1,
            child_rect.2,
            child_rect.3,
        );
        cache.last_child = Some(child_rect);
    }
    cache.expected_outer = expected_outer;
    registry().set_layout_cache(session_id, cache);

    // 模式变化才广播（前端按模式切换导航条方向与玻璃样式）。
    if registry().layout_mode(session_id) != Some(layout_mode.as_str()) {
        registry().set_layout_mode(session_id, layout_mode.as_str());
        registry().update_mode(
            session_id,
            if zoomed {
                ProjectionWindowMode::Maximized
            } else {
                window_mode
            },
        );
        if let Some(app) = app_handle() {
            let payload = ToolbarStatePayload {
                window_mode: window_mode.as_str().to_string(),
                layout_mode: layout_mode.as_str().to_string(),
                dpi_scale: super::projection_layout::dpi_scale(dpi),
                session_id: session_id.to_string(),
            };
            let _ = app.emit_to(toolbar_label(session_id), TOOLBAR_STATE_EVENT, payload);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolbarStatePayload {
    /// 窗口形态（normal/maximized/fullscreen）。
    pub window_mode: String,
    /// 一体化布局模式（side/bottom/compact）。
    pub layout_mode: String,
    /// 当前 DPI scale（前端逻辑尺寸换算用）。
    pub dpi_scale: f64,
    pub session_id: String,
}

/// 纯函数：一轮布局的模式判定 + 窗口吸附目标（与 [`update_projection_layout`] 共用）。
///
/// - `managed_by_os`（最大化/全屏）：不吸附，交由 Windows 决定尺寸；
/// - Side：宽度吸附到「视频宽 + 2×导航 WebView」精确值（初次挂载/旋转后）；
/// - Bottom：高度吸附到「视频高 + 2×底部条带」精确值；
/// - Compact：不吸附（导航悬浮在视频右缘）。
/// - 吸附容差 2px：避免与浮点换算互相抖动。
pub fn decide_projection_update(
    client: LayoutSize,
    video: LayoutSize,
    dpi: u32,
    managed_by_os: bool,
    max_client_w: Option<f64>,
    max_client_h: Option<f64>,
) -> (ProjectionLayoutMode, LayoutSize) {
    if managed_by_os {
        return (ProjectionLayoutMode::Side, client);
    }
    if should_use_side_layout(client, video, dpi, max_client_w) {
        let mut target = client;
        let needed_w = side_client_width(video, client.h, dpi);
        if (client.w - needed_w).abs() > 2.0 {
            target.w = needed_w;
        }
        (ProjectionLayoutMode::Side, target)
    } else if should_use_bottom_layout(client, video, dpi, max_client_h) {
        let mut target = client;
        let needed_h = bottom_client_height(video, client.w, dpi);
        if (client.h - needed_h).abs() > 2.0 {
            target.h = needed_h;
        }
        (ProjectionLayoutMode::Bottom, target)
    } else {
        (ProjectionLayoutMode::Compact, client)
    }
}

// ── 会话归属与动作派发（多会话隔离红线）─────────────────────

/// HWND → Session：窗口级动作归属解析。禁止用 active_device / last_session 替代。
pub fn resolve_projection_session(hwnd: isize) -> Option<String> {
    registry().resolve_session_by_hwnd(hwnd)
}

/// Session 有效性校验：存在、运行中，且导航控制栏已挂载到投屏窗口。
pub fn validate_projection_session(session_id: &str) -> AppResult<VdSession> {
    let session = process::manager().session(session_id)?;
    if session.status != "running" {
        return Err(AppError::Conflict(
            "会话尚未就绪或已结束，无法发送导航操作".into(),
        ));
    }
    if !registry().is_attached(session_id) {
        return Err(AppError::Conflict(
            "投屏窗口未挂载导航控制栏，动作被拒绝".into(),
        ));
    }
    Ok(session)
}

/// 导航动作统一派发：校验 Session → 复用 `vd_nav`（不重实现 Android 导航）。
/// Back/Home 只作用于当前 Session 的 display；Recents 的能力限制仍在
/// `resolve_nav_target` 里执行（虚拟屏会拒绝并解释原因）。
pub fn dispatch_projection_action(
    session_id: &str,
    action: &str,
) -> AppResult<super::virtual_display::VdNav> {
    validate_projection_session(session_id)?;
    super::virtual_display::vd_nav(session_id.to_string(), action.to_string())
}

/// 投屏窗口身份回读（验收/诊断）：标题 + 大小图标 + AUMID 三项核实。
#[tauri::command]
pub fn vd_projection_identity(session_id: String) -> AppResult<ProjectionIdentityReport> {
    let binding = registry()
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound("投屏会话未绑定窗口，无法校验身份".into()))?;
    let session = process::manager().session(&session_id)?;
    let projection_type = if session.mode == "virtual" {
        ProjectionType::Virtual
    } else {
        ProjectionType::Mirror
    };
    let expected_title = build_projection_window_title(
        session.device_model.as_deref().unwrap_or("Android"),
        projection_type,
        session.app_label.as_deref(),
    );
    validate_projection_window_identity(binding.scrcpy_hwnd, &expected_title).map_err(AppError::from)
}

/// 导航动作派发命令（控制栏 → 后端统一入口，替代直连 vd_nav 的旧链路）。
#[tauri::command]
pub fn vd_projection_dispatch(
    session_id: String,
    action: String,
) -> AppResult<super::virtual_display::VdNav> {
    dispatch_projection_action(&session_id, &action)
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
/// 投屏窗口品牌身份回读报告（真机验收与诊断用）。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectionIdentityReport {
    pub title: String,
    pub title_matches: bool,
    pub icon_small_set: bool,
    pub icon_big_set: bool,
    pub aumid: Option<String>,
    pub aumid_matches: bool,
}

/// 设置窗口标题（统一经 [`build_projection_window_title`] 生成后调用）。
pub fn set_projection_window_title(
    hwnd: isize,
    title: &str,
) -> Result<(), ProjectionWindowError> {
    if !win::is_valid_window(hwnd) {
        return Err(ProjectionWindowError::InvalidWindow(
            "窗口句柄无效，无法设置标题".into(),
        ));
    }
    win::set_window_title(hwnd, title);
    Ok(())
}

/// 设置窗口任务栏身份（稳定 AUMID：`TaskDock.Projection`，与 session_id 无关）。
pub fn set_projection_taskbar_identity(hwnd: isize) -> Result<(), ProjectionWindowError> {
    set_projection_app_user_model_id(hwnd, "")
}

/// 回读并校验投屏窗口身份：标题、WM_SETICON 大小图标、AUMID 三项全部核实。
pub fn validate_projection_window_identity(
    hwnd: isize,
    expected_title: &str,
) -> Result<ProjectionIdentityReport, ProjectionWindowError> {
    if !win::is_valid_window(hwnd) {
        return Err(ProjectionWindowError::InvalidWindow(
            "窗口句柄无效，无法校验身份".into(),
        ));
    }
    let title = win::window_title(hwnd);
    let (small, big) = win::icon_handles(hwnd);
    let aumid = win::read_app_user_model_id(hwnd);
    Ok(ProjectionIdentityReport {
        title_matches: !expected_title.is_empty() && title == expected_title,
        icon_small_set: small != 0,
        icon_big_set: big != 0,
        aumid_matches: aumid.as_deref() == Some(PROJECTION_AUMID),
        title,
        aumid,
    })
}

/// 应用投屏窗口品牌身份（任务八/九统一入口）：标题 → 图标 → 任务栏身份 → 回读校验。
/// 图标/AUMID 部分失败只降级告警，不阻断投屏（标题已生效时其余失败可恢复）。
pub fn apply_projection_window_identity(
    hwnd: isize,
    session: &VdSession,
) -> Result<ProjectionIdentityReport, ProjectionWindowError> {
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
    set_projection_window_title(hwnd, &title)?;
    let mut failures: Vec<String> = Vec::new();
    if let Err(error) = set_projection_window_icon(hwnd) {
        failures.push(format!("图标：{error}"));
    }
    if let Err(error) = set_projection_taskbar_identity(hwnd) {
        failures.push(format!("AUMID：{error}"));
    }
    let report = validate_projection_window_identity(hwnd, &title)?;
    if failures.is_empty() {
        Ok(report)
    } else {
        // 标题已经生效时，图标/AUMID 失败只报告，不把整个品牌化判失败。
        tracing::warn!(
            session = %short_id(&session.id),
            "投屏窗口品牌化部分失败: {}",
            failures.join("；")
        );
        Ok(report)
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

/// 立即重算一体化布局（模式判定 / 窗口吸附 / 子窗口定位 / 模式广播）。
#[tauri::command]
pub fn vd_toolbar_update(session_id: String) -> AppResult<bool> {
    let Some(binding) = registry().get(&session_id) else {
        return Ok(false);
    };
    if binding.toolbar_hwnd == 0 || !registry().is_attached(&session_id) {
        return Ok(false);
    }
    update_projection_layout(&session_id)?;
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
    use super::{MonitorInfo, ProjectionWindowError, ProjectionWindowMode, WindowRect};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITORINFOEXW,
        MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::ExtractIconExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, EnumWindows, GetClientRect, GetParent, GetWindow,
        GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
        IsWindowVisible, IsZoomed, SendMessageW, SetParent, SetWindowLongW, SetWindowPos,
        SetWindowTextW, ShowWindowAsync, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, HICON, ICON_BIG,
        ICON_SMALL, LR_DEFAULTCOLOR, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_GETICON, WM_SETICON, WS_CAPTION,
        WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_CHILD,
        WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
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

    /// ClientRect 尺寸（物理 px；投屏窗口布局的输入口径）。
    pub fn client_size(hwnd: isize) -> Option<(i32, i32)> {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetClientRect(hwnd as HWND, &mut rect) } == 0 {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            None
        } else {
            Some((width, height))
        }
    }

    /// 当前父窗口（未挂载时为 None）。
    pub fn parent_of(hwnd: isize) -> Option<isize> {
        let parent = unsafe { GetParent(hwnd as HWND) };
        if parent.is_null() {
            None
        } else {
            Some(parent as isize)
        }
    }

    /// 把 TaskDock 控制栏窗口转成 scrcpy 窗口的 `WS_CHILD`（方案 A 核心）。
    ///
    /// 跨进程 `SetParent` 已在真机 PoC 验证：子窗口渲染、遮挡跟随、页面交互正常。
    /// 挂载前剥离 WS_EX_TOPMOST/NOACTIVATE 与 popup/caption/thickframe 样式，
    /// 否则「子窗口 + 置顶」的组合会重新制造 P0#2 的遮挡不一致。
    /// 失败时必须回滚样式，让调用方降级，不留半挂载状态。
    pub fn attach_as_child(child: isize, parent: isize) -> Result<(), ProjectionWindowError> {
        if !is_valid_window(child) || !is_valid_window(parent) {
            return Err(ProjectionWindowError::InvalidWindow(
                "挂载失败：窗口句柄无效".into(),
            ));
        }
        unsafe {
            let style = GetWindowLongW(child as HWND, GWL_STYLE);
            let ex_style = GetWindowLongW(child as HWND, GWL_EXSTYLE);
            // windows-sys 的样式常量是 u32，GetWindowLongW/SetWindowLongW 是 i32。
            let strip = (WS_POPUP
                | WS_CAPTION
                | WS_THICKFRAME
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX) as i32;
            let child_flags = (WS_CHILD | WS_VISIBLE) as i32;
            let ex_strip = (WS_EX_TOPMOST | WS_EX_NOACTIVATE) as i32;
            let next_style = (style & !strip) | child_flags;
            let next_ex = ex_style & !ex_strip;
            SetWindowLongW(child as HWND, GWL_STYLE, next_style);
            SetWindowLongW(child as HWND, GWL_EXSTYLE, next_ex);
            if SetParent(child as HWND, parent as HWND).is_null() {
                // 回滚样式，避免留下无父且无边框的孤儿窗口。
                SetWindowLongW(child as HWND, GWL_STYLE, style);
                SetWindowLongW(child as HWND, GWL_EXSTYLE, ex_style);
                return Err(ProjectionWindowError::InvalidWindow(
                    "SetParent 失败：控制栏无法挂载到投屏窗口".into(),
                ));
            }
            SetWindowPos(
                child as HWND,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
        Ok(())
    }

    /// 撤销 `attach_as_child`：仅用于 attach 失败回滚路径；正常生命周期直接销毁子窗口。
    pub fn detach_child(child: isize) {
        if !is_valid_window(child) {
            return;
        }
        unsafe {
            let style = GetWindowLongW(child as HWND, GWL_STYLE);
            SetWindowLongW(
                child as HWND,
                GWL_STYLE,
                (style & !(WS_CHILD as i32))
                    | (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU) as i32,
            );
            SetParent(child as HWND, std::ptr::null_mut());
        }
    }

    /// 窗口是否处于最大化。
    pub fn is_zoomed(hwnd: isize) -> bool {
        unsafe { IsZoomed(hwnd as HWND) != 0 }
    }

    /// 读取窗口标题（品牌化回读校验用）。
    pub fn window_title(hwnd: isize) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetWindowTextW(hwnd as HWND, buf.as_mut_ptr(), buf.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    /// 回读 WM_GETICON 设置的窗口图标句柄（small, big）；0 表示未设置。
    pub fn icon_handles(hwnd: isize) -> (isize, isize) {
        unsafe {
            let small = SendMessageW(hwnd as HWND, WM_GETICON, ICON_SMALL as usize, 0);
            let big = SendMessageW(hwnd as HWND, WM_GETICON, ICON_BIG as usize, 0);
            (small, big)
        }
    }

    /// 回读窗口级 AppUserModelID（任务栏身份校验用）。
    #[cfg(windows)]
    pub fn read_app_user_model_id(hwnd: isize) -> Option<String> {
        use windows::Win32::Foundation::HWND as WHWND;
        use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
        use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
        use windows::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::System::Variant::VT_LPWSTR;
        use windows::Win32::UI::Shell::PropertiesSystem::{
            IPropertyStore, SHGetPropertyStoreForWindow,
        };
        use windows::core::PCWSTR;

        struct ComGuard(bool);
        impl Drop for ComGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() };
                }
            }
        }
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let guard = ComGuard(hr.is_ok());
            let store: IPropertyStore =
                SHGetPropertyStoreForWindow(WHWND(hwnd as *mut core::ffi::c_void)).ok()?;
            let mut variant = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
            let value = if variant.Anonymous.Anonymous.vt == VT_LPWSTR {
                let ptr = variant.Anonymous.Anonymous.Anonymous.pwszVal;
                if ptr.is_null() {
                    None
                } else {
                    let wide = PCWSTR(ptr.as_ptr());
                    Some(wide.to_string().ok()?)
                }
            } else {
                None
            };
            let _ = PropVariantClear(&mut variant as *mut _);
            let _ = guard;
            value
        }
    }

    #[cfg(not(windows))]
    pub fn read_app_user_model_id(_hwnd: isize) -> Option<String> {
        None
    }

    /// 调整顶层窗口外框尺寸（保持位置与 Z 序；scrcpy 窗口宽度/高度吸附）。
    pub fn set_outer_size(hwnd: isize, width: i32, height: i32) -> bool {
        if !is_valid_window(hwnd) {
            return false;
        }
        unsafe {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                0,
                0,
                width,
                height,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            ) != 0
        }
    }

    /// 定位子窗口（父窗口 ClientRect 坐标，物理 px）。
    pub fn set_child_rect(hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> bool {
        if !is_valid_window(hwnd) {
            return false;
        }
        unsafe {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                x,
                y,
                w,
                h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            ) != 0
        }
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

    /// TaskDock 投屏窗口专用图标（随二进制内嵌，不依赖 exe 资源 ID 或当前工作目录）；
    /// 与主程序图标区分，源图见 icons/projection-1024.png。
    const TASKDOCK_ICON_ICO: &[u8] = include_bytes!("../../icons/projection.ico");

    /// 投屏窗口专属图标（任务八统一入口）：解析内嵌 `icons/projection.ico`
    /// 返回 (大图标, 小图标)。随二进制内嵌，不依赖 exe 资源 ID 或工作目录。
    pub fn get_projection_window_icon() -> Option<(HICON, HICON)> {
        embedded_icons()
    }

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
            // SHStrDupW 用 CoTaskMemAlloc 复制字符串，所有权交给本地 PROPVARIANT，
            // 由 PropVariantClear 统一释放（不能用 Rust 堆内存，否则属性系统按
            // CoTaskMemFree 清理时会破坏堆）。
            let memory = SHStrDupW(PCWSTR(wide.as_ptr()))
                .map_err(|error| format!("复制 AUMID 失败：{error}"))?;
            // 直接构造 PROPVARIANT，避免对 ManuallyDrop 联合字段做 DerefMut 赋值。
            let inner = PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { pwszVal: memory },
            };
            let mut variant = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: std::mem::ManuallyDrop::new(inner),
                },
            };
            // SetValue 契约上复制值；Commit 完成后再清理本地字符串，避免存储
            // 内部仍引用该指针时被提前释放（曾触发 0xc0000374 堆损坏）。
            let result = store.SetValue(&PKEY_AppUserModel_ID, &variant);
            let committed = result.and_then(|()| store.Commit());
            let _ = PropVariantClear(&mut variant);
            committed.map_err(|error| format!("写入 AUMID 失败：{error}"))?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod win {
    use super::{MonitorInfo, ProjectionWindowError, ProjectionWindowMode, WindowRect};

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
    pub fn client_size(_hwnd: isize) -> Option<(i32, i32)> {
        None
    }
    pub fn parent_of(_hwnd: isize) -> Option<isize> {
        None
    }
    pub fn attach_as_child(
        _child: isize,
        _parent: isize,
    ) -> Result<(), ProjectionWindowError> {
        Err(ProjectionWindowError::Unsupported)
    }
    pub fn detach_child(_child: isize) {}
    pub fn is_zoomed(_hwnd: isize) -> bool {
        false
    }
    pub fn set_outer_size(_hwnd: isize, _width: i32, _height: i32) -> bool {
        false
    }
    pub fn set_child_rect(_hwnd: isize, _x: i32, _y: i32, _w: i32, _h: i32) -> bool {
        false
    }
    pub fn window_title(_hwnd: isize) -> String {
        String::new()
    }
    pub fn icon_handles(_hwnd: isize) -> (isize, isize) {
        (0, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::projection_layout::{
        bottom_client_height, nav_webview_physical, side_client_width,
    };

    fn binding(session_id: &str, scrcpy: isize, toolbar: isize) -> ProjectionWindowBinding {
        ProjectionWindowBinding {
            session_id: session_id.into(),
            scrcpy_hwnd: scrcpy,
            toolbar_hwnd: toolbar,
            monitor_id: String::new(),
            dpi: 96,
            mode: ProjectionWindowMode::Normal,
            toolbar_locked: false,
        }
    }

    fn portrait_video() -> LayoutSize {
        LayoutSize { w: 1080.0, h: 2400.0 }
    }

    #[test]
    fn session_toolbar_binding_uses_session_key() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        registry.insert_binding(binding("session-a", 0x100, 0x200));
        assert_eq!(registry.toolbar_hwnd("session-a"), Some(0x200));
        assert_eq!(registry.scrcpy_hwnd("session-a"), Some(0x100));
        assert!(registry.toolbar_hwnd("session-b").is_none());
    }

    #[test]
    fn session_toolbar_isolation_keeps_two_sessions_apart() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        registry.insert_binding(binding("a", 0x10, 0x20));
        registry.insert_binding(binding("b", 0x30, 0x40));
        registry.remove("a");
        assert_eq!(registry.toolbar_hwnd("b"), Some(0x40));
        assert!(registry.toolbar_hwnd("a").is_none());
    }

    #[test]
    fn destroy_toolbar_is_idempotent() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        registry.insert_binding(binding("idempotent", 0x1, 0));
        assert!(registry.cleanup("idempotent"));
        assert!(!registry.cleanup("idempotent"));
    }

    #[test]
    fn resolve_session_by_hwnd_matches_scrcpy_or_toolbar() {
        let registry = ProjectionWindowRegistry {
            map: Mutex::new(HashMap::new()),
        };
        registry.insert_binding(binding("by-hwnd", 0xAAA, 0xBBB));
        assert_eq!(
            registry.resolve_session_by_hwnd(0xAAA).as_deref(),
            Some("by-hwnd")
        );
        assert_eq!(
            registry.resolve_session_by_hwnd(0xBBB).as_deref(),
            Some("by-hwnd")
        );
        assert!(registry.resolve_session_by_hwnd(0xCCC).is_none());
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
    fn decide_update_snaps_side_width_on_first_attach_and_rotation() {
        // scrcpy 初始/旋转后客户区 == 视频纵横比（无余量）→ Side 需要扩宽。
        let client = LayoutSize { w: 577.0, h: 1282.0 };
        let (mode, target) =
            decide_projection_update(client, portrait_video(), 120, false, Some(4000.0), Some(2000.0));
        assert_eq!(mode, ProjectionLayoutMode::Side);
        let needed = side_client_width(portrait_video(), client.h, 120);
        assert!((target.w - needed).abs() < 0.5, "target={}", target.w);
        assert!((target.h - client.h).abs() < 0.5, "高度保留用户值");
    }

    #[test]
    fn decide_update_keeps_side_without_resize_after_snap() {
        let client_h = 1282.0;
        let snapped_w = side_client_width(portrait_video(), client_h, 120);
        let client = LayoutSize { w: snapped_w, h: client_h };
        let (mode, target) =
            decide_projection_update(client, portrait_video(), 120, false, Some(4000.0), Some(2000.0));
        assert_eq!(mode, ProjectionLayoutMode::Side);
        assert!((target.w - client.w).abs() <= 2.0, "已吸附宽度不再抖动");
        assert!((target.h - client.h).abs() < 0.5);
    }

    #[test]
    fn decide_update_switches_to_bottom_when_width_shrinks() {
        // 宽度不足以放 Side → Bottom：高度吸附到「视频高 + 2×底部条带」。
        let client = LayoutSize { w: 620.0, h: 900.0 };
        let (mode, target) =
            decide_projection_update(client, portrait_video(), 120, false, Some(700.0), Some(4000.0));
        assert_eq!(mode, ProjectionLayoutMode::Bottom);
        let needed_h = bottom_client_height(portrait_video(), client.w, 120);
        assert!((target.h - needed_h).abs() < 0.5, "target={}", target.h);
        assert!((target.w - client.w).abs() < 0.5);
    }

    #[test]
    fn decide_update_compact_when_height_capped() {
        let client = LayoutSize { w: 620.0, h: 900.0 };
        let needed_h = bottom_client_height(portrait_video(), client.w, 120);
        let (mode, target) = decide_projection_update(
            client,
            portrait_video(),
            120,
            false,
            Some(700.0),
            Some(needed_h - 1.0),
        );
        assert_eq!(mode, ProjectionLayoutMode::Compact);
        assert!((target.w - client.w).abs() < 0.5 && (target.h - client.h).abs() < 0.5);
    }

    #[test]
    fn decide_update_respects_os_managed_window() {
        // 最大化/全屏：不吸附，模式固定 Side，尺寸原样返回。
        let client = LayoutSize { w: 2560.0, h: 1300.0 };
        let (mode, target) =
            decide_projection_update(client, portrait_video(), 120, true, Some(2560.0), Some(1300.0));
        assert_eq!(mode, ProjectionLayoutMode::Side);
        assert!((target.w - client.w).abs() < 0.5 && (target.h - client.h).abs() < 0.5);
    }

    #[test]
    fn side_target_fits_nav_webview_budget() {
        // Side 吸附宽度 = 视频宽 + 2×导航 WebView（含 Tooltip 溢出区），
        // 导航子窗口有容身之处且不挤压视频。
        let client_h = 1282.0;
        let needed = side_client_width(portrait_video(), client_h, 120);
        let video_w = client_h * (1080.0 / 2400.0);
        let spare = needed - video_w;
        let webview = nav_webview_physical(120);
        assert!((spare - 2.0 * webview).abs() < 0.5, "spare={spare} webview={webview}");
    }

    #[test]
    fn projection_layout_cache_tracks_outer_changes() {
        let mut cache = LayoutCache::default();
        assert!(cache.outer_changed((1000, 1400)), "首次观察视为变化");
        assert!(!cache.outer_changed((1000, 1400)), "相同尺寸不算变化");
        assert!(cache.outer_changed((1000, 1300)), "尺寸变化要上报");
    }
}
