//! AgentDiscoveryService（第二阶段）：四层自动发现引擎。
//!
//! 第 1 层 安装识别：配置目录 / PATH 可执行文件 / 常见安装目录 / 注册表卸载信息
//!         （受支持的系统接口 + 预定义白名单路径，不做全盘遍历）；
//! 第 2 层 运行实例：按进程名枚举（tasklist），多实例分别识别；
//!         运行 ≠ 执行任务——执行状态只由真实事件决定；
//! 第 3 层 接口能力：官方 Hooks / 宿主插件事件 / 通用桥接（含事件能力核验）；
//! 第 4 层 真实事件验证：数据库证据（verified / last_event_at / 最近事件流水）。
//!
//! 性能：安装层为低频操作（用户点击扫描时执行），进程枚举单次 <100ms，不做任何轮询。

use serde_json::json;

use crate::db::Db;

use super::managed::{self, DetectionReport};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredAgent {
    pub source_id: String,
    pub display_name: String,
    pub transport_kind: String,
    /// 第 1 层
    pub installed: bool,
    pub version: Option<String>,
    pub install_paths: Vec<String>,
    pub config_homes: Vec<String>,
    pub install_method: String,
    /// 第 2 层
    pub running_instances: Vec<managed::ProcessInfo>,
    /// 第 3 层
    pub capabilities: Vec<String>,
    pub supported_events: Vec<String>,
    pub docs_url: String,
    pub limitations: Vec<String>,
    /// 第 4 层（DB 证据）
    pub registered: bool,
    pub enabled: bool,
    pub configured: bool,
    pub verified: bool,
    pub last_event_at: Option<String>,
    /// live | stale | awaiting-first-event | no-events | unregistered
    pub health_state: String,
}

/// 注册表卸载键枚举（OnceLock 进程级缓存：单次扫描内多个适配器共享，避免重复枚举）。
fn uninstall_key_lines() -> &'static Vec<String> {
    use std::sync::OnceLock;
    static LINES: OnceLock<Vec<String>> = OnceLock::new();
    LINES.get_or_init(|| {
        let mut lines = Vec::new();
        let keys = [
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ];
        for key in keys {
            if let Ok(out) = crate::winproc::hidden("reg").args(["query", key]).output() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    lines.push(line.to_string());
                }
            }
        }
        lines
    })
}

/// 注册表卸载信息（HKCU + HKLM，仅查询预定义键，只读；枚举结果进程内共享）。
fn registry_uninstall_mentions(names: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    for line in uninstall_key_lines() {
        for n in names {
            if line.to_ascii_lowercase().contains(&n.to_ascii_lowercase()) {
                let path = line.split("    ").last().unwrap_or(line).trim().to_string();
                if !path.is_empty() && !found.contains(&path) {
                    found.push(path);
                }
            }
        }
    }
    found
}

/// 全量扫描：安装 → 实例 → 能力 → 事件证据。
pub fn scan_all(db: &Db) -> Vec<DiscoveredAgent> {
    let adapters = managed::all_adapters();
    let mut out = Vec::new();
    for a in &adapters {
        let d: DetectionReport = a.detect();
        // 第 1 层补充：注册表卸载信息
        let reg = registry_uninstall_mentions(&[a.id(), a.display_name()]);
        let installed = d.installed || !reg.is_empty();

        // 第 4 层：DB 证据（按检测到的 source_id 查——个别适配器 id 与来源 id 不同，如 dsh → deepseek-harness）
        let health = managed::source_health(db, &d.source_id);
        let registered = health.get("state") != Some(&json!("unregistered"));

        out.push(DiscoveredAgent {
            source_id: d.source_id.clone(),
            display_name: d.display_name.clone(),
            transport_kind: a.transport_kind().to_string(),
            installed,
            version: d.version.clone(),
            install_paths: {
                let mut p = d.install_paths.clone();
                for r in reg {
                    if !p.contains(&r) {
                        p.push(r);
                    }
                }
                p
            },
            config_homes: d.config_homes.clone(),
            install_method: d.install_method.clone(),
            running_instances: d.running_instances.clone(),
            capabilities: d.capabilities.clone(),
            supported_events: d.supported_events.clone(),
            docs_url: d.docs_url.clone(),
            limitations: d.limitations.clone(),
            registered,
            enabled: health
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            configured: health
                .get("configured")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            verified: health
                .get("verified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            last_event_at: health
                .get("last_event_at")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            health_state: health
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("unregistered")
                .to_string(),
        });
    }
    // 附加通用桥接来源（manual，不属于任何具体 Adapter）
    let health = managed::source_health(db, "bridge");
    out.push(DiscoveredAgent {
        source_id: "bridge".into(),
        display_name: "通用桥接".into(),
        transport_kind: "manual".into(),
        installed: true,
        version: None,
        install_paths: vec![],
        config_homes: vec![],
        install_method: "built-in".into(),
        running_instances: vec![],
        capabilities: vec!["http-ingest".into(), "file-drop".into()],
        supported_events: vec![],
        docs_url: String::new(),
        limitations: vec!["任意 Agent 可通过本地 HTTP / 文件投递上报（source_id=bridge）".into()],
        registered: health.get("state") != Some(&json!("unregistered")),
        enabled: health
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        configured: true,
        verified: health
            .get("verified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        last_event_at: health
            .get("last_event_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        health_state: health
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("unregistered")
            .to_string(),
    });
    out
}
