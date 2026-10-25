//! Qoder 适配器（Qoder / Qoder CN，IDE 与 CLI 共用 Hooks）。
//!
//! 官方文档：https://docs.qoder.cn/qoder/hooks
//! 配置：用户级 `~/.qoder/settings.json` 的 `hooks` 键（项目级 .qoder/settings.json 可选）。
//! 格式为 Claude 兼容组结构，处理程序支持 command / http / prompt / agent 类型；
//! Task Dock 使用 command 类型（与其他 Agent 一致、可审计、可卸载）。
//! 事件含 PermissionRequest / PermissionDenied（官方文档确认）。

use std::path::PathBuf;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

pub const QODER_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "Notification",
];

fn program_dir(name: &str) -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|l| PathBuf::from(l).join("Programs").join(name))
        .filter(|p| p.exists())
}

pub fn hooks_files() -> Vec<PathBuf> {
    let home = home_dir().join(".qoder");
    if home.exists() {
        vec![home.join("settings.json")]
    } else {
        // 未安装/未启动过：默认路径（安装器创建目录）
        vec![home.join("settings.json")]
    }
}

pub fn supported_events() -> Vec<String> {
    QODER_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let home = home_dir().join(".qoder");
    let apps = [program_dir("Qoder"), program_dir("Qoder CN")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let cli = managed::find_exe(&["qoder", "qoder.exe"]);
    r.installed = home.exists() || !apps.is_empty() || cli.is_some();
    if home.exists() {
        r.config_homes.push(home.to_string_lossy().to_string());
    }
    for a in &apps {
        r.install_paths.push(a.to_string_lossy().to_string());
    }
    if let Some(c) = &cli {
        r.install_paths.push(c.to_string_lossy().to_string());
        r.version = managed::probe_version(c, &["--version"]);
    }
    r.install_method = "config-home-or-program-dir".into();
    r.running_instances = managed::find_processes(&["Qoder", "qoder"]);
    r.capabilities.push("http-handler".into());
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "qoder",
        display_name: "Qoder",
        docs_url: "https://docs.qoder.cn/qoder/hooks",
        hooks_files: hooks_files,
        events: supported_events,
        detect_impl,
        limitations: vec![
            "Qoder CN 与国际版配置根相同（~/.qoder），事件以官方 CN 文档为准；国际版未在本机联调前标记「待验证」".into(),
            "官方文档明示：配置可见 ≠ Hook 已被 Runtime 加载执行，需以实际任务验证".into(),
        ],
        timeout_secs: 10,
    }
}
