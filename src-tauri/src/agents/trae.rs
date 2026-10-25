//! Trae 适配器（Trae IDE / Trae CN）。
//!
//! 官方 Hooks：用户级 `~/.trae/hooks.json`（国际版）与 `~/.trae-cn/hooks.json`（CN 版），
//! 项目级 `.trae/hooks.json`；格式为 Claude 兼容组结构。
//! 事件（官方文档 hook-configuration-reference）：SessionStart / UserPromptSubmit /
//! PreToolUse / PostToolUse / Stop / Notification。
//! 国际版与 CN 版配置相互独立：同时安装时一并写入。

use std::path::PathBuf;

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, HooksAdapter};

pub const TRAE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
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
    let mut out = Vec::new();
    let int = home_dir().join(".trae").join("hooks.json");
    let cn = home_dir().join(".trae-cn").join("hooks.json");
    // 只写入已存在的 Trae 配置根（不存在的说明该版本未安装/未启动过）
    if int.parent().map(|p| p.exists()).unwrap_or(false) {
        out.push(int);
    }
    if cn.parent().map(|p| p.exists()).unwrap_or(false) {
        out.push(cn);
    }
    if out.is_empty() {
        // 都不存在时默认国际版路径（安装器会创建目录）
        out.push(home_dir().join(".trae").join("hooks.json"));
    }
    out
}

pub fn supported_events() -> Vec<String> {
    TRAE_EVENTS.iter().map(|s| s.to_string()).collect()
}

fn detect_impl(r: &mut DetectionReport) {
    let int_home = home_dir().join(".trae");
    let cn_home = home_dir().join(".trae-cn");
    let int_app = program_dir("Trae");
    let cn_app = program_dir("Trae CN");
    r.installed = int_home.exists() || cn_home.exists() || int_app.is_some() || cn_app.is_some();
    if int_home.exists() {
        r.config_homes.push(int_home.to_string_lossy().to_string());
    }
    if cn_home.exists() {
        r.config_homes.push(cn_home.to_string_lossy().to_string());
    }
    if let Some(p) = &int_app {
        r.install_paths.push(p.to_string_lossy().to_string());
    }
    if let Some(p) = &cn_app {
        r.install_paths.push(p.to_string_lossy().to_string());
    }
    r.install_method = "config-home-or-program-dir".into();
    r.running_instances = managed::find_processes(&["Trae"]);
    // 注意：不探测 IDE 版本——Trae 的 CLI 启动器会拉起整个 IDE，探测会阻塞并打扰用户；
    // 版本信息留待官方 CLI 元数据可用时再补充。
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "trae",
        display_name: "Trae",
        docs_url: "https://docs.trae.ai/ide/hook-configuration-reference",
        hooks_files,
        events: supported_events,
        detect_impl,
        limitations: vec![
            "事件名以官方 Hook 配置参考为准（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification）；未在本机完成真实会话联调前标记「待验证」".into(),
            "国际版与 CN 版配置独立，接入会同时写入已安装版本的配置".into(),
        ],
        timeout_secs: 10,
    }
}
