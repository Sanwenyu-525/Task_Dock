//! Tauri 命令：Agent MCP Server 管理（第二轮 UI 的后端契约）。
//!
//! 安全约定：
//! - `mcp_agent_create` 返回的 token 明文只出现这一次，库内只存 SHA-256；
//! - 撤销立即生效（bridge 每次请求从库里重读身份，无缓存窗口）；
//! - 任何命令的返回值与日志都不得包含 token 明文/哈希。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::audit::{self, AuditPage, LastCall, PruneReport};
use crate::mcp::auth::{self, McpAgentInfo};
use crate::mcp::bridge::McpRuntimeStatus;
use crate::mcp::diagnostics::DiagnosticsReport;
use crate::mcp::permissions::{self, CapabilityGrant, WorkspaceRoot};

#[derive(Serialize)]
pub struct McpStatus {
    /// 设置开关（mcp_server_enabled）
    pub enabled: bool,
    /// bridge 当前是否在监听（只反映实际运行状态）
    pub running: bool,
    /// bridge 端口（未运行为 null）
    pub port: Option<u16>,
    /// 已登记 Agent 数（含已撤销）
    pub agent_count: i64,
    /// 未撤销的 Agent 数
    pub active_agent_count: i64,
    pub started_at: Option<String>,
    /// 最近一次工具调用摘要（无调用为 null）
    pub last_call: Option<LastCall>,
}

#[tauri::command]
pub fn mcp_status(
    db: State<'_, Arc<Db>>,
    runtime: State<'_, Arc<McpRuntimeStatus>>,
) -> AppResult<McpStatus> {
    let enabled = db
        .get_setting("mcp_server_enabled")
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let (agent_count, active_agent_count): (i64, i64) = db.with_read(|conn| {
        let total = conn.query_row("SELECT COUNT(*) FROM mcp_agents", [], |r| r.get(0))?;
        let active = conn.query_row(
            "SELECT COUNT(*) FROM mcp_agents WHERE revoked_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        Ok((total, active))
    })?;
    let last_call = db.with_read(|conn| audit::last_call(conn)).ok().flatten();
    let (running, port) = runtime.snapshot();
    let started_at = runtime
        .started_at
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    Ok(McpStatus {
        enabled,
        running,
        port,
        agent_count,
        active_agent_count,
        started_at,
        last_call,
    })
}

#[tauri::command]
pub fn mcp_agent_list(db: State<'_, Arc<Db>>) -> AppResult<Vec<McpAgentInfo>> {
    auth::list_agents(&db)
}

/// 创建 Agent。返回值中的 `token` 明文只在本次响应出现，前端必须提示用户立即保存。
#[tauri::command]
pub fn mcp_agent_create(
    db: State<'_, Arc<Db>>,
    agent_id: String,
    display_name: String,
) -> AppResult<McpAgentCreated> {
    let created = auth::create_agent(&db, &agent_id, &display_name)?;
    Ok(McpAgentCreated {
        info: created.info,
        token: created.token,
    })
}

/// 为现有 Agent 轮换 token；旧 token 在事务提交后立即失效，明文只返回一次。
#[tauri::command]
pub fn mcp_agent_rotate_token(db: State<'_, Arc<Db>>, id: String) -> AppResult<McpAgentCreated> {
    let rotated = auth::rotate_agent_token(&db, &id)?;
    Ok(McpAgentCreated {
        info: rotated.info,
        token: rotated.token,
    })
}

#[derive(Serialize)]
pub struct McpAgentCreated {
    #[serde(flatten)]
    pub info: McpAgentInfo,
    /// 明文 token，仅此一次
    pub token: String,
}

#[tauri::command]
pub fn mcp_agent_set_scope(
    db: State<'_, Arc<Db>>,
    id: String,
    scope: String,
) -> AppResult<McpAgentInfo> {
    auth::set_agent_scope(&db, &id, &scope)
}

#[tauri::command]
pub fn mcp_agent_grant_project(
    db: State<'_, Arc<Db>>,
    id: String,
    project_id: String,
) -> AppResult<McpAgentInfo> {
    auth::grant_project(&db, &id, &project_id)
}

#[tauri::command]
pub fn mcp_agent_revoke_project(
    db: State<'_, Arc<Db>>,
    id: String,
    project_id: String,
) -> AppResult<McpAgentInfo> {
    auth::revoke_project(&db, &id, &project_id)
}

/// 撤销：置 revoked_at，立即生效（进行中的 HTTP 请求处理完即失效）。
#[tauri::command]
pub fn mcp_agent_revoke(db: State<'_, Arc<Db>>, id: String) -> AppResult<McpAgentInfo> {
    auth::revoke_agent(&db, &id)
}

/// 本机只读、分页审计摘要；不返回 detail、request_id 或幂等结果正文。
#[tauri::command]
pub fn mcp_audit_list(db: State<'_, Arc<Db>>, offset: u32, limit: u32) -> AppResult<AuditPage> {
    db.with_read(|conn| audit::list_page(conn, offset, limit))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnippetInput {
    /// claude-code | codex | cursor | trae | generic
    pub client: String,
    /// mcp_agent_create 返回的明文 token
    pub agent_token: String,
}

#[tauri::command]
pub fn mcp_config_snippet(input: ConfigSnippetInput) -> AppResult<String> {
    let exe = std::env::current_exe()
        .map_err(AppError::Io)?
        .to_string_lossy()
        .to_string();
    crate::mcp::config::config_snippet(&input.client, &exe, &input.agent_token)
}

/// 客户端配置文件位置说明（与可粘贴片段分离，避免注释污染 JSON/TOML）。
#[tauri::command]
pub fn mcp_config_hint(client: String) -> AppResult<String> {
    Ok(crate::mcp::config::config_hint(&client)?.to_string())
}

#[tauri::command]
pub fn mcp_agent_capabilities(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<Vec<CapabilityGrant>> {
    permissions::list(&db, &id)
}

/// 授予资源能力。`resource_id` 为空表示全局；非空只对单条任务/笔记/工作流生效。
#[tauri::command]
pub fn mcp_agent_grant_capability(
    db: State<'_, Arc<Db>>,
    id: String,
    capability: String,
    resource_id: Option<String>,
) -> AppResult<Vec<CapabilityGrant>> {
    permissions::grant(&db, &id, &capability, resource_id.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn mcp_agent_revoke_capability(
    db: State<'_, Arc<Db>>,
    id: String,
    capability: String,
    resource_id: Option<String>,
) -> AppResult<Vec<CapabilityGrant>> {
    permissions::revoke(&db, &id, &capability, resource_id.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn mcp_workspace_roots(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<Vec<WorkspaceRoot>> {
    permissions::list_roots(&db, &id)
}

#[tauri::command]
pub fn mcp_workspace_grant_root(
    db: State<'_, Arc<Db>>,
    id: String,
    path: String,
) -> AppResult<Vec<WorkspaceRoot>> {
    permissions::grant_root(&db, &id, &path)
}

#[tauri::command]
pub fn mcp_workspace_revoke_root(
    db: State<'_, Arc<Db>>,
    id: String,
    root_id: String,
) -> AppResult<Vec<WorkspaceRoot>> {
    permissions::revoke_root(&db, &id, &root_id)
}

/// 两段式审计清理：元数据保留与幂等载荷保留分开，默认只由用户显式触发。
#[tauri::command]
pub fn mcp_audit_prune(
    db: State<'_, Arc<Db>>,
    metadata_days: Option<i64>,
    payload_days: Option<i64>,
) -> AppResult<PruneReport> {
    let metadata = metadata_days.unwrap_or(180);
    let payload = payload_days.unwrap_or(7);
    db.with_conn(|conn| audit::prune(conn, metadata, payload))
}

/// 连接诊断：真实探测 bridge、传输文件、工具注册表、数据库与 Agent 身份。
#[tauri::command]
pub fn mcp_diagnostics(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    runtime: State<'_, Arc<McpRuntimeStatus>>,
    agent_id: Option<String>,
) -> AppResult<DiagnosticsReport> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Validation(format!("无法解析应用数据目录: {e}")))?;
    crate::mcp::diagnostics::run(&db, &runtime, &app_data, agent_id.as_deref())
}
