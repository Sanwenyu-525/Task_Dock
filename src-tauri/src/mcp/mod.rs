//! Agent MCP Server（迁移 v37）：外部 MCP 客户端（Claude Code、Codex CLI、Cursor、
//! Trae 等）经 stdio JSON-RPC 安全读写规划中心的最小闭环。
//!
//! 架构（固定，不得绕过）：
//! ```text
//! MCP 客户端 → taskdock.exe --mcp-server（同二进制 stdio 子命令，无库访问）
//!            → HTTP loopback(127.0.0.1) mcp_bridge（hyper + Bearer 常量时间比较，
//!              独立端口独立 token，参数与 http_ingest.rs 同模式）
//!            → 主进程规划服务层（commands/planning.rs 的 *_impl，不得绕过）
//!            → SQLite
//! ```
//!
//! 安全边界：
//! - 双层凭据：`mcp-transport.json` 的 bridge token 保护 loopback 端口本身
//!   （参照 agents/hook_cli.rs 的 hook-transport.json 模式，仅本机用户可读）；
//!   agent token（客户端 env `TASKDOCK_MCP_TOKEN`）确立 Agent 身份与授权，
//!   库内只存 SHA-256，明文只在创建命令返回值出现一次；
//! - scope：`disabled`（拒绝一切）/ `readonly`（只读工具）/ `project_rw`
//!   （读 + 已授权项目的写）；写工具逐项目校验 grant，未授权明确拒绝，不降级；
//! - 每次工具调用写审计（动作/对象/身份/request_id/成功/授权/脱敏摘要）；
//!   写工具支持 request_id 幂等重放（重复请求返回原结果，不重复执行）；
//! - 传输 token 与 agent 凭据绝不写入日志、事件、审计 detail 或任何可提交文件；
//! - `taskdock_update_feature` 不得置 status='completed'（验收完成由用户判定）；
//!   `taskdock_submit_for_review` 只能置为 'review'；
//! - MCP 客户端无法触碰内置路线图 featureCatalog（它不在 planning 表，天然隔离）。

pub mod audit;
pub mod auth;
pub mod bridge;
pub mod commands;
pub mod config;
pub mod protocol;
pub mod tools;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

/// stdio 子命令读取的传输参数文件（端口 + bridge token + 启停）。
/// 与 agents/hook_cli.rs 的 hook-transport.json 同模式：主进程写入，
/// 原子替换；stdio 子进程只读，不落库、不进备份。
pub const TRANSPORT_FILE: &str = "mcp-transport.json";

/// stdio 子进程从 MCP 客户端 env 中读取的 agent token 变量名。
pub const AGENT_TOKEN_ENV: &str = "TASKDOCK_MCP_TOKEN";

/// MCP 写入成功后广播给前端的事件名（usePlanningStore 订阅，局部刷新）。
pub const PLANNING_CHANGED_EVENT: &str = "planning-changed";

/// `planning-changed` 事件载荷（camelCase，与前端 bridge.ts 契约一致）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanningChanged {
    /// project | feature | step | milestone | activity
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
}

/// 写成功后的事件回调：主进程内实现为 Tauri emit；测试注入收集器。
/// 用回调而非直接依赖 AppHandle，保持工具层可在无 Tauri 运行时下测试。
pub type ChangeEmitter = std::sync::Arc<dyn Fn(PlanningChanged) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTransport {
    pub enabled: bool,
    /// 0 = 未运行
    pub port: u16,
    /// bridge token（仅保护 loopback 端口，不含任何 agent 凭据）
    pub token: String,
}

pub fn transport_path(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join(TRANSPORT_FILE)
}

/// 主进程启动/停止 bridge 与设置变更时调用；原子替换，读到的一定是完整 JSON。
pub fn write_transport_config(
    app_data: &std::path::Path,
    port: u16,
    token: &str,
    enabled: bool,
) -> crate::error::AppResult<()> {
    std::fs::create_dir_all(app_data)?;
    let path = transport_path(app_data);
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_string(&McpTransport {
        enabled,
        port,
        token: token.to_string(),
    })?;
    std::fs::write(&tmp, body)?;
    if std::fs::rename(&tmp, &path).is_err() {
        // Windows 上 rename 不覆盖既有文件：先移除旧文件再试一次
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&tmp, &path)?;
    }
    Ok(())
}

/// stdio 子进程的数据目录：与 hook_cli 相同的隔离规则（TASK_DOCK_DATA_DIR 优先）。
pub fn stdio_app_data_dir() -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR") {
        return std::path::PathBuf::from(dir);
    }
    std::env::var("APPDATA")
        .map(|a| std::path::PathBuf::from(a).join("com.taskdock.desktop"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}
