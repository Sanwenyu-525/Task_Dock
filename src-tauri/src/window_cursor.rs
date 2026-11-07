//! 主窗角热区光标（2026-11-03 真机反馈：斜角缩放松手后光标回退成普通箭头）。
//!
//! ## 根因
//! 斜角缩放走 tao 的 `drag_resize_window`：`WM_NCLBUTTONDOWN` + HTTOPLEFT… 进入
//! DefWindowProc 的**系统模态缩放循环**。循环按光标增量改矩形，松手时指针仍停在
//! 角热区里；但循环退出后 Windows 把光标重置为默认箭头，而指针**不再移动**时系统
//! 不会再派发 `WM_SETCURSOR`，WebView2 的 CSS `cursor` 因此没有机会重新生效，光标
//! 就停在默认值。前端手柄是常驻挂载的无状态元素（没有 hover 挂载、没有拖拽态类名），
//! 所以这不是前端卸载或状态复位问题，只能在窗口过程里补一次 `SetCursor`。
//!
//! ## 为什么不在 CSS / 命中区修
//! 命中与缩放意图已经正确（`WindowResizeGrips` 在区域内接住四角，交给原生循环）；
//! 缺的是手势结束后没有新的 `WM_SETCURSOR`。给 `.resize-grip` 再加 `cursor` 规则
//! 不会触发（指针静止时元素收不到 hover/move），因此修复点在光标层。
//!
//! 主窗 `SetWindowRgn` 区域只覆盖 CSS 圆角触及的像素（见 `window_shape.rs`），
//! 角点最外侧的少量像素（随 DPI 缩放）在区域外，那段像素的命中属于下层窗口；
//! 本模块只在指针确实位于本窗口角热区时改写光标，不触碰窗口形状、几何与吸附逻辑。
//!
//! 热区边长必须与前端 `.resize-grip` 的 12 CSS px 一致（跨端契约，两端单测锁定）。

/// 角热区边长（CSS px）。与 `src/styles-themes.css` 的 `.resize-grip` 宽高一致。
pub const GRIP_CSS: f64 = 12.0;

/// 指针落在窗口的哪个角。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    /// 与 CSS 一致：左上/右下为 `nwse-resize`，右上/左下为 `nesw-resize`。
    pub fn is_nwse(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::BottomRight)
    }
}

/// CSS 热区 → 物理像素（四舍五入、至少 1px），保证 150%/200% DPI 下热区不缩水。
pub fn grip_physical(scale: f64) -> i32 {
    if !scale.is_finite() || scale <= 0.0 {
        return 1;
    }
    (GRIP_CSS * scale).round().max(1.0) as i32
}

/// 指针（屏幕坐标）是否落在窗口某个角热区；`rect` = (left, top, right, bottom)。
///
/// 热区按窗口**矩形**角计算（不是区域）：圆角裁掉的最外侧像素仍属于用户看到的「角」；
/// 是否允许改写那里的光标，由调用方 `restore_at_corner` 用 `WindowFromPoint` 归属校验决定。
/// 多个热区重叠时取距离最近的角。
pub fn corner_at(cursor: (i32, i32), rect: (i32, i32, i32, i32), grip: i32) -> Option<Corner> {
    let (cx, cy) = cursor;
    let (left, top, right, bottom) = rect;
    let grip = grip.max(1);

    let mut best: Option<(i32, Corner)> = None;
    let mut consider = |dx: i32, dy: i32, corner: Corner| {
        if dx < 0 || dy < 0 || dx > grip || dy > grip {
            return;
        }
        let key = dx + dy;
        if best.map_or(true, |(best_key, _)| key < best_key) {
            best = Some((key, corner));
        }
    };
    consider(cx - left, cy - top, Corner::TopLeft);
    consider(right - cx, cy - top, Corner::TopRight);
    consider(cx - left, bottom - cy, Corner::BottomLeft);
    consider(right - cx, bottom - cy, Corner::BottomRight);
    best.map(|(_, corner)| corner)
}

/// 指针在本窗口角热区内时把光标设为对应双向箭头，返回是否改写。
///
/// 只在 `WM_EXITSIZEMOVE`（延后一拍）与 `WM_SETCURSOR`（HTCLIENT）调用；
/// 停靠胶囊态不参与（前端不渲染四角手柄，区域也不是整窗矩形）。
///
/// 先做 `WindowFromPoint` 归属校验：主窗区域是圆角二值裁剪，角点最外侧 1–3px
/// 属于**下层窗口**（见 `window_shape.rs`）。那段像素上的光标应由下层窗口决定，
/// 这里不得越权改写——热区判定与真实命中区因此保持一致。
#[cfg(windows)]
pub fn restore_at_corner(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetWindowRect, LoadCursorW, SetCursor, WindowFromPoint, GA_ROOT,
        IDC_SIZENESW, IDC_SIZENWSE,
    };

    if hwnd == 0 || crate::window_shape::is_capsule_mode(hwnd) {
        return false;
    }
    unsafe {
        let mut cursor: POINT = std::mem::zeroed();
        if GetCursorPos(&mut cursor) == 0 {
            return false;
        }
        // 像素归属：必须仍是本窗口（含 WebView2 子窗，root 即本窗口）。
        // 区域外角点落到下层窗口时直接放弃，避免改写别人的光标。
        let under = WindowFromPoint(cursor);
        if under.is_null() || GetAncestor(under, GA_ROOT) != hwnd as HWND {
            return false;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd as HWND, &mut rect) == 0 {
            return false;
        }
        let dpi = GetDpiForWindow(hwnd as HWND);
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
        let Some(corner) = corner_at(
            (cursor.x, cursor.y),
            (rect.left, rect.top, rect.right, rect.bottom),
            grip_physical(scale),
        ) else {
            return false;
        };
        let id = if corner.is_nwse() {
            IDC_SIZENWSE
        } else {
            IDC_SIZENESW
        };
        let handle = LoadCursorW(std::ptr::null_mut(), id);
        if handle.is_null() {
            return false;
        }
        SetCursor(handle);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 窗口矩形 (100,200)-(600,900)：非零原点，覆盖多显示器负坐标场景的换算。
    const RECT: (i32, i32, i32, i32) = (100, 200, 600, 900);

    #[test]
    fn grip_scales_with_dpi_and_never_shrinks() {
        assert_eq!(grip_physical(1.0), 12);
        assert_eq!(grip_physical(1.25), 15);
        assert_eq!(grip_physical(1.5), 18);
        assert_eq!(grip_physical(2.0), 24);
        assert_eq!(grip_physical(0.0), 1);
        assert_eq!(grip_physical(-1.0), 1);
        assert_eq!(grip_physical(f64::NAN), 1);
    }

    #[test]
    fn corner_at_matches_all_four_corners() {
        let grip = grip_physical(1.5); // 150% DPI = 18 物理像素
        assert_eq!(corner_at((100, 200), RECT, grip), Some(Corner::TopLeft));
        assert_eq!(corner_at((599, 200), RECT, grip), Some(Corner::TopRight));
        assert_eq!(corner_at((100, 899), RECT, grip), Some(Corner::BottomLeft));
        assert_eq!(corner_at((599, 899), RECT, grip), Some(Corner::BottomRight));
    }

    #[test]
    fn corner_at_accepts_grip_boundary_and_rejects_one_pixel_outside() {
        let grip = grip_physical(1.25); // 125% DPI = 15 物理像素
        assert_eq!(corner_at((115, 215), RECT, grip), Some(Corner::TopLeft));
        assert_eq!(corner_at((116, 210), RECT, grip), None);
        assert_eq!(corner_at((110, 216), RECT, grip), None);
    }

    #[test]
    fn corner_at_ignores_points_outside_window() {
        let grip = grip_physical(1.0);
        assert_eq!(corner_at((99, 199), RECT, grip), None);
        assert_eq!(corner_at((601, 901), RECT, grip), None);
    }

    #[test]
    fn corner_at_prefers_nearest_when_hot_zones_overlap() {
        // 10×10 的小窗口，12px 热区在四个角全部重叠：按 dx+dy 取最近。
        let small = (0, 0, 10, 10);
        assert_eq!(corner_at((1, 1), small, 12), Some(Corner::TopLeft));
        assert_eq!(corner_at((9, 1), small, 12), Some(Corner::TopRight));
        assert_eq!(corner_at((1, 9), small, 12), Some(Corner::BottomLeft));
        assert_eq!(corner_at((9, 9), small, 12), Some(Corner::BottomRight));
    }

    #[test]
    fn cursor_direction_matches_css_contract() {
        // 与 styles-themes.css 的四角 cursor 一致：tl/br = nwse，tr/bl = nesw。
        assert!(Corner::TopLeft.is_nwse());
        assert!(!Corner::TopRight.is_nwse());
        assert!(!Corner::BottomLeft.is_nwse());
        assert!(Corner::BottomRight.is_nwse());
    }

    #[test]
    fn corner_at_handles_negative_screen_coordinates() {
        // 左侧/上方副屏为负坐标。
        let rect = (-1920, -200, -1320, 500);
        assert_eq!(corner_at((-1920, -200), rect, 15), Some(Corner::TopLeft));
        assert_eq!(corner_at((-1321, 499), rect, 15), Some(Corner::BottomRight));
    }
}
