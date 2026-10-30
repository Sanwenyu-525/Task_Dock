//! 窗口外形（v0.6）：Win32 圆角裁剪 + DWM 角偏好。
//!
//! 背景：本应用是 `decorations:false` + `transparent:true` + `shadow:false` 的无边框窗口。
//! 一旦应用原生 Mica/Acrylic，DWM 会**在整个窗口矩形**上绘制系统背景；CSS 的
//! `border-radius` 只能裁掉 WebView2 自己的内容层，裁不掉 DWM 背景，
//! 于是四角出现深色（近乎黑色）的直角区域 —— 这就是 v0.5 截图里的问题。
//!
//! 这里做两件事，二者互补：
//! 1. `SetWindowRgn(CreateRoundRectRgn)`：在 GDI 层把窗口外形裁成圆角。
//!    这是真正生效的几何裁剪，Win10/11 都可用，DWM 背景与 WebView2 合成层
//!    都会被裁掉，因此四角不会再露底（代价是边缘没有抗锯齿）。
//! 2. `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`（Win11 22000+）：
//!    让系统按 DWM 规则给出抗锯齿圆角与阴影；不支持时该调用只是失败返回，
//!    不影响第 1 步的兜底裁剪。
//!
//! 逻辑半径由前端按视觉预设下发（dream-gradient = 18，liquid-glass = 20），
//! resize / DPI 变化时按同一逻辑半径重算物理像素，避免 125%/150% 缩放下
//! 圆角与 CSS 半径对不上。

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{Runtime, WebviewWindow};

/// 当前圆角半径，存储为「逻辑像素 × 1000」的整数，避免浮点原子。
static RADIUS_MILLI: AtomicU32 = AtomicU32::new(18_000);
/// 防止 SetWindowRgn 触发的窗口事件再次进入自身造成递归。
static APPLYING: AtomicBool = AtomicBool::new(false);
/// 最近一次成功应用的区域参数（物理宽、高、半径）：尺寸没变就不重复裁剪。
static LAST_APPLIED: Mutex<Option<(u32, u32, u32)>> = Mutex::new(None);

/// 诊断开关（环境变量，便于在真机上定位「区域裁剪 / DWM 圆角」对分层窗口的影响）：
/// - `TASK_DOCK_WINDOW_REGION=0`：不设置 Win32 窗口区域（只保留 CSS 圆角）
/// - `TASK_DOCK_WINDOW_DWM_CORNER=0`：不设置 DWM 圆角偏好
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
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

    let Ok(handle) = win.hwnd() else {
        return false;
    };
    let hwnd = handle.0;
    // 用**窗口外框尺寸**（不是客户区）：SetWindowRgn 的坐标是窗口坐标系，
    // 无边框窗口两者相等，但用外框尺寸可以避免在有边框/影子时区域与窗口错位。
    let size = match win.outer_size() {
        Ok(s) if s.width > 0 && s.height > 0 => s,
        _ => return false,
    };
    if APPLYING.swap(true, Ordering::SeqCst) {
        return false;
    }

    let scale = win.scale_factor().unwrap_or(1.0);
    // 物理像素半径：与 CSS 的 border-radius（逻辑像素）保持视觉一致
    let r = (radius() * scale).round() as i32;
    let w = size.width as i32;
    let h = size.height as i32;

    if !flag("TASK_DOCK_WINDOW_REGION") {
        // 诊断模式：不设置窗口区域
        APPLYING.store(false, Ordering::SeqCst);
        return false;
    }

    // 尺寸/半径没变就不重复裁剪：SetWindowRgn 本身很便宜，但每次 resize 都重做
    // 会让「区域状态」与「窗口状态」更容易错位。
    {
        let last = LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((lw, lh, lr)) = *last {
            if lw == size.width && lh == size.height && lr == r as u32 {
                APPLYING.store(false, Ordering::SeqCst);
                return true;
            }
        }
    }

    let ok = unsafe {
        // CreateRoundRectRgn 的右/下边界是开区间，+1 才能覆盖最后一行像素
        let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, (r * 2).max(1), (r * 2).max(1));
        if rgn.is_null() {
            false
        } else if SetWindowRgn(hwnd, rgn, 1) == 0 {
            // 失败时窗口区域未被接管，region 仍归调用方，必须自行释放
            DeleteObject(rgn as _);
            false
        } else {
            // 成功后 region 所有权移交给系统，不能再 DeleteObject
            true
        }
    };

    if ok {
        apply_dwm_corner(hwnd, r > 0);
        let mut last = LAST_APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        *last = Some((size.width, size.height, r as u32));
    }
    APPLYING.store(false, Ordering::SeqCst);
    ok
}

/// 启动后按延迟重算几次区域：窗口在启动阶段会经历「按模式尺寸 → 按记忆矩形 →
/// 前端布局稳定」多次变化，延迟重算能保证区域最终与窗口尺寸一致。
pub fn schedule_reapply<R: Runtime>(win: &WebviewWindow<R>) {
    let w = win.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [150u64, 500, 1200, 2500] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let _ = apply(&w);
        }
    });
}

#[cfg(not(windows))]
pub fn apply<R: Runtime>(_win: &WebviewWindow<R>) -> bool {
    false
}

/// Win11 圆角偏好：抗锯齿圆角与系统阴影。旧系统上调用失败无副作用。
#[cfg(windows)]
fn apply_dwm_corner(hwnd: *mut c_void, rounded: bool) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

    if !flag("TASK_DOCK_WINDOW_DWM_CORNER") {
        return;
    }

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DEFAULT: i32 = 0;
    const DWMWCP_ROUND: i32 = 2;
    let pref: i32 = if rounded {
        DWMWCP_ROUND
    } else {
        DWMWCP_DEFAULT
    };
    unsafe {
        DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
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
}
