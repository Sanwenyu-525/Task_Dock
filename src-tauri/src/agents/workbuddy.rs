//! WorkBuddy 适配器（WorkBuddy / CodeBuddy，桌面端与 CLI）。
//!
//! 官方 Hooks：用户级 settings.json 的 `hooks` 键。本机存在两个配置根：
//! `~/.workbuddy`（桌面端）与 `~/.workbuddy-ai`（AI 版），历史版本为 `~/.codebuddy`。
//! 格式为 Claude 兼容组结构；Windows 下 Hook 强制经 Git Bash 执行（powershell 命令行兼容）。
//!
//! ⚠️ 官方安全机制：外部修改 settings.json 不会立即生效——CLI 启动时对 hooks 做快照，
//! 会话期间被外部改动会警告，必须在 CLI 的 /hooks 面板审查确认后才应用。
//! 安装向导与文档必须明示这一步。

use std::path::PathBuf;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

/// 官方 Hooks 参考（27+ 事件中选取与执行状态相关的核心集）。
pub const WORKBUDDY_EVENTS: &[&str] = &[
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

/// 已存在的 WorkBuddy 配置根（可多个并存）。
pub fn settings_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for home in [".workbuddy", ".workbuddy-ai", ".codebuddy"] {
        let dir = home_dir().join(home);
        if dir.exists() {
            out.push(dir.join("settings.json"));
        }
    }
    if out.is_empty() {
        out.push(home_dir().join(".workbuddy").join("settings.json"));
    }
    out
}

pub fn supported_events() -> Vec<String> {
    WORKBUDDY_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let homes = [".workbuddy", ".workbuddy-ai", ".codebuddy"]
        .iter()
        .map(|h| home_dir().join(h))
        .filter(|p| p.exists())
        .collect::<Vec<_>>();
    let apps = [
        program_dir("WorkBuddy"),
        program_dir("WorkBuddyAI"),
        program_dir("CodeBuddy"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    r.installed = !homes.is_empty() || !apps.is_empty();
    for h in &homes {
        r.config_homes.push(h.to_string_lossy().to_string());
    }
    for a in &apps {
        r.install_paths.push(a.to_string_lossy().to_string());
    }
    r.install_method = "config-home-or-program-dir".into();
    r.running_instances = managed::find_processes(&["WorkBuddy", "CodeBuddy", "workbuddy", "codebuddy"]);
    r.capabilities.push("sdk-message-stream".into());
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "workbuddy",
        display_name: "WorkBuddy",
        docs_url: "https://www.workbuddy.ai/docs/zh/cli/hooks",
        hooks_files: settings_files,
        events: supported_events,
        detect_impl,
        limitations: vec![
            "官方安全机制：外部写入 settings.json 后，必须在 WorkBuddy CLI 的 /hooks 面板审查确认才生效".into(),
            "Windows 下 Hook 经 Git Bash 执行；Task Dock 命令行为 powershell 调用，已兼容".into(),
            "桌面端（WorkBuddy/WorkBuddyAI）与 CodeBuddy Code、Agent SDK 是不同产品形态，仅 hooks 通道为共同接口".into(),
        ],
        timeout_secs: 15,
    }
}
