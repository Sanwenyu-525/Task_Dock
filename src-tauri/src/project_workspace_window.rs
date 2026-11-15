//! 项目工作空间独立窗口（v49）。
//!
//! 与主窗口、桌面微件的边界：
//! - 单一窗口（label = `workspace`），**无原生装饰**、任务栏可见、可缩放/最大化、
//!   非置顶；标题栏由 `WorkbenchShell` 顶栏自绘（拖动区 + 最小化/最大化/关闭），
//!   关闭只销毁自身，不影响胶囊/托盘/主窗口；
//! - 不挂载主窗口的 `App.tsx`，只加载 `workspace.html`，不启动贴边吸附、通知调度
//!   与主窗口轮询；能力集由 `capabilities/workspace.json` 隔离；
//! - 几何按**物理像素**持久化到内部设置键 `workspace_window_rect`（不进入前端
//!   `Settings` 快照）；恢复时收敛到目标显示器工作区，显示器消失时回落到主屏；
//! - 最大化状态单独记忆：最大化期间不覆盖正常几何，下次打开仍可还原窗口大小。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use rusqlite::OptionalExtension;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::commands::settings::is_rect_mostly_visible;
use crate::commands::settings::WindowRect;
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const WINDOW_LABEL: &str = "workspace";
pub const EVENT_WINDOW_CLOSED: &str = "project-workspace-window-closed";
/// 启动/重复启动路径打开工作台失败：主窗口据此展示可恢复的错误提示。
/// 事件已显示主窗口只是兜底，不能让用户以为「启动成功但仍看到旧面板」。
pub const EVENT_STARTUP_FAILED: &str = "workbench-startup-failed";
pub const EVENT_OPEN_DEV_WORKBENCH: &str = "project-workspace-open-dev-workbench";
/// 主窗口 → 工作空间窗口：本次「打开开发工作台」事务的**真实结果**回执。
/// 事件已发送不等于用户看到了开发工作台（主窗口可能仍在胶囊里），
/// 因此必须由主窗口在解除停靠、切页完成后再回传结果。
pub const EVENT_OPEN_DEV_WORKBENCH_RESULT: &str =
    "project-workspace-open-dev-workbench-result";

/// 跨窗口请求序号：工作空间窗口发起，主窗口回执时带回同一个 id，
/// 迟到的重复回执按 id 去重（不与后来的请求混淆）。
static DEV_WORKBENCH_REQ_ID: AtomicI64 = AtomicI64::new(1);

/// 分配下一个跨窗口请求序号（单调递增；迟到回执靠它去重）。
fn next_dev_workbench_request_id() -> i64 {
    DEV_WORKBENCH_REQ_ID.fetch_add(1, Ordering::SeqCst)
}

// ── 工作台窗口外形（独立于主窗/胶囊的状态）──────────────────────────────
//
// 与 `window_shape` 的关系：区域算法、DPI 换算、缓存与回读全部复用
// `apply_with_radius`（ShapeTarget::Popup），**不读也不写**主窗的全局半径、
// 胶囊参数与 blank 状态；`window_shape` 的区域缓存按 hwnd 隔离，工作台
// 销毁时用 `forget_window(hwnd)` 清掉自己那一份，不会命中复用句柄的旧缓存。
//
// 本模块只额外维护两样工作台专属状态：
// 1. 逻辑半径（由前端按视觉预设下发，与 CSS `--radius-window` 同源）；
// 2. 最近一次已应用的几何指纹（半径/尺寸/DPI/最大化），参数没变就不重复
//    调 SetWindowRgn（尺寸拖动时事件密集，避免逐帧重建区域）。
static WORKBENCH_RADIUS_MILLI: AtomicU32 = AtomicU32::new(18_000);
/// 角部曲线指数 ×1000：2 = 圆弧（默认，兼容口径），4 = 与 CSS
/// `corner-shape: superellipse(4)` 对齐的连续圆角。由前端在确认 WebView2 支持后下发；
/// 未下发时保持 2，绝不单方面把窗口切成超椭圆（会与 CSS 弧错位露白）。
static WORKBENCH_CORNER_MILLI: AtomicU32 = AtomicU32::new(2_000);
static WORKBENCH_FRAME_KEY: AtomicU64 = AtomicU64::new(0);

/// 半径合法性：NaN/无穷回落默认预设值，其余夹到 0–40（与 `set_radius` 同口径）。
fn clamp_workbench_radius(radius: f64) -> f64 {
    if radius.is_finite() {
        radius.clamp(0.0, 40.0)
    } else {
        18.0
    }
}

fn workbench_radius() -> f64 {
    WORKBENCH_RADIUS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0
}

/// 角部曲线指数（2 = 圆弧，4 = 连续圆角）；非法值按 2 处理，理由同常量注释。
fn workbench_corner() -> f64 {
    let milli = WORKBENCH_CORNER_MILLI.load(Ordering::Relaxed);
    let exponent = f64::from(milli) / 1000.0;
    if exponent.is_finite() {
        exponent.clamp(2.0, 6.0)
    } else {
        2.0
    }
}

/// 窗口销毁时清空几何指纹（HWND 复用不会命中上一轮的「参数没变」判定）。
fn reset_workbench_frame_state() {
    WORKBENCH_FRAME_KEY.store(0, Ordering::Relaxed);
    // 曲线回落圆弧：新窗口在收到前端能力检测结果前按圆弧裁剪，绝不单方面超椭圆。
    WORKBENCH_CORNER_MILLI.store(2_000, Ordering::Relaxed);
}

/// 有效半径：最大化时 0（窗口必须铺满显示器工作区，圆角会在屏幕边缘留缝隙）。
fn effective_workbench_radius(radius: f64, maximized: bool) -> f64 {
    if maximized { 0.0 } else { radius }
}

/// 几何指纹：同一窗口在半径/尺寸/DPI/最大化状态/角部曲线都没变时返回同一个值。
fn frame_key(radius: f64, width: u32, height: u32, scale: f64, maximized: bool) -> u64 {
    frame_key_with_corner(radius, 2.0, width, height, scale, maximized)
}

/// 带角部曲线的几何指纹。bit61 记录「是否连续圆角」：切换曲线必须重建区域，
/// 否则会保留上一形态的支撑像素（圆角与超椭圆在角部相差 8–9 物理像素）。
fn frame_key_with_corner(
    radius: f64,
    corner: f64,
    width: u32,
    height: u32,
    scale: f64,
    maximized: bool,
) -> u64 {
    let radius_milli = (radius * 1000.0).round().clamp(0.0, 40_000.0) as u64;
    let scale_milli = if scale.is_finite() && scale > 0.0 {
        (scale * 1000.0).round() as u64
    } else {
        1000
    };
    let squircle = (corner.is_finite() && corner > 2.5) as u64;
    (radius_milli & 0xFFFF)
        | ((width as u64 & 0xFFFF) << 16)
        | ((height as u64 & 0xFFFF) << 32)
        | ((scale_milli & 0xFFF) << 48)
        | ((maximized as u64) << 60)
        | (squircle << 61)
}


// ── 统一工作台导航协议（U0）────────────────────────────────────────────
//
// 「打开工作台并导航到某功能」不能只发一个事件就宣称成功：
// 1. 窗口可能尚未创建（事件没有接收方）；
// 2. 窗口刚创建时 React 可能还没注册监听（事件被丢弃）；
// 3. 工作台内有未保存草稿时目标导航可能被门禁拦下。
//
// 因此协议是**排队 + 拉取 + 回执**：
// - Rust 把导航请求放进队列，并（窗口存在时）同时推一条事件作为快路径；
// - 工作台挂载时、以及收到事件时都调用 `workbench_take_nav` 拉取队列（去重）；
// - 工作台完成路由（或被门禁拦下）后调用 `workbench_nav_ack` 回传真实状态，
//   主窗口调用方只认回执，不认「invoke 返回成功」。

pub const EVENT_WORKBENCH_NAVIGATE: &str = "workbench-navigate";
pub const EVENT_WORKBENCH_NAV_ACK: &str = "workbench-nav-ack";

/// 工作台可路由的稳定功能 ID（与前端 `Tab` + 工作台首页一致）。
/// 只做白名单校验：未知目标直接拒绝，不允许任意字符串进入窗口路由。
const WORKBENCH_TABS: &[&str] = &[
    "home",
    "workbench",
    "workspace",
    "tasks",
    "agents",
    "apps",
    "widgets",
    "actions",
    "clipboard",
    "mobile",
    "inbox",
    "shelf",
    "workflows",
    "history",
    "roadmap",
    "settings",
    "help",
    "diagnostics",
    "resource",
];

/// 结构化导航目标：功能 + 可选上下文（项目/任务/对象/子页）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchNavTarget {
    pub tab: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub object_id: Option<String>,
    #[serde(default)]
    pub sub: Option<String>,
}

impl Default for WorkbenchNavTarget {
    fn default() -> Self {
        Self {
            tab: "home".to_string(),
            project_id: None,
            task_id: None,
            object_id: None,
            sub: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchNavRequest {
    pub request_id: i64,
    pub target: WorkbenchNavTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchNavAckEvent {
    pub request_id: i64,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchOpenResult {
    pub request_id: i64,
    pub created: bool,
}

#[derive(Debug, Clone)]
struct AwaitingWorkbenchNav {
    request: WorkbenchNavRequest,
    since: Instant,
}

#[derive(Debug, Clone, Copy)]
struct TerminalWorkbenchNav {
    request_id: i64,
    at: Instant,
}

/// 导航请求生命周期（Rust 侧权威状态）：
/// - `pending`：待交付（队首会重复交付，页面重载不丢请求）；
/// - `awaiting`：已交付且已回 `pending`，等用户确认；移出交付队列，后续请求可继续推进；
/// - `terminal`：已收敛到 succeeded / cancelled / failed；同号重复/迟到回执只处理一次。
#[derive(Default)]
struct WorkbenchNavQueue {
    pending: VecDeque<WorkbenchNavRequest>,
    awaiting: HashMap<i64, AwaitingWorkbenchNav>,
    terminal: VecDeque<TerminalWorkbenchNav>,
    last_request_id: i64,
}

static WORKBENCH_NAV: LazyLock<Mutex<WorkbenchNavQueue>> =
    LazyLock::new(|| Mutex::new(WorkbenchNavQueue::default()));

const WORKBENCH_NAV_QUEUE_MAX: usize = 8;
/// `pending`（等待用户确认）超过该时长仍未收到最终回执：按失效清理，避免永久悬挂。
/// 前端 `openWorkbench().settled` 使用更长的超时，保证这里先清理、前端再如实报超时。
const WORKBENCH_NAV_AWAIT_TIMEOUT: Duration = Duration::from_secs(300);
/// 终态编号保留窗口：重复/迟到回执在此窗口内幂等忽略。
const WORKBENCH_NAV_TERMINAL_TTL: Duration = Duration::from_secs(600);
const WORKBENCH_NAV_TERMINAL_MAX: usize = 64;

fn normalize_optional_field(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    let Some(raw) = value else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 128 {
        return Err(AppError::Validation(format!("{field} 过长")));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::Validation(format!("{field} 含非法控制字符")));
    }
    Ok(Some(trimmed.to_string()))
}

/// 归一化并校验导航目标：未知 tab 直接拒绝（不猜测、不静默改路由）。
pub fn normalize_workbench_target(
    target: Option<WorkbenchNavTarget>,
) -> AppResult<WorkbenchNavTarget> {
    let mut target = target.unwrap_or_default();
    let tab = target.tab.trim().to_string();
    if !WORKBENCH_TABS.contains(&tab.as_str()) {
        return Err(AppError::Validation(format!(
            "未知的工作台导航目标: {tab}（允许: {}）",
            WORKBENCH_TABS.join(", ")
        )));
    }
    target.tab = tab;
    target.project_id = normalize_optional_field(target.project_id, "projectId")?;
    target.task_id = normalize_optional_field(target.task_id, "taskId")?;
    target.object_id = normalize_optional_field(target.object_id, "objectId")?;
    target.sub = normalize_optional_field(target.sub, "sub")?;
    Ok(target)
}

/// 清理超时的 awaiting 请求，并维护终态去重窗口。返回本次失效的请求编号。
/// 调用方负责把失效结果以 `failed` 回执广播给主窗口（没有接收方时静默）。
fn prune_workbench_nav_locked(
    queue: &mut WorkbenchNavQueue,
    now: Instant,
) -> Vec<i64> {
    let mut expired = Vec::new();
    queue.awaiting.retain(|id, item| {
        if now.saturating_duration_since(item.since) > WORKBENCH_NAV_AWAIT_TIMEOUT {
            expired.push(*id);
            false
        } else {
            true
        }
    });
    for id in &expired {
        queue.terminal.push_back(TerminalWorkbenchNav {
            request_id: *id,
            at: now,
        });
    }
    while let Some(front) = queue.terminal.front() {
        if now.saturating_duration_since(front.at) > WORKBENCH_NAV_TERMINAL_TTL
            || queue.terminal.len() > WORKBENCH_NAV_TERMINAL_MAX
        {
            queue.terminal.pop_front();
        } else {
            break;
        }
    }
    expired
}

fn nav_request_known(queue: &WorkbenchNavQueue, request_id: i64) -> bool {
    queue.pending.iter().any(|req| req.request_id == request_id)
        || queue.awaiting.contains_key(&request_id)
        || queue
            .terminal
            .iter()
            .any(|item| item.request_id == request_id)
}

/// 入队并返回（新请求, 被容量淘汰的最旧请求）。淘汰只发生在未交付队列：
/// `awaiting` 已让出队首，不会阻塞新导航。
fn enqueue_workbench_nav_inner(
    target: WorkbenchNavTarget,
    request_id: Option<i64>,
) -> AppResult<(WorkbenchNavRequest, Option<WorkbenchNavRequest>)> {
    let mut queue = WORKBENCH_NAV
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_workbench_nav_locked(&mut queue, Instant::now());
    let id = match request_id {
        Some(id) => {
            if id <= 0 {
                return Err(AppError::Validation(
                    "导航请求编号必须为正整数".to_string(),
                ));
            }
            if nav_request_known(&queue, id) {
                return Err(AppError::Validation(format!(
                    "导航请求编号重复: {id}"
                )));
            }
            // 调用方在发命令之前已登记回执：编号必须原样使用，不能改成新号，
            // 否则早到的回执会因编号不匹配被丢弃（假超时）。
            queue.last_request_id = queue.last_request_id.max(id);
            id
        }
        None => {
            queue.last_request_id += 1;
            queue.last_request_id
        }
    };
    let request = WorkbenchNavRequest {
        request_id: id,
        target,
    };
    // 队列满时淘汰最旧的未交付请求：新目标优先；被淘汰的调用方由主窗口按失败收敛。
    let evicted = if queue.pending.len() >= WORKBENCH_NAV_QUEUE_MAX {
        queue.pending.pop_front()
    } else {
        None
    };
    queue.pending.push_back(request.clone());
    Ok((request, evicted))
}

fn enqueue_workbench_nav(
    target: WorkbenchNavTarget,
    request_id: Option<i64>,
) -> AppResult<WorkbenchNavRequest> {
    Ok(enqueue_workbench_nav_inner(target, request_id)?.0)
}

/// 读取队首并清理超时 awaiting。只**读取**、不弹出：工作台可能因 StrictMode
/// 双执行/页面重载在拉取后立即销毁，弹出的请求会随之丢失。请求只在
/// `workbench_nav_ack` 回执后移出；工作台按 requestId 去重，重复拉取不会重复执行。
fn take_pending_workbench_nav_with_expired() -> (Option<WorkbenchNavRequest>, Vec<i64>) {
    let mut queue = WORKBENCH_NAV
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let expired = prune_workbench_nav_locked(&mut queue, Instant::now());
    (queue.pending.front().cloned(), expired)
}

fn take_pending_workbench_nav() -> Option<WorkbenchNavRequest> {
    take_pending_workbench_nav_with_expired().0
}

/// 回执后移除同号请求（含已进入 awaiting 的请求）。
fn clear_pending_workbench_nav(request_id: i64) {
    if let Ok(mut queue) = WORKBENCH_NAV.lock() {
        queue.pending.retain(|req| req.request_id != request_id);
        queue.awaiting.remove(&request_id);
    }
}

/// 应用一次回执。返回 `(是否广播, 本次超时失效的编号)`。
///
/// - `pending`：把请求从交付队列移入 awaiting；后续请求可继续推进。
/// - 终态：移出 pending/awaiting 并登记 terminal；同号重复回执不再广播。
fn apply_workbench_nav_ack_locked(
    queue: &mut WorkbenchNavQueue,
    request_id: i64,
    status: &str,
    now: Instant,
) -> (bool, Vec<i64>) {
    let expired = prune_workbench_nav_locked(queue, now);
    let already_terminal = queue
        .terminal
        .iter()
        .any(|item| item.request_id == request_id);
    if status == ACK_STATUS_PENDING {
        if already_terminal {
            return (false, expired);
        }
        if let Some(position) = queue
            .pending
            .iter()
            .position(|req| req.request_id == request_id)
        {
            let request = queue
                .pending
                .remove(position)
                .expect("position came from iter");
            queue.awaiting.insert(
                request_id,
                AwaitingWorkbenchNav {
                    request,
                    since: now,
                },
            );
        }
        // awaiting 已存在（重复 pending）或编号未知：仍广播。重复状态对前端幂等，
        // 而事件丢失时重复回执是唯一的恢复手段；生命周期不被改变。
        return (true, expired);
    }

    if already_terminal {
        return (false, expired);
    }
    queue.pending.retain(|req| req.request_id != request_id);
    queue.awaiting.remove(&request_id);
    queue.terminal.push_back(TerminalWorkbenchNav {
        request_id,
        at: now,
    });
    (true, expired)
}

/// 清空并返回所有未终结请求：窗口销毁时逐个以 `cancelled` 收敛，调用方不会
/// 永久停在 pending。测试也用它验证队列彻底清空。
fn drain_workbench_nav_requests() -> Vec<WorkbenchNavRequest> {
    let mut queue = WORKBENCH_NAV
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut requests: Vec<WorkbenchNavRequest> = queue.pending.drain(..).collect();
    requests.extend(queue.awaiting.drain().map(|(_, item)| item.request));
    queue.terminal.clear();
    requests
}

fn clear_workbench_nav_queue() {
    drop(drain_workbench_nav_requests());
}

/// 广播导航回执；主窗口不存在时忽略（没有接收方不是错误）。
fn emit_nav_ack_event(
    app: &AppHandle,
    request_id: i64,
    status: &str,
    error: Option<String>,
) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.emit(
            EVENT_WORKBENCH_NAV_ACK,
            WorkbenchNavAckEvent {
                request_id,
                status: status.to_string(),
                error,
            },
        );
    }
}

const SETTING_RECT: &str = "workspace_window_rect";
const MAIN_LABEL: &str = "main";
const DEFAULT_WIDTH: f64 = 1180.0;
const DEFAULT_HEIGHT: f64 = 760.0;
const MIN_WIDTH: f64 = 880.0;
const MIN_HEIGHT: f64 = 600.0;
const EDGE_MARGIN: i32 = 24;
const SAVE_THROTTLE: Duration = Duration::from_millis(500);

/// 启动揭示超时：窗口在启动时**隐藏创建**，等前端首帧就绪（`workbench_ui_ready`）
/// 后才 show，避免用户先看到空白窗口。开发态 Vite 冷加载可能 3–6s，因此超时给到
/// 8s；超时仍强制显示并写诊断，保证应用不会「无窗口、无反馈」。
const STARTUP_REVEAL_TIMEOUT: Duration = Duration::from_secs(8);

/// 启动揭示待办：仅启动路径置位，由工作台前端的 `workbench_ui_ready` 消费。
static STARTUP_REVEAL: AtomicBool = AtomicBool::new(false);

/// 待兑现的最大化：几何恢复时为 `maximized=true`，但**必须等窗口可见后再最大化**。
/// 在隐藏窗口上最大化会让 Windows 把「还原矩形」记成窗口创建时的默认级联位置，
/// 之后点还原会跳到屏幕中间而不是用户保存的位置（真机复现过 370,130 → 160,130）。
static STARTUP_MAXIMIZE: AtomicBool = AtomicBool::new(false);

/// 创建/聚焦串行化：启动、快捷入口、托盘与第二实例可能并发到达。
/// Tauri 对重复 label 会直接报错，这里先串行再二次检查，保证「工作台唯一」。
static OPEN_LOCK: Mutex<()> = Mutex::new(());

/// 新建窗口后何时显示：手动打开立刻显示（用户已经点了按钮，空白等待不可接受）；
/// 启动路径等前端首帧就绪后再显示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenReveal {
    Immediate,
    WhenReady,
}

/// 窗口几何（物理像素）。`maximized` 与正常矩形一起保存，恢复时先还原矩形再最大化。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct WorkspaceGeometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    #[serde(default)]
    maximized: bool,
}

impl WorkspaceGeometry {
    fn to_window_rect(self) -> WindowRect {
        WindowRect {
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct WorkArea {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl WorkArea {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let rect = monitor.work_area();
        Self {
            x: rect.position.x,
            y: rect.position.y,
            width: rect.size.width as i32,
            height: rect.size.height as i32,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWindowInfo {
    pub opened: bool,
    pub project_id: Option<String>,
    /// 旧入口适配器生成的导航编号；调用方等待 `workbench-nav-ack` 时必须用它，
    /// `opened=true` 只代表窗口已打开/聚焦，不代表目标项目导航已生效。
    pub request_id: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenDevWorkbenchEvent {
    pub request_id: i64,
    pub dev_project_id: String,
}

/// 「在开发工作台打开」的受理结果：`requestId` 用于等待主窗口回执。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDevWorkbenchRequest {
    pub request_id: i64,
    pub dev_project_id: String,
}

/// 回执的最终状态。
///
/// `pending` **不是终态**：主窗口被未保存草稿拦截后先回 pending，用户确认/取消
/// 之后必须再回一条 `succeeded` / `cancelled`；否则工作空间窗口只能一直等。
pub const ACK_STATUS_PENDING: &str = "pending";
pub const ACK_STATUS_SUCCEEDED: &str = "succeeded";
pub const ACK_STATUS_CANCELLED: &str = "cancelled";
pub const ACK_STATUS_FAILED: &str = "failed";

/// 主窗口回执载荷：`ok=false` 时必须带可读原因；`pending=true` 表示被未保存
/// 草稿拦截、等用户确认（不是失败，也不是成功）。
///
/// `status` 是权威字段（旧字段 `ok`/`pending` 保留给旧窗口兼容）：
/// `succeeded` / `pending` / `cancelled` / `failed`。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenDevWorkbenchAckEvent {
    pub request_id: i64,
    pub ok: bool,
    pub pending: bool,
    pub status: String,
    pub error: Option<String>,
}

/// 规整调用方传入的状态：非法值直接拒绝，避免「未知状态」被当成成功。
fn normalize_ack_status(ok: bool, pending: bool, status: Option<&str>) -> AppResult<String> {
    let status = match status.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => {
            if pending {
                ACK_STATUS_PENDING.to_string()
            } else if ok {
                ACK_STATUS_SUCCEEDED.to_string()
            } else {
                ACK_STATUS_FAILED.to_string()
            }
        }
    };
    match status.as_str() {
        ACK_STATUS_PENDING | ACK_STATUS_SUCCEEDED | ACK_STATUS_CANCELLED | ACK_STATUS_FAILED => {
            Ok(status)
        }
        other => Err(AppError::Validation(format!(
            "未知的导航回执状态: {other}"
        ))),
    }
}

static LAST_GEOMETRY_SAVE: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

fn assert_main_or_workspace(window: &WebviewWindow) -> AppResult<()> {
    match window.label() {
        MAIN_LABEL | WINDOW_LABEL => Ok(()),
        _ => Err(AppError::Validation(
            "该命令仅限主窗口或工作空间窗口调用".to_string(),
        )),
    }
}

fn read_geometry(db: &Db) -> Option<WorkspaceGeometry> {
    db.get_setting(SETTING_RECT)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// 选择恢复目标：优先与保存矩形交集最大的显示器；完全不可见时回落到主显示器，
/// 再退到任意显示器。返回工作区与显示器物理边界（用于可见性判定）。
fn pick_restore_area(
    app: &AppHandle,
    rect: &WorkspaceGeometry,
) -> Option<(WorkArea, Vec<(i32, i32, u32, u32)>)> {
    let monitors = app.available_monitors().ok().unwrap_or_default();
    if monitors.is_empty() {
        return None;
    }
    let bounds: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    let mostly_visible = is_rect_mostly_visible(&rect.to_window_rect(), &bounds);
    let target = if mostly_visible {
        monitors
            .iter()
            .max_by(|a, b| {
                visible_area(rect, a)
                    .partial_cmp(&visible_area(rect, b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned()
    } else {
        app.primary_monitor().ok().flatten()
    };
    let target = target.or_else(|| monitors.into_iter().next())?;
    Some((WorkArea::from_monitor(&target), bounds))
}

fn visible_area(rect: &WorkspaceGeometry, monitor: &tauri::Monitor) -> f64 {
    let m = monitor.size();
    let p = monitor.position();
    let ix0 = rect.x.max(p.x);
    let iy0 = rect.y.max(p.y);
    let ix1 = (rect.x + rect.w as i32).min(p.x + m.width as i32);
    let iy1 = (rect.y + rect.h as i32).min(p.y + m.height as i32);
    ((ix1 - ix0).max(0) as f64) * ((iy1 - iy0).max(0) as f64)
}

/// 把保存几何收敛进工作区：尺寸不超过工作区（留边），位置不越界。
fn clamp_into_area(area: WorkArea, rect: WorkspaceGeometry) -> (PhysicalSize<u32>, PhysicalPosition<i32>) {
    let max_w = (area.width - EDGE_MARGIN * 2).max(MIN_WIDTH as i32);
    let max_h = (area.height - EDGE_MARGIN * 2).max(MIN_HEIGHT as i32);
    let w = (rect.w as i32).clamp(MIN_WIDTH as i32, max_w);
    let h = (rect.h as i32).clamp(MIN_HEIGHT as i32, max_h);
    let max_x = area.x + (area.width - w).max(0);
    let max_y = area.y + (area.height - h).max(0);
    let x = rect.x.clamp(area.x, max_x);
    let y = rect.y.clamp(area.y, max_y);
    (PhysicalSize::new(w as u32, h as u32), PhysicalPosition::new(x, y))
}

fn restore_geometry(app: &AppHandle, win: &WebviewWindow, db: &Db) {
    let Some(saved) = read_geometry(db) else {
        // 首次打开：默认尺寸居中（仅在没有保存几何时执行，避免覆盖用户摆放）。
        let _ = win.set_size(PhysicalSize::new(DEFAULT_WIDTH as u32, DEFAULT_HEIGHT as u32));
        let _ = win.center();
        return;
    };
    let Some((area, bounds)) = pick_restore_area(app, &saved) else {
        return;
    };
    // 保存值在双屏切换/缩放下可能部分越界：仍收敛到目标工作区。
    let mostly_visible = is_rect_mostly_visible(&saved.to_window_rect(), &bounds);
    let target = if mostly_visible {
        saved
    } else {
        // 完全屏外：保持尺寸但放到主屏工作区左上角（不把窗口丢到用户找不到的位置）。
        WorkspaceGeometry {
            x: area.x + EDGE_MARGIN,
            y: area.y + EDGE_MARGIN,
            w: saved.w,
            h: saved.h,
            maximized: saved.maximized,
        }
    };
    let (size, position) = clamp_into_area(area, target);
    if let Err(error) = win.set_size(size) {
        tracing::warn!("恢复工作空间窗口尺寸失败: {error}");
    }
    if let Err(error) = win.set_position(position) {
        tracing::warn!("恢复工作空间窗口位置失败: {error}");
    }
    // 最大化不在隐藏窗口上直接调用：见 `STARTUP_MAXIMIZE` 的注释。
    // 兑现点在 `reveal_workbench`（窗口 show 之后）。
    STARTUP_MAXIMIZE.store(saved.maximized, Ordering::SeqCst);
}

fn geometry_from_window(win: &WebviewWindow) -> Option<WorkspaceGeometry> {
    let position = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(WorkspaceGeometry {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
        maximized: win.is_maximized().unwrap_or(false),
    })
}

/// 保存几何：最大化时只更新标记，不覆盖正常矩形；`force=false` 按 500ms 节流，
/// 避免拖动/缩放期间每一帧都写库。
fn save_geometry(app: &AppHandle, win: &WebviewWindow, force: bool) {
    if !force {
        let Ok(mut last) = LAST_GEOMETRY_SAVE.lock() else {
            return;
        };
        let now = Instant::now();
        if last.map(|t| now.duration_since(t) < SAVE_THROTTLE).unwrap_or(false) {
            return;
        }
        *last = Some(now);
    }
    let Some(db) = app.try_state::<Arc<Db>>() else {
        return;
    };
    let Some(current) = geometry_from_window(win) else {
        return;
    };

    if current.maximized {
        // 保留关闭前的正常矩形，只记录最大化标记；没有历史矩形时记录当前值，
        // 下次打开至少能恢复「最大化」状态，而不是回到默认居中。
        let mut saved = read_geometry(&db).unwrap_or(current);
        saved.maximized = true;
        match serde_json::to_value(saved) {
            Ok(value) => {
                if let Err(error) = db.set_setting(SETTING_RECT, value) {
                    tracing::debug!("保存工作空间最大化状态失败: {error}");
                }
            }
            Err(error) => tracing::debug!("序列化工作空间窗口几何失败: {error}"),
        }
        return;
    }

    // 只保存大部分可见的位置（与主窗口 window_rect 同口径），屏外位置不落库。
    let monitors: Vec<(i32, i32, u32, u32)> = app
        .available_monitors()
        .map(|list| {
            list.iter()
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
    if !monitors.is_empty() && !is_rect_mostly_visible(&current.to_window_rect(), &monitors) {
        return;
    }
    match serde_json::to_value(current) {
        Ok(value) => {
            if let Err(error) = db.set_setting(SETTING_RECT, value) {
                tracing::debug!("保存工作空间窗口几何失败: {error}");
            }
        }
        Err(error) => tracing::debug!("序列化工作空间窗口几何失败: {error}"),
    }
}

/// 工作台窗口外轮廓：普通态按当前预设半径（Win32 区域 + CSS 弧同源），
/// 最大化取直角——最大化窗口必须铺满显示器工作区，圆角会在屏幕边缘留缝隙。
/// 参数没变时直接返回，避免尺寸拖动中逐帧重建设置区域。
fn sync_workbench_frame(win: &WebviewWindow) -> bool {
    let maximized = win.is_maximized().unwrap_or(false);
    let radius = effective_workbench_radius(workbench_radius(), maximized);
    let corner = workbench_corner();
    let size = win
        .outer_size()
        .unwrap_or(PhysicalSize { width: 0, height: 0 });
    let scale = win.scale_factor().unwrap_or(1.0);
    let key = frame_key_with_corner(radius, corner, size.width, size.height, scale, maximized);
    if WORKBENCH_FRAME_KEY.load(Ordering::Relaxed) == key {
        return true;
    }
    // 最大化时半径归零，指数无意义；非最大化时按前端确认过的曲线指数裁剪。
    let applied = if maximized {
        crate::window_shape::apply_with_radius(win, radius)
    } else {
        crate::window_shape::apply_with_corner_profile(win, radius, corner)
    };
    // 失败时清掉指纹：下次事件（尺寸/DPI/显示）必须重试，不能停在旧区域
    WORKBENCH_FRAME_KEY.store(if applied { key } else { 0 }, Ordering::Relaxed);
    applied
}

/// 前端按视觉预设下发工作台窗口半径（与主窗 `apply_window_radius` 同一口径）。
/// 返回 Win32 区域是否真正应用成功；失败时 CSS 弧仍在，前端不做阻断。
#[tauri::command]
pub fn set_workspace_window_radius(app: AppHandle, radius: f64) -> AppResult<bool> {
    let clamped = clamp_workbench_radius(radius);
    WORKBENCH_RADIUS_MILLI.store((clamped * 1000.0).round() as u32, Ordering::Relaxed);
    WORKBENCH_FRAME_KEY.store(0, Ordering::Relaxed);
    let win = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| AppError::Agent("工作台窗口不存在".into()))?;
    Ok(sync_workbench_frame(&win))
}

/// 前端在确认 WebView2 支持 `corner-shape` 后下发角部曲线指数（4 = 连续圆角）。
/// `corner = None` 表示"保持当前"；传 2 表示明确退回圆弧（能力检测失败时的降级）。
/// 与半径分开成两个命令，是为了让不支持 `corner-shape` 的运行时只降级曲线，
/// 半径仍然按预设生效（不会把圆角一起丢掉）。
#[tauri::command]
pub fn set_workspace_window_corner(app: AppHandle, corner: Option<f64>) -> AppResult<bool> {
    if let Some(value) = corner {
        let exponent = if value.is_finite() {
            value.clamp(2.0, 6.0)
        } else {
            2.0
        };
        WORKBENCH_CORNER_MILLI.store((exponent * 1000.0).round() as u32, Ordering::Relaxed);
        WORKBENCH_FRAME_KEY.store(0, Ordering::Relaxed);
    }
    let win = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| AppError::Agent("工作台窗口不存在".into()))?;
    Ok(sync_workbench_frame(&win))
}

fn attach_events(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    let w = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { .. } => {
            // 关闭按钮 / Alt+F4：保存几何后正常销毁；不 prevent_close，窗口才是真关闭。
            save_geometry(&app, &w, true);
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            save_geometry(&app, &w, false);
            // 尺寸/DPI/最大化状态变化后按新的物理像素重算区域，否则区域会停在
            // 旧尺寸上把内容裁掉（主窗同样契约，见 `window_shape::apply`）。
            let _ = sync_workbench_frame(&w);
        }
        tauri::WindowEvent::Destroyed => {
            // 工作台专属状态必须随窗口销毁一起清掉：否则下次创建（或句柄被系统
            // 复用时）会命中旧几何指纹/旧区域缓存，新窗口停在上一轮的裁剪形状上。
            reset_workbench_frame_state();
            if let Ok(h) = w.hwnd() {
                crate::window_shape::forget_window(h.0 as isize);
                crate::window_shadow::detach(h.0 as isize);
            }
            // 窗口销毁后不再有待兑现的启动揭示（避免 watchdog 对已销毁窗口 show）。
            STARTUP_REVEAL.store(false, Ordering::SeqCst);
            // 窗口销毁后队列里的请求已无接收方：逐个以 cancelled 收敛，
            // 调用方不会永久停在 pending；同时避免下次打开执行过期导航。
            for request in drain_workbench_nav_requests() {
                emit_nav_ack_event(
                    &app,
                    request.request_id,
                    ACK_STATUS_CANCELLED,
                    Some("工作台窗口已关闭，导航已取消".to_string()),
                );
            }
            if let Some(main) = app.get_webview_window(MAIN_LABEL) {
                let _ = main.emit(EVENT_WINDOW_CLOSED, ());
            }
        }
        _ => {}
    });
}

/// 打开计划：工作台标签存在时只能聚焦，不存在时才允许创建。
///
/// 这是「工作台唯一」的判定点：启动、手动打开、托盘/胶囊转发与第二实例全部经
/// `open_or_focus_workbench` 的同一把锁 + 同一条计划，不会出现两个完整工作台。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkbenchOpenPlan {
    FocusExisting,
    CreateNew,
}

fn plan_workbench_open(has_existing_window: bool) -> WorkbenchOpenPlan {
    if has_existing_window {
        WorkbenchOpenPlan::FocusExisting
    } else {
        WorkbenchOpenPlan::CreateNew
    }
}

/// 显示并聚焦工作台（幂等）：已可见时只聚焦，最小化时先还原。
/// 保存的最大化状态在这里兑现——先 show 再 maximize，保证系统记录的还原矩形
/// 是用户保存的窗口位置，而不是隐藏创建时的默认位置。
fn reveal_workbench(win: &WebviewWindow) -> AppResult<()> {
    let _ = win.unminimize();
    if !win.is_visible().unwrap_or(false) {
        win.show()?;
    }
    if STARTUP_MAXIMIZE.swap(false, Ordering::SeqCst) {
        if let Err(error) = win.maximize() {
            tracing::warn!("恢复工作台最大化状态失败: {error}");
        }
    }
    let _ = win.set_focus();
    Ok(())
}

/// 启动揭示超时兜底：前端崩溃/白屏时窗口不能永远隐藏。
fn spawn_startup_reveal_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_REVEAL_TIMEOUT);
        if !STARTUP_REVEAL.swap(false, Ordering::SeqCst) {
            return;
        }
        tracing::warn!(
            timeout_ms = STARTUP_REVEAL_TIMEOUT.as_millis() as u64,
            "大型工作台未收到前端就绪信号，已超时强制显示"
        );
        crate::diagnostics::event(
            crate::diagnostics::DiagLevel::Warn,
            "workbench",
            "startup-reveal",
            "timeout",
        )
        .window(WINDOW_LABEL)
        .message("大型工作台前端未在超时内确认就绪，已强制显示窗口")
        .metadata(
            "timeoutMs",
            serde_json::json!(STARTUP_REVEAL_TIMEOUT.as_millis() as u64),
        )
        .emit();
        if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
            if let Err(error) = reveal_workbench(&win) {
                tracing::warn!("超时后显示工作台失败: {error}");
            }
        }
    });
}

/// 打开失败时把用户带回可用界面：显示主面板（快捷工具面板职责仍在），
/// 并广播明确错误文案——绝不静默停在旧界面还宣称启动成功。
pub(crate) fn fallback_to_main(app: &AppHandle, message: &str) {
    tracing::warn!(%message, "回退主面板");
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        crate::show_and_focus(&main);
        let _ = main.emit(
            EVENT_STARTUP_FAILED,
            serde_json::json!({ "message": message }),
        );
    }
}

/// 启动阶段打开大型工作台：依赖（DB/设置/托盘/快捷键）就绪后调用。
/// 窗口隐藏创建，等前端首帧就绪后再显示；失败由调用方走 `fallback_to_main`。
pub fn open_workbench_on_startup(app: &AppHandle, db: &Db) -> AppResult<()> {
    open_or_focus_workbench(app, db, None, None, None, OpenReveal::WhenReady)?;
    Ok(())
}

/// 重复启动（第二实例）的唤醒：工作台存在则聚焦，已关闭则重建。
///
/// 单实例回调运行在 `WM_COPYDATA` 的同步派发里（第二个实例最多等 10s），
/// 因此创建窗口投递到主线程消息循环的下一拍，不在 SendMessage 回调里嵌套
/// 创建 WebView。
pub fn focus_or_open_workbench_from_second_instance(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        STARTUP_REVEAL.store(false, Ordering::SeqCst);
        let _ = reveal_workbench(&win);
        return;
    }
    let app_for_main = app.clone();
    let posted = app.run_on_main_thread(move || {
        let app = app_for_main;
        let result = match app.try_state::<Arc<Db>>() {
            Some(db) => {
                open_or_focus_workbench(&app, &db, None, None, None, OpenReveal::Immediate)
                    .map(|_| ())
            }
            None => Err(AppError::Unavailable(
                "数据库尚未就绪，无法打开大型工作台".to_string(),
            )),
        };
        if let Err(error) = result {
            fallback_to_main(&app, &format!("大型工作台打开失败：{error}"));
        }
    });
    if let Err(error) = posted {
        fallback_to_main(app, &format!("大型工作台打开失败：{error}"));
    }
}

/// 工作台前端首帧就绪：启动路径挂起的显示请求在这里兑现（手动打开时是 no-op）。
#[tauri::command]
pub fn workbench_ui_ready(window: WebviewWindow) -> AppResult<()> {
    if window.label() != WINDOW_LABEL {
        return Err(AppError::Validation(
            "只有工作台窗口可以确认首帧就绪".to_string(),
        ));
    }
    if STARTUP_REVEAL.swap(false, Ordering::SeqCst) {
        reveal_workbench(&window)?;
    }
    Ok(())
}

/// 打开/聚焦工作台窗口的内部实现：启动与手动打开共用同一创建与回滚路径。
///
/// `nav` 会先进入队列再创建/唤醒窗口：
/// - 新窗口的 WebView 可能在我们返回之前就开始挂载，因此**先入队**才能被
///   `workbench_take_nav` 拉到；
/// - 已存在窗口同时推一条事件作为快路径（事件丢失仍可从队列拉取）。
///
/// **活跃项目不在原生层提交**：带 projectId 的导航可能被工作台内的未保存草稿
/// 取消或拒绝。活跃项目由工作台外壳在路由切换成功/用户确认后通过
/// `workspace_set_active_project` 串行提交，原生层只负责把目标放进队列。
fn open_or_focus_workbench(
    app: &AppHandle,
    db: &Db,
    _project_id: Option<&str>,
    nav: Option<WorkbenchNavTarget>,
    request_id: Option<i64>,
    reveal: OpenReveal,
) -> AppResult<(bool, Option<i64>)> {
    // 串行化创建：并发调用都可能先看到「窗口不存在」，Tauri 会拒绝第二个 label。
    // 拿锁后二次读取，第二个调用者直接走聚焦路径（不会多建一个工作台）。
    let _guard = OPEN_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let existing = app.get_webview_window(WINDOW_LABEL);
    match plan_workbench_open(existing.is_some()) {
        WorkbenchOpenPlan::FocusExisting => {
            let existing = existing.ok_or_else(|| {
                AppError::Unavailable("工作台窗口状态不一致".to_string())
            })?;
            // 已存在即已加载（或正在加载）：启动挂起的揭示直接兑现，避免窗口隐形。
            STARTUP_REVEAL.store(false, Ordering::SeqCst);
            // 已有窗口的几何由它自己维护，不能让上一次创建遗留的最大化待办落到它身上。
            STARTUP_MAXIMIZE.store(false, Ordering::SeqCst);
            let _ = existing.unminimize();
            if !existing.is_visible().unwrap_or(false) {
                existing.show()?;
            }
            let _ = existing.set_focus();
            if let Some(target) = nav {
                let (request, evicted) = enqueue_workbench_nav_inner(target, request_id)?;
                if let Some(stale) = evicted {
                    emit_nav_ack_event(
                        app,
                        stale.request_id,
                        ACK_STATUS_FAILED,
                        Some("导航队列已满，该请求已被新目标取代".to_string()),
                    );
                }
                let request_id = request.request_id;
                if let Err(error) = existing.emit(EVENT_WORKBENCH_NAVIGATE, request) {
                    // 事件没送出去也没有窗口会来拉取：撤销这次排队并如实报错。
                    clear_pending_workbench_nav(request_id);
                    return Err(AppError::Agent(format!(
                        "向工作台发送导航请求失败：{error}"
                    )));
                }
                // Tauri 事件可能因页面重载/监听尚未注册而丢失（窗口已存在但 WebView
                // 正在刷新）。直接执行一次页面内 DOM 事件触发工作台立即拉取队列；
                // eval 失败不影响协议，工作台挂载/聚焦时仍会拉取。
                let _ = existing.eval(
                    "window.dispatchEvent(new Event('taskdock-workbench-nav-ping'))",
                );
                return Ok((false, Some(request_id)));
            }
            return Ok((false, None));
        }
        WorkbenchOpenPlan::CreateNew => {}
    }

    // 新窗口必须先入队再创建：WebView 可能在 build 返回前就开始挂载并拉取队列。
    let nav_request = match nav {
        Some(target) => {
            let (request, evicted) = enqueue_workbench_nav_inner(target, request_id)?;
            if let Some(stale) = evicted {
                emit_nav_ack_event(
                    app,
                    stale.request_id,
                    ACK_STATUS_FAILED,
                    Some("导航队列已满，该请求已被新目标取代".to_string()),
                );
            }
            Some(request)
        }
        None => None,
    };

    // 新窗口：导航目标已入队，WebView 挂载后由外壳应用路由并提交项目。
    let rollback_nav = |request: &Option<WorkbenchNavRequest>| {
        if let Some(req) = request {
            clear_pending_workbench_nav(req.request_id);
        }
    };

    // 启动路径的揭示意图必须在 build 前就挂起：WebView 在另一个线程里运行，
    // 首帧就绪的 IPC 可能早于主线程返回 build，晚置位会让这次就绪信号白丢，
    // 只能等 8s 兜底才显示窗口。
    if matches!(reveal, OpenReveal::WhenReady) {
        STARTUP_REVEAL.store(true, Ordering::SeqCst);
    }
    let win = match WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("workspace.html".into()),
    )
    .title("Task Dock · 工作台")
    // 无原生装饰：标题栏由 `WorkbenchShell` 顶栏自绘（品牌/上下文/窗口按钮）。
    // `shadow(false)` 同时让 tao 走「无阴影无边框窗口」的完整四边/四角
    // WM_NCHITTEST 分支——只关标题栏但保留 `shadow(true)` 时，tao 只让顶边可
    // 缩放（见 tao 0.37 的 undecorated_with_shadows 分支），左右下边就不可拖拽缩放。
    // 最大化时 tao 会把客户区收敛到显示器工作区，不会遮挡任务栏。
    //
    // `transparent(true)`：窗口圆角由 `window_shape::apply_with_radius` 的 Win32
    // 区域裁剪 + `workbench.css` 的 CSS 弧共同定义，四角外侧那片像素必须真正透明，
    // 否则会留下不透明的直角方块（正是修复前「方形直角」的直接来源）。
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(true)
    .maximizable(true)
    .minimizable(true)
    .closable(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .visible(false)
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
    .build()
    {
        Ok(win) => win,
        Err(e) => {
            if matches!(reveal, OpenReveal::WhenReady) {
                STARTUP_REVEAL.store(false, Ordering::SeqCst);
            }
            rollback_nav(&nav_request);
            return Err(e.into());
        }
    };

    attach_events(app, &win);
    // 与主窗、微件、右键菜单同一条外观链路：Win32 区域裁剪出窗口圆角，
    // 前端 `.wb-root` 只负责同半径的可见弧与 1px 边框（不再各写一套）。
    let _ = sync_workbench_frame(&win);
    // 原生外部阴影（DWM 不给带区域的无边框窗口画投影，见 window_shadow 模块注释）。
    crate::window_shadow::attach(&win);
    // 新窗口从干净状态开始：上一次创建遗留的最大化待办不能带到这里。
    STARTUP_MAXIMIZE.store(false, Ordering::SeqCst);
    restore_geometry(app, &win, db);
    match reveal {
        OpenReveal::Immediate => {
            if let Err(e) = reveal_workbench(&win) {
                let _ = win.close();
                rollback_nav(&nav_request);
                return Err(e);
            }
        }
        OpenReveal::WhenReady => {
            // 意图已在 build 前挂起；这里只负责超时兜底，避免前端崩溃后窗口永远隐藏。
            spawn_startup_reveal_watchdog(app.clone());
        }
    }

    Ok((
        true,
        nav_request.as_ref().map(|request| request.request_id),
    ))
}

/// 打开/聚焦统一工作台并导航到结构化目标。
///
/// 只能由主窗口调用（胶囊与主面板都在该窗口内）；工作台窗口自身使用前端路由，
/// 不需要经由本命令。返回的 `requestId` 只代表**请求已受理**，调用方必须等待
/// `workbench-nav-ack` 事件才能判断导航是否真的成功。
#[tauri::command]
pub async fn workbench_open_window(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Arc<Db>>,
    target: Option<WorkbenchNavTarget>,
    project_id: Option<String>,
    request_id: Option<i64>,
) -> AppResult<WorkbenchOpenResult> {
    if window.label() != MAIN_LABEL {
        return Err(AppError::Validation(
            "工作台只能由主窗口打开".to_string(),
        ));
    }
    let mut target = normalize_workbench_target(target)?;
    // 显式 projectId 参数优先（兼容旧调用方），并与 target 内的项目合并为唯一值。
    let explicit = project_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(id) = explicit {
        target.project_id = Some(id);
    }
    if let Some(id) = target.project_id.as_deref() {
        // 打开前校验存在性：失败直接报错，不把悬空 ID 写成活跃项目。
        crate::commands::project_workspace::workspace_project_get_impl(&db, id)?;
    }
    let project_id = target.project_id.clone();
    let (created, request_id) = open_or_focus_workbench(
        &app,
        &db,
        project_id.as_deref(),
        Some(target),
        request_id,
        OpenReveal::Immediate,
    )?;
    Ok(WorkbenchOpenResult {
        request_id: request_id.unwrap_or(0),
        created,
    })
}

/// 工作台拉取下一条待处理导航请求（挂载 / 收到事件 / 重新获得焦点时调用）。
///
/// 只允许工作台窗口调用；队列为空返回 `null`（不是错误）。
#[tauri::command]
pub fn workbench_take_nav(window: WebviewWindow) -> AppResult<Option<WorkbenchNavRequest>> {
    if window.label() != WINDOW_LABEL {
        return Err(AppError::Validation(
            "只有工作台窗口可以拉取导航请求".to_string(),
        ));
    }
    let (request, expired) = take_pending_workbench_nav_with_expired();
    for request_id in expired {
        emit_nav_ack_event(
            window.app_handle(),
            request_id,
            ACK_STATUS_FAILED,
            Some("等待用户确认超时，导航已失效".to_string()),
        );
    }
    Ok(request)
}

/// 工作台回执：把本次导航的**真实结果**转给主窗口调用方。
///
/// `status` 只允许 succeeded / pending / cancelled / failed；`pending` 不是终态，
/// 用户确认或取消后必须再回一条最终结果。
#[tauri::command]
pub fn workbench_nav_ack(
    app: AppHandle,
    window: WebviewWindow,
    request_id: i64,
    status: String,
    error: Option<String>,
) -> AppResult<()> {
    if window.label() != WINDOW_LABEL {
        return Err(AppError::Validation(
            "工作台导航回执只能由工作台窗口发送".to_string(),
        ));
    }
    if request_id <= 0 {
        return Err(AppError::Validation(
            "导航请求编号必须为正整数".to_string(),
        ));
    }
    let status = normalize_ack_status(true, false, Some(status.as_str()))?;
    let (broadcast, expired) = {
        let mut queue = WORKBENCH_NAV
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        apply_workbench_nav_ack_locked(&mut queue, request_id, &status, Instant::now())
    };
    for expired_id in expired {
        emit_nav_ack_event(
            &app,
            expired_id,
            ACK_STATUS_FAILED,
            Some("等待用户确认超时，导航已失效".to_string()),
        );
    }
    if broadcast {
        emit_nav_ack_event(&app, request_id, &status, error);
    }
    Ok(())
}

/// 旧 IPC 兼容适配器：打开/聚焦统一工作台，并把「打开某项目」转换为同一条
/// 结构化导航事务（`workbench_open_window` 的兼容入口）。
///
/// 只入队一次，不再广播可绕过草稿门禁的 `project-selected` 事件；活跃项目仍由
/// 工作台外壳在路由成功/用户确认后提交，因此取消导航不会改活跃项目。
///
/// 必须是 async：同步命令阻塞 IPC 线程时，WebView2 控制器创建等待消息循环会卡死。
#[tauri::command]
pub async fn open_project_workspace_window(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Arc<Db>>,
    project_id: Option<String>,
    request_id: Option<i64>,
) -> AppResult<WorkspaceWindowInfo> {
    if window.label() != MAIN_LABEL {
        return Err(AppError::Validation(
            "工作空间窗口只能由主窗口打开".to_string(),
        ));
    }
    let project_id = project_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(id) = project_id.as_deref() {
        // 打开前校验存在性：失败直接报错，不把悬空 ID 写成活跃项目。
        crate::commands::project_workspace::workspace_project_get_impl(&db, id)?;
    }

    // 旧入口语义是「打开某个工作空间项目」：映射为工作台的项目路由目标，
    // 让旧调用方与新入口共享同一条导航协议（页面切换、草稿门禁、回执与项目提交）。
    // 只入队一次：不再额外发送可直接改项目状态的事件。
    let nav = project_id.as_ref().map(|id| WorkbenchNavTarget {
        tab: "workspace".to_string(),
        project_id: Some(id.clone()),
        ..Default::default()
    });
    let (_, request_id) = open_or_focus_workbench(
        &app,
        &db,
        project_id.as_deref(),
        nav,
        request_id,
        OpenReveal::Immediate,
    )?;
    Ok(WorkspaceWindowInfo {
        opened: true,
        project_id: if request_id.is_some() {
            project_id
        } else {
            None
        },
        request_id,
    })
}

/// 「在开发工作台打开」：校验工作空间与开发项目登记，显示主窗口并发出导航请求。
///
/// 返回 `requestId`：事件只是**请求**，主窗口解除胶囊/切页完成后必须用
/// `project_workspace_open_dev_workbench_ack` 回传真实结果（`EVENT_..._RESULT`）。
///
/// ## requestId 由调用方（工作空间窗口）生成
/// 若由本命令分配再通过返回值传给前端，主窗口的回执可能**先于**命令响应到达
/// 工作空间窗口，此时前端还没登记 requestId，回执会被当成过期消息丢弃，最终
/// 假超时。因此允许调用方在**发命令之前**生成并登记 requestId，再传进来；
/// 未传时仍用本进程的单调计数器（老调用方兼容）。
///
/// ## 不在这里写 `workbench_current_project`
/// 「切换当前开发项目」是导航事务的一部分：主窗口不存在、事件发送失败、被未保存
/// 草稿拦截、用户取消都不应改写上下文。上下文提交由主窗口在确认导航真正生效时
/// 完成，失败则由主窗口按原值回滚。
#[tauri::command]
pub fn project_workspace_open_dev_workbench(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Arc<Db>>,
    project_id: String,
    request_id: Option<i64>,
) -> AppResult<OpenDevWorkbenchRequest> {
    assert_main_or_workspace(&window)?;
    let project = crate::commands::project_workspace::workspace_project_get_impl(&db, &project_id)?;
    let Some(dev_project_id) = project.dev_project_id else {
        return Err(AppError::Validation(
            "该项目未关联开发项目，请先在开发工作台登记并关联".to_string(),
        ));
    };
    // 弱引用失效时明确报错，不静默改写到别的项目。
    let exists = db.with_read(|conn| {
        conn.query_row(
            "SELECT 1 FROM dev_projects WHERE id = ?1",
            rusqlite::params![dev_project_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(AppError::from)
    })?;
    if !exists {
        return Err(AppError::NotFound(
            "关联的开发项目已不存在，请重新关联".to_string(),
        ));
    }
    if let Some(id) = request_id {
        if id <= 0 {
            return Err(AppError::Validation(
                "导航请求编号必须为正整数".to_string(),
            ));
        }
    }
    // 主窗口不可用时直接失败：不修改任何上下文，也不返回「已受理」。
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return Err(AppError::NotFound(
            "主窗口不可用，无法打开开发工作台".to_string(),
        ));
    };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    let request_id = request_id.unwrap_or_else(next_dev_workbench_request_id);
    main.emit(
        EVENT_OPEN_DEV_WORKBENCH,
        OpenDevWorkbenchEvent {
            request_id,
            dev_project_id: dev_project_id.clone(),
        },
    )
    .map_err(|e| {
        AppError::Agent(format!("向主窗口发送打开请求失败：{e}"))
    })?;
    Ok(OpenDevWorkbenchRequest {
        request_id,
        dev_project_id,
    })
}

/// 主窗口回执：把本次事务的真实结果转给工作空间窗口。
///
/// 只允许主窗口调用；工作空间窗口已关闭时忽略（没有接收方不是错误）。
/// `status` 为权威状态；未传时按旧字段 `ok`/`pending` 推导。
#[tauri::command]
pub fn project_workspace_open_dev_workbench_ack(
    app: AppHandle,
    window: WebviewWindow,
    request_id: i64,
    ok: bool,
    pending: bool,
    status: Option<String>,
    error: Option<String>,
) -> AppResult<()> {
    if window.label() != MAIN_LABEL {
        return Err(AppError::Validation(
            "该回执只能由主窗口发送".to_string(),
        ));
    }
    if request_id <= 0 {
        return Err(AppError::Validation(
            "导航请求编号必须为正整数".to_string(),
        ));
    }
    let status = normalize_ack_status(ok, pending, status.as_deref())?;
    if let Some(ws) = app.get_webview_window(WINDOW_LABEL) {
        let _ = ws.emit(
            EVENT_OPEN_DEV_WORKBENCH_RESULT,
            OpenDevWorkbenchAckEvent {
                request_id,
                ok,
                pending,
                status,
                error,
            },
        );
    }
    Ok(())
}

/// 应用退出前强制落一次几何：正常关闭会走 CloseRequested，强制退出/托盘退出
/// 不保证触发，因此在退出流程显式调用。
pub fn persist_geometry_on_exit(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        save_geometry(app, &win, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 导航队列是进程级全局状态：并行测试必须串行访问，否则互相清空/推进。
    static NAV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn area() -> WorkArea {
        WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        }
    }

    #[test]
    fn workbench_open_plan_reuses_the_single_workspace_window() {
        // 唯一性判定：标签已存在只能聚焦，绝不允许再建第二个完整工作台。
        assert_eq!(
            plan_workbench_open(true),
            WorkbenchOpenPlan::FocusExisting
        );
        assert_eq!(plan_workbench_open(false), WorkbenchOpenPlan::CreateNew);
        assert_eq!(WINDOW_LABEL, "workspace", "工作台标签是跨入口共享契约");
    }

    #[test]
    fn startup_reveal_is_not_pending_by_default() {
        // 只有启动路径会挂起显示请求；手动打开/已有窗口必须立即可见。
        assert!(!STARTUP_REVEAL.load(Ordering::SeqCst));
    }

    #[test]
    fn clamp_geometry_keeps_window_inside_work_area() {
        let (size, pos) = clamp_into_area(
            area(),
            WorkspaceGeometry {
                x: -3000,
                y: -500,
                w: 4000,
                h: 2000,
                maximized: false,
            },
        );
        assert!(size.width as i32 <= area().width);
        assert!(size.height as i32 <= area().height);
        assert!(pos.x >= area().x);
        assert!(pos.y >= area().y);
        assert!(pos.x + size.width as i32 <= area().x + area().width);
        assert!(pos.y + size.height as i32 <= area().y + area().height);
    }

    #[test]
    fn clamp_geometry_preserves_valid_position_and_size() {
        let rect = WorkspaceGeometry {
            x: -1800,
            y: 100,
            w: 1000,
            h: 700,
            maximized: false,
        };
        let (size, pos) = clamp_into_area(area(), rect);
        assert_eq!(size.width, 1000);
        assert_eq!(size.height, 700);
        assert_eq!(pos.x, -1800);
        assert_eq!(pos.y, 100);
    }

    #[test]
    fn geometry_round_trip_through_json() {
        let rect = WorkspaceGeometry {
            x: 10,
            y: 20,
            w: 1180,
            h: 760,
            maximized: true,
        };
        let value = serde_json::to_value(rect).unwrap();
        let back: WorkspaceGeometry = serde_json::from_value(value).unwrap();
        assert_eq!(rect, back);
        // 兼容早期只有矩形、没有 maximized 的 JSON
        let legacy: WorkspaceGeometry =
            serde_json::from_str(r#"{"x":1,"y":2,"w":900,"h":700}"#).unwrap();
        assert!(!legacy.maximized);
    }

    /// P0-02 契约：跨窗口「打开开发工作台」载荷与回执必须是 camelCase，
    /// 且请求里同时带 requestId 与 devProjectId（两者语义不同，不能合并）。
    #[test]
    fn open_dev_workbench_payloads_are_camel_case() {
        let event = serde_json::to_string(&OpenDevWorkbenchEvent {
            request_id: 7,
            dev_project_id: "dev-1".into(),
        })
        .unwrap();
        assert!(event.contains("\"requestId\":7"), "{event}");
        assert!(event.contains("\"devProjectId\":\"dev-1\""), "{event}");

        let request = serde_json::to_string(&OpenDevWorkbenchRequest {
            request_id: 8,
            dev_project_id: "dev-2".into(),
        })
        .unwrap();
        assert!(request.contains("\"requestId\":8"), "{request}");

        // 成功回执：error 为 null，status 是权威终态字段
        let ack = serde_json::to_string(&OpenDevWorkbenchAckEvent {
            request_id: 7,
            ok: true,
            pending: false,
            status: ACK_STATUS_SUCCEEDED.into(),
            error: None,
        })
        .unwrap();
        assert!(ack.contains("\"requestId\":7"), "{ack}");
        assert!(ack.contains("\"ok\":true"), "{ack}");
        assert!(ack.contains("\"pending\":false"), "{ack}");
        assert!(ack.contains("\"status\":\"succeeded\""), "{ack}");
        assert!(ack.contains("\"error\":null"), "{ack}");

        // 失败回执必须带可读原因
        let failed = serde_json::to_string(&OpenDevWorkbenchAckEvent {
            request_id: 9,
            ok: false,
            pending: false,
            status: ACK_STATUS_FAILED.into(),
            error: Some("页面切换未生效".into()),
        })
        .unwrap();
        assert!(failed.contains("\"ok\":false"), "{failed}");
        assert!(failed.contains("\"status\":\"failed\""), "{failed}");
        assert!(failed.contains("页面切换未生效"), "{failed}");
    }

    /// status 缺省时按旧字段推导；非法状态直接拒绝，不能被当成成功。
    #[test]
    fn ack_status_derives_from_legacy_flags_and_rejects_unknown() {
        assert_eq!(
            normalize_ack_status(false, true, None).unwrap(),
            ACK_STATUS_PENDING
        );
        assert_eq!(
            normalize_ack_status(true, false, None).unwrap(),
            ACK_STATUS_SUCCEEDED
        );
        assert_eq!(
            normalize_ack_status(false, false, Some("")).unwrap(),
            ACK_STATUS_FAILED
        );
        assert_eq!(
            normalize_ack_status(true, false, Some(ACK_STATUS_CANCELLED)).unwrap(),
            ACK_STATUS_CANCELLED
        );
        assert!(normalize_ack_status(false, false, Some("done")).is_err());
    }

    /// requestId 单调递增，迟到回执可按 id 去重。
    #[test]
    fn dev_workbench_request_ids_are_monotonic() {
        let a = next_dev_workbench_request_id();
        let b = next_dev_workbench_request_id();
        assert!(b > a);
    }

    /// 工作台导航目标：只接受已注册功能 ID，可选上下文去空白、拒绝控制字符。
    #[test]
    fn workbench_target_requires_known_tab_and_trims_context() {
        let target = normalize_workbench_target(Some(WorkbenchNavTarget {
            tab: " tasks ".into(),
            project_id: Some("  p1  ".into()),
            task_id: Some("   ".into()),
            object_id: None,
            sub: Some("notes".into()),
        }))
        .unwrap();
        assert_eq!(target.tab, "tasks");
        assert_eq!(target.project_id.as_deref(), Some("p1"));
        assert_eq!(target.task_id, None);
        assert_eq!(target.sub.as_deref(), Some("notes"));

        // 缺省目标 = 工作台首页
        assert_eq!(normalize_workbench_target(None).unwrap().tab, "home");

        // 未知目标/控制字符/超长 ID 一律拒绝，不静默改写
        for bad in ["", "tasks/../../etc", "unknown", "TASKS"] {
            assert!(
                normalize_workbench_target(Some(WorkbenchNavTarget {
                    tab: bad.into(),
                    ..Default::default()
                }))
                .is_err(),
                "tab {bad} 应被拒绝"
            );
        }
        assert!(normalize_workbench_target(Some(WorkbenchNavTarget {
            tab: "tasks".into(),
            project_id: Some("p\n1".into()),
            ..Default::default()
        }))
        .is_err());
        assert!(normalize_workbench_target(Some(WorkbenchNavTarget {
            tab: "tasks".into(),
            object_id: Some("x".repeat(129)),
            ..Default::default()
        }))
        .is_err());
    }

    /// 导航队列按顺序交付；回执会清掉尚未拉取的同号请求（防止窗口重载重复执行）。
    #[test]
    fn workbench_nav_queue_delivers_in_order_and_ack_clears_pending() {
        let _guard = NAV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_workbench_nav_queue();
        let first = enqueue_workbench_nav(
            WorkbenchNavTarget {
                tab: "tasks".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let second = enqueue_workbench_nav(
            WorkbenchNavTarget {
                tab: "agents".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(second.request_id > first.request_id);

        let taken = take_pending_workbench_nav().expect("第一条应可拉取");
        assert_eq!(taken.request_id, first.request_id);
        assert_eq!(taken.target.tab, "tasks");
        // 未回执前重复拉取仍返回同一条（StrictMode 双执行/重载不丢请求）。
        assert_eq!(
            take_pending_workbench_nav().map(|req| req.request_id),
            Some(first.request_id)
        );

        // 事件快路径已经回执第二条之前，先回执第一条：队首推进到第二条。
        clear_pending_workbench_nav(first.request_id);
        assert_eq!(
            take_pending_workbench_nav().map(|req| req.target.tab),
            Some("agents".to_string())
        );

        // 事件快路径已经回执第二条：队列里的它必须被移除，重载时不再执行。
        clear_pending_workbench_nav(second.request_id);
        assert!(take_pending_workbench_nav().is_none());

        // 调用方预登记编号必须原样保留（回执可能先于命令响应到达）。
        let explicit = enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(9001)).unwrap();
        assert_eq!(explicit.request_id, 9001);
        assert_eq!(take_pending_workbench_nav().unwrap().request_id, 9001);
        clear_pending_workbench_nav(9001);
        assert!(enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(0)).is_err());

        let third = enqueue_workbench_nav(WorkbenchNavTarget::default(), None).unwrap();
        assert!(third.request_id > 9001);
        clear_workbench_nav_queue();
    }

    /// pending 不是终态：它必须移出交付队列（不阻塞后续导航），且最终回执只广播一次。
    #[test]
    fn workbench_nav_pending_unblocks_queue_and_final_ack_is_idempotent() {
        let _guard = NAV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_workbench_nav_queue();
        let (first, evicted) = enqueue_workbench_nav_inner(
            WorkbenchNavTarget {
                tab: "tasks".into(),
                ..Default::default()
            },
            Some(7301),
        )
        .unwrap();
        assert!(evicted.is_none());
        let (second, _) = enqueue_workbench_nav_inner(WorkbenchNavTarget::default(), Some(7302))
            .unwrap();
        assert_eq!(
            take_pending_workbench_nav().map(|req| req.request_id),
            Some(first.request_id)
        );

        let now = Instant::now();
        let (broadcast, expired) = {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(&mut queue, 7301, ACK_STATUS_PENDING, now)
        };
        assert!(broadcast);
        assert!(expired.is_empty());
        // 队首 pending 已让出：第二条可以立即交付，不会等到用户确认。
        assert_eq!(
            take_pending_workbench_nav().map(|req| req.request_id),
            Some(second.request_id)
        );

        // 重复 pending 仍广播（事件可能丢失），但生命周期状态不变。
        let (duplicate_pending, _) = {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(&mut queue, 7301, ACK_STATUS_PENDING, now)
        };
        assert!(duplicate_pending);
        {
            let queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(queue.awaiting.contains_key(&7301));
            assert_eq!(queue.pending.len(), 1);
        }

        let (final_broadcast, expired) = {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(
                &mut queue,
                7301,
                ACK_STATUS_SUCCEEDED,
                now + Duration::from_secs(1),
            )
        };
        assert!(final_broadcast);
        assert!(expired.is_empty());
        // 重复终态回执必须幂等：不再广播，也不重新进入任何生命周期集合。
        let (duplicate_final, _) = {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(
                &mut queue,
                7301,
                ACK_STATUS_SUCCEEDED,
                now + Duration::from_secs(2),
            )
        };
        assert!(!duplicate_final);
        {
            let queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(!queue.awaiting.contains_key(&7301));
            assert!(queue.terminal.iter().any(|item| item.request_id == 7301));
        }
        clear_workbench_nav_queue();
    }

    /// 等待确认超时：请求从 awaiting 清理并按失效处理，迟到终态不再广播。
    #[test]
    fn workbench_nav_await_timeout_expires_and_late_ack_is_ignored() {
        let _guard = NAV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_workbench_nav_queue();
        let (request, _) = enqueue_workbench_nav_inner(WorkbenchNavTarget::default(), Some(7311))
            .unwrap();
        let started = Instant::now();
        {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (broadcast, _) = apply_workbench_nav_ack_locked(
                &mut queue,
                request.request_id,
                ACK_STATUS_PENDING,
                started,
            );
            assert!(broadcast);
        }
        let later = started + WORKBENCH_NAV_AWAIT_TIMEOUT + Duration::from_secs(1);
        let (broadcast, expired) = {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(
                &mut queue,
                request.request_id,
                ACK_STATUS_PENDING,
                later,
            )
        };
        assert!(!broadcast, "超时请求的迟到 pending 不应再广播");
        assert_eq!(expired, vec![request.request_id]);
        let (late_final, _) = {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(
                &mut queue,
                request.request_id,
                ACK_STATUS_SUCCEEDED,
                later + Duration::from_secs(1),
            )
        };
        assert!(!late_final, "超时后迟到终态应按幂等忽略");
        clear_workbench_nav_queue();
    }

    /// 队列满时淘汰最旧未交付请求，新目标优先；被淘汰的编号由调用方失败收敛。
    #[test]
    fn workbench_nav_queue_evicts_oldest_when_full() {
        let _guard = NAV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_workbench_nav_queue();
        let mut first_id = 0;
        for index in 0..WORKBENCH_NAV_QUEUE_MAX {
            let (request, evicted) = enqueue_workbench_nav_inner(
                WorkbenchNavTarget::default(),
                Some(7400 + index as i64),
            )
            .unwrap();
            assert!(evicted.is_none());
            if index == 0 {
                first_id = request.request_id;
            }
        }
        let (newest, evicted) = enqueue_workbench_nav_inner(
            WorkbenchNavTarget::default(),
            Some(7499),
        )
        .unwrap();
        assert_eq!(evicted.map(|req| req.request_id), Some(first_id));
        assert_eq!(
            take_pending_workbench_nav().map(|req| req.request_id),
            Some(first_id + 1)
        );
        assert_eq!(newest.request_id, 7499);
        clear_workbench_nav_queue();
    }

    /// 请求编号在 queued / awaiting / terminal 三个阶段都不可复用。
    #[test]
    fn workbench_nav_request_id_is_unique_across_lifecycle() {
        let _guard = NAV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_workbench_nav_queue();
        enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(7501)).unwrap();
        assert!(
            enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(7501)).is_err(),
            "queued 阶段不得复用编号"
        );
        {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(&mut queue, 7501, ACK_STATUS_PENDING, Instant::now());
        }
        assert!(
            enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(7501)).is_err(),
            "awaiting 阶段不得复用编号"
        );
        {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(&mut queue, 7501, ACK_STATUS_CANCELLED, Instant::now());
        }
        assert!(
            enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(7501)).is_err(),
            "terminal 阶段不得复用编号"
        );
        clear_workbench_nav_queue();
    }

    /// 窗口销毁：所有未终结请求（含 awaiting）都被取出，供调用方按 cancelled 收敛。
    #[test]
    fn workbench_nav_drain_returns_queued_and_awaiting_requests() {
        let _guard = NAV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_workbench_nav_queue();
        let first = enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(7601)).unwrap();
        let second = enqueue_workbench_nav(WorkbenchNavTarget::default(), Some(7602)).unwrap();
        {
            let mut queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            apply_workbench_nav_ack_locked(
                &mut queue,
                first.request_id,
                ACK_STATUS_PENDING,
                Instant::now(),
            );
        }
        let mut drained: Vec<i64> = drain_workbench_nav_requests()
            .into_iter()
            .map(|req| req.request_id)
            .collect();
        drained.sort();
        assert_eq!(drained, vec![first.request_id, second.request_id]);
        {
            let queue = WORKBENCH_NAV
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(queue.pending.is_empty());
            assert!(queue.awaiting.is_empty());
            assert!(queue.terminal.is_empty());
        }
    }

    /// 旧 IPC 适配器必须把 requestId 暴露给调用方，否则无法等待真实回执。
    #[test]
    fn legacy_open_adapter_result_exposes_request_id() {
        let info = WorkspaceWindowInfo {
            opened: true,
            project_id: Some("p1".into()),
            request_id: Some(42),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"requestId\":42"), "{json}");
        assert!(json.contains("\"projectId\":\"p1\""), "{json}");
    }

    /// 跨窗口载荷必须是 camelCase，且 ack 的 status 是权威字段。
    #[test]
    fn workbench_nav_payloads_are_camel_case() {
        let request = serde_json::to_string(&WorkbenchNavRequest {
            request_id: 11,
            target: WorkbenchNavTarget {
                tab: "workspace".into(),
                project_id: Some("p1".into()),
                task_id: Some("t1".into()),
                object_id: None,
                sub: None,
            },
        })
        .unwrap();
        assert!(request.contains("\"requestId\":11"), "{request}");
        assert!(request.contains("\"projectId\":\"p1\""), "{request}");
        assert!(request.contains("\"taskId\":\"t1\""), "{request}");

        let ack = serde_json::to_string(&WorkbenchNavAckEvent {
            request_id: 11,
            status: ACK_STATUS_SUCCEEDED.into(),
            error: None,
        })
        .unwrap();
        assert!(ack.contains("\"requestId\":11"), "{ack}");
        assert!(ack.contains("\"status\":\"succeeded\""), "{ack}");
        assert!(ack.contains("\"error\":null"), "{ack}");

        let open = serde_json::to_string(&WorkbenchOpenResult {
            request_id: 12,
            created: true,
        })
        .unwrap();
        assert!(open.contains("\"requestId\":12"), "{open}");
        assert!(open.contains("\"created\":true"), "{open}");
    }

    // ── 工作台窗口外形（纯函数，不依赖 Win32）─────────────────────────────

    #[test]
    fn workbench_radius_clamps_and_falls_back() {
        // 与 `window_shape::set_radius` 同口径：0–40，NaN/无穷回落默认预设值。
        assert_eq!(clamp_workbench_radius(18.0), 18.0);
        assert_eq!(clamp_workbench_radius(-4.0), 0.0, "负半径等价直角");
        assert_eq!(clamp_workbench_radius(64.0), 40.0);
        assert_eq!(clamp_workbench_radius(f64::NAN), 18.0);
        assert_eq!(clamp_workbench_radius(f64::INFINITY), 18.0);
    }

    #[test]
    fn maximized_workbench_uses_square_frame() {
        // 最大化必须铺满工作区：任何预设半径在这里都收敛成 0（直角）。
        assert_eq!(effective_workbench_radius(18.0, true), 0.0);
        assert_eq!(effective_workbench_radius(20.0, true), 0.0);
        // 还原后立即回到预设半径，不残留最大化期间的直角区域。
        assert_eq!(effective_workbench_radius(18.0, false), 18.0);
        assert_eq!(effective_workbench_radius(20.0, false), 20.0);
    }

    #[test]
    fn frame_key_is_stable_only_for_identical_geometry() {
        let base = frame_key(18.0, 1280, 820, 1.25, false);
        assert_eq!(base, frame_key(18.0, 1280, 820, 1.25, false), "参数相同不重复应用");
        assert_ne!(base, frame_key(18.0, 1280, 820, 1.25, true), "最大化状态必须重建");
        assert_ne!(base, frame_key(20.0, 1280, 820, 1.25, false), "预设半径变化必须重建");
        assert_ne!(base, frame_key(18.0, 944, 608, 1.25, false), "尺寸变化必须重建");
        assert_ne!(base, frame_key(18.0, 1280, 820, 1.5, false), "DPI 变化必须重建");
    }

    #[test]
    fn frame_key_separates_radius_from_size_and_scale_bits() {
        // 位域互不重叠：半径上限 40px（40000 milli）只占低 16 位，缩放 12 位
        // （≤4095，含 100%/125%/150%/200%/300%），最大化占 1 位；常见尺寸/缩放
        // 不会与半径碰撞，也不会因为高位溢出退化成恒等。
        for width in [240u32, 944, 1280, 1920, 3440] {
            for height in [96u32, 608, 820, 1040, 1440] {
                for scale in [1.0f64, 1.25, 1.5, 2.0] {
                    let square = frame_key(0.0, width, height, scale, true);
                    let rounded = frame_key(18.0, width, height, scale, false);
                    assert_ne!(square, rounded, "{width}x{height}@{scale}");
                }
            }
        }
    }

    #[test]
    fn destroyed_window_resets_frame_state() {
        // 销毁清理：指纹归零后，同一个句柄被系统复用也不会误判「参数没变」。
        let key = frame_key(18.0, 1280, 820, 1.25, false);
        WORKBENCH_FRAME_KEY.store(key, Ordering::Relaxed);
        WORKBENCH_CORNER_MILLI.store(4_000, Ordering::Relaxed);
        reset_workbench_frame_state();
        assert_eq!(WORKBENCH_FRAME_KEY.load(Ordering::Relaxed), 0);
        assert_eq!(
            WORKBENCH_CORNER_MILLI.load(Ordering::Relaxed),
            2_000,
            "新窗口必须先回到圆弧，等前端确认 corner-shape 支持后再切超椭圆"
        );
    }

    #[test]
    fn frame_key_separates_circle_from_continuous_corner() {
        // 角部曲线必须进入指纹：否则切换预设（圆弧 ↔ 连续圆角）时缓存命中，
        // 窗口会保留上一形态的角部支撑像素（实测两者相差 8–9 物理像素）。
        let circle = frame_key_with_corner(22.0, 2.0, 1280, 820, 1.25, false);
        let squircle = frame_key_with_corner(22.0, 4.0, 1280, 820, 1.25, false);
        assert_ne!(circle, squircle, "曲线变化必须重建区域");
        assert_eq!(
            circle,
            frame_key(22.0, 1280, 820, 1.25, false),
            "不传曲线时沿用圆弧指纹，保证既有调用方语义不变"
        );
        assert_eq!(
            squircle,
            frame_key_with_corner(22.0, 4.0004, 1280, 820, 1.25, false),
            "浮点噪声不应触发重建"
        );
    }

    #[test]
    fn workbench_corner_clamps_to_supported_range() {
        for (input, expected) in [
            (4.0, 4.0),
            (2.0, 2.0),
            (1.0, 2.0),
            (9.0, 6.0),
            (f64::NAN, 2.0),
            (f64::INFINITY, 6.0),
        ] {
            WORKBENCH_CORNER_MILLI.store((input * 1000.0) as u32, Ordering::Relaxed);
            let got = workbench_corner();
            assert!(
                (got - expected).abs() < 0.011,
                "corner {input} 期望 ~{expected}，实得 {got}"
            );
        }
        WORKBENCH_CORNER_MILLI.store(2_000, Ordering::Relaxed);
    }

}