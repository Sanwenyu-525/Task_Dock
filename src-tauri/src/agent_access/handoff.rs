//! Agent 交接（handoff）与工作报告。
//!
//! 交接不是一段自由文本：必须有来源、目标、关联项目/任务、状态机、版本与时间。
//! 状态迁移由「合法迁移表 + revision 条件更新」共同约束：两个 Agent 不能同时
//! 改写同一条交接，失败的操作不推进 revision，每次状态变化都在同一事务内留审计。
//!
//! 工作报告是**追加式**记录：报告必须挂在一条真实存在的交接上，项目归属由
//! `agent_handoffs.project_id` 推导（载荷声明的项目不能伪造归属），提交者必须
//! 同时通过身份匹配、能力与项目范围三道校验。
//!
//! 报告的语义是「做过什么」（`result`：completed/partial/blocked/failed），
//! 与决策记录的「已确认」（`agent_decisions.status`：proposed/accepted/…）
//! **不是一回事**：报告永远不能被当成已确认决策使用。

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions as perms;
use super::{store, validation, Identity, Page, Principal};

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

// ── 交接创建 ─────────────────────────────────────────────────────

pub fn create_handoff(
    db: &Db,
    principal: &Principal,
    input: store::HandoffInput,
) -> AppResult<HandoffCreated> {
    create_handoff_guarded(db, principal, input, &store::NoGuard)
}

/// 带**事务内守卫**的交接写入（v82 文件导入用）。
///
/// 守卫（`store::WriteGuard`）与业务写入在**同一个写事务**内：事务开始时
/// `check(conn)` 校验执行权，业务写入成功后 `complete(conn)` 收尾。任一步失败
/// 都会让整个事务回滚，不会留下「交接已写入但租约未完成」的窗口。
pub fn create_handoff_guarded(
    db: &Db,
    principal: &Principal,
    input: store::HandoffInput,
    guard: &dyn store::WriteGuard,
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
        guard.check(conn)?;
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
        let revision = store::bump_revision(conn, "handoff", &id, principal, &now, "")?;
        guard.record_operation(conn, "handoff", &id)?;
        guard.complete(conn)?;
        Ok(revision)
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
///
/// 已注册 Agent 按「能力 + 项目范围」判定（`resource_id = ''` 的全局授权可覆盖
/// 任何项目，项目授权只能覆盖同一项目）。文件导入同样要过能力与项目范围两道
/// 校验：读能力缺失的导入授权不能借交接详情/报告读取越权。
fn ensure_handoff_access(
    db: &Db,
    principal: &Principal,
    handoff: &store::Handoff,
    capability: Capability,
) -> AppResult<()> {
    perms::require(db, principal, capability, &handoff.project_id)?;
    if principal.identity == Identity::FileImport {
        if let Some(grant) = principal.import.as_ref() {
            perms::check_import_project_scope(grant, &handoff.project_id)?;
        }
    }
    Ok(())
}

// ── 状态机 ───────────────────────────────────────────────────────

/// 合法状态迁移表。终态（completed / rejected / cancelled）没有任何出边，
/// 因此终态不能被重新打开；`pending` 也不能直接跳到 `completed`。
fn legal_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("pending", "accepted")
            | ("pending", "rejected")
            | ("pending", "cancelled")
            | ("accepted", "completed")
            | ("accepted", "cancelled")
    )
}

/// 状态迁移：条件更新 + 受影响行数判断。
///
/// 并发控制依赖 `WHERE id = ? AND revision = ?` 的**条件更新**：两个 Agent 用
/// 同一个 `base_revision` 提交时，只有一个能命中行（受影响行数为 1），另一个
/// 必然得到 0 行并被判为版本冲突。revision 校验与写入在同一写事务内完成，
/// 失败的操作不会推进 revision；审计与状态变更同事务，状态变了就没有
/// 「没有审计」的可能。
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
    let now = crate::agents::now_iso();
    let action = match next {
        "accepted" => "handoff.accept",
        "rejected" => "handoff.reject",
        "completed" => "handoff.complete",
        _ => "handoff.cancel",
    };
    let detail = format!("交接状态 → {next}");
    db.with_transaction(|conn| {
        // 事务内重读状态与版本：事务外的快照只是预检，这里才是判定依据。
        let (status, revision): (String, i64) = conn.query_row(
            "SELECT status, revision FROM agent_handoffs WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if revision != base_revision {
            return Err(AppError::Conflict(format!(
                "交接版本已变化（当前 revision={revision}，提交 {base_revision}）"
            )));
        }
        if !legal_transition(&status, next) {
            return Err(AppError::Conflict(format!(
                "交接状态不允许从 {status} 变为 {next}"
            )));
        }
        let next_revision = revision.saturating_add(1);
        // 条件更新：revision 必须仍然等于提交时的版本，否则本次不生效。
        let affected = conn.execute(
            "UPDATE agent_handoffs SET status = ?1, revision = ?2, updated_at = ?3,
               accepted_at = CASE WHEN ?1 = 'accepted' THEN ?3 ELSE accepted_at END,
               rejected_at = CASE WHEN ?1 = 'rejected' THEN ?3 ELSE rejected_at END,
               rejection_reason = CASE WHEN ?1 = 'rejected' THEN ?4 ELSE rejection_reason END,
               completed_at = CASE WHEN ?1 = 'completed' THEN ?3 ELSE completed_at END
             WHERE id = ?5 AND revision = ?6",
            rusqlite::params![next, next_revision, now, reason.unwrap_or(""), id, base_revision],
        )?;
        if affected != 1 {
            return Err(AppError::Conflict(
                "交接已被其他执行者更新，请重新读取后重试".into(),
            ));
        }
        store::bump_revision(conn, "handoff", id, principal, &now, "")?;
        // 审计与状态变更同事务：状态变了却没有审计，等于没有审计。
        store::write_activity(
            conn,
            &store::ActivityEntry {
                principal,
                action,
                resource_kind: "handoff",
                resource_id: id,
                project_id: &current.project_id,
                request_id: "",
                success: true,
                error_code: "",
                detail: &detail,
                revision: Some(next_revision),
                duration_ms: 0,
            },
        )?;
        Ok(())
    })?;
    store::get_handoff(db, id)
}

/// 本机协调者：可信本机用户（UI / 未设 token 的本机 CLI）。
///
/// 内部维护身份（`SystemInternal`）不是协调者，不得代替 Agent 接收/拒绝/取消交接。
fn is_local_coordinator(principal: &Principal) -> bool {
    matches!(principal.identity, Identity::LocalHuman)
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
    // 目标状态必须先合法：本机协调者也不能把交接改成未知状态。
    if !matches!(next, "accepted" | "rejected" | "completed" | "cancelled") {
        return Err(validation(format!("非法交接状态: {next}")));
    }
    if is_local_coordinator(principal) {
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

/// 取消交接：只有创建方或本机协调者可以取消。
pub fn cancel_handoff(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: i64,
    reason: &str,
) -> AppResult<store::Handoff> {
    store::check_text("reason", reason, 500)?;
    transition(db, principal, id, "cancelled", base_revision, Some(reason))
}

// ── 工作报告 ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct ReportOut {
    pub report: store::WorkReport,
    pub revision: i64,
}

/// 报告必须挂在一条**真实存在**的交接上：项目归属由交接推导，
/// 载荷声明的项目只做一致性校验，声明为空不代表「全局」。
fn resolve_report_handoff(db: &Db, handoff_id: Option<&str>) -> AppResult<store::Handoff> {
    let raw = handoff_id.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return Err(validation("报告必须关联交接：handoff_id 不能为空"));
    }
    store::get_handoff(db, raw)
}

/// 报告项目 = 交接项目。载荷声明的项目不一致时直接拒绝（不静默改写归属）。
fn derive_report_project(handoff: &store::Handoff, declared: Option<&str>) -> AppResult<String> {
    let declared = declared.map(str::trim).unwrap_or("");
    if !declared.is_empty() && declared != handoff.project_id {
        if handoff.project_id.is_empty() {
            return Err(validation(format!(
                "交接没有项目归属，报告不得声明项目 {declared}"
            )));
        }
        return Err(validation(format!(
            "报告项目 {declared} 与交接项目 {} 不一致（报告项目由交接推导）",
            handoff.project_id
        )));
    }
    Ok(handoff.project_id.clone())
}

/// 报告提交者的身份校验：登记身份必须与库内记录一致（防冒用/防已撤销）。
///
/// 「是不是注册 Agent」不是结论：这里核对的是**身份匹配**——行 ID 存在、未撤销、
/// 且声明的 `agent_id` 与登记记录一致。能力与项目范围由后面的检查负责。
fn verify_registered_agent(db: &Db, principal: &Principal) -> AppResult<()> {
    let row_id = principal
        .agent_row_id
        .as_deref()
        .ok_or_else(|| AppError::Forbidden("缺少 Agent 身份".into()))?;
    let registered = db.with_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT agent_id FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
                rusqlite::params![row_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })?;
    let Some(registered) = registered else {
        return Err(AppError::Forbidden("Agent 不存在或已被撤销".into()));
    };
    if principal.agent_id.trim() != registered {
        return Err(AppError::Forbidden(
            "Agent 身份与授权记录不一致，拒绝写入".into(),
        ));
    }
    Ok(())
}

/// 直接调用报告接口的 Agent 必须是该交接的参与方（发起方或目标方）：
/// 报告陈述的是「这条交接上做过什么」，与交接无关的 Agent 无权写入。
///
/// 文件导入通道不走这条规则：它的授权来自导入授权 + 绑定 Agent 的真实授权
/// （由 `perms::require` 内部复核），且文件自称的身份本身不可信。
fn ensure_report_participant(principal: &Principal, handoff: &store::Handoff) -> AppResult<()> {
    let me = principal.agent_id.trim();
    if me.is_empty() {
        return Err(AppError::Forbidden("缺少 Agent 身份".into()));
    }
    if handoff.to_agent_id != me && handoff.from_agent_id != me {
        return Err(AppError::Forbidden(format!(
            "该交接参与方为 {} → {}，当前 Agent 无权为其提交报告",
            handoff.from_agent_id, handoff.to_agent_id
        )));
    }
    Ok(())
}

/// 报告写入的完整授权：身份匹配 + 能力 + 项目范围，三者缺一不可。
///
/// - **身份匹配**：注册 Agent 必须与库内登记一致（未撤销、agent_id 相符）；
///   直接调用接口时还必须是该交接的参与方；
/// - **能力**：必须持有 `handoffs.write`；
/// - **项目范围**：按交接真实归属的项目判定——全局授权可覆盖任何项目，
///   项目授权只能覆盖同一项目；无项目（全局）交接只接受全局授权。
fn ensure_report_access(
    db: &Db,
    principal: &Principal,
    handoff: &store::Handoff,
) -> AppResult<()> {
    match principal.identity {
        Identity::RegisteredAgent => {
            verify_registered_agent(db, principal)?;
            if principal.import.is_none() {
                ensure_report_participant(principal, handoff)?;
            }
            perms::require(db, principal, Capability::HandoffsWrite, &handoff.project_id)?;
        }
        Identity::FileImport => {
            // 文件导入：能力集合来自导入授权；项目范围同样按交接真实归属判定。
            perms::require(db, principal, Capability::HandoffsWrite, &handoff.project_id)?;
            if let Some(grant) = principal.import.as_ref() {
                perms::check_import_project_scope(grant, &handoff.project_id)?;
            }
        }
        Identity::LocalHuman | Identity::SystemInternal => {
            perms::require(db, principal, Capability::HandoffsWrite, &handoff.project_id)?;
        }
    }
    Ok(())
}

pub fn create_report(
    db: &Db,
    principal: &Principal,
    input: store::ReportInput,
) -> AppResult<ReportOut> {
    create_report_guarded(db, principal, input, &store::NoGuard)
}

/// 带**事务内守卫**的工作报告写入（v82 文件导入用）。
///
/// 与 [`create_handoff_guarded`] 的守卫语义一致：守卫校验与业务写入在同一个写
/// 事务内完成，任一步失败都整体回滚。
pub fn create_report_guarded(
    db: &Db,
    principal: &Principal,
    input: store::ReportInput,
    guard: &dyn store::WriteGuard,
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
    // 1) 报告必须关联真实存在的交接。
    let handoff = resolve_report_handoff(db, input.handoff_id.as_deref())?;
    // 2) 项目归属只能来自交接；载荷声明的项目只做一致性校验。
    let project_id = derive_report_project(&handoff, input.project_id.as_deref())?;
    // 3) 身份匹配 + 能力 + 项目范围。
    ensure_report_access(db, principal, &handoff)?;
    let (agent_row, agent_id) = principal_agent_snapshot(principal);
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::agents::now_iso();
    let source = super::store::source_label(principal.source);
    let revision = db.with_transaction(|conn| {
        guard.check(conn)?;
        // 追加式写入：只 INSERT，绝不 UPDATE/REPLACE 既有报告。
        conn.execute(
            "INSERT INTO agent_work_reports
               (id, handoff_id, project_id, task_id, agent_row_id, agent_id, summary, result,
                completed_items, pending_items, files_changed, evidence, risks, source, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                id,
                handoff.id,
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
        let revision = store::bump_revision(conn, "report", &id, principal, &now, "")?;
        guard.record_operation(conn, "report", &id)?;
        guard.complete(conn)?;
        Ok(revision)
    })?;
    let report = store::get_report(db, &id)?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "report.create",
            resource_kind: "report",
            resource_id: &id,
            project_id: &report.project_id,
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

/// 列工作报告：**先按项目范围过滤再分页**。
///
/// 范围来自 `AuthorizedReads.handoffs`（`handoffs.read` 的项目范围）：
/// - 全局授权 → 全量；
/// - 项目授权且 `ids` 为空 → FORBIDDEN（没有可读范围，不能退化成全量）；
/// - 项目授权 → 只查这些项目的报告，`Page.total` 也只计这些项目。
///
/// 带 `handoff_id` 时先校验该交接的项目访问，再按该交接过滤（其报告项目必然
/// 等于交接项目，因此仍落在允许范围内）。
pub fn list_reports(
    db: &Db,
    principal: &Principal,
    agent_id: Option<&str>,
    handoff_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<store::WorkReport>, Page)> {
    let scope = perms::authorized_reads(db, principal)?.handoffs;
    if let Some(handoff_id) = handoff_id {
        let handoff = store::get_handoff(db, handoff_id)?;
        ensure_handoff_access(db, principal, &handoff, Capability::HandoffsRead)?;
        if !scope.allows(&handoff.project_id) {
            return Err(perms::denial(Capability::HandoffsRead));
        }
    } else if scope.is_empty() {
        return Err(perms::denial(Capability::HandoffsRead));
    }
    if scope.global {
        store::list_reports(db, agent_id, handoff_id, limit, offset)
    } else {
        let projects: Vec<String> = scope.ids.into_iter().collect();
        store::list_reports_in_projects(db, &projects, agent_id, handoff_id, limit, offset)
    }
}

/// 供 Context Engine 消费的工作报告：按能力 + 项目范围过滤。
///
/// 先按项目过滤再取数（不是取全量后在内存里筛），项目级授权的总条数与分页
/// 都不会被其它项目影响。
///
/// 报告语义固定为「做过什么」：`result` 取值只可能是
/// completed/partial/blocked/failed，**不会**出现决策状态
/// （proposed/accepted/superseded/rejected）。调用方必须以 `kind = "report"`
/// 呈现，不得把它并入决策集合。
pub fn list_reports_for_context(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    limit: u32,
) -> AppResult<Vec<store::WorkReport>> {
    perms::require(db, principal, Capability::HandoffsRead, project_id)?;
    let limit = limit.clamp(1, 200);
    let projects = [project_id.to_string()];
    let (reports, _) = store::list_reports_in_projects(db, &projects, None, None, limit, 0)?;
    Ok(reports)
}

/// 取单条报告：访问范围由报告的**真实归属**判定。
///
/// 报告挂在交接上时项目归属由交接推导（载荷声明不可信）；没有交接的旧报告才
/// 回退到自身 `project_id`——项目为空时只允许全局 `handoffs.read`，因此不会
/// 返回其它项目的报告。
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
