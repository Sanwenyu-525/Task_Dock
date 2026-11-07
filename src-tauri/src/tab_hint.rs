//! 极简标签悬停提示窗口（`tab-hint`）：独立透明 WebView，**不抢焦点、点击穿透**。
//!
//! 为什么不能画在主窗：极简标签的可见区只有 10×46（`SetWindowRgn`），
//! 主窗里的 TooltipLayer 气泡会被裁成残片；扩大主窗区域又是明令禁止的做法。
//! 因此提示与右键菜单一样走独立弹窗，只是更轻：
//!
//! - **不抢焦点**：窗口在 tauri.conf.json 里 `focus: false`（tao 据此加
//!   `WS_EX_NOACTIVATE`），这里也从不调用 `set_focus()`；
//! - **点击穿透**：`set_ignore_cursor_events(true)`（`WS_EX_TRANSPARENT`），
//!   鼠标永远落在下面的标签/桌面上，提示不可能拦截单击、拖动或右键；
//! - **先量后显**：主窗只发文字，本窗口的前端测量自然尺寸后回传
//!   `fit_tab_hint`，后端按实测尺寸收放 + 贴边定位 + 应用圆角区域，最后才
//!   `show()`——不存在「先弹默认宽度再缩」的跳动，也不会露到工作区外；
//! - **无轮询**：显示/隐藏完全由主窗的悬停、离开、按下、失焦、卸载事件驱动。
//!
//! ## 显示会话：代次（generation）
//!
//! 显示是三段式异步链路（show → 前端渲染/测量 → fit → 真显），必须能取消：
//! 鼠标离开、按下、标签恢复都会先 `hide`，而**在途的 fit 仍可能晚到**。
//! 因此每次 show/hide 都推进一个单调代次：
//!
//! - `show` 建新一代并把代次随事件下发（同文案也必须是新代次，否则前端不会重新测量）；
//! - `fit` 必须带回同代次才被接受，过期 fit 直接丢弃，**绝不让已隐藏的窗口重新出现**；
//! - `hide` 推进代次并清空目标，使所有在途请求失效；
//! - 窗口销毁同样推进代次，重建后不会沿用失效状态。
//!
//! 前端未就绪时的处理：Tauri 事件没有缓冲，WebView 启动早期 emit 会静默丢失。
//! 因此 `show` 在 `ready=false` 时只把请求**排队**，等前端在显示事件订阅兑现后
//! 调用 `tab_hint_ready` 再补发；不会提前用兜底尺寸显示一个没有文字的空提示条。
//!
//! ## 就绪三态（2026-11-07 round3）
//!
//! 后端可区分三种状态，不依赖固定延迟：
//! - **窗口已销毁/未创建**：`hint_window()` 为 None。`show` 直接返回 false（不置
//!   前端「已显示」标记）；`tab_hint_ready` 不置 ready（等重建后的新前端重新订阅）；
//! - **监听尚未就绪**（`ready=false`）：`show` 只更新代次/目标并排队，不 emit；
//! - **已就绪**（`ready=true`）：`show` 立即 emit，成功后清掉同代次排队载荷。
//!
//! `Destroyed` 事件把状态复位为「监听尚未就绪」并清空目标/排队载荷，重建窗口
//! 不会沿用失效会话。
//!
//! ## 命令执行模型（并发复核结论，2026-11-07 round3）
//!
//! 四个命令都是**同步**命令（非 `async`）。Tauri 会内联执行同步命令：wry 在
//! WebView2 的 `WebMessageReceived` / `WebResourceRequested` 回调里调用
//! `ipc_handler`（`wry-0.57.1/src/webview2/mod.rs` 的 `attach_ipc_handler` 与
//! `attach_custom_protocol_handler`），Tauri 在其中同步调用
//! `manager.run_invoke_handler(invoke)`（`tauri-2.12.5/src/webview/mod.rs` 的
//! `on_message`）。这两个回调都由创建 WebView2 的线程（Windows 主线程）投递，
//! 因此不同 WebView（主窗 / 提示窗）发出的 show/fit/hide **在同一线程上严格
//! 串行**；`reveal` 的「校验代次 → 调用窗口 API」之间不可能插入另一个命令或
//! `Destroyed` 事件。窗口 API 自身只是向事件循环投递消息，投递顺序与命令执行
//! 顺序一致，所以不会出现「旧 reveal 校验通过 → hide → 旧 show 执行」。
//!
//! 该结论依赖「命令保持同步」这一契约：若将来改成 `async fn`，Tauri 会把命令
//! 放到 async runtime 线程池（`respond_async`），上述串行性失效，必须改为提交
//! 序号或主线程封送。下面的交错单测锁定状态机层面的不变量。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};

use crate::tab_popups::{parse_edge, tab_rect_screen, ScreenRect};

pub const WINDOW_LABEL: &str = "tab-hint";
/// 后端 → 提示窗口：`{ id, text }`。前端必须带回 `id` 才能完成显示。
pub const SHOW_EVENT: &str = "tab-hint-show";
/// 提示条 CSS 圆角（逻辑像素）：与 `styles-tab-hint.css` 的 `border-radius: 8px` **相等**。
/// 不能比 CSS 大：区域是 CSS 圆弧的像素支撑形状，半径偏大会切进气泡四角的抗锯齿弧，
/// 表现为「角被削掉一圈」。比右键菜单（16px）小：提示条只有一行。
pub const HINT_RADIUS: f64 = 8.0;

/// 首次显示（前端还没回传尺寸）时的兜底逻辑尺寸：够放一句中文提示。
const DEFAULT_SIZE: (f64, f64) = (180.0, 28.0);
/// 尺寸合理区间：只防异常 IPC 值，不作为视觉上限。
const MIN_WIDTH: f64 = 40.0;
const MAX_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 18.0;
const MAX_HEIGHT: f64 = 80.0;
/// 文案长度上限（字符）：提示是一句话，超长只可能是异常输入。
const MAX_TEXT_CHARS: usize = 200;

/// 下发给提示窗口的显示请求：`id` 是本次显示会话的代次，前端必须原样带回。
#[derive(Clone, Debug, serde::Serialize)]
pub struct HintShow {
    pub id: u64,
    pub text: String,
}

/// 显示会话状态：代次 / 目标 / 自然尺寸 / 前端就绪**同一把锁**，任何一次读写
/// 都看到一致快照，不存在「目标已换、代次没换」这类跨锁半状态。
#[derive(Debug)]
struct HintState {
    generation: u64,
    target: Option<(ScreenRect, u8)>,
    natural: (f64, f64),
    ready: bool,
    /// 前端尚未就绪时暂存的显示请求：订阅兑现前的 emit 会静默丢失，
    /// 因此先排队，等 `tab_hint_ready` 再补发（不轮询、不重试）。
    pending: Option<HintShow>,
}

impl HintState {
    const fn new() -> Self {
        Self {
            generation: 0,
            target: None,
            natural: DEFAULT_SIZE,
            ready: false,
            pending: None,
        }
    }

    /// 新一次显示请求：推进代次并记录目标/待下发载荷，返回本次载荷。
    fn begin(&mut self, target: (ScreenRect, u8), text: String) -> HintShow {
        self.generation = self.generation.wrapping_add(1);
        self.target = Some(target);
        let payload = HintShow {
            id: self.generation,
            text,
        };
        self.pending = Some(payload.clone());
        payload
    }

    /// 结束当前会话（隐藏 / 销毁）：推进代次，作废所有在途 fit 与待发请求。
    fn end(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.target = None;
        self.pending = None;
    }

    /// 接受一次测量：只有代次仍有效才更新尺寸并允许显示。
    fn accept_fit(&mut self, id: u64, size: (f64, f64)) -> bool {
        if !self.is_current(id) {
            return false;
        }
        self.natural = size;
        true
    }

    fn is_current(&self, id: u64) -> bool {
        id != 0 && id == self.generation
    }

    /// 取走待下发载荷（就绪握手时调用一次）。
    fn take_pending(&mut self) -> Option<HintShow> {
        self.pending.take()
    }

    /// 已成功下发：只清掉同一代次的待发载荷，避免误删更新的一次 show。
    fn clear_pending(&mut self, id: u64) {
        if self.pending.as_ref().is_some_and(|p| p.id == id) {
            self.pending = None;
        }
    }
}

static STATE: Mutex<HintState> = Mutex::new(HintState::new());

fn state() -> std::sync::MutexGuard<'static, HintState> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn hint_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// 显示提示：记录标签矩形 → 通知前端渲染 → （前端未就绪时）用缓存尺寸先显示。
///
/// 返回是否真的进入了显示流程：前端据此维护「已显示」去重标记，
/// 避免后端提前返回（标签几何缺失等）时前端误以为已显示、之后再也不发请求。
pub fn show(app: &AppHandle, edge: &str, text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return false;
    }
    let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let Some(e) = parse_edge(edge) else {
        tracing::warn!(%edge, "极简标签提示：非法停靠边");
        return false;
    };
    let Some(tab) = tab_rect_screen(app, e) else {
        return false;
    };
    // 窗口不存在时不能返回“已受理”：前端会把「已显示」标记置真，之后
    // 悬停全部命中错误去重门（一次失败变成永久不弹）。
    if hint_window(app).is_none() {
        tracing::warn!("tab-hint 窗口不存在（未在 tauri.conf.json 声明？）");
        return false;
    }
    let (payload, ready) = {
        let mut s = state();
        let payload = s.begin((tab, e), text);
        (payload, s.ready)
    };
    if !ready {
        // 前端监听尚未兑现（WebView 启动早期）：只排队，等 tab_hint_ready
        // 补发。不能用缓存尺寸先显示——文字事件会丢，留下一个空提示条。
        tracing::debug!("极简标签提示：前端未就绪，显示请求已排队");
        return true;
    }
    let id = payload.id;
    match app.emit_to(WINDOW_LABEL, SHOW_EVENT, payload) {
        Ok(()) => {
            state().clear_pending(id);
            true
        }
        Err(e) => {
            tracing::warn!("极简标签提示：下发显示请求失败: {e}");
            // 事件没送达就无法完成 fit：结束会话，避免留下悬空目标
            hide(app);
            false
        }
    }
}

/// 按实测自然尺寸收放并显示（前端在渲染完成后调用一次）。
///
/// `id` 必须与当前代次一致：过期测量（show 之后已经 hide，或已被新的 show 取代）
/// 一律丢弃，不得让窗口重新显示。
pub fn fit(app: &AppHandle, id: u64, width: f64, height: f64) -> bool {
    if !width.is_finite() || !height.is_finite() {
        return false;
    }
    let size = (
        width.clamp(MIN_WIDTH, MAX_WIDTH),
        height.clamp(MIN_HEIGHT, MAX_HEIGHT),
    );
    if !state().accept_fit(id, size) {
        return false;
    }
    reveal(app, id)
}

/// `reveal` 的提交门：每次窗口 API 之间复核。
///
/// 代次仍是当前**且**目标仍在才允许继续提交显示；`hide`（清空目标）或新的
/// `show`（推进代次）之后，旧 reveal 一律止步——旧请求不能把已隐藏的窗口重新
/// 显示，也不能覆盖新会话的尺寸/位置。锁只在校验瞬间持有，窗口 API 全在锁外。
fn commit_allowed(s: &HintState, id: u64) -> bool {
    s.is_current(id) && s.target.is_some()
}

/// 真正把窗口放到标签旁并显示（无焦点、无动画、无延迟）。返回是否显示成功。
///
/// 锁只在取快照与**显示前最后一次校验**时短暂持有；tao 调用全部在锁外。
fn reveal(app: &AppHandle, id: u64) -> bool {
    let Some(win) = hint_window(app) else {
        tracing::warn!("tab-hint 窗口不存在（未在 tauri.conf.json 声明？）");
        return false;
    };
    let Some((tab, edge, size)) = ({
        let s = state();
        if !commit_allowed(&s, id) {
            return false;
        }
        s.target.map(|(tab, edge)| (tab, edge, s.natural))
    }) else {
        return false;
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    // 定位与右键菜单共用 `place_beside`：朝屏幕内部展开，不覆盖贴边标签
    let Some((x, y)) = crate::tab_popups::popup_position(app, edge, tab, size, scale) else {
        return false;
    };
    // 先定尺寸再定位：区域与圆角都按最终尺寸计算，显示时不会先出现一帧旧尺寸。
    if let Err(e) = win.set_size(LogicalSize::new(size.0, size.1)) {
        tracing::debug!("极简标签提示：设置尺寸失败 {e}");
        return false;
    }
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // 收放期间可能已有新的 show/hide：过期请求不得把窗口显示出来。
    if !commit_allowed(&state(), id) {
        return false;
    }
    crate::window_shape::apply_with_radius(&win, HINT_RADIUS);
    if !commit_allowed(&state(), id) {
        return false;
    }
    if let Err(e) = win.show() {
        tracing::warn!("显示极简标签提示失败: {e}");
        return false;
    }
    true
}

/// 隐藏：推进代次（作废在途 fit）→ 清空目标 → 隐藏窗口。
pub fn hide(app: &AppHandle) {
    state().end();
    if let Some(win) = hint_window(app) {
        let _ = win.hide();
    }
}

/// 启动时挂接：不抢焦点 + 点击穿透 + 尺寸变化重算圆角区域。
pub fn init(app: &AppHandle) {
    if let Some(win) = hint_window(app) {
        // 不抢焦点：只靠配置的 `focus:false` 不够——它只表示创建时不聚焦。
        // `set_focusable(false)` 把「不可聚焦」交给 tao 的窗口状态机，
        // show/set_size 重算样式时会保留 WS_EX_NOACTIVATE；手写 EXSTYLE 会被覆盖。
        if let Err(err) = win.set_focusable(false) {
            tracing::warn!("极简标签提示：设置不可聚焦失败（悬停可能抢焦点）: {err}");
        }
        // 提示永不接收鼠标：既不会挡住标签，也不会因命中测试抢走 hover
        if let Err(e) = win.set_ignore_cursor_events(true) {
            tracing::debug!("极简标签提示：点击穿透设置失败 {e}");
        }
        let w = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::Resized(_) => {
                crate::window_shape::apply_with_radius(&w, HINT_RADIUS);
            }
            tauri::WindowEvent::Destroyed => {
                if let Ok(h) = w.hwnd() {
                    crate::window_shape::forget_window(h.0 as isize);
                }
                let mut s = state();
                s.ready = false;
                s.end();
            }
            _ => {}
        });
    }
}

// ── 命令 ─────────────────────────────────────────────────────

#[tauri::command]
pub fn show_tab_hint(app: AppHandle, edge: String, text: String) -> bool {
    show(&app, &edge, &text)
}

#[tauri::command]
pub fn hide_tab_hint(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn fit_tab_hint(app: AppHandle, width: f64, height: f64, id: u64) -> bool {
    fit(&app, id, width, height)
}

/// 前端挂载完成：之后按实测尺寸显示（避免首帧用兜底尺寸抖动）。
///
/// 前端必须**等显示事件订阅兑现后**才调用本命令；这里会把就绪前排队的
/// 显示请求补发出去。补发失败则结束会话并隐藏，避免留下一个永远等不到
/// fit 的悬空目标，也避免前端「已显示」标记与真实状态失步。
///
/// 返回 true 表示就绪已生效；false 表示窗口已销毁/不存在（不标记就绪，
/// 重建后的新前端会重新订阅并再次调用）。
#[tauri::command]
pub fn tab_hint_ready(app: AppHandle) -> bool {
    // 窗口已销毁/未创建：此时置 ready 只会让后续 show 误以为事件能送达。
    // 保持「未就绪」，重建窗口后由新前端重新握手。
    if hint_window(&app).is_none() {
        tracing::warn!("极简标签提示：窗口不存在，忽略 ready");
        return false;
    }
    let pending = {
        let mut s = state();
        s.ready = true;
        s.take_pending()
    };
    let Some(payload) = pending else { return true };
    if let Err(e) = app.emit_to(WINDOW_LABEL, SHOW_EVENT, payload) {
        tracing::warn!("极简标签提示：补发显示请求失败: {e}");
        hide(&app);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> ScreenRect {
        ScreenRect {
            x: 0,
            y: 100,
            w: 10,
            h: 46,
        }
    }

    fn begin(s: &mut HintState) -> u64 {
        s.begin((rect(), 0), "提示".to_string()).id
    }

    #[test]
    fn show_fit_then_hide_is_the_happy_path() {
        let mut s = HintState::new();
        let id = begin(&mut s);
        assert!(s.is_current(id));
        assert!(s.accept_fit(id, (120.0, 26.0)));
        assert_eq!(s.natural, (120.0, 26.0));
        s.end();
        assert!(!s.is_current(id), "hide 之后旧请求必须失效");
    }

    #[test]
    fn fit_after_hide_is_rejected() {
        // show → hide → 旧 fit：绝不能把已隐藏的窗口重新显示出来
        let mut s = HintState::new();
        let id = begin(&mut s);
        s.end();
        assert!(!s.accept_fit(id, (120.0, 26.0)));
    }

    #[test]
    fn stale_fit_does_not_leak_into_the_next_show() {
        // show A → hide A → show B → 旧 fit A：不显示 B，也不改 B 的尺寸
        let mut s = HintState::new();
        let a = begin(&mut s);
        s.end();
        let b = begin(&mut s);
        assert!(!s.accept_fit(a, (999.0, 77.0)));
        assert_eq!(s.natural, DEFAULT_SIZE, "过期 fit 不得污染当前自然尺寸");
        assert!(s.accept_fit(b, (140.0, 30.0)));
        assert_eq!(s.natural, (140.0, 30.0));
    }

    #[test]
    fn consecutive_shows_only_accept_the_latest() {
        // 同文案重复悬停：每次 show 都是新代次，前端才会重新测量
        let mut s = HintState::new();
        let a = begin(&mut s);
        let b = begin(&mut s);
        assert_ne!(a, b);
        assert!(!s.accept_fit(a, (120.0, 26.0)));
        assert!(s.accept_fit(b, (130.0, 26.0)));
    }

    #[test]
    fn consecutive_hides_invalidate_in_flight_fit() {
        let mut s = HintState::new();
        let id = begin(&mut s);
        s.end();
        s.end();
        assert!(!s.accept_fit(id, (120.0, 26.0)));
        assert!(s.target.is_none());
    }

    #[test]
    fn fit_without_a_show_is_rejected() {
        // 代次 0 不是有效请求：id=0 的 fit 不能显示窗口
        let mut s = HintState::new();
        assert!(!s.accept_fit(0, (120.0, 26.0)));
    }

    // ── 就绪握手与排队（P2-3）────────────────────────────────

    #[test]
    fn show_before_ready_is_queued_for_the_ready_handshake() {
        // 前端订阅兑现前 emit 会静默丢失：必须先排队，就绪时补发一次。
        let mut s = HintState::new();
        assert!(!s.ready);
        let payload = s.begin((rect(), 0), "Agent 等待确认".to_string());
        assert_eq!(payload.id, 1);
        let pending = s.take_pending().expect("就绪前必须保留待下发载荷");
        assert_eq!(pending.id, payload.id);
        assert_eq!(pending.text, "Agent 等待确认");
        assert!(s.pending.is_none(), "补发后不得重复下发");
    }

    #[test]
    fn hide_discards_a_queued_show() {
        // show（排队）→ hide：补发时不得让已离开的提示重新显示
        let mut s = HintState::new();
        let _ = s.begin((rect(), 0), "提示".to_string());
        s.end();
        assert!(s.pending.is_none());
        assert!(s.take_pending().is_none());
    }

    #[test]
    fn newer_show_replaces_the_queued_payload() {
        let mut s = HintState::new();
        let a = s.begin((rect(), 0), "A".to_string());
        let b = s.begin((rect(), 0), "B".to_string());
        let pending = s.take_pending().expect("有排队请求");
        assert_eq!(pending.id, b.id);
        assert_ne!(a.id, b.id);
        assert!(!s.accept_fit(a.id, (120.0, 26.0)), "旧代次必须失效");
    }

    #[test]
    fn clearing_pending_only_affects_the_same_generation() {
        // 旧请求的成功回执迟到，不得删掉新请求的待发载荷
        let mut s = HintState::new();
        let a = s.begin((rect(), 0), "A".to_string());
        s.clear_pending(a.id);
        assert!(s.pending.is_none());
        let b = s.begin((rect(), 0), "B".to_string());
        s.clear_pending(a.id);
        assert_eq!(s.pending.as_ref().map(|p| p.id), Some(b.id));
    }

    // ── 显示提交的交错顺序（P2-4）────────────────────────────
    //
    // 真实命令在 WebView2 消息线程上严格串行（见模块文档的执行模型），这里用
    // 状态机把「快照 → hide/新 show → 提交」的顺序固定下来：无论窗口 API 何时
    // 投递，旧 reveal 都不能越过提交门重新显示窗口。

    #[test]
    fn hide_between_reveal_snapshot_and_commit_is_rejected() {
        let mut s = HintState::new();
        let id = begin(&mut s);
        assert!(commit_allowed(&s, id), "show 之后快照阶段应允许提交");
        s.end(); // hide 插在快照与提交之间
        assert!(!commit_allowed(&s, id), "hide 之后旧 reveal 不得再显示窗口");
        assert!(s.target.is_none());
    }

    #[test]
    fn old_reveal_cannot_override_a_new_show() {
        let mut s = HintState::new();
        let a = begin(&mut s);
        assert!(commit_allowed(&s, a));
        let b = begin(&mut s); // 旧 reveal 走到一半时来了新 show
        assert!(!commit_allowed(&s, a), "旧代次不能提交显示");
        assert!(commit_allowed(&s, b));
        assert!(s.accept_fit(b, (130.0, 28.0)));
    }

    #[test]
    fn hide_then_show_commits_only_the_new_session() {
        let mut s = HintState::new();
        let a = begin(&mut s);
        s.end();
        let b = begin(&mut s);
        assert!(!commit_allowed(&s, a));
        assert!(commit_allowed(&s, b));
        assert!(!s.accept_fit(a, (10.0, 10.0)), "旧 fit 仍被拒绝");
        assert!(s.accept_fit(b, (120.0, 26.0)));
    }

    #[test]
    fn hide_between_fit_accept_and_reveal_is_rejected() {
        // fit 已接受尺寸 → 提交前 hide：等价于 reveal 的两次提交门复核
        let mut s = HintState::new();
        let id = begin(&mut s);
        assert!(s.accept_fit(id, (120.0, 26.0)));
        assert!(commit_allowed(&s, id));
        s.end();
        assert!(!commit_allowed(&s, id));
    }

    #[test]
    fn repeated_hides_leave_no_committable_session() {
        let mut s = HintState::new();
        let id = begin(&mut s);
        s.end();
        s.end();
        assert!(!commit_allowed(&s, id));
        assert!(s.pending.is_none());
    }

    #[test]
    fn ready_flush_does_not_resurrect_a_hidden_session() {
        // show（未就绪，排队）→ hide → ready：补发必须为空
        let mut s = HintState::new();
        let _ = s.begin((rect(), 0), "提示".to_string());
        s.end();
        assert!(s.take_pending().is_none());
    }

    #[test]
    fn radius_matches_the_css_contract() {
        // 跨端契约：styles-tab-hint.css 的 border-radius 必须与本常量相等
        assert_eq!(HINT_RADIUS, 8.0);
    }
}
