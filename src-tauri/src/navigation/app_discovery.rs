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
    /// startmenu | registry | uwp | known
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppScanResult {
    pub apps: Vec<DiscoveredApp>,
    pub scanned_at: String,
    pub duration_ms: u64,
    pub counts: HashMap<String, usize>,
}

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
    {
        let guard = cache_cell().lock().unwrap();
        if let Some((at, r)) = guard.as_ref() {
            if !force && at.elapsed() < SCAN_CACHE_TTL {
                return r.clone();
            }
        }
    }
    let started = Instant::now();
    let mut result = scan_now();
    result.duration_ms = started.elapsed().as_millis() as u64;
    result.scanned_at = crate::agents::now_iso();
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

#[cfg(windows)]
fn scan_now() -> AppScanResult {
    let mut apps: Vec<DiscoveredApp> = Vec::new();
    let mut counts = HashMap::new();

    let n0 = apps.len();
    for a in scan_start_menu() {
        push_unique(&mut apps, a);
    }
    counts.insert("startmenu".into(), apps.len() - n0);

    let n0 = apps.len();
    for a in scan_known() {
        push_unique(&mut apps, a);
    }
    counts.insert("known".into(), apps.len() - n0);

    let n0 = apps.len();
    for a in scan_registry() {
        push_unique(&mut apps, a);
    }
    counts.insert("registry".into(), apps.len() - n0);

    let n0 = apps.len();
    for a in scan_uwp() {
        push_unique(&mut apps, a);
    }
    counts.insert("uwp".into(), apps.len() - n0);

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
    }
}

#[cfg(not(windows))]
fn scan_now() -> AppScanResult {
    AppScanResult {
        apps: Vec::new(),
        scanned_at: String::new(),
        duration_ms: 0,
        counts: HashMap::new(),
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

/// 开始菜单快捷方式（用户 + 所有用户）。
#[cfg(windows)]
fn scan_start_menu() -> Vec<DiscoveredApp> {
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Ok(pd) = std::env::var("ProgramData") {
        dirs.push(PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    let mut out = Vec::new();
    let mut budget = MAX_LNK_FILES;
    for dir in dirs {
        walk_lnk_dir(&dir, 0, &mut budget, &mut out);
        if budget == 0 {
            break;
        }
    }
    out
}

#[cfg(windows)]
fn walk_lnk_dir(dir: &Path, depth: usize, budget: &mut usize, out: &mut Vec<DiscoveredApp>) {
    if depth > MAX_LNK_DEPTH || *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_lnk_dir(&path, depth + 1, budget, out);
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
    let lower_name = display_name.to_ascii_lowercase();
    if lower_name.contains("uninstall") || display_name.contains("卸载") {
        return None;
    }
    let sl = std::panic::catch_unwind(|| lnk::ShellLink::open(path).ok())
        .ok()
        .flatten()?;
    let target = sl
        .link_info()
        .as_ref()
        .and_then(|li| li.local_base_path().clone())
        .unwrap_or_default();
    if target.is_empty() {
        return None;
    }
    // 目标校验：绝对路径 + .exe + 存在 + 非解释器（复用导航安全校验）
    if validate_exe_path(&target).is_err() {
        return None;
    }
    let lower = target.to_ascii_lowercase();
    let raw_wd = sl.working_dir().clone().unwrap_or_default();
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
        launch_args: sl
            .arguments()
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string(),
        working_dir,
        app_user_model_id: String::new(),
        source: "startmenu".into(),
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
            })
        })
        .collect()
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
            let icon: String = sk.get_value("DisplayIcon").unwrap_or_default();
            let exe = icon
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches('"')
                .to_string();
            if exe.is_empty() {
                continue;
            }
            if validate_exe_path(&exe).is_err() {
                continue;
            }
            let lower = exe.to_ascii_lowercase();
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
            });
        }
    }
    out
}

/// UWP / MSIX：Get-StartApps 中带「!」的应用身份（单次 PowerShell 调用，限时 8s）。
#[cfg(windows)]
fn scan_uwp() -> Vec<DiscoveredApp> {
    let out = run_powershell_with_timeout(
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ConvertTo-Csv -NoTypeInformation",
        ],
        Duration::from_secs(8),
    )
    .unwrap_or_default();
    let mut apps = Vec::new();
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
        });
        if apps.len() >= 200 {
            break;
        }
    }
    apps
}

/// 带超时的子进程执行（防止 PowerShell 挂起阻塞扫描）。
#[cfg(windows)]
fn run_powershell_with_timeout(args: &[&str], timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new("powershell.exe")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => return None,
        }
    }
    let mut buf = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut buf);
    }
    Some(buf)
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
}
