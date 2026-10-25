//! Windows 窗口管理：顶层窗口枚举、进程身份关联、最小化恢复与前台切换。
//!
//! 约束（对应验收条款）：
//! - PID/HWND 都是易变身份，绝不落库作为永久关联；每次动作前重新枚举核对；
//! - `SetForegroundWindow` 被 Windows 拒绝时如实返回失败原因，不报告成功；
//! - 进程启动成功 ≠ 窗口出现：启动后由 `wait_for_window_by_exe` 轮询确认；
//! - 枚举带 TTL 缓存（约 1.2s），避免高频系统调用。
//!
//! 非 Windows 平台提供空实现（编译不炸，导航如实报不支持）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 一个可交互顶层窗口的快照（HWND 以整数传递，避免跨 FFI 持有指针）。
#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
    pub is_minimized: bool,
    /// 所属进程 exe 完整路径（小写；查询失败为 None）
    pub exe_path: Option<String>,
}

/// 焦点控制结果：Confirmed = 前台句柄已核实；Unverified = API 接受请求但未能在
/// 超时内核实（动画/抢焦点等），调用方可如实标注验证级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusOutcome {
    Confirmed,
    Unverified,
}

#[derive(Debug)]
pub enum FocusError {
    WindowVanished,
    RestoreFailed,
    ForegroundDenied,
}

impl FocusError {
    pub fn reason_cn(&self) -> &'static str {
        match self {
            FocusError::WindowVanished => "窗口已关闭（句柄失效）",
            FocusError::RestoreFailed => "恢复最小化窗口失败",
            FocusError::ForegroundDenied => {
                "Windows 前台锁定拒绝了切换（目标窗口可能已高亮但未置前）"
            }
        }
    }
}

pub const WINDOW_CACHE_TTL: Duration = Duration::from_millis(1200);
const FOCUS_VERIFY_TIMEOUT: Duration = Duration::from_millis(900);
const RESTORE_TIMEOUT: Duration = Duration::from_millis(1200);

// ── 缓存与查询 ──────────────────────────────────────────────

fn cache_cell() -> &'static Mutex<(Instant, Vec<WindowInfo>)> {
    use std::sync::OnceLock;
    static CELL: OnceLock<Mutex<(Instant, Vec<WindowInfo>)>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new((Instant::now() - WINDOW_CACHE_TTL, Vec::new())))
}

/// 枚举可交互顶层窗口（TTL 缓存内直接复用）。
pub fn top_windows() -> Vec<WindowInfo> {
    {
        let guard = cache_cell().lock().unwrap();
        if guard.0.elapsed() < WINDOW_CACHE_TTL {
            return guard.1.clone();
        }
    }
    let fresh = enumerate_now();
    *cache_cell().lock().unwrap() = (Instant::now(), fresh.clone());
    fresh
}

/// 强制绕过缓存枚举。
pub fn top_windows_force() -> Vec<WindowInfo> {
    let fresh = enumerate_now();
    *cache_cell().lock().unwrap() = (Instant::now(), fresh.clone());
    fresh
}

/// 按 exe 完整路径（大小写不敏感）找窗口。
pub fn windows_for_exe(exe: &str) -> Vec<WindowInfo> {
    let want = exe.trim().to_ascii_lowercase();
    if want.is_empty() {
        return Vec::new();
    }
    top_windows()
        .into_iter()
        .filter(|w| w.exe_path.as_deref() == Some(want.as_str()))
        .collect()
}

/// 按标题子串（大小写不敏感）找窗口：用于 exe 身份不可判定的应用（微信/QQ 等多进程形态）。
pub fn windows_for_title(hint: &str) -> Vec<WindowInfo> {
    let h = hint.trim().to_ascii_lowercase();
    if h.is_empty() {
        return Vec::new();
    }
    top_windows()
        .into_iter()
        .filter(|w| w.title.to_ascii_lowercase().contains(&h))
        .collect()
}

/// 等待某个 exe 的可交互窗口出现（启动后确认用）。
pub fn wait_for_window_by_exe(exe: &str, timeout: Duration) -> Option<WindowInfo> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let wins = windows_for_exe(exe);
        if let Some(w) = wins.into_iter().max_by_key(|w| w.title.chars().count()) {
            return Some(w);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

/// 把窗口带到前台：校验句柄有效 → 恢复最小化 → 置前 → 核实前台句柄。
/// 任一步被拒返回准确原因；绝不把「API 拒绝」报成成功。
pub fn focus_window(hwnd: isize) -> Result<FocusOutcome, FocusError> {
    focus_window_impl(hwnd)
}

/// exe 路径查询（按 PID；查询失败返回 None，绝不猜测）。
pub fn exe_path_of(pid: u32) -> Option<String> {
    exe_path_of_pid(pid)
}

// ── Windows 实现 ────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
        SetForegroundWindow, ShowWindowAsync, GWL_EXSTYLE, SW_RESTORE, WS_EX_TOOLWINDOW,
    };

    pub(super) fn enumerate_now() -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = Vec::new();
        let lparam = &mut out as *mut Vec<WindowInfo> as LPARAM;
        unsafe {
            EnumWindows(Some(enum_proc), lparam);
            for w in out.iter_mut() {
                w.exe_path = exe_path_of_pid(w.pid);
            }
        }
        out
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let out = &mut *(lparam as *mut Vec<WindowInfo>);
        unsafe {
            // 只收可见、有标题、非工具窗口的顶层窗口（浏览器的渲染进程不是
            // 顶层窗口，天然不会被当作独立软件）
            if IsWindowVisible(hwnd) == 0 {
                return 1; // TRUE 继续枚举
            }
            if GetWindowLongW(hwnd, GWL_EXSTYLE) & (WS_EX_TOOLWINDOW as i32) != 0 {
                return 1;
            }
            // UWP 挂起窗口被系统「隐身」（cloaked），不算可交互窗口
            let mut cloaked: u32 = 0;
            let hr = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            if hr == 0 && cloaked != 0 {
                return 1;
            }
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return 1;
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            if title.trim().is_empty() {
                return 1;
            }
            let mut cls = [0u16; 64];
            let cn = GetClassNameW(hwnd, cls.as_mut_ptr(), 64);
            let class_name = String::from_utf16_lossy(&cls[..cn.max(0) as usize]);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            out.push(WindowInfo {
                hwnd: hwnd as isize,
                pid,
                title,
                class_name,
                is_minimized: IsIconic(hwnd) != 0,
                exe_path: None,
            });
        }
        1
    }

    pub(super) fn exe_path_of_pid(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                buf.as_mut_ptr(),
                &mut size,
            );
            CloseHandle(handle);
            if ok != 0 && (size as usize) <= buf.len() {
                Some(String::from_utf16_lossy(&buf[..size as usize]).to_ascii_lowercase())
            } else {
                None
            }
        }
    }

    pub(super) fn focus_window_impl(hwnd: isize) -> Result<FocusOutcome, FocusError> {
        let h = hwnd as HWND;
        unsafe {
            // 动作前重新核对句柄（枚举到执行之间窗口可能已关闭）
            if IsWindow(h) == 0 {
                return Err(FocusError::WindowVanished);
            }
            if IsIconic(h) != 0 {
                ShowWindowAsync(h, SW_RESTORE);
                let deadline = Instant::now() + RESTORE_TIMEOUT;
                while Instant::now() < deadline && IsIconic(h) != 0 {
                    std::thread::sleep(Duration::from_millis(100));
                }
                if IsIconic(h) != 0 {
                    return Err(FocusError::RestoreFailed);
                }
            }
            if SetForegroundWindow(h) == 0 {
                // Windows 前台锁定：按一次 ALT 让本进程取得设置前台的资格后重试
                //（系统惯用法，不涉及坐标点击/键序列注入）
                keybd_event(VK_MENU as u8, 0, 0, 0);
                keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
                std::thread::sleep(Duration::from_millis(60));
                if SetForegroundWindow(h) == 0 {
                    return Err(FocusError::ForegroundDenied);
                }
            }
            // 核实：前台切换有动画延迟，短暂轮询
            let deadline = Instant::now() + FOCUS_VERIFY_TIMEOUT;
            while Instant::now() < deadline {
                if GetForegroundWindow() == h {
                    return Ok(FocusOutcome::Confirmed);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(FocusOutcome::Unverified)
        }
    }
}

// ── 非 Windows 桩 ───────────────────────────────────────────

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub(super) fn enumerate_now() -> Vec<WindowInfo> {
        Vec::new()
    }
    pub(super) fn exe_path_of_pid(_pid: u32) -> Option<String> {
        None
    }
    pub(super) fn focus_window_impl(_hwnd: isize) -> Result<FocusOutcome, FocusError> {
        Err(FocusError::ForegroundDenied)
    }
}

use imp::{enumerate_now, exe_path_of_pid, focus_window_impl};

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn enumeration_returns_structurally_valid_windows() {
        let wins = top_windows_force();
        if wins.is_empty() {
            // 无桌面会话环境下跳过，不视为失败
            eprintln!("跳过：当前会话无可枚举窗口");
            return;
        }
        for w in &wins {
            assert!(!w.title.trim().is_empty(), "窗口必须有标题");
            assert!(w.pid != 0, "窗口必须有 PID");
        }
        assert!(
            wins.iter().any(|w| w.exe_path.is_some()),
            "桌面会话下应至少有一个窗口可关联进程 exe"
        );
    }

    #[cfg(windows)]
    #[test]
    fn cache_returns_same_snapshot_within_ttl() {
        let a = top_windows();
        let b = top_windows();
        assert_eq!(a.len(), b.len(), "TTL 内应命中缓存");
    }

    #[test]
    fn focus_dead_handle_reports_vanished() {
        // 0 永远不是有效窗口句柄
        let err = focus_window(0).unwrap_err();
        assert!(matches!(err, FocusError::WindowVanished));
    }

    #[cfg(windows)]
    #[test]
    fn self_pid_resolves_to_test_binary() {
        let pid = std::process::id();
        let exe = exe_path_of(pid).expect("测试进程应能解析自身 exe");
        assert!(exe.ends_with(".exe"));
    }

    #[test]
    fn matchers_reject_empty_input() {
        assert!(windows_for_exe("").is_empty());
        assert!(windows_for_title("   ").is_empty());
    }
}
