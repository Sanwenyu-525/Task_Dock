//! Codex 适配器（OpenAI Codex CLI / App）。
//!
//! 官方 Hooks：`$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`），
//! 格式与本机实测一致（Claude 兼容组结构）：
//! ```json
//! { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "...", "timeout": 5 } ] } ] } }
//! ```
//! ⚠️ v0.1 缺陷：曾把 `{type, command}` 直接写进事件数组（缺 `hooks` 组层），
//! Codex 不会执行该结构。v0.2 修复为官方组结构，并加入二进制能力检查。
//!
//! 事件能力检查（P0-1）：安装前定位 codex 可执行文件并扫描二进制中的事件名，
//! 只注册当前版本真正支持的事件；找不到二进制时使用已验证基线（0.130.0 / 0.165.0 实测）
//! 并在报告中注明未做本机能力核验。
//!
//! Hook 信任（0.165.0-alpha.1.2 实测）：Codex 只执行已信任的 hook，未信任时**静默跳过**，
//! 事件不会到达任何下游；非交互 `codex exec` 需 `--dangerously-bypass-hook-trust`
//! 才能让 hook 真正执行。

use std::path::PathBuf;

use serde_json::json;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

/// 本机实测基线（codex-cli 0.130.0-alpha.5 与 0.165.0-alpha.1.2，二进制字符串验证）。
pub const BASELINE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "Notification",
];

pub fn codex_home() -> PathBuf {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    home_dir().join(".codex")
}

pub fn hooks_files() -> Vec<PathBuf> {
    vec![codex_home().join("hooks.json")]
}

/// 收集本机所有候选 codex 可执行文件：PATH → %LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe
/// → bin\<hash>\codex.exe（Codex 桌面版真正执行的那份，通常是最新版本）。
fn codex_exe_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.exists() && !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(p) = managed::find_exe(&["codex", "codex.exe"]) {
        push(p);
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let bin = PathBuf::from(local)
            .join("OpenAI")
            .join("Codex")
            .join("bin");
        push(bin.join("codex.exe"));
        if let Ok(rd) = std::fs::read_dir(&bin) {
            for entry in rd.flatten() {
                push(entry.path().join("codex.exe"));
            }
        }
    }
    out
}

/// 从 `codex-cli 0.165.0-alpha.1.2` 解析主版本号序列。
fn parse_version(text: &str) -> Option<Vec<u64>> {
    let tok = text
        .split_whitespace()
        .find(|t| t.starts_with(|c: char| c.is_ascii_digit()))?;
    let core = tok.split_once('-').map(|(a, _)| a).unwrap_or(tok);
    let nums: Vec<u64> = core.split('.').filter_map(|s| s.parse().ok()).collect();
    if nums.is_empty() {
        None
    } else {
        Some(nums)
    }
}

fn version_key(nums: &[u64]) -> Vec<u64> {
    let mut k = nums.to_vec();
    while k.len() < 3 {
        k.push(0);
    }
    k
}

/// 进程内缓存的版本号（按 路径|大小|mtime 失效）。
fn probe_version_cached(exe: &PathBuf) -> Option<String> {
    use std::sync::{LazyLock, Mutex};
    static MEMO: LazyLock<Mutex<std::collections::HashMap<String, Option<String>>>> =
        LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
    let Ok(meta) = std::fs::metadata(exe) else {
        return None;
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}|{}|{}", exe.to_string_lossy(), meta.len(), mtime);
    if let Ok(m) = MEMO.lock() {
        if let Some(v) = m.get(&key) {
            return v.clone();
        }
    }
    let v = managed::probe_version(exe, &["--version"]);
    if let Ok(mut m) = MEMO.lock() {
        m.insert(key, v.clone());
    }
    v
}

/// 定位 codex 可执行文件：取本机候选中版本最高的一个。
/// 桌面版把当前版本放在 `bin\<hash>\codex.exe`，而 `bin\codex.exe` 可能是历史残留的旧版；
/// 若固定取后者，能力扫描与 `codex resume` 都会作用在错误的 CLI 上。
pub fn find_codex_exe() -> Option<PathBuf> {
    let candidates = codex_exe_candidates();
    if candidates.is_empty() {
        return None;
    }
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for c in candidates {
        let key = probe_version_cached(&c)
            .and_then(|v| parse_version(&v))
            .map(|n| version_key(&n))
            .unwrap_or_else(|| vec![0, 0, 0]);
        match &best {
            Some((bk, _)) if *bk >= key => {}
            _ => best = Some((key, c)),
        }
    }
    best.map(|(_, p)| p)
}

/// 能力检查：扫描二进制中实际存在的 Hook 事件。
pub fn supported_events() -> Vec<String> {
    if let Some(exe) = find_codex_exe() {
        let found = managed::scan_events_cached(&exe, BASELINE_EVENTS, "codex-events");
        if !found.is_empty() {
            return found;
        }
    }
    BASELINE_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let home = codex_home();
    let exe = find_codex_exe();
    // 配置目录存在即视为已安装（App 与 CLI 共用 ~/.codex）
    let home_exists = home.exists();
    let local_app = std::env::var("LOCALAPPDATA")
        .map(|l| PathBuf::from(l).join("OpenAI").join("Codex"))
        .ok()
        .filter(|p| p.exists());
    r.installed = home_exists || exe.is_some() || local_app.is_some();
    r.config_homes = vec![home.to_string_lossy().to_string()];
    if let Some(e) = &exe {
        r.install_paths.push(e.to_string_lossy().to_string());
        r.version = managed::probe_version(e, &["--version"]);
        // 用二进制实扫事件做能力核验（带缓存）
        let found = managed::scan_events_cached(e, BASELINE_EVENTS, "codex-events");
        if !found.is_empty() {
            r.supported_events = found;
        }
    }
    if let Some(p) = local_app {
        r.install_paths.push(p.to_string_lossy().to_string());
    }
    r.install_method = "config-home-or-executable".into();
    r.running_instances = managed::find_processes(&["codex"]);
    if r.version.is_none() && r.running_instances.is_empty() && r.installed {
        r.version = None; // 仅安装（如 App 数据目录），版本未知
    }
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "codex",
        display_name: "Codex",
        docs_url: "https://github.com/openai/codex",
        hooks_files,
        events: supported_events,
        detect_impl,
        hook_command: super::hooks_install::codex_hook_command,
        limitations: vec![
            "Codex App（桌面版）与 CLI 共用 ~/.codex；App Server（JSON-RPC）可观测能力未在本轮验证"
                .into(),
            "Hook 由 Codex 在会话生命周期触发；配置写入成功 ≠ 事件已到达，以真实事件为准".into(),
            "Codex CLI 要求 hook 通过信任审核，未信任的 hook 会被静默跳过（非交互场景可用 \
             --dangerously-bypass-hook-trust 绕过）"
                .into(),
        ],
        timeout_secs: 10,
    }
}

/// 兼容旧命令入口：Hooks 状态。
pub fn status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::error::AppResult<serde_json::Value> {
    let _ = app;
    let events = supported_events();
    let events_ref: Vec<&str> = events.iter().map(|s| s.as_str()).collect();
    let s = super::hooks_install::status_hooks(&hooks_files()[0], &events_ref)?;
    Ok(json!({
        "installed": s["registered_events"].as_array().map(|a| !a.is_empty()).unwrap_or(false),
        "hooks_path": s["path"],
        "registered_events": s["registered_events"],
        "expected_events": s["expected_events"],
        "third_party_entries": s["third_party_entries"],
        "codex_home": codex_home().to_string_lossy(),
    }))
}

// v0.4：会话跳转（codex resume）已迁移至 navigation::agent_navigation::resume_session，
// 统一走证据化能力 + 诚实降级路径；本模块保留安装检测与 Hooks 观测职责。
