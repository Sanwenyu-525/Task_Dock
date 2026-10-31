//! 窗口外形（v0.6）：Win32 圆角区域 + DWM 角/边框策略。
//!
//! 本应用是 `decorations:false` + `transparent:true` + `shadow:false` 的无边框窗口。
//! 真机验证（docs/ui-themes/12-v06-window-corners.md）确认：
//! - Win11 的 **Mica / SystemBackdrop 由 DWM 按整个窗口矩形绘制，不受 SetWindowRgn
//!   约束**，会在区域圆角之外、窗口矩形之内留下近黑色月牙；因此原生材质与区域裁剪
//!   必须联合验证，不能只靠 CSS 圆角。
//! - DWM 默认的 1px 边框也会沿窗口矩形绘制，浅色背景上表现为灰/黑描边。
//!
//! 这里做四件事：
//! 1. `SetWindowRgn(CreateRoundRectRgn)`：在 GDI 层把窗口裁成圆角，WebView2 内容层
//!    被真正裁掉；边缘无抗锯齿，因此半径与 CSS 保持同一逻辑值。
//! 2. `DWMWA_WINDOW_CORNER_PREFERENCE`：只做系统级圆角偏好（可被实验开关关闭/改为
//!    DONOTROUND），与区域裁剪是两个独立维度，便于矩阵验证。
//! 3. `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE`：去掉 DWM 默认描边（默认可关）。
//! 4. 缓存 + 校验：区域缓存包含 hwnd/物理尺寸/DPI/半径；每次应用都用 GetWindowRgn
//!    读取**实际**区域（无区域、包围盒不符、角点仍为实心都视为失效）后才决定跳过。
//!    缩放重入不再丢弃请求：内层调用只置 PENDING，外层按最新尺寸重新计算。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use tauri::{Runtime, WebviewWindow};

/// 当前圆角半径，存储为「逻辑像素 × 1000」的整数，避免浮点原子。
static RADIUS_MILLI: AtomicU32 = AtomicU32::new(18_000);
/// 正在执行 SetWindowRgn；此期间到达的请求只置 PENDING，由外层合并重算。
/// （全局短临界区串行化：SetWindowRgn 本身廉价，串行只损失并行度不损正确性。）
static APPLYING: AtomicBool = AtomicBool::new(false);
/// 外层执行期间又有新的应用请求（通常是 SetWindowRgn 自己触发的 resize 事件）。
static PENDING: AtomicBool = AtomicBool::new(false);

/// 一次成功应用的区域参数。hwnd/尺寸/DPI/半径任一变化都必须重做。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RegionStamp {
    hwnd: isize,
    width: u32,
    height: u32,
    radius: u32,
    scale_milli: u32,
}

/// 按 **HWND** 管理的区域缓存（v0.6 整改）：主窗与右键菜单弹窗各自维护
/// 圆角参数，交错 resize / 不同半径 / DPI 变化互不污染。
#[derive(Default)]
struct RegionCache {
    stamps: HashMap<isize, RegionStamp>,
    /// 每窗口最近一次 pass 的物理尺寸（仅用于判断稳定性，不参与缓存命中）。
    last_pass_size: HashMap<isize, (i32, i32)>,
}

impl RegionCache {
    fn new() -> Self {
        Self::default()
    }

    /// 该 stamp 是否与上次成功应用一致（只比对同 hwnd 的记录）。
    fn is_current(&self, stamp: &RegionStamp) -> bool {
        self.stamps.get(&stamp.hwnd) == Some(stamp)
    }

    fn update(&mut self, stamp: RegionStamp) {
        self.stamps.insert(stamp.hwnd, stamp);
    }

    fn last_pass_size(&self, hwnd: isize) -> Option<(i32, i32)> {
        self.last_pass_size.get(&hwnd).copied()
    }

    fn set_last_pass_size(&mut self, hwnd: isize, size: (i32, i32)) {
        self.last_pass_size.insert(hwnd, size);
    }

    /// 窗口销毁时清理对应记录，防止句柄复用后误判「已应用」。
    fn forget(&mut self, hwnd: isize) {
        self.stamps.remove(&hwnd);
        self.last_pass_size.remove(&hwnd);
    }
}

static REGIONS: LazyLock<Mutex<RegionCache>> = LazyLock::new(|| Mutex::new(RegionCache::new()));

// ── 分类胶囊几何常量（CSS px）────────────────────────────────
//
// 与前端 `src/lib/capsuleLayout.ts` 是**跨端契约**（两端各有单测锁定同一组
// 数字）：轨道（rail）竖排分类导航 + 右侧功能面板，折叠时窗口只露出轨道，
// 展开时露出「轨道 ∪ 面板」的联合区域。窗口本身在停靠期间**不移动、不缩放**，
// 因此不存在"鼠标跨越胶囊与面板时命中区跟着窗口跑"的抖动来源。

/// 轨道厚度（垂直停靠时为宽，水平停靠时为高）。
pub const CAPSULE_RAIL_THICKNESS_CSS: u32 = 56;
/// 轨道长度（沿边方向）。
pub const CAPSULE_RAIL_LENGTH_CSS: u32 = 300;
/// 功能面板宽。
pub const CAPSULE_PANEL_WIDTH_CSS: u32 = 336;
/// 功能面板高。
pub const CAPSULE_PANEL_HEIGHT_CSS: u32 = 420;
/// 轨道与面板之间的间隙（视觉分隔，区域上不连通）。
pub const CAPSULE_GAP_CSS: u32 = 8;
/// 面板圆角（轨道为全圆角 = 厚度/2）。
pub const CAPSULE_PANEL_RADIUS_CSS: u32 = 22;

/// 胶囊区域参数（Smart Dock Capsule）。
/// 数值与前端 `src/lib/capsuleLayout.ts` 保持一致（跨端契约，两端单测锁定）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapsuleParams {
    /// 停靠边：0=left 1=right 2=top 3=bottom
    pub edge: u8,
    /// 轨道厚度（CSS px）
    pub thickness_css: u32,
    /// 轨道长度（CSS px，沿边方向）
    pub length_css: u32,
    /// true = 展开态（轨道 ∪ 面板）；false = 折叠态（仅轨道）
    pub expanded: bool,
}

/// 胶囊模式按 **hwnd** 绑定：只作用于主窗口，右键菜单弹窗
/// （apply_with_radius）不受影响。None = 正常整窗圆角区域。
struct CapsuleState {
    hwnd: isize,
    params: CapsuleParams,
}

static CAPSULE: LazyLock<Mutex<Option<CapsuleState>>> = LazyLock::new(|| Mutex::new(None));

/// 设置/清除某窗口的胶囊区域模式（调用方负责随后在主线程 apply）。
///
/// v0.7 起**取消**了「窗口大部分可见 → 自动撤销胶囊」的自愈：
/// 新架构中窗口在停靠期间始终完整可见（贴边齐平、不再滑出屏幕），
/// 「大部分可见」是正常状态，旧自愈会把胶囊区域瞬间撤销成整窗矩形。
/// 取而代之的安全网是：区域由前端在停靠/解除/关闭吸附三条路径上显式设置，
/// 且窗口本身始终可见可点击（最坏情况是露出整窗而不是消失在屏外）。
pub fn set_capsule(hwnd: isize, params: Option<CapsuleParams>) {
    let mut cap = CAPSULE.lock().unwrap_or_else(|e| e.into_inner());
    *cap = params.map(|p| CapsuleState { hwnd, params: p });
}

fn capsule_for(hwnd: isize) -> Option<CapsuleParams> {
    let cap = CAPSULE.lock().unwrap_or_else(|e| e.into_inner());
    match *cap {
        Some(ref s) if s.hwnd == hwnd => Some(s.params),
        _ => None,
    }
}

/// 窗口销毁时调用：清理该 hwnd 的区域缓存（防句柄复用误判）。
pub fn forget_window(hwnd: isize) {
    REGIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .forget(hwnd);
}

/// 诊断开关（环境变量，真机矩阵验收用）：
/// - `TASK_DOCK_WINDOW_REGION=0`：不设置 Win32 区域
/// - `TASK_DOCK_WINDOW_DWM_CORNER=0`：不设置 DWM 角偏好（保持系统默认）
/// - `TASK_DOCK_WINDOW_DWM_CORNER=dontround`：显式 DONOTROUND（区域自己裁圆角时用）
/// - `TASK_DOCK_WINDOW_DWM_BORDER=0`：保留 DWM 默认 1px 边框
fn flag(name: &str) -> bool {
    std::env::var(name).map(|v| v != "0").unwrap_or(true)
}

/// 设置逻辑半径（0 = 直角），返回夹取后的实际值。
pub fn set_radius(radius: f64) -> f64 {
    let clamped = if radius.is_finite() {
        radius.clamp(0.0, 40.0)
    } else {
        18.0
    };
    RADIUS_MILLI.store((clamped * 1000.0).round() as u32, Ordering::Relaxed);
    clamped
}

pub fn radius() -> f64 {
    RADIUS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0
}

/// 按当前半径把窗口裁剪为圆角矩形。返回是否真正应用成功。
#[cfg(windows)]
pub fn apply<R: Runtime>(win: &WebviewWindow<R>) -> bool {
    apply_with_radius(win, radius())
}

/// 用**指定**逻辑半径裁剪窗口（独立弹窗使用自己的 CSS 圆角，
/// 不读取/不污染主窗口的全局半径状态）。返回是否真正应用成功。
#[cfg(windows)]
pub fn apply_with_radius<R: Runtime>(win: &WebviewWindow<R>, logical_radius: f64) -> bool {
    let Ok(handle) = win.hwnd() else {
        return false;
    };
    let hwnd = handle.0 as isize;

    if APPLYING.swap(true, Ordering::SeqCst) {
        // 重入：不能直接丢弃，否则拖拽缩放的最后一次尺寸可能永远得不到圆角。
        PENDING.store(true, Ordering::SeqCst);
        return false;
    }

    let mut applied = false;
    // 一次拖动会产生连续尺寸。每次 pass 后重新读取实际尺寸；尺寸变了或期间有新
    // 请求就再来一次，直到窗口稳定（上限防止异常环境下死循环）。
    for _ in 0..8 {
        PENDING.store(false, Ordering::SeqCst);
        applied |= apply_pass(win, hwnd, logical_radius);
        let stable = match win.outer_size() {
            Ok(size) => {
                REGIONS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .last_pass_size(hwnd)
                    == Some((size.width as i32, size.height as i32))
            }
            Err(_) => false,
        };
        if stable && !PENDING.load(Ordering::SeqCst) {
            break;
        }
    }

    APPLYING.store(false, Ordering::SeqCst);

    // 在「检查 PENDING」与「清除 APPLYING」之间仍可能到达一个请求；补一次异步应用。
    if PENDING.swap(false, Ordering::SeqCst) {
        let w = win.clone();
        let _ = w.clone().run_on_main_thread(move || {
            let _ = apply(&w);
        });
    }
    applied
}

// 最近一次 pass 实际使用的窗口尺寸：已并入 RegionCache（按 hwnd 隔离）。

#[cfg(windows)]
fn apply_pass<R: Runtime>(win: &WebviewWindow<R>, hwnd: isize, logical_radius: f64) -> bool {
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

    // 每次都重新读取几何：外层 pass 开始后窗口可能又被拖动了。
    let size = match win.outer_size() {
        Ok(s) if s.width > 0 && s.height > 0 => s,
        _ => return false,
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let w = size.width as i32;
    let h = size.height as i32;
    let r = (logical_radius.clamp(0.0, 40.0) * scale).round() as i32;
    let scale_milli = (scale * 1000.0).round() as u32;
    REGIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set_last_pass_size(hwnd, (w, h));

    if !flag("TASK_DOCK_WINDOW_REGION") {
        // 诊断模式：不设置区域，同时丢弃该窗口缓存，避免下次开启时误判为已应用。
        REGIONS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(hwnd);
        apply_dwm(hwnd, r > 0);
        return false;
    }

    // ── 分类胶囊模式：只露出轨道（折叠）或「轨道 ∪ 面板」（展开）──
    // 区域外的内容不被绘制、也不接收鼠标命中（Win32 SetWindowRgn 语义）。
    // 窗口位置/尺寸在停靠期间保持不变，区域切换是唯一的视觉状态变化。
    if let Some(cap) = capsule_for(hwnd) {
        return apply_capsule_pass(hwnd, w, h, scale, cap);
    }

    let stamp = RegionStamp {
        hwnd,
        width: size.width,
        height: size.height,
        radius: r as u32,
        scale_milli,
    };
    let current = {
        let cache = REGIONS.lock().unwrap_or_else(|e| e.into_inner());
        cache.is_current(&stamp)
    } && region_is_current(hwnd, w, h, r);

    let mut ok = current;
    if !current {
        ok = unsafe {
            // CreateRoundRectRgn 的右/下边界是开区间，+1 才能覆盖最后一行像素。
            let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, (r * 2).max(1), (r * 2).max(1));
            if rgn.is_null() {
                false
            } else if SetWindowRgn(hwnd as _, rgn, 1) == 0 {
                // 失败时区域未被系统接管，仍归调用方，必须释放。
                DeleteObject(rgn as _);
                false
            } else {
                // 成功后区域所有权移交系统，不能再 DeleteObject。
                true
            }
        };
        if ok {
            REGIONS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .update(stamp);
        }
    }

    apply_dwm(hwnd, r > 0);
    ok
}

/// 胶囊区域矩形（**显式宽高**，杜绝依赖变量名推断方向）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CapsuleRegionRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub radius: i32,
}

impl CapsuleRegionRect {
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.width && py >= self.y && py < self.y + self.height
    }
    fn center(&self) -> (i32, i32) {
        (self.x + self.width / 2, self.y + self.height / 2)
    }
}

/// 胶囊区域集合：折叠态只有轨道；展开态 = 轨道 ∪ 面板（两块圆角矩形，
/// 中间由 `gap` 分隔，**不连通**——间隙既不属于区域也不拦截鼠标）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CapsuleRegionSet {
    pub rail: CapsuleRegionRect,
    pub panel: Option<CapsuleRegionRect>,
    /// 间隙中点：必须落在区域之外（回读验证用）。
    pub gap_probe: Option<(i32, i32)>,
}

impl CapsuleRegionSet {
    /// 联合区域包围盒（x, y, right, bottom）。
    pub fn bounds(&self) -> (i32, i32, i32, i32) {
        let (mut left, mut top) = (self.rail.x, self.rail.y);
        let (mut right, mut bottom) = (self.rail.x + self.rail.width, self.rail.y + self.rail.height);
        if let Some(p) = self.panel {
            left = left.min(p.x);
            top = top.min(p.y);
            right = right.max(p.x + p.width);
            bottom = bottom.max(p.y + p.height);
        }
        (left, top, right, bottom)
    }
}

/// 胶囊区域几何（纯函数，跨平台可测）。
///
/// 尺寸约定（与前端 CSS 对齐）：
/// - Left / Right：**纵向**轨道，width = 厚度、height = 长度；轨道贴停靠边；
/// - Top / Bottom：**横向**轨道，width = 长度、height = 厚度；
/// - 面板始终在轨道**内侧**（朝屏幕内部），与轨道同轴居中、间隔 `gap`。
///
/// 物理像素按 DPI 换算。窗口尺寸不足以容纳面板时**放弃面板**（只保留轨道），
/// 绝不产生负尺寸或越界区域——前端会先把窗口撑到容器尺寸，这里是退化兜底。
pub(crate) fn capsule_regions(
    window_w: i32,
    window_h: i32,
    scale: f64,
    cap: &CapsuleParams,
) -> Option<CapsuleRegionSet> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    if window_w <= 0 || window_h <= 0 {
        return None;
    }
    let thickness = ((cap.thickness_css as f64) * scale).round() as i32;
    let length = ((cap.length_css as f64) * scale).round() as i32;
    let panel_w = ((CAPSULE_PANEL_WIDTH_CSS as f64) * scale).round() as i32;
    let panel_h = ((CAPSULE_PANEL_HEIGHT_CSS as f64) * scale).round() as i32;
    let gap = ((CAPSULE_GAP_CSS as f64) * scale).round().max(1.0) as i32;
    let panel_radius = ((CAPSULE_PANEL_RADIUS_CSS as f64) * scale).round() as i32;
    if thickness <= 0 || length <= 0 {
        return None; // 退化防护：胶囊至少 1px
    }
    // 方向：0/1=left/right（纵） 2/3=top/bottom（横）
    let vertical = cap.edge <= 1;
    let (width, height) = if vertical {
        (thickness.min(window_w), length.min(window_h))
    } else {
        (length.min(window_w), thickness.min(window_h))
    };
    if width <= 0 || height <= 0 {
        return None;
    }
    let radius = (width.min(height) / 2).max(1);
    // 轨道贴停靠边（与旧实现相反：旧实现窗口滑出屏幕，露出的是对侧窄条；
    // 新实现窗口齐平贴边、不再移动，轨道就在窗口的停靠侧）
    let (x, y) = match cap.edge {
        0 => (0, (window_h - height) / 2),                // left  → 窗口左缘竖条
        1 => (window_w - width, (window_h - height) / 2), // right → 窗口右缘竖条
        2 => ((window_w - width) / 2, 0),                 // top   → 窗口上缘横条
        _ => ((window_w - width) / 2, window_h - height), // bottom→ 窗口下缘横条
    };
    let rail = CapsuleRegionRect {
        x: x.clamp(0, window_w - width),
        y: y.clamp(0, window_h - height),
        width,
        height,
        radius,
    };
    if !cap.expanded {
        return Some(CapsuleRegionSet {
            rail,
            panel: None,
            gap_probe: None,
        });
    }
    let (pw, ph) = (panel_w.min(window_w), panel_h.min(window_h));
    if pw <= 0 || ph <= 0 {
        return Some(CapsuleRegionSet {
            rail,
            panel: None,
            gap_probe: None,
        });
    }
    let (px, py) = match cap.edge {
        0 => (rail.x + rail.width + gap, (window_h - ph) / 2),
        1 => (rail.x - gap - pw, (window_h - ph) / 2),
        2 => ((window_w - pw) / 2, rail.y + rail.height + gap),
        _ => ((window_w - pw) / 2, rail.y - gap - ph),
    };
    // 越界即放弃面板：宁可只显示轨道，也不让区域跑到窗口外/压住轨道
    if px < 0 || py < 0 || px + pw > window_w || py + ph > window_h {
        tracing::warn!(
            "胶囊面板区域越界，退化为仅轨道（w={window_w} h={window_h} edge={} px={px} py={py} pw={pw} ph={ph}）",
            cap.edge
        );
        return Some(CapsuleRegionSet {
            rail,
            panel: None,
            gap_probe: None,
        });
    }
    let panel = CapsuleRegionRect {
        x: px,
        y: py,
        width: pw,
        height: ph,
        radius: panel_radius.max(1),
    };
    let gap_probe = match cap.edge {
        0 => Some((rail.x + rail.width + gap / 2, rail.center().1)),
        1 => Some((panel.x + panel.width + gap / 2, rail.center().1)),
        2 => Some((rail.center().0, rail.y + rail.height + gap / 2)),
        _ => Some((rail.center().0, panel.y + panel.height + gap / 2)),
    };
    Some(CapsuleRegionSet {
        rail,
        panel: Some(panel),
        gap_probe,
    })
}

/// 应用胶囊区域：折叠 = 轨道圆角矩形；展开 = 轨道 ∪ 面板（CombineRgn OR）。
/// 区域外不绘制、不接收鼠标；DPI/尺寸变化由外层 apply 重算。
/// 成功后用 GetWindowRgn **回读验证**：包围盒一致 + 轨道/面板中心在区域内 +
/// 间隙中点在区域外——SetWindowRgn 返回成功不代表区域内容正确。
#[cfg(windows)]
fn apply_capsule_pass(hwnd: isize, w: i32, h: i32, scale: f64, cap: CapsuleParams) -> bool {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_ERROR, RGN_OR,
    };

    let Some(set) = capsule_regions(w, h, scale, &cap) else {
        tracing::warn!(
            "胶囊区域几何退化（w={w} h={h} scale={scale} edge={}）",
            cap.edge
        );
        return false;
    };
    let round = |r: &CapsuleRegionRect| unsafe {
        // 右/下边界开区间，+1 覆盖最后一行像素（与整窗区域口径一致）
        CreateRoundRectRgn(
            r.x,
            r.y,
            r.x + r.width + 1,
            r.y + r.height + 1,
            r.radius * 2,
            r.radius * 2,
        )
    };
    let applied = unsafe {
        let rgn = round(&set.rail);
        if rgn.is_null() {
            false
        } else {
            let mut ok = true;
            if let Some(p) = set.panel {
                let pr = round(&p);
                if pr.is_null() || CombineRgn(rgn, rgn, pr, RGN_OR) == RGN_ERROR {
                    ok = false;
                }
                if !pr.is_null() {
                    DeleteObject(pr as _);
                }
            }
            if !ok {
                DeleteObject(rgn as _);
                false
            } else if SetWindowRgn(hwnd as _, rgn, 1) == 0 {
                // 失败时区域未被系统接管，仍归调用方，必须释放。
                DeleteObject(rgn as _);
                false
            } else {
                true
            }
        }
    };
    let verified = applied && capsule_region_matches(hwnd, &set);
    tracing::debug!(
        hwnd,
        edge = cap.edge,
        expanded = cap.expanded,
        rail_x = set.rail.x,
        rail_y = set.rail.y,
        rail_w = set.rail.width,
        rail_h = set.rail.height,
        panel = set.panel.is_some(),
        applied,
        verified,
        "胶囊区域应用"
    );
    apply_dwm(hwnd, true);
    verified
}

/// 回读验证胶囊区域：包围盒 + 关键点包含关系（±1px 容差）。
#[cfg(windows)]
fn capsule_region_matches(hwnd: isize, expect: &CapsuleRegionSet) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateRectRgn, DeleteObject, GetRgnBox, GetWindowRgn, PtInRegion,
    };

    let (left, top, right, bottom) = expect.bounds();
    unsafe {
        let rgn = CreateRectRgn(0, 0, 0, 0);
        if rgn.is_null() {
            return false;
        }
        let kind = GetWindowRgn(hwnd as _, rgn);
        let ok = kind != 0 && {
            let mut bounds = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let box_kind = GetRgnBox(rgn, &mut bounds);
            let bbox_ok = box_kind != 0
                && (bounds.left - left).abs() <= 1
                && (bounds.top - top).abs() <= 1
                && (bounds.right - (right + 1)).abs() <= 1
                && (bounds.bottom - (bottom + 1)).abs() <= 1;
            let (rx, ry) = expect.rail.center();
            let mut points_ok = PtInRegion(rgn, rx, ry) != 0;
            if let Some(p) = expect.panel {
                let (px, py) = p.center();
                points_ok &= PtInRegion(rgn, px, py) != 0;
            }
            if let Some((gx, gy)) = expect.gap_probe {
                points_ok &= PtInRegion(rgn, gx, gy) == 0;
            }
            bbox_ok && points_ok
        };
        DeleteObject(rgn as _);
        ok
    }
}

/// 读取窗口的**实际**区域并与期望几何比对。系统重置区域、窗口缩放后缓存未更新、
/// 或区域被替换成直角矩形时都会返回 false。
#[cfg(windows)]
fn region_is_current(hwnd: isize, w: i32, h: i32, r: i32) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateRectRgn, DeleteObject, GetRgnBox, GetWindowRgn, PtInRegion,
    };

    unsafe {
        let rgn = CreateRectRgn(0, 0, 0, 0);
        if rgn.is_null() {
            return false;
        }
        let kind = GetWindowRgn(hwnd as _, rgn);
        if kind == 0 {
            // 0 = ERROR：窗口当前没有区域
            DeleteObject(rgn as _);
            return false;
        }
        let mut bounds = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let box_kind = GetRgnBox(rgn, &mut bounds);
        // CreateRoundRectRgn(0,0,w+1,h+1) 的包围盒右/下为 w+1/h+1；
        // 留 1px 容差，既能识别旧尺寸，也不会因 API 的边界口径误判。
        let bounds_ok = box_kind != 0
            && bounds.left >= -1
            && bounds.top >= -1
            && (bounds.right - (w + 1)).abs() <= 1
            && (bounds.bottom - (h + 1)).abs() <= 1;
        // 区域被重置成直角矩形时 (1,1) 会在区域内；圆角区域必然裁掉它。
        let radius_ok = r <= 1 || (PtInRegion(rgn, 1, 1) == 0 && PtInRegion(rgn, r, r) != 0);
        DeleteObject(rgn as _);
        bounds_ok && radius_ok
    }
}

#[cfg(windows)]
fn dwm_get_i32(hwnd: isize, attr: u32) -> Option<i32> {
    use windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute;

    let mut value = 0i32;
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd as _,
            attr,
            &mut value as *mut i32 as *mut std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
    };
    (hr == 0).then_some(value)
}

#[cfg(windows)]
fn apply_dwm(hwnd: isize, rounded: bool) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWCP_DONOTROUND: i32 = 1;
    const DWMWCP_ROUND: i32 = 2;
    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

    let mode = std::env::var("TASK_DOCK_WINDOW_DWM_CORNER").unwrap_or_default();
    let border_none = flag("TASK_DOCK_WINDOW_DWM_BORDER");

    if mode != "0" {
        let want: i32 = if mode == "dontround" || !rounded {
            DWMWCP_DONOTROUND
        } else {
            DWMWCP_ROUND
        };
        if dwm_get_i32(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE) != Some(want) {
            unsafe {
                DwmSetWindowAttribute(
                    hwnd as _,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &want as *const i32 as *const std::ffi::c_void,
                    std::mem::size_of::<i32>() as u32,
                );
            }
        }
    }

    if border_none && dwm_get_i32(hwnd, DWMWA_BORDER_COLOR) != Some(DWMWA_COLOR_NONE as i32) {
        unsafe {
            DwmSetWindowAttribute(
                hwnd as _,
                DWMWA_BORDER_COLOR,
                &DWMWA_COLOR_NONE as *const u32 as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

/// 监听窗口销毁：清理该 hwnd 的区域缓存（主窗与弹窗共用，防句柄复用误判）。
pub fn watch_destroy<R: Runtime>(win: &WebviewWindow<R>) {
    let hwnd = win.hwnd().map(|h| h.0 as isize).ok();
    let w = win.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(hwnd) = hwnd {
                forget_window(hwnd);
            } else if let Ok(h) = w.hwnd() {
                forget_window(h.0 as isize);
            }
        }
    });
}

/// 启动后按延迟重算几次区域：窗口在启动阶段会经历「按模式尺寸 → 按记忆矩形 →
/// 前端布局稳定」多次变化，延迟重算能保证区域最终与窗口尺寸一致。
pub fn schedule_reapply<R: Runtime>(win: &WebviewWindow<R>) {
    let w = win.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [150u64, 500, 1200, 2500] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let _ = apply_on_main_thread(&w);
        }
    });
}

#[cfg(not(windows))]
pub fn apply<R: Runtime>(_win: &WebviewWindow<R>) -> bool {
    false
}

/// 非 Windows 平台的指定半径版本（与 apply 一样直接成功/忽略）。
#[cfg(not(windows))]
pub fn apply_with_radius<R: Runtime>(win: &WebviewWindow<R>, _logical_radius: f64) -> bool {
    apply(win)
}

/// 在主线程上应用窗口外形（Win32 窗口操作必须走主线程），带超时保护。
pub fn apply_on_main_thread<R: Runtime>(win: &WebviewWindow<R>) -> bool {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let w = win.clone();
    if win
        .run_on_main_thread(move || {
            let _ = tx.send(apply(&w));
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radius_is_clamped_and_persisted() {
        assert_eq!(set_radius(20.0), 20.0);
        assert_eq!(radius(), 20.0);
        // 越界与非法值都必须收敛到安全范围，不能写坏全局状态
        assert_eq!(set_radius(999.0), 40.0);
        assert_eq!(radius(), 40.0);
        assert_eq!(set_radius(-5.0), 0.0);
        assert_eq!(radius(), 0.0);
        assert_eq!(set_radius(f64::NAN), 18.0);
        assert_eq!(radius(), 18.0);
    }

    #[test]
    fn region_stamp_invalidates_on_every_identity_field() {
        let base = RegionStamp {
            hwnd: 1,
            width: 500,
            height: 700,
            radius: 23,
            scale_milli: 1250,
        };
        assert_ne!(base, RegionStamp { hwnd: 2, ..base });
        assert_ne!(base, RegionStamp { width: 501, ..base });
        assert_ne!(
            base,
            RegionStamp {
                height: 701,
                ..base
            }
        );
        assert_ne!(base, RegionStamp { radius: 24, ..base });
        assert_ne!(
            base,
            RegionStamp {
                scale_milli: 1000,
                ..base
            }
        );
    }

    fn stamp(hwnd: isize, w: u32, h: u32, r: u32, scale_milli: u32) -> RegionStamp {
        RegionStamp {
            hwnd,
            width: w,
            height: h,
            radius: r,
            scale_milli,
        }
    }

    /// 回归：主窗与菜单弹窗交错应用区域时，缓存必须按 hwnd 各自命中，
    /// 一方的更新不得污染另一方的「已应用」判定（旧实现是单槽全局缓存）。
    #[test]
    fn region_cache_keeps_windows_independent_under_interleaving() {
        let mut cache = RegionCache::new();
        let main = stamp(100, 500, 700, 23, 1250);
        let menu = stamp(200, 313, 775, 20, 1250);

        cache.update(main);
        cache.update(menu);
        // 交错命中：两个窗口各自都算「已应用」
        assert!(cache.is_current(&main));
        assert!(cache.is_current(&menu));

        // 主窗 resize → 只有主窗失效，菜单缓存不受影响
        let main_resized = stamp(100, 620, 820, 23, 1250);
        assert!(!cache.is_current(&main_resized));
        assert!(cache.is_current(&menu));
        cache.update(main_resized);
        assert!(cache.is_current(&main_resized));
        // 旧尺寸不再命中
        assert!(!cache.is_current(&main));

        // 菜单用自己的半径（16px@1.25=20）更新，主窗仍保持原判定
        let menu_reapplied = stamp(200, 313, 649, 20, 1250);
        assert!(!cache.is_current(&menu_reapplied));
        cache.update(menu_reapplied);
        assert!(cache.is_current(&menu_reapplied));
        assert!(cache.is_current(&main_resized));
    }

    /// 回归：DPI 变化（scale_milli 改变）必须让该窗口失效，且只影响该窗口。
    #[test]
    fn region_cache_invalidates_on_dpi_change_per_window() {
        let mut cache = RegionCache::new();
        let main_125 = stamp(100, 500, 700, 23, 1250);
        let menu_125 = stamp(200, 313, 775, 20, 1250);
        cache.update(main_125);
        cache.update(menu_125);

        // 显示器 DPI 变化（如拖到 100% 屏）：两窗几何都要按新缩放重算
        let main_100 = stamp(100, 400, 560, 18, 1000);
        let menu_100 = stamp(200, 250, 519, 16, 1000);
        assert!(!cache.is_current(&main_100));
        assert!(!cache.is_current(&menu_100));
        cache.update(main_100);
        cache.update(menu_100);
        assert!(cache.is_current(&main_100));
        assert!(cache.is_current(&menu_100));
        assert!(!cache.is_current(&main_125));
        assert!(!cache.is_current(&menu_125));
    }

    /// 回归：窗口销毁清理缓存；句柄复用后旧 stamp 不得再命中。
    #[test]
    fn region_cache_forget_clears_only_that_window() {
        let mut cache = RegionCache::new();
        let main = stamp(100, 500, 700, 23, 1250);
        let menu = stamp(200, 313, 775, 20, 1250);
        cache.update(main);
        cache.update(menu);
        cache.set_last_pass_size(100, (500, 700));
        cache.set_last_pass_size(200, (313, 775));

        // 菜单销毁
        cache.forget(200);
        assert_eq!(cache.last_pass_size(200), None);
        assert!(!cache.is_current(&menu));
        // 主窗不受影响
        assert!(cache.is_current(&main));
        assert_eq!(cache.last_pass_size(100), Some((500, 700)));

        // 句柄复用：新窗口拿到同一 hwnd，但旧 stamp 不能再命中
        assert!(!cache.is_current(&menu));
    }

    #[test]
    fn region_cache_last_pass_size_tracks_stability_per_window() {
        let mut cache = RegionCache::new();
        cache.set_last_pass_size(100, (500, 700));
        cache.set_last_pass_size(200, (313, 775));
        // 交错 resize：每个窗口比较自己的上一 pass 尺寸
        assert_eq!(cache.last_pass_size(100), Some((500, 700)));
        assert_eq!(cache.last_pass_size(200), Some((313, 775)));
        cache.set_last_pass_size(100, (620, 820));
        assert_eq!(cache.last_pass_size(100), Some((620, 820)));
        cache.set_last_pass_size(200, (313, 775));
        assert_eq!(cache.last_pass_size(200), Some((313, 775)));
    }

    // ── 分类胶囊区域几何 ──────────────────────────────────────

    const CAP: CapsuleParams = CapsuleParams {
        edge: 0,
        thickness_css: 56,
        length_css: 300,
        expanded: false,
    };
    /// 胶囊容器（前端在停靠时把窗口撑到该尺寸）：垂直停靠 400×420。
    const CONTAINER_W: i32 = 400;
    const CONTAINER_H: i32 = 420;

    #[test]
    fn capsule_contract_matches_frontend_constants() {
        // 跨端契约：与 src/lib/capsuleLayout.ts 同一组数字（两端各有单测）
        assert_eq!(CAP.thickness_css, 56);
        assert_eq!(CAP.length_css, 300);
        assert_eq!(CAPSULE_PANEL_WIDTH_CSS, 336);
        assert_eq!(CAPSULE_PANEL_HEIGHT_CSS, 420);
        assert_eq!(CAPSULE_GAP_CSS, 8);
    }

    #[test]
    fn capsule_rail_is_flush_to_dock_side_and_centered() {
        // 100%：left → 轨道贴窗口左缘、垂直居中、56×300、全圆角 28
        let s = capsule_regions(CONTAINER_W, CONTAINER_H, 1.0, &CAP).unwrap();
        assert_eq!(
            (s.rail.x, s.rail.y, s.rail.width, s.rail.height),
            (0, (420 - 300) / 2, 56, 300)
        );
        assert_eq!(s.rail.radius, 28);
        assert!(s.panel.is_none(), "折叠态不得包含面板区域");
        assert_eq!(s.bounds(), (0, 60, 56, 360));

        // right → 贴窗口右缘
        let s = capsule_regions(400, 420, 1.0, &CapsuleParams { edge: 1, ..CAP }).unwrap();
        assert_eq!((s.rail.x, s.rail.y), (400 - 56, 60));
        // top → 贴窗口上缘的横向轨道 300×56
        let s = capsule_regions(400, 484, 1.0, &CapsuleParams { edge: 2, ..CAP }).unwrap();
        assert_eq!((s.rail.x, s.rail.y, s.rail.width, s.rail.height), (50, 0, 300, 56));
        // bottom → 贴窗口下缘
        let s = capsule_regions(400, 484, 1.0, &CapsuleParams { edge: 3, ..CAP }).unwrap();
        assert_eq!((s.rail.x, s.rail.y, s.rail.width, s.rail.height), (50, 484 - 56, 300, 56));
    }

    #[test]
    fn capsule_expanded_region_is_rail_or_panel_with_gap() {
        // left 展开：面板在轨道内侧（右），同轴居中，间隙 8px
        let s = capsule_regions(CONTAINER_W, CONTAINER_H, 1.0, &CapsuleParams { expanded: true, ..CAP })
            .unwrap();
        let p = s.panel.expect("展开态必须有面板区域");
        assert_eq!((p.x, p.y, p.width, p.height), (56 + 8, 0, 336, 420));
        assert_eq!(p.radius, 22);
        // 联合包围盒 = 整块容器
        assert_eq!(s.bounds(), (0, 0, 400, 420));
        // 间隙中点必须落在区域之外（两块矩形不连通）
        let (gx, gy) = s.gap_probe.expect("展开态应有间隙探针");
        assert!(!s.rail.contains(gx, gy));
        assert!(!p.contains(gx, gy));

        // right 展开：面板在轨道左侧，同样不越界
        let s = capsule_regions(400, 420, 1.0, &CapsuleParams { edge: 1, expanded: true, ..CAP })
            .unwrap();
        let p = s.panel.unwrap();
        assert_eq!((p.x, p.width), (0, 336));
        assert_eq!(s.rail.x, 400 - 56);

        // top 展开：面板在轨道下方
        let s = capsule_regions(400, 484, 1.0, &CapsuleParams { edge: 2, expanded: true, ..CAP })
            .unwrap();
        let p = s.panel.unwrap();
        assert_eq!((p.x, p.y, p.width, p.height), (32, 56 + 8, 336, 420));

        // bottom 展开：面板在轨道上方
        let s = capsule_regions(400, 484, 1.0, &CapsuleParams { edge: 3, expanded: true, ..CAP })
            .unwrap();
        let p = s.panel.unwrap();
        assert_eq!((p.x, p.y), (32, 484 - 56 - 8 - 420));
    }

    #[test]
    fn capsule_region_scales_with_dpi() {
        for (scale, t, l) in [(1.0f64, 56i32, 300i32), (1.25, 70, 375), (1.5, 84, 450)] {
            let s = capsule_regions(2000, 2000, scale, &CAP).unwrap();
            assert_eq!((s.rail.width, s.rail.height), (t, l));
            assert_eq!(s.rail.radius, t / 2);
        }
    }

    #[test]
    fn capsule_region_rejects_degenerate_and_drops_overflow_panel() {
        assert!(capsule_regions(400, 420, 1.0, &CapsuleParams { thickness_css: 0, ..CAP }).is_none());
        assert!(capsule_regions(0, 420, 1.0, &CAP).is_none());
        assert!(capsule_regions(400, -5, 1.0, &CAP).is_none());
        assert!(capsule_regions(400, 420, 0.0, &CAP).is_some(), "非法 DPI 回退 1");

        // 窗口太窄放不下面板：只保留轨道，绝不产生越界区域
        let s = capsule_regions(120, 420, 1.0, &CapsuleParams { expanded: true, ..CAP }).unwrap();
        assert!(s.panel.is_none());
        assert!(s.rail.x + s.rail.width <= 120);
        // 窗口太矮：轨道长度钳制到窗口高
        let s = capsule_regions(400, 90, 1.0, &CAP).unwrap();
        assert_eq!((s.rail.y, s.rail.height), (0, 90));
    }

    #[test]
    fn capsule_mode_is_hwnd_scoped() {
        set_capsule(100, Some(CAP));
        assert_eq!(capsule_for(100), Some(CAP));
        assert_eq!(capsule_for(200), None, "右键菜单弹窗不得继承主窗胶囊模式");
        set_capsule(100, None);
        assert_eq!(capsule_for(100), None);
    }

    /// **真实 Win32 窗口**上的区域应用与回读验证（无头、不可见窗口，不影响桌面）：
    /// 验证 SetWindowRgn → GetWindowRgn 的真实行为链，四边矩形与回读一致。
    /// 这是纯单元测试无法覆盖的 OS 层证据（真机 GUI 验收的补充，不替代）。
    #[cfg(windows)]
    #[test]
    fn capsule_region_applies_and_verifies_on_real_win32_window() {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, WNDCLASSW, WS_POPUP,
        };

        // 注册极简窗口类（系统默认背景，不可见：不传 WS_VISIBLE）
        const CLASS_NAME: &[u16] = &[b'T' as u16, b'D' as u16, b'_' as u16, b'T' as u16, 0];
        unsafe {
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
                    lpszClassName: CLASS_NAME.as_ptr(),
                };
                RegisterClassW(&wc);
            });

            let hwnd = CreateWindowExW(
                0,
                CLASS_NAME.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                -2000,
                -2000,
                400,
                484,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "CreateWindowExW 失败");

            // 真实 Win32 窗口上逐边应用「折叠 / 展开」区域并回读验证：
            // 折叠 = 单块圆角矩形；展开 = 轨道 ∪ 面板（CombineRgn OR），
            // 包围盒、两块中心与间隙中点都必须与几何一致。
            let apply_region = |edge: u8, expanded: bool| -> CapsuleRegionSet {
                // 容器取 400×484（水平停靠所需高度），四边都能放下轨道与面板
                let cap = CapsuleParams { edge, expanded, ..CAP };
                let set = capsule_regions(400, 484, 1.0, &cap).unwrap();
                let rgn = CreateRoundRectRgn(
                    set.rail.x,
                    set.rail.y,
                    set.rail.x + set.rail.width + 1,
                    set.rail.y + set.rail.height + 1,
                    set.rail.radius * 2,
                    set.rail.radius * 2,
                );
                assert!(!rgn.is_null());
                if let Some(p) = set.panel {
                    let pr = CreateRoundRectRgn(
                        p.x,
                        p.y,
                        p.x + p.width + 1,
                        p.y + p.height + 1,
                        p.radius * 2,
                        p.radius * 2,
                    );
                    assert!(!pr.is_null());
                    assert_ne!(
                        windows_sys::Win32::Graphics::Gdi::CombineRgn(
                            rgn,
                            rgn,
                            pr,
                            windows_sys::Win32::Graphics::Gdi::RGN_OR
                        ),
                        windows_sys::Win32::Graphics::Gdi::RGN_ERROR
                    );
                    DeleteObject(pr as _);
                }
                assert_ne!(SetWindowRgn(hwnd as _, rgn, 1), 0);
                assert!(
                    capsule_region_matches(hwnd as isize, &set),
                    "edge={edge} expanded={expanded} 回读验证失败"
                );
                set
            };

            // 四边折叠：只有轨道，尺寸随方向变化
            let left = apply_region(0, false);
            assert_eq!((left.rail.width, left.rail.height), (56, 300));
            assert!(left.panel.is_none());
            let top = apply_region(2, false);
            assert_eq!((top.rail.width, top.rail.height), (300, 56), "顶边必须横向 300×56");

            // 四边展开：轨道 + 面板联合区域，间隙处不连通
            for edge in [0u8, 1, 2, 3] {
                let set = apply_region(edge, true);
                assert!(set.panel.is_some(), "edge={edge} 展开必须有面板");
                let (gx, gy) = set.gap_probe.unwrap();
                assert!(gx >= 0 && gy >= 0);
            }

            // 清理：恢复无区域并销毁窗口
            let full = CreateRoundRectRgn(0, 0, 401, 485, 36, 36);
            SetWindowRgn(hwnd as _, full, 1);
            DeleteObject(full as _);
            DestroyWindow(hwnd as HWND);
        }
    }
}
