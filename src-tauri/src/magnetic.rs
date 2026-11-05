//! 拖拽磁力（磁吸吸引 + 脱离阻力），基于 `WM_MOVING` 修正移动矩形。
//!
//! ## 为什么在原生层做
//!
//! 窗口拖拽走 `data-tauri-drag-region` → `start_dragging` → tao 的
//! `PostMessageW(WM_NCLBUTTONDOWN, HTCAPTION)`，系统随即进入**模态移动循环**。
//! 该循环每帧向窗口发 `WM_MOVING`，`lParam` 是「本次提议的窗口矩形」——改写它
//! 就能让窗口偏离鼠标 1:1 轨迹，这就是磁力的物理载体。
//!
//! 关键事实（`tao-0.37.2/src/platform_impl/windows/`）：
//! - `handle_os_dragging()` 用 `PostMessageW` 起拖，因此 IPC 线程不被阻塞；
//! - tao 只处理 `WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE`（置位/清位
//!   `MARKER_IN_SIZE_MOVE`），**不处理 `WM_MOVING`**，该消息原样落到
//!   `DefWindowProc`。子类化后由我们改写 `lParam` 再交回原窗口过程即可。
//!
//! 之所以不在 React 里高频 `setPosition`：那会与系统拖拽循环争抢窗口位置
//! （循环每帧把窗口拉回鼠标轨迹），既抖动又必然丢帧。
//!
//! ## Windows Snap 抑制（停靠期）
//!
//! 停靠态的胶囊齐平贴在屏幕边上，用户向外拖动时**原生拖拽循环的起点光标就落在
//! 系统贴靠区里**（顶边 = Snap Bar，左右边 = 贴靠飞出）。窗口若具备"可最大化"
//! 资格，Windows 11 会在拖拽悬停时弹出分屏布局——这正是"解除吸附误触发系统
//! 分屏"的根因；系统在移动循环里给出的贴靠矩形也会改窗口尺寸，与磁力锚点冲突。
//!
//! 处理（按窗口、按状态，不动系统设置、不影响其他窗口）：
//! - Aero Snap / Snap Layouts 只作用于**可最大化**窗口（顶部贴靠 = 最大化）。
//!   停靠期间清除主窗的 `WS_MAXIMIZEBOX`，系统即不再为它提供任何贴靠 UI；
//!   该样式与 `WS_SIZEBOX`（手动缩放）互相独立，普通拖拽与尺寸能力不受影响。
//! - 停靠事务提交（`set_dock(Some)`）时清除，解除（`set_dock(None)`）时恢复。
//! - 解除若发生在**拖拽循环内**（用户拖出阈值触发），恢复推迟到
//!   `WM_EXITSIZEMOVE`：保证"从吸附状态拖出"的整个手势期间贴靠 UI 不介入。
//! - `WM_ENTERSIZEMOVE` 时若仍停靠则重申清除（自愈：tao 侧任何标志位重算
//!   都会整窗重写样式并还原该位，见 `WindowFlags::apply_diff`）。
//!
//! ## 两种手感，两套曲线
//!
//! | | 自由窗口（吸引） | 停靠窗口（阻力） |
//! |---|---|---|
//! | 目标 | 窗口**领先**鼠标，主动靠向屏幕边 | 窗口**落后**鼠标，被磁力拉住 |
//! | 曲线 | `lead = M·smoothstep(1 − d/R)`，且 `lead ≤ d` | `disp = d²/(2·D)`（d < D） |
//! | 边界 | `d = R` 处 lead = 0（连续），`d ≤ M` 时贴平 | `d = D` 处一次性释放 |
//!
//! 两者都用**停靠边法向坐标**计算：沿边方向不参与任何磁力/解除判定
//! （否则沿边滑动胶囊会被误判成拖离）。
//!
//! ## 无位置反馈环
//!
//! 模型只读「系统提议矩形 + 本次拖拽内累积的游标位移」，**从不读窗口实际位置**。
//! 系统移动循环的锚点（`ptDrag`）在循环开始时固定，我们的改写不会回灌到下一次
//! 提议矩形，因此不存在"越吸越偏"的累积。这一点由 `TASK_DOCK_MAGNET_TRACE=1`
//! 的轨迹（proposed vs applied）在真机上验证。
//!
//! ## 拖离解除的鼠标锚定（v0.7）
//!
//! 拖离解除发生在**原生拖拽循环内**：前端判定拖离意图后走 `set_undock_anchor`
//! 挂起一次锚定请求，`WM_MOVING` 在下一帧把窗口一次性改写为「模式尺寸 +
//! 标题栏中心对齐光标」的目标矩形（`undock_anchor_rect`）。这样：
//! - 恢复尺寸与重新定位在同一个拖拽帧内原子完成，不出现"先按旧尺寸跟手、
//!   松手后再瞬移"的两段式跳变；
//! - `DragAnchor` 立即重锚到目标矩形，后续帧继续 1:1 跟手，用户无需松手重抓；
//! - 尺寸/位置只由原生拖拽循环写，React 不参与逐帧定位（无争抢）。
//!
//! 请求的生命周期：`request_undock_anchor` 置位 → 下一帧 `WM_MOVING` 消费并置
//! `ANCHOR_APPLIED` → 前端在尺寸恢复确认后 `take_undock_anchor_applied` 查询；
//! 若请求时拖拽已结束（`WM_EXITSIZEMOVE` 先到），请求就地作废，由前端按实际
//! 恢复后的尺寸自行定位（`undockAnchorTarget`，跨端同口径）。`WM_ENTERSIZEMOVE`
//! 会清掉陈旧请求——它只可能来自上一轮已收尾的解除，不得影响新一轮拖拽。
//! 按钮解除 / 打开完整页 / 托盘唤回等非拖拽路径**不**发起该请求。

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};

// ── 参数（CSS px；物理像素 = CSS × DPI 缩放）─────────────────
//
// 与前端 `src/lib/edgeSnap.ts` 的 `SNAP_MAGNET_*` 是**跨端契约**：
// 两端各有单测锁定同一组数字，改动必须同步（见 `magnet_contract_matches_frontend`）。

/// 吸引作用范围：窗口距边缘 ≤ 该值开始受磁力（宽于停靠确认阈值 24，
/// 「先有吸力、后出提示」）。2026-11-02 由 56 收窄到 50（用户反馈介入过早）。
pub const ATTRACT_RANGE_CSS: f64 = 50.0;
/// 最大额外吸引位移（窗口领先鼠标的上限）。
pub const ATTRACT_MAX_LEAD_CSS: f64 = 16.0;
/// 脱离所需拖动位移（游标沿法向向外的位移）。
pub const RELEASE_DRAG_CSS: f64 = 32.0;
/// 脱离**提交**阈值（窗口实际位移）：小于它松手则回弹贴平。
/// 与前端 `SNAP_UNDOCK_DRAG_PX` 同值——两套规则必须指向同一物理量。
pub const COMMIT_DRAG_CSS: f64 = 24.0;
/// 重新武装距离：突破后窗口需离开边缘超过该值才重新受吸引（滞回）。
pub const REARM_DIST_CSS: f64 = 96.0;
/// 释放后残留滞后（游标与窗口的位置差）的衰减时间常数。
pub const LAG_DECAY_MS: f64 = 110.0;

/// 方向枚举：与前端 `SnapEdge` 一一对应（0=left 1=right 2=top 3=bottom）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

pub const EDGES: [Edge; 4] = [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom];

impl Edge {
    pub fn from_id(id: u8) -> Option<Edge> {
        match id {
            0 => Some(Edge::Left),
            1 => Some(Edge::Right),
            2 => Some(Edge::Top),
            3 => Some(Edge::Bottom),
            _ => None,
        }
    }

    pub fn id(self) -> u8 {
        match self {
            Edge::Left => 0,
            Edge::Right => 1,
            Edge::Top => 2,
            Edge::Bottom => 3,
        }
    }

    /// 法向是否沿 x 轴（左右停靠）——沿边方向是另一条轴。
    pub fn normal_is_x(self) -> bool {
        matches!(self, Edge::Left | Edge::Right)
    }

    /// 外法向符号：+1 = 「离开屏幕边」时坐标增大（left/top），-1 = 坐标减小（right/bottom）。
    pub fn outward_sign(self) -> i32 {
        match self {
            Edge::Left | Edge::Top => 1,
            Edge::Right | Edge::Bottom => -1,
        }
    }
}

/// 矩形（物理像素，左上角 + 宽高），与 Tauri `outerPosition/outerSize` 同口径。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
}

/// 窗口到工作区某条边的距离（≥0 在内侧；负值表示已越出该边）。
pub fn edge_distance(r: Rect, area: Rect, edge: Edge) -> f64 {
    match edge {
        Edge::Left => (r.x - area.x) as f64,
        Edge::Right => (area.x + area.w - (r.x + r.w)) as f64,
        Edge::Top => (r.y - area.y) as f64,
        Edge::Bottom => (area.y + area.h - (r.y + r.h)) as f64,
    }
}

/// 窗口中心是否落在工作区沿边跨度内（防止在另一屏误判）。
pub fn center_within_span(r: Rect, area: Rect, edge: Edge) -> bool {
    if edge.normal_is_x() {
        let cy = r.y as f64 + r.h as f64 / 2.0;
        cy >= area.y as f64 && cy <= (area.y + area.h) as f64
    } else {
        let cx = r.x as f64 + r.w as f64 / 2.0;
        cx >= area.x as f64 && cx <= (area.x + area.w) as f64
    }
}

/// 最近的可吸附边（与前端 `detectCandidateEdge` 同一口径：中心在跨度内、取最小距离）。
pub fn nearest_edge(r: Rect, area: Rect, max_dist: f64) -> Option<Edge> {
    let mut best: Option<Edge> = None;
    let mut best_d = f64::INFINITY;
    for edge in EDGES {
        if !center_within_span(r, area, edge) {
            continue;
        }
        let d = edge_distance(r, area, edge);
        if d < best_d {
            best_d = d;
            best = Some(edge);
        }
    }
    match best {
        // 允许轻微越出（用户把窗口压过边缘），明显越出（< -EXIT）不判
        Some(e) if best_d <= max_dist && best_d >= -ATTRACT_RANGE_CSS => Some(e),
        _ => None,
    }
}

/// 沿法向平移：`delta > 0` = 离开屏幕边（朝屏幕内部）。
pub fn shift_normal(r: Rect, edge: Edge, delta: f64) -> Rect {
    let d = delta.round() as i32;
    match edge {
        Edge::Left => Rect { x: r.x + d, ..r },
        Edge::Right => Rect { x: r.x - d, ..r },
        Edge::Top => Rect { y: r.y + d, ..r },
        Edge::Bottom => Rect { y: r.y - d, ..r },
    }
}

/// 窗口相对 `base` 的法向位移（外法向为正 = 离开屏幕边）。
pub fn normal_offset(r: Rect, base: Rect, edge: Edge) -> f64 {
    let raw = if edge.normal_is_x() {
        (r.x - base.x) as f64
    } else {
        (r.y - base.y) as f64
    };
    raw * edge.outward_sign() as f64
}

/// 沿边平移量（不带符号；前端 `alongDeviation` 的 Rust 对照实现，仅供测试）。
#[cfg(test)]
pub fn along_offset(r: Rect, base: Rect, edge: Edge) -> f64 {
    if edge.normal_is_x() {
        (r.y - base.y) as f64
    } else {
        (r.x - base.x) as f64
    }
}

/// 把沿边坐标钳制进工作区（法向不动）。停靠期窗口是 400×420 的容器，
/// 钳制它等价于保证轨道不会被拖出屏幕。
pub fn clamp_along(r: Rect, area: Rect, edge: Edge) -> Rect {
    if edge.normal_is_x() {
        let lo = area.y;
        let hi = (area.y + area.h - r.h).max(area.y);
        Rect {
            y: r.y.clamp(lo, hi),
            ..r
        }
    } else {
        let lo = area.x;
        let hi = (area.x + area.w - r.w).max(area.x);
        Rect {
            x: r.x.clamp(lo, hi),
            ..r
        }
    }
}

/// 拖离解除的鼠标锚定矩形（纯函数，物理像素）：标题栏中心 = 光标。
///
/// 与前端 `src/lib/edgeSnap.ts` 的 `undockAnchorTarget` 同口径（两端单测 +
/// 契约用例互锁），**只**负责几何：
///
/// - 光标参考值先钳进工作区（拖到任务栏上方时窗口仍按屏内光标摆放）；
/// - 目标位置 = `(cursor − w/2, cursor − titlebar/2)`，再钳进工作区；
/// - 结果保证光标落在窗口矩形内（不落在窗外）；工作区足够时落在标题栏带内，
///   不足时（如光标贴近下缘、窗口比剩余空间高）窗口完整可见优先——
///   这是「不把窗口大面积放出屏幕」与「可继续拖动」之间的最小位移取舍；
/// - 尺寸大于工作区时收敛到工作区尺寸，钳制区间恒合法。
pub fn undock_anchor_rect(cursor: (f64, f64), w: i32, h: i32, titlebar: f64, area: Rect) -> Rect {
    let w = w.clamp(1, area.w.max(1));
    let h = h.clamp(1, area.h.max(1));
    let tb = if titlebar.is_finite() && titlebar > 0.0 {
        titlebar
    } else {
        0.0
    };
    let ax = cursor.0.clamp(area.x as f64, (area.x + area.w) as f64);
    let ay = cursor.1.clamp(area.y as f64, (area.y + area.h) as f64);
    let x = ((ax - w as f64 / 2.0).round() as i32).clamp(area.x, area.x + area.w - w);
    let y = ((ay - tb / 2.0).round() as i32).clamp(area.y, area.y + area.h - h);
    Rect::new(x, y, w, h)
}

fn smoothstep(u: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

/// 吸引曲线：窗口距边 `d` 时的**额外吸引位移**（朝边缘，≥0）。
///
/// - `d ≥ range` → 0（磁场外完全跟随鼠标）；
/// - `d → 0` → 单调增大到 `max_lead`，但被 `d` 本身钳住（绝不把窗口推出屏幕边）；
/// - 连续、一阶大致光滑、有界；不使用任何随时间演化的状态（无动画循环）。
pub fn attraction_lead(d: f64, range: f64, max_lead: f64) -> f64 {
    // 原 `!(range > 0.0)` 的等价展开（含 NaN 防御）：非正或非数都视为无磁场
    if range <= 0.0 || range.is_nan() || max_lead <= 0.0 || max_lead.is_nan() || d >= range {
        return 0.0;
    }
    if d <= 0.0 {
        return 0.0; // 已压过边缘：不再加力，避免把窗口进一步推出屏幕
    }
    let lead = max_lead * smoothstep(1.0 - d / range);
    lead.min(d) // 保证 结果距离 = d - lead ≥ 0
}

/// 脱离阻力曲线：游标沿法向外移 `d` 时窗口的**实际位移**（0 ≤ disp < d）。
///
/// `disp = d²/(2D)`：起点斜率为 0（刚开始拉几乎不动 = 被吸住），
/// 随 d 增大逐渐"让步"；`d = D` 时位移恰为 `D/2`，随后一次性释放。
pub fn release_displacement(d: f64, release: f64) -> f64 {
    if release <= 0.0 || release.is_nan() || d <= 0.0 {
        return 0.0;
    }
    let d = d.min(release);
    d * d / (2.0 * release)
}

/// Windows Snap 抑制目标（纯函数，可单测）。
///
/// 返回 `Some(true)` = 应清除 `WS_MAXIMIZEBOX`（不可最大化 ⇒ 系统不提供
/// Snap Bar / 贴靠飞出）；`Some(false)` = 应恢复系统默认样式；
/// `None` = 本次不切换（拖拽循环内解除吸附时，恢复推迟到 `WM_EXITSIZEMOVE`）。
fn snap_suppression_target(docked: bool, in_size_move: bool, enabled: bool) -> Option<bool> {
    if !enabled {
        // 吸附整体关闭：无论如何恢复系统默认样式（前端关闭时会同时清停靠位，
        // 这里按防御口径独立判断，避免任何时序组合残留抑制）
        return Some(false);
    }
    if docked {
        return Some(true);
    }
    if in_size_move {
        // 拖拽循环内解除吸附：保证"从吸附状态拖出"的整个手势期间
        // 系统贴靠 UI 不介入，循环退出（WM_EXITSIZEMOVE）后再恢复
        return None;
    }
    Some(false)
}

/// 拖拽模式（单次拖拽内的状态机）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragMode {
    /// 未停靠：只做吸引
    Free,
    /// 停靠中且未突破：只做阻力
    Resist,
    /// 已突破：窗口 1:1 跟随鼠标（残留滞后按事件衰减）
    Released,
}

/// 拖拽锚点：把系统提案还原成「没有磁力时窗口本该在的位置」。
///
/// 关键事实（真机实测，见 `tmp/acceptance/magnetic-drag-resistance/`）：
/// 系统模态移动循环**不是**无反馈的，`propₙ₊₁ = appliedₙ + Δcursor`。
/// 若直接拿 `WM_MOVING` 的提案当基准去算距离，我们施加的领先量会在下一帧
/// 被系统吸收成新基准，`d` 重新变大 → 领先量逐帧累积（实测累积到 48px，
/// 远超 `ATTRACT_MAX_LEAD_CSS`，且让窗口永久偏移、贴边时吸引反而消失）。
///
/// 因此这里自己维护锚点：起点矩形 + 光标累积位移 → 还原 1:1 矩形。
/// 磁力只作用在这个还原矩形上，施加结果不再回流。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DragAnchor {
    /// 拖拽开始时的窗口矩形（物理像素）
    rect: Rect,
    /// 拖拽开始时的光标位置（物理像素）
    cursor: (f64, f64),
}

impl DragAnchor {
    pub fn new(rect: Rect, cursor: (f64, f64)) -> Self {
        Self { rect, cursor }
    }

    /// 重新锚定（尺寸被系统改动后调用，避免用旧尺寸算位移）。
    pub fn rebase(&mut self, rect: Rect, cursor: (f64, f64)) {
        self.rect = rect;
        self.cursor = cursor;
    }

    /// 由当前光标还原「未施加磁力」的矩形。
    ///
    /// 宽高始终取系统提案（Aero Snap 等可能改尺寸）；一旦尺寸变了，
    /// 说明系统接管了几何，返回 `None` 让调用方重锚并跳过磁力。
    pub fn raw(&self, proposed: Rect, cursor: (f64, f64)) -> Option<Rect> {
        if proposed.w <= 0 || proposed.h <= 0 {
            return None; // 退化矩形（系统移动循环首帧）：不是真实几何
        }
        if proposed.w != self.rect.w || proposed.h != self.rect.h {
            return None;
        }
        let dx = cursor.0 - self.cursor.0;
        let dy = cursor.1 - self.cursor.1;
        if !dx.is_finite() || !dy.is_finite() {
            return None;
        }
        Some(Rect {
            x: self.rect.x + dx.round() as i32,
            y: self.rect.y + dy.round() as i32,
            w: proposed.w,
            h: proposed.h,
        })
    }
}

/// 一次拖拽的磁力模型。所有时间/几何都从参数注入，纯函数式可单测。
#[derive(Clone, Copy, Debug)]
pub struct DragModel {
    mode: DragMode,
    /// 当前作用的边（Free 下 = 最近边，可能是 None）
    pub edge: Option<Edge>,
    /// 停靠边 + 齐平矩形（Resist/Released 有效）
    docked: Option<(Edge, Rect)>,
    /// 突破后残留的游标-窗口滞后（物理像素，沿外法向）
    lag: f64,
    last_ms: f64,
    /// 吸引是否已武装（突破后需离开边缘足够远才重新武装）
    armed: bool,
    scale: f64,
}

impl Default for DragModel {
    fn default() -> Self {
        Self {
            mode: DragMode::Free,
            edge: None,
            docked: None,
            lag: 0.0,
            last_ms: 0.0,
            armed: true,
            scale: 1.0,
        }
    }
}

impl DragModel {
    /// 开始一次拖拽。`docked` 非空 = 从停靠态被拖起。
    pub fn begin(docked: Option<(Edge, Rect)>, scale: f64, now_ms: f64) -> Self {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        Self {
            mode: if docked.is_some() {
                DragMode::Resist
            } else {
                DragMode::Free
            },
            edge: docked.map(|(e, _)| e),
            docked,
            lag: 0.0,
            last_ms: now_ms,
            armed: true,
            scale,
        }
    }

    pub fn mode(&self) -> DragMode {
        self.mode
    }

    /// 自由窗口：返回施加吸引后的矩形。
    pub fn adjust_free(&mut self, proposed: Rect, area: Rect, now_ms: f64) -> Rect {
        let _ = now_ms;
        let range = ATTRACT_RANGE_CSS * self.scale;
        let max_lead = ATTRACT_MAX_LEAD_CSS * self.scale;
        let rearm = REARM_DIST_CSS * self.scale;

        // 滞回：突破后必须离开边缘足够远才重新受吸引
        if !self.armed {
            let far = EDGES
                .iter()
                .map(|&e| edge_distance(proposed, area, e))
                .fold(f64::NEG_INFINITY, f64::max);
            if far > rearm {
                self.armed = true;
            }
        }

        let edge = nearest_edge(proposed, area, range);
        self.edge = edge;
        match edge {
            Some(e) if self.armed => {
                let d = edge_distance(proposed, area, e);
                let lead = attraction_lead(d, range, max_lead);
                if lead <= 0.0 {
                    proposed
                } else {
                    shift_normal(proposed, e, -lead)
                }
            }
            _ => proposed,
        }
    }

    /// 停靠中：返回施加阻力/释放后的矩形。
    pub fn adjust_docked(&mut self, proposed: Rect, area: Rect, now_ms: f64) -> Rect {
        let Some((edge, base)) = self.docked else {
            return proposed;
        };
        let release = RELEASE_DRAG_CSS * self.scale;
        let d = normal_offset(proposed, base, edge);

        if self.mode == DragMode::Resist {
            if d <= 0.0 {
                // 往里推：法向钳回齐平位（胶囊不能被推进屏幕边缘外）
                let r = shift_normal(proposed, edge, -d);
                return clamp_along(r, area, edge);
            }
            if d < release {
                let disp = release_displacement(d, release);
                let r = shift_normal(proposed, edge, disp - d);
                return clamp_along(r, area, edge);
            }
            // 突破：冻结当前滞后，此后 1:1 跟随（无跳变）
            self.mode = DragMode::Released;
            self.armed = false;
            self.lag = release - release_displacement(release, release);
            self.last_ms = now_ms;
        }

        if self.mode == DragMode::Released {
            let dt = (now_ms - self.last_ms).max(0.0);
            self.last_ms = now_ms;
            if self.lag > 0.0 {
                self.lag *= (-dt / LAG_DECAY_MS).exp();
                if self.lag < 0.5 {
                    self.lag = 0.0;
                }
            }
            let r = shift_normal(proposed, edge, -self.lag);
            return clamp_along(r, area, edge);
        }

        proposed
    }

    /// 拖拽结束：需要回弹时返回目标矩形（贴回齐平位，保留沿边位置）。
    ///
    /// - `Resist`：任何法向位移都回弹（未突破 = 用户只是轻拉）；
    /// - `Released`：窗口位移 < `COMMIT_DRAG_CSS` 时回弹，否则交给前端解除；
    /// - `Free`：不处理（停靠由前端确认）。
    pub fn finish(&mut self, applied: Rect) -> Option<Rect> {
        let (edge, base) = self.docked?;
        let d = normal_offset(applied, base, edge);
        let snap = match self.mode {
            // 未突破：任何法向位移都回弹（用户只是轻拉，磁力把它拉回去）
            DragMode::Resist => d.abs() > 0.5,
            // 已突破但窗口位移仍不足提交阈值：回弹，绝不停在半脱开状态
            // （"手感上已放手"与"几何上已拖离"是两件事，后者才允许解除）
            DragMode::Released => d < COMMIT_DRAG_CSS * self.scale,
            DragMode::Free => false,
        };
        if snap {
            Some(shift_normal(applied, edge, -d))
        } else {
            None
        }
    }
}

// ── 配置（IPC 线程写、窗口线程读；纯原子，热路径无锁）─────────

fn store_milli(a: &AtomicU32, v: f64) {
    let clamped = if v.is_finite() {
        v.clamp(0.0, 10_000.0)
    } else {
        0.0
    };
    a.store((clamped * 1000.0).round() as u32, Ordering::Relaxed);
}

fn load_milli(a: &AtomicU32) -> f64 {
    a.load(Ordering::Relaxed) as f64 / 1000.0
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static RANGE_MILLI: AtomicU32 = AtomicU32::new(50_000);
static MAX_LEAD_MILLI: AtomicU32 = AtomicU32::new(16_000);
static RELEASE_MILLI: AtomicU32 = AtomicU32::new(32_000);
static DOCKED: AtomicBool = AtomicBool::new(false);
static DOCK_EDGE: AtomicI32 = AtomicI32::new(-1);
static DOCK_X: AtomicI32 = AtomicI32::new(0);
static DOCK_Y: AtomicI32 = AtomicI32::new(0);

// ── 拖离解除的鼠标锚定（见模块文档「拖离解除的鼠标锚定」）────────
//
// 请求由前端命令线程置位，`WM_MOVING`（窗口线程）在下一帧消费：
// W/H 是恢复后的窗口 CSS 尺寸，TB 是标题栏 CSS 高度（前端从真实布局量取），
// 物理值在应用时按当时 DPI 换算。

static ANCHOR_PENDING: AtomicBool = AtomicBool::new(false);
static ANCHOR_APPLIED: AtomicBool = AtomicBool::new(false);
static ANCHOR_W_MILLI: AtomicU32 = AtomicU32::new(0);
static ANCHOR_H_MILLI: AtomicU32 = AtomicU32::new(0);
static ANCHOR_TB_MILLI: AtomicU32 = AtomicU32::new(0);

/// 挂起一次拖离解除的鼠标锚定请求（仅拖离路径；非 Windows / 未安装时为 no-op，
/// 返回 false 让前端走自己的回退定位）。
pub fn request_undock_anchor(w_css: f64, h_css: f64, titlebar_css: f64) -> bool {
    if !installed() {
        return false;
    }
    store_milli(&ANCHOR_W_MILLI, w_css);
    store_milli(&ANCHOR_H_MILLI, h_css);
    store_milli(&ANCHOR_TB_MILLI, titlebar_css);
    ANCHOR_APPLIED.store(false, Ordering::Release);
    ANCHOR_PENDING.store(true, Ordering::Release);
    true
}

/// 作废尚未应用的锚定请求（解除中止 / 回滚时防残留到下一次拖拽）。
pub fn cancel_undock_anchor() {
    ANCHOR_PENDING.store(false, Ordering::Release);
    ANCHOR_APPLIED.store(false, Ordering::Release);
}

/// 查询并复位锚定结果：`true` = 请求已在拖拽循环内应用（前端无需再定位）。
/// 同时作废残留的未应用请求（解除收尾后不应再影响后续拖拽）。
pub fn take_undock_anchor_applied() -> bool {
    ANCHOR_PENDING.store(false, Ordering::Release);
    ANCHOR_APPLIED.swap(false, Ordering::AcqRel)
}

/// 磁力总开关 + 参数（CSS px）。`enabled=false` 时窗口完全按系统默认移动，
/// 阻力与吸引同时失效（`snap_enabled` 关闭必须彻底停用）。
pub fn set_config(enabled: bool, range_css: f64, max_lead_css: f64, release_css: f64) {
    store_milli(&RANGE_MILLI, range_css);
    store_milli(&MAX_LEAD_MILLI, max_lead_css);
    store_milli(&RELEASE_MILLI, release_css);
    if !enabled {
        // 关闭时挂起的锚定请求永远等不到 WM_MOVING（该消息被旁路），
        // 必须就地作废，否则会泄漏到之后重新开启的某次拖拽里。
        ANCHOR_PENDING.store(false, Ordering::Release);
        ANCHOR_APPLIED.store(false, Ordering::Release);
    }
    ENABLED.store(enabled, Ordering::Release);
    request_snap_style_sync();
}

pub fn config() -> (bool, f64, f64, f64) {
    (
        ENABLED.load(Ordering::Acquire),
        load_milli(&RANGE_MILLI),
        load_milli(&MAX_LEAD_MILLI),
        load_milli(&RELEASE_MILLI),
    )
}

/// 停靠状态：`edge = None` 表示当前未停靠（阻力失效）。
/// 坐标是**齐平位置**（物理像素），由前端在停靠事务提交后下发。
pub fn set_dock(edge: Option<Edge>, x: i32, y: i32) {
    match edge {
        Some(e) => {
            DOCK_X.store(x, Ordering::Release);
            DOCK_Y.store(y, Ordering::Release);
            DOCK_EDGE.store(e.id() as i32, Ordering::Release);
            DOCKED.store(true, Ordering::Release);
        }
        None => {
            DOCKED.store(false, Ordering::Release);
            DOCK_EDGE.store(-1, Ordering::Release);
        }
    }
    // 停靠 ⇄ 解除同时驱动 Windows Snap 抑制（见模块文档「Windows Snap 抑制」）：
    // 停靠期清除 WS_MAXIMIZEBOX，解除后恢复。实际样式切换在窗口线程执行。
    request_snap_style_sync();
}

/// 请求窗口线程重估 Snap 抑制状态（非 Windows 平台 no-op）。
#[cfg(windows)]
fn request_snap_style_sync() {
    win::request_style_sync();
}
#[cfg(not(windows))]
fn request_snap_style_sync() {}

fn docked_snapshot() -> Option<(Edge, Rect)> {
    if !DOCKED.load(Ordering::Acquire) {
        return None;
    }
    let edge = Edge::from_id(DOCK_EDGE.load(Ordering::Acquire).clamp(0, 3) as u8)?;
    let x = DOCK_X.load(Ordering::Acquire);
    let y = DOCK_Y.load(Ordering::Acquire);
    // 宽高在拖拽中由系统提议矩形给出，这里只借用左上角作基准
    Some((edge, Rect::new(x, y, 0, 0)))
}

// ── 诊断轨迹（TASK_DOCK_MAGNET_TRACE=1）──────────────────────
//
// 热路径只用 try_lock：拿不到锁就丢弃本条，绝不阻塞窗口线程。
// 轨迹是「系统提议矩形 vs 我们应用的矩形」，用于证明改写不累积、无反馈环。

#[derive(Clone, Copy, Debug)]
pub struct TraceRec {
    pub at_ms: u32,
    /// 0=enter 1=moving 2=exit 3=snap
    pub kind: u8,
    /// 0=Free 1=Resist 2=Released
    pub mode: u8,
    /// 255 = 无边
    pub edge: u8,
    pub proposed: [i32; 4],
    pub applied: [i32; 4],
}

const TRACE_CAP: usize = 4096;
static TRACE_ON: AtomicBool = AtomicBool::new(false);
/// 轨迹落盘路径（`TASK_DOCK_MAGNET_TRACE=<文件路径>`）。拖拽结束时追加一次，
/// 不在 WM_MOVING 热路径里做任何 I/O。
static TRACE_PATH: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
static TRACE: std::sync::Mutex<Vec<TraceRec>> = std::sync::Mutex::new(Vec::new());
static TRACE_START: std::sync::LazyLock<std::time::Instant> =
    std::sync::LazyLock::new(std::time::Instant::now);

fn trace(kind: u8, mode: DragMode, edge: Option<Edge>, proposed: Rect, applied: Rect) {
    if !TRACE_ON.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut buf) = TRACE.try_lock() else {
        return;
    };
    if buf.len() >= TRACE_CAP {
        return;
    }
    buf.push(TraceRec {
        at_ms: TRACE_START.elapsed().as_millis() as u32,
        kind,
        mode: match mode {
            DragMode::Free => 0,
            DragMode::Resist => 1,
            DragMode::Released => 2,
        },
        edge: edge.map(|e| e.id()).unwrap_or(255),
        proposed: [proposed.x, proposed.y, proposed.w, proposed.h],
        applied: [applied.x, applied.y, applied.w, applied.h],
    });
}

/// 取出并清空轨迹（落盘用）。
fn take_trace() -> Vec<TraceRec> {
    match TRACE.lock() {
        Ok(mut b) => std::mem::take(&mut *b),
        Err(e) => std::mem::take(&mut *e.into_inner()),
    }
}

/// 拖拽结束把本次轨迹追加到 CSV（`TASK_DOCK_MAGNET_TRACE` 指向的路径）。
///
/// 列：`at_ms,kind,mode,edge,proposed_*,applied_*`。
/// `kind`：0=ENTER 1=MOVING 2=EXIT 3=SNAP。`edge`：0..3，255=无。
/// 只在拖拽结束时调用一次：热路径（WM_MOVING）不做任何 I/O。
fn dump_trace() {
    let Some(Some(path)) = TRACE_PATH.get() else {
        return;
    };
    let recs = take_trace();
    if recs.is_empty() {
        return;
    }
    use std::fmt::Write as _;
    let mut out = String::with_capacity(recs.len() * 72);
    if !path.exists() {
        out.push_str("at_ms,kind,mode,edge,proposed_x,proposed_y,proposed_w,proposed_h,applied_x,applied_y,applied_w,applied_h\n");
    }
    for r in recs {
        let _ = writeln!(
            out,
            "{},{},{},{},{},{},{},{},{},{},{},{}",
            r.at_ms,
            r.kind,
            r.mode,
            r.edge,
            r.proposed[0],
            r.proposed[1],
            r.proposed[2],
            r.proposed[3],
            r.applied[0],
            r.applied[1],
            r.applied[2],
            r.applied[3],
        );
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, out.as_bytes()));
}

// ── 窗口过程（子类化）───────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, GetCursorPos, GetWindowLongW, GetWindowRect, PostMessageW,
        SetWindowLongPtrW, SetWindowLongW, SetWindowPos, GWLP_WNDPROC, GWL_STYLE, HTCLIENT,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_APP,
        WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVING, WM_SETCURSOR, WNDPROC,
        WS_MAXIMIZEBOX,
    };

    /// 我们接管的主窗（只作用于 task_dock 主窗口）。
    static TARGET: AtomicIsize = AtomicIsize::new(0);
    /// 原窗口过程（tao 的 wndproc）。
    static OLD_PROC: AtomicIsize = AtomicIsize::new(0);
    /// 回弹消息（自定义）：避免在 WM_EXITSIZEMOVE 内嵌套 SetWindowPos。
    const WM_MAGNET_SNAP: u32 = WM_APP + 0x51;
    /// Snap 抑制重估消息（自定义）：`set_dock`/`set_config`（IPC 线程）发起，
    /// 由窗口线程在 wndproc 里实际读写样式（Win32 样式操作应在窗口所属线程执行）。
    const WM_MAGNET_STYLE_SYNC: u32 = WM_APP + 0x52;
    /// 角热区光标恢复消息（自定义）：缩放/移动循环退出后延后一拍补 `SetCursor`。
    /// 见 `window_cursor` 模块文档。
    const WM_CURSOR_CORNER: u32 = WM_APP + 0x53;

    /// 子类化时窗口是否本就带 `WS_MAXIMIZEBOX`（1=有 2=没有 0=未记录）。
    /// 恢复时只还原原本存在的样式，不把"不可最大化"改成"可最大化"。
    static ORIGINAL_MAXBOX: AtomicU8 = AtomicU8::new(0);
    /// 当前是否由我们清除了 `WS_MAXIMIZEBOX`（true = 处于抑制态）。
    static SNAP_CLEARED: AtomicBool = AtomicBool::new(false);

    thread_local! {
        static RUNTIME: RefCell<Runtime> = RefCell::new(Runtime::default());
        /// 是否处于系统模态移动循环内（WM_ENTERSIZEMOVE…WM_EXITSIZEMOVE）。
        static IN_SIZE_MOVE: Cell<bool> = const { Cell::new(false) };
    }

    /// 锚定强制窗口状态：锚定帧应用后，若系统提案尚未接受新尺寸
    /// （个别 shell 的移动循环对中途改尺寸有迟滞），继续按
    /// 「标题栏中心 = 当前光标」改写若干帧，直到提案尺寸一致或超时
    /// （有界，防与系统打架）。
    #[derive(Clone, Copy, Debug)]
    struct AnchorEnforce {
        rect: Rect,
        titlebar_phys: f64,
        until_ms: f64,
    }

    #[derive(Default)]
    struct Runtime {
        model: DragModel,
        /// 缓存的工作区（HMONITOR, rect），拖拽中只在跨屏时重算
        area: Option<(isize, Rect)>,
        pending_snap: Option<Rect>,
        /// 拖拽锚点：用「起点矩形 + 光标累积位移」还原 1:1 矩形，
        /// 避免系统移动循环的提案把磁力位移吸收成新基准（见 `DragAnchor`）。
        anchor: Option<DragAnchor>,
        /// 拖离解除锚定的强制期（见 `AnchorEnforce`）；拖拽结束即作废。
        anchor_enforce: Option<AnchorEnforce>,
    }

    fn now_ms() -> f64 {
        TRACE_START.elapsed().as_secs_f64() * 1000.0
    }

    fn rect_from(r: &RECT) -> Rect {
        Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
    }

    fn write_rect(r: Rect, out: &mut RECT) {
        out.left = r.x;
        out.top = r.y;
        out.right = r.x + r.w;
        out.bottom = r.y + r.h;
    }

    fn dpi_scale(hwnd: isize) -> f64 {
        let dpi = unsafe { GetDpiForWindow(hwnd as HWND) };
        if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        }
    }

    /// 当前光标位置（物理像素）。高频路径上只做一次 P/Invoke：无 IPC、无锁。
    fn cursor_pos() -> Option<(f64, f64)> {
        let mut p: POINT = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetCursorPos(&mut p) };
        if ok != 0 {
            Some((p.x as f64, p.y as f64))
        } else {
            None
        }
    }

    /// 窗口所在显示器的工作区（物理像素，已排除任务栏）。
    fn work_area(hwnd: isize, rect: Rect, cache: &mut Option<(isize, Rect)>) -> Rect {
        let rc = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.w,
            bottom: rect.y + rect.h,
        };
        let hmon = unsafe { MonitorFromRect(&rc, MONITOR_DEFAULTTONEAREST) };
        if let Some((cached_hmon, cached)) = *cache {
            if cached_hmon == hmon as isize {
                return cached;
            }
        }
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let ok = unsafe { GetMonitorInfoW(hmon, &mut info) };
        let area = if ok != 0 {
            rect_from(&info.rcWork)
        } else {
            // 取不到工作区时退回窗口自身（等价于不做磁力，安全降级）
            rect
        };
        *cache = Some((hmon as isize, area));
        let _ = hwnd;
        area
    }

    /// 清除/恢复主窗的 `WS_MAXIMIZEBOX`（Windows Snap 资格，见模块文档）。
    ///
    /// - 已处于目标状态时是 no-op（可安全重复调用，`WM_ENTERSIZEMOVE` 的重申靠它自愈）；
    /// - 原窗口本就不带该样式（`ORIGINAL_MAXBOX=2`）时永不动样式；
    /// - 恢复只把原本存在的位写回，不改变其他样式位；
    /// - `SWP_FRAMECHANGED` 是样式变更生效的官方要求（MSDN SetWindowLong 注意事项）。
    ///
    /// 只在窗口线程调用（wndproc 内）。返回是否实际发生了样式写入。
    fn apply_snap_suppression(hwnd: HWND, suppress: bool) -> bool {
        // 未记录原始状态（未走 install）时不操作：宁可少抑制，不可盲目改样式
        if ORIGINAL_MAXBOX.load(Ordering::Relaxed) == 0 {
            return false;
        }
        // 原窗口不可最大化：系统本来就不为它提供 Snap，无需任何改动
        if ORIGINAL_MAXBOX.load(Ordering::Relaxed) == 2 {
            SNAP_CLEARED.store(false, Ordering::Relaxed);
            return false;
        }
        let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
        let has = style & WS_MAXIMIZEBOX != 0;
        if has != suppress {
            return false; // 已处于目标状态（幂等）：抑制期望 has=false，恢复期望 has=true
        }
        let next = if suppress {
            style & !WS_MAXIMIZEBOX
        } else {
            style | WS_MAXIMIZEBOX
        };
        let prev = unsafe { SetWindowLongW(hwnd, GWL_STYLE, next as i32) };
        if prev == 0 {
            // 返回 0 = 失败（原样式恒非 0）。保持原子状态与实际一致，便于重试自愈
            tracing::warn!("WS_MAXIMIZEBOX 切换失败（SetWindowLongW 返回 0）");
            return false;
        }
        SNAP_CLEARED.store(suppress, Ordering::Relaxed);
        // 样式变更刷新窗口框架（不改几何、不激活、不改 Z 序）
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        tracing::debug!(suppress, "主窗 Windows Snap 抑制已切换");
        true
    }

    /// 按当前状态（开关 + 停靠位 + 是否在拖拽循环内）应用或推迟 Snap 抑制。
    fn sync_snap_suppression(hwnd: HWND) {
        let in_move = IN_SIZE_MOVE.with(|f| f.get());
        let (enabled, _, _, _) = config();
        // 拖拽循环内解除吸附返回 None：推迟到 WM_EXITSIZEMOVE 再恢复
        if let Some(suppress) =
            snap_suppression_target(DOCKED.load(Ordering::Acquire), in_move, enabled)
        {
            apply_snap_suppression(hwnd, suppress);
        }
    }

    unsafe extern "system" fn magnetic_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let target = TARGET.load(Ordering::Relaxed);
        if target == 0 || hwnd as isize != target {
            return call_old(hwnd, msg, wparam, lparam);
        }

        // ── 角热区光标（与磁力开关无关，必须在下面的旁路之前处理）──────────
        // 缩放循环内部发出 WM_EXITSIZEMOVE；循环返回后 Windows 还会重设光标，
        // 所以延后一拍（与 WM_MAGNET_SNAP 同样的理由：不在模态循环内做事）。
        // 指针静止时系统不再派发 WM_SETCURSOR，前端 CSS cursor 无法重新生效，
        // 由窗口过程补一次 SetCursor（根因见 `window_cursor` 模块文档）。
        if msg == WM_EXITSIZEMOVE {
            unsafe {
                PostMessageW(hwnd, WM_CURSOR_CORNER, 0, 0);
            }
        }
        match msg {
            WM_CURSOR_CORNER => {
                crate::window_cursor::restore_at_corner(hwnd as isize);
                return 0;
            }
            WM_SETCURSOR if wparam == HTCLIENT as WPARAM => {
                // 客户端区的光标通常由 WebView2 子窗按 CSS 设置；这里兜底
                // 「子窗没有设置光标」的情况，命中角热区时保持双向箭头。
                if crate::window_cursor::restore_at_corner(hwnd as isize) {
                    return 1;
                }
            }
            _ => {}
        }

        let (enabled, _, _, _) = config();
        if !enabled && msg != WM_MAGNET_SNAP && msg != WM_MAGNET_STYLE_SYNC {
            // 关闭时彻底旁路：不读状态、不改矩形（样式同步仍需放行，
            // 否则关闭吸附后无法恢复被抑制的 WS_MAXIMIZEBOX）
            return call_old(hwnd, msg, wparam, lparam);
        }

        match msg {
            WM_ENTERSIZEMOVE => {
                // 拖拽开始：若仍处于停靠态，重申 Snap 抑制。清除动作在停靠事务提交时
                // 已做，这里是自愈——任何后续样式重写（tao 标志位变化）都被本调用纠正，
                // 且它先于系统贴靠判定（贴靠只在移动循环内发生）。
                IN_SIZE_MOVE.with(|f| f.set(true));
                if DOCKED.load(Ordering::Acquire) {
                    apply_snap_suppression(hwnd, true);
                }
                let scale = dpi_scale(hwnd as isize);
                let mut rc: RECT = unsafe { std::mem::zeroed() };
                let ok = unsafe { GetWindowRect(hwnd, &mut rc) };
                let actual = if ok != 0 { Some(rect_from(&rc)) } else { None };
                // 停靠基准以**拖拽起点的真实矩形**为准：胶囊被拖起时它就在齐平位上。
                // 前端下发的基准可能滞后（区域切换/沿边重定位/重启恢复），一旦偏差
                // 超过 32px，第一帧就会被判成"已突破"并进入 Released，随后窗口被甩飞
                // （真机实测 x 从 0 飞到 -210 并触发 Aero Snap）。
                let docked = docked_snapshot().map(|(e, stored)| (e, actual.unwrap_or(stored)));
                let cursor = cursor_pos();
                RUNTIME.with(|rt| {
                    let mut rt = rt.borrow_mut();
                    rt.model = DragModel::begin(docked, scale, now_ms());
                    rt.area = None;
                    rt.pending_snap = None;
                    rt.anchor_enforce = None;
                    // 锚点：拖拽起点矩形 + 起手光标。之后每帧用光标增量还原 1:1 矩形。
                    rt.anchor = match (actual, cursor) {
                        (Some(r), Some(c)) => Some(DragAnchor::new(r, c)),
                        _ => None,
                    };
                });
                // 新拖拽开始：清掉上一轮解除遗留的锚定请求——它只可能来自
                // 已收尾的解除（tick 补判定路径），不得在这次拖拽里突然改窗口。
                ANCHOR_PENDING.store(false, Ordering::Release);
                trace(
                    0,
                    DragMode::Free,
                    None,
                    Rect::new(0, 0, 0, 0),
                    Rect::new(0, 0, 0, 0),
                );
                call_old(hwnd, msg, wparam, lparam)
            }
            WM_DPICHANGED => {
                // 跨屏 DPI 变化：刷新缩放（CSS→物理的换算基准）并重锚，
                // 否则锚点里的旧物理尺寸会让 `raw` 判断为「尺寸变了」而放弃磁力。
                let scale = dpi_scale(hwnd as isize);
                let mut rc: RECT = unsafe { std::mem::zeroed() };
                let ok = unsafe { GetWindowRect(hwnd, &mut rc) };
                let cursor = cursor_pos();
                RUNTIME.with(|rt| {
                    let mut rt = rt.borrow_mut();
                    rt.model.scale = scale;
                    if ok != 0 {
                        if let Some(c) = cursor {
                            match rt.anchor {
                                Some(mut a) => a.rebase(rect_from(&rc), c),
                                None => rt.anchor = Some(DragAnchor::new(rect_from(&rc), c)),
                            }
                        }
                    }
                });
                call_old(hwnd, msg, wparam, lparam)
            }
            WM_MOVING => {
                let ptr = lparam as *mut RECT;
                if ptr.is_null() {
                    return call_old(hwnd, msg, wparam, lparam);
                }
                let proposed = rect_from(&*ptr);
                // 系统移动循环开头会先送一帧**退化矩形**（left/top/right/bottom 全 0）。
                // 它不是真实几何：若把它当作"尺寸变化"去重锚，锚点会被重置到原点，
                // 此后还原矩形永远贴着 0，阻力段窗口就被钉死在停靠位（真机实测）。
                if proposed.w <= 0 || proposed.h <= 0 {
                    return call_old(hwnd, msg, wparam, lparam);
                }
                let cursor = cursor_pos();
                let applied = RUNTIME.with(|rt| {
                    let mut rt = rt.borrow_mut();
                    // 还原「无磁力时本该在的位置」；拿不到（无锚点 / 尺寸被系统改动 /
                    // 光标读取失败）就按系统提案走并重锚，宁可不吸也不累积。
                    let base = match (rt.anchor, cursor) {
                        (Some(a), Some(c)) => match a.raw(proposed, c) {
                            Some(raw) => raw,
                            None => {
                                rt.anchor = Some(DragAnchor::new(proposed, c));
                                proposed
                            }
                        },
                        _ => proposed,
                    };
                    let area = work_area(hwnd as isize, base, &mut rt.area);
                    let now = now_ms();

                    // ── 拖离解除的鼠标锚定（见模块文档同名小节）──────────────
                    // (1) 强制期：锚定帧已应用，但系统提案还没接受新尺寸——继续按
                    //     「标题栏中心 = 光标」改写，直到提案尺寸一致（系统已接手，
                    //     之后回归正常磁力路径）或超时（交给前端松手后的兜底定位）。
                    if let Some(en) = rt.anchor_enforce {
                        match cursor {
                            Some(c)
                                if now < en.until_ms
                                    && (proposed.w != en.rect.w || proposed.h != en.rect.h) =>
                            {
                                let out = undock_anchor_rect(
                                    c,
                                    en.rect.w,
                                    en.rect.h,
                                    en.titlebar_phys,
                                    area,
                                );
                                rt.anchor_enforce = Some(AnchorEnforce {
                                    rect: out,
                                    titlebar_phys: en.titlebar_phys,
                                    until_ms: en.until_ms,
                                });
                                rt.anchor = Some(DragAnchor::new(out, c));
                                let scale = rt.model.scale;
                                rt.model = DragModel::begin(None, scale, now);
                                trace(1, DragMode::Free, None, base, out);
                                return out;
                            }
                            _ => rt.anchor_enforce = None,
                        }
                    }
                    // (2) 挂起的锚定请求：前端拖离解除（`set_undock_anchor`）后在这里
                    //     应用——恢复模式尺寸 + 标题栏中心对齐光标在一个拖拽帧内完成，
                    //     并重锚/换 Free 模型，后续帧继续 1:1 跟手（用户无需松手重抓）。
                    if ANCHOR_PENDING.swap(false, Ordering::AcqRel) {
                        if let Some(c) = cursor {
                            let s = dpi_scale(hwnd as isize);
                            let w = (load_milli(&ANCHOR_W_MILLI) * s).round() as i32;
                            let h = (load_milli(&ANCHOR_H_MILLI) * s).round() as i32;
                            let tb = load_milli(&ANCHOR_TB_MILLI) * s;
                            let out = undock_anchor_rect(c, w, h, tb, area);
                            rt.anchor = Some(DragAnchor::new(out, c));
                            rt.model = DragModel::begin(None, s, now);
                            rt.anchor_enforce = Some(AnchorEnforce {
                                rect: out,
                                titlebar_phys: tb,
                                until_ms: now + 500.0,
                            });
                            ANCHOR_APPLIED.store(true, Ordering::Release);
                            trace(1, DragMode::Free, None, base, out);
                            return out;
                        }
                        // 光标读取失败：请求作废，走正常路径（前端回退定位兜底）
                    }

                    let m = &mut rt.model;
                    let out = match m.mode() {
                        DragMode::Free => m.adjust_free(base, area, now),
                        _ => {
                            // 停靠态在拖拽中被前端解除：立刻放弃阻力，避免与区域切换打架
                            if !DOCKED.load(Ordering::Acquire) {
                                m.adjust_free(base, area, now)
                            } else {
                                m.adjust_docked(base, area, now)
                            }
                        }
                    };
                    trace(1, m.mode(), m.edge, base, out);
                    out
                });
                if applied != proposed {
                    write_rect(applied, &mut *ptr);
                }
                call_old(hwnd, msg, wparam, lparam)
            }
            WM_EXITSIZEMOVE => {
                let result = call_old(hwnd, msg, wparam, lparam);
                IN_SIZE_MOVE.with(|f| f.set(false));
                // 拖拽期间 `window_shape::apply` 被推迟（不逐帧 SetWindowRgn / DWM）：
                // 松手后在窗口线程一次性校准区域与 DWM 角偏好。这里直接调用，
                // 与 `lib.rs` 的事件回调同处主线程，不额外起线程。
                crate::window_shape::flush_deferred(hwnd as isize);
                // 拖拽期间前端可能已解除吸附（拖离阈值/跨边/显式解除，DOCKED 已清零）：
                // 此时窗口几何由前端接管（恢复模式尺寸、回工作区），原生磁力不得再回弹——
                // finish 的停靠基准是拖拽开始时的快照，按它回弹会把刚解除的窗口拽回停靠位。
                let docked_now = DOCKED.load(Ordering::Acquire);
                let mut snap: Option<Rect> = None;
                RUNTIME.with(|rt| {
                    let mut rt = rt.borrow_mut();
                    let mut rect: RECT = std::mem::zeroed();
                    let ok =
                        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
                    let applied = if ok != 0 {
                        rect_from(&rect)
                    } else {
                        Rect::new(0, 0, 0, 0)
                    };
                    if docked_now {
                        snap = rt.model.finish(applied);
                        if snap.is_some() {
                            rt.pending_snap = snap;
                        }
                    } else {
                        rt.pending_snap = None; // 拖拽中已解除：迟到的回弹一律作废
                    }
                    // 锚定强制期只存在于拖拽循环内：松手后尺寸恢复由前端兜底
                    rt.anchor_enforce = None;
                    trace(2, rt.model.mode(), rt.model.edge, applied, applied);
                });
                // 拖拽已结束：来不及应用的锚定请求就地作废（前端按回退路径定位），
                // 防止它泄漏到下一次拖拽里突然改窗口。
                ANCHOR_PENDING.store(false, Ordering::Release);
                if snap.is_some() {
                    // 延后一拍回弹：不在 EXITSIZEMOVE 内嵌套 SetWindowPos
                    unsafe {
                        windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                            hwnd,
                            WM_MAGNET_SNAP,
                            0,
                            0,
                        );
                    }
                } else {
                    dump_trace();
                }
                // 拖拽循环已退出：若拖拽中解除过吸附（docked_now=false 且吸附仍开启），
                // 这里恢复系统默认样式——"从吸附状态拖出"的整个手势期间贴靠 UI 均不介入
                if let Some(suppress) = snap_suppression_target(docked_now, false, enabled) {
                    apply_snap_suppression(hwnd, suppress);
                }
                result
            }
            WM_MAGNET_SNAP => {
                let target = RUNTIME.with(|rt| rt.borrow_mut().pending_snap.take());
                if let Some(t) = target {
                    unsafe {
                        SetWindowPos(
                            hwnd,
                            std::ptr::null_mut(),
                            t.x,
                            t.y,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                    trace(3, DragMode::Resist, None, t, t);
                }
                dump_trace();
                0
            }
            WM_MAGNET_STYLE_SYNC => {
                // IPC 线程的 set_dock / set_config 发起：在窗口线程按最新状态
                // 应用或推迟 Snap 抑制（见模块文档「Windows Snap 抑制」）
                sync_snap_suppression(hwnd);
                0
            }
            _ => call_old(hwnd, msg, wparam, lparam),
        }
    }

    fn call_old(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let old = OLD_PROC.load(Ordering::Relaxed);
        if old == 0 {
            return unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::DefWindowProcW(
                    hwnd, msg, wparam, lparam,
                )
            };
        }
        let proc: WNDPROC = unsafe { std::mem::transmute(old) };
        unsafe { CallWindowProcW(proc, hwnd, msg, wparam, lparam) }
    }

    /// 在主窗上安装子类化（必须在该窗口所属线程调用）。
    pub fn install(hwnd: isize) -> bool {
        if hwnd == 0 {
            return false;
        }
        let current = TARGET.load(Ordering::Relaxed);
        if current == hwnd && OLD_PROC.load(Ordering::Relaxed) != 0 {
            return true; // 幂等
        }
        if current != 0 && current != hwnd {
            uninstall(current);
        }
        // 记录原始样式：恢复时只还原原本存在的 WS_MAXIMIZEBOX。
        // setup 钩子里调用（tao 已按配置完成样式设置），此后再无运行时样式写入方。
        let style = unsafe { GetWindowLongW(hwnd as HWND, GWL_STYLE) } as u32;
        ORIGINAL_MAXBOX.store(
            if style & WS_MAXIMIZEBOX != 0 { 1 } else { 2 },
            Ordering::Relaxed,
        );
        let trace_path = std::env::var_os("TASK_DOCK_MAGNET_TRACE")
            .map(std::path::PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        TRACE_ON.store(trace_path.is_some(), Ordering::Relaxed);
        let _ = TRACE_PATH.set(trace_path);
        let new_proc = magnetic_proc as *const () as usize as isize;
        let old = unsafe { SetWindowLongPtrW(hwnd as HWND, GWLP_WNDPROC, new_proc) };
        if old == 0 {
            tracing::warn!(hwnd, "磁力拖拽子类化失败（SetWindowLongPtrW 返回 0）");
            return false;
        }
        OLD_PROC.store(old, Ordering::Relaxed);
        TARGET.store(hwnd, Ordering::Relaxed);
        tracing::debug!(hwnd, "磁力拖拽已安装窗口子类化");
        true
    }

    /// 卸载子类化（窗口销毁前调用；幂等）。
    pub fn uninstall(hwnd: isize) {
        let old = OLD_PROC.swap(0, Ordering::Relaxed);
        let target = TARGET.swap(0, Ordering::Relaxed);
        if target != 0 && old != 0 && (hwnd == 0 || hwnd == target) {
            // 卸载前还原样式：窗口销毁无所谓，但换窗重装时不得把"不可最大化"留给旧窗口
            if SNAP_CLEARED.load(Ordering::Relaxed) {
                apply_snap_suppression(target as HWND, false);
            }
            unsafe {
                SetWindowLongPtrW(target as HWND, GWLP_WNDPROC, old);
            }
        }
        SNAP_CLEARED.store(false, Ordering::Relaxed);
        ANCHOR_PENDING.store(false, Ordering::Release);
        ANCHOR_APPLIED.store(false, Ordering::Release);
        RUNTIME.with(|rt| {
            let mut rt = rt.borrow_mut();
            rt.model = DragModel::default();
            rt.area = None;
            rt.pending_snap = None;
            rt.anchor_enforce = None;
        });
    }

    /// 请求窗口线程按最新停靠/开关状态重估 Snap 抑制（任意线程可调用）。
    pub fn request_style_sync() {
        let hwnd = TARGET.load(Ordering::Relaxed);
        if hwnd == 0 || OLD_PROC.load(Ordering::Relaxed) == 0 {
            return; // 未安装子类化：磁力层整体停用，无样式需要同步
        }
        unsafe {
            PostMessageW(hwnd as HWND, WM_MAGNET_STYLE_SYNC, 0, 0);
        }
    }

    pub fn installed() -> bool {
        TARGET.load(Ordering::Relaxed) != 0
    }

    /// 指定窗口是否正处于系统模态移动/缩放循环内（`WM_ENTERSIZEMOVE`…`WM_EXITSIZEMOVE`）。
    ///
    /// 供 `window_shape` 判定「拖拽期间不要逐帧写区域/DWM」：窗口移动不改变
    /// 窗口自身尺寸，区域在窗口局部坐标里也不随位置变化，因此拖拽期间唯一
    /// 需要的原生动作是**推迟到松手后一次性校准**。
    pub fn in_size_move(hwnd: isize) -> bool {
        TARGET.load(Ordering::Relaxed) == hwnd && IN_SIZE_MOVE.with(|f| f.get())
    }

    #[cfg(test)]
    mod style_tests {
        use super::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, WNDCLASSW, WS_CAPTION,
            WS_SYSMENU,
        };

        /// 创建无头不可见测试窗口（屏幕外 120×80）。
        unsafe fn make_test_window(style: u32) -> HWND {
            static REGISTERED: std::sync::Once = std::sync::Once::new();
            REGISTERED.call_once(|| {
                let wc = WNDCLASSW {
                    style: 0,
                    lpfnWndProc: Some(DefWindowProcW),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: std::ptr::null_mut(),
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: CLASS_TDMGN.as_ptr(),
                };
                RegisterClassW(&wc);
            });
            let hwnd = CreateWindowExW(
                0,
                CLASS_TDMGN.as_ptr(),
                std::ptr::null(),
                style,
                -2000,
                -2000,
                120,
                80,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "CreateWindowExW 失败");
            hwnd
        }

        const CLASS_TDMGN: &[u16] = &[
            b'T' as u16,
            b'D' as u16,
            b'_' as u16,
            b'M' as u16,
            b'G' as u16,
            b'N' as u16,
            0,
        ];

        /// **真实 Win32 窗口**上的 `WS_MAXIMIZEBOX` 清除/恢复验证（OS 层证据）：
        /// 抑制只动这一位、幂等、恢复后与原样式完全一致；原窗口本就不可最大化时
        /// 是纯 no-op。两个场景合并在一个测试里顺序执行——共享的 `ORIGINAL_MAXBOX`
        /// 全局静态不允许并行用例互踩。
        #[test]
        fn suppression_toggles_maximizebox_on_real_window() {
            // ── 场景 A：窗口本就可最大化（主窗口径）─────────────────
            unsafe {
                let hwnd = make_test_window(WS_CAPTION | WS_SYSMENU | WS_MAXIMIZEBOX);

                // 模拟 install() 记录的原始状态：窗口本就可最大化
                ORIGINAL_MAXBOX.store(1, Ordering::Relaxed);
                let style0 = GetWindowLongW(hwnd, GWL_STYLE) as u32;
                assert_ne!(style0 & WS_MAXIMIZEBOX, 0, "前置：窗口应带 WS_MAXIMIZEBOX");

                // 清除：仅去掉该位，其余样式位不变
                assert!(apply_snap_suppression(hwnd, true), "首次清除应实际写入");
                let style1 = GetWindowLongW(hwnd, GWL_STYLE) as u32;
                assert_eq!(style1 & WS_MAXIMIZEBOX, 0, "抑制后不得再带 WS_MAXIMIZEBOX");
                assert_eq!(
                    style1 & !WS_MAXIMIZEBOX,
                    style0 & !WS_MAXIMIZEBOX,
                    "其余样式位不得变化"
                );

                // 幂等：重复清除是 no-op
                assert!(!apply_snap_suppression(hwnd, true));

                // 恢复：与原样式完全一致
                assert!(apply_snap_suppression(hwnd, false), "首次恢复应实际写入");
                assert_eq!(
                    GetWindowLongW(hwnd, GWL_STYLE) as u32,
                    style0,
                    "恢复后样式必须与原始一致"
                );
                assert!(!apply_snap_suppression(hwnd, false), "重复恢复是 no-op");

                DestroyWindow(hwnd);
            }

            // ── 场景 B：窗口本就不可最大化（如 maximizable:false 的配置）────
            unsafe {
                let hwnd = make_test_window(WS_CAPTION | WS_SYSMENU);
                ORIGINAL_MAXBOX.store(2, Ordering::Relaxed);
                let style0 = GetWindowLongW(hwnd, GWL_STYLE) as u32;
                assert_eq!(style0 & WS_MAXIMIZEBOX, 0, "前置：窗口不可最大化");

                assert!(
                    !apply_snap_suppression(hwnd, true),
                    "原不可最大化时清除是 no-op"
                );
                assert!(
                    !apply_snap_suppression(hwnd, false),
                    "原不可最大化时恢复是 no-op"
                );
                assert_eq!(
                    GetWindowLongW(hwnd, GWL_STYLE) as u32,
                    style0,
                    "样式不得被改动"
                );

                DestroyWindow(hwnd);
            }

            // 还原全局测试状态，避免影响其他测试（0 = 未记录）
            ORIGINAL_MAXBOX.store(0, Ordering::Relaxed);
        }
    }
}

#[cfg(windows)]
pub use win::{in_size_move, install, installed, uninstall};

#[cfg(not(windows))]
pub fn in_size_move(_hwnd: isize) -> bool {
    false
}

#[cfg(not(windows))]
pub fn install(_hwnd: isize) -> bool {
    false
}
#[cfg(not(windows))]
pub fn uninstall(_hwnd: isize) {}
#[cfg(not(windows))]
pub fn installed() -> bool {
    false
}

/// 窗口销毁时卸载子类化：句柄被系统复用后，残留的原窗口过程指针会把
/// 新窗口的 wndproc 写坏（`window_shape::watch_destroy` 同一动机）。
pub fn watch_destroy<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) {
    let hwnd = win.hwnd().map(|h| h.0 as isize).ok();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            uninstall(hwnd.unwrap_or(0));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1032,
    };

    fn free_model() -> DragModel {
        DragModel::begin(None, 1.0, 0.0)
    }

    // ── 吸引曲线 ────────────────────────────────────────────

    /// 磁场外必须完全跟随鼠标：lead = 0，且随距离单调不增。
    #[test]
    fn attraction_is_zero_outside_range_and_monotone_inside() {
        let r = ATTRACT_RANGE_CSS;
        let m = ATTRACT_MAX_LEAD_CSS;
        assert_eq!(attraction_lead(r + 1.0, r, m), 0.0);
        assert_eq!(attraction_lead(r, r, m), 0.0);
        // 物理量是「窗口结果位置」d − lead：它必须随 d 单调不增（越靠越近），
        // 且始终 ≥ 0（不被推出屏幕）。lead 本身在钳制段会随 d 变小而变小，
        // 所以不能直接断言 lead 单调。
        let mut prev_pos = f64::INFINITY;
        let mut d = r;
        while d >= 0.0 {
            let lead = attraction_lead(d, r, m);
            assert!(lead <= m + 1e-9, "吸引位移必须被 max_lead 钳住");
            assert!(lead <= d + 1e-9, "结果距离不得为负（不把窗口推出屏幕）");
            let pos = d - lead;
            assert!(
                pos <= prev_pos + 1e-9,
                "越接近边缘窗口必须越靠里：d={d} pos={pos} prev={prev_pos}"
            );
            prev_pos = pos;
            d -= 0.5;
        }
        // 中段确实有明显吸引（不是"阈值伪装成磁力"）
        assert!(attraction_lead(r * 0.5, r, m) > m * 0.4);
    }

    /// 曲线连续：相邻 0.25px 采样不得出现跳变（> 1px 的突变就是"突然跳"）。
    #[test]
    fn attraction_is_continuous() {
        let r = ATTRACT_RANGE_CSS;
        let m = ATTRACT_MAX_LEAD_CSS;
        let mut d = 0.0;
        while d < r {
            let a = attraction_lead(d, r, m);
            let b = attraction_lead(d + 0.25, r, m);
            assert!(
                (a - b).abs() <= 1.0,
                "d={d} 处吸引位移跳变 {}",
                (a - b).abs()
            );
            d += 0.25;
        }
    }

    /// 四边一致：同样的距离产生同样的额外位移，方向各自朝自己的边。
    #[test]
    fn attraction_is_symmetric_across_four_edges() {
        let range = ATTRACT_RANGE_CSS;
        let lead = attraction_lead(24.0, range, ATTRACT_MAX_LEAD_CSS);
        assert!(lead > 0.0);

        let left = Rect::new(24, 400, 400, 560);
        let right = Rect::new(1920 - 400 - 24, 400, 400, 560);
        let top = Rect::new(700, 24, 400, 560);
        let bottom = Rect::new(700, 1032 - 560 - 24, 400, 560);

        let mut m = free_model();
        let l = m.adjust_free(left, AREA, 0.0);
        let r = m.adjust_free(right, AREA, 0.0);
        let t = m.adjust_free(top, AREA, 0.0);
        let b = m.adjust_free(bottom, AREA, 0.0);

        assert_eq!(l.x, 24 - lead.round() as i32, "左侧应向 x=0 靠拢");
        assert_eq!(r.x, right.x + lead.round() as i32, "右侧应向屏幕右缘靠拢");
        assert_eq!(t.y, 24 - lead.round() as i32, "顶侧应向 y=0 靠拢");
        assert_eq!(b.y, bottom.y + lead.round() as i32, "底侧应向屏幕下缘靠拢");
        // 另一条轴完全不动
        assert_eq!((l.y, r.y, t.x, b.x), (left.y, right.y, top.x, bottom.x));
    }

    /// 靠近时窗口确实领先鼠标；贴平后继续靠近不再越界。
    #[test]
    fn attraction_leads_window_and_never_crosses_edge() {
        let mut m = free_model();
        let mut prev_x = i32::MAX;
        for d in (0..=ATTRACT_RANGE_CSS as i32).rev() {
            let r = m.adjust_free(Rect::new(d, 400, 400, 560), AREA, 0.0);
            assert!(r.x <= d, "窗口不得越过屏幕边缘（d={d} → x={rx}）", rx = r.x);
            assert!(r.x <= prev_x, "单调靠近：d={d} → x={} prev={prev_x}", r.x);
            prev_x = r.x;
        }
        assert_eq!(prev_x, 0, "最后必须精确贴平");
        // 中段窗口领先于鼠标（额外位移 > 0）
        let mid = m.adjust_free(Rect::new(30, 400, 400, 560), AREA, 0.0);
        assert!(mid.x < 30, "进入磁场后窗口必须领先鼠标：x={}", mid.x);
    }

    /// 反方向拖离：吸引平滑消失（不是突然放手），窗口回到跟随鼠标。
    #[test]
    fn attraction_fades_smoothly_when_pulling_away() {
        let mut m = free_model();
        let mut prev = 0i32;
        for d in 0..=80 {
            let r = m.adjust_free(Rect::new(d, 400, 400, 560), AREA, 0.0);
            assert!(
                r.x >= prev,
                "拖离时窗口位置必须单调增大（不得回跳）：d={d} x={} prev={prev}",
                r.x
            );
            prev = r.x;
        }
        // 磁场外完全等于提议矩形
        assert_eq!(prev, 80);
    }

    /// 明显越出边缘（压过屏幕边）时不再加力，避免把窗口进一步推出屏幕。
    #[test]
    fn attraction_does_not_push_window_off_screen() {
        let mut m = free_model();
        let r = m.adjust_free(Rect::new(-40, 400, 400, 560), AREA, 0.0);
        assert_eq!(r.x, -40);
    }

    // ── 脱离阻力 ────────────────────────────────────────────

    /// 阻力：窗口位移始终小于游标位移，且单调不减。
    #[test]
    fn resistance_is_always_less_than_cursor_travel() {
        let release = RELEASE_DRAG_CSS;
        let mut prev = 0.0;
        let mut d = 0.5;
        while d < release {
            let disp = release_displacement(d, release);
            assert!(disp < d, "窗口位移必须小于拖动距离：d={d} disp={disp}");
            assert!(disp >= prev, "阻力必须单调：d={d}");
            prev = disp;
            d += 0.5;
        }
        // 弹性可见位移落在 4–8 CSS px 区间（需求给定手感区间）
        let at4 = (0..=release as i32)
            .map(|i| i as f64)
            .find(|&x| release_displacement(x, release) >= 4.0)
            .expect("应存在 4px 位移点");
        let at8 = (0..=release as i32)
            .map(|i| i as f64)
            .find(|&x| release_displacement(x, release) >= 8.0)
            .expect("应存在 8px 位移点");
        assert!((14.0..=30.0).contains(&at4), "4px 位移出现在 {at4}px 处");
        assert!((20.0..=release).contains(&at8), "8px 位移出现在 {at8}px 处");
    }

    fn docked_model(edge: Edge, base: Rect) -> DragModel {
        DragModel::begin(Some((edge, base)), 1.0, 0.0)
    }

    /// 停靠态：轻拉被拉住（位移远小于拖动），未突破前不会脱开。
    #[test]
    fn docked_drag_is_held_back_until_release() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        let mut last = 0;
        for d in 1..RELEASE_DRAG_CSS as i32 {
            let out = m.adjust_docked(Rect::new(d, 300, 400, 420), AREA, 0.0);
            assert_eq!(m.mode(), DragMode::Resist, "d={d} 不应提前释放");
            assert!(out.x < d, "窗口位移必须小于拖动：d={d} x={}", out.x);
            assert!(out.x >= last, "位移单调");
            last = out.x;
        }
        assert!(last >= 4, "轻拉必须产生可见弹性位移，实测 {last}px");
    }

    /// 达到阈值一次性释放，且释放瞬间**不跳变**（连续性）。
    #[test]
    fn release_is_one_shot_and_continuous() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        let d_before = RELEASE_DRAG_CSS - 1.0;
        let before = m.adjust_docked(Rect::new(d_before as i32, 300, 400, 420), AREA, 0.0);
        assert_eq!(m.mode(), DragMode::Resist);

        let at = RELEASE_DRAG_CSS as i32;
        let after = m.adjust_docked(Rect::new(at, 300, 400, 420), AREA, 0.0);
        assert_eq!(m.mode(), DragMode::Released, "越过阈值必须释放");
        assert!(
            (after.x - before.x).abs() <= 2,
            "释放瞬间不得跳变：before={} after={}",
            before.x,
            after.x
        );

        // 释放后 1:1 跟随（同样 10px 的拖动产生 ~10px 位移）
        let a = m.adjust_docked(Rect::new(at + 10, 300, 400, 420), AREA, 0.0);
        let b = m.adjust_docked(Rect::new(at + 20, 300, 400, 420), AREA, 0.0);
        assert!(
            (b.x - a.x - 10).abs() <= 2,
            "释放后应 1:1 跟随：{} → {}",
            a.x,
            b.x
        );
    }

    /// 反向拖动（往屏幕边里推）不产生振荡：法向钳回齐平位。
    #[test]
    fn pushing_back_towards_edge_is_clamped_without_oscillation() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        // d ≤ 0（往屏幕边里推）：钳回齐平位，绝不把胶囊推出屏幕
        for d in [0, -3, -8] {
            let out = m.adjust_docked(Rect::new(d, 300, 400, 420), AREA, 0.0);
            assert_eq!(out.x, 0, "向屏幕边内推必须钳在齐平位（d={d}）");
        }
        // d > 0 仍在阻力段：位移严格小于拖动距离，且单调（不振荡）
        let mut prev = 0;
        for d in [2, 6, 10, 20, 30] {
            let out = m.adjust_docked(Rect::new(d, 300, 400, 420), AREA, 0.0);
            assert!(out.x <= d, "阻力段位移不得超过拖动距离（d={d}）");
            assert!(out.x >= prev, "阻力段位移必须单调（d={d}）");
            prev = out.x;
        }
        assert_eq!(m.mode(), DragMode::Resist, "反向拖动不得触发释放");
    }

    /// 沿边方向拖动不触发脱离（只换 along 坐标，法向保持齐平）。
    #[test]
    fn along_edge_drag_never_releases() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        for dy in [-200, -80, -20, 0, 20, 80, 200] {
            let out = m.adjust_docked(Rect::new(0, 300 + dy, 400, 420), AREA, 0.0);
            assert_eq!(m.mode(), DragMode::Resist, "沿边移动 dy={dy} 不得解除");
            assert_eq!(out.x, 0, "沿边移动不得改变法向坐标");
            assert_eq!(out.y, 300 + dy, "沿边坐标应 1:1 跟随");
        }
        // 沿边也不得被拖出工作区
        let out = m.adjust_docked(Rect::new(0, 5000, 400, 420), AREA, 0.0);
        assert_eq!(out.y, AREA.h - 420);
        let out = m.adjust_docked(Rect::new(0, -500, 400, 420), AREA, 0.0);
        assert_eq!(out.y, 0);
    }

    /// 未突破松手：回弹到齐平位（保留沿边位置）。
    #[test]
    fn sub_threshold_release_snaps_back_flush() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        let out = m.adjust_docked(Rect::new(20, 320, 400, 420), AREA, 0.0);
        assert_eq!(m.mode(), DragMode::Resist);
        let snap = m.finish(out).expect("未突破必须回弹");
        assert_eq!((snap.x, snap.y), (0, 320), "法向回齐平、沿边保留");
    }

    /// 突破但窗口位移仍小于提交阈值：仍然回弹（避免停在半脱开状态）。
    #[test]
    fn released_but_small_offset_still_snaps_back() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        let out = m.adjust_docked(Rect::new(RELEASE_DRAG_CSS as i32, 300, 400, 420), AREA, 0.0);
        assert_eq!(m.mode(), DragMode::Released);
        assert!(out.x < COMMIT_DRAG_CSS as i32, "释放点位移应小于提交阈值");
        assert!(m.finish(out).is_some(), "位移不足提交阈值时必须回弹");
    }

    /// 突破并拖出提交阈值：不回弹，交给前端解除。
    #[test]
    fn committed_drag_does_not_snap_back() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        let d = (RELEASE_DRAG_CSS + COMMIT_DRAG_CSS + 20.0) as i32;
        let out = m.adjust_docked(Rect::new(d, 300, 400, 420), AREA, 0.0);
        assert!(out.x >= COMMIT_DRAG_CSS as i32);
        assert!(m.finish(out).is_none(), "越过提交阈值后不得回弹");
    }

    /// 突破后同一拖拽内不再被吸回（滞回），离开足够远才重新武装。
    #[test]
    fn rearm_requires_leaving_the_magnet_field() {
        let base = Rect::new(0, 300, 400, 420);
        let mut m = docked_model(Edge::Left, base);
        let d = (RELEASE_DRAG_CSS + COMMIT_DRAG_CSS + 20.0) as i32;
        m.adjust_docked(Rect::new(d, 300, 400, 420), AREA, 0.0);
        assert_eq!(m.mode(), DragMode::Released);

        // 拖回边缘附近：不得重新吸引（窗口 1:1 跟随游标）
        let back = Rect::new(20, 300, 400, 560);
        let out = m.adjust_docked(back, AREA, 0.0);
        assert!(out.x >= 0);

        // 新的一次拖拽（自由窗口）在磁场内仍会被吸引——滞回只限同一次拖拽
        let mut fresh = DragModel::begin(None, 1.0, 0.0);
        let attracted = fresh.adjust_free(Rect::new(20, 300, 400, 560), AREA, 0.0);
        assert!(attracted.x < 20, "新拖拽应重新受吸引");
    }

    /// 四边一致：同样的拖动距离在四条边产生同样的法向位移。
    #[test]
    fn resistance_matches_on_four_edges() {
        let cases = [
            (
                Edge::Left,
                Rect::new(0, 300, 400, 420),
                Rect::new(12, 300, 400, 420),
            ),
            (
                Edge::Right,
                Rect::new(1920 - 400, 300, 400, 420),
                Rect::new(1920 - 400 - 12, 300, 400, 420),
            ),
            (
                Edge::Top,
                Rect::new(700, 0, 400, 420),
                Rect::new(700, 12, 400, 420),
            ),
            (
                Edge::Bottom,
                Rect::new(700, 1032 - 420, 400, 420),
                Rect::new(700, 1032 - 420 - 12, 400, 420),
            ),
        ];
        for (edge, base, proposed) in cases {
            let mut m = docked_model(edge, base);
            let out = m.adjust_docked(proposed, AREA, 0.0);
            let disp = normal_offset(out, base, edge);
            assert!(
                (disp - release_displacement(12.0, RELEASE_DRAG_CSS)).abs() <= 1.0,
                "edge={edge:?} 位移 {disp} 与左/上边不一致"
            );
        }
    }

    // ── DPI / 多屏负坐标 ────────────────────────────────────

    /// 高 DPI：物理像素阈值按缩放放大，手感（CSS 口径）保持一致。
    #[test]
    fn dpi_scaling_keeps_css_feel() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let mut m = DragModel::begin(None, scale, 0.0);
            let d = (ATTRACT_RANGE_CSS * scale * 0.5) as i32;
            let out = m.adjust_free(Rect::new(d, 400, 400, 560), AREA, 0.0);
            let lead = (d - out.x) as f64;
            let css_lead = lead / scale;
            let expect = attraction_lead(
                ATTRACT_RANGE_CSS * 0.5,
                ATTRACT_RANGE_CSS,
                ATTRACT_MAX_LEAD_CSS,
            );
            assert!(
                (css_lead - expect).abs() <= 1.0,
                "scale={scale} CSS 口径吸引位移 {css_lead} != {expect}"
            );

            // 停靠阻力同样按 CSS 口径一致
            let base = Rect::new(0, 300, 400, 420);
            let mut dm = DragModel::begin(Some((Edge::Left, base)), scale, 0.0);
            let drag = (16.0 * scale) as i32;
            let out = dm.adjust_docked(Rect::new(drag, 300, 400, 420), AREA, 0.0);
            let css_disp = out.x as f64 / scale;
            let expect = release_displacement(16.0, RELEASE_DRAG_CSS);
            assert!(
                (css_disp - expect).abs() <= 1.0,
                "scale={scale} CSS 口径阻力位移 {css_disp} != {expect}"
            );
        }
    }

    /// 负坐标多屏（副屏在主屏左侧）：几何与吸引方向必须正确。
    #[test]
    fn negative_coordinate_monitor_works() {
        let area = Rect::new(-1920, 0, 1920, 1032);
        let mut m = DragModel::begin(None, 1.0, 0.0);
        // 贴近副屏左缘
        let out = m.adjust_free(Rect::new(-1920 + 20, 300, 400, 560), area, 0.0);
        assert!(out.x < -1920 + 20, "应向副屏左缘靠拢（x 减小）");
        // 贴近副屏右缘（接缝）
        let right = Rect::new(-400 - 20, 300, 400, 560);
        let out = m.adjust_free(right, area, 0.0);
        assert!(out.x > right.x, "应向副屏右缘靠拢（x 增大）");
    }

    /// 中心不在工作区跨度内时不判该边（防止跨屏误吸）。
    #[test]
    fn edge_outside_span_is_ignored() {
        let mut m = DragModel::begin(None, 1.0, 0.0);
        // 窗口在屏幕下方之外（中心 y > area.h）：left 边不应生效
        let far = Rect::new(10, 5000, 400, 560);
        let out = m.adjust_free(far, AREA, 0.0);
        assert_eq!(out, far);
        assert_eq!(m.edge, None);
    }

    /// 关闭时（enabled=false）由调用方旁路，模型本身不引入副作用：
    /// 这里验证配置读写与 dock 快照的语义。
    #[test]
    fn config_and_dock_snapshot_roundtrip() {
        set_config(true, 56.0, 16.0, 32.0);
        let (enabled, range, lead, release) = config();
        assert!(enabled);
        assert!((range - 56.0).abs() < 1e-6);
        assert!((lead - 16.0).abs() < 1e-6);
        assert!((release - 32.0).abs() < 1e-6);

        set_dock(Some(Edge::Right), 1520, 300);
        let (edge, base) = docked_snapshot().expect("应读到停靠快照");
        assert_eq!(edge, Edge::Right);
        assert_eq!((base.x, base.y), (1520, 300));

        set_dock(None, 0, 0);
        assert!(docked_snapshot().is_none());

        set_config(false, 56.0, 16.0, 32.0);
        assert!(!config().0);
    }

    /// 跨端契约：与 `src/lib/edgeSnap.ts` 的 `SNAP_MAGNET_*` 同值。
    #[test]
    fn magnet_contract_matches_frontend() {
        // 2026-11-02：吸引范围 56 → 50（用户反馈介入过早，收窄几个像素）
        assert_eq!(ATTRACT_RANGE_CSS, 50.0);
        assert_eq!(ATTRACT_MAX_LEAD_CSS, 16.0);
        assert_eq!(RELEASE_DRAG_CSS, 32.0);
        assert_eq!(COMMIT_DRAG_CSS, 24.0, "必须等于前端 SNAP_UNDOCK_DRAG_PX");
        assert_eq!(REARM_DIST_CSS, 96.0);
    }

    /// Windows Snap 抑制的状态决策：停靠即抑制；解除即恢复；
    /// 拖拽循环内解除必须**推迟**恢复（保证整个拖出手势无系统贴靠 UI）；
    /// 吸附关闭时无条件恢复。
    #[test]
    fn snap_suppression_follows_dock_state() {
        assert_eq!(
            snap_suppression_target(true, false, true),
            Some(true),
            "停靠态应抑制"
        );
        assert_eq!(
            snap_suppression_target(true, true, true),
            Some(true),
            "停靠态拖拽中仍抑制"
        );
        assert_eq!(
            snap_suppression_target(false, false, true),
            Some(false),
            "自由态应恢复"
        );
        assert_eq!(
            snap_suppression_target(false, true, true),
            None,
            "拖拽循环内解除吸附：恢复必须推迟到循环退出"
        );
        assert_eq!(
            snap_suppression_target(true, false, false),
            Some(false),
            "吸附关闭：无论停靠位如何都恢复系统默认样式"
        );
        assert_eq!(snap_suppression_target(false, true, false), Some(false));
    }

    /// 沿边位移与法向位移的正交性（诊断口径）。
    #[test]
    fn normal_and_along_offsets_are_orthogonal() {
        let base = Rect::new(0, 300, 400, 420);
        let moved = Rect::new(12, 340, 400, 420);
        assert_eq!(normal_offset(moved, base, Edge::Left), 12.0);
        assert_eq!(along_offset(moved, base, Edge::Left), 40.0);
        assert_eq!(normal_offset(moved, base, Edge::Right), -12.0);
        assert_eq!(normal_offset(moved, base, Edge::Top), 40.0);
        assert_eq!(normal_offset(moved, base, Edge::Bottom), -40.0);
    }

    // ── 拖拽锚点：屏蔽系统移动循环的位置反馈 ──────────────────────

    /// `raw` 必须只由「起点矩形 + 光标增量」决定，与系统提案的位置无关。
    #[test]
    fn anchor_raw_ignores_proposal_position() {
        let start = Rect::new(200, 140, 400, 560);
        let anchor = DragAnchor::new(start, (280.0, 156.0));
        // 系统提案已经把我们上一帧的磁力位移吸收进去了（真机行为）
        let polluted = Rect::new(0, 140, 400, 560);
        let raw = anchor
            .raw(polluted, (120.0, 156.0))
            .expect("尺寸未变应返回");
        assert_eq!(raw.x, 40, "起点 200 + 光标 -160 = 40，与提案 0 无关");
        assert_eq!(raw.y, 140);
        assert_eq!(raw.w, 400);
        assert_eq!(raw.h, 560);
    }

    /// 尺寸被系统改动（Aero Snap 等）时必须放弃磁力并重锚，不能拿旧尺寸算位移。
    #[test]
    fn anchor_raw_rejects_size_change() {
        let anchor = DragAnchor::new(Rect::new(200, 140, 400, 560), (280.0, 156.0));
        assert!(anchor
            .raw(Rect::new(200, 0, 400, 690), (280.0, 16.0))
            .is_none());
    }

    /// 回归：系统移动循环首帧会送一个全 0 的退化矩形。
    /// 若把它当"尺寸变化"重锚，锚点会被重置到原点、阻力段窗口被钉死（真机实测）。
    #[test]
    fn anchor_raw_rejects_degenerate_rect() {
        let anchor = DragAnchor::new(Rect::new(0, 140, 510, 550), (20.0, 610.0));
        assert!(
            anchor.raw(Rect::new(0, 0, 0, 0), (20.0, 610.0)).is_none(),
            "退化矩形不得参与还原"
        );
        // 真实矩形仍应正常还原
        let ok = anchor
            .raw(Rect::new(0, 140, 510, 550), (40.0, 610.0))
            .expect("真实矩形");
        assert_eq!(ok.x, 20);
    }

    /// 回归：系统每帧以「已应用矩形」为基准重算提案时，领先量不得累积。
    ///
    /// 真机实测的旧实现会累积到 48px（远超 16px 上限）并把窗口推出屏幕左缘。
    /// 现在锚点固定在整个拖拽期间，喂给模型的永远是还原后的 1:1 矩形。
    #[test]
    fn lead_does_not_accumulate_across_frames() {
        let area = Rect::new(0, 0, 2560, 1380);
        let start = Rect::new(200, 140, 400, 560);
        let grab = 80.0; // 光标在窗口内 80px 处
        let anchor = DragAnchor::new(start, (200.0 + grab, 156.0));
        let mut model = free_model();
        // 系统提案：起始 = 窗口当前位置；之后每帧 = 上一帧的 applied（反馈）
        let mut system_prop = start;
        let mut cursor = 200.0 + grab;
        let mut max_lead = 0.0f64;
        let mut lead_at_flush = f64::NAN;

        for _ in 0..160 {
            cursor -= 2.0;
            let raw = anchor.raw(system_prop, (cursor, 156.0)).expect("尺寸未变");
            let applied = model.adjust_free(raw, area, 0.0);
            let lead = raw.x as f64 - applied.x as f64;
            max_lead = max_lead.max(lead);
            assert!(lead >= 0.0, "吸引只能朝边缘，不得反向：lead={lead}");
            assert!(
                lead <= ATTRACT_MAX_LEAD_CSS + 0.5,
                "领先量必须被上限约束（实测 {lead}）"
            );
            if raw.x <= area.x {
                // 已到/越过边缘：磁力不再施加任何位移，窗口严格 1:1 跟随光标
                assert_eq!(
                    applied.x, raw.x,
                    "越界后不得继续加力：{applied:?} vs {raw:?}"
                );
            }
            if raw.x == 0 {
                lead_at_flush = lead;
            }
            // 反馈：系统下一帧基于已应用矩形重算提案
            system_prop = applied;
        }
        assert_eq!(lead_at_flush, 0.0, "恰好齐平时不应有额外领先");
        // `lead ≤ d` 钳制使得曲线渐近上限 16 实际取不到：`16·smoothstep(1−d/56) = d`
        // 的交点在 d ≈ 13.7，这就是真机可观测到的最大领先量（仍在 12–20 区间内）。
        assert!(
            max_lead >= 12.0 && max_lead <= ATTRACT_MAX_LEAD_CSS,
            "最大领先量应落在 12–16 之间（实测 {max_lead}）"
        );
    }

    /// 反向：从贴边往外拖，窗口只能越来越远离边缘（不得回弹），最终完全 1:1。
    ///
    /// 注意贴近边缘时 `lead ≤ d` 钳制会让领先量**先增后减**：距离 2px 时
    /// 最多只能领先 2px（已经齐平，无法再往边里推），所以"领先量单调递减"
    /// 不是正确口径，正确口径是"窗口位置单调远离边缘"。
    #[test]
    fn lead_fades_to_zero_when_leaving_edge() {
        let area = Rect::new(0, 0, 2560, 1380);
        let anchor = DragAnchor::new(Rect::new(0, 140, 400, 560), (80.0, 156.0));
        let mut model = free_model();
        let mut system_prop = Rect::new(0, 140, 400, 560);
        let mut cursor = 80.0;
        let mut applied_x = Vec::new();
        for _ in 0..60 {
            cursor += 2.0;
            let raw = anchor.raw(system_prop, (cursor, 156.0)).expect("尺寸未变");
            let applied = model.adjust_free(raw, area, 0.0);
            applied_x.push(applied.x as f64);
            system_prop = applied;
        }
        for w in applied_x.windows(2) {
            assert!(
                w[1] >= w[0] - 0.001,
                "拖离时窗口必须单调远离边缘：{applied_x:?}"
            );
        }
        // 超出磁场（56px）后必须完全 1:1：光标 80→200，窗口 0→120
        assert_eq!(*applied_x.last().unwrap(), 120.0, "磁场外必须严格跟手");
    }

    /// 停靠态：用还原矩形算法向位移，阻力不随系统反馈累积。
    #[test]
    fn docked_resistance_does_not_accumulate() {
        let area = Rect::new(0, 0, 2560, 1380);
        let base = Rect::new(0, 300, 400, 420);
        let mut model = DragModel::begin(Some((Edge::Left, base)), 1.0, 0.0);
        let anchor = DragAnchor::new(base, (24.0, 500.0));
        let mut system_prop = base;
        let mut cursor = 24.0;
        let mut last_disp = 0;
        for _ in 0..10 {
            cursor += 2.0; // 共拉 20px，未达 32px 阈值
            let raw = anchor.raw(system_prop, (cursor, 500.0)).expect("尺寸未变");
            let applied = model.adjust_docked(raw, area, 0.0);
            system_prop = applied;
            last_disp = applied.x;
        }
        assert_eq!(model.mode(), DragMode::Resist, "20px 未突破阈值");
        // 游标 20px → 位移 20²/(2·32) = 6.25px，必须远小于拖动距离
        assert!(
            (last_disp as f64 - 6.25).abs() < 0.6,
            "阻力位移应约 6.25px，实测 {last_disp}"
        );
        assert!(last_disp < 20, "位移必须小于拖动距离");
    }

    // ── 拖离解除的鼠标锚定（undock_anchor_rect）───────────────────

    const ANCHOR_W: i32 = 400;
    const ANCHOR_H: i32 = 560;
    const ANCHOR_TB: f64 = 41.0;

    /// 居中：光标在屏幕中部时，窗口宽度的中点对准光标 x、标题栏中线对准光标 y。
    /// 光标 y=500 处标题栏居中会让窗口下缘压到任务栏（480+560 > 1032），
    /// 因此 y 被最小位移钳到 472——光标仍在标题栏带（472..513）内。
    #[test]
    fn anchor_centers_titlebar_on_cursor() {
        let cursor = (960.0, 500.0);
        let r = undock_anchor_rect(cursor, ANCHOR_W, ANCHOR_H, ANCHOR_TB, AREA);
        assert_eq!(r.x, 960 - ANCHOR_W / 2);
        assert_eq!(r.y, 472, "窗口下缘不得压进任务栏（最小位移钳制）");
        assert_eq!((r.w, r.h), (ANCHOR_W, ANCHOR_H));
        // 光标确实落在标题栏带内（y ∈ [r.y, r.y + titlebar]）且在窗口内
        assert!(cursor.1 >= r.y as f64 && cursor.1 <= r.y as f64 + ANCHOR_TB);
        assert!(cursor.0 >= r.x as f64 && cursor.0 <= (r.x + r.w) as f64);

        // 光标更高时不受钳制：标题栏严格居中
        let r = undock_anchor_rect((960.0, 400.0), ANCHOR_W, ANCHOR_H, ANCHOR_TB, AREA);
        assert_eq!(r.y, (400.0 - ANCHOR_TB / 2.0).round() as i32);
        assert!(400.0 >= r.y as f64 && 400.0 <= r.y as f64 + ANCHOR_TB);
    }

    /// 左缘：光标贴左工作区边时窗口整体在屏内，光标仍在窗口内。
    #[test]
    fn anchor_clamps_at_left_edge() {
        let r = undock_anchor_rect((5.0, 500.0), ANCHOR_W, ANCHOR_H, ANCHOR_TB, AREA);
        assert_eq!(r.x, 0, "窗口左缘钳在工作区左缘");
        assert!(5 >= r.x && 5 <= r.x + r.w, "光标必须落在窗口内");
    }

    /// 右缘：同理，窗口不越出工作区右缘。
    #[test]
    fn anchor_clamps_at_right_edge() {
        let r = undock_anchor_rect((1915.0, 500.0), ANCHOR_W, ANCHOR_H, ANCHOR_TB, AREA);
        assert_eq!(r.x + r.w, AREA.w, "窗口右缘齐工作区右缘");
        assert!(1915 >= r.x && 1915 <= r.x + r.w);
    }

    /// 顶缘：标题栏中心要求与工作区上缘冲突时窗口完整可见优先，光标不落窗外。
    #[test]
    fn anchor_clamps_at_top_edge() {
        let r = undock_anchor_rect((900.0, 3.0), ANCHOR_W, ANCHOR_H, ANCHOR_TB, AREA);
        assert_eq!(r.y, 0);
        assert!(3.0 >= r.y as f64 && 3.0 <= (r.y + r.h) as f64);
        // 上缘空间足够（41/2 < 3 不成立 → 钳制），但光标仍尽量接近标题栏：
        // 光标到窗口顶的距离必须小于一个标题栏高度 + 1
        assert!((3.0 - r.y as f64) <= ANCHOR_TB);
    }

    /// 底缘：窗口比光标下方剩余空间高时，无法同时「完整可见 + 光标在标题栏」，
    /// 此时取最小位移（窗口尽量往下贴），光标保持在窗口内。
    #[test]
    fn anchor_clamps_at_bottom_edge() {
        let bottom = AREA.y + AREA.h;
        let r = undock_anchor_rect(
            (900.0, (bottom - 2) as f64),
            ANCHOR_W,
            ANCHOR_H,
            ANCHOR_TB,
            AREA,
        );
        assert_eq!(r.y + r.h, bottom, "窗口下缘齐工作区下缘（最小位移）");
        assert!(
            (bottom - 2) as f64 >= r.y as f64 && (bottom - 2) as f64 <= (r.y + r.h) as f64,
            "光标必须落在窗口内"
        );
    }

    /// 负坐标多屏（副屏在主屏左侧）：锚点几何同样正确。
    #[test]
    fn anchor_works_with_negative_coordinates() {
        let area = Rect::new(-1920, 0, 1920, 1032);
        let r = undock_anchor_rect((-1000.0, 400.0), ANCHOR_W, ANCHOR_H, ANCHOR_TB, area);
        assert_eq!(r.x, -1000 - ANCHOR_W / 2);
        assert_eq!(r.y, (400.0 - ANCHOR_TB / 2.0).round() as i32);
        // 左缘钳制
        let r = undock_anchor_rect((-1915.0, 400.0), ANCHOR_W, ANCHOR_H, ANCHOR_TB, area);
        assert_eq!(r.x, area.x);
        assert!(-1915.0 >= r.x as f64 && -1915.0 <= (r.x + r.w) as f64);
    }

    /// 光标在任务栏上（工作区外）松手：按钳进工作区的参考光标摆放，窗口完整可见。
    #[test]
    fn anchor_cursor_outside_work_area_is_pulled_in() {
        let r = undock_anchor_rect(
            (900.0, (AREA.y + AREA.h + 30) as f64),
            ANCHOR_W,
            ANCHOR_H,
            ANCHOR_TB,
            AREA,
        );
        assert!(r.y + r.h <= AREA.y + AREA.h, "窗口必须完整落在工作区内");
    }

    /// 不变量：工作区内的任意光标位置下，光标都在结果窗口内且窗口完整可见；
    /// 工作区外的光标（任务栏/屏外）无法同时满足两者，只要求窗口完整可见。
    #[test]
    fn anchor_cursor_always_inside_window() {
        for &ox in &[-1920i32, 0, 2560] {
            for &oy in &[-400i32, 0, 800] {
                let area = Rect::new(ox, oy, 1920, 1032);
                // 工作区内（含边缘）：光标必须落在窗口内
                for cx in [
                    ox as f64,
                    ox as f64 + 1.0,
                    ox as f64 + 960.0,
                    ox as f64 + 1919.0,
                ] {
                    for cy in [
                        oy as f64,
                        oy as f64 + 1.0,
                        oy as f64 + 500.0,
                        oy as f64 + 1031.0,
                    ] {
                        let r = undock_anchor_rect((cx, cy), ANCHOR_W, ANCHOR_H, ANCHOR_TB, area);
                        assert!(
                            cx >= r.x as f64 && cx <= (r.x + r.w) as f64,
                            "光标 x 必须在窗口内：cursor={cx} rect={r:?}"
                        );
                        assert!(
                            cy >= r.y as f64 && cy <= (r.y + r.h) as f64,
                            "光标 y 必须在窗口内：cursor={cy} rect={r:?}"
                        );
                        assert!(r.x >= area.x && r.y >= area.y);
                        assert!(r.x + r.w <= area.x + area.w && r.y + r.h <= area.y + area.h);
                    }
                }
                // 工作区外：几何上不可能既完整可见又含光标，只断言窗口完整可见
                for cx in [ox as f64 - 50.0, ox as f64 + 2000.0] {
                    let r = undock_anchor_rect(
                        (cx, oy as f64 + 500.0),
                        ANCHOR_W,
                        ANCHOR_H,
                        ANCHOR_TB,
                        area,
                    );
                    assert!(r.x >= area.x && r.x + r.w <= area.x + area.w);
                    assert!(r.y >= area.y && r.y + r.h <= area.y + area.h);
                }
            }
        }
    }

    /// 非法标题栏高度（0 / NaN）按 0 处理：不产生 NaN 坐标，钳制语义不变。
    #[test]
    fn anchor_degenerate_titlebar_falls_back() {
        // y = clamp(500, 0, 1032-560) = 472：钳制结果与 titlebar 无关
        let r = undock_anchor_rect((900.0, 500.0), ANCHOR_W, ANCHOR_H, 0.0, AREA);
        assert_eq!(r.y, 472);
        let r = undock_anchor_rect((900.0, 500.0), ANCHOR_W, ANCHOR_H, f64::NAN, AREA);
        assert_eq!(r.y, 472);
        // 光标在窗口中部时 tb=0 → 窗口顶对准光标（钳制区间内）
        let r = undock_anchor_rect((900.0, 400.0), ANCHOR_W, ANCHOR_H, 0.0, AREA);
        assert_eq!(r.y, 400);
    }

    /// 请求/取消/取用生命周期：pending → applied → take 复位。
    #[test]
    fn undock_anchor_request_lifecycle() {
        // 未安装子类化（单元测试环境）时请求被拒绝：前端走自己的回退定位
        assert!(!request_undock_anchor(400.0, 560.0, 41.0));
        cancel_undock_anchor();
        assert!(!take_undock_anchor_applied());
    }
}
