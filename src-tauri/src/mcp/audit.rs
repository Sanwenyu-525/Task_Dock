//! MCP 审计（mcp_audit_log，迁移 v37）：每次工具调用一条记录。
//!
//! 脱敏边界：detail 只放动作结果摘要（revision、错误码、参数摘要），
//! 绝不含凭据、剪贴板正文、完整路径；result_json 只保存写工具的成功结果
//! （规划实体本身，与 planning 表同源），供 request_id 幂等重放。
//!
//! 幂等键（v37 部分唯一索引）：`UNIQUE(agent_row_id, action, request_id)
//! WHERE request_id <> '' AND success = 1`。该索引作为事务幂等流程的最后约束；
//! 读工具 request_id 恒存 ''，可重复审计。

use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;

pub struct AuditEntry<'a> {
    /// 未知身份（token 不被识别）时为 None，仍要留痕
    pub agent_row_id: Option<&'a str>,
    /// 身份字符串（未知身份存空串；绝不存 token）
    pub agent_id: &'a str,
    pub action: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    /// 写工具幂等键；读工具恒存 ''
    pub request_id: &'a str,
    pub success: bool,
    pub authz: bool,
    /// 脱敏摘要
    pub detail: &'a str,
    /// 写工具成功结果 JSON（幂等重放载荷）；读工具/失败恒空
    pub result_json: &'a str,
}

pub struct Replay {
    pub result_json: String,
    pub detail: String,
    pub entity_type: String,
    pub entity_id: String,
}

/// UI 审计摘要：不包含幂等载荷、参数、错误正文或凭据。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditSummary {
    pub agent_id: String,
    pub display_name: Option<String>,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub created_at: String,
    pub success: bool,
    pub authorized: bool,
    pub error_category: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub items: Vec<AuditSummary>,
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
}

/// 分页读取最少必要审计字段；result_json/detail/request_id 始终留在本地存储内部。
pub fn list_page(conn: &Connection, offset: u32, limit: u32) -> AppResult<AuditPage> {
    let limit = limit.clamp(1, 100);
    let total = conn.query_row("SELECT COUNT(*) FROM mcp_audit_log", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let mut stmt = conn.prepare(
        "SELECT l.agent_id, a.display_name, l.action, l.entity_type, l.entity_id,
                l.created_at, l.success, l.authz
         FROM mcp_audit_log l
         LEFT JOIN mcp_agents a ON a.id = l.agent_row_id
         ORDER BY l.created_at DESC, l.rowid DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
        let success = row.get::<_, i64>(6)? != 0;
        let authorized = row.get::<_, i64>(7)? != 0;
        Ok(AuditSummary {
            agent_id: row.get(0)?,
            display_name: row.get(1)?,
            action: row.get(2)?,
            entity_type: row.get(3)?,
            entity_id: row.get(4)?,
            created_at: row.get(5)?,
            success,
            authorized,
            error_category: if success {
                None
            } else if authorized {
                Some("operation_failed".to_string())
            } else {
                Some("authorization_denied".to_string())
            },
        })
    })?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(AuditPage {
        items,
        total,
        offset,
        limit,
    })
}

pub fn write(conn: &Connection, e: &AuditEntry<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO mcp_audit_log
           (id, agent_row_id, agent_id, action, entity_type, entity_id, request_id,
            success, authz, detail, result_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            e.agent_row_id,
            e.agent_id,
            e.action,
            e.entity_type,
            e.entity_id,
            e.request_id,
            e.success as i64,
            e.authz as i64,
            e.detail,
            e.result_json,
            crate::agents::now_iso(),
        ],
    )?;
    Ok(())
}

/// 读取成功幂等记录及其脱敏元数据，调用方必须校验参数摘要和当前授权。
pub fn find_replay_entry(
    conn: &Connection,
    agent_row_id: &str,
    action: &str,
    request_id: &str,
) -> AppResult<Option<Replay>> {
    if request_id.is_empty() {
        return Ok(None);
    }
    rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT result_json, detail, entity_type, entity_id FROM mcp_audit_log
         WHERE agent_row_id = ?1 AND action = ?2 AND request_id = ?3 AND success = 1",
        rusqlite::params![agent_row_id, action, request_id],
        |r| {
            Ok(Replay {
                result_json: r.get(0)?,
                detail: r.get(1)?,
                entity_type: r.get(2)?,
                entity_id: r.get(3)?,
            })
        },
    ))
    .map_err(crate::error::AppError::from)
}
