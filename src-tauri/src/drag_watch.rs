//! 微件窗口的拖拽相位监视（**只做相位通知**，不引入磁吸状态机）。
//!
//! 主窗靠 `magnetic.rs` 的子类化顺便发出拖拽相位；微件窗口是独立窗口，
//! 没有磁力层，因此单独挂一个只关心 `WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE`
//! 的轻量窗口过程：
//!
//! - **不动几何、不碰光标**：窗口位置/尺寸完全由系统移动循环与前端决定；
//! - **不重复安装**：每个 HWND 只装一次（`install` 幂等），主窗不走这里；
//! - **不留句柄泄露**：`WM_NCDESTROY` 时还原原窗口过程并摘除表项；
//! - 与主窗共用 `drag_signal` 协议：事件只 emit 给**该微件窗口**，不广播。
//!
//! 非 Windows 平台是 no-op（`install` 返回 false），前端退回指针事件兜底。

use tauri::AppHandle;

#[cfg(windows)]
mod win {
    use super::*;
    use crate::drag_signal::{DragEvent, DRAG_EVENT};
    use std::sync::Mutex;
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, PostMessageW, SetWindowLongPtrW, GWLP_WNDPROC, WM_APP,
        WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY, WNDPROC,
    };

    /// 自定义消息：把相位处理推迟到窗口过程返回之后（与磁力层同一理由：
    /// 不在模态循环内部执行宿主代码）。
    const WM_WIDGET_DRAG: u32 = WM_APP + 0x61;

    struct Watch {
        old: isize,
        app: AppHandle,
        label: String,
        generation: u64,
    }

    /// 微件窗口数量很少（按类型各一个），线性表足够，避免引入哈希表依赖。
    static WATCHES: Mutex<Vec<(isize, Watch)>> = Mutex::new(Vec::new());

    fn with_watch<T>(hwnd: isize, f: impl FnOnce(&mut Watch) -> T) -> Option<T> {
        let mut list = WATCHES.lock().unwrap_or_else(|e| e.into_inner());
        list.iter_mut()
            .find(|(h, _)| *h == hwnd)
            .map(|(_, watch)| f(watch))
    }

    fn call_old(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let old = {
            let list = WATCHES.lock().unwrap_or_else(|e| e.into_inner());
            list.iter()
                .find(|(h, _)| *h == hwnd as isize)
                .map(|(_, w)| w.old)
                .unwrap_or(0)
        };
        if old == 0 {
            return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
        }
        let proc: WNDPROC = unsafe { std::mem::transmute(old) };
        unsafe { CallWindowProcW(proc, hwnd, msg, wparam, lparam) }
    }

    unsafe extern "system" fn watch_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_ENTERSIZEMOVE => {
                let generation = with_watch(hwnd as isize, |watch| {
                    watch.generation += 1;
                    watch.generation
                });
                if let Some(generation) = generation {
                    // 开始信号：延后一拍，避免在进入模态循环的当下执行宿主代码。
                    PostMessageW(hwnd, WM_WIDGET_DRAG, generation as usize, 1);
                }
                call_old(hwnd, msg, wparam, lparam)
            }
            WM_EXITSIZEMOVE => {
                if let Some(generation) =
                    with_watch(hwnd as isize, |watch| watch.generation)
                {
                    PostMessageW(hwnd, WM_WIDGET_DRAG, generation as usize, 0);
                }
                call_old(hwnd, msg, wparam, lparam)
            }
            WM_WIDGET_DRAG => {
                let generation = wparam as u64;
                let event = if lparam == 1 {
                    DragEvent::start(generation)
                } else {
                    DragEvent::end(generation)
                };
                // 只发给本微件窗口：窗口级 emit 不会与其他窗口/主窗串台。
                // 先在锁内取出目标，再在锁外 emit（不持锁调用外部代码）。
                let target = with_watch(hwnd as isize, |watch| {
                    (watch.app.clone(), watch.label.clone())
                });
                if let Some((app, label)) = target {
                    let _ = app.emit_to(&label, DRAG_EVENT, event);
                }
                0
            }
            WM_NCDESTROY => {
                // 先摘表项 + 还原原过程，再把销毁消息转给它：
                // 否则后续消息会落到已摘除的监视状态上，且原过程收不到销毁通知。
                let removed = {
                    let mut list = WATCHES.lock().unwrap_or_else(|e| e.into_inner());
                    match list.iter().position(|(h, _)| *h == hwnd as isize) {
                        Some(index) => Some(list.remove(index).1),
                        None => None,
                    }
                };
                match removed {
                    Some(watch) => {
                        let old = watch.old;
                        let proc: WNDPROC = unsafe { std::mem::transmute(old) };
                        unsafe {
                            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, old);
                            CallWindowProcW(proc, hwnd, msg, wparam, lparam)
                        }
                    }
                    None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
                }
            }
            _ => call_old(hwnd, msg, wparam, lparam),
        }
    }

    /// 在微件窗口上安装相位监视（必须在该窗口所属线程调用）。幂等。
    pub fn install(app: &AppHandle, hwnd: isize, label: &str) -> bool {
        if hwnd == 0 {
            return false;
        }
        let mut list = WATCHES.lock().unwrap_or_else(|e| e.into_inner());
        if list.iter().any(|(h, _)| *h == hwnd) {
            return true;
        }
        let old = unsafe {
            SetWindowLongPtrW(hwnd as HWND, GWLP_WNDPROC, watch_proc as usize as isize)
        };
        if old == 0 {
            tracing::warn!(hwnd, "微件拖拽相位监视安装失败（SetWindowLongPtrW 返回 0）");
            return false;
        }
        list.push((
            hwnd,
            Watch { old, app: app.clone(), label: label.to_string(), generation: 0 },
        ));
        true
    }
}

/// 在微件窗口上安装拖拽相位监视。非 Windows 直接返回 false（前端退回指针兜底）。
#[cfg(windows)]
pub fn install(app: &AppHandle, hwnd: isize, label: &str) -> bool {
    win::install(app, hwnd, label)
}

#[cfg(not(windows))]
pub fn install(_app: &AppHandle, _hwnd: isize, _label: &str) -> bool {
    false
}
