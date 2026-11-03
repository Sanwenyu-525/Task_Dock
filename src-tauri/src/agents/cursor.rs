//! Cursor 适配器（官方 Hooks，用户级配置）。
//!
//! 官方文档：<https://cursor.com/docs/hooks>
//! 只写用户级 `~/.cursor/hooks.json`，不修改项目级 `.cursor/hooks.json`；
//! 保留 `version` 等既有字段。Cursor 的 Hook 授权/确认流程由产品自身完成。

use std::path::PathBuf;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

/// 官方文档中的用户可见事件（保守基线，不使用未验证的内部事件）。
pub const BASELINE_EVENTS: &[&str] = &[
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "beforeReadFile",
    "afterFileEdit",
    "beforeShellExecution",
    "afterShellExecution",
    "stop",
];

pub fn config_home() -> PathBuf {
    home_dir().join(".cursor")
}

pub fn hooks_files() -> Vec<PathBuf> {
    vec![config_home().join("hooks.json")]
}

fn exe_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = managed::find_exe(&["cursor", "cursor.exe"]) {
        out.push(p);
    }
    for env in ["LOCALAPPDATA", "PROGRAMFILES"] {
        if let Ok(root) = std::env::var(env) {
            for sub in ["Programs\\Cursor\\Cursor.exe", "Cursor\\Cursor.exe"] {
                let p = PathBuf::from(&root).join(sub);
                if p.exists() && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

pub fn supported_events() -> Vec<String> {
    if let Some(exe) = exe_candidates().first() {
        let found = managed::scan_events_cached(exe, BASELINE_EVENTS, "cursor-events");
        if !found.is_empty() {
            return found;
        }
    }
    BASELINE_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let home = config_home();
    let exes = exe_candidates();
    r.installed = home.exists() || !exes.is_empty();
    r.config_homes = vec![home.to_string_lossy().to_string()];
    if let Some(e) = exes.first() {
        r.install_paths.push(e.to_string_lossy().to_string());
        r.version = managed::probe_version(e, &["--version"]);
        let found = managed::scan_events_cached(e, BASELINE_EVENTS, "cursor-events");
        if !found.is_empty() {
            r.supported_events = found;
        }
    }
    r.install_method = "config-home-or-executable".into();
    r.running_instances = managed::find_processes(&["cursor"]);
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "cursor",
        display_name: "Cursor",
        docs_url: "https://cursor.com/docs/hooks",
        hooks_files,
        events: supported_events,
        detect_impl,
        hook_command: super::hooks_install::hook_command,
        limitations: vec![
            "只接入用户级 ~/.cursor/hooks.json；项目级 hooks 不由 Task Dock 修改".into(),
            "Cursor 版本的 Hook 事件集合可能变化，安装前以二进制实扫结果为准".into(),
            "配置写入成功 ≠ 事件已到达；真实会话接入以非自测事件为准".into(),
        ],
        timeout_secs: 10,
    }
}
