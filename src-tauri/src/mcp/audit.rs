//! MCP 审计（mcp_audit_log，迁移 v37）：每次工具调用一条记录。
//!
//! 脱敏边界：detail 只放动作结果摘要（revision、拒绝原因类别），
//! 绝不含凭据、剪贴板正文、完整路径；result_json 只保存写工具的成功结果
//! （规划实体本身，与 planning 表同源），供 request_id 幂等重放。
//!
//! 幂等键（v37 部分唯一索引）：`UNIQUE(agent_row_id, action, request_id)
//! WHERE request_id <> '' AND success = 1`。并发同键第二次插入会撞唯一索引，
//! 此时按重放处理（重查原结果返回）。读工具 request_id 恒存 ''，可重复审计。

use rusqlite::Connection;

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

/// 查找可重放的成功写结果（同 agent + action + request_id）。
pub fn find_replay(
    conn: &Connection,
    agent_row_id: &str,
    action: &str,
    request_id: &str,
) -> AppResult<Option<String>> {
    if request_id.is_empty() {
        return Ok(None);
    }
    let result: Option<String> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT result_json FROM mcp_audit_log
             WHERE agent_row_id = ?1 AND action = ?2 AND request_id = ?3 AND success = 1",
        rusqlite::params![agent_row_id, action, request_id],
        |r| r.get(0),
    ))
    .map_err(crate::error::AppError::from)?;
    Ok(result.filter(|s| !s.is_empty()))
}

/// 唯一索引冲突（并发同键写入）判定。
pub fn is_idempotency_conflict(err: &crate::error::AppError) -> bool {
    matches!(
        err,
        crate::error::AppError::Db(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.contains("mcp_audit_log") && msg.contains("UNIQUE")
    )
}
