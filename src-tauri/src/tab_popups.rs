//! 极简标签（Edge Tab）弹出层几何：悬停提示窗与右键菜单**共用同一套定位**。
//!
//! 为什么需要独立模块：标签的原生可见区只有 10×46（`SetWindowRgn`），
//! 任何主窗内的浮层都会被裁成残片；所以提示与菜单都是独立窗口，
//! 位置必须由「标签屏幕矩形 + 停靠边」计算，而不是锚点居中。
//!
//! 规则（全部物理像素，纯函数、可单测）：
//! - **朝屏幕内部展开**：左侧停靠的标签菜单向右、右侧向左、顶部向下、底部向上，
//!   永不覆盖贴边那一列/一行，也不会因为「优先上方」而弹到屏幕外；
//! - **横跨轴以标签中心对齐**，再收进工作区（多显示器、负坐标、125%/150%/200%
//!   都用调用方传入的该显示器工作区与缩放换算）；
//! - 放不下时保证完整落在工作区内（可覆盖标签），绝不露到屏外。

use tauri::{AppHandle, Manager};

use crate::context_menu::WorkArea;
use crate::window_shape::{CAPSULE_TAB_HEIGHT_CSS, CAPSULE_TAB_WIDTH_CSS};

/// 弹出层与标签之间的间隙（逻辑像素），与右键菜单的 ANCHOR_GAP 同值。
pub const POPUP_GAP: f64 = 8.0;
/// 工作区安全边距（物理像素），与右键菜单的 EDGE_MARGIN 同值。
const EDGE_MARGIN: i32 = 6;

/// 屏幕矩形（物理像素，绝对屏幕坐标）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 停靠边：0=left 1=right 2=top 3=bottom（与 `window_shape` / 前端 SnapEdge 同序）。
pub fn parse_edge(raw: &str) -> Option<u8> {
    match raw {
        "left" => Some(0),
        "right" => Some(1),
        "top" => Some(2),
        "bottom" => Some(3),
        _ => None,
    }
}

pub fn is_vertical(edge: u8) -> bool {
    edge <= 1
}

/// 计算弹出层窗口左上角（物理像素）。
pub fn place_beside(
    edge: u8,
    tab: ScreenRect,
    popup_logical: (f64, f64),
    scale: f64,
    wa: WorkArea,
) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let pw = ((popup_logical.0.max(1.0)) * scale).round() as i32;
    let ph = ((popup_logical.1.max(1.0)) * scale).round() as i32;
    let gap = (POPUP_GAP * scale).round() as i32;

    let min_x = wa.x + EDGE_MARGIN;
    let min_y = wa.y + EDGE_MARGIN;
    // 工作区比弹出层还窄/矮时，clamp 区间退化为「贴起点边」而不是负坐标
    let max_x = (wa.x + wa.w - EDGE_MARGIN - pw).max(min_x);
    let max_y = (wa.y + wa.h - EDGE_MARGIN - ph).max(min_y);
    let clamp = |v: i32, lo: i32, hi: i32| v.max(lo).min(hi);

    let (x, y) = match edge {
        0 => (tab.x + tab.w + gap, tab.y + tab.h / 2 - ph / 2),
        1 => (tab.x - gap - pw, tab.y + tab.h / 2 - ph / 2),
        2 => (tab.x + tab.w / 2 - pw / 2, tab.y + tab.h + gap),
        _ => (tab.x + tab.w / 2 - pw / 2, tab.y - gap - ph),
    };
    (clamp(x, min_x, max_x), clamp(y, min_y, max_y))
}

/// 主窗当前极简标签的屏幕矩形（物理像素）。
///
/// 停靠期窗口不移动、不缩放，标签永远贴边且沿边居中：
/// 垂直停靠取贴左/右缘、纵向居中；水平停靠取贴上/下缘、横向居中。
/// 与 `window_shape::capsule_tab_regions` 的窗口局部矩形是同一套公式
/// （那边是窗口局部坐标，这边加上了窗口在屏幕上的位置）。
pub fn tab_rect_screen(app: &AppHandle, edge: u8) -> Option<ScreenRect> {
    let win = app.get_webview_window("main")?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let scale = win.scale_factor().ok()?;
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let tab_w = ((CAPSULE_TAB_WIDTH_CSS as f64) * scale).round().max(1.0) as i32;
    let tab_h = ((CAPSULE_TAB_HEIGHT_CSS as f64) * scale).round().max(1.0) as i32;
    let (w, h) = if is_vertical(edge) {
        (tab_w, tab_h)
    } else {
        (tab_h, tab_w)
    };
    let win_w = size.width as i32;
    let win_h = size.height as i32;
    let x = match edge {
        0 => pos.x,
        1 => pos.x + win_w - w,
        _ => pos.x + (win_w - w) / 2,
    };
    let y = match edge {
        2 => pos.y,
        3 => pos.y + win_h - h,
        _ => pos.y + (win_h - h) / 2,
    };
    Some(ScreenRect { x, y, w, h })
}

/// 锚点所在显示器的工作区与缩放（与 `context_menu` 同一取法）。
fn monitor_at(app: &AppHandle, point: (f64, f64)) -> Option<(WorkArea, f64)> {
    let monitor = app
        .monitor_from_point(point.0, point.1)
        .ok()
        .flatten()
        .or_else(|| {
            app.available_monitors().ok().and_then(|mons| {
                mons.into_iter().find(|m| {
                    let (p, s) = (m.position(), m.size());
                    point.0 >= p.x as f64
                        && point.0 < (p.x + s.width as i32) as f64
                        && point.1 >= p.y as f64
                        && point.1 < (p.y + s.height as i32) as f64
                })
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten())?;
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

/// 在标签旁显示快捷菜单（复用既有 `context-menu` 液态玻璃弹窗）。
///
/// 返回 false 仅表示「当前没有可定位的标签」：窗口未停靠、标签几何退化、
/// 或 edge 参数非法。菜单窗口自身缺失由 context_menu 记录告警。
#[tauri::command]
pub fn show_tab_context_menu(app: AppHandle, edge: String) -> bool {
    let Some(e) = parse_edge(&edge) else {
        tracing::warn!(%edge, "极简标签菜单：非法停靠边");
        return false;
    };
    let Some(tab) = tab_rect_screen(&app, e) else {
        tracing::warn!("极简标签菜单：读不到主窗几何");
        return false;
    };
    crate::context_menu::show_at_tab(&app, tab, e);
    true
}

/// 供提示窗复用的定位入口：标签矩形 + 目标显示器工作区。
pub fn popup_position(
    app: &AppHandle,
    edge: u8,
    tab: ScreenRect,
    size_logical: (f64, f64),
    scale: f64,
) -> Option<(i32, i32)> {
    let center = (
        tab.x as f64 + tab.w as f64 / 2.0,
        tab.y as f64 + tab.h as f64 / 2.0,
    );
    let (wa, monitor_scale) = monitor_at(app, center)?;
    // 以目标显示器缩放为准：标签跨屏/DPI 变化时按标签实际所在屏换算
    let scale = if monitor_scale.is_finite() && monitor_scale > 0.0 {
        monitor_scale
    } else {
        scale
    };
    Some(place_beside(edge, tab, size_logical, scale, wa))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wa_full_hd() -> WorkArea {
        WorkArea::new(0, 0, 1920, 1032)
    }

    /// 左停靠：100% DPI 下标签 10×46，纵向居中于 1032 的工作区。
    fn left_tab() -> ScreenRect {
        ScreenRect {
            x: 0,
            y: (1032 - 46) / 2,
            w: 10,
            h: 46,
        }
    }

    #[test]
    fn left_edge_places_popup_inward_without_covering_tab() {
        let (x, y) = place_beside(0, left_tab(), (240.0, 30.0), 1.0, wa_full_hd());
        assert!(x >= left_tab().x + left_tab().w + POPUP_GAP as i32, "x={x}");
        assert_eq!(y, left_tab().y + 23 - 15);
    }

    #[test]
    fn right_edge_places_popup_to_the_left() {
        let tab = ScreenRect {
            x: 1920 - 10,
            y: 400,
            w: 10,
            h: 46,
        };
        let (x, y) = place_beside(1, tab, (240.0, 30.0), 1.0, wa_full_hd());
        assert_eq!(x, 1920 - 10 - 8 - 240);
        assert_eq!(y, 400 + 23 - 15);
    }

    #[test]
    fn top_edge_places_popup_below_and_centered() {
        let tab = ScreenRect {
            x: 900,
            y: 0,
            w: 46,
            h: 10,
        };
        let (x, y) = place_beside(2, tab, (240.0, 30.0), 1.0, wa_full_hd());
        assert_eq!(y, 10 + 8);
        assert_eq!(x, 900 + 23 - 120);
    }

    #[test]
    fn bottom_edge_places_popup_above() {
        let tab = ScreenRect {
            x: 900,
            y: 1022,
            w: 46,
            h: 10,
        };
        let (x, y) = place_beside(3, tab, (240.0, 30.0), 1.0, wa_full_hd());
        assert_eq!(y, 1022 - 8 - 30);
        assert_eq!(x, 900 + 23 - 120);
    }

    #[test]
    fn clamps_into_work_area_near_bottom() {
        // 左停靠标签贴工作区下缘：菜单纵向居中会越界 → 收回工作区
        let tab = ScreenRect {
            x: 0,
            y: 1000,
            w: 10,
            h: 46,
        };
        let (_, y) = place_beside(0, tab, (252.0, 200.0), 1.0, wa_full_hd());
        assert!(y + 200 <= 1032 - EDGE_MARGIN, "y={y}");
    }

    #[test]
    fn converts_by_monitor_scale() {
        // 150%：标签 15×69、菜单 378×753 物理
        let wa = WorkArea::new(0, 0, 2560, 1392);
        let tab = ScreenRect {
            x: 0,
            y: (1392 - 69) / 2,
            w: 15,
            h: 69,
        };
        let (x, y) = place_beside(0, tab, (252.0, 502.0), 1.5, wa);
        assert_eq!(x, 15 + 12); // gap 8×1.5 = 12
        assert_eq!(y, tab.y + 34 - 376);
    }

    #[test]
    fn honors_secondary_monitor_with_negative_origin() {
        // 副屏在左侧（x=-1920）：右停靠标签的菜单向左展开后仍在该屏工作区内
        let wa = WorkArea::new(-1920, 0, 1920, 1032);
        let tab = ScreenRect {
            x: -10,
            y: 500,
            w: 10,
            h: 46,
        };
        let (x, y) = place_beside(1, tab, (240.0, 30.0), 1.0, wa);
        assert_eq!(x, -10 - 8 - 240);
        assert_eq!(y, 500 + 23 - 15);
        assert!(x >= -1920 + EDGE_MARGIN);
    }

    #[test]
    fn tiny_work_area_never_overflows() {
        // 工作区比弹出层还窄/矮：水平贴起点边（x=6），纵向收进下缘
        // （max_y = 60-6-30 = 24），都不出现负坐标或越界。
        let wa = WorkArea::new(0, 0, 100, 60);
        let tab = ScreenRect {
            x: 0,
            y: 20,
            w: 10,
            h: 46,
        };
        let (x, y) = place_beside(0, tab, (240.0, 30.0), 1.0, wa);
        assert_eq!(x, EDGE_MARGIN);
        assert_eq!(y, 24);
        assert!(y >= EDGE_MARGIN);
        assert!(y + 30 <= 60 - EDGE_MARGIN);
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        let (x, _) = place_beside(0, left_tab(), (240.0, 30.0), 0.0, wa_full_hd());
        assert_eq!(x, 10 + 8);
    }

    #[test]
    fn parses_edges() {
        assert_eq!(parse_edge("left"), Some(0));
        assert_eq!(parse_edge("right"), Some(1));
        assert_eq!(parse_edge("top"), Some(2));
        assert_eq!(parse_edge("bottom"), Some(3));
        assert_eq!(parse_edge("LEFT"), None);
        assert_eq!(parse_edge(""), None);
    }
}
