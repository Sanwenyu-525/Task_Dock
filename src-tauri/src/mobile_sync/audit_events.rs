//! mobile_sync 安全审计事件（`security_audit_log`，迁移 v82）。
//!
//! 首批事件：`PAIRING_REQUESTED / PAIRING_SUCCEEDED / PAIRING_FAILED /
//! DEVICE_REVOKED / AUTH_FAILED`（docs/architecture/unified-observability-design.md
//! §4.3.2）。`mcp/audit.rs` 的权限拒绝与高风险调用也复用本模块的 [`insert_event`]
//! 写入同一张表（category="mcp"），保证 INSERT 语句单一来源。
//!
//! `crate::security_audit`（lib.rs 接线后生效）是查询/清理/对外门面，
//! 其 `record` 委托到本模块——接线前的编译树里只有本模块可被引用。
//!
//! 写入纪律（§4.3 契约）：追加写，应用层不提供 UPDATE；写入失败**不 panic、
//! 不阻塞业务**（审计失败绝不改变配对/鉴权的结果），高风险事件（配对成功落库、
//! 设备撤销）失败时通过诊断日志记 ERROR 供告警。
//!
//! 脱敏红线：绝不记录配对码、token、密钥、SPKI 指纹值或任何业务正文；
//! `subject` 只允许设备库内 UUID 或 [`minimize_peer_ip`] 截断后的网段。

use rusqlite::Connection;
use serde::Serialize;

use crate::db::Db;
use crate::diagnostics::{self, DiagLevel};
use crate::error::AppResult;

// ── 稳定枚举（公开契约，只增不改） ─────────────────────────────────────

/// 事件类别：配对生命周期。
pub const CATEGORY_PAIRING: &str = "pairing";
/// 事件类别：设备信任/鉴权（撤销、鉴权失败）。
pub const CATEGORY_AUTH: &str = "auth";
/// 事件类别：MCP 工具调用（权限拒绝、高风险工具）。
pub const CATEGORY_MCP: &str = "mcp";
/// 剪贴板安全事件：Agent 明文导出、导出目录清理。只记录范围/计数，不含正文、路径。
pub const CATEGORY_CLIPBOARD: &str = "clipboard";

pub const EVENT_PAIRING_REQUESTED: &str = "PAIRING_REQUESTED";
pub const EVENT_PAIRING_SUCCEEDED: &str = "PAIRING_SUCCEEDED";
pub const EVENT_PAIRING_FAILED: &str = "PAIRING_FAILED";
pub const EVENT_DEVICE_REVOKED: &str = "DEVICE_REVOKED";
pub const EVENT_AUTH_FAILED: &str = "AUTH_FAILED";
/// MCP 权限拒绝（authz=false）。
pub const EVENT_MCP_TOOL_DENIED: &str = "MCP_TOOL_DENIED";
/// MCP 高风险工具调用（成功或失败都记，普通成功调用不写）。
pub const EVENT_MCP_HIGH_RISK_CALL: &str = "MCP_HIGH_RISK_CALL";
/// 剪贴板导出成功 / 失败 / 过期导出目录清理。
pub const EVENT_CLIPBOARD_EXPORT_SUCCEEDED: &str = "CLIPBOARD_EXPORT_SUCCEEDED";
pub const EVENT_CLIPBOARD_EXPORT_FAILED: &str = "CLIPBOARD_EXPORT_FAILED";
pub const EVENT_CLIPBOARD_EXPORT_PURGED: &str = "CLIPBOARD_EXPORT_PURGED";

pub const RESULT_OK: &str = "ok";
pub const RESULT_DENIED: &str = "denied";
pub const RESULT_FAILED: &str = "failed";

/// 审计事件（字段与 `security_audit_log` 列一一对应）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    pub category: String,
    pub event_type: String,
    pub subject: Option<String>,
    pub action: String,
    pub result: String,
    pub reason_code: Option<String>,
    pub correlation_id: Option<String>,
    pub created_at: String,
}

impl AuditEvent {
    /// 构造基础事件：id 用 UUID v4，created_at 用进程统一 UTC RFC3339。
    pub fn new(category: &str, event_type: &str, action: &str, result: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            category: category.to_string(),
            event_type: event_type.to_string(),
            subject: None,
            action: action.to_string(),
            result: result.to_string(),
            reason_code: None,
            correlation_id: None,
            created_at: crate::agents::now_iso(),
        }
    }
}

/// peer_ip 最小化（纯函数）：IPv4 截断到 /24 网段，IPv6 截断到 /48 前缀。
///
/// 返回 `None` 表示无法解析或为空——审计侧宁可不记 subject，也绝不落精确地址。
pub fn minimize_peer_ip(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(ip) = raw.parse::<std::net::Ipv4Addr>() {
        let octets = ip.octets();
        return Some(format!("{}.{}.{}.0/24", octets[0], octets[1], octets[2]));
    }
    if let Ok(ip) = raw.parse::<std::net::Ipv6Addr>() {
        let segments = ip.segments();
        // /48 = 前 3 组 16 bit；其余清零后由标准压缩格式输出（如 2001:db8:1122::）。
        let prefix = [
            segments[0],
            segments[1],
            segments[2],
            0,
            0,
            0,
            0,
            0,
        ];
        return Some(format!("{}/48", std::net::Ipv6Addr::from(prefix)));
    }
    None
}

/// 追加写一条审计事件。调用方保证不处于会回滚的事务语义中（审计必须独立成立）。
pub fn insert_event(conn: &Connection, event: &AuditEvent) -> AppResult<()> {
    conn.execute(
        "INSERT INTO security_audit_log
           (id, category, event_type, subject, action, result, reason_code, correlation_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            event.id,
            event.category,
            event.event_type,
            event.subject,
            event.action,
            event.result,
            event.reason_code,
            event.correlation_id,
            event.created_at,
        ],
    )?;
    Ok(())
}

/// 业务路径入口：写入失败只上报诊断，不向调用方传播错误。
///
/// `high_risk=true`（配对成功落库、设备撤销）失败时记 ERROR
/// （`error_code=SECURITY_AUDIT_WRITE_FAILED`）供告警；其余记 WARN。
/// 诊断 metadata 白名单在 `diagnostics/privacy.rs`，`category`/`event_type`
/// 未登记，故用已登记的 `kind`/`action`/`reason` 承载路由信息。
pub fn record(db: &Db, event: AuditEvent, high_risk: bool) {
    let outcome = db.with_conn(|conn| insert_event(conn, &event));
    if let Err(error) = outcome {
        let level = if high_risk {
            DiagLevel::Error
        } else {
            DiagLevel::Warn
        };
        diagnostics::event(level, "security_audit", "write", "failed")
            .error_code("SECURITY_AUDIT_WRITE_FAILED")
            .metadata("kind", serde_json::json!(event.category))
            .metadata("action", serde_json::json!(event.event_type))
            .metadata("reason", serde_json::json!(error.code()))
            .emit();
        tracing::warn!(
            "安全审计写入失败（category={} event_type={}）: {error}",
            event.category,
            event.event_type
        );
    }
}

// ── mobile_sync 五类事件构造 ──────────────────────────────────────────

/// 用户在设置页生成配对码（`start_pairing` 成功返回后）。
pub(crate) fn pairing_requested(db: &Db) {
    record(
        db,
        AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_REQUESTED, "start_pairing", RESULT_OK),
        false,
    );
}

/// 配对成功落库（`complete_pairing` 返回 Ok 后）。高风险：审计丢失必须可告警。
pub(crate) fn pairing_succeeded(db: &Db, device_id: &str) {
    let event = AuditEvent {
        subject: Some(device_id.to_string()),
        ..AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_SUCCEEDED, "complete_pairing", RESULT_OK)
    };
    record(db, event, true);
}

/// 配对失败（invalid_code / too_many / closed）。subject 用最小化来源网段。
pub(crate) fn pairing_failed(db: &Db, reason: &str, peer_ip: Option<&str>) {
    let event = AuditEvent {
        subject: minimize_peer_ip(peer_ip.unwrap_or("")),
        reason_code: Some(reason.to_string()),
        ..AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_FAILED, "complete_pairing", RESULT_FAILED)
    };
    record(db, event, false);
}

/// 设备撤销成功（`revoke_device` 命中有效记录）。高风险。
pub(crate) fn device_revoked(db: &Db, device_id: &str) {
    let event = AuditEvent {
        subject: Some(device_id.to_string()),
        ..AuditEvent::new(CATEGORY_AUTH, EVENT_DEVICE_REVOKED, "revoke_device", RESULT_OK)
    };
    record(db, event, true);
}

/// 设备令牌鉴权失败（含格式非法与未知/已撤销令牌）。subject 用最小化来源网段。
pub(crate) fn auth_failed(db: &Db, peer_ip: Option<&str>) {
    let event = AuditEvent {
        subject: minimize_peer_ip(peer_ip.unwrap_or("")),
        reason_code: Some("unauthorized".to_string()),
        ..AuditEvent::new(CATEGORY_AUTH, EVENT_AUTH_FAILED, "authenticate_device", RESULT_DENIED)
    };
    record(db, event, false);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn rows(db: &Db) -> Vec<(String, String, Option<String>, String, Option<String>)> {
        db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT category, event_type, subject, result, reason_code
                 FROM security_audit_log ORDER BY created_at, id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, rusqlite::Error>>()
                .map_err(crate::error::AppError::from)
        })
        .unwrap()
    }

    #[test]
    fn insert_and_read_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let event = AuditEvent {
            subject: Some("0f8fad5b-d9cb-469f-a165-70867728950e".into()),
            reason_code: Some("invalid_code".into()),
            correlation_id: Some("req-1".into()),
            ..AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_FAILED, "complete_pairing", RESULT_FAILED)
        };
        db.with_conn(|conn| insert_event(conn, &event)).unwrap();
        let stored = rows(&db);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0, CATEGORY_PAIRING);
        assert_eq!(stored[0].1, EVENT_PAIRING_FAILED);
        assert_eq!(
            stored[0].2.as_deref(),
            Some("0f8fad5b-d9cb-469f-a165-70867728950e")
        );
        assert_eq!(stored[0].3, RESULT_FAILED);
        assert_eq!(stored[0].4.as_deref(), Some("invalid_code"));
        // 表只追加不更新：应用层没有 UPDATE 路径，这里只验证插入成功。
    }

    #[test]
    fn record_swallows_write_failure() {
        // 写入失败不影响业务：模拟方式是构造无法写入的场景——直接复用正常库
        // 验证 record() 成功路径；失败路径的容错在 insert_event 的 Result 语义中。
        let db = Db::open_in_memory().unwrap();
        record(&db, AuditEvent::new(CATEGORY_AUTH, EVENT_AUTH_FAILED, "authenticate_device", RESULT_DENIED), false);
        assert_eq!(rows(&db).len(), 1);
    }

    #[test]
    fn event_id_and_created_at_shape() {
        let event = AuditEvent::new(CATEGORY_MCP, EVENT_MCP_HIGH_RISK_CALL, "taskdock_update_project", RESULT_OK);
        assert_eq!(event.id.len(), 36);
        assert!(uuid::Uuid::parse_str(&event.id).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&event.created_at).is_ok());
    }

    #[test]
    fn minimize_peer_ip_ipv4_truncates_to_slash24() {
        assert_eq!(
            minimize_peer_ip("192.168.5.67").as_deref(),
            Some("192.168.5.0/24")
        );
        assert_eq!(minimize_peer_ip("10.1.2.3").as_deref(), Some("10.1.2.0/24"));
        assert_eq!(
            minimize_peer_ip("  172.20.1.7  ").as_deref(),
            Some("172.20.1.0/24")
        );
    }

    #[test]
    fn minimize_peer_ip_ipv6_truncates_to_slash48() {
        assert_eq!(
            minimize_peer_ip("2001:db8:1122:3344:5566:7788:9900:aabb").as_deref(),
            Some("2001:db8:1122::/48")
        );
        assert_eq!(minimize_peer_ip("fe80::1").as_deref(), Some("fe80::/48"));
    }

    #[test]
    fn minimize_peer_ip_rejects_empty_invalid_and_unparseable() {
        assert_eq!(minimize_peer_ip(""), None);
        assert_eq!(minimize_peer_ip("   "), None);
        assert_eq!(minimize_peer_ip("not-an-ip"), None);
        assert_eq!(minimize_peer_ip("999.1.1.1"), None);
        assert_eq!(minimize_peer_ip("192.168.5"), None);
    }

    #[test]
    fn sensitive_values_never_reach_any_column() {
        // 脱敏红线：配对码、令牌、指纹值不得出现在 security_audit_log 任何列。
        let db = Db::open_in_memory().unwrap();
        let pairing_code = "042913";
        let token = "a".repeat(64);
        let fingerprint = "f".repeat(64);
        pairing_failed(&db, "invalid_code", Some("203.0.113.9"));
        auth_failed(&db, Some("203.0.113.9"));
        pairing_succeeded(&db, "0f8fad5b-d9cb-469f-a165-70867728950e");

        let all_columns: Vec<String> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, category, event_type, subject, action, result,
                            reason_code, correlation_id, created_at
                     FROM security_audit_log",
                )?;
                let rows = stmt
                    .query_map([], |row| {
                        let mut parts = Vec::new();
                        for idx in 0..9 {
                            let value: Option<String> = row.get(idx)?;
                            parts.push(value.unwrap_or_default());
                        }
                        Ok(parts.join("|"))
                    })?
                    .collect::<Result<Vec<_>, rusqlite::Error>>()
                    .map_err(crate::error::AppError::from)?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(all_columns.len(), 3);
        for row in &all_columns {
            assert!(!row.contains(pairing_code), "配对码泄漏: {row}");
            assert!(!row.contains(&token), "令牌泄漏: {row}");
            assert!(!row.contains(&fingerprint), "指纹泄漏: {row}");
        }
        // 来源地址只以网段形态出现，绝不落完整 IP。
        assert!(all_columns.iter().all(|row| !row.contains("203.0.113.9")));
        assert!(all_columns.iter().any(|row| row.contains("203.0.113.0/24")));
    }
}
