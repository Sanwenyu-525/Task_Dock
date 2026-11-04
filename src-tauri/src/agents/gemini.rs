//! Gemini CLI 适配器（官方 Hooks）。
//!
//! 官方文档：<https://geminicli.com/docs/hooks>
//! 配置：`~/.gemini/settings.json` 的 `hooks` 字段。
//! Gemini CLI 的 Hook 信任/启用确认由产品自身完成，Task Dock 不绕过。

use std::path::PathBuf;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

/// 官方文档事件（AfterAgent 表示一轮结束；BeforeTool/AfterTool 表示执行中）。
pub const BASELINE_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "AfterAgent",
    "BeforeModel",
    "AfterModel",
    "BeforeToolSelection",
    "BeforeTool",
    "AfterTool",
    "PreCompress",
    "Notification",
];

pub fn config_home() -> PathBuf {
    home_dir().join(".gemini")
}

pub fn hooks_files() -> Vec<PathBuf> {
    vec![config_home().join("settings.json")]
}

fn find_exe() -> Option<PathBuf> {
    managed::find_exe(&["gemini", "gemini.exe"])
}

pub fn supported_events() -> Vec<String> {
    if let Some(exe) = find_exe() {
        let found = managed::scan_events_cached(&exe, BASELINE_EVENTS, "gemini-cli-events");
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
        let found = managed::scan_events_cached(e, BASELINE_EVENTS, "gemini-cli-events");
        if !found.is_empty() {
            r.supported_events = found;
        }
    }
    r.install_method = "config-home-or-executable".into();
    r.running_instances = managed::find_processes(&["gemini"]);
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "gemini-cli",
        display_name: "Gemini CLI",
        docs_url: "https://geminicli.com/docs/hooks",
        hooks_files,
        events: supported_events,
        detect_impl,
        hook_command: super::hooks_install::hook_command,
        layout: super::hooks_install::HooksLayout::Flat,
        limitations: vec![
            "Gemini CLI 与 Gemini IDE 插件形态不同，本适配器只覆盖 CLI 配置".into(),
            "配置写入成功 ≠ 事件已到达；真实会话接入以非自测事件为准".into(),
        ],
        timeout_secs: 10,
    }
}
