//! 身份、能力与审计。
//!
//! 服务端推导 Actor：IPC 只构造本机用户；MCP 由 `McpAgentRow` 构造；AI 结果用 System。
//! 调用方传入的任何 `actor` 字段一律忽略。

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::mcp::auth::McpScope;

use super::util::{new_id, now_iso};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorKind {
    Ui,
    Agent,
    System,
}

impl ActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ActorKind::Ui => "ui",
            ActorKind::Agent => "agent",
            ActorKind::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    ContextRead,
    IssuesRead,
    IssuesWrite,
    PlansRead,
    PlansWrite,
    PlansReview,
    VisualRead,
    VisualWrite,
    EvidenceWrite,
    AiGenerate,
}

#[derive(Debug, Clone)]
pub struct Actor {
    /// 稳定身份：UI=`local-user`；Agent=`mcp:<row_id>`；System=`system`。
    pub id: String,
    /// 展示名（Agent 为 display_name）。
    pub name: String,
    pub kind: ActorKind,
    pub source: String,
    /// MCP Agent 行 ID（审计/项目授权用）。
    pub agent_row_id: Option<String>,
    pub can_read: bool,
    pub can_write: bool,
    pub can_review: bool,
}

impl Actor {
    pub fn ui() -> Self {
        Self {
            id: "local-user".to_string(),
            name: "本机用户".to_string(),
            kind: ActorKind::Ui,
            source: "ui".to_string(),
            agent_row_id: None,
            can_read: true,
            can_write: true,
            can_review: true,
        }
    }

    pub fn agent(row: &crate::mcp::auth::McpAgentRow, source: &str) -> Self {
        Self {
            id: format!("mcp:{}", row.row_id),
            name: row.display_name.clone(),
            kind: ActorKind::Agent,
            source: source.to_string(),
            agent_row_id: Some(row.row_id.clone()),
            can_read: row.scope != McpScope::Disabled,
            can_write: row.scope == McpScope::ProjectRw,
            // 审批权永不下放给 Agent（即使未来新增 capability）。
            can_review: false,
        }
    }

    pub fn system() -> Self {
        Self {
            id: "system".to_string(),
            name: "系统".to_string(),
            kind: ActorKind::System,
            source: "system".to_string(),
            agent_row_id: None,
            can_read: true,
            can_write: true,
            can_review: false,
        }
    }

    pub fn allows(&self, cap: Capability) -> bool {
        match cap {
            Capability::ContextRead
            | Capability::IssuesRead
            | Capability::PlansRead
            | Capability::VisualRead => self.can_read,
            Capability::PlansReview => self.can_review && self.kind == ActorKind::Ui,
            Capability::IssuesWrite
            | Capability::PlansWrite
            | Capability::VisualWrite
            | Capability::EvidenceWrite
            | Capability::AiGenerate => self.can_write,
        }
    }

    pub fn require(&self, cap: Capability) -> AppResult<()> {
        if self.allows(cap) {
            Ok(())
        } else {
            Err(AppError::Forbidden(format!(
                "当前身份无权执行该操作（{:?}）",
                cap
            )))
        }
    }

    pub fn require_review(&self) -> AppResult<()> {
        if self.kind != ActorKind::Ui {
            return Err(AppError::Forbidden(
                "方案审批只能由本机开发者完成".to_string(),
            ));
        }
        self.require(Capability::PlansReview)
    }

    pub fn kind_str(&self) -> &'static str {
        self.kind.as_str()
    }
}

/// 项目归属校验：UI 直接通过；Agent 必须有 `mcp_agent_grants` 命中。
pub fn assert_project_scope(conn: &Connection, actor: &Actor, project_id: &str) -> AppResult<()> {
    if !project_exists(conn, project_id)? {
        return Err(AppError::NotFound("项目不存在".to_string()));
    }
    if actor.kind != ActorKind::Agent {
        return Ok(());
    }
    let row = actor
        .agent_row_id
        .as_deref()
        .ok_or_else(|| AppError::Forbidden("Agent 身份缺少行 ID".to_string()))?;
    let granted: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM mcp_agent_grants WHERE agent_row_id = ?1 AND project_id = ?2 LIMIT 1",
            rusqlite::params![row, project_id],
            |r| r.get(0),
        )
        .optional()?;
    if granted.is_none() {
        // 不区分「项目不存在」与「未授权」，避免枚举其他项目。
        return Err(AppError::Forbidden("无权访问该项目".to_string()));
    }
    Ok(())
}

pub fn project_exists(conn: &Connection, project_id: &str) -> AppResult<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM planning_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(exists.is_some())
}

/// 写审计行（必须在业务事务内调用；失败则整组回滚）。
#[allow(clippy::too_many_arguments)]
pub fn write_audit(
    conn: &Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    action: &str,
    actor: &Actor,
    revision_before: Option<i64>,
    revision_after: Option<i64>,
    detail: Value,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO collab_audit
         (id, project_id, entity_kind, entity_id, action, actor, actor_kind, source,
          revision_before, revision_after, detail_json, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        rusqlite::params![
            new_id("ca"),
            project_id,
            entity_kind,
            entity_id,
            action,
            actor.id,
            actor.kind_str(),
            actor.source,
            revision_before,
            revision_after,
            detail.to_string(),
            now_iso(),
        ],
    )?;
    Ok(())
}

/// 读取审计分页（UI 只读）。
pub fn list_audit(
    conn: &Connection,
    project_id: &str,
    entity_kind: Option<&str>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<super::model::Page<super::model::AuditEntry>> {
    let (page, size, offset) = super::util::page_bounds(page, page_size, super::model::PAGE_MAX);
    let total: i64 = match entity_kind {
        Some(kind) => conn.query_row(
            "SELECT COUNT(*) FROM collab_audit WHERE project_id=?1 AND entity_kind=?2",
            rusqlite::params![project_id, kind],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT COUNT(*) FROM collab_audit WHERE project_id=?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )?,
    };
    let sql = if entity_kind.is_some() {
        "SELECT id, project_id, entity_kind, entity_id, action, actor, actor_kind, source, \
         revision_before, revision_after, detail_json, created_at \
         FROM collab_audit WHERE project_id=?1 AND entity_kind=?2 \
         ORDER BY created_at DESC LIMIT ?3 OFFSET ?4"
    } else {
        "SELECT id, project_id, entity_kind, entity_id, action, actor, actor_kind, source, \
         revision_before, revision_after, detail_json, created_at \
         FROM collab_audit WHERE project_id=?1 \
         ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
    };
    let mut stmt = conn.prepare(sql)?;
    let map = |r: &rusqlite::Row<'_>| {
        Ok(super::model::AuditEntry {
            id: r.get(0)?,
            project_id: r.get(1)?,
            entity_kind: r.get(2)?,
            entity_id: r.get(3)?,
            action: r.get(4)?,
            actor: r.get(5)?,
            actor_kind: r.get(6)?,
            source: r.get(7)?,
            revision_before: r.get(8)?,
            revision_after: r.get(9)?,
            detail_json: r.get(10)?,
            created_at: r.get(11)?,
        })
    };
    let items = if let Some(kind) = entity_kind {
        stmt.query_map(rusqlite::params![project_id, kind, size, offset], map)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(rusqlite::params![project_id, size, offset], map)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(super::model::Page::new(items, total, page, size))
}
