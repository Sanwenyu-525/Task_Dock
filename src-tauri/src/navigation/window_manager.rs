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

use crate::db::Db;

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

/// 窗口记忆的来源。
///
/// - `User`：用户在窗口选择器里**显式指定**的窗口身份。即便「记住窗口」偏好
///   关闭，导航也必须优先尊重它——绝不允许用「标题最长」冒充用户的选择。
/// - `Auto`：焦点定位成功后自动记录的身份，仅在 `nav_remember_window` 开启时使用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryOrigin {
    User,
    #[default]
    Auto,
}

/// 用户上次选择的窗口身份。
///
/// **刻意不保存 HWND**：句柄在窗口关闭、进程重启、DWM 重连后都会失效，
/// 存下来的数字下次几乎必然指向别的窗口（甚至别的进程）——那是最坏的一种
/// "看起来记住了，实际点错窗口"。这里只存稳定特征：窗口类名 + 标题 + 来源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct WindowMemory {
    pub class_name: String,
    pub title: String,
    /// 身份来源（旧数据无此字段 → Auto：旧版本只有自动记忆一种来源）。
    #[serde(default)]
    pub origin: MemoryOrigin,
}

impl WindowMemory {
    pub fn from_window(w: &WindowInfo) -> Self {
        Self {
            class_name: w.class_name.clone(),
            title: w.title.clone(),
            origin: MemoryOrigin::Auto,
        }
    }

    fn from_window_with_origin(w: &WindowInfo, origin: MemoryOrigin) -> Self {
        Self {
            class_name: w.class_name.clone(),
            title: w.title.clone(),
            origin,
        }
    }
}

/// 在候选窗口里挑一个：优先命中记忆，否则取标题最长（信息量最大）的。
///
/// 记忆失效时逐级降级：同类名同标题 → 同类名（标题会随文档/标签变化）→ 最长标题。
/// 这个函数是纯函数，多窗口选择行为因此可以被单测直接验证。
pub fn pick_window<'a>(
    windows: &'a [WindowInfo],
    remembered: Option<&WindowMemory>,
) -> Option<&'a WindowInfo> {
    if windows.is_empty() {
        return None;
    }
    if let Some(m) = remembered {
        if let Some(w) = windows
            .iter()
            .find(|w| w.class_name == m.class_name && w.title == m.title)
        {
            return Some(w);
        }
        if let Some(w) = windows.iter().find(|w| w.class_name == m.class_name) {
            return Some(w);
        }
    }
    windows.iter().max_by_key(|w| w.title.chars().count())
}

// ── 记忆持久化（application_settings.nav_window_memory）──────────

const WINDOW_MEMORY_KEY: &str = "nav_window_memory";

fn memory_map(db: &Db) -> serde_json::Map<String, serde_json::Value> {
    db.get_setting(WINDOW_MEMORY_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 读取某目标的窗口记忆（无记忆 / 数据损坏 → None，绝不猜测）。
pub fn load_memory(db: &Db, target_id: &str) -> Option<WindowMemory> {
    memory_map(db)
        .get(target_id)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// 记录一次成功的窗口定位（仅在 nav_remember_window 开启时由 router 调用；来源=auto）。
pub fn save_memory(db: &Db, target_id: &str, w: &WindowInfo) -> crate::error::AppResult<()> {
    save_memory_with_origin(db, target_id, w, MemoryOrigin::Auto)
}

/// 记录用户显式指定的窗口身份（AppPicker 挑选窗口时调用；来源=user）。
///
/// 显式选择不受 nav_remember_window 偏好限制：用户亲手挑的窗口，下次导航必须
/// 优先找它，找不到也要如实反馈，而不是拿"标题最长"的窗口冒充。
pub fn save_user_memory(db: &Db, target_id: &str, w: &WindowInfo) -> crate::error::AppResult<()> {
    save_memory_with_origin(db, target_id, w, MemoryOrigin::User)
}

fn save_memory_with_origin(
    db: &Db,
    target_id: &str,
    w: &WindowInfo,
    origin: MemoryOrigin,
) -> crate::error::AppResult<()> {
    let mut map = memory_map(db);
    map.insert(
        target_id.to_string(),
        serde_json::to_value(WindowMemory::from_window_with_origin(w, origin))?,
    );
    db.set_setting(WINDOW_MEMORY_KEY, serde_json::Value::Object(map))
}

/// 清除某目标的窗口记忆（目标删除 / 用户重置时调用）。
pub fn forget_memory(db: &Db, target_id: &str) -> crate::error::AppResult<()> {
    let mut map = memory_map(db);
    if map.remove(target_id).is_some() {
        db.set_setting(WINDOW_MEMORY_KEY, serde_json::Value::Object(map))?;
    }
    Ok(())
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
            let ok =
                QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
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

    // ── 问题 10：多窗口选择与记忆 ─────────────────────────────

    fn win(hwnd: isize, title: &str, class: &str) -> WindowInfo {
        WindowInfo {
            hwnd,
            pid: 1000 + hwnd as u32,
            title: title.into(),
            class_name: class.into(),
            is_minimized: false,
            exe_path: Some("c:\\app\\app.exe".into()),
        }
    }

    #[test]
    fn pick_window_prefers_exact_memory_then_class_then_longest_title() {
        let wins = vec![
            win(1, "项目 A — 编辑器", "Chrome_WidgetWin_1"),
            win(2, "项目 B — 编辑器", "Chrome_WidgetWin_1"),
            win(3, "设置", "Chrome_WidgetWin_1"),
            win(4, "终端", "ConsoleWindowClass"),
        ];
        // 1) 记忆精确命中（同类名 + 同标题）
        let m = WindowMemory {
            class_name: "Chrome_WidgetWin_1".into(),
            title: "项目 B — 编辑器".into(),
            origin: MemoryOrigin::Auto,
        };
        assert_eq!(pick_window(&wins, Some(&m)).unwrap().hwnd, 2);
        // 2) 标题变了（用户切了标签）→ 仍按类名落到同一种窗口
        let m2 = WindowMemory {
            class_name: "ConsoleWindowClass".into(),
            title: "早已关闭的终端".into(),
            origin: MemoryOrigin::Auto,
        };
        assert_eq!(pick_window(&wins, Some(&m2)).unwrap().hwnd, 4);
        // 3) 类名也不认识 → 回退最长标题
        let m3 = WindowMemory {
            class_name: "Nope".into(),
            title: "nope".into(),
            origin: MemoryOrigin::Auto,
        };
        let picked = pick_window(&wins, Some(&m3)).unwrap();
        assert_eq!(
            picked.title.chars().count(),
            wins.iter().map(|w| w.title.chars().count()).max().unwrap()
        );
        // 4) 无记忆 → 最长标题；空集合 → None
        assert!(pick_window(&wins, None).is_some());
        assert!(pick_window(&[], Some(&m)).is_none());
    }

    #[test]
    fn window_memory_persists_without_hwnd() {
        let db = Db::open_in_memory().unwrap();
        let w = win(424242, "我的项目 — 编辑器", "Chrome_WidgetWin_1");
        assert!(load_memory(&db, "t1").is_none(), "初始无记忆");
        save_memory(&db, "t1", &w).unwrap();
        let m = load_memory(&db, "t1").expect("应能读回记忆");
        assert_eq!(m.class_name, "Chrome_WidgetWin_1");
        assert_eq!(m.title, "我的项目 — 编辑器");
        assert_eq!(m.origin, MemoryOrigin::Auto, "自动记忆来源必须是 auto");
        // 落库内容里不得出现 HWND 数字（句柄是易变身份，绝不持久化）
        let raw = db
            .get_setting("nav_window_memory")
            .unwrap()
            .unwrap()
            .to_string();
        assert!(!raw.contains("424242"), "不得把 HWND 写入数据库: {}", raw);
        // 不同目标互不干扰
        assert!(load_memory(&db, "t2").is_none());
        forget_memory(&db, "t1").unwrap();
        assert!(load_memory(&db, "t1").is_none());
    }

    #[test]
    fn user_memory_origin_persists_and_reads_back() {
        let db = Db::open_in_memory().unwrap();
        let w = win(777, "用户挑的窗口", "Chrome_WidgetWin_1");
        save_user_memory(&db, "t1", &w).unwrap();
        let m = load_memory(&db, "t1").expect("显式选择应能读回");
        assert_eq!(m.origin, MemoryOrigin::User, "显式选择来源必须是 user");
        assert_eq!(m.title, "用户挑的窗口");
        // 旧数据（无 origin 字段）→ 反序列化为 Auto，绝不误判成用户显式选择
        db.set_setting(
            "nav_window_memory",
            serde_json::json!({ "t2": { "class_name": "C", "title": "T" } }),
        )
        .unwrap();
        assert_eq!(load_memory(&db, "t2").unwrap().origin, MemoryOrigin::Auto);
    }

    #[test]
    fn window_memory_survives_corrupted_value() {
        let db = Db::open_in_memory().unwrap();
        // 人为写入损坏结构：必须安全降级为「无记忆」，不能 panic
        db.set_setting(
            "nav_window_memory",
            serde_json::json!({ "t1": "not-an-object" }),
        )
        .unwrap();
        assert!(load_memory(&db, "t1").is_none());
        // 损坏后仍可正常写入新记忆
        save_memory(&db, "t1", &win(1, "X", "Y")).unwrap();
        assert_eq!(load_memory(&db, "t1").unwrap().title, "X");
    }
}
