//! MCP 资源能力与工作区授权（迁移 64）。
//!
//! 与 `auth.rs` 的分工：
//! - `auth.rs` 管 **身份**：token、scope（disabled/readonly/project_rw）、项目写授权。
//! - 本模块管 **资源能力**：任务 / 笔记 / 工作流 / 文件工作区。
//!
//! 判定顺序固定为「scope → 能力 → 资源范围」，任何一层不满足都明确拒绝，
//! 绝不把 `project_rw` 解释成对 Task Dock 全部数据的写权限，也绝不自动降级执行。

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const CAPABILITIES: &[&str] = &[
    "tasks.read",
    "tasks.write",
    "notes.read",
    "notes.write",
    "workflows.read",
    "workspace.read",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capability {
    TasksRead,
    TasksWrite,
    NotesRead,
    NotesWrite,
    WorkflowsRead,
    WorkspaceRead,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::TasksRead => "tasks.read",
            Capability::TasksWrite => "tasks.write",
            Capability::NotesRead => "notes.read",
            Capability::NotesWrite => "notes.write",
            Capability::WorkflowsRead => "workflows.read",
            Capability::WorkspaceRead => "workspace.read",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "tasks.read" => Capability::TasksRead,
            "tasks.write" => Capability::TasksWrite,
            "notes.read" => Capability::NotesRead,
            "notes.write" => Capability::NotesWrite,
            "workflows.read" => Capability::WorkflowsRead,
            "workspace.read" => Capability::WorkspaceRead,
            _ => return None,
        })
    }

    pub fn is_write(self) -> bool {
        matches!(self, Capability::TasksWrite | Capability::NotesWrite)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrant {
    pub capability: String,
    /// 空串表示全局
    pub resource_id: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub id: String,
    pub root_path: String,
    pub created_at: String,
}

const MAX_RESOURCE_ID: usize = 128;

fn check_resource(capability: Capability, resource_id: &str) -> AppResult<()> {
    if resource_id.chars().count() > MAX_RESOURCE_ID {
        return Err(AppError::Validation("resource_id 超过 128 字符".into()));
    }
    if capability == Capability::WorkspaceRead && !resource_id.is_empty() {
        return Err(AppError::Validation(
            "workspace.read 的资源范围由工作区根目录授权决定，resource_id 必须为空".into(),
        ));
    }
    Ok(())
}

fn resource_exists(conn: &Connection, capability: Capability, resource_id: &str) -> AppResult<bool> {
    if resource_id.is_empty() {
        return Ok(true);
    }
    let (sql, what) = match capability {
        Capability::TasksRead | Capability::TasksWrite => ("SELECT 1 FROM tasks WHERE id = ?1", "任务"),
        Capability::NotesRead | Capability::NotesWrite => ("SELECT 1 FROM notes WHERE id = ?1", "笔记"),
        Capability::WorkflowsRead => ("SELECT 1 FROM workflows WHERE id = ?1", "工作流"),
        Capability::WorkspaceRead => return Ok(true),
    };
    let found = conn
        .query_row(sql, rusqlite::params![resource_id], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(AppError::from)?;
    if found.is_none() {
        return Err(AppError::Validation(format!("{what}不存在: {resource_id}")));
    }
    Ok(true)
}

/// 是否持有能力：全局授权（resource_id=''）或精确资源授权。
/// 调用方必须已经校验过 scope。
pub fn has(
    conn: &Connection,
    agent_row_id: &str,
    capability: Capability,
    resource_id: &str,
) -> AppResult<bool> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND capability = ?2
               AND (resource_id = '' OR resource_id = ?3)",
            rusqlite::params![agent_row_id, capability.as_str(), resource_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    Ok(n > 0)
}

/// 是否持有全局能力（列表/搜索/统计类工具必须要求全局，避免逐条拼授权）。
pub fn has_global(conn: &Connection, agent_row_id: &str, capability: Capability) -> AppResult<bool> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND capability = ?2 AND resource_id = ''",
            rusqlite::params![agent_row_id, capability.as_str()],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    Ok(n > 0)
}

pub fn grant(
    db: &Db,
    agent_row_id: &str,
    capability_raw: &str,
    resource_id: &str,
) -> AppResult<Vec<CapabilityGrant>> {
    let capability = Capability::parse(capability_raw).ok_or_else(|| {
        AppError::Validation(format!(
            "未知能力: {capability_raw}（允许 {}）",
            CAPABILITIES.join(" | ")
        ))
    })?;
    let resource_id = resource_id.trim();
    check_resource(capability, resource_id)?;
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL)",
            rusqlite::params![agent_row_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("MCP Agent 不存在或已撤销: {agent_row_id}")));
        }
        resource_exists(conn, capability, resource_id)?;
        conn.execute(
            "INSERT OR IGNORE INTO mcp_agent_capabilities
               (id, agent_row_id, capability, resource_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                agent_row_id,
                capability.as_str(),
                resource_id,
                now
            ],
        )?;
        Ok(())
    })?;
    list(db, agent_row_id)
}

pub fn revoke(
    db: &Db,
    agent_row_id: &str,
    capability_raw: &str,
    resource_id: &str,
) -> AppResult<Vec<CapabilityGrant>> {
    let capability = Capability::parse(capability_raw).ok_or_else(|| {
        AppError::Validation(format!("未知能力: {capability_raw}"))
    })?;
    let resource_id = resource_id.trim();
    check_resource(capability, resource_id)?;
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND capability = ?2 AND resource_id = ?3",
            rusqlite::params![agent_row_id, capability.as_str(), resource_id],
        )?;
        Ok(())
    })?;
    list(db, agent_row_id)
}

pub fn list(db: &Db, agent_row_id: &str) -> AppResult<Vec<CapabilityGrant>> {
    db.with_read(|conn| list_in_conn(conn, agent_row_id))
}

pub fn list_in_conn(conn: &Connection, agent_row_id: &str) -> AppResult<Vec<CapabilityGrant>> {
    let mut stmt = conn.prepare(
        "SELECT capability, resource_id, created_at FROM mcp_agent_capabilities
         WHERE agent_row_id = ?1 ORDER BY capability, resource_id",
    )?;
    let rows = stmt.query_map(rusqlite::params![agent_row_id], |r| {
        Ok(CapabilityGrant {
            capability: r.get(0)?,
            resource_id: r.get(1)?,
            created_at: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ── 笔记归属 ─────────────────────────────────────────────────────────

pub fn record_note_owner(
    conn: &Connection,
    note_id: &str,
    agent_row_id: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO mcp_note_ownership (note_id, agent_row_id, created_at)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![note_id, agent_row_id, crate::agents::now_iso()],
    )?;
    Ok(())
}

pub fn note_owned_by(conn: &Connection, note_id: &str, agent_row_id: &str) -> AppResult<bool> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mcp_note_ownership WHERE note_id = ?1 AND agent_row_id = ?2",
            rusqlite::params![note_id, agent_row_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    Ok(n > 0)
}

/// 笔记读取：自己的笔记，或 notes.read 全局/精确授权。
pub fn can_read_note(conn: &Connection, agent_row_id: &str, note_id: &str) -> AppResult<bool> {
    if note_owned_by(conn, note_id, agent_row_id)? {
        return Ok(true);
    }
    let global = has_global(conn, agent_row_id, Capability::NotesRead)?;
    if global {
        return Ok(true);
    }
    has(conn, agent_row_id, Capability::NotesRead, note_id)
}

/// 笔记写入：自己的笔记，或 notes.write 全局/精确授权。
/// 更新既有笔记还必须能读它（避免盲写覆盖）。
pub fn can_write_note(conn: &Connection, agent_row_id: &str, note_id: &str) -> AppResult<bool> {
    let writable = note_owned_by(conn, note_id, agent_row_id)?
        || has_global(conn, agent_row_id, Capability::NotesWrite)?
        || has(conn, agent_row_id, Capability::NotesWrite, note_id)?;
    if !writable {
        return Ok(false);
    }
    can_read_note(conn, agent_row_id, note_id)
}

/// 创建笔记：需要 notes.write 的全局或任一资源授权。
pub fn can_create_note(conn: &Connection, agent_row_id: &str) -> AppResult<bool> {
    if has_global(conn, agent_row_id, Capability::NotesWrite)? {
        return Ok(true);
    }
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mcp_agent_capabilities
         WHERE agent_row_id = ?1 AND capability = 'notes.write'",
        rusqlite::params![agent_row_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

// ── 文件工作区根目录 ─────────────────────────────────────────────────

fn normalize_root(raw: &str) -> AppResult<std::path::PathBuf> {
    let path = std::path::PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err(AppError::Validation("工作区根目录必须是绝对路径".into()));
    }
    if raw.trim_start().starts_with("\\\\") {
        return Err(AppError::Validation("不支持网络共享路径（UNC）".into()));
    }
    let canonical = std::fs::canonicalize(&path).map_err(|e| {
        AppError::Validation(format!("工作区目录不可访问: {}", e))
    })?;
    if !canonical.is_dir() {
        return Err(AppError::Validation("工作区根目录必须是已存在的目录".into()));
    }
    Ok(canonical)
}

pub fn grant_root(db: &Db, agent_row_id: &str, raw_path: &str) -> AppResult<Vec<WorkspaceRoot>> {
    let canonical = normalize_root(raw_path)?;
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL)",
            rusqlite::params![agent_row_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("MCP Agent 不存在或已撤销: {agent_row_id}")));
        }
        conn.execute(
            "INSERT OR IGNORE INTO mcp_workspace_roots (id, agent_row_id, root_path, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                agent_row_id,
                canonical.to_string_lossy().to_string(),
                now
            ],
        )?;
        Ok(())
    })?;
    list_roots(db, agent_row_id)
}

pub fn revoke_root(db: &Db, agent_row_id: &str, root_id: &str) -> AppResult<Vec<WorkspaceRoot>> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM mcp_workspace_roots WHERE agent_row_id = ?1 AND id = ?2",
            rusqlite::params![agent_row_id, root_id],
        )?;
        Ok(())
    })?;
    list_roots(db, agent_row_id)
}

pub fn list_roots(db: &Db, agent_row_id: &str) -> AppResult<Vec<WorkspaceRoot>> {
    db.with_read(|conn| list_roots_in_conn(conn, agent_row_id))
}

pub fn list_roots_in_conn(conn: &Connection, agent_row_id: &str) -> AppResult<Vec<WorkspaceRoot>> {
    let mut stmt = conn.prepare(
        "SELECT id, root_path, created_at FROM mcp_workspace_roots
         WHERE agent_row_id = ?1 ORDER BY created_at",
    )?;
    let rows = stmt.query_map(rusqlite::params![agent_row_id], |r| {
        Ok(WorkspaceRoot {
            id: r.get(0)?,
            root_path: r.get(1)?,
            created_at: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 找到包含目标路径的已授权根（按规范化真实路径比较；Windows 忽略大小写）。
pub fn root_containing(
    conn: &Connection,
    agent_row_id: &str,
    canonical_target: &std::path::Path,
) -> AppResult<Option<std::path::PathBuf>> {
    let roots = list_roots_in_conn(conn, agent_row_id)?;
    for root in roots {
        let root_path = std::path::PathBuf::from(&root.root_path);
        if canonical_target.starts_with(&root_path) {
            return Ok(Some(root_path));
        }
    }
    Ok(None)
}
