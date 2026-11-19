//! 全局快速捕获（v0.7）：常驻静态窗口 + 生命周期 + IPC 命令。
//!
//! 设计要点（对应 PLAN 第 2、4、5 节）：
//! - **窗口复用**：`capture` 窗口在 `tauri.conf.json` 声明、启动即创建并隐藏，
//!   唤起只做定位 + show + 激活，隐藏只做 hide——不存在反复创建/销毁的
//!   WebView 泄漏，隐藏后也没有任何轮询或定时器。
//! - **显示时序**：`tao` 的 `set_visible` 经主线程队列异步生效，紧跟其后的
//!   `set_focus()` 会读到「尚不可见」而直接返回（旧实现在这里丢焦点）。现在显示
//!   流程分三步：排队 show → 有界等待 `IsWindowVisible` → 直接 Win32 激活并核实
//!   前台句柄；不再依赖 `set_focus()` 的时序，也不用 tao 的 ALT 模拟。
//! - **生命周期**：隐藏/显示/激活/失焦由 `lifecycle` 状态机判定（纯函数、可单测）。
//!   只有真正进入过 `Active` 的窗口，后续失焦才自动隐藏；顶层窗口把焦点交给自己的
//!   WebView2 子窗口时会收到 `Focused(false)`，但窗口仍在前台——这种情况不隐藏。
//! - **定位**：记录唤起前的真实前台窗口（仅运行时内存，绝不落库），优先在
//!   它所在显示器的工作区居中；取不到退回光标所在显示器，再退回主显示器。
//!   工作区为物理像素（已排除任务栏），逻辑尺寸 × scale_factor 换算；
//!   工作区比窗口还小时先缩小窗口，保证整体不越界（多显示器/多 DPI 均收敛）。
//! - **焦点恢复**：显式关闭（Escape / 关闭按钮 / 热键 toggle）恢复唤起前的前台
//!   窗口，单次尽力而为；失焦隐藏路径绝不抢焦点。
//! - **退出**：`request_exit` 中若窗口可见，emit `capture-flush-draft` 并最多
//!   等待 300ms（前端 `quick_capture_save_draft` 成功即 ack），不拖慢常规退出。
//! - **正文安全**：命令不打印捕获正文，错误信息也不回显正文。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::navigation::window_manager;

pub mod attachments;
pub mod lifecycle;
pub mod store;
pub mod voice;

use lifecycle::{Action, LifecycleState, Phase, Signal};

/// 窗口 label（与 tauri.conf.json / capabilities/capture.json 一致）。
pub const WINDOW_LABEL: &str = "capture";
/// 后端 → 捕获窗口：已唤起（前端重置输入/聚焦）。
pub const SUMMONED_EVENT: &str = "quick-capture-summoned";
/// 后端 → 捕获窗口：已隐藏（前端可清理临时状态）。
pub const HIDDEN_EVENT: &str = "quick-capture-hidden";
/// 后端 → 全应用：新建了收集箱条目/任务（主窗口刷新收集箱角标）。
pub const CREATED_EVENT: &str = "quick-capture-created";
/// 后端 → 捕获窗口：请立即落草稿（失焦隐藏与退出前各触发一次）。
pub const FLUSH_DRAFT_EVENT: &str = "capture-flush-draft";

/// 设计尺寸（逻辑像素，与 tauri.conf.json 的 width/height 一致）。
pub const WINDOW_WIDTH: f64 = 640.0;
pub const WINDOW_HEIGHT: f64 = 360.0;
/// 捕获卡片圆角（逻辑像素）：必须与 styles-capture.css 的 `--radius-capture`
/// 一致，`window_shape` 按同一半径裁剪原生窗口，否则外阴影/圆角会错位。
const CAPTURE_RADIUS: f64 = 16.0;
/// 退出前等待前端落草稿的上限（毫秒）：有界，避免拖慢退出。
pub const FLUSH_WAIT_MS: u64 = 300;
/// 等待草稿 ack 的轮询步长（毫秒）。
const FLUSH_POLL_MS: u64 = 10;
/// 等待窗口真正可见的上限（毫秒）：`show()` 只是把请求排进主线程队列。
const REVEAL_WAIT_MS: u64 = 400;
/// 激活后核实前台句柄的上限（毫秒）：只做一次有界核实，不循环抢焦点。
const FOCUS_VERIFY_MS: u64 = 240;
/// 有界核实的轮询步长（毫秒）。
const FOCUS_POLL_MS: u64 = 15;

/// 唤起前的前台窗口句柄（仅运行时内存，绝不落库；隐藏后清空）。
static PREV_FOREGROUND: Mutex<Option<isize>> = Mutex::new(None);
/// 退出前草稿是否已落盘（`quick_capture_save_draft` 成功后置位）。
static DRAFT_FLUSHED: AtomicBool = AtomicBool::new(false);
/// 窗口生命周期（单窗口，进程内唯一）。
static LIFECYCLE: Mutex<LifecycleState> = Mutex::new(LifecycleState::initial());

fn capture_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn prev_foreground() -> std::sync::MutexGuard<'static, Option<isize>> {
    PREV_FOREGROUND.lock().unwrap_or_else(|e| e.into_inner())
}

fn lifecycle() -> std::sync::MutexGuard<'static, LifecycleState> {
    LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 当前阶段（诊断/事件判定用快照）。
pub fn phase() -> Phase {
    lifecycle().phase
}

/// 推进生命周期并返回动作。
fn advance(signal: Signal) -> Action {
    let mut guard = lifecycle();
    let (next, action) = lifecycle::step(*guard, signal);
    if next != *guard {
        tracing::debug!(
            from = ?guard.phase,
            to = ?next.phase,
            signal = ?signal,
            attempts = next.attempts,
            "快速捕获生命周期"
        );
    }
    *guard = next;
    action
}

fn hwnd_of(win: &tauri::WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

fn is_foreground(hwnd: isize) -> bool {
    hwnd != 0 && window_manager::foreground_window() == hwnd
}

// ── 定位（纯函数，可单测）──────────────────────────────────

/// 计算捕获窗口的物理位置与尺寸。
///
/// - 逻辑尺寸按 `wa.scale` 换算为物理像素（DPI 适配）；
/// - 在目标显示器工作区内居中（工作区已排除任务栏）；
/// - 工作区比窗口还小时先缩小窗口，保证整体不越界（极端小屏/缩放场景）。
pub fn place_capture(
    wa: &window_manager::MonitorWorkArea,
    size_logical: (f64, f64),
) -> (i32, i32, i32, i32) {
    let scale = if wa.scale.is_finite() && wa.scale > 0.0 {
        wa.scale
    } else {
        1.0
    };
    let mut mw = (size_logical.0 * scale).round() as i32;
    let mut mh = (size_logical.1 * scale).round() as i32;
    if wa.w > 0 {
        mw = mw.min(wa.w);
    }
    if wa.h > 0 {
        mh = mh.min(wa.h);
    }
    mw = mw.max(1);
    mh = mh.max(1);
    let x = wa.x + ((wa.w - mw) / 2).max(0);
    let y = wa.y + ((wa.h - mh) / 2).max(0);
    (x, y, mw, mh)
}

/// 光标所在显示器的工作区；取不到返回 None。
fn cursor_monitor(app: &AppHandle) -> Option<window_manager::MonitorWorkArea> {
    let cursor = app.cursor_position().ok()?;
    let from_point = app.monitor_from_point(cursor.x, cursor.y).ok().flatten();
    let monitor = from_point.or_else(|| {
        app.available_monitors()
            .ok()
            .and_then(|mons| {
                mons.into_iter().find(|m| {
                    let (p, s) = (m.position(), m.size());
                    cursor.x >= p.x as f64
                        && cursor.x < (p.x + s.width as i32) as f64
                        && cursor.y >= p.y as f64
                        && cursor.y < (p.y + s.height as i32) as f64
                })
            })
            .or_else(|| app.primary_monitor().ok().flatten())
    })?;
    Some(window_manager::monitor_work_area(&monitor))
}

/// 目标显示器工作区：唤起前前台窗口所在显示器 → 光标所在显示器 → 主显示器。
fn target_area(app: &AppHandle) -> Option<window_manager::MonitorWorkArea> {
    if let Some(hwnd) = *prev_foreground() {
        if let Some(area) = window_manager::monitor_of_window(app, hwnd) {
            return Some(area);
        }
    }
    if let Some(area) = cursor_monitor(app) {
        return Some(area);
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| window_manager::monitor_work_area(&m))
}

// ── 窗口生命周期 ────────────────────────────────────────────

/// 打开快速捕获窗口的真实结果。
///
/// `visible` 为 true 表示窗口已显示；`focused` 为 false 时前端应提示
/// 「已显示但系统未允许自动聚焦」，不能误报为打开失败。窗口不存在或 show 失败
/// 由命令返回错误，前端据此给出可操作反馈。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCaptureShowResult {
    pub visible: bool,
    pub focused: bool,
    pub focus_error: Option<String>,
}

/// 隐藏结果：前端据此区分「已收起」与「本来就不可见」，并可以对失败给出反馈。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCaptureHideResult {
    pub hidden: bool,
    pub already_hidden: bool,
}

/// 热键入口（Ctrl+Shift+Space）：
/// - 已在前台 → 收起（toggle）；
/// - 已可见但不在前台 → 只做激活，不重建、不收起；
/// - 隐藏 → 走与「快速记录」相同的显示路径。
pub fn toggle(app: &AppHandle) {
    let Some(win) = capture_window(app) else {
        tracing::warn!(window = WINDOW_LABEL, "快速捕获窗口不存在，忽略热键");
        return;
    };
    if win.is_visible().unwrap_or(false) {
        if hwnd_of(&win).is_some_and(is_foreground) {
            if let Err(e) = hide_capture(app, true) {
                tracing::warn!("快速捕获收起失败: {e}");
            }
            return;
        }
    }
    // 激活/显示要等待窗口可见（有界），放到异步任务，不阻塞热键回调。
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = show(&handle).await {
            tracing::warn!("快速捕获窗口显示失败: {e}");
        }
    });
}

/// 显示并在有界时间内尝试激活。
///
/// 已可见时只补充激活（不重建、不收起）；显示失败如实返回错误，激活失败只影响
/// `focused` 字段——窗口仍然可见可用，前端提示用户点击输入区继续。
pub async fn show(app: &AppHandle) -> AppResult<QuickCaptureShowResult> {
    let win = capture_window(app).ok_or_else(|| AppError::NotFound("快速捕获窗口不存在".into()))?;
    let already_visible = win.is_visible().unwrap_or(false);
    // 本轮显示是否已获得一次激活预算（由生命周期状态机发放）
    let mut visible_action = Action::None;

    if !already_visible {
        // 记录唤起前的真实前台窗口（仅运行时内存；无效/本进程时为 None）
        *prev_foreground() = window_manager::foreground_hwnd();
        // Hidden → Showing：重置本轮激活预算（不在此处激活，等窗口真正可见）
        let _ = advance(Signal::Show);
        if let Some(area) = target_area(app) {
            let (x, y, w, h) = place_capture(&area, (WINDOW_WIDTH, WINDOW_HEIGHT));
            // 尺寸只在需要时设置，避免每次唤起都触发前端 resize
            let current = win
                .outer_size()
                .ok()
                .map(|s| (s.width as i32, s.height as i32));
            if current != Some((w, h)) {
                let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
            }
            let _ = win.set_position(PhysicalPosition::new(x, y));
            tracing::debug!(x, y, w, h, "快速捕获窗口定位");
        }
        // 区域必须在每次显示前按最终尺寸重算：尺寸变化会重置窗口区域，
        // 不重算会让原生阴影/裁剪沿用上一帧的圆角矩形。
        crate::window_shape::apply_with_radius(&win, CAPTURE_RADIUS);
        let _ = win.unminimize();
        // 只有 show 失败才算「窗口打开失败」；定位/尺寸失败仍尝试显示并如实报告焦点状态。
        win.show().map_err(AppError::Tauri)?;
        // 先通知前端恢复草稿/聚焦，再等窗口可见：DOM 焦点与原生激活互不依赖。
        let _ = app.emit_to(WINDOW_LABEL, SUMMONED_EVENT, ());
    } else {
        // 已可见：Show 在可见阶段等价于一次补激活（受预算限制）。
        visible_action = advance(Signal::Show);
        let _ = win.unminimize();
        let _ = app.emit_to(WINDOW_LABEL, SUMMONED_EVENT, ());
    }

    let hwnd = hwnd_of(&win);
    let Some(hwnd) = hwnd else {
        return Ok(QuickCaptureShowResult {
            visible: true,
            focused: false,
            focus_error: Some("无法获取窗口句柄，请点击输入区继续输入".into()),
        });
    };

    if !already_visible {
        // 等真正可见：tao 的 show 是主线程队列异步生效的。
        reveal_wait(hwnd, Duration::from_millis(REVEAL_WAIT_MS)).await;
        visible_action = advance(Signal::Revealed);
    }

    // 只在状态机发放了预算时才真正调用 SetForegroundWindow（每轮最多 2 次）。
    let focused = if visible_action == Action::AttemptActivation {
        activate_and_verify(hwnd).await
    } else {
        is_foreground(hwnd)
    };
    if focused {
        advance(Signal::FocusGained);
    }
    Ok(QuickCaptureShowResult {
        visible: true,
        focused,
        focus_error: if focused {
            None
        } else {
            Some("系统未允许自动聚焦，请点击输入区继续输入".into())
        },
    })
}

/// 发一次激活请求并做有界核实（**不**推进生命周期，调用方负责领取预算）。
///
/// 预算由生命周期状态机控制（每轮显示最多 `MAX_ACTIVATION_ATTEMPTS` 次），
/// 因此这里即使被重复调用也不会无界抢焦点。
async fn activate_and_verify(hwnd: isize) -> bool {
    if is_foreground(hwnd) {
        return true;
    }
    // 激活请求本身是极快的同步 Win32 调用；核实靠有界轮询，不在命令线程长阻塞。
    let accepted = window_manager::activate_window_now(hwnd);
    if !accepted && !is_foreground(hwnd) {
        return false;
    }
    let deadline = Instant::now() + Duration::from_millis(FOCUS_VERIFY_MS);
    while Instant::now() < deadline {
        if is_foreground(hwnd) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(FOCUS_POLL_MS)).await;
    }
    is_foreground(hwnd)
}

/// 有界等待窗口真正可见（`IsWindowVisible`）：只用于 show 之后的一次确认。
async fn reveal_wait(hwnd: isize, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if window_visible(hwnd) {
            return;
        }
        if Instant::now() >= deadline {
            tracing::warn!("快速捕获窗口在限定时间内未确认可见，继续尝试激活");
            return;
        }
        tokio::time::sleep(Duration::from_millis(FOCUS_POLL_MS)).await;
    }
}

#[cfg(windows)]
fn window_visible(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    unsafe { IsWindowVisible(hwnd as HWND) != 0 }
}

#[cfg(not(windows))]
fn window_visible(_hwnd: isize) -> bool {
    true
}

/// 隐藏捕获窗口（幂等）。
///
/// `restore_focus = true`（用户主动关闭/热键收起）时，仅当隐藏前前台确实是捕获
/// 窗口才把焦点还给唤起前的前台窗口；自动失焦隐藏传 false，绝不抢焦点。
/// 重复调用（已经隐藏 / 正在隐藏）返回 `already_hidden = true`，不会重复执行。
pub fn hide_capture(app: &AppHandle, restore_focus: bool) -> AppResult<QuickCaptureHideResult> {
    let win = capture_window(app).ok_or_else(|| AppError::NotFound("快速捕获窗口不存在".into()))?;
    let action = advance(if restore_focus {
        Signal::Dismiss
    } else {
        Signal::FocusLost
    });
    let Action::Hide { restore_focus } = action else {
        // 已经隐藏 / 正在关闭：幂等返回，不重复 hide、不重复恢复焦点
        return Ok(QuickCaptureHideResult {
            hidden: false,
            already_hidden: true,
        });
    };
    if !win.is_visible().unwrap_or(false) {
        advance(Signal::Hidden);
        return Ok(QuickCaptureHideResult {
            hidden: false,
            already_hidden: true,
        });
    }
    // 隐藏即释放麦克风：即使前端来不及 stop，听写会话也不在后台空转。
    if let Some(voice) = app.try_state::<Arc<voice::VoiceInput>>() {
        voice.stop_async();
    }
    // 必须在 hide 之前判断：hide 之后前台必然易主，按字面判断永远不会成立。
    let was_foreground = hwnd_of(&win).is_some_and(is_foreground);

    win.hide().map_err(|e| {
        // hide 失败：回滚到可用状态，让用户还能看到窗口并再次尝试关闭。
        advance(Signal::Hidden);
        AppError::Tauri(e)
    })?;
    advance(Signal::Hidden);

    let prev = prev_foreground().take();
    if restore_focus && was_foreground {
        if let Some(hwnd) = prev {
            if hwnd != 0 {
                // 单次尽力恢复；失败静默（不循环重试、不弹错误）
                let _ = window_manager::focus_window(hwnd);
            }
        }
    }
    let _ = app.emit_to(WINDOW_LABEL, HIDDEN_EVENT, ());
    Ok(QuickCaptureHideResult {
        hidden: true,
        already_hidden: false,
    })
}

/// 启动时挂接捕获窗口事件（只注册一次）：真实失焦隐藏、关闭改为隐藏。
pub fn init(app: &AppHandle) {
    let Some(win) = capture_window(app) else {
        tracing::warn!(window = WINDOW_LABEL, "快速捕获窗口未创建，跳过事件挂接");
        return;
    };
    // 先按最终卡片半径建立原生区域，再挂原生伴随阴影；顺序反了会让阴影
    // 首帧按矩形窗口绘制，出现四角方形阴影。
    crate::window_shape::apply_with_radius(&win, CAPTURE_RADIUS);
    #[cfg(windows)]
    crate::window_shadow::attach(&win);
    // 头部拖拽相位监视（与微件同一协议）：松手瞬间结束前端 grabbing 光标会话。
    // init 在 setup（主线程）执行，子类化可直接安装；drag_watch 自身幂等。
    if let Ok(hwnd) = win.hwnd() {
        crate::drag_watch::install(app, hwnd.0 as isize, WINDOW_LABEL);
    }
    let handle = app.clone();
    let shape_win = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(true) => {
            advance(Signal::FocusGained);
        }
        tauri::WindowEvent::Focused(false) => {
            let Some(win) = capture_window(&handle) else {
                return;
            };
            if !win.is_visible().unwrap_or(false) {
                return;
            }
            // WebView2 子窗口接管焦点时，顶层窗口会收到 WM_KILLFOCUS（tao 抛
            // Focused(false)），但窗口仍在前台、仍能输入。只看生命周期会在
            // Showing/AwaitingFocus 阶段拦住它；这里再用前台句柄做一次事实核对，
            // 避免「点一下输入框窗口就消失」。
            if hwnd_of(&win).is_some_and(is_foreground) {
                return;
            }
            // 生命周期闸门：只有进入过 Active 之后的真实失焦才自动隐藏。
            if !lifecycle().auto_hide_allowed() {
                return;
            }
            // 先通知前端落草稿，再隐藏；不抢回焦点（用户已切走）
            let _ = handle.emit_to(WINDOW_LABEL, FLUSH_DRAFT_EVENT, ());
            if let Err(e) = hide_capture(&handle, false) {
                tracing::warn!("快速捕获失焦隐藏失败: {e}");
            }
        }
        tauri::WindowEvent::Resized(_) => {
            // 系统缩放/工作区过小时窗口尺寸会被钳制；每次尺寸变化重算区域，
            // 保证原生阴影轮廓一直贴合卡片圆角。
            crate::window_shape::apply_with_radius(&shape_win, CAPTURE_RADIUS);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // 窗口常驻复用：关闭 = 隐藏并恢复原前台窗口，不销毁 WebView
            api.prevent_close();
            if let Err(e) = hide_capture(&handle, true) {
                tracing::warn!("快速捕获关闭失败: {e}");
            }
        }
        _ => {}
    });
}

/// 退出前落草稿：仅当捕获窗口可见时执行，emit 后最多等待 `FLUSH_WAIT_MS`，
/// 常规退出（窗口未显示）立即返回，不拖慢退出流程。
pub async fn flush_draft_before_exit(app: &AppHandle) {
    let Some(win) = capture_window(app) else {
        return;
    };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    DRAFT_FLUSHED.store(false, Ordering::SeqCst);
    if app.emit_to(WINDOW_LABEL, FLUSH_DRAFT_EVENT, ()).is_err() {
        tracing::warn!(
            window = WINDOW_LABEL,
            "退出前通知快速捕获落草稿失败，继续退出"
        );
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(FLUSH_WAIT_MS);
    while Instant::now() < deadline {
        if DRAFT_FLUSHED.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(FLUSH_POLL_MS)).await;
    }
    if !DRAFT_FLUSHED.load(Ordering::SeqCst) {
        tracing::warn!(
            window = WINDOW_LABEL,
            "退出前快速捕获草稿落盘等待超时，继续退出"
        );
    }
}

// ── 命令（参数 camelCase，返回 snake_case JSON）──────────────

#[tauri::command]
pub fn quick_capture_state(db: State<'_, Arc<Db>>) -> AppResult<store::CaptureState> {
    store::state(&db)
}

#[tauri::command]
pub fn quick_capture_save_draft(
    db: State<'_, Arc<Db>>,
    kind: String,
    content: String,
) -> AppResult<store::DraftSaved> {
    let saved = store::save_draft(&db, &kind, &content)?;
    // 退出前等待的 ack：只有真正写库成功才置位
    DRAFT_FLUSHED.store(true, Ordering::SeqCst);
    Ok(saved)
}

#[tauri::command]
pub fn quick_capture_clear_draft(
    db: State<'_, Arc<Db>>,
    files: State<'_, Arc<attachments::CaptureFiles>>,
) -> AppResult<()> {
    store::clear_draft(&db, &files)
}

#[tauri::command]
pub fn quick_capture_set_last_type(db: State<'_, Arc<Db>>, kind: String) -> AppResult<()> {
    store::set_last_type(&db, &kind)
}

#[tauri::command]
pub fn quick_capture_submit(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    input: store::SubmitCaptureInput,
) -> AppResult<store::SubmitCaptureResult> {
    let result = store::submit(&db, input)?;
    if !result.duplicate {
        let _ = app.emit(
            CREATED_EVENT,
            serde_json::json!({
                "kind": result.kind,
                "id": result.id,
                "task_id": result.task_id,
                "status": result.status,
            }),
        );
    }
    Ok(result)
}

#[tauri::command]
pub fn quick_capture_list(
    db: State<'_, Arc<Db>>,
    status: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Vec<store::CaptureItem>> {
    store::list(&db, status.as_deref(), limit, offset)
}

#[tauri::command]
pub fn quick_capture_mark_handled(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<store::CaptureItem> {
    store::mark_handled(&db, &id)
}

#[tauri::command]
pub fn quick_capture_delete(
    db: State<'_, Arc<Db>>,
    files: State<'_, Arc<attachments::CaptureFiles>>,
    id: String,
) -> AppResult<()> {
    store::delete(&db, &id, &files)
}

#[tauri::command]
pub fn quick_capture_convert_to_task(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<store::CaptureItem> {
    let item = store::convert_to_task(&db, &id)?;
    let _ = app.emit(
        CREATED_EVENT,
        serde_json::json!({
            "kind": item.kind,
            "id": item.id,
            "task_id": item.task_id,
            "status": item.status,
        }),
    );
    Ok(item)
}

/// 显式打开快速捕获窗口（收集箱「+ 快速记录」）：已打开时补充激活，不切换为隐藏。
#[tauri::command]
pub async fn quick_capture_show(app: AppHandle) -> AppResult<QuickCaptureShowResult> {
    show(&app).await
}

/// 只做激活（前端在窗口已显示但未获得键盘焦点时调用，例如用户点击输入区）。
#[tauri::command]
pub async fn quick_capture_focus(app: AppHandle) -> AppResult<bool> {
    let win = capture_window(&app).ok_or_else(|| AppError::NotFound("快速捕获窗口不存在".into()))?;
    let hwnd =
        hwnd_of(&win).ok_or_else(|| AppError::Unavailable("无法获取窗口句柄".into()))?;
    if !win.is_visible().unwrap_or(false) {
        return Ok(false);
    }
    let focused = if advance(Signal::Activate) == Action::AttemptActivation {
        activate_and_verify(hwnd).await
    } else {
        is_foreground(hwnd)
    };
    if focused {
        advance(Signal::FocusGained);
    }
    Ok(focused)
}

/// 前端主动隐藏（Escape/关闭按钮/保存成功）：恢复唤起前的前台窗口。
/// 失败如实返回错误，前端给出可理解反馈，不静默吞掉。
#[tauri::command]
pub fn quick_capture_hide(app: AppHandle) -> AppResult<QuickCaptureHideResult> {
    hide_capture(&app, true)
}

// ── 图片附件命令 ───────────────────────────────────────────

/// 添加一张粘贴图片（前端已在 canvas 侧转成 PNG 并限制尺寸）。
///
/// 解码/编码放到 blocking 线程池：2MB 的截图解码 + 缩略图约几十毫秒，
/// 不应占用 IPC/主线程。
#[tauri::command]
pub async fn quick_capture_add_attachment(
    db: State<'_, Arc<Db>>,
    files: State<'_, Arc<attachments::CaptureFiles>>,
    data_base64: String,
    mime: String,
) -> AppResult<attachments::CaptureAttachment> {
    let db = Arc::clone(&db);
    let files = Arc::clone(&files);
    tauri::async_runtime::spawn_blocking(move || {
        attachments::add(&db, &files, &data_base64, &mime)
    })
    .await
    .map_err(|e| AppError::Unavailable(format!("图片处理线程异常: {e}")))?
}

#[tauri::command]
pub fn quick_capture_remove_attachment(
    db: State<'_, Arc<Db>>,
    files: State<'_, Arc<attachments::CaptureFiles>>,
    id: String,
) -> AppResult<()> {
    attachments::remove_draft(&db, &files, &id)
}

/// 缩略图 data URL（列表与草稿预览；按 ID 回查数据库，路径不来自前端）。
#[tauri::command]
pub fn quick_capture_attachment_thumb(
    db: State<'_, Arc<Db>>,
    files: State<'_, Arc<attachments::CaptureFiles>>,
    id: String,
) -> AppResult<Option<String>> {
    attachments::thumb_data_url(&db, &files, &id)
}

/// 原图 data URL（大图预览）。
#[tauri::command]
pub fn quick_capture_attachment_preview(
    db: State<'_, Arc<Db>>,
    files: State<'_, Arc<attachments::CaptureFiles>>,
    id: String,
) -> AppResult<Option<String>> {
    attachments::preview_data_url(&db, &files, &id)
}

/// 启动语音输入（听写模式）：成功后在 capture 窗口收到 capture-voice-* 事件。
/// 阻塞等待工作线程回包，因此放到 blocking 线程池，不占用 IPC/主线程。
#[tauri::command]
pub async fn quick_capture_voice_start(
    app: AppHandle,
    voice: State<'_, Arc<voice::VoiceInput>>,
) -> AppResult<voice::VoiceStartResult> {
    let voice = Arc::clone(&voice);
    tauri::async_runtime::spawn_blocking(move || voice.start(&app).map_err(|e| e.into_app_error()))
        .await
        .map_err(|e| AppError::Unavailable(format!("语音输入线程异常: {e}")))?
}

/// 停止语音输入并等待会话关闭（幂等；未启动过时返回空列表）。
/// 返回值是停止收尾期间才定稿的片段（StopAsync 会补发最后一批结果），
/// 前端在 stopping 相位追加进正文，避免「说完立刻点停止」丢最后一句。
#[tauri::command]
pub async fn quick_capture_voice_stop(
    voice: State<'_, Arc<voice::VoiceInput>>,
) -> AppResult<Vec<String>> {
    let voice = Arc::clone(&voice);
    tauri::async_runtime::spawn_blocking(move || voice.stop().map_err(|e| e.into_app_error()))
        .await
        .map_err(|e| AppError::Unavailable(format!("语音输入线程异常: {e}")))?
}

/// 语音隐私策略未接受时的恢复入口：打开 Windows「语音」隐私设置页。
/// 是否开启「在线语音识别」由用户决定，应用不修改系统隐私设置。
#[tauri::command]
pub fn quick_capture_open_speech_settings(app: AppHandle) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("ms-settings:privacy-speech", None::<&str>)
        .map_err(|e| {
            AppError::Validation(format!(
                "无法打开设置，请手动进入「设置 > 隐私和安全性 > 语音」：{e}"
            ))
        })
}

// ── 单测 ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: i32, y: i32, w: i32, h: i32, scale: f64) -> window_manager::MonitorWorkArea {
        window_manager::MonitorWorkArea { x, y, w, h, scale }
    }

    #[test]
    fn centers_in_primary_work_area() {
        // 1920x1080 屏去掉 48px 任务栏：1920x1032
        let (x, y, w, h) = place_capture(&area(0, 0, 1920, 1032, 1.0), (640.0, 360.0));
        assert_eq!((w, h), (640, 360));
        assert_eq!(x, (1920 - 640) / 2);
        assert_eq!(y, (1032 - 360) / 2);
    }

    #[test]
    fn secondary_monitor_offsets_by_work_area_origin() {
        let (x, y, w, h) = place_capture(&area(2560, 0, 1920, 1032, 1.0), (640.0, 360.0));
        assert_eq!((x, y), (2560 + 640, 336));
        assert_eq!((w, h), (640, 360));
    }

    #[test]
    fn scales_by_dpi() {
        // 150% 缩放：逻辑 640x360 → 物理 960x540
        let (x, y, w, h) = place_capture(&area(0, 0, 2560, 1392, 1.5), (640.0, 360.0));
        assert_eq!((w, h), (960, 540));
        assert_eq!(x, (2560 - 960) / 2);
        assert_eq!(y, (1392 - 540) / 2);
    }

    #[test]
    fn shrinks_when_work_area_too_small() {
        // 工作区比窗口还小：先缩小窗口，整体贴在工作区内
        let (x, y, w, h) = place_capture(&area(100, 50, 400, 200, 1.0), (640.0, 360.0));
        assert_eq!((w, h), (400, 200));
        assert_eq!((x, y), (100, 50));
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let (x, y, w, h) = place_capture(&area(0, 0, 1920, 1032, scale), (640.0, 360.0));
            assert_eq!((w, h), (640, 360), "scale={scale} 应回退 1.0");
            assert_eq!((x, y), (640, 336));
        }
    }

    #[test]
    fn show_result_serializes_focus_error_as_camel_case() {
        let value = serde_json::to_value(QuickCaptureShowResult {
            visible: true,
            focused: false,
            focus_error: Some("foreground lock".into()),
        })
        .unwrap();
        assert_eq!(value["visible"], true);
        assert_eq!(value["focused"], false);
        // 前端按 focusError 读取；snake_case 会让提示文案拿不到原因。
        assert_eq!(value["focusError"], "foreground lock");
        assert!(value.get("focus_error").is_none());
    }

    #[test]
    fn hide_result_serializes_as_camel_case() {
        let value = serde_json::to_value(QuickCaptureHideResult {
            hidden: true,
            already_hidden: false,
        })
        .unwrap();
        assert_eq!(value["hidden"], true);
        assert_eq!(value["alreadyHidden"], false);
    }

    /// 前端点关闭按钮时可能连点两次：第二次必须是幂等的 already_hidden，
    /// 不能重复 hide、也不能把焦点恢复执行两遍。
    #[test]
    fn lifecycle_repeated_dismiss_is_idempotent() {
        let mut state = LifecycleState::initial();
        for signal in [
            Signal::Show,
            Signal::Revealed,
            Signal::FocusGained,
            Signal::Dismiss,
        ] {
            state = lifecycle::step(state, signal).0;
        }
        let (next, action) = lifecycle::step(state, Signal::Dismiss);
        assert_eq!(next.phase, Phase::Closing);
        assert_eq!(action, Action::None);
    }

    /// 窗口显示但系统拒绝聚焦：保持可见，直到用户显式关闭。
    #[test]
    fn awaiting_focus_never_auto_hides() {
        let mut state = LifecycleState::initial();
        for signal in [Signal::Show, Signal::Revealed] {
            state = lifecycle::step(state, signal).0;
        }
        for _ in 0..5 {
            let (next, action) = lifecycle::step(state, Signal::FocusLost);
            state = next;
            assert_eq!(action, Action::None);
        }
        assert_eq!(state.phase, Phase::AwaitingFocus);
        let (next, action) = lifecycle::step(state, Signal::Dismiss);
        assert_eq!(next.phase, Phase::Closing);
        assert_eq!(action, Action::Hide { restore_focus: true });
    }
}
