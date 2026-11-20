//! 安全审计（`security_audit_log`，迁移 v82）：查询、两段式保留与对外门面。
//!
//! 架构说明：写入路径（事件构造 + INSERT）当前在 [`crate::mobile_sync::audit_events`]
//! ——它是首批消费者（mobile_sync 配对/鉴权）所在域，且在 lib.rs 接线前即处于编译树。
//! 本模块是契约门面：re-export 写入类型与函数，并提供查询（[`list_page`]）与
//! 用户显式触发的两段式清理（[`prune`]）。`mcp/audit.rs` 的双写同样经
//! `audit_events::insert_event` 落表（category="mcp"），保证 INSERT 单一来源。
//!
//! 迁移 v82 的 DDL 内联在 `db/mod.rs`；表只追加不更新（应用层无 UPDATE 路径，
//! 清理仅由用户显式触发）。现有 `mcp_audit_log` / `vault.audit` / `ph_audit_log`
//! 三套审计保留原地，本表只承载此前没有审计落点的安全事件。
//!
//! 防篡改边界（设计文档 §4.3.4）：本地审计不引入哈希链——在「设备所有者即
//! 攻击者」的威胁模型下无法阻止恶意重写，只防误删、误改与未授权软件的意外损坏。
//!
//! 接线要求（主智能体）：`lib.rs` 增加 `pub mod security_audit;`，命令注册见
//! `commands/security_audit.rs` 头注释。

use chrono::{Duration, Utc};
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};
pub use crate::mobile_sync::audit_events::{
    insert_event, record, AuditEvent, CATEGORY_AUTH, CATEGORY_MCP, CATEGORY_PAIRING,
    EVENT_AUTH_FAILED, EVENT_DEVICE_REVOKED, EVENT_MCP_HIGH_RISK_CALL, EVENT_MCP_TOOL_DENIED,
    EVENT_PAIRING_FAILED, EVENT_PAIRING_REQUESTED, EVENT_PAIRING_SUCCEEDED, RESULT_DENIED,
    RESULT_FAILED, RESULT_OK, minimize_peer_ip,
};

/// 默认保留策略：元数据 90 天。
pub const DEFAULT_METADATA_DAYS: i64 = 90;
/// 默认保留策略：`reason_code` 明细 30 天（到期只清明细，不删行）。
pub const DEFAULT_DETAIL_DAYS: i64 = 30;

/// 分页查询过滤条件（时间均为 RFC3339；语义上按 UTC 瞬时比较）。
#[derive(Debug, Clone, Default)]
pub struct AuditFilter {
    pub category: Option<String>,
    pub event_type: Option<String>,
    /// created_at >= from（含边界）
    pub from: Option<String>,
    /// created_at <= to（含边界）
    pub to: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// 审计条目投影：表内不含敏感内容（subject 为库内 UUID 或最小化网段），
/// 字段全集返回，前端可直接展示。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditSummary {
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub items: Vec<AuditSummary>,
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    /// 清空 reason_code 明细的行数（超出明细保留期但仍在元数据保留期）
    pub cleared_reason_codes: i64,
    /// 删除的行数（超出元数据保留期）
    pub deleted_rows: i64,
    /// 清理后剩余行数
    pub remaining_rows: i64,
    pub metadata_cutoff: String,
    pub detail_cutoff: String,
}

const MAX_PAGE_LIMIT: u32 = 100;

/// 分页查询（新 → 旧）。时间过滤用 SQLite `datetime()` 归一到 UTC 秒级比较，
/// 避免 RFC3339 亚秒精度可变导致的字典序误判（秒内边界多保留属可接受误差）。
pub fn list_page(db: &Db, filter: AuditFilter) -> AppResult<AuditPage> {
    let limit = filter.limit.unwrap_or(50).clamp(1, MAX_PAGE_LIMIT);
    let offset = filter.offset.unwrap_or(0);
    db.with_read(|conn| {
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM security_audit_log
             WHERE (?1 IS NULL OR category = ?1)
               AND (?2 IS NULL OR event_type = ?2)
               AND (?3 IS NULL OR datetime(created_at) >= datetime(?3))
               AND (?4 IS NULL OR datetime(created_at) <= datetime(?4))",
            rusqlite::params![
                filter.category,
                filter.event_type,
                filter.from,
                filter.to,
            ],
            |row| row.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, category, event_type, subject, action, result,
                    reason_code, correlation_id, created_at
             FROM security_audit_log
             WHERE (?1 IS NULL OR category = ?1)
               AND (?2 IS NULL OR event_type = ?2)
               AND (?3 IS NULL OR datetime(created_at) >= datetime(?3))
               AND (?4 IS NULL OR datetime(created_at) <= datetime(?4))
             ORDER BY created_at DESC, id DESC
             LIMIT ?5 OFFSET ?6",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![filter.category, filter.event_type, filter.from, filter.to, limit, offset],
            |row| {
                Ok(AuditSummary {
                    id: row.get(0)?,
                    category: row.get(1)?,
                    event_type: row.get(2)?,
                    subject: row.get(3)?,
                    action: row.get(4)?,
                    result: row.get(5)?,
                    reason_code: row.get(6)?,
                    correlation_id: row.get(7)?,
                    created_at: row.get(8)?,
                })
            },
        )?;
        let items = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(AuditPage {
            items,
            total,
            offset,
            limit,
        })
    })
}

fn cutoff_format(dt: chrono::DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// 两段式清理（只由用户显式触发，不在启动时静默执行）：
/// - 先清明细：超出 `detail_days` 的行把 `reason_code` 置空，行保留用于统计；
/// - 再删行：超出 `metadata_days` 的行删除。`detail_days <= metadata_days`
///   保证不会出现「先删行、后清明细」的顺序矛盾。
pub fn prune(db: &Db, metadata_days: i64, detail_days: i64) -> AppResult<PruneReport> {
    if !(7..=3650).contains(&metadata_days) {
        return Err(AppError::Validation(
            "审计元数据保留天数必须在 7..=3650".into(),
        ));
    }
    if !(1..=3650).contains(&detail_days) || detail_days > metadata_days {
        return Err(AppError::Validation(
            "reason_code 明细保留天数必须在 1..=3650 且不大于元数据保留天数".into(),
        ));
    }
    let now = Utc::now();
    let detail_cutoff = cutoff_format(now - Duration::days(detail_days));
    let metadata_cutoff = cutoff_format(now - Duration::days(metadata_days));
    db.with_conn(|conn| {
        // 先清明细：保留行本身（谁、何时、什么事件、结果），只抹去失败原因等明细。
        let cleared = conn.execute(
            "UPDATE security_audit_log SET reason_code = NULL
             WHERE reason_code IS NOT NULL
               AND datetime(created_at) < datetime(?1)",
            rusqlite::params![detail_cutoff],
        )? as i64;
        let deleted = conn.execute(
            "DELETE FROM security_audit_log
             WHERE datetime(created_at) < datetime(?1)",
            rusqlite::params![metadata_cutoff],
        )? as i64;
        let remaining: i64 = conn.query_row(
            "SELECT COUNT(*) FROM security_audit_log",
            [],
            |row| row.get(0),
        )?;
        Ok(PruneReport {
            cleared_reason_codes: cleared,
            deleted_rows: deleted,
            remaining_rows: remaining,
            metadata_cutoff,
            detail_cutoff,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_sync::audit_events as sink;

    fn query_all(db: &Db) -> AuditPage {
        list_page(db, AuditFilter::default()).unwrap()
    }

    #[test]
    fn migrations_create_security_audit_log() {
        // 新库直接打开：迁移 v82 建表成功；旧库（此处用迁移前 schema 模拟不了，
        // 以迁移函数幂等性兜底）重开不报错。
        let db = Db::open_in_memory().unwrap();
        let total: i64 = db
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM security_audit_log", [], |r| r.get(0))
                    .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(total, 0);
        // 幂等：再次执行迁移集合对已迁移库是 no-op（apply_migrations 按 user_version 跳过）。
        db.migrate().unwrap();
    }

    #[test]
    fn record_then_query_roundtrip_and_pagination() {
        let db = Db::open_in_memory().unwrap();
        for idx in 0..5 {
            let event = AuditEvent {
                subject: Some(format!("device-{idx}")),
                ..AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_SUCCEEDED, "complete_pairing", RESULT_OK)
            };
            db.with_conn(|conn| insert_event(conn, &event)).unwrap();
        }
        let page = query_all(&db);
        assert_eq!(page.total, 5);
        assert_eq!(page.items.len(), 5);
        assert_eq!(page.items[0].category, CATEGORY_PAIRING);
        assert_eq!(page.items[0].event_type, EVENT_PAIRING_SUCCEEDED);
        assert!(page.items[0].id.len() == 36);

        // 分页：limit=2 offset=0 → 前 2 条；offset=2 → 后 3 条，无重叠
        let first = list_page(
            &db,
            AuditFilter {
                limit: Some(2),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.total, 5);
        let second = list_page(
            &db,
            AuditFilter {
                limit: Some(2),
                offset: Some(2),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(second.items.len(), 2);
        let ids_first: Vec<&str> = first.items.iter().map(|i| i.id.as_str()).collect();
        let ids_second: Vec<&str> = second.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids_first.iter().all(|id| !ids_second.contains(id)));
    }

    #[test]
    fn query_filters_by_category_event_type_and_time() {
        let db = Db::open_in_memory().unwrap();
        let ok = AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_SUCCEEDED, "complete_pairing", RESULT_OK);
        db.with_conn(|conn| insert_event(conn, &ok)).unwrap();
        let denied = AuditEvent::new(CATEGORY_AUTH, EVENT_AUTH_FAILED, "authenticate_device", RESULT_DENIED);
        db.with_conn(|conn| insert_event(conn, &denied)).unwrap();
        let mcp = AuditEvent::new(CATEGORY_MCP, EVENT_MCP_TOOL_DENIED, "bridge_request", RESULT_FAILED);
        db.with_conn(|conn| insert_event(conn, &mcp)).unwrap();

        let by_category = list_page(
            &db,
            AuditFilter {
                category: Some(CATEGORY_MCP.into()),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(by_category.total, 1);
        assert_eq!(by_category.items[0].event_type, EVENT_MCP_TOOL_DENIED);

        let by_event = list_page(
            &db,
            AuditFilter {
                event_type: Some(EVENT_AUTH_FAILED.into()),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(by_event.total, 1);

        // 时间过滤：未来边界包含全部；过去边界为空
        let future = (Utc::now() + Duration::days(1)).to_rfc3339();
        let from_future = list_page(
            &db,
            AuditFilter {
                from: Some(future),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(from_future.total, 0);
        let past = (Utc::now() - Duration::days(1)).to_rfc3339();
        let to_past = list_page(
            &db,
            AuditFilter {
                to: Some(past.clone()),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(to_past.total, 0);
        let range = list_page(
            &db,
            AuditFilter {
                from: Some(past),
                to: Some((Utc::now() + Duration::days(1)).to_rfc3339()),
                ..AuditFilter::default()
            },
        )
        .unwrap();
        assert_eq!(range.total, 3);
    }

    #[test]
    fn prune_two_phase_clears_detail_then_deletes_metadata() {
        let db = Db::open_in_memory().unwrap();
        // 构造一条 40 天前的 AUTH_FAILED（reason_code 在 30 天明细窗口外、90 天窗口内）
        let old_created = (Utc::now() - Duration::days(40))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let event = AuditEvent {
            reason_code: Some("unauthorized".into()),
            subject: sink::minimize_peer_ip("203.0.113.7"),
            ..AuditEvent::new(CATEGORY_AUTH, EVENT_AUTH_FAILED, "authenticate_device", RESULT_DENIED)
        };
        db.with_conn(|conn| insert_event(conn, &event)).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE security_audit_log SET created_at = ?1",
                rusqlite::params![old_created],
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();

        let report = prune(&db, DEFAULT_METADATA_DAYS, DEFAULT_DETAIL_DAYS).unwrap();
        assert_eq!(report.cleared_reason_codes, 1, "40 天 > 30 天明细窗口");
        assert_eq!(report.deleted_rows, 0, "40 天 < 90 天元数据窗口");
        assert_eq!(report.remaining_rows, 1);
        let page = query_all(&db);
        assert!(page.items[0].reason_code.is_none(), "明细必须被置空");
        assert_eq!(page.items[0].event_type, EVENT_AUTH_FAILED, "行保留用于统计");

        // 100 天前 → 整行删除
        let older = (Utc::now() - Duration::days(100))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE security_audit_log SET created_at = ?1",
                rusqlite::params![older],
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
        let report = prune(&db, DEFAULT_METADATA_DAYS, DEFAULT_DETAIL_DAYS).unwrap();
        assert_eq!(report.deleted_rows, 1);
        assert_eq!(report.remaining_rows, 0);
    }

    #[test]
    fn prune_rejects_invalid_windows() {
        let db = Db::open_in_memory().unwrap();
        assert!(prune(&db, 6, 5).is_err(), "元数据窗口下限 7 天");
        assert!(prune(&db, 90, 120).is_err(), "明细窗口不得大于元数据窗口");
        assert!(prune(&db, 90, 0).is_err(), "明细窗口下限 1 天");
    }

    #[test]
    fn facade_re_exports_minimize_peer_ip() {
        assert_eq!(
            minimize_peer_ip("192.168.5.67").as_deref(),
            Some("192.168.5.0/24")
        );
    }
}
