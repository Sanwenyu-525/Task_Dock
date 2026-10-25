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
//! 只注册当前版本真正支持的事件；找不到二进制时使用已验证基线（0.130.0 实测）
//! 并在报告中注明未做本机能力核验。

use std::path::PathBuf;

use serde_json::json;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

/// 本机实测基线（codex-cli 0.130.0-alpha.5，二进制字符串验证）。
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

/// 定位 codex 可执行文件：PATH → %LOCALAPPDATA%\OpenAI\Codex\bin。
pub fn find_codex_exe() -> Option<PathBuf> {
    if let Some(p) = managed::find_exe(&["codex", "codex.exe"]) {
        return Some(p);
    }
    let candidate = std::env::var("LOCALAPPDATA")
        .map(|l| PathBuf::from(l).join("OpenAI").join("Codex").join("bin").join("codex.exe"))
        .unwrap_or_default();
    if candidate.exists() {
        return Some(candidate);
    }
    None
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
        hooks_files: hooks_files,
        events: supported_events,
        detect_impl,
        limitations: vec![
            "Codex App（桌面版）与 CLI 共用 ~/.codex；App Server（JSON-RPC）可观测能力未在本轮验证".into(),
            "Hook 由 Codex 在会话生命周期触发；配置写入成功 ≠ 事件已到达，以真实事件为准".into(),
        ],
        timeout_secs: 10,
    }
}

/// 兼容旧命令入口：Hooks 状态。
pub fn status<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> crate::error::AppResult<serde_json::Value> {
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

/// 跳转到 Codex 会话：codex resume（白名单程序 + 严格参数校验）。
pub fn open_session(session_id: &str) -> crate::error::AppResult<()> {
    crate::agents::validate_session_id(session_id)?;
    if let Some(exe) = find_codex_exe() {
        std::process::Command::new(exe)
            .args(["resume", session_id])
            .spawn()
            .map_err(|e| crate::error::AppError::Agent(format!("启动 codex resume 失败: {}", e)))?;
        return Ok(());
    }
    std::process::Command::new("cmd")
        .args(["/c", "start", "codex", "resume", session_id])
        .spawn()
        .map_err(|e| crate::error::AppError::Agent(format!("启动 codex resume 失败: {}", e)))?;
    Ok(())
}
