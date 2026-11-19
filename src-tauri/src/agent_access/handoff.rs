//! Agent 交接（handoff）与工作报告。
//!
//! 交接不是一段自由文本：必须有来源、目标、关联项目/任务、状态机、版本与时间。
//! 状态迁移复用 `store::set_handoff_status` 的合法迁移表，并强制 `base_revision` 校验，
//! 因此两个 Agent 不可能无约束地同时覆盖同一条交接。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions as perms;
use super::{store, validation, Page, Principal};

#[derive(Clone, Debug, Serialize)]
pub struct HandoffCreated {
    pub handoff: store::Handoff,
    pub revision: i64,
}

fn resolve_target_agent(db: &Db, target: &str) -> AppResult<(Option<String>, String)> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err(validation("to_agent_id 不能为空"));
    }
    db.with_read(|conn| {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT id, agent_id FROM mcp_agents
                 WHERE (id = ?1 OR agent_id = ?1) AND revoked_at IS NULL
                 ORDER BY created_at LIMIT 1",
                rusqlite::params![trimmed],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        row.map_or_else(
            || {
                Err(AppError::NotFound(format!(
                    "目标 Agent 不存在或已撤销: {trimmed}（请先在 UI 注册）"
                )))
            },
            |(row_id, agent_id)| Ok((Some(row_id), agent_id)),
        )
    })
}

fn principal_agent_snapshot(principal: &Principal) -> (Option<String>, String) {
    let agent_id = if principal.agent_id.trim().is_empty() {
        "local".to_string()
    } else {
        principal.agent_id.clone()
    };
    (principal.agent_row_id.clone(), agent_id)
}

fn project_kind_for(db: &Db, project_id: &str) -> AppResult<&'static str> {
    if project_id.trim().is_empty() {
        return Ok("none");
    }
    let kind = db.with_read(|conn| perms::project_exists(conn, project_id))?;
    kind.ok_or_else(|| AppError::NotFound(format!("项目不存在: {project_id}")))
}

pub fn create_handoff(
    db: &Db,
    principal: &Principal,
    input: store::HandoffInput,
) -> AppResult<HandoffCreated> {
    let summary = input.summary.trim().to_string();
    if summary.is_empty() {
        return Err(validation("交接摘要不能为空"));
    }
    store::check_text("summary", &summary, 2000)?;
    for (field, items) in [
        ("completed_items", &input.completed_items),
        ("pending_items", &input.pending_items),
        ("files_changed", &input.files_changed),
        ("risks", &input.risks),
        ("next_steps", &input.next_steps),
    ] {
        store::check_items(field, items)?;
    }
    let project_id = input.project_id.unwrap_or_default();
    let project_kind = match input.project_kind.as_deref() {
        Some("planning") | Some("workspace") => project_kind_for(db, &project_id)?,
        _ => project_kind_for(db, &project_id)?,
    };
    perms::require(db, principal, Capability::HandoffsWrite, &project_id)?;
    let target = resolve_target_agent(db, &input.to_agent_id)?;
    let (from_row, from_id) = principal_agent_snapshot(principal);
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::agents::now_iso();
    let revision = db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO agent_handoffs
               (id, project_id, project_kind, task_id, from_agent_row_id, from_agent_id,
                to_agent_row_id, to_agent_id, status, summary, completed_items, pending_items,
                decisions, files_changed, risks, next_steps, revision, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9,?10,?11,?12,?13,?14,?15,1,?16,?16)",
            rusqlite::params![
                id,
                project_id,
                project_kind,
                input.task_id,
                from_row,
                from_id,
                target.0,
                target.1,
                summary,
                store::json_array(&input.completed_items),
                store::json_array(&input.pending_items),
                serde_json::to_string(&input.decisions)?,
                store::json_array(&input.files_changed),
                store::json_array(&input.risks),
                store::json_array(&input.next_steps),
                now,
            ],
        )
        .map_err(AppError::from)?;
        store::bump_revision(conn, "handoff", &id, principal, &now, "")
    })?;
    let handoff = store::get_handoff(db, &id)?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "handoff.create",
            resource_kind: "handoff",
            resource_id: &id,
            project_id: &handoff.project_id,
            request_id: "",
            success: true,
            error_code: "",
            detail: "创建 Agent 交接",
            revision: Some(revision),
            duration_ms: 0,
        },
    );
    Ok(HandoffCreated { handoff, revision })
}

pub fn list_handoffs(
    db: &Db,
    principal: &Principal,
    status: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<store::Handoff>, Page)> {
    match (principal.is_agent(), project_id) {
        (true, Some(pid)) => perms::require(db, principal, Capability::HandoffsRead, pid)?,
        (true, None) => perms::require(db, principal, Capability::HandoffsRead, "")?,
        _ => {}
    }
    if let Some(status) = status {
        if !matches!(status, "pending" | "accepted" | "rejected" | "completed" | "cancelled") {
            return Err(validation(format!("非法交接状态: {status}")));
        }
    }
    store::list_handoffs(db, status, project_id, limit, offset)
}

pub fn get_handoff(db: &Db, principal: &Principal, id: &str) -> AppResult<store::Handoff> {
    let handoff = store::get_handoff(db, id)?;
    ensure_handoff_access(db, principal, &handoff, Capability::HandoffsRead)?;
    Ok(handoff)
}

/// 交接自身的项目范围校验。项目为空的交接只对全局授权可见。
fn ensure_handoff_access(
    db: &Db,
    principal: &Principal,
    handoff: &store::Handoff,
    capability: Capability,
) -> AppResult<()> {
    match principal.identity {
        super::Identity::RegisteredAgent => {
            perms::require(db, principal, capability, &handoff.project_id)
        }
        _ => Ok(()),
    }
}

fn transition(
    db: &Db,
    principal: &Principal,
    id: &str,
    next: &str,
    base_revision: i64,
    reason: Option<&str>,
) -> AppResult<store::Handoff> {
    let current = store::get_handoff(db, id)?;
    ensure_handoff_access(db, principal, &current, Capability::HandoffsWrite)?;
    authorize_handoff_transition(principal, &current, next)?;
    let handoff = store::set_handoff_status(db, principal, id, next, base_revision, reason)?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: match next {
                "accepted" => "handoff.accept",
                "rejected" => "handoff.reject",
                "completed" => "handoff.complete",
                _ => "handoff.cancel",
            },
            resource_kind: "handoff",
            resource_id: id,
            project_id: &handoff.project_id,
            request_id: "",
            success: true,
            error_code: "",
            detail: &format!("交接状态 → {next}"),
            revision: Some(handoff.revision),
            duration_ms: 0,
        },
    );
    Ok(handoff)
}

/// 交接状态迁移的操作者约束。必须与状态机同时生效：
/// - pending → accepted / rejected：只能目标 Agent（本机协调者可代为处理）；
/// - accepted → completed：目标 Agent；
/// - cancelled：创建方或本机协调者；
/// - 其他 Agent 一律拒绝，不论其是否持有 HandoffsWrite。
pub fn authorize_handoff_transition(
    principal: &Principal,
    handoff: &store::Handoff,
    next: &str,
) -> AppResult<()> {
    if principal.is_trusted_local() {
        return Ok(());
    }
    if !principal.is_agent() {
        return Err(AppError::Forbidden("当前身份不能变更交接状态".into()));
    }
    let me = principal.agent_id.trim();
    let is_target = !me.is_empty() && handoff.to_agent_id == me;
    let is_creator = !me.is_empty() && handoff.from_agent_id == me;
    match next {
        "accepted" | "rejected" => {
            if is_target {
                Ok(())
            } else {
                Err(AppError::Forbidden(format!(
                    "该交接目标为 {}，当前 Agent 无权接收或拒绝",
                    handoff.to_agent_id
                )))
            }
        }
        "completed" => {
            if is_target {
                Ok(())
            } else {
                Err(AppError::Forbidden(format!(
                    "只有目标 Agent {} 可以完成该交接",
                    handoff.to_agent_id
                )))
            }
        }
        "cancelled" => {
            if is_creator {
                Ok(())
            } else {
                Err(AppError::Forbidden("只有创建方可以取消该交接".into()))
            }
        }
        other => Err(validation(format!("非法交接状态: {other}"))),
    }
}

pub fn accept_handoff(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: i64,
) -> AppResult<store::Handoff> {
    // 目标身份校验统一在 `transition` → `authorize_handoff_transition`。
    transition(db, principal, id, "accepted", base_revision, None)
}

pub fn reject_handoff(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: i64,
    reason: &str,
) -> AppResult<store::Handoff> {
    store::check_text("reason", reason, 500)?;
    transition(db, principal, id, "rejected", base_revision, Some(reason))
}

pub fn complete_handoff(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: i64,
) -> AppResult<store::Handoff> {
    transition(db, principal, id, "completed", base_revision, None)
}

// ── 工作报告 ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct ReportOut {
    pub report: store::WorkReport,
    pub revision: i64,
}

pub fn create_report(
    db: &Db,
    principal: &Principal,
    input: store::ReportInput,
) -> AppResult<ReportOut> {
    let summary = input.summary.trim().to_string();
    if summary.is_empty() {
        return Err(validation("报告摘要不能为空"));
    }
    store::check_text("summary", &summary, 4000)?;
    for (field, items) in [
        ("completed_items", &input.completed_items),
        ("pending_items", &input.pending_items),
        ("files_changed", &input.files_changed),
        ("risks", &input.risks),
    ] {
        store::check_items(field, items)?;
    }
    if input.evidence.len() > 50 {
        return Err(validation("evidence 最多 50 条"));
    }
    let result = input.result.unwrap_or_else(|| "completed".into());
    if !matches!(result.as_str(), "completed" | "partial" | "blocked" | "failed") {
        return Err(validation(format!("非法 result: {result}")));
    }
    let handoff = match input.handoff_id.as_deref() {
        Some(handoff_id) => {
            let handoff = store::get_handoff(db, handoff_id)?;
            ensure_handoff_access(db, principal, &handoff, Capability::HandoffsWrite)?;
            Some(handoff)
        }
        None => None,
    };
    let project_id = input.project_id.unwrap_or_default();
    if !project_id.is_empty() {
        project_kind_for(db, &project_id)?;
    }
    if let Some(handoff) = &handoff {
        if !handoff.project_id.is_empty()
            && !project_id.is_empty()
            && handoff.project_id != project_id
        {
            return Err(validation(format!(
                "报告项目 {} 与交接项目 {} 不一致",
                project_id, handoff.project_id
            )));
        }
    }
    // 报告必须归属于交接的项目，避免用空项目绕过范围限制。
    let effective_project = if project_id.is_empty() {
        handoff
            .as_ref()
            .map(|item| item.project_id.clone())
            .unwrap_or_default()
    } else {
        project_id.clone()
    };
    perms::require(db, principal, Capability::HandoffsWrite, &effective_project)?;
    let (agent_row, agent_id) = principal_agent_snapshot(principal);
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::agents::now_iso();
    let source = super::store::source_label(principal.source);
    let revision = db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO agent_work_reports
               (id, handoff_id, project_id, task_id, agent_row_id, agent_id, summary, result,
                completed_items, pending_items, files_changed, evidence, risks, source, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                id,
                input.handoff_id,
                project_id,
                input.task_id,
                agent_row,
                agent_id,
                summary,
                result,
                store::json_array(&input.completed_items),
                store::json_array(&input.pending_items),
                store::json_array(&input.files_changed),
                serde_json::to_string(&input.evidence)?,
                store::json_array(&input.risks),
                source,
                now,
            ],
        )
        .map_err(AppError::from)?;
        store::bump_revision(conn, "report", &id, principal, &now, "")
    })?;
    let report = store::get_report(db, &id)?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "report.create",
            resource_kind: "report",
            resource_id: &id,
            project_id: &project_id,
            request_id: "",
            success: true,
            error_code: "",
            detail: "提交工作报告",
            revision: Some(revision),
            duration_ms: 0,
        },
    );
    Ok(ReportOut { report, revision })
}

pub fn list_reports(
    db: &Db,
    principal: &Principal,
    agent_id: Option<&str>,
    handoff_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<store::WorkReport>, Page)> {
    if let Some(handoff_id) = handoff_id {
        let handoff = store::get_handoff(db, handoff_id)?;
        ensure_handoff_access(db, principal, &handoff, Capability::HandoffsRead)?;
    } else {
        perms::require(db, principal, Capability::HandoffsRead, "")?;
    }
    store::list_reports(db, agent_id, handoff_id, limit, offset)
}

pub fn get_report(db: &Db, principal: &Principal, id: &str) -> AppResult<store::WorkReport> {
    let report = store::get_report(db, id)?;
    if let Some(handoff_id) = report.handoff_id.as_deref() {
        let handoff = store::get_handoff(db, handoff_id)?;
        ensure_handoff_access(db, principal, &handoff, Capability::HandoffsRead)?;
    } else {
        perms::require(db, principal, Capability::HandoffsRead, &report.project_id)?;
    }
    Ok(report)
}

// ── Agent 注册表 ─────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct AgentInfo {
    pub row_id: String,
    pub agent_id: String,
    pub display_name: String,
    pub vendor: String,
    pub scope: String,
    pub revoked: bool,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

pub fn list_agents(db: &Db, principal: &Principal) -> AppResult<Vec<AgentInfo>> {
    perms::require(db, principal, Capability::HandoffsRead, "")?;
    let agents = crate::mcp::auth::list_agents(db)?;
    let rows = db.with_read(|conn| {
        let mut stmt = conn
            .prepare("SELECT id, vendor FROM mcp_agents")
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok::<_, AppError>(out)
    })?;
    let vendor_of = |id: &str| {
        rows.iter()
            .find(|(row_id, _)| row_id == id)
            .map(|(_, vendor)| vendor.clone())
            .unwrap_or_default()
    };
    Ok(agents
        .into_iter()
        .map(|a| AgentInfo {
            row_id: a.id.clone(),
            agent_id: a.agent_id.clone(),
            display_name: a.display_name.clone(),
            vendor: vendor_of(&a.id),
            scope: a.scope,
            revoked: a.revoked_at.is_some(),
            created_at: a.created_at.clone(),
            last_seen_at: a.last_seen_at.clone(),
        })
        .collect())
}

/// Agent 活动（统一日志，四入口共用）。
pub fn activity(
    db: &Db,
    principal: &Principal,
    agent_id: Option<&str>,
    interface: Option<&str>,
    since: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<store::ActivityRecord>, Page)> {
    perms::require_any_read(db, principal)?;
    let query = store::ActivityQuery {
        agent_id: agent_id.map(str::to_string),
        interface: interface.map(str::to_string),
        since: since.map(str::to_string),
        limit,
        offset,
    };
    store::list_activity(db, &query)
}

/// 交接摘要视图：给 UI 与 CLI 的 `agent handoff list` 共用。
#[derive(Clone, Debug, Serialize)]
pub struct HandoffSummary {
    pub id: String,
    pub project_id: String,
    pub task_id: Option<String>,
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub status: String,
    pub summary: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn summarize(handoffs: Vec<store::Handoff>) -> Vec<HandoffSummary> {
    handoffs
        .into_iter()
        .map(|h| HandoffSummary {
            id: h.id,
            project_id: h.project_id,
            task_id: h.task_id,
            from_agent_id: h.from_agent_id,
            to_agent_id: h.to_agent_id,
            status: h.status,
            summary: h.summary,
            revision: h.revision,
            created_at: h.created_at,
            updated_at: h.updated_at,
        })
        .collect()
}

/// 交接里的 `decisions` 是结构化数组，读取时保持原样（不解析成文本）。
pub fn decision_refs(handoff: &store::Handoff) -> &[Value] {
    &handoff.decisions
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReportQuery {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub handoff_id: Option<String>,
}
