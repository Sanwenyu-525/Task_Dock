//! 通用软件发现：开始菜单快捷方式、卸载注册表、UWP 应用与常用软件路径。
//!
//! 原则：
//! - 只扫明确位置，绝不全盘搜索；
//! - 浏览器渲染进程等子进程绝不当作独立软件（进程仅参与「运行状态」判定，
//!   窗口层只枚举顶层可交互窗口）；
//! - 扫描结果只作「发现建议」，落库为导航目标时才成为可信配置；
//! - 扫描带进程内缓存（TTL 5 分钟），UI 打开选择器不重复全量扫描。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::validate_exe_path;

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredApp {
    /// 稳定应用身份：exe 绝对路径（小写）或 UWP AUMID
    pub app_key: String,
    pub display_name: String,
    /// browser | im | music | dev | file | uwp | other
    pub category: String,
    pub exe_path: String,
    pub launch_args: String,
    pub working_dir: String,
    pub app_user_model_id: String,
    /// 窗口标题提示（exe 无法唯一判定时的窗口匹配辅助，如「微信」）
    pub window_title_hint: String,
    /// startmenu | registry | uwp | known | app_paths
    pub source: String,
    /// normal（默认展示）| advanced（默认折叠，可在「显示高级项」查看）。
    /// 无效候选（卸载/安装例程等）不会进入扫描结果。
    #[serde(default)]
    pub tier: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppScanResult {
    pub apps: Vec<DiscoveredApp>,
    pub scanned_at: String,
    pub duration_ms: u64,
    pub counts: HashMap<String, usize>,
    /// 来源级诊断（如 startmenu_truncated / uwp_scan_failed）：
    /// 用于区分「没有匹配」与「发现不完整」，不把扫描失败说成没有结果。
    #[serde(default)]
    pub diagnostics: HashMap<String, u32>,
}

/// 扫描进度的渐进事件负载（由 nav_scan_apps 逐来源推送，前端按 scan_id 过滤过期批次）。
#[derive(Debug, Clone, Serialize)]
pub struct AppScanBatch {
    pub scan_id: String,
    /// startmenu | known | app_paths | registry | uwp
    pub source: String,
    /// 本批新增（已按 app_key 去重）的应用
    pub apps: Vec<DiscoveredApp>,
    /// 含本批在内的累计发现数
    pub discovered: usize,
    pub sources_done: usize,
    pub sources_total: usize,
}

/// 真机扫描的来源总数（缓存命中不推送批次）；用于前端展示「已扫描来源 x/y」而非虚假百分比。
pub const SCAN_SOURCES_TOTAL: usize = 5;

/// 应用运行状态（区分「进程在」与「有窗口」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunningState {
    NotRunning,
    /// 有进程但无可交互窗口（后台/托盘）
    ProcessOnly,
    /// 存在可交互窗口
    HasWindow,
}

const SCAN_CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_LNK_FILES: usize = 600;
const MAX_LNK_DEPTH: usize = 4;

fn cache_cell() -> &'static std::sync::Mutex<Option<(Instant, AppScanResult)>> {
    use std::sync::{Mutex, OnceLock};
    static CELL: OnceLock<Mutex<Option<(Instant, AppScanResult)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// 扫描已安装软件（TTL 内直接返回缓存；force 绕过）。
pub fn scan_installed_apps(force: bool) -> AppScanResult {
    scan_installed_apps_streaming(force, |_, _, _| {})
}

/// 渐进扫描：每完成一个来源就回调本批新增应用与累计发现数。
///
/// 回调在扫描线程内同步执行，调用方（命令层）只做事件推送，不做重活；
/// 最终仍返回完整权威结果，前端以该结果收敛 Store、缓存与诊断。
pub fn scan_installed_apps_streaming<F>(force: bool, mut on_batch: F) -> AppScanResult
where
    F: FnMut(&[DiscoveredApp], &str, usize),
{
    let cached = {
        let guard = cache_cell().lock().unwrap();
        match guard.as_ref() {
            Some((at, r)) if !force && at.elapsed() < SCAN_CACHE_TTL => Some(r.clone()),
            _ => None,
        }
    };
    if let Some(r) = cached {
        // 缓存命中是即时返回，无需渐进批次（也避免「来源 1/5」的误导性进度）。
        super::app_icons::register_discovered(&r.apps);
        return r;
    }
    let started = Instant::now();
    let mut result = scan_now_streaming(&mut on_batch);
    result.duration_ms = started.elapsed().as_millis() as u64;
    result.scanned_at = crate::agents::now_iso();
    // 扫描结束后整体收敛身份登记（清掉已卸载应用），并用最终结果刷新缓存。
    super::app_icons::register_discovered(&result.apps);
    *cache_cell().lock().unwrap() = Some((Instant::now(), result.clone()));
    result
}

// ── 分类知识 ────────────────────────────────────────────────

/// exe 文件名（小写、不含 .exe）→ 分类。
fn category_for_exe(exe_lower: &str) -> &'static str {
    let stem = Path::new(exe_lower)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let contains = |names: &[&str]| names.iter().any(|n| stem.contains(n));
    if contains(&[
        "chrome", "msedge", "firefox", "opera", "brave", "vivaldi", "browser",
    ]) {
        "browser"
    } else if contains(&[
        "wechat", "weixin", "qq", "dingtalk", "feishu", "lark", "telegram", "whatsapp", "tim",
        "discord", "slack",
    ]) {
        "im"
    } else if contains(&[
        "kugou",
        "cloudmusic",
        "qqmusic",
        "kwmusic",
        "spotify",
        "foobar",
        "potplayer",
        "vlc",
    ]) {
        "music"
    } else if contains(&[
        "code",
        "trae",
        "qoder",
        "cursor",
        "idea",
        "pycharm",
        "webstorm",
        "goland",
        "rustrover",
        "clion",
        "rider",
        "datagrip",
        "studio64",
        "sublime",
        "notepad++",
        "vim",
        "neovim",
        "emacs",
        "windsurf",
    ]) {
        "dev"
    } else if contains(&["explorer"]) {
        "file"
    } else {
        "other"
    }
}

/// 常用软件的窗口标题提示（中文应用 exe 名与显示名差异大，标题匹配更可靠）。
fn title_hint_for_exe(exe_lower: &str) -> &'static str {
    let stem = Path::new(exe_lower)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if stem.contains("wechat") || stem.contains("weixin") {
        "微信"
    } else if stem == "qq" || stem.contains("tim") {
        "QQ"
    } else if stem.contains("kugou") {
        "酷狗"
    } else if stem.contains("cloudmusic") {
        "网易云音乐"
    } else if stem.contains("qqmusic") {
        "QQ音乐"
    } else if stem.contains("dingtalk") {
        "钉钉"
    } else if stem.contains("feishu") || stem.contains("lark") {
        "飞书"
    } else {
        ""
    }
}

/// 常用软件的常见安装位置（开始菜单缺失时的补充；只探测，不搜索）。
#[cfg(windows)]
fn known_app_candidates() -> Vec<(String, String)> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| pf.clone());
    let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut v: Vec<(String, String)> = vec![
        (
            format!("{}\\Google\\Chrome\\Application\\chrome.exe", pf),
            "Google Chrome".into(),
        ),
        (
            format!("{}\\Google\\Chrome\\Application\\chrome.exe", pf86),
            "Google Chrome".into(),
        ),
        (
            format!("{}\\Google\\Chrome\\Application\\chrome.exe", la),
            "Google Chrome".into(),
        ),
        (
            format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", pf),
            "Microsoft Edge".into(),
        ),
        (
            format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", pf86),
            "Microsoft Edge".into(),
        ),
        (
            format!("{}\\Mozilla Firefox\\firefox.exe", pf),
            "Firefox".into(),
        ),
        (
            format!("{}\\Microsoft VS Code\\Code.exe", pf),
            "Visual Studio Code".into(),
        ),
        (
            format!("{}\\Programs\\Microsoft VS Code\\Code.exe", la),
            "Visual Studio Code".into(),
        ),
    ];
    if let Some(p) = crate::agents::managed::find_exe(&["code", "code.cmd"]) {
        v.push((p.to_string_lossy().to_string(), "Visual Studio Code".into()));
    }
    v
}

// ── 各来源扫描 ──────────────────────────────────────────────

/// 逐来源扫描：每完成一个来源即登记本批身份并回调（渐进展示），
/// 最终按应用名排序返回权威结果。
#[cfg(windows)]
fn scan_now_streaming<F>(on_batch: &mut F) -> AppScanResult
where
    F: FnMut(&[DiscoveredApp], &str, usize),
{
    let mut apps: Vec<DiscoveredApp> = Vec::new();
    let mut counts = HashMap::new();
    let mut diagnostics: HashMap<String, u32> = HashMap::new();

    fn publish<F>(apps: &[DiscoveredApp], from: usize, source: &str, on_batch: &mut F)
    where
        F: FnMut(&[DiscoveredApp], &str, usize),
    {
        let batch = &apps[from..];
        // 先登记身份，保证前端收到批次后立即请求图标不会因「尚未登记」失败；
        // 扫描完成前不清空旧登记，避免重扫期间已有图标失效。
        super::app_icons::register_discovered_batch(batch);
        on_batch(batch, source, apps.len());
    }

    let n0 = apps.len();
    let (menu, truncated) = scan_start_menu();
    for a in menu {
        push_unique(&mut apps, a);
    }
    counts.insert("startmenu".into(), apps.len() - n0);
    if truncated {
        diagnostics.insert("startmenu_truncated".into(), 1);
    }
    publish(&apps, n0, "startmenu", on_batch);

    let n0 = apps.len();
    for a in scan_known() {
        push_unique(&mut apps, a);
    }
    counts.insert("known".into(), apps.len() - n0);
    publish(&apps, n0, "known", on_batch);

    // App Paths：软件注册的启动入口（开始菜单缺失时的可靠补充，不猜安装路径）
    let n0 = apps.len();
    for a in scan_app_paths() {
        push_unique(&mut apps, a);
    }
    counts.insert("app_paths".into(), apps.len() - n0);
    publish(&apps, n0, "app_paths", on_batch);

    let n0 = apps.len();
    for a in scan_registry() {
        push_unique(&mut apps, a);
    }
    counts.insert("registry".into(), apps.len() - n0);
    publish(&apps, n0, "registry", on_batch);

    let n0 = apps.len();
    let (uwp, uwp_ok, uwp_truncated) = scan_uwp();
    for a in uwp {
        push_unique(&mut apps, a);
    }
    counts.insert("uwp".into(), apps.len() - n0);
    if !uwp_ok {
        diagnostics.insert("uwp_scan_failed".into(), 1);
    }
    if uwp_truncated {
        diagnostics.insert("uwp_truncated".into(), 1);
    }
    publish(&apps, n0, "uwp", on_batch);

    apps.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    AppScanResult {
        apps,
        scanned_at: String::new(),
        duration_ms: 0,
        counts,
        diagnostics,
    }
}

#[cfg(not(windows))]
fn scan_now_streaming<F>(_on_batch: &mut F) -> AppScanResult
where
    F: FnMut(&[DiscoveredApp], &str, usize),
{
    AppScanResult {
        apps: Vec::new(),
        scanned_at: String::new(),
        duration_ms: 0,
        counts: HashMap::new(),
        diagnostics: HashMap::new(),
    }
}

fn push_unique(apps: &mut Vec<DiscoveredApp>, a: DiscoveredApp) {
    if a.app_key.is_empty() {
        return;
    }
    if apps.iter().any(|x| x.app_key == a.app_key) {
        return;
    }
    apps.push(a);
}

/// 开始菜单快捷方式（用户 + 所有用户）。返回 (应用列表, 是否因预算耗尽而截断)。
#[cfg(windows)]
fn scan_start_menu() -> (Vec<DiscoveredApp>, bool) {
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Ok(pd) = std::env::var("ProgramData") {
        dirs.push(PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    let mut out = Vec::new();
    let mut budget = MAX_LNK_FILES;
    let mut truncated = false;
    for dir in dirs {
        if budget == 0 {
            // 还有未遍历的根目录：预算确实被耗尽，不能只看 budget==0 就报截断。
            truncated = true;
            break;
        }
        walk_lnk_dir(&dir, 0, &mut budget, &mut out, &mut truncated);
    }
    (out, truncated)
}

#[cfg(windows)]
fn walk_lnk_dir(
    dir: &Path,
    depth: usize,
    budget: &mut usize,
    out: &mut Vec<DiscoveredApp>,
    truncated: &mut bool,
) {
    if depth > MAX_LNK_DEPTH {
        // 深度上限：只有目录里确实还有内容时才标记「发现不完整」，空目录不算截断。
        if std::fs::read_dir(dir)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
        {
            *truncated = true;
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            // 仍有未处理条目 → 预算截断；恰好处理完最后一条则不会走到这里。
            *truncated = true;
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_lnk_dir(&path, depth + 1, budget, out, truncated);
        } else if path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            *budget -= 1;
            if let Some(app) = parse_lnk(&path) {
                out.push(app);
            }
        }
    }
}

/// 解析单个 .lnk：目标必须是通过安全校验的本地 exe。
/// 外部文件按不可信数据处理：解析库 panic（畸形 lnk）也被拦下，绝不让扫描崩掉。
#[cfg(windows)]
fn parse_lnk(path: &Path) -> Option<DiscoveredApp> {
    let display_name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // 优先走 Windows Shell（IShellLinkW）：快捷方式的 LinkInfo 可能是历史遗留路径，
    // 真实目标在 LinkTargetIDList 中（例：微信的 .lnk 里 LinkInfo 仍指向已删除的
    // D:\微信\WeChat\WeChat.exe，而实际安装位置是 D:\微信\Weixin\Weixin.exe）。
    let mut resolved = super::app_icons::resolve_shortcut(&path.to_string_lossy());
    if !matches!(&resolved, Some((t, _, _)) if validate_exe_path(t).is_ok()) {
        // COM 不可用或目标失效时回退到纯 Rust 解析（不因单一来源失败丢掉全部快捷方式）
        resolved = std::panic::catch_unwind(|| lnk::ShellLink::open(path).ok())
            .ok()
            .flatten()
            .and_then(|sl| {
                let target = sl
                    .link_info()
                    .as_ref()
                    .and_then(|li| li.local_base_path().clone())
                    .unwrap_or_default();
                if target.is_empty() {
                    return None;
                }
                Some((
                    target,
                    sl.arguments().clone().unwrap_or_default(),
                    sl.working_dir().clone().unwrap_or_default(),
                ))
            });
    }
    let (target, launch_args, raw_wd) = resolved?;
    // 目标校验：绝对路径 + .exe + 存在 + 非解释器（复用导航安全校验）
    if validate_exe_path(&target).is_err() {
        return None;
    }
    let lower = target.to_ascii_lowercase();
    let tier = candidate_tier(&display_name, &lower);
    if tier == CandidateTier::Invalid {
        // 卸载/安装例程不进入候选；高级项保留，由前端默认折叠、可展开。
        return None;
    }
    let working_dir = {
        let t = raw_wd.trim();
        if !t.is_empty() && Path::new(t).is_dir() {
            t.to_string()
        } else {
            String::new()
        }
    };
    Some(DiscoveredApp {
        app_key: lower.clone(),
        display_name: display_name.trim().to_string(),
        category: category_for_exe(&lower).to_string(),
        window_title_hint: title_hint_for_exe(&lower).to_string(),
        exe_path: target,
        launch_args: launch_args.trim().to_string(),
        working_dir,
        app_user_model_id: String::new(),
        source: "startmenu".into(),
        tier: tier.as_str().to_string(),
    })
}

/// 常用软件路径补充探测。
#[cfg(windows)]
fn scan_known() -> Vec<DiscoveredApp> {
    known_app_candidates()
        .into_iter()
        .filter_map(|(exe, name)| {
            let lower = exe.to_ascii_lowercase();
            if validate_exe_path(&exe).is_err() {
                return None;
            }
            Some(DiscoveredApp {
                app_key: lower.clone(),
                display_name: name,
                category: category_for_exe(&lower).to_string(),
                window_title_hint: title_hint_for_exe(&lower).to_string(),
                exe_path: exe,
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                source: "known".into(),
                tier: CandidateTier::Normal.as_str().to_string(),
            })
        })
        .collect()
}

/// 候选分层：普通 / 高级（默认折叠、可展开）/ 无效（不进扫描结果）。
/// 所有来源共用同一套判定，避免各扫描函数各自维护一份不一致的字符串黑名单。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateTier {
    Normal,
    Advanced,
    Invalid,
}

impl CandidateTier {
    fn as_str(self) -> &'static str {
        match self {
            CandidateTier::Normal => "normal",
            CandidateTier::Advanced => "advanced",
            CandidateTier::Invalid => "invalid",
        }
    }
}

fn exe_stem(exe_lower: &str) -> String {
    Path::new(exe_lower)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 卸载/安装例程：只有精确的文件名形态才判无效，避免把
/// `uninstall-tool.exe`（合法卸载管理器）或路径含 setup 的开发工具误杀。
fn is_uninstaller_stem(stem: &str) -> bool {
    if matches!(stem, "uninstall" | "uninstaller" | "uninst") {
        return true;
    }
    // unins000.exe / unins001.exe 等 Inno Setup 卸载器
    stem.strip_prefix("unins")
        .map(|rest| rest.is_empty() || rest.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

fn is_installer_stem(stem: &str) -> bool {
    if matches!(
        stem,
        "setup" | "installer" | "install" | "installshield" | "dpinst" | "dpinst64" | "driverinstall"
    ) {
        return true;
    }
    // setup64.exe / setup_x64.exe 等安装包，不把 setup-tool 之类的合法工具算进来
    stem.strip_prefix("setup")
        .map(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '_' || c == '-' || c == 'x')
        })
        .unwrap_or(false)
}

/// 高级项：可启动但对日常使用没有意义的组件（更新器 / 崩溃报告 / 后台服务 / 维护工具）。
/// 只按「文件名独立语义 + 显示名完整短语」匹配，不做任意子串删除，
/// 因此开发工具、终端、软件管理器里的 update/service/setup 不会被误折叠。
fn is_advanced_candidate(display_name: &str, stem: &str) -> bool {
    let name = display_name.trim().to_ascii_lowercase();
    const NAME_MARKERS: &[&str] = &[
        "update service",
        "crash reporter",
        "crashpad",
        "background service",
        "maintenance tool",
        "uninstall helper",
    ];
    if NAME_MARKERS.iter().any(|m| name.contains(m)) {
        return true;
    }
    // 完整词尾：避免把 `CodeUpdater 调试工具` 这类名字里的子串当成更新器
    if name == "updater" || name.ends_with(" updater") {
        return true;
    }
    // 名称明确是卸载入口（快捷方式可能指向主程序+卸载参数），默认折叠但仍可展开
    if name.starts_with("uninstall") || display_name.starts_with("卸载") {
        return true;
    }
    // 中文短语（完整词，不做单字匹配）
    const CN_MARKERS: &[&str] = &[
        "更新服务",
        "更新程序",
        "后台服务",
        "崩溃报告",
        "维护工具",
        "卸载辅助",
        "驱动安装",
    ];
    if CN_MARKERS.iter().any(|m| display_name.contains(m)) {
        return true;
    }
    // 文件名级：只认独立后缀/精确名，`service-hub`、`update-checker` 之类开发工具不受影响。
    const STEM_SUFFIXES: &[&str] = &[
        "updater",
        "crashpad_handler",
        "crashreporter",
        "dismhost",
        "maintenancetool",
    ];
    if STEM_SUFFIXES.iter().any(|m| {
        stem == *m || stem.ends_with(&format!("_{}", m)) || stem.ends_with(&format!("-{}", m))
    }) {
        return true;
    }
    stem == "service" || stem.ends_with("_service") || stem.ends_with("-service")
}

/// 统一候选判定：各来源只负责收集，不再各自写一套卸载/更新过滤。
fn candidate_tier(display_name: &str, exe_lower: &str) -> CandidateTier {
    let stem = exe_stem(exe_lower);
    if is_uninstaller_stem(&stem) || is_installer_stem(&stem) {
        return CandidateTier::Invalid;
    }
    if is_advanced_candidate(display_name, &stem) {
        return CandidateTier::Advanced;
    }
    CandidateTier::Normal
}

/// Uninstall 注册表的 DisplayIcon 常写成 `"C:\App\app.exe",0`，也可能只是图标资源
///（.ico/.dll）。只有 .exe 才能当作可启动应用，其余一律不猜。
fn exe_from_display_icon(icon: &str) -> Option<String> {
    let raw = icon.split(',').next()?.trim().trim_matches('"').trim();
    if raw.is_empty() || !raw.to_ascii_lowercase().ends_with(".exe") {
        return None;
    }
    Some(raw.to_string())
}

/// App Paths：软件自己注册的启动入口（HKCU / HKLM 64 位与 32 位视图）。
/// 这是可靠系统来源，不猜测安装目录；与开始菜单/注册表按 app_key 去重。
#[cfg(windows)]
fn scan_app_paths() -> Vec<DiscoveredApp> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ),
        (
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ),
    ];
    let mut out = Vec::new();
    for (root, sub) in roots {
        let Ok(key) = RegKey::predef(root).open_subkey(sub) else {
            continue;
        };
        for name in key.enum_keys().flatten() {
            let Ok(sk) = key.open_subkey(&name) else {
                continue;
            };
            let exe: String = sk.get_value("").unwrap_or_default();
            let exe = exe.trim().trim_matches('"').to_string();
            // 含环境变量或空值无法可靠定位（不做猜测展开）
            if exe.is_empty() || exe.contains('%') || validate_exe_path(&exe).is_err() {
                continue;
            }
            let lower = exe.to_ascii_lowercase();
            let display_name = name
                .strip_suffix(".exe")
                .or_else(|| name.strip_suffix(".EXE"))
                .unwrap_or(&name)
                .trim()
                .to_string();
            if display_name.is_empty() {
                continue;
            }
            let tier = candidate_tier(&display_name, &lower);
            if tier == CandidateTier::Invalid {
                continue;
            }
            out.push(DiscoveredApp {
                app_key: lower.clone(),
                display_name,
                category: category_for_exe(&lower).to_string(),
                window_title_hint: title_hint_for_exe(&lower).to_string(),
                exe_path: exe,
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                source: "app_paths".into(),
                tier: tier.as_str().to_string(),
            });
        }
    }
    out
}

/// 卸载注册表（HKLM 64/32 + HKCU）。
#[cfg(windows)]
fn scan_registry() -> Vec<DiscoveredApp> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
    ];
    let mut out = Vec::new();
    for (root, sub) in roots {
        let Ok(key) = RegKey::predef(root).open_subkey(sub) else {
            continue;
        };
        // enum_keys 只给子键名；逐个打开读取（winreg 0.55 语义）
        for name in key.enum_keys().flatten() {
            let Ok(sk) = key.open_subkey(&name) else {
                continue;
            };
            let display: String = sk.get_value("DisplayName").unwrap_or_default();
            if display.trim().is_empty() {
                continue;
            }
            // 系统组件 / 纯 MSI 登记项不作为可启动应用
            let sys_comp: u32 = sk.get_value("SystemComponent").unwrap_or(0);
            if sys_comp == 1 {
                continue;
            }
            // 更新补丁 / 父级条目不是独立应用
            let parent: String = sk.get_value("ParentKeyName").unwrap_or_default();
            if !parent.trim().is_empty() {
                continue;
            }
            let release: String = sk.get_value("ReleaseType").unwrap_or_default();
            let rel = release.to_ascii_lowercase();
            if rel.contains("update") || rel.contains("hotfix") || rel.contains("patch") {
                continue;
            }
            let icon: String = sk.get_value("DisplayIcon").unwrap_or_default();
            // DisplayIcon 常见写法：`"C:\App\app.exe",0`；也可能是 .ico/.dll，
            // 只有 exe 才能作为启动目标（图标文件不是可执行程序）。
            let Some(exe) = exe_from_display_icon(&icon) else {
                continue;
            };
            if validate_exe_path(&exe).is_err() {
                continue;
            }
            let lower = exe.to_ascii_lowercase();
            // 卸载程序不是可启动应用；更新/崩溃报告等归为高级项（默认折叠、可展开）。
            let tier = candidate_tier(display.trim(), &lower);
            if tier == CandidateTier::Invalid {
                continue;
            }
            out.push(DiscoveredApp {
                app_key: lower.clone(),
                display_name: display.trim().to_string(),
                category: category_for_exe(&lower).to_string(),
                window_title_hint: title_hint_for_exe(&lower).to_string(),
                exe_path: exe,
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                source: "registry".into(),
                tier: tier.as_str().to_string(),
            });
        }
    }
    out
}

/// UWP / MSIX：Get-StartApps 中带「!」的应用身份（单次 PowerShell 调用，限时 8s）。
#[cfg(windows)]
fn scan_uwp() -> (Vec<DiscoveredApp>, bool, bool) {
    // 输出统一 UTF-8：默认控制台编码会把中文应用名变成乱码（搜索与展示都会失效）
    let out = run_powershell_with_timeout(
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ConvertTo-Csv -NoTypeInformation",
        ],
        Duration::from_secs(8),
    );
    let Some(out) = out else {
        // PowerShell 不可用 / 超时：如实标记来源失败，不把「没有 UWP」当作扫描成功
        return (Vec::new(), false, false);
    };
    let mut apps = Vec::new();
    let mut truncated = false;
    for line in out.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() || line == "\"Name\",\"AppID\"" {
            continue;
        }
        // CSV："名称","AUMID"
        let parts: Vec<&str> = line.split("\",\"").collect();
        if parts.len() != 2 {
            continue;
        }
        let name = parts[0].trim_start_matches('"').to_string();
        let aumid = parts[1].trim_end_matches('"').to_string();
        if name.is_empty() || super::validate_aumid(&aumid).is_err() {
            continue;
        }
        if apps.len() >= 200 {
            // 继续遍历只为准确判定「是否真的还有更多条目」，不产生假截断诊断。
            truncated = true;
            continue;
        }
        apps.push(DiscoveredApp {
            app_key: aumid.clone(),
            display_name: name,
            category: "uwp".into(),
            exe_path: String::new(),
            launch_args: String::new(),
            working_dir: String::new(),
            app_user_model_id: aumid,
            window_title_hint: String::new(),
            source: "uwp".into(),
            tier: CandidateTier::Normal.as_str().to_string(),
        });
    }
    (apps, true, truncated)
}

/// 带超时的子进程执行（防止 PowerShell 挂起阻塞扫描）。
#[cfg(windows)]
fn run_powershell_with_timeout(args: &[&str], timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = crate::winproc::hidden("powershell.exe")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    // 必须并发消费 stdout：等进程退出后才读管道，大输出会把管道写满并死锁，
    // 直到超时才被杀死。这里先起读线程，再轮询退出状态。
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let mut s = stdout;
        let _ = s.read_to_string(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let buf = reader.join().unwrap_or_default();
    // 超时或非零退出都视为「本次扫描不可用」，不得把半截/错误输出当结果。
    status.filter(|s| s.success()).map(|_| buf)
}

// ── 运行状态判定 ────────────────────────────────────────────

/// 计算一批 app_key 的运行状态：有窗口 > 仅进程 > 未运行。
/// app_key 为 exe 路径（小写）或 AUMID（AUMID 只能判窗口标题）。
pub fn running_states(app_keys: &[String]) -> HashMap<String, RunningState> {
    let mut out: HashMap<String, RunningState> = HashMap::new();
    // 顶层窗口 → exe 身份（一次枚举）
    let windows = super::window_manager::top_windows_force();
    let mut window_exes: std::collections::HashSet<String> = std::collections::HashSet::new();
    for w in &windows {
        if let Some(exe) = &w.exe_path {
            window_exes.insert(exe.clone());
        }
    }
    // 进程快照（含后台/托盘进程）
    let procs = crate::agents::managed::process_snapshot_names();
    let mut proc_stems: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &procs {
        proc_stems.insert(name.to_ascii_lowercase());
    }
    for key in app_keys {
        let state = if window_exes.contains(key) {
            RunningState::HasWindow
        } else if key.contains('!') {
            // UWP：无 exe 身份，窗口匹配按标题提示；这里无提示则按未运行处理（不猜）
            RunningState::NotRunning
        } else if let Some(stem) = Path::new(key).file_stem() {
            let stem = stem.to_string_lossy().to_string();
            if proc_stems.contains(&stem) {
                RunningState::ProcessOnly
            } else {
                RunningState::NotRunning
            }
        } else {
            RunningState::NotRunning
        };
        out.insert(key.clone(), state);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机验证渐进扫描：来源批次按顺序到达、批间 app_key 不重复、累计数单调且等于最终结果。
    #[cfg(windows)]
    #[test]
    #[ignore = "真机扫描（访问开始菜单/注册表/应用商店，耗时数秒）"]
    fn streaming_scan_emits_source_batches_and_final_result() {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = HashSet::new();
        let mut batches = 0usize;
        let mut last_discovered = 0usize;
        let mut monotonic = true;
        let mut no_cross_batch_dupes = true;
        let started = std::time::Instant::now();
        let result = scan_installed_apps_streaming(true, |apps, source, discovered| {
            batches += 1;
            println!(
                "batch {} source={} new={} discovered={} at {:?}",
                batches,
                source,
                apps.len(),
                discovered,
                started.elapsed()
            );
            for a in apps {
                if !seen.insert(a.app_key.clone()) {
                    no_cross_batch_dupes = false;
                }
            }
            if discovered < last_discovered {
                monotonic = false;
            }
            last_discovered = discovered;
        });
        assert!(batches > 0, "至少应有来源批次");
        assert!(no_cross_batch_dupes, "同一 app_key 不得跨批重复推送");
        assert!(monotonic, "累计发现数必须单调不减");
        assert_eq!(result.apps.len(), last_discovered, "最终结果与累计数应一致");
    }

    #[test]
    fn categories_match_common_apps() {
        assert_eq!(category_for_exe("c:\\chrome\\chrome.exe"), "browser");
        assert_eq!(category_for_exe("c:\\edge\\msedge.exe"), "browser");
        assert_eq!(category_for_exe("c:\\tencent\\wechat\\wechat.exe"), "im");
        assert_eq!(category_for_exe("c:\\kugou\\kugou.exe"), "music");
        assert_eq!(category_for_exe("c:\\cloud music\\cloudmusic.exe"), "music");
        assert_eq!(category_for_exe("c:\\ide\\code.exe"), "dev");
        assert_eq!(category_for_exe("c:\\something\\weird.exe"), "other");
    }

    #[test]
    fn title_hints_for_cn_apps() {
        assert_eq!(
            title_hint_for_exe("c:\\tencent\\wechat\\wechat.exe"),
            "微信"
        );
        assert_eq!(title_hint_for_exe("c:\\kugou\\kugou.exe"), "酷狗");
        assert_eq!(title_hint_for_exe("c:\\app\\unknown.exe"), "");
    }

    #[test]
    fn push_unique_dedupes_by_app_key() {
        let mut apps = Vec::new();
        push_unique(
            &mut apps,
            DiscoveredApp {
                app_key: "a".into(),
                display_name: "A".into(),
                category: "other".into(),
                exe_path: String::new(),
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                window_title_hint: String::new(),
                source: "startmenu".into(),
                tier: "normal".into(),
            },
        );
        push_unique(
            &mut apps,
            DiscoveredApp {
                app_key: "a".into(),
                display_name: "A dup".into(),
                category: "other".into(),
                exe_path: String::new(),
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                window_title_hint: String::new(),
                source: "registry".into(),
                tier: "normal".into(),
            },
        );
        push_unique(
            &mut apps,
            DiscoveredApp {
                app_key: String::new(),
                display_name: "empty key".into(),
                category: "other".into(),
                exe_path: String::new(),
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                window_title_hint: String::new(),
                source: "startmenu".into(),
                tier: "normal".into(),
            },
        );
        assert_eq!(apps.len(), 1, "同 key 与空 key 不得重复入库");
        assert_eq!(
            apps[0].display_name, "A",
            "先到者保留（来源优先级由调用顺序决定）"
        );
    }

    #[cfg(windows)]
    #[test]
    fn scan_returns_only_valid_targets() {
        let r = scan_installed_apps(true);
        for a in &r.apps {
            if a.source == "uwp" {
                assert!(!a.app_user_model_id.is_empty());
                assert!(super::super::validate_aumid(&a.app_user_model_id).is_ok());
            } else {
                assert!(
                    !a.exe_path.is_empty(),
                    "非 UWP 发现项必须有 exe：{:?}",
                    a.display_name
                );
                assert!(
                    super::super::validate_exe_path(&a.exe_path).is_ok(),
                    "发现项必须通过安全校验：{} -> {}",
                    a.display_name,
                    a.exe_path
                );
            }
            assert!(!a.display_name.trim().is_empty());
            assert!(
                a.tier == "normal" || a.tier == "advanced",
                "扫描候选只能是普通项或高级项：{} -> {}",
                a.display_name,
                a.tier
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn running_states_distinguish_levels() {
        // 本测试进程自身：exe 在运行（进程存在），但无顶层窗口
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();
        let map = running_states(&[exe]);
        let s = map.values().next().unwrap();
        assert!(
            *s == RunningState::ProcessOnly || *s == RunningState::NotRunning,
            "测试进程无 GUI 窗口，不得报 HasWindow"
        );
    }

    #[test]
    fn display_icon_only_accepts_exe_without_arguments() {
        // 带引号 + 图标索引：取 exe 本身
        assert_eq!(
            exe_from_display_icon("\"C:\\Program Files\\App\\app.exe\",0"),
            Some("C:\\Program Files\\App\\app.exe".to_string())
        );
        assert_eq!(
            exe_from_display_icon("C:\\App\\app.exe,-1"),
            Some("C:\\App\\app.exe".to_string())
        );
        // 图标资源 / DLL / 空值不能当启动目标
        assert_eq!(exe_from_display_icon("C:\\App\\icon.ico"), None);
        assert_eq!(exe_from_display_icon("C:\\App\\res.dll,2"), None);
        assert_eq!(exe_from_display_icon("   "), None);
    }

    #[test]
    fn uninstallers_and_setup_helpers_are_invalid() {
        // 无效：卸载/安装例程本身不是可交互应用，不进候选
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\unins000.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\uninstall.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\setup.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\setup64.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\installer.exe"),
            CandidateTier::Invalid
        );
        // 正常应用不能被误杀（开发工具、通讯、便携程序）
        assert_eq!(
            candidate_tier("Visual Studio Code", "c:\\program files\\microsoft vs code\\code.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("企业微信", "c:\\tencent\\wxwork\\wxwork.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("便携工具", "d:\\portable\\tool.exe"),
            CandidateTier::Normal
        );
    }

    #[test]
    fn updater_and_service_components_are_advanced_not_deleted() {
        // 高级项：可展开查看，不能被当作无效直接删除
        assert_eq!(
            candidate_tier("Google Update", "c:\\app\\updater.exe"),
            CandidateTier::Advanced
        );
        assert_eq!(
            candidate_tier("Acme 更新服务", "c:\\app\\acme_service.exe"),
            CandidateTier::Advanced
        );
        assert_eq!(
            candidate_tier("Crash Reporter", "c:\\app\\crashpad_handler.exe"),
            CandidateTier::Advanced
        );
        assert_eq!(
            candidate_tier("Background Service", "c:\\app\\agent.exe"),
            CandidateTier::Advanced
        );
        // 卸载入口指向主程序时（名称而非安装器文件）默认折叠，仍可展开
        assert_eq!(
            candidate_tier("Uninstall Foo", "c:\\app\\foo.exe"),
            CandidateTier::Advanced
        );
        // 开发工具文件名含 update/service 但语义独立，不得误折叠
        assert_eq!(
            candidate_tier("CodeUpdater 调试工具", "c:\\dev\\update-checker.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("ServiceHub", "c:\\jetbrains\\servicehub.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("Windows Terminal", "c:\\terminal\\windows-terminal.exe"),
            CandidateTier::Normal
        );
    }

    #[cfg(windows)]
    #[test]
    fn lnk_budget_truncation_is_accurate() {
        let dir = std::env::temp_dir().join(format!(
            "task-dock-lnk-budget-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        for name in ["a.lnk", "b.lnk"] {
            std::fs::write(dir.join(name), b"broken").unwrap();
        }
        let mut out = Vec::new();
        let mut truncated = false;
        let mut budget = 2usize;
        walk_lnk_dir(&dir, 0, &mut budget, &mut out, &mut truncated);
        assert!(!truncated, "预算恰好覆盖全部条目时不得报截断");
        let mut out = Vec::new();
        let mut truncated = false;
        let mut budget = 1usize;
        walk_lnk_dir(&dir, 0, &mut budget, &mut out, &mut truncated);
        assert!(truncated, "仍有未处理条目时必须报截断");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn invalid_shortcut_is_ignored_without_panic() {
        let dir = std::env::temp_dir().join(format!(
            "task-dock-lnk-test-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("broken.lnk");
        std::fs::write(&path, b"not a real shortcut").unwrap();
        let parsed = parse_lnk(&path);
        assert!(parsed.is_none(), "非法快捷方式必须被忽略，且不能 panic");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// 真机可复现样本：微信的 .lnk 的 LinkInfo 指向已删除的旧路径，
    /// 真实目标在 LinkTargetIDList 中。未安装微信时跳过（不伪造结果）。
    #[cfg(windows)]
    #[test]
    fn stale_link_info_shortcut_resolves_to_existing_target() {
        let lnk = Path::new("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\微信\\微信.lnk");
        if !lnk.exists() {
            eprintln!("skip: 本机未安装微信（{} 不存在）", lnk.display());
            return;
        }
        let resolved = super::super::app_icons::resolve_shortcut(&lnk.to_string_lossy())
            .expect("Shell 应能解析 IDList 中的真实目标");
        assert!(
            super::super::validate_exe_path(&resolved.0).is_ok(),
            "解析出的目标必须是现有 exe：{}",
            resolved.0
        );
    }
}
