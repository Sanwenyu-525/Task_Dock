//! 窗口外形（2026-11-01 二轮整改）：主窗**原生圆角区域 + CSS 抗锯齿边缘**，
//! 胶囊与弹窗沿用各自独立的 Win32 区域。
//!
//! 本应用是 `decorations:false` + `transparent:true` + `shadow:false` 的无边框窗口。
//! 真机证据（`tmp/acceptance/window-corner-unification/`，含非激活态灰底截图）确认：
//! - **整窗矩形区域**（`CreateRectRgn`）+ DWM `DONOTROUND` 时，窗口非激活后
//!   WebView2 会在窗口矩形内回填不透明底色（实测纯白 255,255,255）：CSS 渐变仍是
//!   圆角，但四角露出**矩形白色/浅灰三角**。在纯白/纯黑桌面上几乎不可见，在灰底与
//!   浅灰底上明显；这是「CSS 圆角 + 直角原生窗口」的伪修复，不能接受。
//! - DWM 原生圆角半径固定为 8 DIP（`DWMWCP_ROUND`），无法配置成设计要求的
//!   18/20 CSS px；`DWMWCP_ROUNDSMALL` 更小，因此不能直接改用 DWM 圆角。
//! - `SetWindowRgn` 的区域是二值裁剪，无法抗锯齿；主窗因此**逐行构造 CSS 圆角的
//!   像素支撑形状**（`css_support_left()` + 行矩形并集）：覆盖所有被 CSS 触及的
//!   像素（含极低 alpha 的抗锯齿外沿），但排除完全透明像素。这样既保留 CSS 平滑
//!   弧线，又不会让非激活态的白色回填从透明像素露出，也不产生多余命中。
//!
//! 因此主窗（完整主界面）的外形策略是：
//! 1. 主窗设置**圆角** `SetWindowRgn`（逐行像素支撑形状），让原生窗口形状本身
//!    是圆角，且与 CSS 可见像素一一对应；
//! 2. DWM 角偏好设为 `DONOTROUND`（否则 8 DIP 系统弧会在自定义大圆角内再切一刀），
//!    并继续尝试 `DWMWA_BORDER_COLOR = NONE`（该属性在部分 23H2 机器上不可读/不可设，
//!    因此不依赖它；圆角区域会把矩形边框的角落裁掉）；
//! 3. CSS `border-radius` 只负责边缘抗锯齿，不再承担「遮盖直角」的职责。
//!
//! 胶囊模式（轨道 / 面板）仍按独立几何裁剪：窗口矩形只露轨道或「轨道 ∪ 面板」，
//! 区域外的内容不绘制、也不接收鼠标；其几何与主窗独立。弹窗（右键菜单）继续用
//! 自己的圆角区域与半径。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use tauri::{Runtime, WebviewWindow};

/// 当前圆角半径，存储为「逻辑像素 × 1000」的整数，避免浮点原子。
static RADIUS_MILLI: AtomicU32 = AtomicU32::new(18_000);

/// 胶囊/弹窗区域半径相对 CSS 物理半径的固定「抗锯齿内收」（物理像素）。
///
/// `SetWindowRgn` 是二值裁剪，没有抗锯齿；把区域半径收紧后，区域弧线落在 CSS
/// 圆角之外的透明像素上，GDI 硬边不可见。主窗不使用这个固定值，而是用
/// `main_region_rgn()` 的逐行像素支撑形状（见该函数文档）。
const REGION_AA_INSET: i32 = 2;
/// 同一 HWND 的重入应用请求：必须保留调用方原始的目标类型与逻辑半径，
/// 补偿重算不得回落到主窗默认形态（右键菜单是 Popup/16px，不是 Main/18px）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PendingShape {
    target: ShapeTarget,
    /// 逻辑半径 × 1000；用整数保存，重入还原时不丢精度。
    radius_milli: u32,
}

/// 按 **HWND** 串行化 `SetWindowRgn`：同窗口重入只记录最新请求（保留 target/radius），
/// 不同窗口各自独立进入，不互相阻塞、不互相覆盖。
#[derive(Default)]
struct ApplyGate {
    applying: HashSet<isize>,
    pending: HashMap<isize, PendingShape>,
}

impl ApplyGate {
    /// 进入应用临界区；返回 `false` 表示同 hwnd 正在应用，调用方应 `defer` 后返回。
    fn try_enter(&mut self, hwnd: isize) -> bool {
        self.applying.insert(hwnd)
    }

    /// 重入请求按 hwnd 覆盖为最新参数；窗口对象仍由外层闭包持有。
    fn defer(&mut self, hwnd: isize, shape: PendingShape) {
        self.pending.insert(hwnd, shape);
    }

    fn take(&mut self, hwnd: isize) -> Option<PendingShape> {
        self.pending.remove(&hwnd)
    }

    fn leave(&mut self, hwnd: isize) {
        self.applying.remove(&hwnd);
    }

    /// 窗口销毁清理：进行中标记与未决请求都不得跨 HWND 复用残留。
    fn forget(&mut self, hwnd: isize) {
        self.applying.remove(&hwnd);
        self.pending.remove(&hwnd);
    }
}

static GATE: LazyLock<Mutex<ApplyGate>> = LazyLock::new(|| Mutex::new(ApplyGate::default()));

fn gate() -> std::sync::MutexGuard<'static, ApplyGate> {
    GATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 逻辑半径 → milli 整数（与 `set_radius` 同一夹取规则：非法值回退 18）。
fn radius_milli(logical_radius: f64) -> u32 {
    let r = if logical_radius.is_finite() {
        logical_radius.clamp(0.0, 40.0)
    } else {
        18.0
    };
    (r * 1000.0).round() as u32
}

/// 一次成功应用的区域参数。hwnd/尺寸/DPI/半径任一变化都必须重做。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RegionStamp {
    hwnd: isize,
    width: u32,
    height: u32,
    /// 实际写入的物理区域半径（0 = 直角矩形区域）。
    radius: u32,
    scale_milli: u32,
}

/// 一次成功应用的**胶囊**区域参数。胶囊区域不是圆角矩形，半径档位对它是无意义的；
/// 真正决定区域内容的是胶囊参数、物理尺寸与 DPI。与 `RegionStamp` 分开记录，
/// 避免整窗/胶囊两种形态在同一次尺寸下互相误命中。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CapsuleStamp {
    hwnd: isize,
    width: u32,
    height: u32,
    scale_milli: u32,
    params: CapsuleParams,
}

/// 应用对象：完整主窗与独立弹窗（右键菜单）。两者都使用「CSS 圆角像素支撑
/// 形状」区域，可见轮廓由 WebView2 的 CSS 抗锯齿弧定义；区域只负责把完全
/// 透明的像素移出窗口（裁剪与命中），不再用 GDI 硬边椭圆。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShapeTarget {
    Main,
    Popup,
}

/// 按 **HWND** 管理的区域缓存（v0.6 整改）：主窗与右键菜单弹窗各自维护
/// 圆角参数，交错 resize / 不同半径 / DPI 变化互不污染。
#[derive(Default)]
struct RegionCache {
    stamps: HashMap<isize, RegionStamp>,
    /// 胶囊区域最近一次成功应用的参数（按 hwnd）。命中也必须回读校验后才跳过重设。
    capsule_stamps: HashMap<isize, CapsuleStamp>,
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

    fn capsule_is_current(&self, stamp: &CapsuleStamp) -> bool {
        self.capsule_stamps.get(&stamp.hwnd) == Some(stamp)
    }

    fn update_capsule(&mut self, stamp: CapsuleStamp) {
        self.capsule_stamps.insert(stamp.hwnd, stamp);
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
        self.capsule_stamps.remove(&hwnd);
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

/// 功能面板宽。
pub const CAPSULE_PANEL_WIDTH_CSS: u32 = 340;
/// 功能面板高。
pub const CAPSULE_PANEL_HEIGHT_CSS: u32 = 440;
/// 轨道与面板之间的间隙（视觉分隔，区域上不连通）。
pub const CAPSULE_GAP_CSS: u32 = 8;
/// 面板圆角（轨道为全圆角 = 厚度/2）。
pub const CAPSULE_PANEL_RADIUS_CSS: u32 = 24;

/// Edge Tab（极简吸附标签）厚度/宽度（垂直于停靠边，CSS px）。
pub const CAPSULE_TAB_WIDTH_CSS: u32 = 10;
/// Edge Tab 长度（沿边方向，CSS px）。
pub const CAPSULE_TAB_HEIGHT_CSS: u32 = 46;
/// Edge Tab 靠屏幕内侧的圆角（CSS px；贴屏一侧保持直角）。
pub const CAPSULE_TAB_RADIUS_CSS: u32 = 8;

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
    /// true = Edge Tab（仅露出贴边的极简标签；优先于 expanded）
    pub tab: bool,
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

/// 该窗口当前是否处于胶囊（停靠）区域模式。
///
/// 停靠态窗口形状是轨道/面板而非整窗矩形，前端也不渲染四角缩放热区；
/// 角热区光标维护（`window_cursor`）据此跳过，避免在胶囊角上错误改写光标。
/// **Edge Tab 的光标不在这里处理**：标签拖动是前端指针拖动，光标由 WebView2 的
/// CSS `cursor` 决定（见 `docs/ui-themes/13-capsule-redesign.md`）。
#[cfg(windows)]
pub fn is_capsule_mode(hwnd: isize) -> bool {
    capsule_for(hwnd).is_some()
}

// ── 启动空白区域 ─────────────────────────────────────────────
//
// 停靠恢复启动时窗口必须**立刻**显示（隐藏窗口的定时器会被浏览器后台节流，
// 恢复反而更慢），但屏幕上不能出现主窗口像素。这里把区域裁成 1×1：
// 窗口仍是 WS_VISIBLE，页面保持前台节流等级，屏幕上只剩一个物理像素。
//
// 与胶囊的关系：**胶囊优先**。前端在恢复事务里会先写胶囊区域，那时空白标记
// 仍然存在——如果空白优先，胶囊区域会被吞掉、`GetWindowRgn` 回读失败，
// 前端会判定"区域写入失败"并回滚停靠。因此 `apply_pass` 先查胶囊、再查空白。

static BLANK: LazyLock<Mutex<Option<isize>>> = LazyLock::new(|| Mutex::new(None));

/// 设置/清除启动空白区域（调用方负责随后 apply）。
pub fn set_blank(hwnd: isize, blank: bool) {
    let mut slot = BLANK.lock().unwrap_or_else(|e| e.into_inner());
    *slot = if blank { Some(hwnd) } else { None };
}

/// 清除空白标记，返回此前是否处于空白状态（用于"是否需要重算区域"）。
pub fn take_blank(hwnd: isize) -> bool {
    let mut slot = BLANK.lock().unwrap_or_else(|e| e.into_inner());
    if *slot == Some(hwnd) {
        *slot = None;
        true
    } else {
        false
    }
}

fn blank_for(hwnd: isize) -> bool {
    *BLANK.lock().unwrap_or_else(|e| e.into_inner()) == Some(hwnd)
}

/// 1×1 空白区域：不可见、不可命中，但窗口保持可见（不触发后台节流）。
#[cfg(windows)]
fn apply_blank_pass(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateRectRgn, DeleteObject, GetRgnBox, GetWindowRgn, SetWindowRgn,
    };

    unsafe {
        let rgn = CreateRectRgn(0, 0, 1, 1);
        if rgn.is_null() {
            return false;
        }
        if SetWindowRgn(hwnd as _, rgn, 1) == 0 {
            DeleteObject(rgn as _);
            return false;
        }
        // 回读验证：区域确实只剩 1×1（SetWindowRgn 成功不代表区域内容正确）
        let probe = CreateRectRgn(0, 0, 0, 0);
        if probe.is_null() {
            return false;
        }
        let kind = GetWindowRgn(hwnd as _, probe);
        let mut box_ = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let ok =
            kind != 0 && GetRgnBox(probe, &mut box_) != 0 && box_.right <= 1 && box_.bottom <= 1;
        DeleteObject(probe as _);
        apply_dwm(hwnd, false);
        if !ok {
            tracing::warn!(hwnd, "启动空白区域回读失败（区域未生效）");
        }
        ok
    }
}

/// 窗口销毁时调用：清理该 hwnd 的区域缓存（防句柄复用误判）。
pub fn forget_window(hwnd: isize) {
    REGIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .forget(hwnd);
    // 启动空白标记同样按 hwnd 绑定：句柄被复用后不得继续裁新窗口
    let _ = take_blank(hwnd);
    // 延迟校准同样按 hwnd 绑定：句柄复用后不得替新窗口补做旧请求。
    let _ = DEFERRED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&hwnd);
    // 重入调度状态同样按 hwnd 绑定：销毁后不得残留未决补偿请求/进行中标记。
    gate().forget(hwnd);
}

// ── 拖拽期间的延迟校准（窗口拖拽透明异常修复）─────────────────
//
// 系统模态移动循环里，tao 为每个位置变化派发 `Moved`，`lib.rs` 因此逐帧调用
// `apply()`。窗口移动**不改变自身尺寸**，区域在窗口局部坐标里也不随位置变化；
// 逐帧 `GetWindowRgn` 回读 + `DwmGet/SetWindowAttribute` 只会让 DWM 在拖拽期间
// 反复重新合成（真机表现为拖动中整窗透明/闪烁，松手、截图或焦点变化才恢复）。
//
// 契约：移动循环内 `apply` 允许按缓存命中直接返回；尺寸/DPI 真变时仍重建区域，
// 但**不做回读、不碰 DWM**。松手（`WM_EXITSIZEMOVE`）后由 `flush_deferred`
// 在窗口线程一次性完成回读校验与 DWM 角偏好校准。
static DEFERRED: LazyLock<Mutex<HashSet<isize>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static APPLY_HOOK: LazyLock<Mutex<Option<Box<dyn Fn() + Send + Sync>>>> =
    LazyLock::new(|| Mutex::new(None));

/// 注册「重新应用主窗形状」的窗口线程回调（`lib.rs` 启动时调用一次）。
pub fn register_apply_hook(hook: Box<dyn Fn() + Send + Sync>) {
    *APPLY_HOOK.lock().unwrap_or_else(|e| e.into_inner()) = Some(hook);
}

/// 拖拽结束后补做被推迟的区域/DWM 校准（窗口线程调用；无待办时不做任何事）。
pub fn flush_deferred(hwnd: isize) {
    let pending = DEFERRED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&hwnd);
    if !pending {
        return;
    }
    let hook = APPLY_HOOK.lock().unwrap_or_else(|e| e.into_inner());
    match hook.as_ref() {
        Some(hook) => hook(),
        None => tracing::debug!(hwnd, "拖拽结束但未注册形状回调，跳过延迟校准"),
    }
}

/// 低频拖拽诊断（`TASK_DOCK_DRAG_DIAG=1`）：只记录原生侧事实，用于区分
/// 「CSS 值变化」与「原生合成异常」。前端在拖拽期间没有任何状态写入，
/// 因此若这里每 500ms 采样都显示 `stamp_current=true` 且无区域重建，
/// 即可排除 CSS/DOM 路径，把问题定位到 DWM 合成层。
fn drag_diag(
    hwnd: isize,
    w: i32,
    h: i32,
    scale: f64,
    dragging: bool,
    stamp_current: bool,
    region_rebuild: bool,
) {
    // 显式 opt-in：未设置或 `0` 时关闭，避免生产路径每 500ms 采样。
    let enabled = std::env::var("TASK_DOCK_DRAG_DIAG")
        .map(|v| v != "0")
        .unwrap_or(false);
    if !enabled {
        return;
    }
    static LAST: LazyLock<Mutex<Option<std::time::Instant>>> = LazyLock::new(|| Mutex::new(None));
    let now = std::time::Instant::now();
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = *last {
        if now.duration_since(prev).as_millis() < 500 {
            return;
        }
    }
    *last = Some(now);
    tracing::info!(
        hwnd,
        w,
        h,
        scale,
        dragging,
        stamp_current,
        region_rebuild,
        "窗口形状诊断（拖拽期跳过回读/DWM）"
    );
}

/// 诊断开关（环境变量，真机矩阵验收用）：
/// - `TASK_DOCK_WINDOW_REGION=0`：不设置 Win32 区域
/// - `TASK_DOCK_WINDOW_DWM_CORNER=0`：不设置 DWM 角偏好（保持系统默认）
/// - `TASK_DOCK_WINDOW_DWM_CORNER=dontround`：显式 DONOTROUND（区域自己裁圆角时用）
/// - `TASK_DOCK_WINDOW_DWM_BORDER=0`：保留 DWM 默认 1px 边框
///
/// 注意：这些开关只能把 DWM 圆角**关掉**，任何取值都不会让胶囊态重新打开
/// `DWMWCP_ROUND`（2026-11-02 真机根因修复的契约，见 `dwm_rounded_for`）。
fn flag(name: &str) -> bool {
    std::env::var(name).map(|v| v != "0").unwrap_or(true)
}

/// 主窗当前要应用的区域形态 —— 决定 DWM 角偏好是否参与合成。
///
/// **2026-11-02 真机根因（停靠胶囊整窗轮廓/阴影）**：胶囊停靠态的区域只是很小的
/// 翼片/面板，但历史实现末尾调用 `apply_dwm(hwnd, true)` 设 `DWMWCP_ROUND`。
/// Win11 的 DWM 会因此**按整个窗口矩形**绘制圆角系统边框 + 外部投影；窗口内容本身
/// 仍是透明的（像素级 A/B：窗口中心与背景同色，ROUND/DONOTROUND 的差异全部是「比
/// 背景更暗」的边框/投影像素）。`SetWindowRgn` 只裁窗口自身内容表面、裁不到 DWM 的
/// NC 合成：真机同刻 `PrintWindow` 只有胶囊，`CopyFromScreen` 却是整窗系统边框 +
/// 投影；浅色桌面/背景从透明窗口矩形透出，叠加成「大面积白板」观感（深色背景则只
/// 表现为整窗轮廓 + 阴影）。
///
/// 因此契约是：**只有形状接近整窗（主窗区域写入失败、退回系统圆角的兜底）才允许
/// ROUND；胶囊/整窗正常区域一律 DONOTROUND**，可见外形完全由 `SetWindowRgn` 定义。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainRegionShape {
    /// 胶囊停靠态（轨道 / 轨道∪面板，窗口只露一小块区域）。
    Capsule,
    /// 主窗正常整窗区域（逐行 CSS 圆角支撑形状）。
    Full,
    /// 主窗整窗区域写入失败：退回 DWM 系统圆角，避免留下直角矩形。
    FullFallback,
}

/// 区域形态 → 是否设置 `DWMWCP_ROUND`（纯函数，单测锁定「胶囊态绝不 ROUND」契约）。
fn dwm_rounded_for(shape: MainRegionShape) -> bool {
    matches!(shape, MainRegionShape::FullFallback)
}

/// 弹窗（右键菜单）区域成功时是否设置 `DWMWCP_ROUND`。
///
/// 与主窗同一契约：自定义区域一旦应用成功，可见外形必须完全由区域 + CSS 弧
/// 定义，DWM 的 8 DIP 系统弧会与 CSS 16px 弧形成双圆角/月牙缝，并沿整窗矩形
/// 绘制系统边框与投影。只有区域写入失败（退回直角矩形）时才允许 ROUND 兜底。
fn dwm_rounded_for_popup(region_applied: bool) -> bool {
    !region_applied
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

/// 按当前半径应用主窗外形（CSS 轮廓模式或旧区域模式）。返回是否真正应用成功。
#[cfg(windows)]
pub fn apply<R: Runtime>(win: &WebviewWindow<R>) -> bool {
    apply_impl(win, radius(), ShapeTarget::Main)
}

/// 用**指定**逻辑半径裁剪独立弹窗（弹窗使用自己的 CSS 圆角，
/// 不读取/不污染主窗口的全局半径状态）。返回是否真正应用成功。
#[cfg(windows)]
pub fn apply_with_radius<R: Runtime>(win: &WebviewWindow<R>, logical_radius: f64) -> bool {
    apply_impl(win, logical_radius, ShapeTarget::Popup)
}

#[cfg(windows)]
fn apply_impl<R: Runtime>(
    win: &WebviewWindow<R>,
    logical_radius: f64,
    target: ShapeTarget,
) -> bool {
    let Ok(handle) = win.hwnd() else {
        return false;
    };
    let hwnd = handle.0 as isize;

    let mut current = PendingShape {
        target,
        radius_milli: radius_milli(logical_radius),
    };

    {
        let mut gate = gate();
        if !gate.try_enter(hwnd) {
            // 重入：保留本次的窗口对象（外层持有）、目标类型与半径，交由外层下一 pass 应用。
            gate.defer(hwnd, current);
            return false;
        }
    }

    let mut applied = false;
    // 一次拖动会产生连续尺寸。每次 pass 后重新读取实际尺寸；尺寸变了或期间有新
    // 请求就再来一次，直到窗口稳定（上限防止异常环境下死循环）。
    for _ in 0..8 {
        applied |= apply_pass(
            win,
            hwnd,
            current.radius_milli as f64 / 1000.0,
            current.target,
        );
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
        // 只取**本 hwnd** 的重入请求；其它窗口的请求由它们各自的调用处理。
        let next = gate().take(hwnd);
        if let Some(next) = next {
            if next != current {
                // 目标/半径变了：下一 pass 必须按新参数执行，不能沿用旧形态。
                current = next;
                continue;
            }
            // 参数相同：本次 pass 已覆盖该请求，仅尺寸未稳定时才继续。
        }
        if stable {
            break;
        }
    }

    // 「离开临界区」与「取剩余请求」必须在同一临界区完成：否则两步之间到达的请求
    // 会看到 applying 为空而直接执行，而这里又取不到它；同一临界区内两种路径互斥。
    let leftover = {
        let mut gate = gate();
        gate.leave(hwnd);
        gate.take(hwnd)
    };
    if let Some(next) = leftover {
        let w = win.clone();
        let _ = w.clone().run_on_main_thread(move || {
            let _ = apply_impl(&w, next.radius_milli as f64 / 1000.0, next.target);
        });
    }
    applied
}

// 最近一次 pass 实际使用的窗口尺寸：已并入 RegionCache（按 hwnd 隔离）。

/// 圆角在某一行像素内的「抗锯齿支撑起点」（窗口左侧，物理像素）。
///
/// 区域必须覆盖 CSS 真正触及的像素（含极低 alpha 的抗锯齿外沿），否则会把
/// 平滑弧线切成 GDI 硬边；同时又不能覆盖 CSS 完全透明的像素，否则 WebView2
/// 在非激活态回填的白色会从这些像素露出，形成白色细边。
///
/// 判定口径：像素 `[x,x+1] × [y,y+1]` 与圆角圆（圆心 `(r,r)`、半径 `r`）
/// 相交 ⇔ `(r−x−1)^2 + (r−y−1)^2 ≤ r^2`。对 `x` 解出最小整数即本行起点。
/// 125% 下 CSS 22.5px 圆角实测最早着色像素 x = 15/13/11/9/7/3（y=0/1/2/3/5/10），
/// 与本公式逐行一致（见单测与真机截图）。
fn css_support_left(y: i32, h: i32, radius: f64) -> i32 {
    if radius <= 0.0 || h <= 0 {
        return 0;
    }
    let top = support_from_edge(y, radius);
    // 底边圆角：同一行相对底边的距离（最后一行 row=0）。
    let bottom = support_from_edge(h - 1 - y, radius);
    top.max(bottom)
}

/// 距最近一条水平边 `row` 行处，圆角圆的支撑起点。
fn support_from_edge(row: i32, radius: f64) -> i32 {
    if row < 0 || (row as f64) >= radius {
        return 0;
    }
    let dy = radius - (row as f64 + 1.0);
    let dx = (radius * radius - dy * dy).max(0.0).sqrt();
    // 像素 [x,x+1] 与该行圆弧相交的最小整数 x。
    let x = (radius - 1.0 - dx).ceil() as i32;
    x.max(0)
}

/// 主窗圆角区域：按行构造 CSS 圆角的**像素支撑形状**（逐行矩形并集）。
///
/// 圆角区域不是简单的 `CreateRoundRectRgn`：单个圆的区域无法同时满足
/// 「覆盖切点处 7~8px 的 AA 支撑」与「不覆盖任何完全透明像素」。逐行取
/// `css_support_left()` 得到的矩形并集，既保留 CSS 抗锯齿外沿，又与 CSS
/// 可见像素一一对应（圆角外不产生白色填充，也不产生多余命中）。
#[cfg(windows)]
fn main_region_rgn(w: i32, h: i32, radius: f64) -> Option<windows_sys::Win32::Graphics::Gdi::HRGN> {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, RGN_ERROR, RGN_OR,
    };

    if w <= 0 || h <= 0 {
        return None;
    }
    // 与 CSS 的 border-radius 钳制口径一致：半径不超过短边一半。
    let radius = radius.min(w.min(h) as f64 / 2.0);
    unsafe {
        if radius <= 0.0 {
            let rgn = CreateRectRgn(0, 0, w + 1, h + 1);
            return (!rgn.is_null()).then_some(rgn);
        }
        let rgn = CreateRectRgn(0, 0, 0, 0);
        if rgn.is_null() {
            return None;
        }
        let mut y = 0;
        while y < h {
            let x = css_support_left(y, h, radius).min(w / 2);
            // 同一起点的连续行合并为一个矩形，避免为每一行都 CombineRgn。
            let mut y_end = y + 1;
            while y_end < h && css_support_left(y_end, h, radius).min(w / 2) == x {
                y_end += 1;
            }
            let right = (w - x).max(x + 1);
            let rect = CreateRectRgn(x, y, right, y_end);
            if rect.is_null() || CombineRgn(rgn, rgn, rect, RGN_OR) == RGN_ERROR {
                if !rect.is_null() {
                    DeleteObject(rect as _);
                }
                DeleteObject(rgn as _);
                return None;
            }
            DeleteObject(rect as _);
            y = y_end;
        }
        Some(rgn)
    }
}

/// 任意圆角矩形的**像素支撑区域**（与 CSS `border-radius` 的弧逐行对齐）。
///
/// `CreateRoundRectRgn` 的弧是 GDI 的硬边椭圆：面板半径 22~24px 时它与 CSS 弧
/// 最多差 2px，在浅色玻璃面板上会形成一圈可见阶梯（正是「矩形拼接感」的
/// 来源之一）。这里复用主窗的 `support_from_edge()`：逐行求「CSS 弧最早着色的
/// 像素」，把相同起点合并成矩形并集，再平移到 `(x0, y0)`。
///
/// 胶囊面板与右键菜单弹窗（`ShapeTarget::Popup`）共用本函数：弹窗半径 16px
/// 虽小，但 `CreateRoundRectRgn` 的硬边仍会切进 CSS 抗锯齿弧（深色桌面上是
/// 一圈白色阶梯，浅色桌面上是灰黑锯齿），因此不再保留弹窗专用的硬边椭圆。
///
/// 右/下边界用**开区间**（`x0 + w`），与 CSS 盒子尺寸一一对应；主窗那套 `+1`
/// 口径只影响包围盒回读的 1px 容差，这里不需要。
#[cfg(windows)]
fn support_rect_rgn(
    x0: i32,
    y0: i32,
    w: i32,
    h: i32,
    radius: f64,
) -> Option<windows_sys::Win32::Graphics::Gdi::HRGN> {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, RGN_ERROR, RGN_OR,
    };

    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let radius = radius.min(w.min(h) as f64 / 2.0);
        if radius <= 0.0 {
            let rgn = CreateRectRgn(x0, y0, x0 + w, y0 + h);
            return (!rgn.is_null()).then_some(rgn);
        }
        let rgn = CreateRectRgn(0, 0, 0, 0);
        if rgn.is_null() {
            return None;
        }
        let mut y = 0;
        while y < h {
            let x = css_support_left(y, h, radius).min(w / 2);
            let mut y_end = y + 1;
            while y_end < h && css_support_left(y_end, h, radius).min(w / 2) == x {
                y_end += 1;
            }
            let right = (w - x).max(x + 1);
            let rect = CreateRectRgn(x0 + x, y0 + y, x0 + right, y0 + y_end);
            if rect.is_null() || CombineRgn(rgn, rgn, rect, RGN_OR) == RGN_ERROR {
                if !rect.is_null() {
                    DeleteObject(rect as _);
                }
                DeleteObject(rgn as _);
                return None;
            }
            DeleteObject(rect as _);
            y = y_end;
        }
        Some(rgn)
    }
}

/// CSS 圆角对应的物理像素半径（用于区域缓存 stamp 与回读点判定；
/// 实际区域形状由 `main_region_rgn` / `support_rect_rgn` 的逐行支撑算法生成）。
fn rounded_region_radius(logical_radius: f64, scale: f64) -> i32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let logical = if logical_radius.is_finite() {
        logical_radius.clamp(0.0, 40.0)
    } else {
        18.0
    };
    (logical * scale).round() as i32
}

#[cfg(windows)]
fn apply_pass<R: Runtime>(
    win: &WebviewWindow<R>,
    hwnd: isize,
    logical_radius: f64,
    target: ShapeTarget,
) -> bool {
    use windows_sys::Win32::Graphics::Gdi::{DeleteObject, SetWindowRgn};

    // 系统模态移动循环内（拖拽整个窗口）：窗口移动不改变尺寸与区域内容，
    // 因此不做回读、不写 DWM，松手后由 `flush_deferred` 一次性校准。
    // 尺寸/DPI 真变（拖动窗口边缘）仍会走重建路径，只是同样跳过回读与 DWM。
    let dragging = target == ShapeTarget::Main && crate::magnetic::in_size_move(hwnd);
    if dragging {
        DEFERRED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(hwnd);
    }

    // 每次都重新读取几何：外层 pass 开始后窗口可能又被拖动了。
    let size = match win.outer_size() {
        Ok(s) if s.width > 0 && s.height > 0 => s,
        _ => return false,
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let w = size.width as i32;
    let h = size.height as i32;
    let r = rounded_region_radius(logical_radius, scale);
    let css_phys = {
        let logical = if logical_radius.is_finite() {
            logical_radius.clamp(0.0, 40.0)
        } else {
            18.0
        };
        logical * scale
    };
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
        apply_dwm(hwnd, false);
        return false;
    }

    // ── 分类胶囊模式：只露出轨道（折叠）或「轨道 ∪ 面板」（展开）──
    // 区域外的内容不被绘制、也不接收鼠标命中（Win32 SetWindowRgn 语义）。
    // 窗口位置/尺寸在停靠期间保持不变，区域切换是唯一的视觉状态变化。
    if target == ShapeTarget::Main {
        if let Some(cap) = capsule_for(hwnd) {
            return apply_capsule_pass(hwnd, w, h, scale, cap, dragging);
        }
        // 启动停靠恢复：区域先裁成 1×1 空白，等前端把几何 + 轨道区域一次做完。
        // 胶囊优先（见 `BLANK` 注释）：这里只在**还没有胶囊状态**时生效。
        if blank_for(hwnd) {
            if apply_blank_pass(hwnd) {
                return true;
            }
            // 空白区域没生效：撤销标记并退回正常区域，绝不留下不可见窗口。
            set_blank(hwnd, false);
        }
    }

    // 主窗与弹窗都使用逐行构造的 CSS 圆角像素支撑形状（保留 AA 外沿、
    // 不覆盖任何完全透明的像素）：可见轮廓由 CSS 抗锯齿弧定义，区域不提供硬边。
    let stamp = RegionStamp {
        hwnd,
        width: size.width,
        height: size.height,
        radius: r as u32,
        scale_milli,
    };
    let stamp_current = {
        let cache = REGIONS.lock().unwrap_or_else(|e| e.into_inner());
        cache.is_current(&stamp)
    };
    // 拖拽中跳过 `GetWindowRgn` 回读（逐帧 GDI 回读与 DWM 查询会打断合成）；
    // 松手后的 flush 会做一次完整回读校验。
    let current = stamp_current && (dragging || region_is_current(hwnd, w, h, r));
    drag_diag(hwnd, w, h, scale, dragging, stamp_current, !current);

    let mut ok = current;
    if !current {
        ok = unsafe {
            let rgn = if target == ShapeTarget::Main {
                main_region_rgn(w, h, css_phys)
            } else {
                // 弹窗不再用 CreateRoundRectRgn（GDI 二值硬边会切进 CSS AA 弧，
                // 四角表现为阶梯锯齿）；与胶囊面板共用同一像素支撑形状。
                support_rect_rgn(0, 0, w, h, css_phys)
            };
            match rgn {
                None => false,
                Some(rgn) => {
                    if SetWindowRgn(hwnd as _, rgn, 1) == 0 {
                        // 失败时区域未被系统接管，仍归调用方，必须释放。
                        DeleteObject(rgn as _);
                        false
                    } else {
                        true
                    }
                }
            }
        };
        if ok {
            REGIONS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .update(stamp);
        }
    }

    if target == ShapeTarget::Main {
        // DWM 角偏好由区域形态决定（纯函数契约，见 `dwm_rounded_for`）：
        // 整窗区域与胶囊区域都 DONOTROUND；只有区域写入失败、退回系统圆角兜底时才 ROUND。
        // 拖拽中不写 DWM（逐帧写会让 DWM 反复重新合成，表现为拖动中整窗透明）；
        // 松手后的 flush 会按当时形态补写一次。
        if !dragging {
            let shape = if ok {
                MainRegionShape::Full
            } else {
                MainRegionShape::FullFallback
            };
            apply_dwm(hwnd, dwm_rounded_for(shape));
        }
    } else {
        // 弹窗与主窗同一契约：区域成功必须 DONOTROUND，否则 DWM 会按整窗矩形
        // 叠加 8 DIP 系统弧与边框/投影，与 CSS 16px 弧形成双圆角/月牙缝。
        apply_dwm(hwnd, dwm_rounded_for_popup(ok));
    }
    ok
}

/// 胶囊区域矩形（**显式宽高**，杜绝依赖变量名推断方向）。
///
/// 轨道（rail）现在是非矩形轮廓，这里的矩形只作为它的**外框**（包围盒）；
/// 真正参与裁剪与命中判定的是 `CapsuleRegionSet::rail_polygon`。
/// 面板仍是圆角矩形，`radius` 只对面板有意义。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CapsuleRegionRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub radius: i32,
}

impl CapsuleRegionRect {
    #[cfg(test)]
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.width && py >= self.y && py < self.y + self.height
    }
    fn center(&self) -> (i32, i32) {
        (self.x + self.width / 2, self.y + self.height / 2)
    }
}

// ── 液态融合翼片几何（与 `src/lib/capsuleShape.ts` 逐点一致）────────
//
// 单一参数化形状：边空间里「贴边一侧切线水平、壁切线垂直」，四边只换映射
// 不换形状。前端 SVG 可见轮廓与这里的区域多边形**取自同一个采样函数**
// （同样的段数、同样的取整），所以「CSS 轮廓 = Win32 区域」是构造性成立的，
// 不依赖容差。两端各有一组金标准点位单测锁定。

/// 单侧液态肩部的沿边跨度（CSS px）：约为厚度的 1.07 倍 → 宽而浅的过渡。
pub const CAPSULE_SHOULDER_CSS: u32 = 88;
/// 肩部起点控制柄占肩宽的比例（与前端 `WING_CREST_RATIO` 相同）。
pub(crate) const WING_CREST_RATIO: f64 = 0.435;
/// 肩部终点控制柄占肩宽的比例（与前端 `WING_TAIL_RATIO` 相同）。
pub(crate) const WING_TAIL_RATIO: f64 = 0.565;
/// 每个肩部的贝塞尔采样段数（与前端 `WING_SAMPLES` 相同）。
pub(crate) const WING_SAMPLES: usize = 18;

/// 与前端 `roundPx` 相同的取整（.5 一律向 +∞，避免两端在半点上分叉）。
fn round_px(v: f64) -> i32 {
    (v + 0.5).floor() as i32
}

/// 翼片参数（物理像素）：(厚度, 平直主体长度, 单侧肩宽)。
pub(crate) fn wing_metrics(scale: f64, thickness_css: u32, length_css: u32) -> (i32, i32, i32) {
    let s = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let thickness = round_px(thickness_css as f64 * s).max(1);
    let length = round_px(length_css as f64 * s).max(1);
    // 肩宽至少 1px：为 0 时肩部退化成一竖直边，形状会重新变成圆角矩形
    let shoulder = round_px(CAPSULE_SHOULDER_CSS as f64 * s).max(1);
    (thickness, length, shoulder)
}

/// 肩部贝塞尔采样：主体端点 `(0, t)` → 贴边尖端 `(s, 0)`，含两端点。
///
/// 控制点取 `(k·s, t)` 与 `((1−tail)·s, 0)`：两端切线都严格水平，
/// 与主体平边、与屏幕边缘都是 C1 相切（与前端 `shoulderCurve` 逐点一致）。
fn shoulder_curve(s: f64, t: f64) -> Vec<(f64, f64)> {
    let p0 = (0.0, t);
    let p1 = (s * WING_CREST_RATIO, t);
    let p2 = (s * (1.0 - WING_TAIL_RATIO), 0.0);
    let p3 = (s, 0.0);
    let mut pts = Vec::with_capacity(WING_SAMPLES + 1);
    for i in 0..=WING_SAMPLES {
        let u = i as f64 / WING_SAMPLES as f64;
        let m = 1.0 - u;
        let (a, b, c, d) = (m * m * m, 3.0 * m * m * u, 3.0 * m * u * u, u * u * u);
        pts.push((
            a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0,
            a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1,
        ));
    }
    pts
}

/// 边空间轮廓（u 沿边、v 由边缘向内），闭合多边形，不含重复的收尾点。
/// 点序：左尖端 → 左肩（逆行）→ 主体 → 右肩 → 右尖端；首尾都落在 `v = 0`。
fn edge_space_outline(l: f64, t: f64, s: f64) -> Vec<(f64, f64)> {
    let half = l / 2.0;
    let curve = shoulder_curve(s, t);
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(2 * curve.len() - 1);
    for p in curve.iter().rev() {
        pts.push((-half - p.0, p.1));
    }
    // i=0 是平直主体的另一端，不能跳过：跳过会让顶边变成一条斜弦
    for p in curve.iter() {
        pts.push((half + p.0, p.1));
    }
    pts
}

fn polygon_signed_area(pts: &[(f64, f64)]) -> f64 {
    let n = pts.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        a += p.0 * q.1 - q.0 * p.1;
    }
    a / 2.0
}

/// 沿外法线整体外扩（与前端 `offsetPolygon` 同一算法、同一判据）。
/// 平滑顶点走角平分线 + 斜接补偿；尖点（贴边收束处内角仅约 6°）改为**斜切**，
/// 保证区域到轮廓的距离处处 ≤ delta。
fn offset_polygon(pts: &[(f64, f64)], delta: f64) -> Vec<(f64, f64)> {
    let n = pts.len();
    if n < 3 || delta == 0.0 {
        return pts.to_vec();
    }
    // y 向下：有向面积为正 → 内部在有向边的 (-dy,dx) 侧 → 外法线 = (dy,-dx)
    let sign = if polygon_signed_area(pts) >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let normal = |a: (f64, f64), b: (f64, f64)| {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = (dx * dx + dy * dy).sqrt().max(1e-9);
        (sign * dy / len, -sign * dx / len)
    };
    let mut out = Vec::with_capacity(n + 4);
    for i in 0..n {
        let p = pts[i];
        let n1 = normal(pts[(i + n - 1) % n], p);
        let n2 = normal(p, pts[(i + 1) % n]);
        if n1.0 * n2.0 + n1.1 * n2.1 < 0.7 {
            out.push((p.0 + n1.0 * delta, p.1 + n1.1 * delta));
            out.push((p.0 + n2.0 * delta, p.1 + n2.1 * delta));
            continue;
        }
        let (mut nx, mut ny) = (n1.0 + n2.0, n1.1 + n2.1);
        let len = (nx * nx + ny * ny).sqrt().max(1e-9);
        nx /= len;
        ny /= len;
        let cos = (n1.0 * nx + n1.1 * ny).max(0.5);
        out.push((p.0 + nx * delta / cos, p.1 + ny * delta / cos));
    }
    out
}

/// 翼片轮廓（轨道**局部**坐标）：返回 `(外框宽, 外框高, 多边形点)`。
/// `inflate` = 区域相对 CSS 轮廓的外扩（物理像素），见 `REGION_AA_INSET`。
pub(crate) fn wing_outline(
    edge: u8,
    scale: f64,
    thickness_css: u32,
    length_css: u32,
    inflate: f64,
) -> (i32, i32, Vec<(f64, f64)>) {
    let (t, l, sh) = wing_metrics(scale, thickness_css, length_css);
    let vertical = edge <= 1;
    let along = l + 2 * sh;
    let (bw, bh) = if vertical { (t, along) } else { (along, t) };
    let mut pts = edge_space_outline(l as f64, t as f64, sh as f64);
    for p in pts.iter_mut() {
        let (u, v) = (p.0, p.1);
        *p = match edge {
            0 => (v, bh as f64 / 2.0 + u),             // left  → 贴左缘，沿边向上
            1 => (bw as f64 - v, bh as f64 / 2.0 + u), // right → 贴右缘
            2 => (bw as f64 / 2.0 + u, v),             // top   → 贴上缘
            _ => (bw as f64 / 2.0 + u, bh as f64 - v), // bottom→ 贴下缘
        };
    }
    if inflate > 0.0 {
        pts = offset_polygon(&pts, inflate);
    }
    (bw, bh, pts)
}

/// Edge Tab 区域：贴边的一条极简标签，靠屏幕内侧两角为圆角、贴屏一侧保持直角。
/// 与轨道/面板共用同一窗口（尺寸与位置不变），只把可见与可命中范围收紧到标签。
fn capsule_tab_regions(
    window_w: i32,
    window_h: i32,
    scale: f64,
    edge: u8,
) -> Option<CapsuleRegionSet> {
    let tab_w = ((CAPSULE_TAB_WIDTH_CSS as f64) * scale).round() as i32;
    let tab_h = ((CAPSULE_TAB_HEIGHT_CSS as f64) * scale).round() as i32;
    if tab_w <= 0 || tab_h <= 0 {
        return None;
    }
    // 垂直于停靠边的是 tab_w，沿边方向是 tab_h；左右停靠为纵标签，上下停靠为横标签。
    let vertical = edge <= 1;
    let (rect_w, rect_h) = if vertical {
        (tab_w, tab_h)
    } else {
        (tab_h, tab_w)
    };
    if rect_w > window_w || rect_h > window_h {
        return None;
    }
    let (x, y) = match edge {
        0 => (0, (window_h - rect_h) / 2),
        1 => (window_w - rect_w, (window_h - rect_h) / 2),
        2 => ((window_w - rect_w) / 2, 0),
        _ => ((window_w - rect_w) / 2, window_h - rect_h),
    };
    let radius = (((CAPSULE_TAB_RADIUS_CSS as f64) * scale).floor() as i32 - REGION_AA_INSET)
        .max(1)
        .min(rect_w.min(rect_h) / 2);
    let local = tab_outline(edge, tab_w, tab_h, radius);
    let rail_polygon: Vec<(i32, i32)> = local
        .iter()
        .map(|&(px, py)| {
            (
                round_px(px + x as f64).clamp(0, window_w),
                round_px(py + y as f64).clamp(0, window_h),
            )
        })
        .collect();
    let rail = CapsuleRegionRect {
        x,
        y,
        width: rect_w,
        height: rect_h,
        radius: 0,
    };
    // 靠屏幕内侧的角必须落在区域外，证明裁的是圆角标签而不是整块矩形。
    let notch_probe = match edge {
        0 => Some((x + rect_w - 1, y)),
        1 => Some((x, y)),
        2 => Some((x, y + rect_h - 1)),
        _ => Some((x, y)),
    };
    Some(CapsuleRegionSet {
        rail,
        rail_polygon,
        panel: None,
        gap_probe: None,
        notch_probe,
    })
}

/// 标签轮廓（局部坐标）：贴屏一侧为直角，靠屏幕内侧两角按 `radius` 采样圆角。
/// 先按「纵向左侧标签」生成，再按停靠边翻转/旋转。
fn tab_outline(edge: u8, rect_w: i32, rect_h: i32, radius: i32) -> Vec<(f64, f64)> {
    let (tw, th, r) = (rect_w as f64, rect_h as f64, radius as f64);
    let mut pts: Vec<(f64, f64)> = vec![(0.0, 0.0), (0.0, th), (tw - r, th)];
    push_arc(&mut pts, tw - r, th - r, r, 90.0, 0.0, 6);
    pts.push((tw, r));
    push_arc(&mut pts, tw - r, r, r, 0.0, -90.0, 6);
    pts.into_iter()
        .map(|(v, u)| match edge {
            0 => (v, u),
            1 => (tw - v, u),
            2 => (u, v),
            // 下边：原点在窗口底部，屏幕边为 y=tw（贴屏直角），内侧 y=0 两角圆角。
            _ => (u, tw - v),
        })
        .collect()
}

fn push_arc(out: &mut Vec<(f64, f64)>, cx: f64, cy: f64, r: f64, from: f64, to: f64, steps: u32) {
    for i in 1..=steps {
        let t = from + (to - from) * (i as f64) / (steps as f64);
        let rad = t.to_radians();
        out.push((cx + r * rad.cos(), cy + r * rad.sin()));
    }
}

/// 胶囊区域集合：折叠态只有轨道；展开态 = 轨道 ∪ 面板（轨道为翼片多边形，
/// 面板为圆角矩形，中间由 `gap` 分隔，**不连通**——间隙既不属于区域也不拦截鼠标）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CapsuleRegionSet {
    /// 轨道外框（包围盒，供布局与日志使用；命中区见 `rail_polygon`）
    pub rail: CapsuleRegionRect,
    /// 轨道多边形（窗口局部物理像素，已含 AA 外扩、已钳制进窗口）
    pub rail_polygon: Vec<(i32, i32)>,
    pub panel: Option<CapsuleRegionRect>,
    /// 间隙中点：必须落在区域之外（回读验证用）。
    pub gap_probe: Option<(i32, i32)>,
    /// 外框内、翼片轮廓之外的点：必须落在区域之外——用来证明区域真的是
    /// 翼片形状，而不是「外框矩形」（那正是历史上白色大矩形的形态）。
    pub notch_probe: Option<(i32, i32)>,
}

impl CapsuleRegionSet {
    /// 联合区域包围盒（x, y, right, bottom）：由多边形实际点位求得。
    pub fn bounds(&self) -> (i32, i32, i32, i32) {
        let mut left = i32::MAX;
        let mut top = i32::MAX;
        let mut right = i32::MIN;
        let mut bottom = i32::MIN;
        for &(x, y) in &self.rail_polygon {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
        if self.rail_polygon.is_empty() {
            left = self.rail.x;
            top = self.rail.y;
            right = self.rail.x + self.rail.width;
            bottom = self.rail.y + self.rail.height;
        }
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
/// - Left / Right：**纵向**轨道，width = 厚度、height = 主体长度 + 2×外扩；
/// - Top / Bottom：**横向**轨道，width = 主体长度 + 2×外扩、height = 厚度；
/// - 轨道贴停靠边齐平（外扩一侧压在屏幕边缘上，切线水平）；
/// - 面板始终在轨道**内侧**（朝屏幕内部），与轨道同轴居中、间隔 `gap`。
///
/// 物理像素按 DPI 换算。**请求展开但窗口不足以容纳「轨道 ∪ 面板」时返回 `None`**
/// （整次应用失败），绝不退化成「只裁轨道却报告成功」：前端的提交协议以本次
/// 返回值与 `GetWindowRgn` 回读为准，退化成功会让 UI 提交 `docked-revealed`，
/// 表现为「React 显示面板 / 原生只露翼片」并泄露完整工作区控件。
/// 前端在展开前必须先把窗口撑到容器尺寸（`ensureCapsuleContainer`）。
/// 折叠态只要求容纳轨道，窗口足够即可。
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
    // 退化防护必须在取整/钳制之前：0 厚度/长度不得被 `max(1)` 兜成 1px
    if cap.thickness_css == 0 || cap.length_css == 0 {
        return None;
    }
    if cap.tab {
        return capsule_tab_regions(window_w, window_h, scale, cap.edge);
    }
    let (thickness, length, shoulder) = wing_metrics(scale, cap.thickness_css, cap.length_css);
    let panel_w = ((CAPSULE_PANEL_WIDTH_CSS as f64) * scale).round() as i32;
    let panel_h = ((CAPSULE_PANEL_HEIGHT_CSS as f64) * scale).round() as i32;
    let gap = ((CAPSULE_GAP_CSS as f64) * scale).round().max(1.0) as i32;
    // 与整窗口径一致：区域圆角比 CSS 小 2px，硬边落在透明像素上，
    // 面板的可见圆角由 CSS 的抗锯齿弧线定义。
    let panel_radius =
        (((CAPSULE_PANEL_RADIUS_CSS as f64) * scale).floor() as i32 - REGION_AA_INSET).max(1);
    if thickness <= 0 || length <= 0 {
        return None; // 退化防护：胶囊至少 1px
    }
    // 方向：0/1=left/right（纵） 2/3=top/bottom（横）
    let vertical = cap.edge <= 1;
    let along = length + 2 * shoulder;
    let (box_w, box_h) = if vertical {
        (thickness, along)
    } else {
        (along, thickness)
    };
    let width = box_w.min(window_w);
    let height = box_h.min(window_h);
    if width <= 0 || height <= 0 {
        return None;
    }
    // 轨道贴停靠边（窗口齐平贴边、不再移动，轨道就在窗口的停靠侧）
    let (x, y) = match cap.edge {
        0 => (0, (window_h - height) / 2), // left  → 窗口左缘
        1 => (window_w - width, (window_h - height) / 2), // right → 窗口右缘
        2 => ((window_w - width) / 2, 0),  // top   → 窗口上缘
        _ => ((window_w - width) / 2, window_h - height), // bottom→ 窗口下缘
    };
    let rail = CapsuleRegionRect {
        x: x.clamp(0, window_w - width),
        y: y.clamp(0, window_h - height),
        width,
        height,
        radius: 0, // 非矩形：真正的外形是多边形
    };
    // 多边形按**自然尺寸**生成后再平移、钳制进窗口：贴边侧的外扩必然越过窗口
    // 边界，钳制结果与系统对区域做的窗口裁剪一致，前端命中判定用同一份点位。
    let (_bw, _bh, local) = wing_outline(
        cap.edge,
        scale,
        cap.thickness_css,
        cap.length_css,
        REGION_AA_INSET as f64,
    );
    let rail_polygon: Vec<(i32, i32)> = local
        .iter()
        .map(|&(px, py)| {
            let gx = round_px(px + rail.x as f64);
            let gy = round_px(py + rail.y as f64);
            (gx.clamp(0, window_w), gy.clamp(0, window_h))
        })
        .collect();
    // 外框内、轮廓外：沿边方向距中心 half + 3/4 肩宽处、厚度中点。
    // 该处肩部曲线已落到约 0.17×厚度，因此厚度中点必然在翼片之外；
    // 取 3/4（而不是 1/2）是为了留出 ≥16px 余量，区域外扩 2px 也不会碰到。
    let half = length / 2;
    let probe_along = half + shoulder * 3 / 4;
    let notch_probe = if vertical {
        Some((rail.x + thickness / 2, rail.y + height / 2 + probe_along))
    } else {
        Some((rail.x + width / 2 + probe_along, rail.y + thickness / 2))
    };
    if !cap.expanded {
        return Some(CapsuleRegionSet {
            rail,
            rail_polygon,
            panel: None,
            gap_probe: None,
            notch_probe,
        });
    }
    let (pw, ph) = (panel_w.min(window_w), panel_h.min(window_h));
    if pw <= 0 || ph <= 0 {
        tracing::warn!(
            "胶囊面板尺寸退化（w={window_w} h={window_h} pw={pw} ph={ph}），展开请求失败",
        );
        return None;
    }
    let (px, py) = match cap.edge {
        0 => (rail.x + rail.width + gap, (window_h - ph) / 2),
        1 => (rail.x - gap - pw, (window_h - ph) / 2),
        2 => ((window_w - pw) / 2, rail.y + rail.height + gap),
        _ => ((window_w - pw) / 2, rail.y - gap - ph),
    };
    // 越界 = 本次展开失败，而不是「静默只显示轨道」：退化结果若被当成成功，
    // 前端会把相位推进到 docked-revealed，但原生只有翼片，面板控件全部被裁掉。
    if px < 0 || py < 0 || px + pw > window_w || py + ph > window_h {
        tracing::warn!(
            "胶囊面板区域越界，展开请求失败（w={window_w} h={window_h} edge={} px={px} py={py} pw={pw} ph={ph}）",
            cap.edge
        );
        return None;
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
        rail_polygon,
        panel: Some(panel),
        gap_probe,
        notch_probe,
    })
}

/// 应用胶囊区域：折叠 = 翼片多边形；展开 = 翼片 ∪ 面板（CombineRgn OR）。
/// 区域外不绘制、不接收鼠标；DPI/尺寸变化由外层 apply 重算。
/// 成功后用 GetWindowRgn **回读验证**：包围盒一致 + 轨道/面板中心在区域内 +
/// 间隙中点在区域外 + 外框缺角在区域外——SetWindowRgn 返回成功不代表区域内容正确。
#[cfg(windows)]
fn apply_capsule_pass(
    hwnd: isize,
    w: i32,
    h: i32,
    scale: f64,
    cap: CapsuleParams,
    dragging: bool,
) -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreatePolygonRgn, DeleteObject, SetWindowRgn, RGN_ERROR, RGN_OR, WINDING,
    };

    let Some(set) = capsule_regions(w, h, scale, &cap) else {
        tracing::warn!(
            "胶囊区域几何退化（w={w} h={h} scale={scale} edge={}）",
            cap.edge
        );
        return false;
    };
    let stamp = CapsuleStamp {
        hwnd,
        width: w as u32,
        height: h as u32,
        scale_milli: (scale * 1000.0).round() as u32,
        params: cap,
    };
    // 缓存命中 + 回读校验：Moved / Focused(true) 等不改尺寸的事件也会走到这里，
    // 尺寸、DPI 与胶囊参数都没变时区域内容必然一致，不必重复 CreatePolygonRgn +
    // SetWindowRgn（重设同一区域会触发整窗失效并被系统重新裁剪）。系统重置区域
    // 或形态被外部改写时回读校验会失败，仍按原路径重建（保留失败恢复）。
    let stamp_current = {
        let cache = REGIONS.lock().unwrap_or_else(|e| e.into_inner());
        cache.capsule_is_current(&stamp)
    };
    // 拖拽中跳过 `GetWindowRgn` 回读：逐帧回读 + DWM 查询会让 DWM 反复重新合成。
    // 松手后的 `flush_deferred` 会完整回读一次并补写 DWM。
    let cached = stamp_current && (dragging || capsule_region_matches(hwnd, &set));
    drag_diag(hwnd, w, h, scale, dragging, stamp_current, !cached);
    if cached {
        if !dragging {
            apply_dwm(hwnd, dwm_rounded_for(MainRegionShape::Capsule));
        }
        return true;
    }
    let round =
        |r: &CapsuleRegionRect| support_rect_rgn(r.x, r.y, r.width, r.height, r.radius as f64);
    let applied = unsafe {
        let pts: Vec<POINT> = set
            .rail_polygon
            .iter()
            .map(|&(x, y)| POINT { x, y })
            .collect();
        let rgn = CreatePolygonRgn(pts.as_ptr(), pts.len() as i32, WINDING);
        if rgn.is_null() {
            false
        } else {
            let mut ok = true;
            if let Some(p) = set.panel {
                match round(&p) {
                    None => ok = false,
                    Some(pr) => {
                        if CombineRgn(rgn, rgn, pr, RGN_OR) == RGN_ERROR {
                            ok = false;
                        }
                        DeleteObject(pr as _);
                    }
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
    // 拖拽中不做回读（见上）；只有写入成功才允许记为"已应用"，松手后 flush 复核。
    let verified = applied && (dragging || capsule_region_matches(hwnd, &set));
    tracing::debug!(
        hwnd,
        edge = cap.edge,
        expanded = cap.expanded,
        rail_x = set.rail.x,
        rail_y = set.rail.y,
        rail_w = set.rail.width,
        rail_h = set.rail.height,
        rail_pts = set.rail_polygon.len(),
        panel = set.panel.is_some(),
        applied,
        verified,
        "胶囊区域应用"
    );
    if verified {
        // 只有回读校验通过才记缓存：写入失败/被系统改写后下一次仍会完整重建。
        REGIONS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update_capsule(stamp);
    }
    // 胶囊态的可见外形只由 SetWindowRgn 定义，**绝不设置 DWMWCP_ROUND**（2026-11-02
    // 真机根因）：区域回读成功 ≠ DWM 合成层被裁。该窗口带 WS_CAPTION|WS_THICKFRAME
    // （tao 行为），ROUND 会让 DWM 在整个窗口矩形上绘制圆角系统边框 + 外部投影；
    // 窗口内部仍透明，浅色背景透出形成「大面积白板」观感——真机同刻 PrintWindow
    // 只有胶囊，CopyFromScreen 却是整窗轮廓 + 阴影（差异像素全部比背景更暗）。
    // 胶囊态保持主窗一致的 DONOTROUND 后，区域外暗像素/白簇/阴影全部归零，胶囊
    // 逐像素不变（证据：tmp/acceptance/docked-window-residual-fix/）。
    // 拖拽中跳过 DWM 写入（松手后的 flush 会补写）。
    if !dragging {
        apply_dwm(hwnd, dwm_rounded_for(MainRegionShape::Capsule));
    }
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
            // 缺角必须在区域外：证明裁的是翼片轮廓，不是外框矩形
            if let Some((nx, ny)) = expect.notch_probe {
                points_ok &= PtInRegion(rgn, nx, ny) == 0;
            }
            bbox_ok && points_ok
        };
        DeleteObject(rgn as _);
        ok
    }
}

/// 读取窗口的**实际**区域并与期望几何比对。系统重置区域、窗口缩放后缓存未更新、
/// 或圆角区域被替换成直角矩形时都会返回 false。
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
        // 区域被重置成直角矩形时 (1,1) 会在区域内；圆角区域必然裁掉它，
        // 而圆心 (r,r) 必须在区域内（确认不是把内容裁没了的退化区域）。
        let radius_ok = if r <= 1 {
            PtInRegion(rgn, 1, 1) != 0
        } else {
            PtInRegion(rgn, 1, 1) == 0 && PtInRegion(rgn, r, r) != 0
        };
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

    /// 弹窗/Win10 路径的区域半径必须与 CSS 逻辑半径同值换算（不额外内收）。
    #[test]
    fn rounded_region_radius_matches_css_physical_radius() {
        assert_eq!(rounded_region_radius(18.0, 1.25), 23); // 22.5 → round
        assert_eq!(rounded_region_radius(20.0, 1.25), 25);
        assert_eq!(rounded_region_radius(18.0, 1.0), 18);
        assert_eq!(rounded_region_radius(20.0, 1.0), 20);
        assert_eq!(rounded_region_radius(0.0, 1.25), 0, "直角窗口不产生圆角");
        assert_eq!(
            rounded_region_radius(f64::NAN, 1.25),
            23,
            "非法半径按 18 收敛"
        );
        assert_eq!(rounded_region_radius(18.0, 0.0), 18, "非法 DPI 回退 1");
    }

    /// 胶囊区域缓存按「尺寸 / DPI / 参数 / hwnd」判定：任一变化都必须重做。
    #[test]
    fn capsule_stamp_invalidates_on_size_dpi_and_params() {
        let base = CapsuleStamp {
            hwnd: 7,
            width: 72,
            height: 500,
            scale_milli: 1000,
            params: CapsuleParams {
                edge: 0,
                thickness_css: 56,
                length_css: 270,
                expanded: false,
                tab: false,
            },
        };
        let mut cache = RegionCache::new();
        assert!(!cache.capsule_is_current(&base), "未应用过不得命中");
        cache.update_capsule(base);
        assert!(cache.capsule_is_current(&base), "同参数必须命中");

        let variants = [
            CapsuleStamp {
                params: CapsuleParams {
                    expanded: true,
                    ..base.params
                },
                ..base
            },
            CapsuleStamp {
                params: CapsuleParams {
                    edge: 1,
                    ..base.params
                },
                ..base
            },
            CapsuleStamp {
                params: CapsuleParams {
                    thickness_css: 60,
                    ..base.params
                },
                ..base
            },
            CapsuleStamp {
                params: CapsuleParams {
                    length_css: 240,
                    ..base.params
                },
                ..base
            },
            CapsuleStamp {
                height: 501,
                ..base
            },
            CapsuleStamp {
                scale_milli: 1250,
                ..base
            },
            CapsuleStamp { hwnd: 9, ..base },
        ];
        for variant in variants {
            assert!(
                !cache.capsule_is_current(&variant),
                "变化 {variant:?} 必须让缓存失效"
            );
        }

        // 重建成功后重新记录，命中恢复；窗口销毁后整条记录清除。
        cache.update_capsule(variants[0]);
        assert!(cache.capsule_is_current(&variants[0]));
        cache.forget(base.hwnd);
        assert!(!cache.capsule_is_current(&base));
        assert!(!cache.capsule_is_current(&variants[0]));
    }

    /// 整窗圆角缓存与胶囊缓存互不冒充：同尺寸下两种形态必须各自重建。
    #[test]
    fn full_and_capsule_stamps_do_not_cross_hit() {
        let mut cache = RegionCache::new();
        cache.update(RegionStamp {
            hwnd: 7,
            width: 500,
            height: 72,
            radius: 20,
            scale_milli: 1000,
        });
        let capsule = CapsuleStamp {
            hwnd: 7,
            width: 500,
            height: 72,
            scale_milli: 1000,
            params: CapsuleParams {
                edge: 2,
                thickness_css: 56,
                length_css: 270,
                expanded: false,
                tab: false,
            },
        };
        assert!(!cache.capsule_is_current(&capsule));
    }

    /// 圆角区域必须逐行覆盖 CSS 实际着色像素（含极低 alpha 外沿），
    /// 且不覆盖完全透明像素：否则要么切出 GDI 硬边，要么露出非激活态白底。
    #[test]
    fn css_support_left_matches_real_aa_pixels() {
        // 125% DPI、dream 18px → CSS 物理半径 22.5；真机首着色像素实测值
        // （round3 / round4 截图逐行 profile）：15/13/11/9/7/3。
        let r = 22.5;
        let h = 560;
        for (y, expect) in [(0, 15), (1, 13), (2, 11), (3, 9), (5, 7), (10, 3)] {
            assert_eq!(css_support_left(y, h, r), expect, "top y={y}");
            assert_eq!(
                css_support_left(h - 1 - y, h, r),
                expect,
                "bottom mirror y={y}"
            );
        }
        assert_eq!(css_support_left(100, h, r), 0, "直边中段必须全宽");
        // 125% DPI、liquid 20px → 25 物理半径：切点第一像素 = 17。
        assert_eq!(css_support_left(0, h, 25.0), 17);
        // 100% DPI、18px：第一像素 = 12。
        assert_eq!(css_support_left(0, h, 18.0), 12);
        assert_eq!(css_support_left(0, h, 0.0), 0, "直角窗口全宽");
        assert_eq!(css_support_left(0, 0, r), 0, "退化高度不越界");
    }

    /// 右键菜单弹窗（CSS 16px）在 100/125/150/200% 下的区域几何：
    /// 物理半径按 DPI 取整，弧首行必须保留 AA 支撑、逐行单调收窄、
    /// 半径行之后转为直边。锁住「菜单圆角不随 DPI 产生阶梯/缺角」。
    #[test]
    fn popup_support_region_scales_with_dpi() {
        let h = 592;
        for scale in [1.0f64, 1.25, 1.5, 2.0] {
            let r = rounded_region_radius(crate::context_menu::MENU_RADIUS, scale);
            assert!(r > 1, "scale={scale}");
            // 首行必须切掉透明像素（保留 AA 外沿），但不能整行截断
            let first = css_support_left(0, h, r as f64);
            assert!(first > 0 && first < r, "scale={scale} first={first}");
            let mut prev = first;
            for y in 1..r - 1 {
                let x = css_support_left(y, h, r as f64);
                assert!(x <= prev, "scale={scale} y={y} 弧必须单调收窄");
                assert!(x <= r - 1);
                prev = x;
            }
            assert_eq!(css_support_left(r, h, r as f64), 0, "scale={scale} 转直边");
            assert_eq!(
                css_support_left(h - 1, h, r as f64),
                first,
                "scale={scale} 底边镜像"
            );
        }
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

    /// 回归契约（2026-11-02 停靠胶囊「整窗轮廓 + 外阴影」根因）：
    /// 胶囊态与整窗正常态都**不得**设置 DWM `DWMWCP_ROUND` —— ROUND 会让 DWM 按
    /// **整个窗口矩形**绘制圆角系统边框 + 外部投影（窗口内部仍透明，浅色背景透出
    /// 成「白板」观感），`SetWindowRgn` 的胶囊区域裁不到这层（真机同刻 PrintWindow
    /// 只有胶囊、CopyFromScreen 是整窗轮廓 + 阴影）。
    /// 只有整窗区域写入失败、退回系统圆角的兜底路径才允许 ROUND。
    #[test]
    fn dwm_round_is_never_used_for_capsule_or_full_region() {
        assert!(
            !dwm_rounded_for(MainRegionShape::Capsule),
            "胶囊态必须 DONOTROUND：否则 DWM 会沿整窗矩形画系统边框/外阴影"
        );
        assert!(
            !dwm_rounded_for(MainRegionShape::Full),
            "整窗正常态必须 DONOTROUND：可见外形由自定义区域定义，8 DIP 系统弧会二次切割"
        );
        assert!(
            dwm_rounded_for(MainRegionShape::FullFallback),
            "只有区域写入失败的系统圆角兜底才允许 ROUND"
        );
    }

    /// 右键菜单弹窗与主窗同一契约：区域成功后必须 DONOTROUND。
    /// 2026-11-04 真机根因：弹窗同时被 Win32 圆角区域（GDI 硬边）与
    /// DWM `DWMWCP_ROUND`（8 DIP 系统弧）裁剪，四角出现双弧/月牙缝/阶梯锯齿。
    #[test]
    fn dwm_round_is_never_used_for_popup_region() {
        assert!(
            !dwm_rounded_for_popup(true),
            "弹窗区域成功时必须 DONOTROUND：可见外形由区域 + CSS AA 弧定义"
        );
        assert!(
            dwm_rounded_for_popup(false),
            "只有弹窗区域写入失败才允许 ROUND 兜底"
        );
    }

    // ── 重入调度（P2-01）：目标类型 / 半径 / HWND 隔离 ─────────────

    const POPUP_16: PendingShape = PendingShape {
        target: ShapeTarget::Popup,
        radius_milli: 16_000,
    };
    const MAIN_18: PendingShape = PendingShape {
        target: ShapeTarget::Main,
        radius_milli: 18_000,
    };

    #[test]
    fn popup_reentry_preserves_target_and_radius() {
        let mut gate = ApplyGate::default();
        assert!(gate.try_enter(11), "首次进入必须成功");
        assert!(!gate.try_enter(11), "同 hwnd 重入必须被拦下");
        gate.defer(11, POPUP_16);
        // 补偿重算只能拿回 Popup/16px，不能回落到 Main/18px。
        assert_eq!(gate.take(11), Some(POPUP_16));
        assert_eq!(POPUP_16.radius_milli as f64 / 1000.0, 16.0);
    }

    #[test]
    fn main_and_popup_requests_do_not_cross() {
        let mut gate = ApplyGate::default();
        assert!(gate.try_enter(1), "主窗进入");
        assert!(gate.try_enter(2), "不同 hwnd 不得被同一把锁阻塞");
        gate.defer(2, POPUP_16);
        gate.defer(1, MAIN_18);
        assert_eq!(
            gate.take(1).map(|p| p.target),
            Some(ShapeTarget::Main),
            "主窗请求不得被弹窗参数覆盖"
        );
        assert_eq!(
            gate.take(2).map(|p| p.target),
            Some(ShapeTarget::Popup),
            "弹窗请求不得被主窗参数覆盖"
        );
        assert_eq!(gate.take(1), None, "取走后不得重复执行");
        gate.leave(1);
        gate.leave(2);
        assert!(gate.try_enter(1), "离开后必须能再次进入");
    }

    #[test]
    fn latest_reentry_request_wins_per_hwnd() {
        let mut gate = ApplyGate::default();
        assert!(gate.try_enter(7));
        gate.defer(7, POPUP_16);
        gate.defer(
            7,
            PendingShape {
                target: ShapeTarget::Popup,
                radius_milli: 20_000,
            },
        );
        assert_eq!(gate.take(7).unwrap().radius_milli, 20_000);
    }

    /// 同参数重入：请求按最新一条记录，外层只能取走一次（不丢、不重复执行）。
    #[test]
    fn same_shape_reentry_is_kept_and_consumed_once() {
        let mut gate = ApplyGate::default();
        assert!(gate.try_enter(9));
        assert!(!gate.try_enter(9), "同 hwnd 重入必须被拦下");
        gate.defer(9, POPUP_16);
        assert_eq!(gate.take(9), Some(POPUP_16));
        assert_eq!(gate.take(9), None, "补偿不得重复执行");
        gate.leave(9);
        assert!(gate.try_enter(9), "收敛后必须能再次进入");
    }

    /// 期间多次请求（含目标变化）：下一 pass 只能用最新参数，旧请求不得回写。
    #[test]
    fn latest_pending_replaces_older_target_and_radius() {
        let mut gate = ApplyGate::default();
        assert!(gate.try_enter(3));
        gate.defer(3, POPUP_16);
        gate.defer(3, MAIN_18);
        assert_eq!(gate.take(3), Some(MAIN_18), "必须以最新请求为准");
        assert_eq!(gate.take(3), None, "旧请求不得残留");
    }

    /// P3-01：销毁清理必须覆盖重入调度状态；句柄复用后不得命中旧未决请求。
    #[test]
    fn gate_forget_clears_pending_and_applying_before_hwnd_reuse() {
        let mut gate = ApplyGate::default();
        assert!(gate.try_enter(42));
        assert!(!gate.try_enter(42));
        gate.defer(42, POPUP_16);
        gate.forget(42);
        assert_eq!(gate.take(42), None, "销毁后不得留下未决补偿请求");
        // 句柄被系统复用：新窗口必须能进入，且不受旧状态影响
        assert!(gate.try_enter(42));
        assert_eq!(gate.take(42), None);
    }

    /// 真线程同步（channel 作同步点，不 sleep）：同 hwnd 后到请求被延后记录，
    /// 外层取走后不得丢失。
    #[test]
    fn gate_serializes_same_hwnd_across_threads() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let shared = Arc::new(Mutex::new(ApplyGate::default()));
        assert!(shared.lock().unwrap().try_enter(5));
        let (tx, rx) = mpsc::channel();
        let second = Arc::clone(&shared);
        let handle = std::thread::spawn(move || {
            let mut gate = second.lock().unwrap();
            let entered = gate.try_enter(5);
            if !entered {
                gate.defer(5, POPUP_16);
            }
            tx.send(entered).unwrap();
        });
        let entered = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!entered, "同 hwnd 后到调用必须被延后");
        let mut gate = shared.lock().unwrap();
        gate.leave(5);
        assert_eq!(gate.take(5), Some(POPUP_16), "延后请求不得丢失");
        drop(gate);
        handle.join().unwrap();
    }

    /// 真线程同步（Barrier 在同一临界点放行）：不同 hwnd 互不阻塞。
    #[test]
    fn gate_allows_different_hwnds_concurrently() {
        use std::sync::{mpsc, Arc, Barrier};

        let shared = Arc::new(Mutex::new(ApplyGate::default()));
        let barrier = Arc::new(Barrier::new(2));
        let (tx, rx) = mpsc::channel();
        let handles: Vec<_> = [1isize, 2isize]
            .into_iter()
            .map(|hwnd| {
                let gate = Arc::clone(&shared);
                let barrier = Arc::clone(&barrier);
                let tx = tx.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let entered = gate.lock().unwrap().try_enter(hwnd);
                    tx.send((hwnd, entered)).unwrap();
                })
            })
            .collect();
        for _ in 0..2 {
            let (hwnd, entered) = rx.recv().unwrap();
            assert!(entered, "hwnd {hwnd} 被其它窗口阻塞");
        }
        for handle in handles {
            handle.join().unwrap();
        }
    }

    /// 连续尺寸变化只保留最新一次 pass 的尺寸，用于稳定性判定。
    #[test]
    fn repeated_resize_passes_settle_on_latest_size_per_hwnd() {
        let mut cache = RegionCache::new();
        for (w, h) in [(300, 700), (313, 751), (280, 640), (313, 751)] {
            cache.set_last_pass_size(7, (w, h));
        }
        assert_eq!(cache.last_pass_size(7), Some((313, 751)));
        assert_eq!(cache.last_pass_size(8), None, "其它窗口不得共享稳定性记录");
    }

    #[test]
    fn radius_milli_clamps_and_rounds_like_set_radius() {
        assert_eq!(radius_milli(f64::NAN), 18_000, "非法值回退 18");
        assert_eq!(radius_milli(-1.0), 0);
        assert_eq!(radius_milli(40.5), 40_000);
        assert_eq!(radius_milli(16.0), 16_000);
        assert_eq!(radius_milli(16.0004), 16_000);
    }

    /// 窗口销毁后，尺寸/DPI/半径缓存（含稳定性记录）必须一并清除；
    /// 句柄被系统复用后不得误判为「已应用」。
    #[test]
    fn forget_window_clears_stamp_and_stability() {
        let mut cache = RegionCache::new();
        let stamp = RegionStamp {
            hwnd: 5,
            width: 300,
            height: 700,
            radius: 20,
            scale_milli: 1250,
        };
        cache.update(stamp);
        cache.set_last_pass_size(5, (300, 700));
        assert!(cache.is_current(&stamp));
        cache.forget(5);
        assert!(!cache.is_current(&stamp));
        assert!(cache.last_pass_size(5).is_none());
    }

    /// DPI 变化必须让弹窗区域缓存失效并重算（半径物理像素随 scale 变化）。
    #[test]
    fn popup_stamp_invalidates_on_dpi_change() {
        let stamp = RegionStamp {
            hwnd: 5,
            width: 300,
            height: 700,
            radius: 20,
            scale_milli: 1250,
        };
        let mut cache = RegionCache::new();
        cache.update(stamp);
        assert!(cache.is_current(&stamp));
        for scale in [1000, 1500, 2000] {
            assert!(
                !cache.is_current(&RegionStamp {
                    scale_milli: scale,
                    ..stamp
                }),
                "scale={scale} 必须失效"
            );
        }
    }

    // ── 分类胶囊区域几何 ──────────────────────────────────────

    const CAP: CapsuleParams = CapsuleParams {
        edge: 0,
        thickness_css: 56,
        length_css: 270,
        expanded: false,
        tab: false,
    };
    /// 胶囊容器（前端在停靠时把窗口撑到该尺寸）：
    /// 垂直停靠 404×446（高 = 轨道外框 446 > 面板 440）。
    const CONTAINER_W: i32 = 404;
    const CONTAINER_H: i32 = 446;
    /// 水平停靠容器：宽 446（轨道外框 446 > 面板宽 340），高 56+8+440 = 504。
    const CONTAINER_W_HORIZ: i32 = 446;
    const CONTAINER_H_HORIZ: i32 = 504;

    /// CSS → 物理像素：与前端 `toPhysical`（`round(css×scale)`，最小 1）一致。
    fn container_physical(css: i32, scale: f64) -> i32 {
        ((css as f64) * scale).round().max(1.0) as i32
    }

    /// 展开态面板必须完整包含在窗口内（四边 × 1.0/1.25/1.5 DPI）。
    ///
    /// 历史缺陷日志：`w=500 h=700 edge=0 px=80 py=75 pw=425 ph=550`
    /// （1.25 DPI 下右边界超出 5px），面板被窗口裁掉。当前实现在越界时返回
    /// `None`；本测试锁定「按容器尺寸撑窗后，四边、多 DPI 都必须成功，且面板
    /// 四边不越界、尺寸不被钳小」的契约，防止再次退化成静默裁剪。
    #[test]
    fn expanded_panel_is_contained_on_all_edges_and_dpis() {
        for scale in [1.0f64, 1.25, 1.5] {
            for edge in 0u8..4 {
                let horizontal = edge >= 2;
                let (w, h) = if horizontal {
                    (
                        container_physical(CONTAINER_W_HORIZ, scale),
                        container_physical(CONTAINER_H_HORIZ, scale),
                    )
                } else {
                    (
                        container_physical(CONTAINER_W, scale),
                        container_physical(CONTAINER_H, scale),
                    )
                };
                let set = capsule_regions(
                    w,
                    h,
                    scale,
                    &CapsuleParams {
                        edge,
                        expanded: true,
                        ..CAP
                    },
                )
                .unwrap_or_else(|| panic!("edge={edge} scale={scale} 容器 {w}x{h} 内展开必须成功"));
                let panel = set
                    .panel
                    .unwrap_or_else(|| panic!("edge={edge} scale={scale} 展开态必须有面板"));
                assert!(
                    panel.x >= 0
                        && panel.y >= 0
                        && panel.x + panel.width <= w
                        && panel.y + panel.height <= h,
                    "edge={edge} scale={scale} 面板越界: panel=({}, {}, {}x{}) window={w}x{h}",
                    panel.x,
                    panel.y,
                    panel.width,
                    panel.height
                );
                // 面板必须保持设计尺寸：越界时唯一允许的结果是整体失败（None），
                // 不能把面板钳小后仍报告成功。
                assert_eq!(
                    (panel.width, panel.height),
                    (
                        container_physical(CAPSULE_PANEL_WIDTH_CSS as i32, scale),
                        container_physical(CAPSULE_PANEL_HEIGHT_CSS as i32, scale),
                    ),
                    "edge={edge} scale={scale} 面板不得被容器裁剪/缩小"
                );
                // 轨道轮廓（联合区域的另一半）同样不得越界。
                for &(px, py) in &set.rail_polygon {
                    assert!(
                        (0..=w).contains(&px) && (0..=h).contains(&py),
                        "edge={edge} scale={scale} 轨道轮廓越界 ({px},{py})"
                    );
                }
            }
        }
    }

    /// 容器差 1px 时展开必须整体失败（宁可展开失败也不能裁掉面板）。
    ///
    /// 关键维度是**堆叠轴**：垂直停靠为窗口宽（轨道+间隙+面板），水平停靠为
    /// 窗口高。另一维只是面板尺寸的上限（`panel.min(window)`），减 1px 会把
    /// 面板钳小而不会越界，因此不能用来验证拒绝契约。
    #[test]
    fn expanded_panel_rejects_window_below_container() {
        for scale in [1.0f64, 1.25, 1.5] {
            for edge in 0u8..4 {
                let horizontal = edge >= 2;
                let (w, h) = if horizontal {
                    (
                        container_physical(CONTAINER_W_HORIZ, scale),
                        container_physical(CONTAINER_H_HORIZ, scale) - 1,
                    )
                } else {
                    (
                        container_physical(CONTAINER_W, scale) - 1,
                        container_physical(CONTAINER_H, scale),
                    )
                };
                assert!(
                    capsule_regions(
                        w,
                        h,
                        scale,
                        &CapsuleParams {
                            edge,
                            expanded: true,
                            ..CAP
                        }
                    )
                    .is_none(),
                    "edge={edge} scale={scale} 窗口 {w}x{h} 不足容器时必须返回 None"
                );
            }
        }
    }

    #[test]
    fn capsule_contract_matches_frontend_constants() {
        // 跨端契约：与 src/lib/capsuleLayout.ts 同一组数字（两端各有单测）
        assert_eq!(CAP.thickness_css, 56);
        assert_eq!(CAP.length_css, 270);
        assert_eq!(CAPSULE_SHOULDER_CSS, 88);
        assert_eq!(WING_SAMPLES, 18);
        assert_eq!(CAPSULE_PANEL_WIDTH_CSS, 340);
        assert_eq!(CAPSULE_PANEL_HEIGHT_CSS, 440);
        assert_eq!(CAPSULE_GAP_CSS, 8);
        assert_eq!(CAPSULE_PANEL_RADIUS_CSS, 24);
    }

    /// 射线法点内判定（与 `CreatePolygonRgn` 的填充语义一致，仅测试用）。
    fn poly_contains(poly: &[(i32, i32)], px: i32, py: i32) -> bool {
        let mut inside = false;
        let n = poly.len();
        for i in 0..n {
            let a = poly[i];
            let b = poly[(i + n - 1) % n];
            if (a.1 > py) != (b.1 > py) {
                let x = (b.0 - a.0) as f64 * (py - a.1) as f64 / (b.1 - a.1) as f64 + a.0 as f64;
                if (px as f64) < x {
                    inside = !inside;
                }
            }
        }
        inside
    }

    #[test]
    fn wing_outline_golden_points_match_frontend() {
        // 金标准点位（100%、bottom、inflate=0）：前端 capsuleShape.test.ts 断言同一组
        // 数字。任何一侧改动采样段数/映射/参数都会让这里先红。
        let (bw, bh, pts) = wing_outline(3, 1.0, 56, 270, 0.0);
        assert_eq!((bw, bh), (446, 56), "外框 = 平直主体 270 + 两侧肩部 88");
        assert_eq!(pts.len(), 38, "两侧各 19 个贝塞尔采样点（含端点）");
        let at = |i: usize| (pts[i].0.round() as i32, pts[i].1.round() as i32);
        // 贴边尖端：切线水平，落在下缘（局部 y = 高度）
        assert_eq!(at(0), (0, 56));
        assert_eq!(at(37), (446, 56));
        // 肩部中段（v = 厚度/2）与接近贴边处
        assert_eq!(at(9), (48, 28));
        assert_eq!(at(13), (63, 11));
        // 平直主体两端：顶边完整 270px
        assert_eq!(at(18), (88, 0));
        assert_eq!(at(19), (358, 0));
        // 左右对称：镜像点逐点重合（浮点比较，容差 1e-9）
        for i in 0..pts.len() {
            let a = pts[i];
            let b = pts[pts.len() - 1 - i];
            assert!(
                (a.0 - (bw as f64 - b.0)).abs() < 1e-9,
                "对称性在第 {i} 点破裂"
            );
            assert!((a.1 - b.1).abs() < 1e-9, "对称性在第 {i} 点破裂");
        }
    }

    #[test]
    fn wing_region_is_flush_not_bounding_box() {
        // 折叠态：区域必须是翼片轮廓，而不是外框矩形——缺角探针在区域外。
        let s = capsule_regions(CONTAINER_W, CONTAINER_H, 1.0, &CAP).unwrap();
        let (nx, ny) = s.notch_probe.expect("应有缺角探针");
        assert!(s.rail.contains(nx, ny), "缺角探针必须落在轨道外框内");
        assert!(
            !poly_contains(&s.rail_polygon, nx, ny),
            "缺角必须落在翼片之外"
        );
        // 轨道中心（图标区）在区域内
        let (cx, cy) = s.rail.center();
        assert!(poly_contains(&s.rail_polygon, cx, cy));
        // 贴边侧整条都是形状（与屏幕边缘齐平，无缝）：沿边中线附近逐点命中
        for y in [s.rail.y + 2, 210, s.rail.y + s.rail.height - 2] {
            assert!(poly_contains(&s.rail_polygon, 1, y), "flush x=1 y={y}");
        }
    }

    #[test]
    fn capsule_rail_is_flush_to_dock_side_and_centered() {
        // 100%：left → 轨道贴窗口左缘、垂直居中、外框 56×446（主体 270 + 两侧肩部 88）
        let s = capsule_regions(CONTAINER_W, CONTAINER_H, 1.0, &CAP).unwrap();
        assert_eq!(
            (s.rail.x, s.rail.y, s.rail.width, s.rail.height),
            (0, (446 - 446) / 2, 56, 446)
        );
        assert!(s.panel.is_none(), "折叠态不得包含面板区域");
        // 区域多边形含 2px AA 外扩：内侧与两端各多 2px，贴边侧被窗口裁掉
        assert_eq!(s.bounds(), (0, 0, 58, 446));

        // right → 贴窗口右缘
        let s = capsule_regions(
            CONTAINER_W,
            CONTAINER_H,
            1.0,
            &CapsuleParams { edge: 1, ..CAP },
        )
        .unwrap();
        assert_eq!((s.rail.x, s.rail.y), (404 - 56, 0));
        // top → 贴窗口上缘的横向轨道 446×56（x 由容器宽度居中）
        let s = capsule_regions(
            CONTAINER_W_HORIZ,
            CONTAINER_H_HORIZ,
            1.0,
            &CapsuleParams { edge: 2, ..CAP },
        )
        .unwrap();
        assert_eq!(
            (s.rail.x, s.rail.y, s.rail.width, s.rail.height),
            ((446 - 446) / 2, 0, 446, 56)
        );
        // bottom → 贴窗口下缘
        let s = capsule_regions(
            CONTAINER_W_HORIZ,
            CONTAINER_H_HORIZ,
            1.0,
            &CapsuleParams { edge: 3, ..CAP },
        )
        .unwrap();
        assert_eq!(
            (s.rail.x, s.rail.y, s.rail.width, s.rail.height),
            ((446 - 446) / 2, 504 - 56, 446, 56)
        );
    }

    #[test]
    fn wing_mirrors_across_four_edges() {
        // 四边同一套形状：外框沿边尺寸相同、贴边侧坐标一致，只是朝向不同。
        for (edge, expect_flush) in [(0u8, (0, 0)), (1, (404 - 56, 0))] {
            let s = capsule_regions(
                CONTAINER_W,
                CONTAINER_H,
                1.0,
                &CapsuleParams { edge, ..CAP },
            )
            .unwrap();
            assert_eq!((s.rail.x, s.rail.y), expect_flush, "edge={edge}");
            assert_eq!((s.rail.width, s.rail.height), (56, 446), "edge={edge}");
            let (nx, ny) = s.notch_probe.unwrap();
            assert!(
                !poly_contains(&s.rail_polygon, nx, ny),
                "edge={edge} 缺角在外"
            );
        }
        for (edge, expect_flush) in [(2u8, (0, 0)), (3, (0, 504 - 56))] {
            let s = capsule_regions(
                CONTAINER_W_HORIZ,
                CONTAINER_H_HORIZ,
                1.0,
                &CapsuleParams { edge, ..CAP },
            )
            .unwrap();
            assert_eq!((s.rail.x, s.rail.y), expect_flush, "edge={edge}");
            assert_eq!((s.rail.width, s.rail.height), (446, 56), "edge={edge}");
            let (nx, ny) = s.notch_probe.unwrap();
            assert!(
                !poly_contains(&s.rail_polygon, nx, ny),
                "edge={edge} 缺角在外"
            );
        }
    }

    #[test]
    fn edge_tab_regions_are_flush_and_inside_on_all_edges() {
        let tab_w = CAPSULE_TAB_WIDTH_CSS as i32;
        let tab_h = CAPSULE_TAB_HEIGHT_CSS as i32;
        for (edge, w, h) in [
            (0u8, CONTAINER_W, CONTAINER_H),
            (1, CONTAINER_W, CONTAINER_H),
            (2, CONTAINER_W_HORIZ, CONTAINER_H_HORIZ),
            (3, CONTAINER_W_HORIZ, CONTAINER_H_HORIZ),
        ] {
            let s = capsule_regions(
                w,
                h,
                1.0,
                &CapsuleParams {
                    edge,
                    tab: true,
                    ..CAP
                },
            )
            .unwrap();
            let vertical = edge <= 1;
            let (rect_w, rect_h) = if vertical {
                (tab_w, tab_h)
            } else {
                (tab_h, tab_w)
            };
            assert_eq!(
                (s.rail.width, s.rail.height),
                (rect_w, rect_h),
                "edge={edge}"
            );
            let expect = match edge {
                0 => (0, (h - rect_h) / 2),
                1 => (w - rect_w, (h - rect_h) / 2),
                2 => ((w - rect_w) / 2, 0),
                _ => ((w - rect_w) / 2, h - rect_h),
            };
            assert_eq!((s.rail.x, s.rail.y), expect, "edge={edge} 应贴边");
            for &(px, py) in &s.rail_polygon {
                assert!(
                    (0..=w).contains(&px) && (0..=h).contains(&py),
                    "edge={edge} 轮廓越界 ({px},{py})"
                );
            }
            let (nx, ny) = s.notch_probe.expect("标签应有缺角探针");
            assert!(
                !poly_contains(&s.rail_polygon, nx, ny),
                "edge={edge} 靠内两角应为圆角（缺角在区域外）"
            );
        }
    }

    #[test]
    fn capsule_expanded_region_is_rail_or_panel_with_gap() {
        // left 展开：面板在轨道内侧（右），同轴居中，间隙 8px
        let s = capsule_regions(
            CONTAINER_W,
            CONTAINER_H,
            1.0,
            &CapsuleParams {
                expanded: true,
                ..CAP
            },
        )
        .unwrap();
        let p = s.panel.expect("展开态必须有面板区域");
        assert_eq!((p.x, p.y, p.width, p.height), (56 + 8, (446 - 440) / 2, 340, 440));
        assert_eq!(p.radius, 22, "面板区域半径比 CSS 24px 内收 2px");
        // 联合包围盒 = 整块容器
        assert_eq!(s.bounds(), (0, 0, 404, 446));
        // 间隙中点必须落在区域之外（两块区域不连通）
        let (gx, gy) = s.gap_probe.expect("展开态应有间隙探针");
        assert!(!poly_contains(&s.rail_polygon, gx, gy));
        assert!(!p.contains(gx, gy));

        // right 展开：面板在轨道左侧，同样不越界
        let s = capsule_regions(
            CONTAINER_W,
            CONTAINER_H,
            1.0,
            &CapsuleParams {
                edge: 1,
                expanded: true,
                ..CAP
            },
        )
        .unwrap();
        let p = s.panel.unwrap();
        assert_eq!((p.x, p.width), (0, 340));
        assert_eq!(s.rail.x, 404 - 56);

        // top 展开：面板在轨道下方
        let s = capsule_regions(
            CONTAINER_W_HORIZ,
            CONTAINER_H_HORIZ,
            1.0,
            &CapsuleParams {
                edge: 2,
                expanded: true,
                ..CAP
            },
        )
        .unwrap();
        let p = s.panel.unwrap();
        assert_eq!((p.x, p.y, p.width, p.height), (53, 56 + 8, 340, 440));

        // bottom 展开：面板在轨道上方
        let s = capsule_regions(
            CONTAINER_W_HORIZ,
            CONTAINER_H_HORIZ,
            1.0,
            &CapsuleParams {
                edge: 3,
                expanded: true,
                ..CAP
            },
        )
        .unwrap();
        let p = s.panel.unwrap();
        assert_eq!((p.x, p.y), (53, 504 - 56 - 8 - 440));
    }

    #[test]
    fn capsule_region_scales_with_dpi() {
        // 厚度 56→70→84；沿边外框 = 主体 + 2×肩宽（100%: 270+176=446，
        // 125%: 338+220=558，150%: 405+264=669）
        for (scale, t, along) in [(1.0f64, 56i32, 446i32), (1.25, 70, 558), (1.5, 84, 669)] {
            let s = capsule_regions(2000, 2000, scale, &CAP).unwrap();
            assert_eq!((s.rail.width, s.rail.height), (t, along), "scale={scale}");
            // 缺角探针在任何 DPI 下都必须落在翼片之外
            let (nx, ny) = s.notch_probe.unwrap();
            assert!(!poly_contains(&s.rail_polygon, nx, ny), "scale={scale}");
        }
    }

    #[test]
    fn capsule_region_rejects_degenerate_and_drops_overflow_panel() {
        assert!(capsule_regions(
            400,
            420,
            1.0,
            &CapsuleParams {
                thickness_css: 0,
                ..CAP
            }
        )
        .is_none());
        assert!(capsule_regions(0, 420, 1.0, &CAP).is_none());
        assert!(capsule_regions(400, -5, 1.0, &CAP).is_none());
        assert!(
            capsule_regions(400, 420, 0.0, &CAP).is_some(),
            "非法 DPI 回退 1"
        );

        // 窗口太窄放不下面板：展开请求必须整体失败，不能退化成「只裁轨道」后
        // 仍报告成功（否则前端提交 docked-revealed，面板控件被裁进翼片）。
        assert!(capsule_regions(
            120,
            420,
            1.0,
            &CapsuleParams {
                expanded: true,
                ..CAP
            }
        )
        .is_none());
        // 折叠态同样宽度只要求容纳轨道，仍应成功
        assert!(capsule_regions(120, 420, 1.0, &CAP).is_some());
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
                446,
                504,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "CreateWindowExW 失败");

            // 真实 Win32 窗口上逐边应用「折叠 / 展开」区域并回读验证：
            // 折叠 = 单块翼片多边形；展开 = 轨道 ∪ 面板（CombineRgn OR），
            // 包围盒、两块中心、间隙中点、外框缺角都必须与几何一致。
            let apply_region = |edge: u8, expanded: bool| -> CapsuleRegionSet {
                use windows_sys::Win32::Foundation::POINT;
                use windows_sys::Win32::Graphics::Gdi::{CreatePolygonRgn, WINDING};
                // 容器：垂直 404×446 / 水平 446×504，四边都能放下轨道与面板
                let cap = CapsuleParams {
                    edge,
                    expanded,
                    ..CAP
                };
                let (w, h) = if edge <= 1 { (404, 446) } else { (446, 504) };
                let set = capsule_regions(w, h, 1.0, &cap).unwrap();
                let pts: Vec<POINT> = set
                    .rail_polygon
                    .iter()
                    .map(|&(x, y)| POINT { x, y })
                    .collect();
                let rgn = CreatePolygonRgn(pts.as_ptr(), pts.len() as i32, WINDING);
                assert!(!rgn.is_null());
                if let Some(p) = set.panel {
                    // 与生产路径一致：面板圆角用逐行像素支撑区域（不是 GDI 硬边椭圆）
                    let pr = support_rect_rgn(p.x, p.y, p.width, p.height, p.radius as f64)
                        .expect("面板支撑区域");
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

            // 四边折叠：只有轨道，外框尺寸随方向变化（主体 270 + 两侧肩部 88）
            let left = apply_region(0, false);
            assert_eq!((left.rail.width, left.rail.height), (56, 446));
            assert!(left.panel.is_none());
            let top = apply_region(2, false);
            assert_eq!(
                (top.rail.width, top.rail.height),
                (446, 56),
                "顶边必须横向 446×56"
            );

            // 四边展开：轨道 + 面板联合区域，间隙处不连通
            for edge in [0u8, 1, 2, 3] {
                let set = apply_region(edge, true);
                assert!(set.panel.is_some(), "edge={edge} 展开必须有面板");
                let (gx, gy) = set.gap_probe.unwrap();
                assert!(gx >= 0 && gy >= 0);
            }

            // 生产路径的重复 apply（Moved/Focused 高频事件会走到这里）：
            // 第一次重建并写缓存，第二次命中缓存但必须仍通过 GetWindowRgn 回读校验。
            let cap = CapsuleParams {
                edge: 3,
                expanded: true,
                ..CAP
            };
            assert!(apply_capsule_pass(hwnd as isize, 446, 504, 1.0, cap, false));
            assert!(
                apply_capsule_pass(hwnd as isize, 446, 504, 1.0, cap, false),
                "缓存命中后回读校验必须仍然成立"
            );

            // 清理：恢复无区域并销毁窗口
            let full = CreateRoundRectRgn(0, 0, 401, 485, 36, 36);
            SetWindowRgn(hwnd as _, full, 1);
            DeleteObject(full as _);
            DestroyWindow(hwnd as HWND);
        }
    }

    /// **OS 层行为验证**（2026-11-02 停靠胶囊残留修复的机制证据；真实 Win32 窗口、
    /// 不可见、不影响桌面）：
    ///
    /// 1. `SetWindowRgn` 设置的小区域（胶囊类 72×500）在
    ///    `SetWindowLongW(GWL_STYLE)` + `SetWindowPos(SWP_FRAMECHANGED)` 之后**不会被
    ///    重置**——排除「磁力层停靠/解除时改写样式会把区域打回整窗」这条怀疑；
    /// 2. DWM 角偏好在带区域的窗口上可写可读（DONOTROUND=1 / ROUND=2），且写 DWM
    ///    属性不会清掉窗口区域——证明「区域」与「DWM 合成层」是两层，互不替代。
    ///
    /// 这两条是「ROUND 只改 DWM 层、区域回读仍只有胶囊，但屏幕上是整窗系统边框 +
    /// 投影」的结构性前提，纯几何单测算不出来。
    #[cfg(windows)]
    #[test]
    fn window_region_survives_style_change_and_dwm_attributes() {
        use windows_sys::Win32::Foundation::{HWND, RECT};
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
        use windows_sys::Win32::Graphics::Gdi::{
            CreateRectRgn, DeleteObject, GetRgnBox, GetWindowRgn, PtInRegion, SetWindowRgn,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongW, RegisterClassW,
            SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_NOZORDER, WNDCLASSW, WS_MAXIMIZEBOX, WS_POPUP,
        };

        const CLASS_NAME: &[u16] = &[b'T' as u16, b'D' as u16, b'_' as u16, b'D' as u16, 0];
        const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
        const EXPECT_BBOX: (i32, i32, i32, i32) = (438, 25, 510, 525);

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

            // 不可见窗口（不传 WS_VISIBLE），几何与真机胶囊容器同量级
            let hwnd = CreateWindowExW(
                0,
                CLASS_NAME.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                -2000,
                -2000,
                510,
                550,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "CreateWindowExW 失败");

            // 右侧轨道类区域（真机 box=438,25,510,525）
            let rgn = CreateRectRgn(EXPECT_BBOX.0, EXPECT_BBOX.1, EXPECT_BBOX.2, EXPECT_BBOX.3);
            assert!(!rgn.is_null());
            assert_ne!(SetWindowRgn(hwnd as _, rgn, 1), 0, "SetWindowRgn 失败");

            // 区域的包围盒 + 点包含关系（区域内/区域外各取一点）
            let read_bbox = || -> RECT {
                let probe = CreateRectRgn(0, 0, 0, 0);
                assert!(!probe.is_null());
                let kind = GetWindowRgn(hwnd as _, probe);
                assert_ne!(kind, 0, "窗口应带区域");
                let mut box_ = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                assert_ne!(GetRgnBox(probe, &mut box_), 0, "GetRgnBox 失败");
                assert!(PtInRegion(probe, 500, 300) != 0, "轨道中心必须在区域内");
                assert!(PtInRegion(probe, 100, 300) == 0, "轨道外必须不在区域内");
                DeleteObject(probe as _);
                box_
            };
            let bbox = |r: RECT| (r.left, r.top, r.right, r.bottom);
            assert_eq!(bbox(read_bbox()), EXPECT_BBOX);

            // 磁力层停靠/解除路径：改写 GWL_STYLE 后必须 SWP_FRAMECHANGED 才生效
            let style = GetWindowLongW(hwnd as _, GWL_STYLE) as u32;
            assert_ne!(
                SetWindowLongW(hwnd as _, GWL_STYLE, (style | WS_MAXIMIZEBOX) as i32),
                0,
                "SetWindowLongW(GWL_STYLE) 失败"
            );
            SetWindowPos(
                hwnd as _,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            assert_eq!(
                bbox(read_bbox()),
                EXPECT_BBOX,
                "样式变更 + SWP_FRAMECHANGED 不得重置窗口区域"
            );

            // DWM 角偏好：可写可读，且与窗口区域互不影响
            let set_corner = |want: i32| {
                let hr = DwmSetWindowAttribute(
                    hwnd as _,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &want as *const i32 as *const std::ffi::c_void,
                    std::mem::size_of::<i32>() as u32,
                );
                assert_eq!(hr, 0, "DwmSetWindowAttribute(corner={want}) 失败");
                assert_eq!(
                    dwm_get_i32(hwnd as isize, DWMWA_WINDOW_CORNER_PREFERENCE),
                    Some(want),
                    "DWM 角偏好回读不一致"
                );
            };
            set_corner(1); // DWMWCP_DONOTROUND（生产策略）
            set_corner(2); // DWMWCP_ROUND（历史缺陷态）
            assert_eq!(
                bbox(read_bbox()),
                EXPECT_BBOX,
                "DWM 属性写入不得清掉/改变窗口区域"
            );
            set_corner(1); // 复位为生产策略，避免影响后续用例

            DestroyWindow(hwnd as HWND);
        }
    }
}
