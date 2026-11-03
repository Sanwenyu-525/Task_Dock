//! Claude Code 适配器（官方 Hooks）。
//!
//! 官方文档：<https://code.claude.com/docs/en/hooks>
//! 配置：`~/.claude/settings.json` 的 `hooks` 字段（Claude Code CLI 与会话共用）。
//! 高影响操作仍由 Claude Code 自身的 Hook 信任/权限确认把关，Task Dock 不绕过。

use std::path::PathBuf;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

/// 官方 Hooks 事件（保守基线；二进制能力检查命中时以实扫结果为准）。
pub const BASELINE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SessionEnd",
    "PreCompact",
];

pub fn config_home() -> PathBuf {
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    home_dir().join(".claude")
}

pub fn hooks_files() -> Vec<PathBuf> {
    vec![config_home().join("settings.json")]
}

fn find_exe() -> Option<PathBuf> {
    managed::find_exe(&["claude", "claude.exe"])
}

/// 能力检查：二进制实扫是「能力线索」，找不到时回退官方文档基线。
pub fn supported_events() -> Vec<String> {
    if let Some(exe) = find_exe() {
        let found = managed::scan_events_cached(&exe, BASELINE_EVENTS, "claude-code-events");
        if !found.is_empty() {
            return found;
        }
    }
    BASELINE_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let home = config_home();
    let exe = find_exe();
    r.installed = home.exists() || exe.is_some();
    r.config_homes = vec![home.to_string_lossy().to_string()];
    if let Some(e) = &exe {
        r.install_paths.push(e.to_string_lossy().to_string());
        r.version = managed::probe_version(e, &["--version"]);
        let found = managed::scan_events_cached(e, BASELINE_EVENTS, "claude-code-events");
        if !found.is_empty() {
            r.supported_events = found;
        }
    }
    r.install_method = "config-home-or-executable".into();
    r.running_instances = managed::find_processes(&["claude"]);
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "claude-code",
        display_name: "Claude Code",
        docs_url: "https://code.claude.com/docs/en/hooks",
        hooks_files,
        events: supported_events,
        detect_impl,
        hook_command: super::hooks_install::hook_command,
        limitations: vec![
            "Claude Code 的 Hook 信任/权限确认由产品自身弹出，Task Dock 不代为确认".into(),
            "配置写入成功 ≠ 事件已到达；真实会话接入以非自测事件为准".into(),
        ],
        timeout_secs: 10,
    }
}
