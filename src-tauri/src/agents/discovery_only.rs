//! 仅有安装/运行发现、尚无可靠官方事件接口的产品。
//!
//! 这些产品不写入任何配置，避免伪造「已接入」：
//! - 安装识别（可执行文件/配置目录/VS Code 扩展）；
//! - 运行进程识别；
//! - 通过 `bridge` 来源提供通用 HTTP / 文件投递接入指引。
//!
//! 官方 Hooks/SDK/API 未核实前，不注册其配置目录，也不共用其他产品的事件表。

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, ManagedAdapter, ProcessInfo};

pub struct DiscoveryOnlyAdapter {
    pub source_id: &'static str,
    pub display_name: &'static str,
    pub docs_url: &'static str,
    pub config_dirs: Vec<PathBuf>,
    pub exe_names: Vec<&'static str>,
    pub process_names: Vec<&'static str>,
    /// VS Code 扩展目录前缀（用于识别 IDE 插件形态）
    pub vsix_prefix: Option<&'static str>,
    pub capabilities: Vec<&'static str>,
    pub limitations: Vec<String>,
}

fn vscode_extensions_dir() -> PathBuf {
    home_dir().join(".vscode").join("extensions")
}

fn has_vsix(prefix: &str) -> bool {
    let dir = vscode_extensions_dir();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().starts_with(prefix))
}

impl ManagedAdapter for DiscoveryOnlyAdapter {
    fn id(&self) -> &'static str {
        self.source_id
    }
    fn display_name(&self) -> &'static str {
        self.display_name
    }
    fn transport_kind(&self) -> &'static str {
        "discovery"
    }
    fn docs_url(&self) -> &'static str {
        self.docs_url
    }
    fn limitations(&self) -> Vec<String> {
        self.limitations.clone()
    }

    fn detect(&self) -> DetectionReport {
        let exe = self
            .exe_names
            .first()
            .and_then(|n| managed::find_exe(&[*n]));
        let vsix = self.vsix_prefix.map(has_vsix).unwrap_or(false);
        let installed = exe.is_some() || vsix || self.config_dirs.iter().any(|p| p.exists());
        let running: Vec<ProcessInfo> = if self.process_names.is_empty() {
            Vec::new()
        } else {
            managed::find_processes(&self.process_names)
        };
        DetectionReport {
            adapter: self.source_id.into(),
            source_id: self.source_id.into(),
            display_name: self.display_name.into(),
            installed,
            version: exe
                .as_ref()
                .and_then(|e| managed::probe_version(e, &["--version"])),
            install_paths: exe
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            config_homes: self
                .config_dirs
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            install_method: "config-home-executable-or-vsix".into(),
            running_instances: running,
            capabilities: self.capabilities.iter().map(|c| c.to_string()).collect(),
            supported_events: Vec::new(),
            docs_url: self.docs_url.into(),
            limitations: self.limitations.clone(),
        }
    }

    fn preview(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({
            "adapter": self.source_id,
            "supported": false,
            "changes": [],
            "reason": "未核实官方 Hooks/SDK/API，不提供自动配置写入",
        }))
    }

    fn install(&self, _app_data: &std::path::Path, _db: &Db) -> AppResult<Value> {
        Err(AppError::Agent(format!(
            "{} 暂无可靠的官方事件接口，Task Dock 不写入配置、不伪造接入；请使用 bridge 通用通道（HTTP / 文件投递）",
            self.display_name
        )))
    }

    fn verify(&self, _app_data: &std::path::Path, _db: &Db) -> AppResult<Value> {
        Err(AppError::Agent(format!(
            "{} 没有可用官方事件接口，无法做真实事件验证",
            self.display_name
        )))
    }

    fn uninstall(&self, _app_data: &std::path::Path, _db: &Db) -> AppResult<Value> {
        Ok(json!({ "adapter": self.source_id, "noop": true }))
    }

    fn config_status(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({
            "adapter": self.source_id,
            "supported": false,
            "configured": false,
            "reason": "仅安装/运行发现",
        }))
    }
}

fn generic(
    source_id: &'static str,
    display_name: &'static str,
    docs_url: &'static str,
    config_dirs: Vec<PathBuf>,
    exe_names: Vec<&'static str>,
    process_names: Vec<&'static str>,
    vsix_prefix: Option<&'static str>,
) -> Box<dyn ManagedAdapter> {
    Box::new(DiscoveryOnlyAdapter {
        source_id,
        display_name,
        docs_url,
        config_dirs,
        exe_names,
        process_names,
        vsix_prefix,
        capabilities: vec!["install-discovery", "process-discovery", "bridge-manual"],
        limitations: vec![
            "官方 Hooks/SDK/API 未核实：仅做安装与运行发现，不写入配置".into(),
            "事件接入请使用 bridge 通用通道（HTTP / 文件投递）".into(),
        ],
    })
}

/// 第二/三/四组产品的发现型适配器。
pub fn adapters() -> Vec<Box<dyn ManagedAdapter>> {
    let mut out: Vec<Box<dyn ManagedAdapter>> = vec![
        generic(
            "windsurf",
            "Windsurf / Cascade",
            "https://docs.windsurf.com/windsurf/cascade/cascade",
            vec![home_dir().join(".codeium").join("windsurf")],
            vec!["windsurf"],
            vec!["Windsurf"],
            None,
        ),
        generic(
            "cline",
            "Cline",
            "https://cline.bot",
            vec![home_dir().join(".cline")],
            vec![],
            vec![],
            Some("saoudrizwan.claude-dev"),
        ),
        generic(
            "roo-code",
            "Roo Code",
            "https://roocode.com",
            vec![home_dir().join(".roo")],
            vec![],
            vec![],
            Some("rooveterinaryinc.roo-cline"),
        ),
        generic(
            "copilot",
            "GitHub Copilot CLI",
            "https://github.com/github/copilot-cli",
            vec![home_dir().join(".copilot")],
            vec!["copilot"],
            vec!["copilot"],
            Some("github.copilot"),
        ),
    ];
    let mut antigravity_dirs = vec![home_dir().join(".antigravity")];
    if let Some(local) = std::env::var("LOCALAPPDATA").ok().map(PathBuf::from) {
        antigravity_dirs.push(local.join("Programs").join("Antigravity"));
    }
    out.push(Box::new(DiscoveryOnlyAdapter {
        source_id: "antigravity",
        display_name: "Google Antigravity",
        docs_url: "https://antigravity.google",
        config_dirs: antigravity_dirs,
        exe_names: vec!["antigravity", "Antigravity"],
        process_names: vec!["Antigravity"],
        vsix_prefix: None,
        capabilities: vec!["install-discovery", "process-discovery", "bridge-manual"],
        limitations: vec![
            "官方事件接口未核实；仅做安装与运行发现".into(),
            "事件接入请使用 bridge 通用通道（HTTP / 文件投递）".into(),
        ],
    }));
    out.push(generic(
        "kiro",
        "Kiro",
        "https://kiro.dev",
        vec![home_dir().join(".kiro")],
        vec!["kiro"],
        vec!["Kiro"],
        None,
    ));
    out.push(generic(
        "continue",
        "Continue",
        "https://docs.continue.dev",
        vec![home_dir().join(".continue")],
        vec![],
        vec![],
        Some("continue.continue"),
    ));
    out.push(generic(
        "aider",
        "Aider",
        "https://aider.chat/docs/",
        vec![home_dir().join(".aider.conf.yml")],
        vec!["aider"],
        vec!["aider"],
        None,
    ));
    out.push(generic(
        "augment",
        "Augment",
        "https://www.augmentcode.com",
        vec![home_dir().join(".augment")],
        vec!["augment"],
        vec![],
        Some("augment.vscode"),
    ));
    out.push(generic(
        "openhands",
        "OpenHands",
        "https://docs.all-hands.dev",
        vec![home_dir().join(".openhands")],
        vec!["openhands"],
        vec!["openhands"],
        None,
    ));
    out.push(generic(
        "openclaw",
        "OpenClaw",
        "",
        vec![home_dir().join(".openclaw")],
        vec!["openclaw"],
        vec!["openclaw"],
        None,
    ));
    out
}
