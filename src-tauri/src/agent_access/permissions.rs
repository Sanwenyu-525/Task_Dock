//! Agent 访问层的统一授权判定。
//!
//! 与 `mcp::permissions` 的关系：能力枚举与「能力 × 资源」存储只有一份，本模块只做
//! **主体 + scope + 能力** 的组合判定，供 CLI / MCP / REST / 文件四个入口共用。
//!
//! 判定顺序固定：身份 → scope → 能力 → （项目授权由既有 `mcp_agent_grants` 负责）。
//! 任何一层不满足都明确拒绝，绝不降级为只读执行。

use rusqlite::Connection;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::auth::McpScope;
use crate::mcp::permissions::{self as mcp_perm, Capability};

use super::{forbidden, Principal};

/// 读取当前身份在库内的 scope（每次请求重读，撤销即时生效）。
fn scope_of(conn: &Connection, agent_row_id: &str) -> AppResult<McpScope> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT scope FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
            rusqlite::params![agent_row_id],
            |r| r.get(0),
        )
        .ok();
    Ok(raw
        .as_deref()
        .and_then(McpScope::parse)
        .unwrap_or(McpScope::Disabled))
}

/// 要求能力（`resource_id` 为空表示全局；否则为该资源/项目 ID）。
pub fn require(
    db: &Db,
    principal: &Principal,
    capability: Capability,
    resource_id: &str,
) -> AppResult<()> {
    if principal.read_only && capability.is_write() {
        return Err(forbidden("当前为只读模式（TASKDOCK_CLI_READONLY=1）"));
    }
    // 本机用户（无 token 的 CLI）等同 UI：可读写，但仍写审计。
    if !principal.is_agent() {
        return Ok(());
    }
    let row_id = principal
        .agent_row_id
        .as_deref()
        .ok_or_else(|| forbidden("缺少 Agent 身份"))?;
    db.with_read(|conn| {
        let scope = scope_of(conn, row_id)?;
        if capability.is_write() {
            if !scope.can_write() {
                return Err(forbidden(format!(
                    "scope={} 不允许写操作（需要 project_rw）",
                    scope.as_str()
                )));
            }
        } else if !scope.can_read() {
            return Err(forbidden(format!(
                "scope={} 不允许读取（需要 readonly 或 project_rw）",
                scope.as_str()
            )));
        }
        if !mcp_perm::has(conn, row_id, capability, resource_id)? {
            return Err(forbidden(format!(
                "缺少能力 {}（resource_id={}）",
                capability.as_str(),
                if resource_id.is_empty() {
                    "global"
                } else {
                    resource_id
                }
            )));
        }
        Ok(())
    })
}

/// 至少持有一个读能力（用于 status/manifest/活动等聚合端点）。
pub fn require_any_read(db: &Db, principal: &Principal) -> AppResult<()> {
    if principal.read_only {
        // 只读模式本身就是允许读取的信号。
    }
    if !principal.is_agent() {
        return Ok(());
    }
    let row_id = principal
        .agent_row_id
        .as_deref()
        .ok_or_else(|| forbidden("缺少 Agent 身份"))?;
    db.with_read(|conn| {
        let scope = scope_of(conn, row_id)?;
        if !scope.can_read() {
            return Err(forbidden(format!("scope={} 不允许读取", scope.as_str())));
        }
        for cap in [
            Capability::ProjectsRead,
            Capability::TasksRead,
            Capability::PlansRead,
            Capability::KnowledgeRead,
            Capability::DecisionsRead,
            Capability::ContextRead,
            Capability::HandoffsRead,
            Capability::SkillsRead,
            Capability::NotesRead,
            Capability::WorkflowsRead,
        ] {
            if mcp_perm::has_global(conn, row_id, cap)? {
                return Ok(());
            }
        }
        Err(forbidden("没有任何读能力"))
    })
}

/// 按任务 ID 解析其所属项目（用于资源级授权与上下文）。
pub fn task_project(conn: &Connection, task_id: &str) -> AppResult<Option<String>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT project_id FROM workspace_task_links WHERE task_id = ?1 LIMIT 1",
            rusqlite::params![task_id],
            |r| r.get(0),
        )
        .ok();
    Ok(row)
}

/// 项目是否存在于两个既有项目体系之一。
pub fn project_exists(conn: &Connection, project_id: &str) -> AppResult<Option<&'static str>> {
    let planning: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM planning_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .ok();
    if planning.is_some() {
        return Ok(Some("planning"));
    }
    let workspace: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM workspace_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .ok();
    Ok(workspace.map(|_| "workspace"))
}

/// 统一错误：被拒绝时携带的能力名，便于客户端提示「去 UI 授权」。
pub fn denial(capability: Capability) -> AppError {
    forbidden(format!(
        "权限不足：需要 {}。请在 Task Dock「能力中心 → Agent 接入」中授权。",
        capability.as_str()
    ))
}
