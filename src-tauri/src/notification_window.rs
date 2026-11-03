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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};

use crate::agents::notify::Popup;

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

/// 窗口当前逻辑高度（fit_notification_window 回传后缓存；宽度恒为 WINDOW_WIDTH）。
static STACK_HEIGHT: Mutex<f64> = Mutex::new(160.0);
/// NOACTIVATE 是否已应用（幂等；失败在下次显示时重试）。
static NOACTIVATE_APPLIED: AtomicBool = AtomicBool::new(false);
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

/// 计算通知窗口的物理位置：光标所在显示器工作区右下角。
/// 空间不足时收进工作区（不越界、不出现负坐标）；DPI 按显示器缩放换算。
pub fn place_stack(wa: WorkArea, size_logical: (f64, f64), scale: f64) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let mw = (size_logical.0 * scale).round();
    let mh = (size_logical.1 * scale).round();
    let margin = (EDGE_MARGIN * scale).round();
    let min_x = wa.x as f64 + margin;
    let min_y = wa.y as f64 + margin;
    let max_x = (wa.x as f64 + wa.w as f64 - margin - mw).max(min_x);
    let max_y = (wa.y as f64 + wa.h as f64 - margin - mh).max(min_y);
    (max_x.round() as i32, max_y.round() as i32)
}

/// 解析光标所在显示器的工作区与缩放；取不到时退回主显示器。
fn monitor_for_cursor(app: &AppHandle) -> Option<(WorkArea, f64)> {
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

fn compute_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let (wa, scale) = monitor_for_cursor(app)?;
    let size = (WINDOW_WIDTH, cached_height());
    let (x, y) = place_stack(wa, size, scale);
    Some(PhysicalPosition::new(x, y))
}

fn cached_height() -> f64 {
    *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner())
}

// ── 展示 ─────────────────────────────────────────────────────

/// 把一批已放行的弹窗送入自定义通知窗口。
/// 返回 false 表示窗口路径不可用（窗口不存在/事件发送失败），
/// 调用方据此兜底 OS toast；绝不部分成功。
pub fn show_cards(app: &AppHandle, popups: &[Popup]) -> bool {
    if popups.is_empty() {
        return true;
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
    // 先发内容再定位/显示：窗口隐藏时前端队列为空（空栈即隐藏），
    // 透明窗口无内容可见，不存在旧内容闪现。
    if let Err(e) = app.emit_to(WINDOW_LABEL, SHOW_EVENT, payload) {
        tracing::warn!("通知窗口事件发送失败，OS 通知兜底: {e}");
        return false;
    }
    ensure_noactivate(&win);
    if let Some(pos) = compute_position(app) {
        let _ = win.set_position(pos);
    }
    let _ = win.set_size(LogicalSize::new(WINDOW_WIDTH, cached_height()));
    if let Err(e) = win.show() {
        tracing::warn!("显示通知窗口失败，OS 通知兜底: {e}");
        return false;
    }
    true
}

#[cfg(windows)]
fn ensure_noactivate(win: &tauri::WebviewWindow) {
    if NOACTIVATE_APPLIED.load(Ordering::Relaxed) {
        return;
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
            if ex & (WS_EX_NOACTIVATE as isize) == 0 {
                SetWindowLongPtrW(hwnd.0, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE as isize);
            }
        }
        NOACTIVATE_APPLIED.store(true, Ordering::Relaxed);
    }
}

#[cfg(not(windows))]
fn ensure_noactivate(_win: &tauri::WebviewWindow) {}

/// 通知栈为空时由前端调用：隐藏窗口但保留 WebView 常驻复用。
pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.hide();
    }
}

/// 启动时挂接窗口事件（销毁时重置缓存，保持与窗口生命周期同步）。
pub fn init(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                NOACTIVATE_APPLIED.store(false, Ordering::Relaxed);
                SNOOZED.lock().unwrap_or_else(|e| e.into_inner()).clear();
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

/// 前端回传实测内容高度：收放窗口**高度**并保持右下角锚点不动。
/// 宽度是设计常量，不回传（避免测量回环漂移）；0.5px 阈值去重。
#[tauri::command]
pub fn fit_notification_window(app: AppHandle, height: f64) {
    let h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let ch = cached_height();
    if (ch - h).abs() < 0.5 {
        return;
    }
    *STACK_HEIGHT.lock().unwrap_or_else(|e| e.into_inner()) = h;
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    let _ = win.set_size(LogicalSize::new(WINDOW_WIDTH, h));
    if visible {
        if let Some(pos) = compute_position(&app) {
            let _ = win.set_position(pos);
        }
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

/// 用户点击跳转（查看详情/立即处理/通知中心）：激活主窗口并切换标签页。
/// 只有这条用户主动路径允许夺取焦点；通知出现本身绝不调用。
#[tauri::command]
pub fn notification_navigate(app: AppHandle, target: String) {
    if let Some(win) = app.get_webview_window("main") {
        crate::show_and_focus(&win);
    }
    let tab = match target.as_str() {
        "history" => "history",
        _ => "agents",
    };
    let _ = app.emit_to("main", NAVIGATE_EVENT, serde_json::json!({ "tab": tab }));
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
        };
        let json = serde_json::to_string(&card).unwrap();
        let back: NotificationCardPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(card, back);
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"sourceId\""));
    }
}
