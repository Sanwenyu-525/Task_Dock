//! 桌面微件独立窗口宿主（第一阶段）。
//!
//! 边界与约束：
//! - 每个微件类型最多一个窗口（label = `widget-<type>`），由主窗口按布局显式创建；
//!   关闭即销毁 WebView，释放渲染进程/监听/句柄；再次显示时重建，不做常驻隐藏窗口。
//! - 窗口不挂载完整 `App.tsx`，只加载 `widget.html` 的轻量宿主；能力集由
//!   `capabilities/widgets.json` 隔离，业务命令在 Rust 侧校验调用窗口身份。
//! - 位置只保存**归一化锚点**（相对显示器工作区 0~1）与显示器名快照；恢复时
//!   按当前显示器换算，找不到显示器时回落到主显示器，绝不把物理坐标盲搬。
//! - 不使用主窗口的全局圆角/吸附/材质状态：圆角用 `window_shape::apply_with_radius`
//!   的弹窗路径，按窗口独立缓存；材质统一由 CSS 半透明表面承担（不挂原生材质，
//!   避免多窗口下 Mica/Acrylic 的全局状态互相影响）。
//! - 默认普通层级、不抢键盘焦点（`set_focusable(false)`）；用户可显式置顶。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::error::{AppError, AppResult};

pub const EVENT_SNAPSHOT: &str = "widget-snapshot";
pub const EVENT_REQUEST: &str = "widget-snapshot-request";
pub const EVENT_ACTION: &str = "widget-action";
pub const EVENT_BOUNDS: &str = "widget-bounds-changed";
pub const EVENT_DISMISSED: &str = "widget-window-dismissed";

const MAIN_LABEL: &str = "main";
const WINDOW_PREFIX: &str = "widget-";
const WIDGET_RADIUS: f64 = 16.0;
const MIN_WIDTH: f64 = 220.0;
const MAX_WIDTH: f64 = 560.0;
const MIN_HEIGHT: f64 = 120.0;
const MAX_HEIGHT: f64 = 640.0;
const EDGE_MARGIN: i32 = 24;
/// 拖动后至少要留出可操作标题区，不能以「与显示器有任意交集」当作可见。
const MIN_VISIBLE_WIDTH: i32 = 120;
const MIN_VISIBLE_HEIGHT: i32 = 48;

/// 窗口实例代际：每次创建自增。关闭事件必须携带创建时的代际，前端据此丢弃
/// 「旧窗口销毁晚于新窗口创建」的迟到事件，而不是靠延时忽略。
static WINDOW_GENERATION: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 程序主动关闭原因：`Destroyed` 事件据此区分用户关窗、管理页关闭、应用退出与异常销毁。
static CLOSE_REASON: LazyLock<Mutex<HashMap<String, &'static str>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 记录程序自身 set_size 的逻辑尺寸（按微件类型 + 代际）。用于区分程序缩放与用户手动缩放：
/// 实际尺寸与记录一致时 `customSize=false`，前端不会把预设尺寸写成自定义尺寸。
/// 带代际可避免旧窗口销毁时清掉新窗口的记录。
static PROGRAMMATIC_SIZE: LazyLock<Mutex<HashMap<String, (u64, f64, f64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 串行化「创建窗口 → 设尺寸 → 放置 → 显示」整段。
///
/// `default_position` 依据其它微件窗口**已可见**的真实矩形做列内堆叠；前端按类型
/// 分队列只能保证同类顺序，跨类型仍会并发创建。若并发，各窗口在放置时都还看不到
/// 对方，六个窗口会全部落在同一个右上角默认位（真实冷启动已复现）。放置属于对
/// 全局窗口集合的读-改-写，必须在这里串行，而不是靠调用方自觉排队。
static PLACEMENT_LOCK: Mutex<()> = Mutex::new(());

fn next_window_generation(kind: &str) -> u64 {
    let Ok(mut generations) = WINDOW_GENERATION.lock() else {
        return 0;
    };
    let next = generations.get(kind).copied().unwrap_or(0) + 1;
    generations.insert(kind.to_string(), next);
    next
}

fn current_window_generation(kind: &str) -> u64 {
    WINDOW_GENERATION
        .lock()
        .ok()
        .and_then(|generations| generations.get(kind).copied())
        .unwrap_or(0)
}

fn mark_close_reason(kind: &str, reason: &'static str) {
    if let Ok(mut reasons) = CLOSE_REASON.lock() {
        reasons.insert(kind.to_string(), reason);
    }
}

fn take_close_reason(kind: &str) -> Option<&'static str> {
    CLOSE_REASON
        .lock()
        .ok()
        .and_then(|mut reasons| reasons.remove(kind))
}

fn clear_close_reason(kind: &str) {
    if let Ok(mut reasons) = CLOSE_REASON.lock() {
        reasons.remove(kind);
    }
}

/// 应用退出前统一标记：Destroyed 事件不得被前端当成「用户关闭桌面显示」而改写配置。
pub fn mark_app_exit() {
    if let Ok(mut reasons) = CLOSE_REASON.lock() {
        for kind in WIDGET_TYPES {
            reasons.insert((*kind).to_string(), "app-exit");
        }
    }
}

fn closed_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn remember_programmatic_size(kind: &str, generation: u64, width: f64, height: f64) {
    if let Ok(mut sizes) = PROGRAMMATIC_SIZE.lock() {
        sizes.insert(
            kind.to_string(),
            (generation, width.round(), height.round()),
        );
    }
}

fn is_user_resize(kind: &str, generation: u64, width: f64, height: f64) -> bool {
    let Ok(sizes) = PROGRAMMATIC_SIZE.lock() else {
        return false;
    };
    match sizes.get(kind).copied() {
        Some((expected_generation, expected_w, expected_h))
            if expected_generation == generation =>
        {
            (width - expected_w).abs() > 1.0 || (height - expected_h).abs() > 1.0
        }
        _ => false,
    }
}

fn forget_programmatic_size(kind: &str, generation: u64) {
    if let Ok(mut sizes) = PROGRAMMATIC_SIZE.lock() {
        if sizes.get(kind).map(|(expected, _, _)| *expected) == Some(generation) {
            sizes.remove(kind);
        }
    }
}

const WIDGET_TYPES: &[&str] = &[
    "today-tasks",
    "next-reminder",
    "agent-status",
    "quick-actions",
    "focus-timer",
    "efficiency",
];

fn validate_type(kind: &str) -> AppResult<&str> {
    WIDGET_TYPES
        .iter()
        .find(|item| **item == kind)
        .copied()
        .ok_or_else(|| AppError::Validation(format!("未知微件类型：{kind}")))
}

fn window_label(kind: &str) -> String {
    format!("{WINDOW_PREFIX}{kind}")
}

fn label_type(label: &str) -> Option<&str> {
    label.strip_prefix(WINDOW_PREFIX)
}

fn caller_type(window: &WebviewWindow) -> AppResult<String> {
    label_type(window.label())
        .filter(|kind| WIDGET_TYPES.contains(kind))
        .map(|kind| kind.to_string())
        .ok_or_else(|| AppError::Validation("该命令仅限桌面微件窗口调用".to_string()))
}

fn assert_main(window: &WebviewWindow) -> AppResult<()> {
    if window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err(AppError::Validation("该命令仅限主窗口调用".to_string()))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWindowSpec {
    pub widget_type: String,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub nx: Option<f64>,
    #[serde(default)]
    pub ny: Option<f64>,
    #[serde(default)]
    pub monitor: Option<String>,
    #[serde(default)]
    pub topmost: bool,
    /// true：应用 nx/ny 锚点；false：保留窗口当前位置（仅更新尺寸/置顶）。
    #[serde(default)]
    pub place: bool,
    /// true：忽略已保存锚点，按默认层叠位放置（管理页「重置位置」）。
    #[serde(default)]
    pub reset_position: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWindowInfo {
    pub widget_type: String,
    /// 窗口实例代际。前端保存它并与关闭事件比对，旧窗口的迟到事件不会覆盖新意图。
    pub generation: u64,
    pub width: f64,
    pub height: f64,
    pub nx: f64,
    pub ny: f64,
    pub monitor: Option<String>,
    pub topmost: bool,
    pub scale: f64,
}

/// 关闭原因：user-close（Alt+F4 / 窗口关闭按钮）、management-hide（管理页关闭桌面显示）、
/// app-exit（应用退出）、destroyed（WebView 崩溃或外部销毁，属于异常）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetDismissedEvent {
    widget_type: String,
    generation: u64,
    reason: &'static str,
    /// 事件产生时间（毫秒）。前端据此判断「关闭」是否早于用户重新开启的意图。
    closed_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundsReport {
    widget_type: String,
    width: f64,
    height: f64,
    nx: f64,
    ny: f64,
    monitor: Option<String>,
    topmost: bool,
    scale: f64,
    custom_size: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetActionEvent {
    widget_type: String,
    action: String,
    tab: Option<String>,
    task_id: Option<String>,
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

fn clamp_size(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max).round()
    } else {
        min
    }
}

/// 选择目标显示器：名称匹配优先，否则主显示器，最后退回任意可用显示器。
fn pick_monitor(app: &AppHandle, name: Option<&str>) -> Option<tauri::Monitor> {
    if let Some(name) = name {
        if let Ok(monitors) = app.available_monitors() {
            if let Some(found) = monitors
                .into_iter()
                .find(|monitor| monitor.name().map(|n| n.as_str()) == Some(name))
            {
                return Some(found);
            }
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| {
        app.available_monitors()
            .ok()
            .and_then(|m| m.into_iter().next())
    })
}

/// 由工作区、窗口物理尺寸与归一化锚点求物理坐标；越界时收进工作区。
fn anchored_position(area: WorkArea, window_w: i32, window_h: i32, nx: f64, ny: f64) -> (i32, i32) {
    let span_x = (area.width - window_w).max(0);
    let span_y = (area.height - window_h).max(0);
    let x = area.x + (nx.clamp(0.0, 1.0) * span_x as f64).round() as i32;
    let y = area.y + (ny.clamp(0.0, 1.0) * span_y as f64).round() as i32;
    (
        x.clamp(area.x, area.x + span_x),
        y.clamp(area.y, area.y + span_y),
    )
}

/// 已存在窗口的物理矩形，用于首次默认布局的贪心排布。
#[derive(Clone, Copy)]
struct WindowRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// 首次默认布局：从工作区右上角向下排列，放不下时向左开新列。
///
/// 旧实现以固定 44px 错开，220/270 高的窗口会被下一个窗口大面积压住。
/// 这里按已存在窗口的**真实物理尺寸**做列内堆叠，列右缘对齐、列间留缝，
/// 既保证六类微件首次打开互不重叠，也不影响用户之后的自由拖动/缩放。
fn default_position(
    area: WorkArea,
    existing: &[WindowRect],
    window_w: i32,
    window_h: i32,
) -> (i32, i32) {
    const COLUMN_GAP: i32 = 12;
    const MAX_COLUMNS: usize = 4;
    let top = area.y + EDGE_MARGIN;
    let bottom = area.y + area.height - EDGE_MARGIN;
    let mut column_right = area.x + area.width - EDGE_MARGIN;

    for _ in 0..MAX_COLUMNS {
        let x = (column_right - window_w).max(area.x);
        let mut next_y = top;
        let mut min_left = i32::MAX;
        let mut column_count = 0usize;
        for rect in existing {
            // 同列判定：右缘对齐。列内宽度可以不同，但右缘必须落在同一竖线。
            if (rect.x + rect.width - column_right).abs() <= 2 {
                column_count += 1;
                next_y = next_y.max(rect.y + rect.height + COLUMN_GAP);
                min_left = min_left.min(rect.x);
            }
        }
        if column_count == 0 {
            next_y = top;
            min_left = x;
        }
        if next_y + window_h <= bottom {
            return (
                x.clamp(area.x, (area.x + area.width - window_w).max(area.x)),
                next_y,
            );
        }
        let next_right = min_left - COLUMN_GAP;
        if next_right - window_w < area.x {
            break;
        }
        column_right = next_right;
    }

    // 极端窄小工作区：仍保证窗口完整可见；可能与其他微件重叠，但用户可拖动分开。
    let x = (area.x + area.width - EDGE_MARGIN - window_w)
        .max(area.x)
        .min(area.x + (area.width - window_w).max(0));
    let y = top.clamp(area.y, area.y + (area.height - window_h).max(0));
    (x, y)
}

fn anchor_from_position(
    area: WorkArea,
    window_w: i32,
    window_h: i32,
    x: i32,
    y: i32,
) -> (f64, f64) {
    let span_x = (area.width - window_w).max(1) as f64;
    let span_y = (area.height - window_h).max(1) as f64;
    (
        ((x - area.x) as f64 / span_x).clamp(0.0, 1.0),
        ((y - area.y) as f64 / span_y).clamp(0.0, 1.0),
    )
}

/// 窗口在任一显示器工作区内是否留有**可操作**区域（标题区 + 可点按钮），
/// 而不是「有任意交集」就算可见，避免窗口只露 1px 后用户无法拖回。
fn has_usable_visible_area(app: &AppHandle, x: i32, y: i32, width: i32, height: i32) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    let need_w = MIN_VISIBLE_WIDTH.min(width);
    let need_h = MIN_VISIBLE_HEIGHT.min(height);
    monitors.iter().any(|monitor| {
        let area = WorkArea::from_monitor(monitor);
        let overlap_w = (x + width).min(area.x + area.width) - x.max(area.x);
        let overlap_h = (y + height).min(area.y + area.height) - y.max(area.y);
        overlap_w >= need_w && overlap_h >= need_h
    })
}

/// 把越界窗口收进指定工作区（保留靠近边缘的位置，不做默认位大跳）。
fn clamp_into_area(area: WorkArea, x: i32, y: i32, width: i32, height: i32) -> (i32, i32) {
    let max_x = area.x + (area.width - width).max(0);
    let max_y = area.y + (area.height - height).max(0);
    (x.clamp(area.x, max_x), y.clamp(area.y, max_y))
}

fn current_work_area(
    app: &AppHandle,
    win: &WebviewWindow,
) -> Option<(WorkArea, f64, Option<String>, i32, i32, i32, i32)> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| pick_monitor(app, None))?;
    let scale = monitor.scale_factor();
    let area = WorkArea::from_monitor(&monitor);
    let position = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    Some((
        area,
        scale,
        monitor.name().cloned(),
        position.x,
        position.y,
        // inner_size 是物理像素；窗口无边框时与外部尺寸一致。
        size.width as i32,
        size.height as i32,
    ))
}

fn logical_size(win: &WebviewWindow) -> (f64, f64) {
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .filter(|s| *s > 0.0)
        .unwrap_or(1.0);
    match win.inner_size() {
        Ok(size) => (
            (size.width as f64 / scale).round(),
            (size.height as f64 / scale).round(),
        ),
        Err(_) => (MIN_WIDTH, MIN_HEIGHT),
    }
}

fn apply_shape(win: &WebviewWindow) {
    // 圆角按窗口独立缓存，不读取/污染主窗口全局半径。
    crate::window_shape::apply_with_radius(win, WIDGET_RADIUS);
}

fn emit_to_main<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    let _ = app.emit_to(MAIN_LABEL, event, payload);
}

fn build_info(kind: &str, win: &WebviewWindow, app: &AppHandle) -> WidgetWindowInfo {
    let (width, height) = logical_size(win);
    let topmost = win.is_always_on_top().unwrap_or(false);
    if let Some((area, scale, monitor, x, y, w, h)) = current_work_area(app, win) {
        let (nx, ny) = anchor_from_position(area, w, h, x, y);
        WidgetWindowInfo {
            widget_type: kind.to_string(),
            generation: current_window_generation(kind),
            width,
            height,
            nx,
            ny,
            monitor,
            topmost,
            scale,
        }
    } else {
        WidgetWindowInfo {
            widget_type: kind.to_string(),
            generation: current_window_generation(kind),
            width,
            height,
            nx: 1.0,
            ny: 1.0,
            monitor: None,
            topmost,
            scale: 1.0,
        }
    }
}

/// 程序化放置后的几何结果；用于把「意图位置」而不是可能滞后的系统测量值回传前端。
struct Placement {
    nx: f64,
    ny: f64,
    monitor: Option<String>,
    scale: f64,
}

/// 收集其余微件窗口的物理矩形；首次布局只依据真实尺寸排布。
///
/// 不按 `is_visible()` 过滤：`show()` 是把调用投递到事件循环，返回值不代表系统
/// 已把窗口标记为可见。真实冷启动里六个窗口创建请求会接连到达，先创建的窗口
/// 在窗口管理器看来仍是「不可见」，于是后续窗口都按空集合排布、堆到同一个角落。
/// 创建/放置/显示已由 `PLACEMENT_LOCK` 串行，因此这里出现的其它微件窗口一定已经
/// 完成了放置与显示；直接读它的真实矩形才是可靠依据。
fn existing_widget_rects(app: &AppHandle, kind: &str) -> Vec<WindowRect> {
    WIDGET_TYPES
        .iter()
        .filter(|item| **item != kind)
        .filter_map(|item| {
            let window = app.get_webview_window(&window_label(item))?;
            let position = window.outer_position().ok()?;
            let size = window.outer_size().ok()?;
            Some(WindowRect {
                x: position.x,
                y: position.y,
                width: size.width as i32,
                height: size.height as i32,
            })
        })
        .collect()
}

fn place_window(
    app: &AppHandle,
    win: &WebviewWindow,
    kind: &str,
    width: f64,
    height: f64,
    nx: Option<f64>,
    ny: Option<f64>,
    monitor_name: Option<&str>,
    reset_position: bool,
) -> AppResult<Placement> {
    let monitor = pick_monitor(app, monitor_name)
        .ok_or_else(|| AppError::Unavailable("找不到可用的显示器，无法放置微件窗口".to_string()))?;
    let area = WorkArea::from_monitor(&monitor);
    let scale = monitor.scale_factor();
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let (x, y) = match (reset_position, nx, ny) {
        (true, ..) | (false, None, _) | (false, _, None) => {
            let existing = existing_widget_rects(app, kind);
            default_position(area, &existing, w, h)
        }
        (false, Some(nx), Some(ny)) => anchored_position(area, w, h, nx, ny),
    };
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|error| AppError::Validation(format!("设置微件窗口位置失败：{error}")))?;
    let (anchor_x, anchor_y) = anchor_from_position(area, w, h, x, y);
    Ok(Placement {
        nx: anchor_x,
        ny: anchor_y,
        monitor: monitor.name().cloned(),
        scale,
    })
}

fn report_bounds(app: &AppHandle, kind: &str, win: &WebviewWindow) {
    let (width, height) = logical_size(win);
    let topmost = win.is_always_on_top().unwrap_or(false);
    let custom_size = is_user_resize(kind, current_window_generation(kind), width, height);
    // 拖动结束留下的可操作区域过小：优先收进当前显示器，其次回到主屏默认层叠位。
    if let (Ok(position), Ok(size)) = (win.outer_position(), win.inner_size()) {
        let (w, h) = (size.width as i32, size.height as i32);
        if !has_usable_visible_area(app, position.x, position.y, w, h) {
            match win.current_monitor().ok().flatten() {
                Some(monitor) => {
                    let area = WorkArea::from_monitor(&monitor);
                    let (x, y) = clamp_into_area(area, position.x, position.y, w, h);
                    let _ = win.set_position(PhysicalPosition::new(x, y));
                }
                None => {
                    // 对账路径尽力而为：失败时保留原位置，由下一次拖动/重置重试。
                    let _ = place_window(app, win, kind, width, height, None, None, None, true);
                }
            }
        }
    }
    let Some((area, scale, monitor, x, y, w, h)) = current_work_area(app, win) else {
        return;
    };
    let (nx, ny) = anchor_from_position(area, w, h, x, y);
    emit_to_main(
        app,
        EVENT_BOUNDS,
        BoundsReport {
            widget_type: kind.to_string(),
            width,
            height,
            nx,
            ny,
            monitor,
            topmost,
            scale,
            custom_size,
        },
    );
}

fn attach_window_events(app: &AppHandle, win: &WebviewWindow, kind: String, generation: u64) {
    let app = app.clone();
    let w = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Alt+F4 / 系统关闭：只关闭「桌面显示」，不动微件配置本身。
            // 真正的 dismissed 事件由 Destroyed 统一发出，避免同一关闭动作发两次不同原因。
            api.prevent_close();
            mark_close_reason(&kind, "user-close");
            if let Err(error) = w.destroy() {
                // 销毁失败：窗口仍在，不能谎报已关闭；清掉预期原因，后续按异常销毁对账。
                clear_close_reason(&kind);
                tracing::warn!("桌面微件窗口销毁失败: {}", error);
            }
        }
        tauri::WindowEvent::ScaleFactorChanged { .. } => {
            apply_shape(&w);
            report_bounds(&app, &kind, &w);
        }
        tauri::WindowEvent::Resized(_) => {
            // 尺寸变化后区域缓存失效，重新应用；拖动结束由前端 debounce 后上报。
            apply_shape(&w);
        }
        tauri::WindowEvent::Destroyed => {
            if let Ok(hwnd) = w.hwnd() {
                crate::window_shape::forget_window(hwnd.0 as isize);
            }
            forget_programmatic_size(&kind, generation);
            // 统一出口：携带创建时的代际与关闭原因，前端只接受「当前窗口」的事件，
            // 旧窗口销毁晚于新窗口创建时不会覆盖新的显示意图。
            let reason = take_close_reason(&kind).unwrap_or("destroyed");
            emit_to_main(
                &app,
                EVENT_DISMISSED,
                WidgetDismissedEvent {
                    widget_type: kind.clone(),
                    generation,
                    reason,
                    closed_at: closed_at_ms(),
                },
            );
        }
        _ => {}
    });
}

fn create_window(app: &AppHandle, kind: &str) -> AppResult<(WebviewWindow, u64)> {
    let label = window_label(kind);
    // 代际必须在 build 之前分配：WebView2 在 build() 期间就可能加载页面并发起首帧请求，
    // 若此时还没占代际，请求与之后的快照都会带旧值（0），窗口自身的 info 也会读到旧值，
    // 导致真实快照被接收端当成旧实例永久丢弃。先占代际后建窗，保证实例身份从头一致。
    let generation = next_window_generation(kind);
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("widget.html".into()))
        .title("Task Dock 微件")
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .skip_taskbar(true)
        // 没有 shadow(false) 时 DWM 会在可视区域外留约 9px 的不可见调整边框：
        // WebView 只画客户区，超出部分用默认白底渲染，与 Win32 圆角区域合成成
        // 右/下亮白边（主窗与任务栏弹窗在 tauri.conf 里都是 shadow:false）。
        .shadow(false)
        .visible(false)
        .inner_size(300.0, 200.0)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .max_inner_size(MAX_WIDTH, MAX_HEIGHT)
        .build()?;

    // 不抢键盘焦点；桌面微件不是输入窗口。
    let _ = win.set_focusable(false);
    apply_shape(&win);
    crate::window_shape::watch_destroy(&win);
    // 拖拽相位监视：微件标题栏拖动时让 WebView 在松手瞬间结束拖拽光标会话。
    // 子类化必须在窗口所属线程执行，而本函数可能在 IPC 线程上跑 → 投递到主线程。
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = hwnd.0 as isize;
        let app_for_watch = app.clone();
        let label_for_watch = label.clone();
        if let Err(err) = app.run_on_main_thread(move || {
            crate::drag_watch::install(&app_for_watch, hwnd, &label_for_watch);
        }) {
            tracing::warn!("微件拖拽相位监视投递失败: {err}");
        }
    }
    attach_window_events(app, &win, kind.to_string(), generation);
    Ok((win, generation))
}

/// 显示（必要时创建）某类微件的桌面窗口。仅主窗口可调用。
///
/// 必须声明为 `async`：同步命令在 IPC 线程（Windows 消息线程）内执行，
/// `WebviewWindowBuilder::build()` 创建 WebView2 控制器时需要消息循环继续运转，
/// 在同线程阻塞等待会互相卡死（表现为前端一直停在「正在创建」）。
#[tauri::command]
pub async fn show_widget_window(
    app: AppHandle,
    window: WebviewWindow,
    spec: WidgetWindowSpec,
) -> AppResult<WidgetWindowInfo> {
    assert_main(&window)?;
    // 锁必须整段由同步函数持有：`MutexGuard` 不可跨 `.await`，async 命令只做入口校验。
    place_and_show(app, spec)
}

/// 串行段：创建（必要时）→ 设尺寸/置顶 → 首次放置 → 显示 → 应用圆角。
/// 见 `PLACEMENT_LOCK`：并发创建会让默认层叠看到空的已存在窗口集合。
fn place_and_show(app: AppHandle, spec: WidgetWindowSpec) -> AppResult<WidgetWindowInfo> {
    let _placement = PLACEMENT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let kind = validate_type(&spec.widget_type)?;
    let width = clamp_size(spec.width, MIN_WIDTH, MAX_WIDTH);
    let height = clamp_size(spec.height, MIN_HEIGHT, MAX_HEIGHT);
    let topmost = spec.topmost;

    let label = window_label(kind);
    let created = app.get_webview_window(&label).is_none();
    let (win, generation) = match app.get_webview_window(&label) {
        Some(existing) => (existing, current_window_generation(kind)),
        None => create_window(&app, kind)?,
    };

    remember_programmatic_size(kind, generation, width, height);
    win.set_size(tauri::LogicalSize::new(width, height))?;
    if let Err(error) = win.set_always_on_top(topmost) {
        tracing::warn!("设置桌面微件置顶失败: {}", error);
    }
    // 只回报真实生效的置顶状态；请求失败时不能把请求值当成已生效。
    let actual_topmost = win.is_always_on_top().unwrap_or(false);
    // 首次创建必须落到默认层叠位（或多个微件会堆在同一系统默认位置）；
    // 已存在窗口仅在 place/reset 时才移动，避免切尺寸把用户摆放好的位置重置。
    let placement = if created || spec.place || spec.reset_position {
        Some(place_window(
            &app,
            &win,
            kind,
            width,
            height,
            spec.nx,
            spec.ny,
            spec.monitor.as_deref(),
            spec.reset_position,
        )?)
    } else {
        None
    };
    if !win.is_visible().unwrap_or(false) {
        win.show()?;
    }
    apply_shape(&win);
    // 位置刚由程序设置时用「意图几何」回传，避免系统测量滞后让前端保存旧坐标。
    Ok(match placement {
        Some(placed) => WidgetWindowInfo {
            widget_type: kind.to_string(),
            generation,
            width,
            height,
            nx: placed.nx,
            ny: placed.ny,
            monitor: placed.monitor,
            topmost: actual_topmost,
            scale: placed.scale,
        },
        None => build_info(kind, &win, &app),
    })
}

/// 关闭桌面显示（销毁窗口，释放 WebView 与监听；微件配置保留）。
#[tauri::command]
pub fn hide_widget_window(
    app: AppHandle,
    window: WebviewWindow,
    widget_type: String,
) -> AppResult<()> {
    assert_main(&window)?;
    let kind = validate_type(&widget_type)?;
    if let Some(win) = app.get_webview_window(&window_label(kind)) {
        mark_close_reason(kind, "management-hide");
        if let Err(error) = win.destroy() {
            // 销毁失败说明窗口仍在：不能向前端谎报已关闭。
            clear_close_reason(kind);
            return Err(AppError::Validation(format!("关闭桌面微件失败：{error}")));
        }
    }
    Ok(())
}

/// 单一桌面窗口自行关闭（标题栏关闭按钮）。
#[tauri::command]
pub fn dismiss_widget_window(window: WebviewWindow) -> AppResult<()> {
    let kind = caller_type(&window)?;
    // 不在这里手工发事件：Destroyed 统一携带代际与 user-close 原因，
    // 销毁失败时不会出现「事件已发但窗口仍在」的假关闭。
    mark_close_reason(&kind, "user-close");
    if let Err(error) = window.destroy() {
        clear_close_reason(&kind);
        return Err(AppError::Validation(format!("关闭桌面微件失败：{error}")));
    }
    Ok(())
}

#[tauri::command]
pub fn set_widget_topmost(app: AppHandle, window: WebviewWindow, topmost: bool) -> AppResult<()> {
    let kind = caller_type(&window)?;
    window.set_always_on_top(topmost)?;
    report_bounds(&app, &kind, &window);
    Ok(())
}

/// 微件窗口挂载时读取自身状态（初始置顶、逻辑尺寸、当前锚点）。
/// 只允许 `widget-*` 窗口调用；主窗口不需要该接口。
#[tauri::command]
pub fn widget_window_info(app: AppHandle, window: WebviewWindow) -> AppResult<WidgetWindowInfo> {
    let kind = caller_type(&window)?;
    Ok(build_info(&kind, &window, &app))
}

/// 拖动/缩放结束后由微件窗口调用（前端 debounce，避免每帧写盘）。
/// 物理几何与显示器换算全部在 Rust 侧完成，前端不传坐标。
#[tauri::command]
pub fn report_widget_bounds(app: AppHandle, window: WebviewWindow) -> AppResult<()> {
    let kind = caller_type(&window)?;
    report_bounds(&app, &kind, &window);
    Ok(())
}

/// 管理页「重置位置」：窗口已打开时立即回到默认层叠位。
#[tauri::command]
pub fn reset_widget_position(
    app: AppHandle,
    window: WebviewWindow,
    widget_type: String,
) -> AppResult<()> {
    assert_main(&window)?;
    let kind = validate_type(&widget_type)?;
    if let Some(win) = app.get_webview_window(&window_label(kind)) {
        let (width, height) = logical_size(&win);
        // 位置设置失败必须明确反馈，不能静默保留在屏幕外/不可操作区域。
        place_window(&app, &win, kind, width, height, None, None, None, true)?;
        apply_shape(&win);
        report_bounds(&app, kind, &win);
    }
    Ok(())
}

/// 主窗口 → 指定微件窗口的数据快照（唯一数据所有者为前端主窗口）。
#[tauri::command]
pub fn publish_widget_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    widget_type: String,
    revision: u64,
    epoch: Option<String>,
    generation: Option<u64>,
    snapshot: serde_json::Value,
) -> AppResult<bool> {
    assert_main(&window)?;
    let kind = validate_type(&widget_type)?;
    let target = window_label(kind);
    let Some(target_window) = app.get_webview_window(&target) else {
        return Ok(false);
    };
    // 代际校验：主窗口可能持有旧请求的应答，窗口已重建时必须丢弃，
    // 不能让旧代际数据被新窗口当成当前快照。
    let current_generation = current_window_generation(kind);
    if generation.is_some_and(|value| value != current_generation) {
        return Ok(false);
    }
    // 只推给对应窗口，不广播到主窗口/其他微件，避免无谓的 IPC 唤醒。
    target_window.emit(
        EVENT_SNAPSHOT,
        serde_json::json!({
            "widgetType": kind,
            "revision": revision,
            "epoch": epoch.unwrap_or_default(),
            "generation": current_generation,
            "snapshot": snapshot,
        }),
    )?;
    Ok(true)
}

/// 微件窗口挂载后请求一次快照；主窗口应答（消除启动竞态）。
#[tauri::command]
pub fn request_widget_snapshot(app: AppHandle, window: WebviewWindow) -> AppResult<()> {
    let kind = caller_type(&window)?;
    let generation = current_window_generation(&kind);
    // 带上本窗口代际：主窗口把它回显进快照，接收端据此拒绝旧实例的数据。
    emit_to_main(
        &app,
        EVENT_REQUEST,
        serde_json::json!({
            "widgetType": kind,
            "generation": generation,
        }),
    );
    Ok(())
}

/// 微件内点击类操作：导航类动作先唤回主窗口，再把意图交给主窗口执行；
/// `retry-efficiency` / `refresh-reminder` 只是数据刷新，不抢占前台。
#[tauri::command]
pub fn dispatch_widget_action(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    tab: Option<String>,
    task_id: Option<String>,
) -> AppResult<()> {
    let kind = caller_type(&window)?;
    let navigates = matches!(
        action.as_str(),
        "open-task"
            | "open-panel"
            | "open-agents"
            | "new-task"
            | "capture"
            | "clipboard"
            | "workflows"
            | "manage-reminders"
    );
    if navigates {
        crate::commands::system::show_main_window(app.clone())?;
    }
    emit_to_main(
        &app,
        EVENT_ACTION,
        WidgetActionEvent {
            widget_type: kind,
            action,
            tab,
            task_id,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> WorkArea {
        WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        }
    }

    #[test]
    fn anchor_zero_places_at_work_area_origin() {
        assert_eq!(anchored_position(area(), 300, 200, 0.0, 0.0), (0, 0));
    }

    #[test]
    fn anchor_one_places_window_flush_bottom_right() {
        assert_eq!(anchored_position(area(), 300, 200, 1.0, 1.0), (1620, 840));
    }

    #[test]
    fn invalid_anchor_is_clamped_into_work_area() {
        assert_eq!(anchored_position(area(), 300, 200, -1.0, 2.0), (0, 840));
    }

    #[test]
    fn negative_monitor_origin_is_preserved() {
        let secondary = WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(anchored_position(secondary, 300, 200, 1.0, 0.0), (-300, 0));
    }

    #[test]
    fn default_positions_stack_without_overlap() {
        let (x, y) = default_position(area(), &[], 340, 280);
        assert_eq!((x, y), (1920 - 24 - 340, 24));
        let first = WindowRect {
            x,
            y,
            width: 340,
            height: 280,
        };
        let (next_x, next_y) = default_position(area(), &[first], 320, 240);
        // 同列右缘对齐，纵向按上一窗口真实高度 + 间距堆叠。
        assert_eq!(next_x, 1920 - 24 - 320);
        assert_eq!(next_y, 24 + 280 + 12);
        assert!(next_y + 240 <= 1040 - 24);
    }

    #[test]
    fn default_positions_open_new_column_when_full() {
        let rects: Vec<WindowRect> = (0..3)
            .map(|index| WindowRect {
                x: 1920 - 24 - 340,
                y: 24 + index * (300 + 12),
                width: 340,
                height: 300,
            })
            .collect();
        let (x, y) = default_position(area(), &rects, 340, 300);
        // 右列放不下第四个：在原列左侧留 12px 开新列，从顶部重新堆叠。
        assert_eq!(x, 1920 - 24 - 340 - 12 - 340);
        assert_eq!(y, 24);
    }

    #[test]
    fn default_position_keeps_window_inside_work_area() {
        let tiny = WorkArea {
            x: 0,
            y: 0,
            width: 800,
            height: 500,
        };
        let (x, y) = default_position(tiny, &[], 340, 280);
        assert!(x >= 0 && x + 340 <= 800);
        assert!(y >= 0 && y + 280 <= 500);
    }

    #[test]
    fn anchor_round_trip_is_stable() {
        let (x, y) = anchored_position(area(), 300, 200, 0.4, 0.6);
        let (nx, ny) = anchor_from_position(area(), 300, 200, x, y);
        assert!((nx - 0.4).abs() < 0.01);
        assert!((ny - 0.6).abs() < 0.01);
    }

    #[test]
    fn size_bounds_are_clamped() {
        assert_eq!(clamp_size(100.0, MIN_WIDTH, MAX_WIDTH), MIN_WIDTH);
        assert_eq!(clamp_size(9999.0, MIN_WIDTH, MAX_WIDTH), MAX_WIDTH);
        assert_eq!(clamp_size(f64::NAN, MIN_HEIGHT, MAX_HEIGHT), MIN_HEIGHT);
    }

    #[test]
    fn label_maps_back_to_widget_type() {
        assert_eq!(label_type("widget-today-tasks"), Some("today-tasks"));
        assert_eq!(label_type("main"), None);
        assert_eq!(label_type("notification"), None);
    }
}
