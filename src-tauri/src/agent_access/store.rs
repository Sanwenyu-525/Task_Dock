//! 新增实体的持久化：版本计数器、决策、交接、工作报告、活动、同步事件/冲突、
//! 上下文访问、REST 幂等缓存。
//!
//! 所有 SQL 都参数化；JSON 数组字段以文本存储，读出时容错为空数组（旧行/手改行不崩）。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{ActorKind, Page, Principal, Source};

// ── 通用工具 ─────────────────────────────────────────────────────

pub fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(20).clamp(1, 200)
}

pub fn clamp_offset(offset: Option<u32>) -> u32 {
    offset.unwrap_or(0).min(10_000)
}

pub fn json_array<T: Serialize>(items: &[T]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".into())
}

pub fn parse_string_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

pub fn parse_value_array(raw: &str) -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(raw).unwrap_or_default()
}

/// 文本字段长度校验（字符数，不是字节数）。
pub fn check_text(field: &str, value: &str, max: usize) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} 超过 {max} 字符（当前 {}）",
            value.chars().count()
        )));
    }
    Ok(())
}

pub fn check_items(field: &str, items: &[String]) -> AppResult<()> {
    if items.len() > 50 {
        return Err(AppError::Validation(format!(
            "{field} 最多 50 项（当前 {}）",
            items.len()
        )));
    }
    for item in items {
        check_text(field, item, 500)?;
    }
    Ok(())
}

// ── 资源版本 ─────────────────────────────────────────────────────

/// 读取版本计数器（不存在返回 0/空）。
pub fn read_revision(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> AppResult<(i64, String, String)> {
    let row = conn
        .query_row(
            "SELECT revision, updated_at, content_hash FROM agent_resource_revisions
             WHERE resource_kind = ?1 AND resource_id = ?2",
            rusqlite::params![kind, id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(AppError::from)?;
    Ok(row.unwrap_or((0, String::new(), String::new())))
}

/// 版本推进：计数器 +1，记录谁在什么入口写的（必须在业务写事务内调用）。
pub fn bump_revision(
    conn: &Connection,
    kind: &str,
    id: &str,
    principal: &Principal,
    updated_at: &str,
    content_hash: &str,
) -> AppResult<i64> {
    let prior = read_revision(conn, kind, id)?;
    let next = prior.0.saturating_add(1);
    conn.execute(
        "INSERT INTO agent_resource_revisions
           (id, resource_kind, resource_id, revision, updated_at, updated_by, actor_kind, source, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(resource_kind, resource_id) DO UPDATE SET
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           actor_kind = excluded.actor_kind,
           source = excluded.source,
           content_hash = excluded.content_hash",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            kind,
            id,
            next,
            updated_at,
            principal.label(),
            principal.actor_kind.as_str(),
            principal.source.as_str(),
            content_hash
        ],
    )
    .map_err(AppError::from)?;
    Ok(next)
}

/// 业务行被服务层之外的路径（UI）改过时，有效 revision = 计数器 + 1。
/// `counter_at` 是计数器认为的业务更新时间；与当前业务 `updated_at` 不一致即视为外部修改。
pub fn effective_revision(counter: i64, counter_at: &str, business_at: &str) -> i64 {
    if counter_at.is_empty() || counter_at == business_at {
        counter
    } else {
        counter.saturating_add(1)
    }
}

// ── 活动日志 ─────────────────────────────────────────────────────

/// 审计条目：只放可复核元数据，绝不放正文/Token/绝对用户路径。
pub struct ActivityEntry<'a> {
    pub principal: &'a Principal,
    pub action: &'a str,
    pub resource_kind: &'a str,
    pub resource_id: &'a str,
    pub project_id: &'a str,
    pub request_id: &'a str,
    pub success: bool,
    pub error_code: &'a str,
    pub detail: &'a str,
    pub revision: Option<i64>,
    pub duration_ms: i64,
}

/// 写活动日志（best-effort：失败只告警，绝不让审计拖垮业务请求）。
pub fn log_activity(db: &Db, entry: &ActivityEntry<'_>) {
    if let Err(err) = db.with_conn(|conn| write_activity(conn, entry)) {
        tracing::warn!("Agent 活动日志写入失败: {err}");
    }
}

pub fn write_activity(conn: &Connection, entry: &ActivityEntry<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_activity_logs
           (id, agent_row_id, agent_id, actor_kind, interface, session_key, action,
            resource_kind, resource_id, project_id, request_id, success, error_code, detail,
            revision, duration_ms, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            entry.principal.agent_row_id,
            entry.principal.agent_id,
            entry.principal.actor_kind.as_str(),
            entry.principal.source.as_str(),
            entry.principal.session_key,
            entry.action,
            entry.resource_kind,
            entry.resource_id,
            entry.project_id,
            entry.request_id,
            if entry.success { 1 } else { 0 },
            entry.error_code,
            truncate(entry.detail, 500),
            entry.revision,
            entry.duration_ms,
            crate::agents::now_iso(),
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

fn truncate(raw: &str, max: usize) -> String {
    if raw.chars().count() <= max {
        return raw.to_string();
    }
    raw.chars().take(max).collect::<String>() + "…"
}

#[derive(Clone, Debug, Serialize)]
pub struct ActivityRecord {
    pub id: String,
    pub agent_id: String,
    pub actor_kind: String,
    pub interface: String,
    pub action: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub project_id: String,
    pub request_id: String,
    pub success: bool,
    pub error_code: String,
    pub detail: String,
    pub revision: Option<i64>,
    pub duration_ms: i64,
    pub created_at: String,
}

pub struct ActivityQuery {
    pub agent_id: Option<String>,
    pub interface: Option<String>,
    pub since: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

pub fn list_activity(db: &Db, query: &ActivityQuery) -> AppResult<(Vec<ActivityRecord>, Page)> {
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_activity_logs
                 WHERE (?1 IS NULL OR agent_id = ?1)
                   AND (?2 IS NULL OR interface = ?2)
                   AND (?3 IS NULL OR created_at >= ?3)",
                rusqlite::params![query.agent_id, query.interface, query.since],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, actor_kind, interface, action, resource_kind, resource_id,
                        project_id, request_id, success, error_code, detail, revision, duration_ms, created_at
                 FROM agent_activity_logs
                 WHERE (?1 IS NULL OR agent_id = ?1)
                   AND (?2 IS NULL OR interface = ?2)
                   AND (?3 IS NULL OR created_at >= ?3)
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?4 OFFSET ?5",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    query.agent_id,
                    query.interface,
                    query.since,
                    query.limit as i64,
                    query.offset as i64
                ],
                |r| {
                    Ok(ActivityRecord {
                        id: r.get(0)?,
                        agent_id: r.get(1)?,
                        actor_kind: r.get(2)?,
                        interface: r.get(3)?,
                        action: r.get(4)?,
                        resource_kind: r.get(5)?,
                        resource_id: r.get(6)?,
                        project_id: r.get(7)?,
                        request_id: r.get(8)?,
                        success: r.get::<_, i64>(9)? == 1,
                        error_code: r.get(10)?,
                        detail: r.get(11)?,
                        revision: r.get(12)?,
                        duration_ms: r.get(13)?,
                        created_at: r.get(14)?,
                    })
                },
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        let page = Page::new(query.limit, query.offset, total.max(0) as u32);
        Ok((out, page))
    })
}

// ── 决策 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Decision {
    pub id: String,
    pub project_id: String,
    pub project_kind: String,
    pub title: String,
    pub status: String,
    pub context: String,
    pub decision: String,
    pub consequences: String,
    pub alternatives: String,
    pub tags: Vec<String>,
    pub revision: i64,
    pub superseded_by: Option<String>,
    pub created_by: String,
    pub actor_kind: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DecisionInput {
    pub title: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_kind: Option<String>,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    pub consequences: String,
    #[serde(default)]
    pub alternatives: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub status: Option<String>,
}

const DECISION_COLS: &str = "id, project_id, project_kind, title, status, context, decision, \
     consequences, alternatives, tags, revision, superseded_by, created_by, actor_kind, source, \
     created_at, updated_at";

fn decision_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Decision> {
    Ok(Decision {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_kind: row.get(2)?,
        title: row.get(3)?,
        status: row.get(4)?,
        context: row.get(5)?,
        decision: row.get(6)?,
        consequences: row.get(7)?,
        alternatives: row.get(8)?,
        tags: parse_string_array(&row.get::<_, String>(9)?),
        revision: row.get(10)?,
        superseded_by: row.get(11)?,
        created_by: row.get(12)?,
        actor_kind: row.get(13)?,
        source: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub fn create_decision(db: &Db, principal: &Principal, input: DecisionInput) -> AppResult<Decision> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Validation("决策标题不能为空".into()));
    }
    check_text("title", &title, 200)?;
    check_text("context", &input.context, 8000)?;
    check_text("decision", &input.decision, 8000)?;
    check_text("consequences", &input.consequences, 4000)?;
    check_text("alternatives", &input.alternatives, 4000)?;
    check_items("tags", &input.tags)?;
    let status = input.status.as_deref().unwrap_or("proposed");
    if !matches!(status, "proposed" | "accepted" | "superseded" | "rejected") {
        return Err(AppError::Validation(format!(
            "非法决策状态: {status}（允许 proposed|accepted|superseded|rejected）"
        )));
    }
    let project_id = input.project_id.unwrap_or_default().trim().to_string();
    let project_kind = input.project_kind.unwrap_or_else(|| {
        if project_id.is_empty() {
            "none".to_string()
        } else {
            "planning".to_string()
        }
    });
    if !matches!(project_kind.as_str(), "none" | "planning" | "workspace") {
        return Err(AppError::Validation(format!(
            "非法 project_kind: {project_kind}（允许 none|planning|workspace）"
        )));
    }
    if project_kind == "none" && !project_id.is_empty() {
        return Err(AppError::Validation(
            "project_kind=none 时不允许 project_id".into(),
        ));
    }
    if project_kind != "none" && project_id.is_empty() {
        return Err(AppError::Validation(
            "指定 project_kind 时必须提供 project_id".into(),
        ));
    }
    let now = crate::agents::now_iso();
    let decision = db.with_transaction(|conn| {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO agent_decisions
               (id, project_id, project_kind, title, status, context, decision, consequences,
                alternatives, tags, revision, superseded_by, created_by, actor_kind, source,
                created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,NULL,?11,?12,?13,?14,?14)",
            rusqlite::params![
                id,
                project_id,
                project_kind,
                title,
                status,
                input.context,
                input.decision,
                input.consequences,
                input.alternatives,
                json_array(&input.tags),
                principal.label(),
                principal.actor_kind.as_str(),
                principal.source.as_str(),
                now,
            ],
        )
        .map_err(AppError::from)?;
        bump_revision(conn, "decision", &id, principal, &now, &String::new())?;
        conn.query_row(
            &format!("SELECT {DECISION_COLS} FROM agent_decisions WHERE id = ?1"),
            rusqlite::params![id],
            decision_from_row,
        )
        .map_err(AppError::from)
    })?;
    Ok(decision)
}

pub fn list_decisions(
    db: &Db,
    project_id: Option<&str>,
    status: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Decision>, Page)> {
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_decisions
                 WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR status = ?2)",
                rusqlite::params![project_id, status],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {DECISION_COLS} FROM agent_decisions
                 WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR status = ?2)
                 ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![project_id, status, limit as i64, offset as i64],
                decision_from_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

pub fn get_decision(db: &Db, id: &str) -> AppResult<Decision> {
    db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {DECISION_COLS} FROM agent_decisions WHERE id = ?1"),
            rusqlite::params![id],
            decision_from_row,
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("决策不存在: {id}")))
    })
}

// ── 交接 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Handoff {
    pub id: String,
    pub project_id: String,
    pub project_kind: String,
    pub task_id: Option<String>,
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub status: String,
    pub summary: String,
    pub completed_items: Vec<String>,
    pub pending_items: Vec<String>,
    pub decisions: Vec<Value>,
    pub files_changed: Vec<String>,
    pub risks: Vec<String>,
    pub next_steps: Vec<String>,
    pub revision: i64,
    pub accepted_at: Option<String>,
    pub rejected_at: Option<String>,
    pub rejection_reason: String,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct HandoffInput {
    pub to_agent_id: String,
    pub summary: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_kind: Option<String>,
    #[serde(default)]
    pub completed_items: Vec<String>,
    #[serde(default)]
    pub pending_items: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<Value>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub next_steps: Vec<String>,
}

const HANDOFF_COLS: &str = "id, project_id, project_kind, task_id, from_agent_id, to_agent_id, \
     status, summary, completed_items, pending_items, decisions, files_changed, risks, next_steps, \
     revision, accepted_at, rejected_at, rejection_reason, completed_at, created_at, updated_at";

fn handoff_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Handoff> {
    Ok(Handoff {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_kind: row.get(2)?,
        task_id: row.get(3)?,
        from_agent_id: row.get(4)?,
        to_agent_id: row.get(5)?,
        status: row.get(6)?,
        summary: row.get(7)?,
        completed_items: parse_string_array(&row.get::<_, String>(8)?),
        pending_items: parse_string_array(&row.get::<_, String>(9)?),
        decisions: parse_value_array(&row.get::<_, String>(10)?),
        files_changed: parse_string_array(&row.get::<_, String>(11)?),
        risks: parse_string_array(&row.get::<_, String>(12)?),
        next_steps: parse_string_array(&row.get::<_, String>(13)?),
        revision: row.get(14)?,
        accepted_at: row.get(15)?,
        rejected_at: row.get(16)?,
        rejection_reason: row.get(17)?,
        completed_at: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

fn handoff_select(conn: &Connection, id: &str) -> AppResult<Handoff> {
    conn.query_row(
        &format!("SELECT {HANDOFF_COLS} FROM agent_handoffs WHERE id = ?1"),
        rusqlite::params![id],
        handoff_from_row,
    )
    .optional()
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::NotFound(format!("交接不存在: {id}")))
}

pub fn list_handoffs(
    db: &Db,
    status: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Handoff>, Page)> {
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_handoffs
                 WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR project_id = ?2)",
                rusqlite::params![status, project_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {HANDOFF_COLS} FROM agent_handoffs
                 WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR project_id = ?2)
                 ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![status, project_id, limit as i64, offset as i64],
                handoff_from_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

pub fn get_handoff(db: &Db, id: &str) -> AppResult<Handoff> {
    db.with_read(|conn| handoff_select(conn, id))
}

/// 交接状态变更：只允许合法的下一步，并要求 `base_revision` 匹配。
pub fn set_handoff_status(
    db: &Db,
    principal: &Principal,
    id: &str,
    next: &str,
    base_revision: i64,
    reason: Option<&str>,
) -> AppResult<Handoff> {
    let allowed = matches!(next, "accepted" | "rejected" | "completed" | "cancelled");
    if !allowed {
        return Err(AppError::Validation(format!(
            "非法交接状态: {next}（允许 accepted|rejected|completed|cancelled）"
        )));
    }
    db.with_transaction(|conn| {
        let current = handoff_select(conn, id)?;
        if current.revision != base_revision {
            return Err(AppError::Conflict(format!(
                "交接版本已变化（当前 revision={}，提交 {}）",
                current.revision, base_revision
            )));
        }
        let legal = match (current.status.as_str(), next) {
            ("pending", "accepted") | ("pending", "rejected") | ("pending", "cancelled") => true,
            ("accepted", "completed") | ("accepted", "cancelled") => true,
            _ => false,
        };
        if !legal {
            return Err(AppError::Conflict(format!(
                "交接状态不允许从 {} 变为 {}",
                current.status, next
            )));
        }
        let now = crate::agents::now_iso();
        let next_revision = current.revision.saturating_add(1);
        conn.execute(
            "UPDATE agent_handoffs SET status = ?1, revision = ?2, updated_at = ?3,
               accepted_at = CASE WHEN ?1 = 'accepted' THEN ?3 ELSE accepted_at END,
               rejected_at = CASE WHEN ?1 = 'rejected' THEN ?3 ELSE rejected_at END,
               rejection_reason = CASE WHEN ?1 = 'rejected' THEN ?4 ELSE rejection_reason END,
               completed_at = CASE WHEN ?1 = 'completed' THEN ?3 ELSE completed_at END
             WHERE id = ?5",
            rusqlite::params![next, next_revision, now, reason.unwrap_or(""), id],
        )
        .map_err(AppError::from)?;
        bump_revision(conn, "handoff", id, principal, &now, &String::new())?;
        handoff_select(conn, id)
    })
}

// ── 工作报告 ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkReport {
    pub id: String,
    pub handoff_id: Option<String>,
    pub project_id: String,
    pub task_id: Option<String>,
    pub agent_id: String,
    pub summary: String,
    pub result: String,
    pub completed_items: Vec<String>,
    pub pending_items: Vec<String>,
    pub files_changed: Vec<String>,
    pub evidence: Vec<Value>,
    pub risks: Vec<String>,
    pub source: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReportInput {
    pub summary: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub handoff_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub completed_items: Vec<String>,
    #[serde(default)]
    pub pending_items: Vec<String>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<Value>,
    #[serde(default)]
    pub risks: Vec<String>,
}

const REPORT_COLS: &str = "id, handoff_id, project_id, task_id, agent_id, summary, result, \
     completed_items, pending_items, files_changed, evidence, risks, source, created_at";

fn report_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkReport> {
    Ok(WorkReport {
        id: row.get(0)?,
        handoff_id: row.get(1)?,
        project_id: row.get(2)?,
        task_id: row.get(3)?,
        agent_id: row.get(4)?,
        summary: row.get(5)?,
        result: row.get(6)?,
        completed_items: parse_string_array(&row.get::<_, String>(7)?),
        pending_items: parse_string_array(&row.get::<_, String>(8)?),
        files_changed: parse_string_array(&row.get::<_, String>(9)?),
        evidence: parse_value_array(&row.get::<_, String>(10)?),
        risks: parse_string_array(&row.get::<_, String>(11)?),
        source: row.get(12)?,
        created_at: row.get(13)?,
    })
}

pub fn list_reports(
    db: &Db,
    agent_id: Option<&str>,
    handoff_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<WorkReport>, Page)> {
    let agent = agent_id.unwrap_or("");
    let handoff = handoff_id.unwrap_or("");
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_work_reports
                 WHERE (?1 = '' OR agent_id = ?1) AND (?2 = '' OR handoff_id = ?2)",
                rusqlite::params![agent, handoff],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {REPORT_COLS} FROM agent_work_reports
                 WHERE (?1 = '' OR agent_id = ?1) AND (?2 = '' OR handoff_id = ?2)
                 ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![agent, handoff, limit as i64, offset as i64],
                report_from_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

pub fn get_report(db: &Db, id: &str) -> AppResult<WorkReport> {
    db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {REPORT_COLS} FROM agent_work_reports WHERE id = ?1"),
            rusqlite::params![id],
            report_from_row,
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("工作报告不存在: {id}")))
    })
}

// ── 同步事件 / 冲突 ──────────────────────────────────────────────

pub struct SyncEvent<'a> {
    pub workspace_row_id: &'a str,
    pub direction: &'a str,
    pub event_kind: &'a str,
    pub rel_path: &'a str,
    pub resource_kind: &'a str,
    pub resource_id: &'a str,
    pub revision: Option<i64>,
    pub status: &'a str,
    pub message: &'a str,
    pub content_hash: &'a str,
    pub request_id: &'a str,
}

pub fn record_sync_event(conn: &Connection, event: &SyncEvent<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sync_events
           (id, workspace_row_id, direction, event_kind, rel_path, resource_kind, resource_id,
            revision, status, message, content_hash, request_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            event.workspace_row_id,
            event.direction,
            event.event_kind,
            event.rel_path,
            event.resource_kind,
            event.resource_id,
            event.revision,
            event.status,
            truncate(event.message, 500),
            event.content_hash,
            event.request_id,
            crate::agents::now_iso(),
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncEventRecord {
    pub id: String,
    pub direction: String,
    pub event_kind: String,
    pub rel_path: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub revision: Option<i64>,
    pub status: String,
    pub message: String,
    pub content_hash: String,
    pub created_at: String,
}

pub fn list_sync_events(
    db: &Db,
    workspace_row_id: &str,
    limit: u32,
) -> AppResult<Vec<SyncEventRecord>> {
    db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, direction, event_kind, rel_path, resource_kind, resource_id,
                        revision, status, message, content_hash, created_at
                 FROM agent_sync_events WHERE workspace_row_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![workspace_row_id, limit as i64], |r| {
                Ok(SyncEventRecord {
                    id: r.get(0)?,
                    direction: r.get(1)?,
                    event_kind: r.get(2)?,
                    rel_path: r.get(3)?,
                    resource_kind: r.get(4)?,
                    resource_id: r.get(5)?,
                    revision: r.get(6)?,
                    status: r.get(7)?,
                    message: r.get(8)?,
                    content_hash: r.get(9)?,
                    created_at: r.get(10)?,
                })
            })
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncConflict {
    pub id: String,
    pub rel_path: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub db_revision: i64,
    pub file_revision: i64,
    pub db_hash: String,
    pub file_hash: String,
    pub status: String,
    pub resolution: String,
    pub detail_json: String,
    pub detected_at: String,
    pub resolved_at: Option<String>,
}

const CONFLICT_COLS: &str = "id, rel_path, resource_kind, resource_id, db_revision, file_revision, \
     db_hash, file_hash, status, resolution, detail_json, detected_at, resolved_at";

fn conflict_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncConflict> {
    Ok(SyncConflict {
        id: row.get(0)?,
        rel_path: row.get(1)?,
        resource_kind: row.get(2)?,
        resource_id: row.get(3)?,
        db_revision: row.get(4)?,
        file_revision: row.get(5)?,
        db_hash: row.get(6)?,
        file_hash: row.get(7)?,
        status: row.get(8)?,
        resolution: row.get(9)?,
        detail_json: row.get(10)?,
        detected_at: row.get(11)?,
        resolved_at: row.get(12)?,
    })
}

pub fn list_conflicts(db: &Db, workspace_row_id: &str) -> AppResult<Vec<SyncConflict>> {
    db.with_read(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CONFLICT_COLS} FROM agent_sync_conflicts
                 WHERE workspace_row_id = ?1 ORDER BY detected_at DESC"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![workspace_row_id], conflict_from_row)
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn upsert_conflict(
    conn: &Connection,
    workspace_row_id: &str,
    conflict: &SyncConflict,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sync_conflicts
           (id, workspace_row_id, rel_path, resource_kind, resource_id, db_revision, file_revision,
            db_hash, file_hash, status, resolution, detail_json, detected_at, resolved_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'open','',?10,?11,NULL)
         ON CONFLICT(workspace_row_id, rel_path) DO UPDATE SET
           resource_kind = excluded.resource_kind,
           resource_id = excluded.resource_id,
           db_revision = excluded.db_revision,
           file_revision = excluded.file_revision,
           db_hash = excluded.db_hash,
           file_hash = excluded.file_hash,
           status = 'open',
           resolution = '',
           detail_json = excluded.detail_json,
           detected_at = excluded.detected_at,
           resolved_at = NULL",
        rusqlite::params![
            conflict.id,
            workspace_row_id,
            conflict.rel_path,
            conflict.resource_kind,
            conflict.resource_id,
            conflict.db_revision,
            conflict.file_revision,
            conflict.db_hash,
            conflict.file_hash,
            conflict.detail_json,
            conflict.detected_at,
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

pub fn get_conflict(db: &Db, id: &str) -> AppResult<SyncConflict> {
    db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {CONFLICT_COLS} FROM agent_sync_conflicts WHERE id = ?1"),
            rusqlite::params![id],
            conflict_from_row,
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("冲突不存在: {id}")))
    })
}

// ── 上下文访问 ───────────────────────────────────────────────────

pub struct ContextAccess<'a> {
    pub principal: &'a Principal,
    pub purpose: &'a str,
    pub project_id: &'a str,
    pub task_id: &'a str,
    pub format: &'a str,
    pub budget_tokens: u32,
    pub item_count: u32,
    pub estimated_tokens: u32,
    pub request_id: &'a str,
}

pub fn record_context_access(conn: &Connection, entry: &ContextAccess<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_context_access_logs
           (id, agent_row_id, agent_id, interface, purpose, project_id, task_id, format,
            budget_tokens, item_count, estimated_tokens, request_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            entry.principal.agent_row_id,
            entry.principal.agent_id,
            entry.principal.source.as_str(),
            entry.purpose,
            entry.project_id,
            entry.task_id,
            entry.format,
            entry.budget_tokens as i64,
            entry.item_count as i64,
            entry.estimated_tokens as i64,
            entry.request_id,
            crate::agents::now_iso(),
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

// ── REST 幂等缓存 ────────────────────────────────────────────────

pub fn cache_lookup(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
) -> AppResult<Option<(String, u16)>> {
    db.with_read(|conn| {
        let row = conn
            .query_row(
                "SELECT response_json, status_code FROM agent_request_cache
                 WHERE agent_row_id = ?1 AND interface = ?2 AND idempotency_key = ?3
                   AND expires_at > strftime('%Y-%m-%dT%H:%M:%S','now')",
                rusqlite::params![agent_row_id, interface, key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u16)),
            )
            .optional()
            .map_err(AppError::from)?;
        Ok(row)
    })
}

pub fn cache_store(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
    request_hash: &str,
    response_json: &str,
    status_code: u16,
) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO agent_request_cache
               (id, agent_row_id, interface, idempotency_key, request_hash, response_json,
                status_code, created_at, expires_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8, strftime('%Y-%m-%dT%H:%M:%S','now','+24 hours'))",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                agent_row_id,
                interface,
                key,
                request_hash,
                response_json,
                status_code as i64,
                crate::agents::now_iso(),
            ],
        )
        .map_err(AppError::from)?;
        Ok(())
    })
}

/// 按时间裁剪运维日志（活动/同步事件/幂等缓存）。单次最多 5000 行，失败不影响启动。
pub fn prune(db: &Db) -> AppResult<u32> {
    let mut removed = 0u32;
    db.with_conn(|conn| {
        removed += conn
            .execute(
                "DELETE FROM agent_request_cache
                 WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%S','now')",
                [],
            )
            .unwrap_or(0) as u32;
        removed += conn
            .execute(
                "DELETE FROM agent_activity_logs WHERE id IN (
                   SELECT id FROM agent_activity_logs
                   WHERE created_at < strftime('%Y-%m-%dT%H:%M:%S','now','-90 days')
                   ORDER BY created_at LIMIT 5000)",
                [],
            )
            .unwrap_or(0) as u32;
        removed += conn
            .execute(
                "DELETE FROM agent_sync_events WHERE id IN (
                   SELECT id FROM agent_sync_events
                   WHERE created_at < strftime('%Y-%m-%dT%H:%M:%S','now','-90 days')
                   ORDER BY created_at LIMIT 5000)",
                [],
            )
            .unwrap_or(0) as u32;
        Ok(())
    })?;
    Ok(removed)
}

/// 任意来源的 `Source` 标签（供 UI 展示/导出）。
pub fn source_label(source: Source) -> &'static str {
    source.as_str()
}

/// 角色标签（供 UI 展示）。
pub fn actor_label(kind: ActorKind) -> &'static str {
    kind.as_str()
}
