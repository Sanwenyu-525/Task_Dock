//! ZCode 适配器（官方配置式 Hooks，用户级）。
//!
//! ZCode 的用户配置 `~/.zcode/cli/config.json` 支持配置式 hooks：
//! ```json
//! { "hooks": { "enabled": true, "events": { "<Event>": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } } }
//! ```
//! 事件全集（本机 zcode.cjs 与官方 `diagnosing-hooks` 指南一致）：
//! SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest /
//! PostToolUse / PostToolUseFailure / Stop。
//!
//! 注意：配置式 hooks **默认关闭**，必须写 `hooks.enabled = true` 才会执行
//! （插件 hooks 存在时 runner 会被自动启用，但 Task Dock 不注册插件）。
//! 首次安装后需新开 ZCode 会话，正在运行的会话不会热加载配置。

use std::path::PathBuf;

use super::hooks_install::{self, home_dir};
use super::managed::{self, DetectionReport, HooksAdapter};

/// 官方配置式 hooks 支持的全部事件（zcode.cjs 实测 + 官方诊断指南）。
pub const ZCODE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
];

/// ZCode 数据根（`~/.zcode`）。
pub fn zcode_home() -> PathBuf {
    home_dir().join(".zcode")
}

/// ZCode 用户级配置目录（`~/.zcode/cli`）。
pub fn config_home() -> PathBuf {
    zcode_home().join("cli")
}

/// 用户级配置文件：hooks 与 mcp / plugins 共用同一个 config.json。
pub fn hooks_files() -> Vec<PathBuf> {
    vec![config_home().join("config.json")]
}

pub fn supported_events() -> Vec<String> {
    ZCODE_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn program_dir() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|l| PathBuf::from(l).join("Programs").join("ZCode"))
        .filter(|p| p.exists())
}

fn detect_impl(r: &mut DetectionReport) {
    let home = zcode_home();
    let cfg = config_home();
    let app = program_dir();
    r.installed = home.exists() || cfg.exists() || app.is_some();
    if cfg.exists() {
        r.config_homes.push(cfg.to_string_lossy().to_string());
    } else if home.exists() {
        r.config_homes.push(home.to_string_lossy().to_string());
    }
    if let Some(a) = &app {
        r.install_paths.push(a.to_string_lossy().to_string());
    }
    r.install_method = "config-home-or-program-dir".into();
    r.running_instances = managed::find_processes(&["zcode", "ZCode"]);
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "zcode",
        display_name: "ZCode",
        docs_url: "",
        hooks_files,
        events: supported_events,
        detect_impl,
        // ZCode 在 Windows 上通过 ComSpec（cmd.exe）执行 command hooks；
        // 与 Codex 相同，`cmd.exe /c call "<exe>" ...` 避免引号被 cmd 当作路径的一部分。
        hook_command: hooks_install::codex_hook_command,
        layout: hooks_install::HooksLayout::NestedEvents,
        limitations: vec![
            "写入用户级 ~/.zcode/cli/config.json 的 hooks.events；安装时自动置 hooks.enabled=true"
                .into(),
            "配置式 hooks 默认关闭，且只在 ZCode 新会话启动时加载；已打开的会话不会热更新".into(),
            "只接入用户级配置；插件市场 hooks 与项目级 .zcode/config.json 不由 Task Dock 修改"
                .into(),
            "配置写入成功 ≠ 事件已到达；真实会话接入以非自测事件为准".into(),
        ],
        timeout_secs: 10,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::managed::ManagedAdapter;

    #[test]
    fn events_cover_zcode_config_schema() {
        assert_eq!(
            supported_events(),
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "PreToolUse",
                "PermissionRequest",
                "PostToolUse",
                "PostToolUseFailure",
                "Stop",
            ]
        );
    }

    #[test]
    fn hooks_file_is_user_config_json() {
        let files = hooks_files();
        assert_eq!(files.len(), 1);
        let s = files[0].to_string_lossy().replace('\\', "/");
        assert!(s.ends_with(".zcode/cli/config.json"), "{}", s);
    }

    #[test]
    fn adapter_uses_hooks_transport_and_nested_layout() {
        let a = adapter();
        assert_eq!(a.id(), "zcode");
        assert_eq!(a.transport_kind(), "hooks");
        assert_eq!(a.layout, hooks_install::HooksLayout::NestedEvents);
        assert_eq!((a.events)(), supported_events());
    }
}
