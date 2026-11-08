//! Windows 窗口管理：顶层窗口枚举、进程身份关联、最小化恢复与前台切换。
//!
//! 约束（对应验收条款）：
//! - PID/HWND 都是易变身份，绝不落库作为永久关联；每次动作前重新枚举核对；
//! - `SetForegroundWindow` 被 Windows 拒绝时如实返回失败原因，不报告成功；
//! - 进程启动成功 ≠ 窗口出现：启动后由 `wait_for_window_by_exe` 轮询确认；
//! - 枚举带 TTL 缓存（约 1.2s），避免高频系统调用。
//!
//! 非 Windows 平台提供空实现（编译不炸，导航如实报不支持）。

use std::collections::HashSet;
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
    /// 旧记忆不含路径；新记忆用路径进一步约束窗口身份。
    #[serde(default)]
    pub exe_path: String,
    /// 身份来源（旧数据无此字段 → Auto：旧版本只有自动记忆一种来源）。
    #[serde(default)]
    pub origin: MemoryOrigin,
}

impl WindowMemory {
    pub fn from_window(w: &WindowInfo) -> Self {
        Self {
            class_name: w.class_name.clone(),
            title: w.title.clone(),
            exe_path: w.exe_path.clone().unwrap_or_default(),
            origin: MemoryOrigin::Auto,
        }
    }

    pub(crate) fn from_window_with_origin(w: &WindowInfo, origin: MemoryOrigin) -> Self {
        Self {
            class_name: w.class_name.clone(),
            title: w.title.clone(),
            exe_path: w.exe_path.clone().unwrap_or_default(),
            origin,
        }
    }
}

/// 在候选窗口里挑一个：优先命中记忆，否则取标题最长（信息量最大）的。
///
/// 显式选择只接受唯一的完整匹配；自动记忆可按类名及最长标题降级。
/// 这个函数是纯函数，多窗口选择行为因此可以被单测直接验证。
pub fn pick_window<'a>(
    windows: &'a [WindowInfo],
    remembered: Option<&WindowMemory>,
) -> Option<&'a WindowInfo> {
    if windows.is_empty() {
        return None;
    }
    if let Some(m) = remembered {
        let mut exact = windows.iter().filter(|w| {
            w.class_name == m.class_name
                && w.title == m.title
                && (m.exe_path.is_empty()
                    || w.exe_path
                        .as_deref()
                        .is_some_and(|p| p.eq_ignore_ascii_case(&m.exe_path)))
        });
        if let Some(w) = exact.next().filter(|_| exact.next().is_none()) {
            return Some(w);
        }
        if m.origin == MemoryOrigin::User {
            return None;
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
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        let raw: Option<String> = conn.query_row(
            "SELECT value FROM application_settings WHERE key = ?1",
            [WINDOW_MEMORY_KEY], |r| r.get(0),
        ).optional()?;
        let mut map = raw.and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
            .and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let current = map.get(target_id).and_then(|v| serde_json::from_value::<WindowMemory>(v.clone()).ok());
        if origin == MemoryOrigin::Auto && current.is_some_and(|m| m.origin == MemoryOrigin::User) {
            return Ok(());
        }
        map.insert(target_id.to_string(), serde_json::to_value(WindowMemory::from_window_with_origin(w, origin))?);
        conn.execute(
            "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![WINDOW_MEMORY_KEY, serde_json::to_string(&map)?, crate::agents::now_iso()],
        )?;
        Ok(())
    })
}

/// 清除某目标的窗口记忆（目标删除 / 用户重置时调用）。
pub fn forget_memory(db: &Db, target_id: &str) -> crate::error::AppResult<()> {
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM application_settings WHERE key = ?1",
                [WINDOW_MEMORY_KEY],
                |r| r.get(0),
            )
            .optional()?;
        let mut map = raw
            .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        if map.remove(target_id).is_some() {
            conn.execute(
                "UPDATE application_settings SET value = ?1, updated_at = ?2 WHERE key = ?3",
                rusqlite::params![
                    serde_json::to_string(&map)?,
                    crate::agents::now_iso(),
                    WINDOW_MEMORY_KEY
                ],
            )?;
        }
        Ok(())
    })
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

/// 按标题子串（大小写不敏感）找窗口。
///
/// 仅用于诊断/调试；导航**不得**直接用标题决定唤醒对象（见 `windows_for_identity`）。
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

/// 纯函数：从窗口快照中筛出「属于目标软件身份」的窗口。
///
/// 判定顺序：进程可执行路径直接命中 → 窗口 PID 属于目标进程树（`related`）。
/// `title_hint` 只在这款软件存在多个可交互窗口时做二次收窄；它绝不能把
/// 其他应用的窗口拉进候选集（跨应用同名标题的根因就在这里）。
pub(crate) fn select_identity_windows(
    windows: &[WindowInfo],
    target_exe: &str,
    related: &HashSet<u32>,
    title_hint: Option<&str>,
) -> Vec<WindowInfo> {
    let want = target_exe.trim().to_ascii_lowercase();
    if want.is_empty() {
        return Vec::new();
    }
    let matched: Vec<WindowInfo> = windows
        .iter()
        .filter(|w| {
            w.exe_path
                .as_deref()
                .is_some_and(|p| p.eq_ignore_ascii_case(&want))
                || related.contains(&w.pid)
        })
        .cloned()
        .collect();
    let hint = title_hint.unwrap_or("").trim().to_ascii_lowercase();
    if hint.is_empty() || matched.len() <= 1 {
        return matched;
    }
    let narrowed: Vec<WindowInfo> = matched
        .iter()
        .filter(|w| w.title.to_ascii_lowercase().contains(&hint))
        .cloned()
        .collect();
    if narrowed.is_empty() {
        matched
    } else {
        narrowed
    }
}

/// 按「进程身份优先、标题二次过滤」找目标软件的窗口。
///
/// 多进程宿主（微信/QQ/酷狗等）的窗口可能由子进程持有，因此除 exe 路径
/// 直接命中外，还接受目标进程树中的窗口；跨应用的同名窗口会被排除。
pub fn windows_for_identity(exe: &str, title_hint: Option<&str>) -> Vec<WindowInfo> {
    let want = exe.trim().to_ascii_lowercase();
    if want.is_empty() {
        return Vec::new();
    }
    let related = identity_pids(&want);
    select_identity_windows(&top_windows(), &want, &related, title_hint)
}

/// 对已按 exe 路径确认身份的窗口，再用标题提示做二次收窄（无命中则保持原集合）。
pub fn prefer_title_hint(windows: Vec<WindowInfo>, title_hint: &str) -> Vec<WindowInfo> {
    let hint = title_hint.trim().to_ascii_lowercase();
    if hint.is_empty() || windows.len() <= 1 {
        return windows;
    }
    let narrowed: Vec<WindowInfo> = windows
        .iter()
        .filter(|w| w.title.to_ascii_lowercase().contains(&hint))
        .cloned()
        .collect();
    if narrowed.is_empty() {
        windows
    } else {
        narrowed
    }
}

/// 校验某个窗口是否确实属于目标软件（用户选窗口/任务关联窗口时使用）。
pub fn window_belongs_to_target(w: &WindowInfo, target_exe: &str) -> bool {
    let want = target_exe.trim().to_ascii_lowercase();
    if want.is_empty() {
        return false;
    }
    if w.exe_path
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case(&want))
    {
        return true;
    }
    identity_pids(&want).contains(&w.pid)
}

/// 等待某个 exe（含其子进程）的可交互窗口出现（启动后确认用）。
pub fn wait_for_window_by_exe(exe: &str, timeout: Duration) -> Option<WindowInfo> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let wins = windows_for_identity(exe, None);
        if let Some(w) = wins.into_iter().max_by_key(|w| w.title.chars().count()) {
            return Some(w);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

/// 当前属于某个进程树（含 root 自身）的可交互窗口。
/// 用于确认「新启动的交互式 CLI 是否真的拿到了终端窗口」。
pub fn windows_for_pid_tree(root_pid: u32) -> Vec<WindowInfo> {
    if root_pid == 0 {
        return Vec::new();
    }
    let related = descendant_pids(root_pid);
    top_windows_force()
        .into_iter()
        .filter(|w| related.contains(&w.pid))
        .collect()
}

/// 把窗口带到前台：校验句柄有效 → 恢复最小化 → 置前 → 核实前台句柄。
/// 任一步被拒返回准确原因；绝不把「API 拒绝」报成成功。
pub fn focus_window(hwnd: isize) -> Result<FocusOutcome, FocusError> {
    focus_window_impl(hwnd)
}

/// 单个窗口的关闭结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseWindowOutcome {
    pub hwnd: isize,
    pub title: String,
    /// true = 投递后句柄已消失（或投递前就已失效）；false = 仍在
    /// （典型原因：应用弹出「是否保存」对话框等待用户决定）。
    pub closed: bool,
}

/// WM_CLOSE 是异步请求，应用可能弹确认框；只等这一段，之后仍存在的窗口
/// 如实标 `closed=false`，不重试、不强杀（强杀属于进程管理，不是关窗口）。
const CLOSE_VERIFY_TIMEOUT: Duration = Duration::from_millis(2000);
/// WM_QUIT 后等待应用自行退出（保存/清理需要时间）；超时仍未退出的如实上报，
/// 由调用方引导改用强制结束。
const QUIT_VERIFY_TIMEOUT: Duration = Duration::from_millis(3000);

/// 优雅关闭一组窗口：逐个投递 `WM_CLOSE`（等价用户点标题栏 ×），不抢焦点、
/// 不动光标、不结束进程；随后有界轮询核实句柄是否消失。调用方必须在调用前
/// 重新枚举窗口（HWND 易变），本函数对投递前已失效的句柄按「已关闭」处理。
pub fn close_windows(windows: &[WindowInfo]) -> Vec<CloseWindowOutcome> {
    close_windows_impl(windows)
}

/// 单个进程的结束结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillProcessOutcome {
    pub pid: u32,
    /// true = TerminateProcess 已受理；false = 打开句柄被拒（权限/保护进程）、
    /// 竞争中已退出，或该 PID 是本进程（绝不自杀）。
    pub killed: bool,
}

/// 按进程身份枚举 PID：自身或任意祖先进程的 exe 路径 == target（含多进程
/// 宿主的子进程）。返回值升序去重；仅在用户已确认强制结束时使用。
pub fn pids_for_identity(target_exe: &str) -> Vec<u32> {
    if target_exe.trim().is_empty() {
        return Vec::new();
    }
    let mut pids: Vec<u32> = identity_pids(target_exe.trim()).into_iter().collect();
    pids.sort_unstable();
    pids
}

/// 强制结束一组进程：`OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess`。
/// 这是破坏性动作（不经过应用的退出/保存流程），调用方必须先取得用户确认；
/// 失败的 PID 如实上报，不重试、不假装成功。
pub fn kill_processes(pids: &[u32]) -> Vec<KillProcessOutcome> {
    kill_processes_impl(pids)
}

/// 一次枚举内判定多个 exe 身份各自「是否存在属于它的可交互窗口」：
/// 窗口 exe 直接命中，或窗口 PID 的祖先链上有 exe 命中（多进程宿主
/// （微信/QQ/酷狗等）的窗口常由子进程持有）。
/// 与 `windows_for_identity` / close / kill 同一套身份语义——运行态检测
/// 若只做 exe 直配，会漏判子进程窗口，导致徽标与「关闭窗口」入口丢失。
/// 返回值按入参原键返回；枚举与进程快照各只做一次，祖先 exe 查询带记忆化。
pub fn identity_has_window(exe_keys: &[String]) -> std::collections::HashMap<String, bool> {
    identity_has_window_impl(exe_keys)
}

/// 「请求退出」的结果：进程走自己的退出路径后是否真的结束。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuitProcessesReport {
    /// 参与判定的目标进程数（剔除本进程）。
    pub process_total: usize,
    /// 有界等待内确认已退出的进程数。
    pub process_exited: usize,
    /// 成功投递 WM_QUIT 的线程数（无消息队列的线程投递失败，属正常）。
    pub posted_threads: usize,
}

/// 属于给定 PID 集合的全部线程 ID（系统级线程快照一次，升序去重）。
pub fn threads_of_pids(pids: &[u32]) -> Vec<u32> {
    threads_of_pids_impl(pids)
}

/// 向一组线程投递 `WM_QUIT`（应用自己的消息循环收到后走退出路径），
/// 返回成功投递数。跨进程投递合法；线程没有消息队列时投递失败，属正常。
pub fn post_quit_threads(tids: &[u32]) -> usize {
    post_quit_threads_impl(tids)
}

/// 有界等待一组进程退出，返回确认已退出的进程数。进程消失
/// （OpenProcess 报无效参数）视为已退出；打不开句柄（权限）按未退出处理。
pub fn wait_processes_exit(pids: &[u32], timeout: Duration) -> usize {
    wait_processes_exit_impl(pids, timeout)
}

/// 请求一组进程自行退出：向其全部线程投递 `WM_QUIT`，随后有界等待核实。
/// 这是「退出应用」语义——接近用户点托盘「退出」：应用走自己的保存/清理/
/// 移除托盘图标路径。不配合（自定义消息循环、保存弹窗）的进程如实报未退出，
/// 由调用方引导改用强制结束；绝不 TerminateProcess。本进程 PID 被剔除。
pub fn request_processes_quit(pids: &[u32]) -> QuitProcessesReport {
    request_processes_quit_impl(pids)
}

/// UWP 目标（AUMID 形如 `Family!App`）的包族名；非 UWP 键返回 None。
/// 打包应用的进程 exe 路径必含包族名（`...\WindowsApps\<family>\...`），
/// 因此族名可用于窗口与进程的身份匹配——这是 UWP 目标唯一的 exe 之外身份。
pub(crate) fn uwp_family(key: &str) -> Option<String> {
    let family = key.split('!').next()?.trim();
    if family.is_empty() || !key.contains('!') {
        return None;
    }
    Some(family.to_ascii_lowercase())
}

/// 纯函数：判定一组窗口各自是否属于给定 UWP 包族名（窗口 exe 路径包含族名，
/// 大小写不敏感——正常数据已小写，这里兜底防调用方传入原始大小写）。
pub(crate) fn windows_hit_families(
    windows: &[WindowInfo],
    families: &[String],
) -> std::collections::HashMap<String, bool> {
    let mut out: std::collections::HashMap<String, bool> = families
        .iter()
        .map(|f| (f.trim().to_ascii_lowercase(), false))
        .collect();
    for w in windows {
        if let Some(exe) = &w.exe_path {
            let exe = exe.to_ascii_lowercase();
            for (family, hit) in out.iter_mut() {
                if !*hit && exe.contains(family.as_str()) {
                    *hit = true;
                }
            }
        }
    }
    out
}

/// 按 UWP 包族名找窗口（窗口 exe 路径包含族名，即该打包应用当前可见的窗口）。
pub fn windows_for_family(family: &str) -> Vec<WindowInfo> {
    let family = family.trim().to_ascii_lowercase();
    if family.is_empty() {
        return Vec::new();
    }
    top_windows_force()
        .into_iter()
        .filter(|w| {
            w.exe_path
                .as_deref()
                .is_some_and(|exe| exe.contains(&family))
        })
        .collect()
}

/// 给定 PID 集合并入其全部子进程后的去重升序集合。
/// UWP 目标没有 exe 身份，只能从窗口 PID 出发按进程树扩展操作对象。
pub fn pids_with_descendants(pids: &[u32]) -> Vec<u32> {
    pids_with_descendants_impl(pids)
}

/// exe 路径查询（按 PID；查询失败返回 None，绝不猜测）。
pub fn exe_path_of(pid: u32) -> Option<String> {
    exe_path_of_pid(pid)
}

// ── 前台窗口 / 显示器工作区（快速捕获唤起定位用）────────────
//
// 只读 Win32 辅助：HWND 与显示器矩形都只在运行时使用，绝不落库。
// 工作区为物理像素（已排除任务栏），配合 monitor.scale_factor() 做 DPI 换算。

/// 显示器工作区（物理像素，绝对屏幕坐标；已排除任务栏等保留区域）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorWorkArea {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// 该显示器缩放（1.0 = 100%，1.5 = 150%）
    pub scale: f64,
}

/// 当前前台窗口句柄；0 表示无法取得（无桌面会话等）。
#[cfg(windows)]
pub fn foreground_window() -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow() as isize }
}

#[cfg(not(windows))]
pub fn foreground_window() -> isize {
    0
}

/// 当前前台窗口句柄：有效且不属于本进程时返回 Some。
///
/// 唤起快速捕获前记录它，用于关闭时恢复焦点；属于本进程（例如主窗口或
/// 捕获窗口自身）或无效时返回 None——调用方不得据此抢回焦点。
pub fn foreground_hwnd() -> Option<isize> {
    let hwnd = foreground_window();
    if hwnd == 0 || !window_is_valid(hwnd) {
        return None;
    }
    if window_pid(hwnd) == Some(std::process::id()) {
        return None;
    }
    Some(hwnd)
}

/// 窗口矩形中心（屏幕物理像素）；取不到矩形返回 None。
#[cfg(windows)]
fn window_center(hwnd: isize) -> Option<(f64, f64)> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindow};
    let h = hwnd as HWND;
    unsafe {
        if IsWindow(h) == 0 {
            return None;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut rect) == 0 {
            return None;
        }
        Some((
            (rect.left as i64 + rect.right as i64) as f64 / 2.0,
            (rect.top as i64 + rect.bottom as i64) as f64 / 2.0,
        ))
    }
}

#[cfg(not(windows))]
fn window_center(_hwnd: isize) -> Option<(f64, f64)> {
    None
}

#[cfg(windows)]
fn window_is_valid(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    unsafe { IsWindow(hwnd as HWND) != 0 }
}

#[cfg(not(windows))]
fn window_is_valid(_hwnd: isize) -> bool {
    false
}

#[cfg(windows)]
fn window_pid(hwnd: isize) -> Option<u32> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd as HWND, &mut pid);
    }
    if pid == 0 {
        None
    } else {
        Some(pid)
    }
}

#[cfg(not(windows))]
fn window_pid(_hwnd: isize) -> Option<u32> {
    None
}

/// 把 Tauri 显示器描述转成物理像素工作区（排除任务栏）。
pub fn monitor_work_area(monitor: &tauri::Monitor) -> MonitorWorkArea {
    let rect = monitor.work_area();
    MonitorWorkArea {
        x: rect.position.x,
        y: rect.position.y,
        w: rect.size.width as i32,
        h: rect.size.height as i32,
        scale: monitor.scale_factor(),
    }
}

/// 窗口所在显示器的工作区：以窗口矩形中心点做 `monitor_from_point`，
/// 与 Win32 `MonitorFromWindow`（最近显示器）语义一致，同时复用 Tauri 的
/// work_area 与 DPI 信息（不新增依赖）。
pub fn monitor_of_window(app: &tauri::AppHandle, hwnd: isize) -> Option<MonitorWorkArea> {
    let (cx, cy) = window_center(hwnd)?;
    let monitor = app.monitor_from_point(cx, cy).ok().flatten()?;
    Some(monitor_work_area(&monitor))
}

// ── Windows 实现 ────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongW,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
        IsWindowVisible, SetForegroundWindow, ShowWindowAsync, GWL_EXSTYLE, SW_RESTORE,
        WS_EX_TOOLWINDOW,
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

    /// 一次性进程快照：pid → parent_pid。
    fn process_parent_map() -> std::collections::HashMap<u32, u32> {
        let mut parents: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap as usize == usize::MAX {
                return parents;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        parents
    }

    /// 目标进程树（含 root 自身）的 PID 集合：用于确认新启动的终端窗口。
    pub(super) fn descendant_pids(root: u32) -> HashSet<u32> {
        let parents = process_parent_map();
        let mut out: HashSet<u32> = HashSet::new();
        out.insert(root);
        for &pid in parents.keys() {
            let mut cur = pid;
            let mut depth = 0;
            while cur != 0 && depth < 12 {
                if cur == root {
                    out.insert(pid);
                    break;
                }
                cur = *parents.get(&cur).unwrap_or(&0);
                depth += 1;
            }
        }
        out
    }

    /// 目标进程树：返回所有「自身或任意祖先进程的 exe 路径 == target」的 PID。
    ///
    /// 微信/QQ/酷狗等宿主把窗口交给子进程持有，单看窗口 PID 的 exe 会漏掉；
    /// 这里用 Toolhelp 快照一次性拿到父子关系，再逐个核对可执行路径。
    /// 仅在 exe 身份直接匹配不到窗口时调用（标题提示路径），正常导航不付这笔开销。
    pub(super) fn identity_pids(target_exe: &str) -> HashSet<u32> {
        use std::collections::{HashMap, HashSet as LocalSet};
        let parents = process_parent_map();
        let want = target_exe.trim().to_ascii_lowercase();
        let mut cache: HashMap<u32, bool> = HashMap::new();
        let mut related: LocalSet<u32> = LocalSet::new();
        for &pid in parents.keys() {
            let mut cur = pid;
            let mut depth = 0;
            while cur != 0 && depth < 12 {
                if let Some(&hit) = cache.get(&cur) {
                    if hit {
                        related.insert(pid);
                    }
                    break;
                }
                let is_target = exe_path_of_pid(cur).is_some_and(|p| p.eq_ignore_ascii_case(&want));
                cache.insert(cur, is_target);
                if is_target {
                    related.insert(pid);
                    break;
                }
                cur = *parents.get(&cur).unwrap_or(&0);
                depth += 1;
            }
        }
        related
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
                // 前台锁定：把**本线程**的输入队列临时挂到当前前台线程，再
                // BringWindowToTop + SetForegroundWindow 重试。旧实现按下 ALT
                // 键（keybd_event）骗取资格，可能打开菜单并干扰用户正在输入；
                // AttachThreadInput 不注入任何按键，属于系统正规激活路径。
                let fg = GetForegroundWindow();
                let mut fg_pid: u32 = 0;
                let fg_thread = if fg != std::ptr::null_mut() {
                    GetWindowThreadProcessId(fg, &mut fg_pid)
                } else {
                    0
                };
                let cur_thread = GetCurrentThreadId();
                // 目标窗口可能属于另一个线程（创建在消息循环线程）：只挂调用线程
                // 到前台线程并不能把前台资格传给目标线程，必须同时把目标线程也挂过去。
                let mut target_pid: u32 = 0;
                let target_thread = GetWindowThreadProcessId(h, &mut target_pid);
                let mut attached_cur = false;
                let mut attached_target = false;
                if fg_thread != 0 && fg_thread != cur_thread {
                    attached_cur = AttachThreadInput(cur_thread, fg_thread, 1) != 0;
                }
                if fg_thread != 0
                    && target_thread != 0
                    && target_thread != fg_thread
                    && target_thread != cur_thread
                {
                    attached_target = AttachThreadInput(target_thread, fg_thread, 1) != 0;
                }
                BringWindowToTop(h);
                let ok = SetForegroundWindow(h);
                if attached_target {
                    AttachThreadInput(target_thread, fg_thread, 0);
                }
                if attached_cur {
                    AttachThreadInput(cur_thread, fg_thread, 0);
                }
                if ok == 0 {
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

    pub(super) fn close_windows_impl(windows: &[WindowInfo]) -> Vec<CloseWindowOutcome> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
        let mut posted: Vec<isize> = Vec::new();
        for w in windows {
            let h = w.hwnd as HWND;
            unsafe {
                // 动作前重新核对句柄（枚举到执行之间窗口可能已被用户关掉）
                if IsWindow(h) == 0 {
                    continue;
                }
                PostMessageW(h, WM_CLOSE, 0, 0);
            }
            posted.push(w.hwnd);
        }
        // 有界轮询核实：WM_CLOSE 异步，应用可能在弹保存确认；超时后仍在的
        // 窗口如实标 closed=false，不重试不强杀。
        let deadline = Instant::now() + CLOSE_VERIFY_TIMEOUT;
        loop {
            posted.retain(|&h| unsafe { IsWindow(h as HWND) != 0 });
            if posted.is_empty() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let still: HashSet<isize> = posted.into_iter().collect();
        windows
            .iter()
            .map(|w| CloseWindowOutcome {
                hwnd: w.hwnd,
                title: w.title.clone(),
                closed: !still.contains(&w.hwnd),
            })
            .collect()
    }

    pub(super) fn kill_processes_impl(pids: &[u32]) -> Vec<KillProcessOutcome> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        let self_pid = std::process::id();
        pids.iter()
            .map(|&pid| {
                // 绝不结束本进程：目标若恰好是 task_dock 自身，宁可失败也不自杀
                let killed = if pid == self_pid || pid == 0 {
                    false
                } else {
                    unsafe {
                        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
                        if handle.is_null() {
                            false
                        } else {
                            let ok = TerminateProcess(handle, 1) != 0;
                            CloseHandle(handle);
                            ok
                        }
                    }
                };
                KillProcessOutcome { pid, killed }
            })
            .collect()
    }

    pub(super) fn identity_has_window_impl(
        exe_keys: &[String],
    ) -> std::collections::HashMap<String, bool> {
        let mut out: std::collections::HashMap<String, bool> = exe_keys
            .iter()
            .map(|k| (k.trim().to_ascii_lowercase(), false))
            .collect();
        if out.is_empty() {
            return out;
        }
        let windows = enumerate_now();
        // UWP 目标没有 exe 身份：按包族名匹配窗口 exe 路径（打包应用路径必含族名）
        let uwp: Vec<(String, String)> = exe_keys
            .iter()
            .filter_map(|k| {
                uwp_family(k).map(|f| (k.trim().to_ascii_lowercase(), f))
            })
            .collect();
        if !uwp.is_empty() {
            let families: Vec<String> = uwp.iter().map(|(_, f)| f.clone()).collect();
            let hits = windows_hit_families(&windows, &families);
            for (lower_key, family) in &uwp {
                if hits.get(family).copied().unwrap_or(false) {
                    if let Some(hit) = out.get_mut(lower_key) {
                        *hit = true;
                    }
                }
            }
        }
        let parents = process_parent_map();
        // 祖先 exe 查询带记忆化：多个窗口共享祖先链，避免重复 OpenProcess
        let mut exe_cache: std::collections::HashMap<u32, Option<String>> =
            std::collections::HashMap::new();
        for w in &windows {
            // 窗口自身 exe 直接命中（enumerate 已填 exe_path；查询失败时由链回退补判）
            if let Some(exe) = &w.exe_path {
                if let Some(hit) = out.get_mut(exe) {
                    *hit = true;
                }
            }
            // 沿父链找子进程宿主：任意祖先 exe 命中即视为该身份有窗口
            let mut cur = w.pid;
            let mut depth = 0;
            while cur != 0 && depth < 12 {
                let exe = exe_cache.entry(cur).or_insert_with(|| exe_path_of_pid(cur));
                if let Some(p) = exe {
                    if let Some(hit) = out.get_mut(&p.to_ascii_lowercase()) {
                        *hit = true;
                    }
                }
                match parents.get(&cur) {
                    Some(&parent) => cur = parent,
                    None => break,
                }
                depth += 1;
            }
        }
        // 以入参原键返回，调用方无需关心内部归一化
        exe_keys
            .iter()
            .map(|k| {
                let v = out.get(&k.trim().to_ascii_lowercase()).copied().unwrap_or(false);
                (k.clone(), v)
            })
            .collect()
    }

    pub(super) fn threads_of_pids_impl(pids: &[u32]) -> Vec<u32> {
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };
        let want: HashSet<u32> = pids.iter().copied().collect();
        let mut out: Vec<u32> = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snap as usize == usize::MAX {
                return out;
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            if Thread32First(snap, &mut entry) != 0 {
                loop {
                    if want.contains(&entry.th32OwnerProcessID) {
                        out.push(entry.th32ThreadID);
                    }
                    if Thread32Next(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    pub(super) fn post_quit_threads_impl(tids: &[u32]) -> usize {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
        let mut posted = 0;
        for &tid in tids {
            unsafe {
                if PostThreadMessageW(tid, WM_QUIT, 0, 0) != 0 {
                    posted += 1;
                }
            }
        }
        posted
    }

    /// 进程是否已退出：Some(true)=已退出，Some(false)=仍在运行，None=无法判定（权限）。
    fn process_exit_state(pid: u32) -> Option<bool> {
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                // 进程已消失且句柄被系统回收后，OpenProcess 报无效参数
                let err = windows_sys::Win32::Foundation::GetLastError();
                return if err == ERROR_INVALID_PARAMETER as u32 {
                    Some(true)
                } else {
                    None
                };
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            Some(code != STILL_ACTIVE)
        }
    }

    pub(super) fn wait_processes_exit_impl(pids: &[u32], timeout: Duration) -> usize {
        let mut pending: HashSet<u32> = pids.iter().copied().collect();
        let self_pid = std::process::id();
        pending.remove(&self_pid);
        pending.remove(&0);
        let deadline = Instant::now() + timeout;
        loop {
            pending.retain(|&pid| process_exit_state(pid) != Some(true));
            if pending.is_empty() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        pids.iter()
            .filter(|&&pid| pid != self_pid && pid != 0)
            .filter(|&&pid| process_exit_state(pid) == Some(true))
            .count()
    }

    pub(super) fn request_processes_quit_impl(pids: &[u32]) -> QuitProcessesReport {
        let self_pid = std::process::id();
        let targets: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|&pid| pid != self_pid && pid != 0)
            .collect();
        let process_total = targets.len();
        if process_total == 0 {
            return QuitProcessesReport {
                process_total: 0,
                process_exited: 0,
                posted_threads: 0,
            };
        }
        let tids = threads_of_pids_impl(&targets);
        let posted_threads = post_quit_threads_impl(&tids);
        let process_exited = wait_processes_exit_impl(&targets, QUIT_VERIFY_TIMEOUT);
        QuitProcessesReport {
            process_total,
            process_exited,
            posted_threads,
        }
    }

    pub(super) fn pids_with_descendants_impl(pids: &[u32]) -> Vec<u32> {
        let self_pid = std::process::id();
        let mut out: HashSet<u32> = HashSet::new();
        for &pid in pids {
            if pid == 0 || pid == self_pid {
                continue;
            }
            out.insert(pid);
            for child in descendant_pids(pid) {
                if child != self_pid {
                    out.insert(child);
                }
            }
        }
        let mut sorted: Vec<u32> = out.into_iter().collect();
        sorted.sort_unstable();
        sorted
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
    pub(super) fn identity_pids(_target_exe: &str) -> HashSet<u32> {
        HashSet::new()
    }
    pub(super) fn descendant_pids(root: u32) -> HashSet<u32> {
        let mut s = HashSet::new();
        s.insert(root);
        s
    }
    pub(super) fn focus_window_impl(_hwnd: isize) -> Result<FocusOutcome, FocusError> {
        Err(FocusError::ForegroundDenied)
    }
    pub(super) fn close_windows_impl(_windows: &[WindowInfo]) -> Vec<CloseWindowOutcome> {
        Vec::new()
    }
    pub(super) fn kill_processes_impl(pids: &[u32]) -> Vec<KillProcessOutcome> {
        pids.iter()
            .map(|&pid| KillProcessOutcome { pid, killed: false })
            .collect()
    }
    pub(super) fn identity_has_window_impl(
        exe_keys: &[String],
    ) -> std::collections::HashMap<String, bool> {
        exe_keys.iter().map(|k| (k.clone(), false)).collect()
    }
    pub(super) fn threads_of_pids_impl(_pids: &[u32]) -> Vec<u32> {
        Vec::new()
    }
    pub(super) fn post_quit_threads_impl(_tids: &[u32]) -> usize {
        0
    }
    pub(super) fn wait_processes_exit_impl(_pids: &[u32], _timeout: Duration) -> usize {
        0
    }
    pub(super) fn request_processes_quit_impl(pids: &[u32]) -> QuitProcessesReport {
        QuitProcessesReport {
            process_total: pids.len(),
            process_exited: 0,
            posted_threads: 0,
        }
    }
    pub(super) fn pids_with_descendants_impl(pids: &[u32]) -> Vec<u32> {
        let mut sorted: Vec<u32> = pids.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        sorted
    }
}

use imp::{
    close_windows_impl, descendant_pids, enumerate_now, exe_path_of_pid, focus_window_impl,
    identity_has_window_impl, identity_pids, kill_processes_impl, pids_with_descendants_impl,
    post_quit_threads_impl, request_processes_quit_impl, threads_of_pids_impl,
    wait_processes_exit_impl,
};

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
    fn close_windows_treats_dead_handle_as_already_closed() {
        // 随机句柄几乎必然无效：投递前核对直接按「已关闭」处理，不等待
        let wins = vec![win_at(0x00DEAD00, 999_999, "不存在的窗口", None)];
        let out = close_windows(&wins);
        assert_eq!(out.len(), 1);
        assert!(out[0].closed, "失效句柄应视为已关闭而非仍在打开");
    }

    #[cfg(windows)]
    #[test]
    fn close_windows_gracefully_closes_a_real_window() {
        use std::sync::mpsc;
        use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostThreadMessageW,
            RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WM_QUIT, WNDCLASSW,
        };

        // 独立线程创建 message-only 窗口并跑消息泵：WM_CLOSE 由 DefWindowProc
        // 处理为 DestroyWindow，主线程的轮询因此能看到句柄真实消失。
        let (ready_tx, ready_rx) = mpsc::channel::<(isize, u32)>();
        let worker = std::thread::spawn(move || {
            unsafe {
                let class_name: Vec<u16> = "taskdock_close_test\0".encode_utf16().collect();
                let mut wc: WNDCLASSW = std::mem::zeroed();
                wc.lpfnWndProc = Some(DefWindowProcW);
                wc.hInstance = GetModuleHandleW(std::ptr::null());
                wc.lpszClassName = class_name.as_ptr();
                if RegisterClassW(&wc) == 0 {
                    return;
                }
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    wc.hInstance,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    return;
                }
                if ready_tx.send((hwnd as isize, GetCurrentThreadId())).is_err() {
                    return;
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
        let Ok((hwnd, thread_id)) = ready_rx.recv_timeout(Duration::from_secs(5)) else {
            eprintln!("跳过：测试窗口创建失败（无窗口站或类注册被拒）");
            let _ = worker.join();
            return;
        };

        let wins = vec![win_at(hwnd, std::process::id(), "taskdock 关闭测试窗口", None)];
        let out = close_windows(&wins);
        assert_eq!(out.len(), 1);
        assert!(out[0].closed, "WM_CLOSE 投递后消息泵应销毁窗口");

        // 收尾：窗口已销毁，GetMessage 不会自行返回，投 WM_QUIT 结束消息泵
        unsafe {
            PostThreadMessageW(thread_id, WM_QUIT, 0 as WPARAM, 0 as LPARAM);
        }
        worker.join().ok();
    }

    #[cfg(windows)]
    #[test]
    fn pids_for_identity_includes_own_test_process() {
        let exe = exe_path_of(std::process::id()).expect("测试进程应能解析自身 exe");
        let pids = pids_for_identity(&exe);
        assert!(
            pids.contains(&std::process::id()),
            "按 exe 身份应包含测试进程自身的 PID"
        );
    }

    #[cfg(windows)]
    #[test]
    fn kill_processes_terminates_spawned_child() {
        // 启动一个只活 30s 的无害子进程（ping），强制结束后应确认退出
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("应能启动 ping 子进程");
        let pid = child.id();
        let out = kill_processes(&[pid]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pid, pid);
        assert!(out[0].killed, "存活子进程应能被 TerminateProcess 结束");
        let status = child.wait().expect("应能等待子进程退出");
        assert!(!status.success(), "被终止的子进程不应报成功退出");
    }

    #[cfg(windows)]
    #[test]
    fn kill_processes_refuses_to_terminate_itself() {
        let out = kill_processes(&[std::process::id()]);
        assert_eq!(out.len(), 1);
        assert!(!out[0].killed, "本进程 PID 必须拒绝终止（不自杀）");
    }

    #[cfg(windows)]
    #[test]
    fn post_quit_threads_ends_message_loop_thread() {
        use std::sync::mpsc;
        use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
            TranslateMessage, HWND_MESSAGE, MSG, WNDCLASSW,
        };

        // 本进程内起一个带消息泵的线程：WM_QUIT 到达后 GetMessage 返回 0，
        // 循环退出——验证「投递 WM_QUIT → 应用自行退出路径」这一机制本身。
        let (ready_tx, ready_rx) = mpsc::channel::<(isize, u32)>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let worker = std::thread::spawn(move || unsafe {
            let class_name: Vec<u16> = "taskdock_quit_test\0".encode_utf16().collect();
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(DefWindowProcW);
            wc.hInstance = GetModuleHandleW(std::ptr::null());
            wc.lpszClassName = class_name.as_ptr();
            if RegisterClassW(&wc) == 0 {
                return;
            }
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                wc.hInstance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return;
            }
            if ready_tx.send((hwnd as isize, GetCurrentThreadId())).is_err() {
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            // GetMessage 返回 0（收到 WM_QUIT）即退出循环
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            done_tx.send(()).ok();
        });
        let Ok((_hwnd, thread_id)) = ready_rx.recv_timeout(Duration::from_secs(5)) else {
            eprintln!("跳过：测试窗口创建失败");
            return;
        };

        assert_eq!(post_quit_threads(&[thread_id]), 1, "有消息队列的线程应能收到 WM_QUIT");
        assert!(
            done_rx.recv_timeout(Duration::from_secs(3)).is_ok(),
            "消息泵收到 WM_QUIT 后应退出循环"
        );
        worker.join().ok();
    }

    #[cfg(windows)]
    #[test]
    fn request_processes_quit_reports_honest_failure_for_console_child() {
        // 控制台子进程（ping）没有消息队列：投递失败、不会退出——结果必须
        // 如实反映，不得虚报已退出；随后强杀清理。
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("应能启动 ping 子进程");
        let pid = child.id();
        // threads_of_pids 应能扫到子进程的线程（无论有无消息队列）
        assert!(
            !threads_of_pids(&[pid]).is_empty(),
            "系统线程快照应包含子进程的线程"
        );
        let report = request_processes_quit(&[pid]);
        assert_eq!(report.process_total, 1);
        assert_eq!(report.posted_threads, 0, "无消息队列的线程投递应失败");
        assert_eq!(report.process_exited, 0, "控制台进程不应被 WM_QUIT 结束");
        // 清理：强杀子进程，避免测试残留 30s
        let _ = kill_processes(&[pid]);
        let _ = child.wait();
    }

    #[test]
    fn uwp_family_parses_aumid_and_rejects_non_uwp() {
        assert_eq!(
            uwp_family("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App").as_deref(),
            Some("microsoft.windowsterminal_8wekyb3d8bbwe")
        );
        assert_eq!(uwp_family("OpenAI.Codex_2p2nqsd0c76g0!App").as_deref(), Some("openai.codex_2p2nqsd0c76g0"));
        // 非 UWP：没有 '!' 不算包身份
        assert_eq!(uwp_family("c:\\program files\\kugou\\kugou.exe"), None);
        assert_eq!(uwp_family("!App"), None, "族名不能为空");
    }

    #[test]
    fn windows_hit_families_matches_by_exe_path_containment() {
        let windows = vec![
            win_at(
                1,
                101,
                "终端",
                Some("C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\WindowsTerminal.exe"),
            ),
            win_at(2, 102, "记事本", Some("c:\\windows\\notepad.exe")),
        ];
        let families = vec![
            "microsoft.windowsterminal_8wekyb3d8bbwe".to_string(),
            "openai.codex_2p2nqsd0c76g0".to_string(),
        ];
        let out = windows_hit_families(&windows, &families);
        assert!(out["microsoft.windowsterminal_8wekyb3d8bbwe"], "打包应用窗口应按族名命中");
        assert!(!out["openai.codex_2p2nqsd0c76g0"], "未运行的包不得误报");
    }

    #[cfg(windows)]
    #[test]
    fn identity_has_window_sees_own_process_window() {
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, DestroyWindow, PeekMessageW,
            RegisterClassW, TranslateMessage, MSG, WNDCLASSW,
        };
        // 离屏 1×1 可见窗口：可被 EnumWindows 枚举（有标题、非工具窗口），
        // 又不会打扰桌面；属于本测试进程，用于验证「exe 身份 → 有窗口」。
        unsafe {
            let class_name: Vec<u16> = "taskdock_idw_test\0".encode_utf16().collect();
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(DefWindowProcW);
            wc.hInstance = GetModuleHandleW(std::ptr::null());
            wc.lpszClassName = class_name.as_ptr();
            if RegisterClassW(&wc) == 0 {
                eprintln!("跳过：窗口类注册失败");
                return;
            }
            let title: Vec<u16> = "taskdock 身份检测测试窗口\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                0x1000_0000, // WS_VISIBLE
                -32000,
                -32000,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                wc.hInstance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                eprintln!("跳过：测试窗口创建失败");
                return;
            }

            let exe = exe_path_of(std::process::id()).expect("测试进程应能解析自身 exe");
            let absent = "c:\\not\\a\\real\\app.exe".to_string();
            let keys = vec![exe.clone(), absent.clone()];
            let out = identity_has_window(&keys);
            assert!(out[&exe], "本进程持有的窗口应按 exe 身份命中");
            assert!(!out[&absent], "不存在的身份不得误报有窗口");

            DestroyWindow(hwnd);
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, 1) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
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

    // ── 问题 1：窗口身份误匹配（跨应用同名 / 多实例 / 路径变化）─────

    fn win_at(hwnd: isize, pid: u32, title: &str, exe: Option<&str>) -> WindowInfo {
        WindowInfo {
            hwnd,
            pid,
            title: title.into(),
            class_name: "C".into(),
            is_minimized: false,
            exe_path: exe.map(str::to_string),
        }
    }

    #[test]
    fn identity_windows_exclude_cross_app_same_title() {
        let target = "C:\\Program Files\\WeChat\\WeChat.exe";
        let mut related = HashSet::new();
        related.insert(9002u32);
        let windows = vec![
            // 其他应用恰好也叫「微信」（记事本窗口标题）
            win_at(1, 9001, "微信", Some("C:\\Windows\\notepad.exe")),
            win_at(2, 9002, "微信", Some(target)),
        ];
        let got = select_identity_windows(&windows, target, &related, Some("微信"));
        assert_eq!(got.len(), 1, "跨应用同名标题不得进入候选集");
        assert_eq!(got[0].hwnd, 2);
    }

    #[test]
    fn identity_windows_keep_multi_instance_and_child_process_windows() {
        let target = "C:\\Program Files\\Tencent\\QQNT\\QQ.exe";
        let mut related = HashSet::new();
        related.insert(9103u32); // 子进程（宿主把窗口交给 helper）
        let windows = vec![
            win_at(1, 9101, "QQ", Some(target)),
            win_at(2, 9102, "QQ - 主面板", Some(target)),
            win_at(
                3,
                9103,
                "QQ - 聊天窗口",
                Some("C:\\Program Files\\Tencent\\QQNT\\QQHelper.exe"),
            ),
        ];
        // 多实例全部保留；标题提示只在同款多窗口时再收窄
        let all = select_identity_windows(&windows, target, &related, None);
        assert_eq!(all.len(), 3);
        let narrowed = select_identity_windows(&windows, target, &related, Some("聊天窗口"));
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0].hwnd, 3, "子进程持有的窗口应按进程树身份保留");
    }

    #[test]
    fn title_hint_cannot_pull_in_foreign_window() {
        let target = "C:\\Program Files\\WeChat\\WeChat.exe";
        let related = HashSet::new();
        let windows = vec![
            win_at(1, 9201, "微信", Some(target)),
            win_at(
                2,
                9202,
                "微信开发文档 - 浏览器",
                Some("C:\\Program Files\\Chrome\\chrome.exe"),
            ),
        ];
        let got = select_identity_windows(&windows, target, &related, Some("微信开发文档"));
        assert_eq!(got.len(), 1, "标题命中也不得越过进程身份");
        assert_eq!(got[0].hwnd, 1);
    }

    #[test]
    fn identity_windows_follow_exe_path_change() {
        let target = "C:\\Program Files\\WeChat\\WeChat.exe";
        let related = HashSet::new();
        let windows = vec![
            // 旧路径（软件升级/迁移后不再属于目标身份）
            win_at(1, 9301, "微信", Some("D:\\OldWeChat\\WeChat.exe")),
        ];
        assert!(select_identity_windows(&windows, target, &related, None).is_empty());
        // 新路径下的窗口可被识别
        let windows_new = vec![win_at(2, 9302, "微信", Some(target))];
        assert_eq!(
            select_identity_windows(&windows_new, target, &related, None).len(),
            1
        );
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
            exe_path: String::new(),
            origin: MemoryOrigin::Auto,
        };
        assert_eq!(pick_window(&wins, Some(&m)).unwrap().hwnd, 2);
        // 2) 标题变了（用户切了标签）→ 仍按类名落到同一种窗口
        let m2 = WindowMemory {
            class_name: "ConsoleWindowClass".into(),
            title: "早已关闭的终端".into(),
            exe_path: String::new(),
            origin: MemoryOrigin::Auto,
        };
        assert_eq!(pick_window(&wins, Some(&m2)).unwrap().hwnd, 4);
        // 3) 类名也不认识 → 回退最长标题
        let m3 = WindowMemory {
            class_name: "Nope".into(),
            title: "nope".into(),
            exe_path: String::new(),
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
    fn automatic_memory_does_not_replace_user_choice() {
        let db = Db::open_in_memory().unwrap();
        save_user_memory(&db, "t1", &win(1, "用户窗口", "Class")).unwrap();
        save_memory(&db, "t1", &win(2, "其他窗口", "Class")).unwrap();
        let m = load_memory(&db, "t1").unwrap();
        assert_eq!(m.origin, MemoryOrigin::User);
        assert_eq!(m.title, "用户窗口");
    }

    #[test]
    fn missing_explicit_window_must_not_select_another_of_same_class() {
        let selected = WindowMemory {
            class_name: "Class".into(),
            title: "窗口 A".into(),
            exe_path: String::new(),
            origin: MemoryOrigin::User,
        };
        assert!(pick_window(&[win(2, "窗口 B", "Class")], Some(&selected)).is_none());
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
