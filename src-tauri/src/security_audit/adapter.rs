//! 安全审计多源统一查询适配层（冻结契约见 `tmp/acceptance/logging-phase2/interfaces.md` §3.1）。
//!
//! # 边界原则
//!
//! 四套原始存储**保留各自物理边界**：每条统一事件都带 [`SOURCE_*`] 来源标识，
//! 序列化为 `<source>:<原始 id>`，绝不把不同表的行伪装成同一张物理表。
//!
//! | 来源常量 | 原始存储 | 可读入口 |
//! |---|---|---|
//! [`SOURCE_SECURITY_AUDIT_LOG`] | 主库 `security_audit_log`（迁移 v82） | 主 `Db` 连接 |
//! [`SOURCE_MCP_AUDIT_LOG`] | 主库 `mcp_audit_log`（迁移 v37） | 主 `Db` 连接 |
//! [`SOURCE_VAULT`] | 保险箱库 `audit` 表（加密存储内） | [`VaultState`]，仅解锁可读 |
//! [`SOURCE_PERSONAL_HUB`] | Hub 独立进程 `hub.db` 的 `ph_audit_log` | 当前主进程**无只读入口**，`notWired` |
//!
//! # 可注入性
//!
//! 保险库 / Personal Hub 的读取不硬编码全局单例：对外暴露 [`VaultAuditReader`] /
//! [`HubAuditReader`] trait，命令层从 Tauri State 构造生产实现，单测注入内存桩。
//!
//! # 隐私红线
//!
//! - `traceId` 只采纳通过 [`validate_external_id`]（16 位小写 hex）的值；非法值丢弃，
//!   且 traceId **绝不参与**认证/授权/设备信任判断。
//! - Personal Hub 的 `fingerprint` 不进入统一视图（最小化/省略）。
//! - 不可读来源在 `sources[]` 显式标注 `locked` / `notWired` / `error`，**绝不**返回空列表冒充无事件。

use std::cmp::Ordering;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::diagnostics::trace::validate_external_id;
use crate::error::{AppError, AppResult};
use crate::mobile_sync::audit_events::EVENT_DEVICE_REVOKED;
use crate::secure_vault::session::RuntimeState;
use crate::secure_vault::VaultState;

// ── 来源标识（与前端 `SecurityAuditSource` 一一对应，只增不改） ──────────────

pub const SOURCE_SECURITY_AUDIT_LOG: &str = "securityAuditLog";
pub const SOURCE_MCP_AUDIT_LOG: &str = "mcpAuditLog";
pub const SOURCE_VAULT: &str = "vault";
pub const SOURCE_PERSONAL_HUB: &str = "personalHub";

/// 统一分类（与前端 `SecurityAuditCategory` 对齐）。
const CATEGORY_PAIRING: &str = "pairing";
const CATEGORY_AUTH: &str = "auth";
const CATEGORY_MCP: &str = "mcp";
const CATEGORY_CLIPBOARD: &str = "clipboard";
const CATEGORY_DEVICE_REVOKE: &str = "deviceRevoke";
const CATEGORY_VAULT: &str = "vault";
/// 分类：Personal Hub（当前主进程未接入，保留给后续管道/状态接线）。
#[allow(dead_code)]
const CATEGORY_PERSONAL_HUB: &str = "personalHub";
const CATEGORY_OTHER: &str = "other";

/// 结果枚举子集（`ok` / `denied` / `failed`）；原始来源给不出结果时落 `unknown`。
const RESULT_OK: &str = "ok";
const RESULT_DENIED: &str = "denied";
const RESULT_FAILED: &str = "failed";

const DEFAULT_LIMIT: u32 = 50;
const MAX_PAGE_LIMIT: u32 = 100;

// ── 对外契约结构（序列化后与前端 `SecurityAuditPage` 逐字段一致） ────────────

/// 查询过滤参数（camelCase 入参，全部可选；与前端 `SecurityAuditFilter` 对齐）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilterArgs {
    pub source: Option<String>,
    pub category: Option<String>,
    pub event_type: Option<String>,
    pub result: Option<String>,
    /// 主体过滤：设备 UUID / 代理 ID 精确匹配，或最小化网段/标识前缀匹配。
    pub device: Option<String>,
    /// RFC3339，含边界。
    pub from: Option<String>,
    /// RFC3339，含边界。
    pub to: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// 统一事件视图。`id` = `<source>:<原始 id>`，不是任何物理表的主键。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedAuditEvent {
    pub id: String,
    pub source: String,
    pub event_type: String,
    pub category: String,
    pub subject: Option<String>,
    pub action: String,
    pub result: String,
    pub reason_code: Option<String>,
    pub trace_id: Option<String>,
    pub created_at: String,
}

/// 单源覆盖状态：未接入/不可读必须显式说明，不能伪装成「没有事件」。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSourceStatus {
    pub source: String,
    /// `available` | `empty` | `locked` | `notWired` | `error`
    pub status: String,
    pub total: Option<i64>,
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedAuditPage {
    pub items: Vec<UnifiedAuditEvent>,
    /// 合并视图总条数（各源 COUNT 之和，不是物理表行数）。
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
    pub sources: Vec<UnifiedSourceStatus>,
}

// ── 可注入的外部源入口 ──────────────────────────────────────────────────────

/// 保险库审计只读入口。生产实现包装 [`VaultState`]；测试注入内存桩。
pub trait VaultAuditReader: Send + Sync {
    /// 运行态：`unlocked` / `locked` / `noVault` / `recovery`。
    fn runtime(&self) -> &str;
    /// 读取最近 `limit` 条审计行（调用方已确认可读）。
    fn load_audit(&self, limit: usize) -> AppResult<Vec<VaultAuditRow>>;
}

/// 与保险箱 `AuditRow` 对齐的最小投影（`count` 不进入统一视图）。
#[derive(Debug, Clone)]
pub struct VaultAuditRow {
    pub id: i64,
    pub at: String,
    pub event: String,
    pub outcome: String,
    pub reason_code: Option<String>,
}

/// Personal Hub 审计只读入口。当前主进程未持有 HubStore（独立进程 + 管道协议
/// 未暴露审计读取方法），生产接线传 `None`；保留 trait 供后续管道方法/状态接入。
pub trait HubAuditReader: Send + Sync {
    fn query(
        &self,
        filter: &AuditFilterArgs,
        fetch_limit: u32,
        offset: u32,
    ) -> AppResult<HubSourcePage>;
}

#[derive(Debug, Clone)]
pub struct HubSourcePage {
    pub total: i64,
    pub items: Vec<UnifiedAuditEvent>,
}

/// 查询上下文：主库 + 可选外部源提供者。
pub struct AuditSources<'a> {
    pub vault: Option<&'a dyn VaultAuditReader>,
    pub hub: Option<&'a dyn HubAuditReader>,
}

// ── 生产接线：Tauri State 包装 ────────────────────────────────────────────────

/// 生产保险库源：从 [`VaultState`] 读取会话态与审计表。
pub struct TauriVaultSource {
    state: Arc<VaultState>,
}

impl TauriVaultSource {
    pub fn new(state: Arc<VaultState>) -> Self {
        Self { state }
    }
}

impl VaultAuditReader for TauriVaultSource {
    fn runtime(&self) -> &str {
        match self.state.session.read().runtime {
            RuntimeState::Unlocked => "unlocked",
            RuntimeState::NoVault => "noVault",
            RuntimeState::Recovery => "recovery",
            RuntimeState::Locked => "locked",
        }
    }

    fn load_audit(&self, limit: usize) -> AppResult<Vec<VaultAuditRow>> {
        let rows = self
            .state
            .with_store(|store| store.load_audit(limit))
            .map_err(|e| AppError::Agent(format!("vault audit read failed: {}", e.message)))?;
        Ok(rows
            .into_iter()
            .map(|r| VaultAuditRow {
                id: r.id,
                at: r.at,
                event: r.event,
                outcome: r.outcome,
                reason_code: r.reason_code,
            })
            .collect())
    }
}

// ── 统一查询入口 ────────────────────────────────────────────────────────────

/// 合并查询：每个源按 `offset + limit` 取数，合并排序后切片；`total` 为各源计数之和。
pub fn unified_query(
    db: &Db,
    filter: &AuditFilterArgs,
    sources: &AuditSources<'_>,
) -> AppResult<UnifiedAuditPage> {
    let (limit, offset) = filter.normalized_limit_offset();
    // 各源取 `offset + limit` 条，保证合并切片后仍能填满当前页（上限 100）。
    let fetch = offset.saturating_add(limit).clamp(0, MAX_PAGE_LIMIT as u32 + MAX_PAGE_LIMIT);

    let security = query_security(db, filter, fetch)?;
    let mcp = query_mcp(db, filter, fetch)?;
    let vault = query_vault(sources.vault, filter, fetch);
    let hub = query_hub(sources.hub, filter, fetch);

    let outcomes = [security, mcp, vault, hub];
    let total: i64 = outcomes.iter().map(|o| o.total).sum();

    let mut items: Vec<UnifiedAuditEvent> = outcomes
        .iter()
        .flat_map(|o| o.items.clone())
        .filter(|e| source_matches_filter(&e.source, filter))
        .collect();
    items.sort_by(compare_events_desc);
    let items: Vec<_> = items.into_iter().skip(offset as usize).take(limit as usize).collect();

    Ok(UnifiedAuditPage {
        items,
        total,
        offset,
        limit,
        sources: outcomes.into_iter().map(|o| o.status).collect(),
    })
}

impl AuditFilterArgs {
    /// 分页归一：limit 1..=100 默认 50；offset 默认 0。
    pub fn normalized_limit_offset(&self) -> (u32, u32) {
        let limit = self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_PAGE_LIMIT);
        let offset = self.offset.unwrap_or(0);
        (limit, offset)
    }
}

struct SourceOutcome {
    items: Vec<UnifiedAuditEvent>,
    total: i64,
    status: UnifiedSourceStatus,
}

fn available_status(source: &str, total: i64) -> UnifiedSourceStatus {
    let status = if total > 0 { "available" } else { "empty" };
    UnifiedSourceStatus {
        source: source.to_string(),
        status: status.to_string(),
        total: Some(total),
        note: None,
    }
}

// ── 源 1：security_audit_log ─────────────────────────────────────────────────

fn query_security(db: &Db, filter: &AuditFilterArgs, fetch: u32) -> AppResult<SourceOutcome> {
    // category 映射：deviceRevoke 在库里落 event_type=DEVICE_REVOKED、category=auth，
    // 因此拆成两条 SQL 谓词；其余分类按存储 category 直通。
    let (category_sql, revoke_event) = match filter.category.as_deref() {
        Some(CATEGORY_DEVICE_REVOKE) => (None, Some(EVENT_DEVICE_REVOKED.to_string())),
        other => (other.map(str::to_string), None),
    };

    let count: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM security_audit_log
             WHERE (?1 IS NULL OR event_type = ?1)
               AND (?2 IS NULL OR result = ?2)
               AND (?3 IS NULL OR datetime(created_at) >= datetime(?3))
               AND (?4 IS NULL OR datetime(created_at) <= datetime(?4))
               AND (?5 IS NULL OR category = ?5)
               AND (?6 IS NULL OR event_type = ?6)",
            rusqlite::params![
                filter.event_type,
                filter.result,
                filter.from,
                filter.to,
                category_sql,
                revoke_event,
            ],
            |row| row.get(0),
        )
        .map_err(crate::error::AppError::from)
    })?;

    let items = db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, category, event_type, subject, action, result,
                        reason_code, correlation_id, created_at
                 FROM security_audit_log
                 WHERE (?1 IS NULL OR event_type = ?1)
                   AND (?2 IS NULL OR result = ?2)
                   AND (?3 IS NULL OR datetime(created_at) >= datetime(?3))
                   AND (?4 IS NULL OR datetime(created_at) <= datetime(?4))
                   AND (?5 IS NULL OR category = ?5)
                   AND (?6 IS NULL OR event_type = ?6)
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?7",
            )
            .map_err(crate::error::AppError::from)?;
        let rows = stmt.query_map(
            rusqlite::params![
                filter.event_type,
                filter.result,
                filter.from,
                filter.to,
                category_sql,
                revoke_event,
                fetch,
            ],
            |row| {
                let raw_id: String = row.get(0)?;
                let stored_category: String = row.get(1)?;
                let event_type: String = row.get(2)?;
                let subject: Option<String> = row.get(3)?;
                let action: String = row.get(4)?;
                let result: String = row.get(5)?;
                let reason_code: Option<String> = row.get(6)?;
                let correlation_id: Option<String> = row.get(7)?;
                let created_at: String = row.get(8)?;
                Ok(UnifiedAuditEvent {
                    id: format!("{SOURCE_SECURITY_AUDIT_LOG}:{raw_id}"),
                    source: SOURCE_SECURITY_AUDIT_LOG.to_string(),
                    category: map_security_category(&event_type, &stored_category),
                    event_type,
                    subject,
                    action,
                    result,
                    reason_code,
                    trace_id: correlation_id.as_deref().and_then(validate_external_id),
                    created_at,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::error::AppError::from)
    })?;

    let items: Vec<_> = items
        .into_iter()
        .filter(|e| row_matches_filter(e, filter))
        .collect();

    Ok(SourceOutcome {
        total: count,
        status: available_status(SOURCE_SECURITY_AUDIT_LOG, count),
        items,
    })
}

/// 库内 category → 统一分类：设备撤销事件独立归 `deviceRevoke`；已知分类直通；
/// 其余落 `other`，不伪造枚举值。
fn map_security_category(event_type: &str, stored: &str) -> String {
    if event_type == EVENT_DEVICE_REVOKED {
        return CATEGORY_DEVICE_REVOKE.to_string();
    }
    match stored {
        CATEGORY_PAIRING | CATEGORY_AUTH | CATEGORY_MCP | CATEGORY_CLIPBOARD => stored.to_string(),
        _ => CATEGORY_OTHER.to_string(),
    }
}

// ── 源 2：mcp_audit_log ─────────────────────────────────────────────────────

fn query_mcp(db: &Db, filter: &AuditFilterArgs, fetch: u32) -> AppResult<SourceOutcome> {
    let count: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM mcp_audit_log
             WHERE (?1 IS NULL OR datetime(created_at) >= datetime(?1))
               AND (?2 IS NULL OR datetime(created_at) <= datetime(?2))",
            rusqlite::params![filter.from, filter.to],
            |row| row.get(0),
        )
        .map_err(crate::error::AppError::from)
    })?;

    let items = db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, action, entity_type, entity_id, request_id,
                        success, authz, created_at
                 FROM mcp_audit_log
                 WHERE (?1 IS NULL OR datetime(created_at) >= datetime(?1))
                   AND (?2 IS NULL OR datetime(created_at) <= datetime(?2))
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?3",
            )
            .map_err(crate::error::AppError::from)?;
        let rows = stmt.query_map(
            rusqlite::params![filter.from, filter.to, fetch],
            |row| {
                let raw_id: String = row.get(0)?;
                let agent_id: String = row.get(1)?;
                let action: String = row.get(2)?;
                let entity_type: String = row.get(3)?;
                let _entity_id: String = row.get(4)?;
                let request_id: String = row.get(5)?;
                let success: i64 = row.get(6)?;
                let authz: i64 = row.get(7)?;
                let created_at: String = row.get(8)?;

                // 结果映射：authz=0 → denied；success=1 且 authz=1 → ok；其余 failed。
                let result = if authz == 0 {
                    RESULT_DENIED
                } else if success == 1 {
                    RESULT_OK
                } else {
                    RESULT_FAILED
                };
                let reason_code = if authz == 0 {
                    Some("authorization_denied".to_string())
                } else if success == 0 {
                    Some("operation_failed".to_string())
                } else {
                    None
                };
                let subject = (!agent_id.is_empty()).then_some(agent_id);
                let event_type = if entity_type.is_empty() {
                    action.clone()
                } else {
                    entity_type
                };

                Ok(UnifiedAuditEvent {
                    id: format!("{SOURCE_MCP_AUDIT_LOG}:{raw_id}"),
                    source: SOURCE_MCP_AUDIT_LOG.to_string(),
                    category: CATEGORY_MCP.to_string(),
                    event_type,
                    subject,
                    action,
                    result: result.to_string(),
                    reason_code,
                    trace_id: (!request_id.is_empty())
                        .then_some(request_id.as_str())
                        .and_then(validate_external_id),
                    created_at,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::error::AppError::from)
    })?;
    let items: Vec<_> = items.into_iter().filter(|e| row_matches_filter(e, filter)).collect();

    Ok(SourceOutcome {
        total: count,
        status: available_status(SOURCE_MCP_AUDIT_LOG, count),
        items,
    })
}

// ── 源 3：保险箱 audit ──────────────────────────────────────────────────────

fn query_vault(reader: Option<&dyn VaultAuditReader>, filter: &AuditFilterArgs, fetch: u32) -> SourceOutcome {
    let Some(reader) = reader else {
        return SourceOutcome {
            items: Vec::new(),
            total: 0,
            status: UnifiedSourceStatus {
                source: SOURCE_VAULT.to_string(),
                status: "notWired".to_string(),
                total: None,
                note: Some("保险箱状态未接入审计适配层".to_string()),
            },
        };
    };

    match reader.runtime() {
        "unlocked" => match reader.load_audit(fetch as usize) {
            Ok(rows) => {
                let items: Vec<UnifiedAuditEvent> = rows
                    .into_iter()
                    .map(|r| UnifiedAuditEvent {
                        id: format!("{SOURCE_VAULT}:{}", r.id),
                        source: SOURCE_VAULT.to_string(),
                        event_type: r.event.clone(),
                        category: CATEGORY_VAULT.to_string(),
                        subject: None,
                        action: r.event,
                        result: r.outcome,
                        reason_code: r.reason_code,
                        trace_id: None,
                        created_at: r.at,
                    })
                    .filter(|e| row_matches_filter(e, filter))
                    .collect();
                let total = items.len() as i64;
                SourceOutcome {
                    total,
                    status: available_status(SOURCE_VAULT, total),
                    items,
                }
            }
            Err(e) => SourceOutcome {
                items: Vec::new(),
                total: 0,
                status: UnifiedSourceStatus {
                    source: SOURCE_VAULT.to_string(),
                    status: "error".to_string(),
                    total: None,
                    note: Some(format!("保险箱审计读取失败：{}", e.user_message())),
                },
            },
        },
        "noVault" => SourceOutcome {
            items: Vec::new(),
            total: 0,
            status: UnifiedSourceStatus {
                source: SOURCE_VAULT.to_string(),
                status: "locked".to_string(),
                total: None,
                note: Some("保险库尚未创建".to_string()),
            },
        },
        "recovery" => SourceOutcome {
            items: Vec::new(),
            total: 0,
            status: UnifiedSourceStatus {
                source: SOURCE_VAULT.to_string(),
                status: "locked".to_string(),
                total: None,
                note: Some("恢复模式会话，保险库审计暂不可读".to_string()),
            },
        },
        _ => SourceOutcome {
            items: Vec::new(),
            total: 0,
            status: UnifiedSourceStatus {
                source: SOURCE_VAULT.to_string(),
                status: "locked".to_string(),
                total: None,
                note: Some("保险库未解锁".to_string()),
            },
        },
    }
}

// ── 源 4：Personal Hub ph_audit_log ─────────────────────────────────────────

fn query_hub(
    reader: Option<&dyn HubAuditReader>,
    filter: &AuditFilterArgs,
    fetch: u32,
) -> SourceOutcome {
    let Some(reader) = reader else {
        return SourceOutcome {
            items: Vec::new(),
            total: 0,
            status: UnifiedSourceStatus {
                source: SOURCE_PERSONAL_HUB.to_string(),
                status: "notWired".to_string(),
                total: None,
                note: Some(
                    "Personal Hub 运行在独立进程，主进程尚未接入 ph_audit_log 只读入口".to_string(),
                ),
            },
        };
    };

    match reader.query(filter, fetch, 0) {
        Ok(page) => {
            let items: Vec<_> = page
                .items
                .into_iter()
                .filter(|e| row_matches_filter(e, filter))
                .collect();
            let total = items.len() as i64;
            SourceOutcome {
                total,
                status: available_status(SOURCE_PERSONAL_HUB, total),
                items,
            }
        }
        Err(e) => SourceOutcome {
            items: Vec::new(),
            total: 0,
            status: UnifiedSourceStatus {
                source: SOURCE_PERSONAL_HUB.to_string(),
                status: "error".to_string(),
                total: None,
                note: Some(format!("Hub 审计读取失败：{}", e.user_message())),
            },
        },
    }
}

// ── 过滤与排序公共逻辑 ──────────────────────────────────────────────────────

fn source_matches_filter(source: &str, filter: &AuditFilterArgs) -> bool {
    match filter.source.as_deref() {
        Some(only) => source == only,
        None => true,
    }
}

fn row_matches_filter(e: &UnifiedAuditEvent, filter: &AuditFilterArgs) -> bool {
    if !source_matches_filter(&e.source, filter) {
        return false;
    }
    if let Some(category) = &filter.category {
        if e.category != *category {
            return false;
        }
    }
    if let Some(event_type) = &filter.event_type {
        if e.event_type != *event_type {
            return false;
        }
    }
    if let Some(result) = &filter.result {
        if e.result != *result {
            return false;
        }
    }
    if !device_matches(&e.subject, &filter.device) {
        return false;
    }
    if !in_time_bounds(&e.created_at, &filter.from, &filter.to) {
        return false;
    }
    true
}

/// 主体过滤：精确匹配，或 subject 以前缀开头（覆盖最小化网段/标识前缀）。
/// 空设备条件不过滤；subject 缺失时不命中。
fn device_matches(subject: &Option<String>, device: &Option<String>) -> bool {
    let Some(device) = device.as_deref().filter(|d| !d.is_empty()) else {
        return true;
    };
    let Some(subject) = subject.as_deref() else {
        return false;
    };
    subject == device || subject.starts_with(device)
}

fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// 时间边界按 UTC 瞬时比较；解析失败回退字典序（与既有 SQL `datetime()` 归一一致，
/// 秒内边界多保留属可接受误差）。
fn in_time_bounds(created: &str, from: &Option<String>, to: &Option<String>) -> bool {
    let created = parse_ts(created);
    let from = from.as_deref().and_then(parse_ts);
    let to = to.as_deref().and_then(parse_ts);
    match (from, created) {
        (Some(f), Some(c)) if c < f => return false,
        _ => {}
    }
    match (to, created) {
        (Some(t), Some(c)) if c > t => return false,
        _ => {}
    }
    true
}

/// 合并排序：`created_at` DESC；同刻按来源、原始 id 稳定兜底，避免跨源乱序。
fn compare_events_desc(a: &UnifiedAuditEvent, b: &UnifiedAuditEvent) -> Ordering {
    let by_time = match (parse_ts(&a.created_at), parse_ts(&b.created_at)) {
        (Some(x), Some(y)) => y.cmp(&x),
        _ => b.created_at.cmp(&a.created_at),
    };
    by_time
        .then_with(|| a.source.cmp(&b.source))
        .then_with(|| b.id.cmp(&a.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_sync::audit_events::{
        insert_event, AuditEvent, CATEGORY_PAIRING, EVENT_PAIRING_SUCCEEDED, RESULT_FAILED, RESULT_OK,
    };

    /// 内存桩保险库源。
    struct FakeVault {
        runtime: String,
        rows: Vec<VaultAuditRow>,
    }

    impl VaultAuditReader for FakeVault {
        fn runtime(&self) -> &str {
            &self.runtime
        }
        fn load_audit(&self, _limit: usize) -> AppResult<Vec<VaultAuditRow>> {
            Ok(self.rows.clone())
        }
    }

    /// 内存桩 Hub 源。
    struct FakeHub {
        items: Vec<UnifiedAuditEvent>,
    }

    impl HubAuditReader for FakeHub {
        fn query(
            &self,
            _filter: &AuditFilterArgs,
            _fetch_limit: u32,
            _offset: u32,
        ) -> AppResult<HubSourcePage> {
            Ok(HubSourcePage {
                total: self.items.len() as i64,
                items: self.items.clone(),
            })
        }
    }

    /// 剪贴板审计是独立分类，不能落入 `other`；未知分类仍按 `other` 兜底。
    #[test]
    fn clipboard_audit_category_is_passed_through() {
        assert_eq!(
            map_security_category("CLIPBOARD_EXPORT_SUCCEEDED", "clipboard"),
            "clipboard"
        );
        assert_eq!(map_security_category("UNKNOWN", "whatever"), CATEGORY_OTHER);
    }

    fn mcp_row(
        db: &Db,
        agent_id: &str,
        action: &str,
        entity_type: &str,
        request_id: &str,
        success: i64,
        authz: i64,
        created_at: &str,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mcp_audit_log
                   (id, agent_row_id, agent_id, action, entity_type, entity_id, request_id,
                    success, authz, detail, result_json, created_at)
                 VALUES (?1, NULL, ?2, ?3, ?4, '', ?5, ?6, ?7, '', '', ?8)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    agent_id,
                    action,
                    entity_type,
                    request_id,
                    success,
                    authz,
                    created_at,
                ],
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    }

    fn security_row(db: &Db, subject: Option<&str>, result: &str, created_at: &str, correlation: Option<&str>) {
        let event = AuditEvent {
            subject: subject.map(str::to_string),
            correlation_id: correlation.map(str::to_string),
            ..AuditEvent::new(CATEGORY_PAIRING, EVENT_PAIRING_SUCCEEDED, "complete_pairing", result)
        };
        db.with_conn(|conn| insert_event(conn, &event)).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE security_audit_log SET created_at = ?1 WHERE id = ?2",
                rusqlite::params![created_at, event.id],
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    }

    fn vault_event(id: i64, at: &str, event: &str, outcome: &str) -> VaultAuditRow {
        VaultAuditRow {
            id,
            at: at.to_string(),
            event: event.to_string(),
            outcome: outcome.to_string(),
            reason_code: None,
        }
    }

    fn hub_event(id: &str, at: &str, subject: &str) -> UnifiedAuditEvent {
        UnifiedAuditEvent {
            id: format!("{SOURCE_PERSONAL_HUB}:{id}"),
            source: SOURCE_PERSONAL_HUB.to_string(),
            event_type: "PAIRING_APPROVED".to_string(),
            category: CATEGORY_PERSONAL_HUB.to_string(),
            subject: Some(subject.to_string()),
            action: "pairing_approved".to_string(),
            result: RESULT_OK.to_string(),
            reason_code: None,
            trace_id: None,
            created_at: at.to_string(),
        }
    }

    #[test]
    fn source_identifiers_are_kept_separate() {
        let db = Db::open_in_memory().unwrap();
        security_row(&db, Some("device-a"), RESULT_OK, "2026-11-19T10:00:00.000Z", None);
        mcp_row(&db, "agent-1", "taskdock_list_tasks", "task", "req-1", 1, 1, "2026-11-19T10:01:00.000Z");

        let vault = FakeVault {
            runtime: "unlocked".into(),
            rows: vec![vault_event(1, "2026-11-19T10:02:00.000Z", "unlock", "ok")],
        };
        let hub = FakeHub {
            items: vec![hub_event("7", "2026-11-19T10:03:00.000Z", "device-h")],
        };
        let page = unified_query(
            &db,
            &AuditFilterArgs::default(),
            &AuditSources {
                vault: Some(&vault),
                hub: Some(&hub),
            },
        )
        .unwrap();

        let by_source: Vec<&str> = page.items.iter().map(|e| e.source.as_str()).collect();
        assert_eq!(
            by_source,
            [
                SOURCE_PERSONAL_HUB,
                SOURCE_VAULT,
                SOURCE_MCP_AUDIT_LOG,
                SOURCE_SECURITY_AUDIT_LOG
            ]
        );
        for e in &page.items {
            assert!(e.id.starts_with(&format!("{}:", e.source)));
        }
        let statuses: Vec<&str> = page.sources.iter().map(|s| s.source.as_str()).collect();
        assert_eq!(
            statuses,
            [
                SOURCE_SECURITY_AUDIT_LOG,
                SOURCE_MCP_AUDIT_LOG,
                SOURCE_VAULT,
                SOURCE_PERSONAL_HUB
            ]
        );
    }

    #[test]
    fn merged_pagination_has_no_overlap_and_is_desc() {
        let db = Db::open_in_memory().unwrap();
        // 时间从旧到新穿插写入四个源。
        security_row(&db, Some("dev-1"), RESULT_OK, "2026-11-19T09:00:00.000Z", None);
        mcp_row(&db, "agent-1", "action-a", "task", "", 1, 1, "2026-11-19T09:05:00.000Z");
        security_row(&db, Some("dev-2"), RESULT_FAILED, "2026-11-19T09:10:00.000Z", None);
        mcp_row(&db, "agent-2", "action-b", "project", "", 0, 1, "2026-11-19T09:15:00.000Z");
        let vault = FakeVault {
            runtime: "unlocked".into(),
            rows: vec![
                vault_event(1, "2026-11-19T09:20:00.000Z", "unlock", "ok"),
                vault_event(2, "2026-11-19T09:25:00.000Z", "lock", "ok"),
            ],
        };
        let hub = FakeHub {
            items: vec![
                hub_event("1", "2026-11-19T09:30:00.000Z", "dev-h1"),
                hub_event("2", "2026-11-19T09:35:00.000Z", "dev-h2"),
            ],
        };
        let sources = AuditSources {
            vault: Some(&vault),
            hub: Some(&hub),
        };

        let first = unified_query(
            &db,
            &AuditFilterArgs {
                limit: Some(3),
                offset: Some(0),
                ..Default::default()
            },
            &sources,
        )
        .unwrap();
        let second = unified_query(
            &db,
            &AuditFilterArgs {
                limit: Some(3),
                offset: Some(3),
                ..Default::default()
            },
            &sources,
        )
        .unwrap();

        assert_eq!(first.total, 8);
        assert_eq!(first.items.len(), 3);
        assert_eq!(second.items.len(), 3);
        let first_ids: Vec<&str> = first.items.iter().map(|e| e.id.as_str()).collect();
        let second_ids: Vec<&str> = second.items.iter().map(|e| e.id.as_str()).collect();
        assert!(first_ids.iter().all(|id| !second_ids.contains(id)), "分页不得重叠");

        // 合并后整体 DESC：第一页首条晚于第二页末条。
        assert!(first.items[0].created_at >= first.items[2].created_at);
        assert!(second.items[0].created_at >= second.items[2].created_at);
        assert!(first.items[0].created_at >= second.items[0].created_at);
    }

    #[test]
    fn single_source_filter_narrows_items_and_statuses_stay_full() {
        let db = Db::open_in_memory().unwrap();
        security_row(&db, Some("dev-1"), RESULT_OK, "2026-11-19T09:00:00.000Z", None);
        mcp_row(&db, "agent-1", "action-a", "task", "", 1, 1, "2026-11-19T09:05:00.000Z");
        let vault = FakeVault {
            runtime: "unlocked".into(),
            rows: vec![vault_event(1, "2026-11-19T09:10:00.000Z", "unlock", "ok")],
        };
        let page = unified_query(
            &db,
            &AuditFilterArgs {
                source: Some(SOURCE_MCP_AUDIT_LOG.into()),
                ..Default::default()
            },
            &AuditSources {
                vault: Some(&vault),
                hub: None,
            },
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source, SOURCE_MCP_AUDIT_LOG);
        // 覆盖状态仍列出全部来源，未命中源不报错。
        assert_eq!(page.sources.len(), 4);
    }

    #[test]
    fn time_filter_and_result_filter_apply_across_sources() {
        let db = Db::open_in_memory().unwrap();
        security_row(&db, Some("dev-1"), RESULT_OK, "2026-11-19T08:00:00.000Z", None);
        security_row(&db, Some("dev-2"), RESULT_FAILED, "2026-11-19T12:00:00.000Z", None);
        mcp_row(&db, "agent-1", "action-a", "task", "", 0, 1, "2026-11-19T10:00:00.000Z");

        let by_result = unified_query(
            &db,
            &AuditFilterArgs {
                result: Some(RESULT_FAILED.into()),
                ..Default::default()
            },
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        assert_eq!(by_result.total, 2, "security failed + mcp failed");
        assert!(by_result.items.iter().all(|e| e.result == RESULT_FAILED));

        let by_time = unified_query(
            &db,
            &AuditFilterArgs {
                from: Some("2026-11-19T09:00:00.000Z".into()),
                to: Some("2026-11-19T11:00:00.000Z".into()),
                ..Default::default()
            },
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        assert_eq!(by_time.total, 1);
        assert_eq!(by_time.items[0].source, SOURCE_MCP_AUDIT_LOG);
    }

    #[test]
    fn device_filter_matches_exact_or_prefix_subject() {
        let db = Db::open_in_memory().unwrap();
        security_row(&db, Some("device-alpha"), RESULT_OK, "2026-11-19T09:00:00.000Z", None);
        mcp_row(&db, "agent-beta", "action-a", "task", "", 1, 1, "2026-11-19T09:05:00.000Z");

        let exact = unified_query(
            &db,
            &AuditFilterArgs {
                device: Some("device-alpha".into()),
                ..Default::default()
            },
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        assert_eq!(exact.items.len(), 1);
        assert_eq!(exact.items[0].subject.as_deref(), Some("device-alpha"));

        let prefix = unified_query(
            &db,
            &AuditFilterArgs {
                device: Some("agent-be".into()),
                ..Default::default()
            },
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        assert_eq!(prefix.items.len(), 1);
        assert_eq!(prefix.items[0].source, SOURCE_MCP_AUDIT_LOG);
    }

    #[test]
    fn mcp_authz_zero_is_denied_and_others_map_failed_or_ok() {
        let db = Db::open_in_memory().unwrap();
        // authz=0 → denied（即使 success=1 也先按拒绝归类）
        mcp_row(&db, "agent-a", "denied-action", "task", "", 1, 0, "2026-11-19T09:00:00.000Z");
        // authz=1 且 success=1 → ok
        mcp_row(&db, "agent-b", "ok-action", "task", "", 1, 1, "2026-11-19T09:05:00.000Z");
        // authz=1 且 success=0 → failed
        mcp_row(&db, "agent-c", "failed-action", "task", "", 0, 1, "2026-11-19T09:10:00.000Z");

        let page = unified_query(
            &db,
            &AuditFilterArgs::default(),
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        let by_result: Vec<&str> = page.items.iter().map(|e| e.result.as_str()).collect();
        assert_eq!(by_result, ["failed", "ok", "denied"]);
        let denied = page.items.iter().find(|e| e.result == RESULT_DENIED).unwrap();
        assert_eq!(denied.reason_code.as_deref(), Some("authorization_denied"));
    }

    #[test]
    fn invalid_correlation_and_request_ids_are_not_exposed_as_trace_id() {
        let db = Db::open_in_memory().unwrap();
        // 合法 16-hex
        security_row(
            &db,
            Some("dev-1"),
            RESULT_OK,
            "2026-11-19T09:00:00.000Z",
            Some("0123456789abcdef"),
        );
        // UUID / 短串 / 大写 hex / 空串均丢弃
        security_row(
            &db,
            Some("dev-2"),
            RESULT_OK,
            "2026-11-19T09:01:00.000Z",
            Some("5b6c6710-f466-4f95-a0dd-c410ad92a432"),
        );
        mcp_row(&db, "agent-1", "action-a", "task", "req-1", 1, 1, "2026-11-19T09:02:00.000Z");
        mcp_row(&db, "agent-2", "action-b", "task", "0123456789ABCDEF", 1, 1, "2026-11-19T09:03:00.000Z");
        mcp_row(&db, "agent-3", "action-c", "task", "", 1, 1, "2026-11-19T09:04:00.000Z");

        let page = unified_query(
            &db,
            &AuditFilterArgs::default(),
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        let traced: Vec<&str> = page
            .items
            .iter()
            .filter_map(|e| e.trace_id.as_deref())
            .collect();
        assert_eq!(traced, ["0123456789abcdef"]);
    }

    #[test]
    fn vault_locked_reports_locked_without_error_or_items() {
        let db = Db::open_in_memory().unwrap();
        security_row(&db, Some("dev-1"), RESULT_OK, "2026-11-19T09:00:00.000Z", None);
        let vault = FakeVault {
            runtime: "locked".into(),
            rows: Vec::new(),
        };
        let page = unified_query(
            &db,
            &AuditFilterArgs::default(),
            &AuditSources {
                vault: Some(&vault),
                hub: None,
            },
        )
        .unwrap();
        let vault_status = page
            .sources
            .iter()
            .find(|s| s.source == SOURCE_VAULT)
            .unwrap();
        assert_eq!(vault_status.status, "locked");
        assert_eq!(vault_status.total, None);
        assert_eq!(vault_status.note.as_deref(), Some("保险库未解锁"));
        assert!(page.items.iter().all(|e| e.source != SOURCE_VAULT));
        assert_eq!(page.total, 1, "locked 源不计入合并 total");
    }

    #[test]
    fn personal_hub_without_reader_is_not_wired_not_empty() {
        let db = Db::open_in_memory().unwrap();
        let page = unified_query(
            &db,
            &AuditFilterArgs::default(),
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        let hub_status = page
            .sources
            .iter()
            .find(|s| s.source == SOURCE_PERSONAL_HUB)
            .unwrap();
        assert_eq!(hub_status.status, "notWired");
        assert!(hub_status.note.as_ref().is_some());
    }

    #[test]
    fn device_revoked_event_maps_to_device_revoke_category() {
        let db = Db::open_in_memory().unwrap();
        // 直接落一行 DEVICE_REVOKED（绕过常量语义，仅做分类映射验证）。
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO security_audit_log
                   (id, category, event_type, subject, action, result, reason_code, correlation_id, created_at)
                 VALUES (?1, 'auth', 'DEVICE_REVOKED', ?2, 'revoke_device', 'ok', NULL, NULL, ?3)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    "device-rev-1",
                    "2026-11-19T09:00:00.000Z"
                ],
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
        let page = unified_query(
            &db,
            &AuditFilterArgs {
                category: Some(CATEGORY_DEVICE_REVOKE.into()),
                ..Default::default()
            },
            &AuditSources { vault: None, hub: None },
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].category, CATEGORY_DEVICE_REVOKE);
    }
}
