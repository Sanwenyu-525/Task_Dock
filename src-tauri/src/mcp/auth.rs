//! MCP Agent 身份与授权（mcp_agents / mcp_agent_grants，迁移 v37）。
//!
//! 安全要点：
//! - token 只存 SHA-256（hex），明文仅在 `mcp_agent_create` 返回值中出现一次；
//! - 查找按 token 哈希比对（先哈希再比较，等效常量时间：SHA-256 消化长度差）；
//! - 撤销（revoked_at 非空）立即生效：每次请求都从库里重读身份，无缓存窗口；
//! - last_seen_at 节流更新（60s 内不重复写），避免高频读工具放大写压力。

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const SCOPES: &[&str] = &["disabled", "readonly", "project_rw"];
const LAST_SEEN_THROTTLE_SECS: i64 = 60;

/// Agent 身份（每次请求从库内解析，绝不缓存 token）。
#[derive(Clone, Debug)]
pub struct McpAgentRow {
    /// mcp_agents.id（行 UUID，审计与授权引用它）
    pub row_id: String,
    pub agent_id: String,
    pub display_name: String,
    pub scope: McpScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum McpScope {
    Disabled,
    ReadOnly,
    ProjectRw,
}

impl McpScope {
    pub fn as_str(self) -> &'static str {
        match self {
            McpScope::Disabled => "disabled",
            McpScope::ReadOnly => "readonly",
            McpScope::ProjectRw => "project_rw",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "disabled" => Some(McpScope::Disabled),
            "readonly" => Some(McpScope::ReadOnly),
            "project_rw" => Some(McpScope::ProjectRw),
            _ => None,
        }
    }

    /// 只读工具对 readonly / project_rw 开放；disabled 一律拒绝。
    pub fn can_read(self) -> bool {
        matches!(self, McpScope::ReadOnly | McpScope::ProjectRw)
    }

    /// 写工具还要求逐项目 grant（create_project 例外：project_rw 可新建并自动授权）。
    pub fn can_write(self) -> bool {
        matches!(self, McpScope::ProjectRw)
    }
}

/// 命令层 / 前端可见的 Agent 信息（不含 token 明文与哈希）。
#[derive(Serialize, Clone, Debug)]
pub struct McpAgentInfo {
    pub id: String,
    pub agent_id: String,
    pub display_name: String,
    pub scope: String,
    pub created_at: String,
    pub updated_at: String,
    pub revoked_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub granted_project_ids: Vec<String>,
}

pub fn sha256_hex(input: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 生成 agent token：`tdm_` + 64 hex（两段 UUIDv4 共 256 bit 随机，OS 熵源）。
pub fn generate_token() -> String {
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(a.as_bytes());
    bytes[16..].copy_from_slice(b.as_bytes());
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    format!("tdm_{hex}")
}

fn row_to_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<(McpAgentRow, String, bool)> {
    let scope_raw: String = row.get(3)?;
    let scope = McpScope::parse(&scope_raw).unwrap_or(McpScope::Disabled);
    Ok((
        McpAgentRow {
            row_id: row.get(0)?,
            agent_id: row.get(1)?,
            display_name: row.get(2)?,
            scope,
        },
        scope_raw,
        row.get::<_, Option<String>>(4)?.is_none(),
    ))
}

const AGENT_SELECT: &str = "SELECT id, agent_id, display_name, scope, revoked_at FROM mcp_agents";

/// 按 agent token 明文解析未撤销的 Agent 身份；查不到/已撤销一律 None（不区分原因）。
pub fn find_agent_by_token(conn: &Connection, token: &str) -> AppResult<Option<McpAgentRow>> {
    let hash = sha256_hex(token);
    let row = conn
        .query_row(
            &format!("{AGENT_SELECT} WHERE token_hash = ?1 AND revoked_at IS NULL"),
            rusqlite::params![hash],
            |r| row_to_agent(r).map(|(a, _, _)| a),
        )
        .optional()
        .map_err(AppError::from)?;
    Ok(row)
}

/// 每次成功请求后更新 last_seen_at（60s 节流；纯运维元数据，失败不影响请求）。
pub fn touch_last_seen(conn: &Connection, row_id: &str) {
    let _ = conn.execute(
        "UPDATE mcp_agents SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND (last_seen_at IS NULL
           OR last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?2))",
        rusqlite::params![row_id, format!("-{} seconds", LAST_SEEN_THROTTLE_SECS)],
    );
}

/// scope=project_rw 的 Agent 是否持有某项目的写授权。
pub fn has_project_grant(conn: &Connection, row_id: &str, project_id: &str) -> AppResult<bool> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mcp_agent_grants WHERE agent_row_id = ?1 AND project_id = ?2",
            rusqlite::params![row_id, project_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    Ok(n > 0)
}

fn grants_of(conn: &Connection, row_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT project_id FROM mcp_agent_grants WHERE agent_row_id = ?1 ORDER BY created_at",
        )
        .map_err(AppError::from)?;
    let rows = stmt
        .query_map(rusqlite::params![row_id], |r| r.get::<_, String>(0))
        .map_err(AppError::from)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(AppError::from)?);
    }
    Ok(out)
}

fn agent_info_by_row_id(conn: &Connection, row_id: &str) -> AppResult<McpAgentInfo> {
    let info = conn
        .query_row(
            "SELECT id, agent_id, display_name, scope, created_at, updated_at, revoked_at, last_seen_at
             FROM mcp_agents WHERE id = ?1",
            rusqlite::params![row_id],
            |r| {
                Ok(McpAgentInfo {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    display_name: r.get(2)?,
                    scope: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    revoked_at: r.get(6)?,
                    last_seen_at: r.get(7)?,
                    granted_project_ids: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("MCP Agent 不存在: {row_id}")))?;
    with_grants(conn, info)
}

fn with_grants(conn: &Connection, mut info: McpAgentInfo) -> AppResult<McpAgentInfo> {
    info.granted_project_ids = grants_of(conn, &info.id)?;
    Ok(info)
}

pub fn list_agents(db: &Db) -> AppResult<Vec<McpAgentInfo>> {
    db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, display_name, scope, created_at, updated_at, revoked_at, last_seen_at
                 FROM mcp_agents ORDER BY created_at",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(McpAgentInfo {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    display_name: r.get(2)?,
                    scope: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    revoked_at: r.get(6)?,
                    last_seen_at: r.get(7)?,
                    granted_project_ids: Vec::new(),
                })
            })
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(with_grants(conn, r.map_err(AppError::from)?)?);
        }
        Ok(out)
    })
}

fn check_agent_id(agent_id: &str) -> AppResult<String> {
    let agent_id = agent_id.trim();
    if agent_id.is_empty() {
        return Err(AppError::Validation("agent_id 不能为空".into()));
    }
    if agent_id.chars().count() > 64 {
        return Err(AppError::Validation("agent_id 超过 64 字符".into()));
    }
    if !agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::Validation(
            "agent_id 只允许字母/数字/-/_/.".into(),
        ));
    }
    Ok(agent_id.to_string())
}

fn check_display_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.chars().count() > 120 {
        return Err(AppError::Validation("display_name 超过 120 字符".into()));
    }
    Ok(name.to_string())
}

/// 创建 Agent：生成随机 token（明文只在本返回值出现一次），库内存 SHA-256。
#[must_use = "token 明文只在此返回一次，必须交给调用方保存"]
pub struct AgentCreated {
    pub info: McpAgentInfo,
    pub token: String,
}

pub fn create_agent(db: &Db, agent_id: &str, display_name: &str) -> AppResult<AgentCreated> {
    let agent_id = check_agent_id(agent_id)?;
    let display_name = check_display_name(display_name)?;
    let token = generate_token();
    let now = crate::agents::now_iso();
    let id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO mcp_agents (id, agent_id, display_name, token_hash, scope, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'disabled', ?5, ?5)",
            rusqlite::params![id, agent_id, display_name, sha256_hex(&token), now],
        )
        .map_err(AppError::from)?;
        Ok(())
    })?;
    let info = db.with_read(|conn| agent_info_by_row_id(conn, &id))?;
    Ok(AgentCreated { info, token })
}

pub fn set_agent_scope(db: &Db, row_id: &str, scope: &str) -> AppResult<McpAgentInfo> {
    if McpScope::parse(scope).is_none() {
        return Err(AppError::Validation(format!(
            "非法 scope: {scope}（允许 {}）",
            SCOPES.join(" | ")
        )));
    }
    db.with_conn(|conn| {
        let n = conn
            .execute(
                "UPDATE mcp_agents SET scope = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![scope, crate::agents::now_iso(), row_id],
            )
            .map_err(AppError::from)?;
        if n == 0 {
            return Err(AppError::NotFound(format!("MCP Agent 不存在: {row_id}")));
        }
        Ok(())
    })?;
    db.with_read(|conn| agent_info_by_row_id(conn, row_id))
}

/// 授予项目写授权（project_rw 生效）；重复授予幂等。
pub fn grant_project(db: &Db, row_id: &str, project_id: &str) -> AppResult<McpAgentInfo> {
    db.with_conn(|conn| {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM planning_projects WHERE id = ?1",
                rusqlite::params![project_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(AppError::from)?;
        if exists.is_none() {
            return Err(AppError::Validation(format!("项目不存在: {project_id}")));
        }
        conn.execute(
            "INSERT OR IGNORE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                row_id,
                project_id,
                crate::agents::now_iso()
            ],
        )
        .map_err(AppError::from)?;
        // 确保 Agent 存在（FK 已保证；显式报错更友好）
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mcp_agents WHERE id = ?1",
                rusqlite::params![row_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        if n == 0 {
            return Err(AppError::NotFound(format!("MCP Agent 不存在: {row_id}")));
        }
        Ok(())
    })?;
    db.with_read(|conn| agent_info_by_row_id(conn, row_id))
}

/// 撤销 Agent：revoked_at 置时间，后续请求立即 401（无缓存窗口）。
pub fn revoke_agent(db: &Db, row_id: &str) -> AppResult<McpAgentInfo> {
    db.with_conn(|conn| {
        let n = conn
            .execute(
                "UPDATE mcp_agents SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
                rusqlite::params![crate::agents::now_iso(), row_id],
            )
            .map_err(AppError::from)?;
        if n == 0 {
            let already: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM mcp_agents WHERE id = ?1 AND revoked_at IS NOT NULL",
                    rusqlite::params![row_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(AppError::from)?;
            if already.is_some() {
                // 幂等：重复撤销保持成功
                return Ok(());
            }
            return Err(AppError::NotFound(format!("MCP Agent 不存在: {row_id}")));
        }
        Ok(())
    })?;
    db.with_read(|conn| agent_info_by_row_id(conn, row_id))
}
