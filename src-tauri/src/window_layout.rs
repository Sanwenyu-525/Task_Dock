//! 桌面端窗口尺寸规范（唯一事实源，2026-11-16）。
//!
//! 背景：完整工作台此前在创建时写死 `min_inner_size(880, 600)`，并且在恢复几何时
//! 把「逻辑像素最小尺寸」直接和「物理像素窗口矩形」比较——125%/150% 缩放下最小尺寸
//! 实际被放宽到 704/587 DIP，工具栏与三栏布局被压缩到控件互相覆盖。这里把
//! **窗口尺寸策略**收敛到一处，供工作台窗口（以及后续独立专业窗口）复用。
//!
//! 三条口径：
//! 1. **DIP 优先**：所有常量、计算与 Tauri `LogicalSize` 一致；物理像素只在
//!    「恢复已保存几何 / 原生区域」边界换算，绝不把两者混用（历史缺陷根因）。
//! 2. **可用区而不是分辨率**：以 `Monitor::work_area()`（已扣除任务栏）为准，
//!    并留出 `WORK_AREA_MARGIN` 安全边，避免窗口贴边后被任务栏/圆角裁掉。
//! 3. **小屏降级而不是突破屏幕**：可用区不足 960×600 时最小尺寸跟着降到可用区，
//!    但不低于 720×480 的布局下限；再小的屏幕直接等于可用区（宁可让响应式布局
//!    接管，也不能让窗口开不出来）。
//!
//! 这里只回答「窗口多大」，不回答「内容怎么排」——内容响应式见
//! `docs/window-size-spec.md`（按内容容器宽度响应）。

use std::sync::Mutex;
use tauri::{LogicalSize, Runtime, WebviewWindow};

/// 大型完整工作台默认打开尺寸（DIP）。
pub const WORKBENCH_DEFAULT_WIDTH: f64 = 1200.0;
pub const WORKBENCH_DEFAULT_HEIGHT: f64 = 760.0;
/// 大型完整工作台标准最小尺寸（DIP）：顶栏（项目选择器 + 搜索 + 工具组 + 窗口按钮）
/// 与「导航 200 + 主内容」两栏在该宽度下均有可用空间。
pub const WORKBENCH_MIN_WIDTH: f64 = 960.0;
pub const WORKBENCH_MIN_HEIGHT: f64 = 600.0;
/// 屏幕可用区不足时的布局下限（DIP）。
///
/// 只作规范口径（`docs/window-size-spec.md` §3 与前端 `WINDOW_METRICS.workbench.floor`
/// 对齐用），**不作为窗口硬下限**：可用区本身小于它时（640×480 远程桌面），
/// 取下限会让窗口大于屏幕、反而开不出来，这种情况交给内容响应式接管。
#[allow(dead_code)]
pub const WORKBENCH_FLOOR_WIDTH: f64 = 720.0;
#[allow(dead_code)]
pub const WORKBENCH_FLOOR_HEIGHT: f64 = 480.0;
/// 窗口与工作区边缘的安全留白（DIP）：避免最大化/贴边时被任务栏或圆角裁切。
pub const WORK_AREA_MARGIN: f64 = 12.0;

// ── 主窗口（`main`）的形态最小尺寸（DIP）────────────────────────────
//
// 与工作台不是同一套：主窗是 400px 级的快速面板，最小尺寸由**核心控件**决定，
// 不套用 960×600。极简下限见 `commands::system::mode_min_size` 的注释
// （240×96 实测会把「待办」挤成竖排、按钮被裁）；三个形态各自独立，
// 模式切换时先写最小尺寸再写目标尺寸，从完整面板切极简不会被旧下限卡住。

/// 极简（minimal）：标题栏 5 个控件 + 一行核心状态的最小可读尺寸。
pub const MAIN_MINIMAL_MIN_WIDTH: f64 = 264.0;
pub const MAIN_MINIMAL_MIN_HEIGHT: f64 = 112.0;
/// 紧凑（compact）：侧轨 + 任务列表的最小尺寸。
pub const MAIN_COMPACT_MIN_WIDTH: f64 = 340.0;
pub const MAIN_COMPACT_MIN_HEIGHT: f64 = 280.0;
/// 完整（full）：侧轨 + 内容区的最小尺寸。
pub const MAIN_FULL_MIN_WIDTH: f64 = 340.0;
pub const MAIN_FULL_MIN_HEIGHT: f64 = 340.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SizePlan {
    pub width: f64,
    pub height: f64,
}

impl SizePlan {
    pub fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }

    /// 以物理像素/缩放比回算 DIP（用于把已保存的物理矩形换算成可比较的逻辑尺寸）。
    pub fn from_physical(width: u32, height: u32, scale: f64) -> Self {
        let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
        Self::new(width as f64 / scale, height as f64 / scale)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPlan {
    /// 首次打开尺寸（已收敛进可用区）。
    pub default: SizePlan,
    /// 原生最小尺寸（原生 `min_inner_size` / `set_min_size` 用这个）。
    pub min: SizePlan,
}

impl WindowPlan {
    pub fn min_logical(&self) -> LogicalSize<f64> {
        LogicalSize::new(self.min.width, self.min.height)
    }

    pub fn default_logical(&self) -> LogicalSize<f64> {
        LogicalSize::new(self.default.width, self.default.height)
    }
}

/// 可用区（DIP）→ 窗口尺寸计划。
///
/// `None` 表示取不到显示器信息（无头/早期启动）：按标准值，不做任何降级，
/// 保证窗口行为与显示器已知时一致，而不是悄悄缩成最小值。
pub fn plan_for_area(area: Option<(f64, f64)>) -> WindowPlan {
    let Some((area_w, area_h)) = area else {
        return WindowPlan {
            default: SizePlan::new(WORKBENCH_DEFAULT_WIDTH, WORKBENCH_DEFAULT_HEIGHT),
            min: SizePlan::new(WORKBENCH_MIN_WIDTH, WORKBENCH_MIN_HEIGHT),
        };
    };
    // 1) 留出安全边；下限防止极小/异常值把可用区算成负数。
    let usable_w = (area_w - WORK_AREA_MARGIN * 2.0).max(320.0);
    let usable_h = (area_h - WORK_AREA_MARGIN * 2.0).max(240.0);

    // 2) 最小尺寸：标准值优先，可用区不足时跟随可用区（可能低于布局下限
    //    `WORKBENCH_FLOOR_*`，此时仍以可用区为准，保证窗口开得出来）。
    let min_w = clamp_floor(WORKBENCH_MIN_WIDTH, usable_w);
    let min_h = clamp_floor(WORKBENCH_MIN_HEIGHT, usable_h);

    // 3) 默认尺寸：目标值收敛进可用区，但不小于最小尺寸。
    let default_w = WORKBENCH_DEFAULT_WIDTH.min(usable_w).max(min_w);
    let default_h = WORKBENCH_DEFAULT_HEIGHT.min(usable_h).max(min_h);

    WindowPlan {
        default: SizePlan::new(default_w.round(), default_h.round()),
        min: SizePlan::new(min_w.round(), min_h.round()),
    }
}

/// `standard` 在 `usable` 之内就取标准值，否则取可用区。
///
/// 不把 `WORKBENCH_FLOOR_*` 作为硬下限：可用区本身小于下限时（如 640×480 远程桌面），
/// 取下限会让窗口大于屏幕、反而开不出来；这种情况交给内容响应式接管。
fn clamp_floor(standard: f64, usable: f64) -> f64 {
    if usable >= standard {
        standard
    } else {
        usable
    }
}

/// 当前显示器工作区（DIP）。取不到时返回 `None`（调用方走标准值）。
pub fn current_work_area<R: Runtime>(win: &WebviewWindow<R>) -> Option<(f64, f64)> {
    let monitor = win.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let area = monitor.work_area();
    Some((
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    ))
}

/// 按显示器给出尺寸计划（窗口尚未创建时用这个，创建后再用 `plan_for_window`）。
pub fn plan_for_monitor(monitor: &tauri::Monitor) -> WindowPlan {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    if !scale.is_finite() || scale <= 0.0 {
        return plan_for_area(None);
    }
    plan_for_area(Some((
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    )))
}

/// 按窗口当前所在显示器给出尺寸计划。
pub fn plan_for_window<R: Runtime>(win: &WebviewWindow<R>) -> WindowPlan {
    plan_for_area(current_work_area(win))
}

/// 应用最小尺寸，并把「越过可用区 / 小于最小尺寸」的当前窗口收敛回来。
///
/// 只做两件事：原生最小尺寸 + 必要的越界修正；合法尺寸一律不动，
/// 避免在用户拖动过程中反复改写几何。
pub fn apply_window_metrics<R: Runtime>(win: &WebviewWindow<R>) {
    let plan = plan_for_window(win);
    let _ = win.set_min_size(Some(plan.min_logical()));

    let Ok(size) = win.inner_size() else {
        return;
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let current = SizePlan::from_physical(size.width, size.height, scale);
    let available = current_work_area(win);
    let Some((area_w, area_h)) = available else {
        // 没有可用区信息时只保证不违反最小尺寸。
        if current.width + 0.5 < plan.min.width || current.height + 0.5 < plan.min.height {
            let _ = win.set_size(LogicalSize::new(
                current.width.max(plan.min.width),
                current.height.max(plan.min.height),
            ));
        }
        return;
    };
    let max_w = (area_w - WORK_AREA_MARGIN * 2.0).max(plan.min.width);
    let max_h = (area_h - WORK_AREA_MARGIN * 2.0).max(plan.min.height);

    let target_w = current.width.clamp(plan.min.width, max_w);
    let target_h = current.height.clamp(plan.min.height, max_h);
    if (target_w - current.width).abs() > 0.5 || (target_h - current.height).abs() > 0.5 {
        let _ = win.set_size(LogicalSize::new(target_w.round(), target_h.round()));
    }
}

/// 跨显示器 / DPI 变化时重算最小尺寸。
///
/// 判据是「工作区矩形 + 缩放比」的签名变化，而不是 `Moved` 事件本身：
/// 同一显示器内拖动不会触发任何 `set_min_size`（避免逐帧改窗口约束）。
pub fn watch_monitor_changes<R: Runtime>(win: &WebviewWindow<R>) {
    #[derive(Clone, Copy, PartialEq)]
    struct Signature {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        scale_milli: i64,
    }

    // 只保留「上次已应用的显示器签名」：同一显示器内拖动不会重复应用。
    // 不做时间节流——签名比较已经把应用次数限制为「每次真正跨屏一次」，
    // 而时间节流会在跨屏后立刻停手时丢掉最后一次应用（窗口停在旧约束上）。
    let state: Mutex<Option<Signature>> = Mutex::new(None);
    let target = win.clone();

    // 监听器里持有的是 `target`（窗口句柄克隆），`win` 只作为注册时的借用方：
    // 直接把 `win` move 进闭包会与 `on_window_event(&self)` 的借用冲突（E0505）。
    win.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            return;
        }
        // 最大化/最小化期间窗口矩形由系统决定，不在这里改约束。
        if target.is_maximized().unwrap_or(false) || target.is_minimized().unwrap_or(false) {
            return;
        }

        let signature = target.current_monitor().ok().flatten().map(|monitor| {
            let area = monitor.work_area();
            Signature {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
                scale_milli: (monitor.scale_factor() * 1000.0).round() as i64,
            }
        });
        let Ok(mut guard) = state.lock() else {
            return;
        };
        if signature.is_some() && *guard == signature {
            return;
        }
        *guard = signature;
        drop(guard);
        apply_window_metrics(&target);
        tracing::info!(
            label = target.label(),
            "显示器变化：窗口最小尺寸与可用区约束已重算"
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_desktop_keeps_960x600_floor_and_1200x760_default() {
        // 1920×1080 + 任务栏（工作区 1920×1040）
        let plan = plan_for_area(Some((1920.0, 1040.0)));
        assert_eq!(plan.min, SizePlan::new(960.0, 600.0));
        assert_eq!(plan.default, SizePlan::new(1200.0, 760.0));
    }

    #[test]
    fn laptop_screen_shrinks_default_but_keeps_min_standard() {
        // 1366×768 笔记本（工作区 1366×728）：默认宽度收敛到可用区，最小仍是标准值
        let plan = plan_for_area(Some((1366.0, 728.0)));
        assert_eq!(plan.min, SizePlan::new(960.0, 600.0));
        assert_eq!(plan.default, SizePlan::new(1200.0, 704.0));
    }

    #[test]
    fn small_screen_degrades_min_size_into_available_area() {
        // 1024×768：可用 1024-24=1000 → 最小仍 960；默认 1200 收敛到 1000
        let plan = plan_for_area(Some((1024.0, 728.0)));
        assert_eq!(plan.min, SizePlan::new(960.0, 600.0));
        assert_eq!(plan.default, SizePlan::new(1000.0, 704.0));

        // 800×600：可用 776×576，低于标准最小 → 最小跟随可用区，窗口仍能打开
        let plan = plan_for_area(Some((800.0, 600.0)));
        assert_eq!(plan.min, SizePlan::new(776.0, 576.0));
        assert_eq!(plan.default, SizePlan::new(776.0, 576.0));
    }

    #[test]
    fn tiny_screen_never_exceeds_available_area() {
        // 640×480 的远程桌面/旧机器：可用 616×456 已低于布局下限，仍以可用区为准
        let plan = plan_for_area(Some((640.0, 480.0)));
        assert!(plan.min.width <= 616.0);
        assert!(plan.min.height <= 456.0);
        assert!(plan.default.width <= 616.0);
        assert!(plan.default.height <= 456.0);
        assert!(plan.default.width >= plan.min.width);
        assert!(plan.default.height >= plan.min.height);
    }

    #[test]
    fn unknown_monitor_falls_back_to_standard_spec() {
        let plan = plan_for_area(None);
        assert_eq!(plan.min, SizePlan::new(960.0, 600.0));
        assert_eq!(plan.default, SizePlan::new(1200.0, 760.0));
    }

    #[test]
    fn physical_size_converts_with_scale_factor() {
        // 125% 缩放下 1200×950 物理 = 960×760 DIP，不能当成 1200×950 DIP 比较
        assert_eq!(SizePlan::from_physical(1200, 950, 1.25), SizePlan::new(960.0, 760.0));
        assert_eq!(SizePlan::from_physical(1200, 950, 0.0), SizePlan::new(1200.0, 950.0));
        assert_eq!(SizePlan::from_physical(2400, 1520, 2.0), SizePlan::new(1200.0, 760.0));
    }

    #[test]
    fn dpi_scaled_min_size_matches_standard_in_dip() {
        // 无论缩放比，原生最小尺寸始终以 DIP 表达：150% 下 960 DIP = 1440 物理
        let plan = plan_for_area(Some((1920.0, 1040.0)));
        let physical_w = plan.min.width * 1.5;
        assert_eq!(physical_w, 1440.0);
        assert_eq!(SizePlan::from_physical(1440, 900, 1.5), plan.min);
    }
}
