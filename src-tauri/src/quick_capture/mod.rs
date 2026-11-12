//! 全局快速捕获（v0.7）：常驻静态窗口 + 生命周期 + IPC 命令。
//!
//! 设计要点（对应 PLAN 第 2、4、5 节）：
//! - **窗口复用**：`capture` 窗口在 `tauri.conf.json` 声明、启动即创建并隐藏，
//!   唤起只做定位 + show + focus，隐藏只做 hide——不存在反复创建/销毁的
//!   WebView 泄漏，隐藏后也没有任何轮询或定时器。
//! - **定位**：记录唤起前的真实前台窗口（仅运行时内存，绝不落库），优先在
//!   它所在显示器的工作区居中；取不到退回光标所在显示器，再退回主显示器。
//!   工作区为物理像素（已排除任务栏），逻辑尺寸 × scale_factor 换算；
//!   工作区比窗口还小时先缩小窗口，保证整体不越界（多显示器/多 DPI 均收敛）。
//! - **焦点**：`Focused(false)` 先通知前端落草稿再隐藏，不抢回焦点；显式关闭
//!   （Escape / 关闭按钮 / 热键 toggle）恢复唤起前的前台窗口，单次尽力而为，
//!   失败静默（Windows 前台锁拒绝时不弹错误、不循环重试）。
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

pub mod store;
pub mod voice;

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
/// 退出前等待前端落草稿的上限（毫秒）：有界，避免拖慢退出。
pub const FLUSH_WAIT_MS: u64 = 300;
/// 等待草稿 ack 的轮询步长（毫秒）。
const FLUSH_POLL_MS: u64 = 10;

/// 唤起前的前台窗口句柄（仅运行时内存，绝不落库；隐藏后清空）。
static PREV_FOREGROUND: Mutex<Option<isize>> = Mutex::new(None);
/// 是否正在执行 hide：防止 hide 触发的 `Focused(false)` 递归。
static HIDING: AtomicBool = AtomicBool::new(false);
/// 退出前草稿是否已落盘（`quick_capture_save_draft` 成功后置位）。
static DRAFT_FLUSHED: AtomicBool = AtomicBool::new(false);

fn capture_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn prev_foreground() -> std::sync::MutexGuard<'static, Option<isize>> {
    PREV_FOREGROUND.lock().unwrap_or_else(|e| e.into_inner())
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

/// 热键入口（Ctrl+Shift+Space）：
/// - 已可见且已聚焦 → 收起（toggle）；
/// - 已可见但未聚焦 → 只聚焦，不重建；
/// - 隐藏 → 记录前台窗口、定位、show + focus。
pub fn toggle(app: &AppHandle) {
    let Some(win) = capture_window(app) else {
        tracing::warn!(window = WINDOW_LABEL, "快速捕获窗口不存在，忽略热键");
        return;
    };
    if win.is_visible().unwrap_or(false) {
        if win.is_focused().unwrap_or(false) {
            hide_capture(app, true);
            return;
        }
        let _ = win.set_focus();
        let _ = app.emit_to(WINDOW_LABEL, SUMMONED_EVENT, ());
        return;
    }
    if let Err(e) = show(app) {
        tracing::warn!("快速捕获窗口显示失败: {e}");
    }
}

/// 显式打开快速捕获窗口（收集箱「+ 快速记录」等入口）：
/// 已可见时只聚焦，不因再次点击而收起；未可见时走与热键相同的定位/恢复草稿路径。
pub fn show(app: &AppHandle) -> AppResult<QuickCaptureShowResult> {
    let win = capture_window(app).ok_or_else(|| AppError::NotFound("快速捕获窗口不存在".into()))?;
    if win.is_visible().unwrap_or(false) {
        let _ = win.unminimize();
        let focus_error = win.set_focus().err().map(|e| e.to_string());
        let focused = win.is_focused().unwrap_or(false);
        let _ = app.emit_to(WINDOW_LABEL, SUMMONED_EVENT, ());
        return Ok(QuickCaptureShowResult {
            visible: true,
            focused,
            focus_error: if focused {
                None
            } else {
                Some(focus_error.unwrap_or_else(|| "系统前台锁阻止窗口自动聚焦".into()))
            },
        });
    }

    // 记录唤起前的真实前台窗口（仅运行时内存；无效/本进程时为 None）
    *prev_foreground() = window_manager::foreground_hwnd();
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
    let _ = win.unminimize();
    // 只有 show 失败才算「窗口打开失败」；定位/尺寸失败仍尝试显示并如实报告焦点状态。
    win.show().map_err(|e| AppError::Tauri(e))?;
    let focus_error = win.set_focus().err().map(|e| e.to_string());
    let focused = win.is_focused().unwrap_or(false);
    let _ = app.emit_to(WINDOW_LABEL, SUMMONED_EVENT, ());
    Ok(QuickCaptureShowResult {
        visible: true,
        focused,
        focus_error: if focused {
            None
        } else {
            Some(focus_error.unwrap_or_else(|| "系统前台锁阻止窗口自动聚焦".into()))
        },
    })
}

/// 隐藏捕获窗口。
///
/// `restore_focus = true` 时，仅当隐藏前前台确实是捕获窗口（用户从窗口内
/// 显式关闭/按热键收起）才把焦点还给唤起前的前台窗口；失焦隐藏路径传 false，
/// 用户已经切到别的应用，绝不抢焦点。恢复失败静默（Windows 前台锁）。
pub fn hide_capture(app: &AppHandle, restore_focus: bool) {
    let Some(win) = capture_window(app) else {
        return;
    };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    // 隐藏即释放麦克风：即使前端来不及 stop，听写会话也不在后台空转。
    if let Some(voice) = app.try_state::<Arc<voice::VoiceInput>>() {
        voice.stop_async();
    }
    // 必须在 hide 之前判断：hide 之后前台必然易主，按字面判断永远不会成立。
    let capture_hwnd = win.hwnd().ok().map(|h| h.0 as isize).unwrap_or(0);
    let was_foreground = capture_hwnd != 0 && window_manager::foreground_window() == capture_hwnd;

    HIDING.store(true, Ordering::SeqCst);
    let _ = win.hide();
    HIDING.store(false, Ordering::SeqCst);

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
}

/// 启动时挂接捕获窗口事件（只注册一次）：失焦落草稿后隐藏、关闭改为隐藏。
pub fn init(app: &AppHandle) {
    let Some(win) = capture_window(app) else {
        tracing::warn!(window = WINDOW_LABEL, "快速捕获窗口未创建，跳过事件挂接");
        return;
    };
    // 头部拖拽相位监视（与微件同一协议）：松手瞬间结束前端 grabbing 光标会话。
    // init 在 setup（主线程）执行，子类化可直接安装；drag_watch 自身幂等。
    if let Ok(hwnd) = win.hwnd() {
        crate::drag_watch::install(app, hwnd.0 as isize, WINDOW_LABEL);
    }
    let handle = app.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(false) => {
            // hide 自身触发的失焦：忽略（HIDING 期间由 hide_capture 统一处理）
            if HIDING.load(Ordering::SeqCst) {
                return;
            }
            let Some(win) = capture_window(&handle) else {
                return;
            };
            if !win.is_visible().unwrap_or(false) {
                return;
            }
            // 先通知前端落草稿，再隐藏；不抢回焦点（用户已切走）
            let _ = handle.emit_to(WINDOW_LABEL, FLUSH_DRAFT_EVENT, ());
            hide_capture(&handle, false);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // 窗口常驻复用：关闭 = 隐藏并恢复原前台窗口，不销毁 WebView
            api.prevent_close();
            hide_capture(&handle, true);
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
pub fn quick_capture_clear_draft(db: State<'_, Arc<Db>>) -> AppResult<()> {
    store::clear_draft(&db)
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
pub fn quick_capture_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    store::delete(&db, &id)
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

/// 显式打开快速捕获窗口（收集箱「+ 快速记录」）：已打开时聚焦，不切换为隐藏。
#[tauri::command]
pub fn quick_capture_show(app: AppHandle) -> AppResult<QuickCaptureShowResult> {
    show(&app)
}

/// 前端主动隐藏（Escape/关闭按钮）：恢复唤起前的前台窗口。
#[tauri::command]
pub fn quick_capture_hide(app: AppHandle) {
    hide_capture(&app, true);
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
}
