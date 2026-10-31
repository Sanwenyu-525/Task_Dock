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
                REGIONS.lock()
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

/// 最近一次 pass 实际使用的窗口尺寸：已并入 RegionCache（按 hwnd 隔离）。

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
        assert_eq!(cache.last_pass_size(200), Some((313, 775)));
    }
}
