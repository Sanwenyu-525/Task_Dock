//! ZCode 适配器（发现 + 进程识别；事件桥接待验证）。
//!
//! ZCode CLI 的 Hook 机制走插件市场：插件根目录 `hooks/hooks.json` 提供事件
//! （本机 zcode.cjs 实测事件全集：SessionStart / UserPromptSubmit / PreToolUse /
//!  PermissionRequest / PostToolUse / PostToolUseFailure / Stop；类型 command|process）。
//! 通过本地 marketplace 注册第三方插件缺少官方文档支持，直接写入存在破坏用户
//! 插件注册表的风险——本轮仅提供第 1/2 层发现与通用桥接指引，不自动安装。

use std::path::PathBuf;

use serde_json::{json, Value};

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, ManagedAdapter};
use crate::db::Db;
use crate::error::AppResult;

pub fn zcode_home() -> PathBuf {
    home_dir().join(".zcode")
}

#[derive(Clone)]
pub struct ZcodeAdapter;

pub fn adapter() -> ZcodeAdapter {
    ZcodeAdapter
}

impl ManagedAdapter for ZcodeAdapter {
    fn id(&self) -> &'static str {
        "zcode"
    }
    fn display_name(&self) -> &'static str {
        "ZCode"
    }
    fn transport_kind(&self) -> &'static str {
        "discovery"
    }
    fn docs_url(&self) -> &'static str {
        ""
    }
    fn limitations(&self) -> Vec<String> {
        vec![
            "ZCode 事件接入依赖插件市场机制（插件根 hooks/hooks.json），第三方本地注册无官方文档，自动安装风险高".into(),
            "当前仅支持：安装发现 + 运行实例识别 + 通用 HTTP/文件桥接（source_id=zcode）".into(),
            "无法读取真实执行状态时显示「未知」".into(),
        ]
    }

    fn detect(&self) -> DetectionReport {
        let mut r = DetectionReport {
            adapter: "zcode".into(),
            source_id: "zcode".into(),
            display_name: "ZCode".into(),
            installed: false,
            version: None,
            install_paths: vec![],
            config_homes: vec![],
            install_method: String::new(),
            running_instances: vec![],
            capabilities: vec!["generic-bridge".into()],
            supported_events: vec![],
            docs_url: self.docs_url().into(),
            limitations: self.limitations(),
        };
        let home = zcode_home();
        let app = std::env::var("LOCALAPPDATA")
            .ok()
            .map(|l| PathBuf::from(l).join("Programs").join("ZCode"))
            .filter(|p| p.exists());
        r.installed = home.exists() || app.is_some();
        if home.exists() {
            r.config_homes.push(home.to_string_lossy().to_string());
        }
        if let Some(a) = &app {
            r.install_paths.push(a.to_string_lossy().to_string());
        }
        r.install_method = "config-home-or-program-dir".into();
        r.running_instances = managed::find_processes(&["zcode", "ZCode"]);
        r
    }

    fn preview(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({
            "adapter": "zcode",
            "kind": "discovery",
            "installable": false,
            "bridge": {
                "http": "POST http://127.0.0.1:47821/api/v1/events (Authorization: Bearer <令牌>)",
                "body": { "source_id": "zcode", "session_id": "<会话>", "state": "running|waiting|completed|failed" },
                "file": "%APPDATA%\\com.taskdock.desktop\\agent-inbox\\zcode-<任意>.json"
            },
            "limitations": self.limitations(),
        }))
    }

    fn install(&self, _app_data: &std::path::Path, _db: &Db) -> AppResult<Value> {
        Ok(json!({
            "adapter": "zcode",
            "installed": false,
            "reason": "ZCode 插件市场自动注册未验证，本轮不自动写入；请使用通用桥接（HTTP/文件）",
            "limitations": self.limitations(),
        }))
    }

    fn verify(&self, _app_data: &std::path::Path, _db: &Db) -> AppResult<Value> {
        Ok(json!({
            "ok": false,
            "reason": "ZCode 无官方本地 Hook 配置文件；事件接入待插件市场机制验证",
        }))
    }

    fn uninstall(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({ "adapter": "zcode", "noop": true }))
    }

    fn config_status(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({ "adapter": "zcode", "installable": false, "note": "仅发现与桥接，无配置安装" }))
    }
}
