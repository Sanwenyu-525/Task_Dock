//! MCP 审计（mcp_audit_log，迁移 v37）：每次工具调用一条记录。
//!
//! 脱敏边界：detail 只放动作结果摘要（revision、错误码、参数摘要），
//! 绝不含凭据、剪贴板正文、完整路径；result_json 只保存写工具的成功结果
//! （规划实体本身，与 planning 表同源），供 request_id 幂等重放。
//!
//! 幂等键（v37 部分唯一索引）：`UNIQUE(agent_row_id, action, request_id)
//! WHERE request_id <> '' AND success = 1`。该索引作为事务幂等流程的最后约束；
//! 读工具 request_id 恒存 ''，可重复审计。
//!
//! 保留策略（两段式，区分「安全审计元数据」与「幂等重放载荷」）：
//! - 元数据（谁、何时、哪个工具、成功/拒绝）保留 `metadata_days`；
//! - 幂等载荷 `result_json` 只保留 `payload_days`，到期先清空载荷，**不删行**；
//! - 删除行必须同时满足「超出元数据保留期」且「超出幂等窗口」，因此仍在
//!   重试窗口内的 requestId 永远不会被清理，不会被重复执行。
//! - 清理只由用户显式触发（`mcp_audit_prune`），不在启动时静默执行。

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

pub fn write(conn: &Connection, e: &AuditEntry<'_>) -> AppResult<()> {    conn.execute(
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

/// 最近一次调用摘要（UI 状态卡用；不含参数、载荷与凭据）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LastCall {
    pub action: String,
    pub agent_id: String,
    pub created_at: String,
    pub success: bool,
    pub authorized: bool,
}

pub fn last_call(conn: &Connection) -> AppResult<Option<LastCall>> {
    rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT action, agent_id, created_at, success, authz FROM mcp_audit_log
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [],
        |r| {
            Ok(LastCall {
                action: r.get(0)?,
                agent_id: r.get(1)?,
                created_at: r.get(2)?,
                success: r.get::<_, i64>(3)? != 0,
                authorized: r.get::<_, i64>(4)? != 0,
            })
        },
    ))
    .map_err(crate::error::AppError::from)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    /// 删除的审计行数（超出元数据保留期）
    pub deleted_rows: i64,
    /// 清空幂等载荷的行数（超出重放窗口但仍在元数据保留期）
    pub cleared_payloads: i64,
    /// 清理后仍可用于幂等重放的行数
    pub replayable_rows: i64,
    pub metadata_cutoff: String,
    pub payload_cutoff: String,
}

/// 两段式清理。`payload_days` 必须 ≤ `metadata_days`；否则拒绝执行，
/// 避免「先删元数据、后清载荷」导致窗口语义自相矛盾。
pub fn prune(
    conn: &Connection,
    metadata_days: i64,
    payload_days: i64,
) -> AppResult<PruneReport> {
    use chrono::{Duration, Utc};
    if !(7..=3650).contains(&metadata_days) {
        return Err(crate::error::AppError::Validation(
            "审计元数据保留天数必须在 7..=3650".into(),
        ));
    }
    if !(1..=3650).contains(&payload_days) || payload_days > metadata_days {
        return Err(crate::error::AppError::Validation(
            "幂等载荷保留天数必须在 1..=3650 且不大于元数据保留天数".into(),
        ));
    }
    let now = Utc::now();
    let fmt = |dt: chrono::DateTime<Utc>| dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let payload_cutoff = fmt(now - Duration::days(payload_days));
    let metadata_cutoff = fmt(now - Duration::days(metadata_days));

    // 先清载荷：仍在重放窗口内的记录不动；超出窗口的清空 result_json，
    // 但保留行本身用于安全审计与统计。
    let cleared_payloads = conn.execute(
        "UPDATE mcp_audit_log SET result_json = ''
         WHERE result_json <> '' AND created_at < ?1",
        rusqlite::params![payload_cutoff],
    )? as i64;

    // 再删行：必须同时早于元数据保留期；由于 metadata_cutoff ≤ payload_cutoff，
    // 不会误删仍处于幂等窗口的记录。
    let deleted_rows = conn.execute(
        "DELETE FROM mcp_audit_log WHERE created_at < ?1 AND created_at < ?2",
        rusqlite::params![metadata_cutoff, payload_cutoff],
    )? as i64;

    let replayable_rows: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mcp_audit_log WHERE result_json <> ''",
        [],
        |r| r.get(0),
    )?;

    Ok(PruneReport {
        deleted_rows,
        cleared_payloads,
        replayable_rows,
        metadata_cutoff,
        payload_cutoff,
    })
}
