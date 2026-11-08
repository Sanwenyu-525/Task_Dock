//! 场景/工作现场的窗口几何：捕获载荷、DPI 换算与多显示器收敛。
//!
//! 红线（AGENTS.md §4.6）：HWND/PID 只作运行时身份，绝不落库——本模块的
//! 几何只描述「窗口在屏幕上的矩形 + 显示器设备名 + DPI 缩放」，窗口身份仍由
//! 既有 exe/类名/标题身份链承担；几何恢复只在按身份链找到窗口之后执行。
//!
//! 收敛口径与主窗口位置恢复一致：`commands::settings::is_rect_mostly_visible`
//! 的 60% 可见面积判定。纯函数（plan_restore / rescale_rect / clamp_into /
//! nearest_monitor）全部可确定性单测；Win32 捕获与应用只在 Windows 编译，
//! 其他平台返回空实现（无几何能力，如实降级）。

use serde::{Deserialize, Serialize};

/// 屏幕矩形（物理像素，虚拟屏幕坐标；w/h 为宽高而非右下角）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct GeometryRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl GeometryRect {
    fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }

    fn center(&self) -> (i64, i64) {
        (
            self.x as i64 + self.w as i64 / 2,
            self.y as i64 + self.h as i64 / 2,
        )
    }
}

/// 捕获到的单窗口几何快照（JSON 存入 workspace_snapshot_items.window_geometry_json）。
///
/// 字段全部 `#[serde(default)]`：历史/损坏载荷缺字段时按「无该信息」处理，
/// 恢复路径对不完整数据如实降级，绝不猜测。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowGeometry {
    /// 窗口矩形（GetWindowRect，物理像素）
    pub rect: GeometryRect,
    /// 所在显示器设备名（如 `\\.\DISPLAY1`）；枚举失败为空串，恢复时按可见性兜底
    #[serde(default)]
    pub monitor: String,
    /// 捕获时该显示器的全屏边界：相对定位与布局变化映射的基准
    #[serde(default)]
    pub monitor_rect: GeometryRect,
    /// 捕获时显示器 DPI 缩放（1.0 = 100%）；非法值按 1.0 处理
    #[serde(default)]
    pub scale: f64,
}

/// 恢复时的显示器布局快照（物理像素）。
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorLayout {
    pub name: String,
    /// 全屏边界
    pub bounds: GeometryRect,
    /// 工作区（排除任务栏等保留区域）；取不到时为空矩形，收敛退回全屏边界
    pub work: GeometryRect,
    pub scale: f64,
}

/// 几何恢复规划的降级类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryAdjust {
    /// 显示器与布局、DPI 均未变化，按原样恢复
    AsIs,
    /// 显示器未变但 DPI 缩放变化，已按比例换算
    Rescaled,
    /// 显示器或布局变化，已映射/收敛到当前可见区域
    Converged,
}

/// 几何恢复的逐项结果状态（随 RestoreItemResult 反馈给前端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryRestoreState {
    /// 已按捕获几何恢复（显示器布局未变；含 DPI 换算成功）
    Applied,
    /// 降级：显示器布局变化（换屏/断连/排序变化），已映射或收敛到当前可见区域
    Converged,
    /// 主动跳过：窗口当前最大化，或无法取得显示器信息，保持现状
    Skipped,
    /// 系统拒绝调整位置（窗口本体恢复不受影响）
    Failed,
}

/// DPI 换算因子（当前/捕获）。任一缩放非法（非有限或 ≤0）按 1.0 处理，不换算。
fn dpi_factor(captured: f64, current: f64) -> f64 {
    if !captured.is_finite() || captured <= 0.0 || !current.is_finite() || current <= 0.0 {
        return 1.0;
    }
    current / captured
}

/// 缩放是否等价（容忍浮点误差；常见缩放 1.0/1.25/1.5/2.0 均可精确表示）。
fn scale_equal(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.01
}

/// 把捕获几何映射到目标显示器：尺寸与「窗口-显示器原点偏移」一起按 DPI 比换算。
/// 捕获时无显示器基准（monitor_rect 为空）时只换算尺寸，位置交给可见性收敛。
fn rescale_rect(g: &WindowGeometry, target: &MonitorLayout) -> GeometryRect {
    let factor = dpi_factor(g.scale, target.scale);
    let scale_i = |v: i32| (v as f64 * factor).round() as i32;
    let w = scale_i(g.rect.w).max(1);
    let h = scale_i(g.rect.h).max(1);
    if g.monitor_rect.is_empty() || target.bounds.is_empty() {
        return GeometryRect {
            x: g.rect.x,
            y: g.rect.y,
            w,
            h,
        };
    }
    GeometryRect {
        x: target.bounds.x + ((g.rect.x - g.monitor_rect.x) as f64 * factor).round() as i32,
        y: target.bounds.y + ((g.rect.y - g.monitor_rect.y) as f64 * factor).round() as i32,
        w,
        h,
    }
}

/// 把矩形收敛进目标区域：尺寸钳制进区域内，位置钳制使矩形完整落在区域内。
/// 坐标可能为负（左侧副屏），全部用 i64 计算避免溢出。
fn clamp_into(rect: GeometryRect, area: &GeometryRect) -> GeometryRect {
    let w = (rect.w.max(1) as i64).min(area.w.max(1) as i64) as i32;
    let h = (rect.h.max(1) as i64).min(area.h.max(1) as i64) as i32;
    let min_x = area.x as i64;
    let max_x = (area.x as i64 + area.w as i64 - w as i64).max(min_x);
    let min_y = area.y as i64;
    let max_y = (area.y as i64 + area.h as i64 - h as i64).max(min_y);
    GeometryRect {
        x: (rect.x as i64).clamp(min_x, max_x) as i32,
        y: (rect.y as i64).clamp(min_y, max_y) as i32,
        w,
        h,
    }
}

/// 与矩形中心最近的显示器（欧氏距离平方比较；平局取列表靠前者，确定性输出）。
fn nearest_monitor<'a>(
    rect: &GeometryRect,
    monitors: &'a [MonitorLayout],
) -> Option<&'a MonitorLayout> {
    if monitors.is_empty() {
        return None;
    }
    let (cx, cy) = rect.center();
    monitors.iter().min_by_key(|m| {
        let (mx, my) = m.bounds.center();
        let dx = cx - mx;
        let dy = cy - my;
        dx * dx + dy * dy
    })
}

/// 「大部分可见」判定：复用主窗口位置恢复的 60% 口径（跨屏窗口按总面积）。
fn mostly_visible(rect: &GeometryRect, monitors: &[MonitorLayout]) -> bool {
    use crate::commands::settings::{is_rect_mostly_visible, WindowRect};
    let bounds: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|m| {
            (
                m.bounds.x,
                m.bounds.y,
                m.bounds.w.max(0) as u32,
                m.bounds.h.max(0) as u32,
            )
        })
        .collect();
    is_rect_mostly_visible(
        &WindowRect {
            x: rect.x,
            y: rect.y,
            w: rect.w.max(0) as u32,
            h: rect.h.max(0) as u32,
        },
        &bounds,
    )
}

/// 按当前显示器布局计算恢复矩形与降级类型。
///
/// 规则：
/// 1. 捕获显示器仍存在：以显示器原点做相对映射；DPI 变化时尺寸与偏移一并换算；
///    布局与 DPI 都未变时按原样恢复。
/// 2. 捕获显示器已断开/更名：先尝试原矩形（布局平移但坐标仍可见时有效）。
/// 3. 最终安全网：候选矩形可见面积不足 60% 时一律钳制进最近显示器的工作区，
///    绝不把窗口恢复到屏幕外。
///
/// 返回 None = 无显示器信息或几何不完整，调用方跳过几何恢复（不猜测）。
pub fn plan_restore(
    g: &WindowGeometry,
    monitors: &[MonitorLayout],
) -> Option<(GeometryRect, GeometryAdjust)> {
    if monitors.is_empty() || g.rect.is_empty() {
        return None;
    }
    let named = monitors
        .iter()
        .find(|m| !g.monitor.is_empty() && m.name == g.monitor);
    let (mut rect, mut adjust) = match named {
        Some(target) => {
            let layout_same = !target.bounds.is_empty() && target.bounds == g.monitor_rect;
            let dpi_same = scale_equal(g.scale, target.scale);
            if layout_same && dpi_same {
                (g.rect, GeometryAdjust::AsIs)
            } else {
                (
                    rescale_rect(g, target),
                    if dpi_same {
                        GeometryAdjust::Converged
                    } else {
                        GeometryAdjust::Rescaled
                    },
                )
            }
        }
        None => (g.rect, GeometryAdjust::Converged),
    };
    if !mostly_visible(&rect, monitors) {
        let target = nearest_monitor(&rect, monitors)?;
        let area = if target.work.is_empty() {
            &target.bounds
        } else {
            &target.work
        };
        if area.is_empty() {
            return None;
        }
        rect = clamp_into(rect, area);
        adjust = GeometryAdjust::Converged;
    }
    Some((rect, adjust))
}

// ── Win32 捕获与应用（只在本模块内使用，HWND 不跨调用持有）──────

/// 读取窗口矩形与其所在显示器元数据（物理像素）。
/// 最小化窗口的矩形是 -32000 桩坐标，不可信，直接返回 None。
#[cfg(windows)]
pub(crate) fn capture_window_geometry(hwnd: isize, is_minimized: bool) -> Option<WindowGeometry> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindow};

    unsafe {
        let h = hwnd as HWND;
        if IsWindow(h) == 0 || is_minimized {
            return None;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut rect) == 0 || rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        let hmon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        let mut monitor = String::new();
        let mut monitor_rect = GeometryRect::default();
        if !hmon.is_null() {
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) != 0 {
                let mi = &info.monitorInfo;
                monitor = String::from_utf16_lossy(&info.szDevice)
                    .trim_end_matches('\0')
                    .to_string();
                monitor_rect = GeometryRect {
                    x: mi.rcMonitor.left,
                    y: mi.rcMonitor.top,
                    w: mi.rcMonitor.right - mi.rcMonitor.left,
                    h: mi.rcMonitor.bottom - mi.rcMonitor.top,
                };
            }
        }
        let dpi = GetDpiForWindow(h);
        Some(WindowGeometry {
            rect: GeometryRect {
                x: rect.left,
                y: rect.top,
                w: rect.right - rect.left,
                h: rect.bottom - rect.top,
            },
            monitor,
            monitor_rect,
            scale: if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 },
        })
    }
}

#[cfg(not(windows))]
pub(crate) fn capture_window_geometry(_hwnd: isize, _is_minimized: bool) -> Option<WindowGeometry> {
    None
}

/// 当前显示器布局（物理像素）。空列表 = 无法获取，调用方跳过几何恢复。
#[cfg(windows)]
pub(crate) fn monitor_layouts(app: &tauri::AppHandle) -> Vec<MonitorLayout> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            let work = m.work_area();
            MonitorLayout {
                name: m.name().cloned().unwrap_or_default(),
                bounds: GeometryRect {
                    x: p.x,
                    y: p.y,
                    w: s.width as i32,
                    h: s.height as i32,
                },
                work: GeometryRect {
                    x: work.position.x,
                    y: work.position.y,
                    w: work.size.width as i32,
                    h: work.size.height as i32,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

#[cfg(not(windows))]
pub(crate) fn monitor_layouts(_app: &tauri::AppHandle) -> Vec<MonitorLayout> {
    Vec::new()
}

/// 窗口当前是否处于最大化（最大化窗口不调整几何，避免打断系统状态）。
#[cfg(windows)]
pub(crate) fn window_is_maximized(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, IsZoomed};
    unsafe { IsWindow(hwnd as HWND) != 0 && IsZoomed(hwnd as HWND) != 0 }
}

#[cfg(not(windows))]
pub(crate) fn window_is_maximized(_hwnd: isize) -> bool {
    false
}

/// 把窗口移动/缩放到目标矩形（物理像素）。不改 Z 序、不抢激活（前台已由
/// 唤醒步骤处理）；SetWindowPos 单次调用，无轮询、无新增长时等待。
#[cfg(windows)]
pub(crate) fn set_window_rect(hwnd: isize, rect: &GeometryRect) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    unsafe {
        SetWindowPos(
            hwnd as HWND,
            std::ptr::null_mut(),
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        ) != 0
    }
}

#[cfg(not(windows))]
pub(crate) fn set_window_rect(_hwnd: isize, _rect: &GeometryRect) -> bool {
    false
}

/// 快照条目几何字段的落库文本（None = 空串）。序列化失败按无几何处理，
/// 绝不让几何编码失败阻塞整个快照保存。
pub(crate) fn geometry_json_text(g: Option<&WindowGeometry>) -> String {
    g.map(serde_json::to_string)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default()
}

/// 从落库文本解析几何（空串/损坏 = None，恢复时如实按无几何降级）。
pub(crate) fn geometry_from_json(raw: &str) -> Option<WindowGeometry> {
    if raw.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<WindowGeometry>(raw) {
        Ok(g) => Some(g),
        Err(e) => {
            tracing::warn!("工作现场条目几何数据损坏，按无几何恢复: {}", e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: i32, h: i32) -> GeometryRect {
        GeometryRect { x, y, w, h }
    }

    fn geometry(
        rect: GeometryRect,
        monitor: &str,
        monitor_rect: GeometryRect,
        scale: f64,
    ) -> WindowGeometry {
        WindowGeometry {
            rect,
            monitor: monitor.into(),
            monitor_rect,
            scale,
        }
    }

    fn monitor(name: &str, bounds: GeometryRect, work: GeometryRect, scale: f64) -> MonitorLayout {
        MonitorLayout {
            name: name.into(),
            bounds,
            work,
            scale,
        }
    }

    // ── DPI 换算 ──────────────────────────────────────────────

    #[test]
    fn dpi_factor_handles_invalid_scales() {
        assert_eq!(dpi_factor(1.0, 1.0), 1.0);
        assert_eq!(dpi_factor(1.0, 2.0), 2.0);
        assert_eq!(dpi_factor(2.0, 1.0), 0.5);
        assert_eq!(dpi_factor(0.0, 1.5), 1.0, "非法捕获缩放不换算");
        assert_eq!(dpi_factor(1.5, -1.0), 1.0);
        assert_eq!(dpi_factor(f64::NAN, 1.5), 1.0);
        assert_eq!(dpi_factor(1.5, f64::INFINITY), 1.0);
    }

    #[test]
    fn rescale_rect_scales_size_and_offset_together() {
        // 捕获：100% 屏左上副屏 (0,0,1920,1080)，窗口 (100,200,800,600)
        let g = geometry(rect(100, 200, 800, 600), "d1", rect(0, 0, 1920, 1080), 1.0);
        // 目标：同一位置现在是 200% 屏 → 尺寸与偏移都翻倍
        let target200 = monitor("d1", rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040), 2.0);
        assert_eq!(
            rescale_rect(&g, &target200),
            rect(200, 400, 1600, 1200),
            "DPI 变化时尺寸与显示器相对偏移都按比例换算"
        );
        // 反向：捕获于 200%，目标 100% → 回到原矩形（换算可逆）
        let g2 = geometry(
            rect(200, 400, 1600, 1200),
            "d1",
            rect(0, 0, 1920, 1080),
            2.0,
        );
        let target100 = monitor("d1", rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040), 1.0);
        assert_eq!(rescale_rect(&g2, &target100), g.rect, "换算必须可逆");
        // 负坐标副屏：显示器原点 -1920，窗口偏移相对显示器
        let g3 = geometry(
            rect(-1820, 200, 800, 600),
            "d0",
            rect(-1920, 0, 1920, 1080),
            1.0,
        );
        let target3 = monitor(
            "d0",
            rect(-1920, 0, 1920, 1080),
            rect(-1920, 0, 1920, 1040),
            2.0,
        );
        assert_eq!(
            rescale_rect(&g3, &target3),
            rect(-1720, 400, 1600, 1200),
            "负坐标副屏同样按显示器原点换算"
        );
    }

    #[test]
    fn rescale_rect_without_monitor_base_keeps_position() {
        // 捕获时显示器边界缺失：只换算尺寸，位置交给可见性收敛
        let g = geometry(rect(100, 200, 800, 600), "d1", GeometryRect::default(), 1.0);
        let target = monitor("d1", rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040), 2.0);
        assert_eq!(rescale_rect(&g, &target), rect(100, 200, 1600, 1200));
    }

    // ── clamp_into / nearest_monitor ──────────────────────────

    #[test]
    fn clamp_into_keeps_rect_inside_work_area() {
        let work = rect(0, 0, 1920, 1040);
        // 完全在屏外右侧
        assert_eq!(
            clamp_into(rect(3000, 100, 800, 600), &work),
            rect(1120, 100, 800, 600)
        );
        // 完全在屏外上方（负坐标）
        assert_eq!(
            clamp_into(rect(100, -5000, 800, 600), &work),
            rect(100, 0, 800, 600)
        );
        // 比工作区还大：尺寸钳制到工作区，位置落在左上角
        assert_eq!(
            clamp_into(rect(10, 10, 5000, 5000), &work),
            rect(0, 0, 1920, 1040)
        );
        // 空矩形输入：至少 1×1
        let got = clamp_into(GeometryRect::default(), &work);
        assert_eq!((got.w, got.h), (1, 1));
    }

    #[test]
    fn clamp_into_works_on_negative_origin_monitor() {
        let work = rect(-1920, 0, 1920, 1040);
        // 窗口落在主屏区域（在左侧屏右边界之外）：收敛进左侧屏的右缘
        assert_eq!(
            clamp_into(rect(100, 100, 800, 600), &work),
            rect(-800, 100, 800, 600)
        );
        // 完全在左侧屏左边界之外：贴左缘
        assert_eq!(
            clamp_into(rect(-5000, 100, 800, 600), &work),
            rect(-1920, 100, 800, 600)
        );
    }

    #[test]
    fn nearest_monitor_prefers_closest_center_and_first_on_tie() {
        let monitors = vec![
            monitor("d0", rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040), 1.0),
            monitor(
                "d1",
                rect(1920, 0, 1920, 1080),
                rect(1920, 0, 1920, 1040),
                1.0,
            ),
        ];
        assert_eq!(
            nearest_monitor(&rect(2000, 100, 800, 600), &monitors)
                .unwrap()
                .name,
            "d1"
        );
        assert_eq!(
            nearest_monitor(&rect(100, 100, 800, 600), &monitors)
                .unwrap()
                .name,
            "d0"
        );
        // 矩形中心恰在两屏中心的中点：等距 → 取列表靠前（确定性）
        assert_eq!(
            nearest_monitor(&rect(1520, 240, 800, 600), &monitors)
                .unwrap()
                .name,
            "d0"
        );
        assert!(nearest_monitor(&rect(1, 1, 1, 1), &[]).is_none());
    }

    // ── plan_restore ──────────────────────────────────────────

    #[test]
    fn plan_restore_applies_asis_when_layout_and_dpi_unchanged() {
        let g = geometry(rect(100, 200, 800, 600), "d1", rect(0, 0, 1920, 1080), 1.5);
        let monitors = vec![monitor(
            "d1",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            1.5,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(r, g.rect);
        assert_eq!(a, GeometryAdjust::AsIs);
    }

    #[test]
    fn plan_restore_rescales_when_dpi_changed() {
        let g = geometry(rect(100, 200, 400, 300), "d1", rect(0, 0, 1920, 1080), 1.0);
        let monitors = vec![monitor(
            "d1",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            2.0,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(r, rect(200, 400, 800, 600));
        assert_eq!(a, GeometryAdjust::Rescaled);
    }

    #[test]
    fn plan_restore_maps_relative_offset_when_monitor_moved() {
        // 同名显示器从 (0,0) 挪到 (-1920,0)（用户交换了左右副屏）
        let g = geometry(rect(100, 200, 800, 600), "d1", rect(0, 0, 1920, 1080), 1.0);
        let monitors = vec![
            monitor("d0", rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040), 1.0),
            monitor(
                "d1",
                rect(-1920, 0, 1920, 1080),
                rect(-1920, 0, 1920, 1040),
                1.0,
            ),
        ];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(
            r,
            rect(-1820, 200, 800, 600),
            "保持窗口在显示器内的相对位置"
        );
        assert_eq!(a, GeometryAdjust::Converged);
    }

    #[test]
    fn plan_restore_converges_when_monitor_disconnected_and_rect_invisible() {
        // 副屏已断开：原坐标不再可见 → 收敛到剩下主屏的工作区
        let g = geometry(
            rect(2400, 200, 800, 600),
            "d1",
            rect(1920, 0, 1920, 1080),
            1.0,
        );
        let monitors = vec![monitor(
            "d0",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            1.0,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(r, rect(1120, 200, 800, 600), "钳制进工作区右侧");
        assert_eq!(a, GeometryAdjust::Converged);
    }

    #[test]
    fn plan_restore_keeps_rect_when_monitor_disconnected_but_still_visible() {
        // 布局平移但坐标恰好仍落在可见区域：保留原矩形，标注降级
        let g = geometry(rect(100, 200, 800, 600), "d9", rect(0, 0, 1920, 1080), 1.0);
        let monitors = vec![monitor(
            "d0",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            1.0,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(r, g.rect);
        assert_eq!(a, GeometryAdjust::Converged);
    }

    #[test]
    fn plan_restore_clamps_oversized_rect_into_work_area() {
        // 大屏换小屏（同名显示器分辨率降低）：换算出的矩形放不下 → 安全网钳制
        let g = geometry(rect(0, 0, 3000, 1800), "d1", rect(0, 0, 3840, 2160), 1.0);
        let monitors = vec![monitor(
            "d1",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            1.0,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(r, rect(0, 0, 1920, 1040), "过大窗口收敛进工作区");
        assert_eq!(a, GeometryAdjust::Converged);
    }

    #[test]
    fn plan_restore_never_places_window_offscreen() {
        // 最大化捕获矩形（越出工作区边缘）在布局不变时仍应基本可见、不被误收敛
        let g = geometry(rect(-8, -8, 1936, 1056), "d1", rect(0, 0, 1920, 1080), 1.0);
        let monitors = vec![monitor(
            "d1",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            1.0,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(a, GeometryAdjust::AsIs);
        assert_eq!(r, g.rect, "可见性达标时不做多余调整");
    }

    #[test]
    fn plan_restore_rejects_incomplete_input() {
        let monitors = vec![monitor(
            "d0",
            rect(0, 0, 1920, 1080),
            rect(0, 0, 1920, 1040),
            1.0,
        )];
        // 无显示器信息：不猜测
        assert!(plan_restore(
            &geometry(rect(1, 1, 1, 1), "d0", rect(0, 0, 10, 10), 1.0),
            &[]
        )
        .is_none());
        // 空矩形（捕获失败的残留）：不猜测
        assert!(plan_restore(
            &geometry(GeometryRect::default(), "d0", rect(0, 0, 10, 10), 1.0),
            &monitors
        )
        .is_none());
    }

    #[test]
    fn plan_restore_falls_back_to_bounds_when_work_area_missing() {
        // 工作区取不到（空矩形）：收敛退回全屏边界
        let g = geometry(rect(5000, 100, 800, 600), "d0", rect(0, 0, 1920, 1080), 1.0);
        let monitors = vec![monitor(
            "d0",
            rect(0, 0, 1920, 1080),
            GeometryRect::default(),
            1.0,
        )];
        let (r, a) = plan_restore(&g, &monitors).unwrap();
        assert_eq!(r, rect(1120, 100, 800, 600));
        assert_eq!(a, GeometryAdjust::Converged);
    }

    // ── JSON 往返 ─────────────────────────────────────────────

    #[test]
    fn geometry_json_round_trips() {
        let g = geometry(
            rect(-1820, 200, 800, 600),
            "\\\\.\\DISPLAY1",
            rect(-1920, 0, 1920, 1080),
            1.25,
        );
        let text = geometry_json_text(Some(&g));
        assert_eq!(geometry_from_json(&text), Some(g));
        assert_eq!(geometry_from_json(""), None);
        assert_eq!(geometry_from_json("   "), None);
        assert_eq!(geometry_from_json("{broken"), None, "损坏载荷按无几何降级");
        assert_eq!(geometry_json_text(None), "");
    }

    #[test]
    fn geometry_json_partial_fields_default_safely() {
        // 旧/损坏载荷缺字段：rect 必填，其余按默认值兜底而不是报错
        let g: WindowGeometry =
            serde_json::from_str(r#"{"rect":{"x":1,"y":2,"w":3,"h":4}}"#).unwrap();
        assert_eq!(g.monitor, "");
        assert_eq!(g.monitor_rect, GeometryRect::default());
        assert_eq!(g.scale, 0.0, "非法缩放由 dpi_factor 兜底为不换算");
    }
}
