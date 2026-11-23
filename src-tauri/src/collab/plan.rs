//! 方案：从 Issue 创建、审批状态机、可视化关联、任务拆解与进度。
//!
//! 边界：
//! - 方案只是计划文档，不改写 `planning_projects/features`；
//! - 任务写入既有 `tasks` 表（复用 `create_task_tx`，同一事务）；
//! - 审批只允许本机 UI Actor（`Actor::require_review`）。

use rusqlite::{Connection, OptionalExtension};

use crate::commands::tasks::{create_task_tx, TaskInput};
use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, write_audit, Actor, ActorKind, Capability};
use super::model::{
    page_args, Evidence, Issue, Page, Plan, PlanDetail, PlanPatch, PlanProgress, PlanTaskRef,
    PlanTasksResult, TaskDraft, VisualDocument, PLAN_STATUSES, MAX_DESCRIPTION, MAX_SOLUTION,
    MAX_TITLE, PAGE_MAX,
};
use super::util::{new_id, now_iso, validate_enum, validate_text};

const COLS: &str = "id, project_id, issue_id, title, summary, solution_md, breakdown_json, \
status, review_note, approved_by, approved_at, revision, created_by, updated_by, created_at, updated_at";

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Plan> {
    let breakdown_raw: String = r.get(6)?;
    Ok(Plan {
        id: r.get(0)?,
        project_id: r.get(1)?,
        issue_id: r.get(2)?,
        title: r.get(3)?,
        summary: r.get(4)?,
        solution_md: r.get(5)?,
        breakdown: serde_json::from_str(&breakdown_raw).unwrap_or_default(),
        status: r.get(7)?,
        review_note: r.get(8)?,
        approved_by: r.get(9)?,
        approved_at: r.get(10)?,
        revision: r.get(11)?,
        created_by: r.get(12)?,
        updated_by: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

pub fn load_plan(conn: &Connection, id: &str) -> AppResult<Plan> {
    conn.query_row(
        &format!("SELECT {COLS} FROM collab_plans WHERE id=?1"),
        rusqlite::params![id],
        map_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("方案不存在".to_string()))
}

fn clip_title(prefix: &str, title: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + title.len());
    out.push_str(prefix);
    out.extend(title.chars().take(MAX_TITLE.saturating_sub(prefix.chars().count())));
    out
}

/// 从 Issue 创建方案时先落一份可执行的规则草案，避免“已批准但无任务可拆”。
fn default_breakdown(issue: &Issue) -> Vec<TaskDraft> {
    let action = if issue.kind == "bug" { "修复" } else { "实现" };
    let description = if issue.description.trim().is_empty() {
        format!("来自需求 {} 的方案拆解。", issue.id)
    } else {
        issue.description.clone()
    };
    let priority = issue
        .priority
        .trim_start_matches('P')
        .parse::<u8>()
        .ok()
        .map(|p| p.clamp(1, 3));
    vec![
        TaskDraft {
            title: clip_title(&format!("{action}："), &issue.title),
            description,
            priority,
        },
        TaskDraft {
            title: clip_title("验证：", &issue.title),
            description: "补充自动化测试与真实验收证据，覆盖边界、错误路径与回归场景。".to_string(),
            priority: Some(2),
        },
    ]
}

pub fn create_plan_from_issue(
    conn: &Connection,
    actor: &Actor,
    issue_id: &str,
) -> AppResult<Plan> {
    actor.require(Capability::PlansWrite)?;
    let issue = super::issue::load_issue(conn, issue_id)?;
    assert_project_scope(conn, actor, &issue.project_id)?;

    let existing: Option<Plan> = conn
        .query_row(
            &format!("SELECT {COLS} FROM collab_plans WHERE issue_id=?1 ORDER BY created_at LIMIT 1"),
            rusqlite::params![issue_id],
            map_row,
        )
        .optional()?;
    if let Some(plan) = existing {
        return Err(AppError::Conflict(format!(
            "DUPLICATE_PLAN: 该需求已有方案 {}（避免误覆盖，请更新原方案）",
            plan.id
        )));
    }

    let now = now_iso();
    let plan = Plan {
        id: new_id("cp"),
        project_id: issue.project_id.clone(),
        issue_id: Some(issue.id.clone()),
        title: format!("方案：{}", issue.title),
        summary: issue.description.clone(),
        solution_md: String::new(),
        breakdown: default_breakdown(&issue),
        status: "draft".to_string(),
        review_note: String::new(),
        approved_by: String::new(),
        approved_at: None,
        revision: 1,
        created_by: actor.id.clone(),
        updated_by: actor.id.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    conn.execute(
        &format!("INSERT INTO collab_plans ({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)"),
        rusqlite::params![
            plan.id,
            plan.project_id,
            plan.issue_id,
            plan.title,
            plan.summary,
            plan.solution_md,
            serde_json::to_string(&plan.breakdown)?,
            plan.status,
            plan.review_note,
            plan.approved_by,
            plan.approved_at,
            plan.revision,
            plan.created_by,
            plan.updated_by,
            plan.created_at,
            plan.updated_at,
        ],
    )?;
    // 双向关联：Issue → Plan（查询用）与 Plan → Issue（详情用）。
    conn.execute(
        "INSERT OR IGNORE INTO collab_issue_links
         (id, issue_id, target_kind, target_id, relation, created_by, created_at)
         VALUES (?1,?2,'plan',?3,'related',?4,?5)",
        rusqlite::params![new_id("il"), issue.id, plan.id, actor.id, now],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO collab_plan_links (id, plan_id, target_kind, target_id, created_at)
         VALUES (?1,?2,'issue',?3,?4)",
        rusqlite::params![new_id("pl"), plan.id, issue.id, now],
    )?;
    write_audit(
        conn,
        &plan.project_id,
        "plan",
        &plan.id,
        "create_from_issue",
        actor,
        None,
        Some(1),
        serde_json::json!({"issueId": issue.id}),
    )?;
    Ok(plan)
}

pub fn update_plan(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    patch: &PlanPatch,
) -> AppResult<Plan> {
    actor.require(Capability::PlansWrite)?;
    let current = load_plan(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;

    let mut next = current.clone();
    if let Some(v) = &patch.title {
        next.title = validate_text(v, "方案标题", MAX_TITLE, true)?;
    }
    if let Some(v) = &patch.summary {
        next.summary = validate_text(v, "方案摘要", MAX_DESCRIPTION, false)?;
    }
    if let Some(v) = &patch.solution_md {
        next.solution_md = validate_text(v, "方案正文", MAX_SOLUTION, false)?;
    }
    if let Some(v) = &patch.breakdown {
        next.breakdown = normalize_breakdown(v)?;
    }
    if let Some(status) = &patch.status {
        apply_status_transition(conn, actor, &current, status, patch.review_note.as_deref())?;
        next.status = status.clone();
        if status == "approved" {
            next.approved_by = actor.id.clone();
            next.approved_at = Some(now_iso());
        }
        if status == "changes_requested" || (current.status == "accepting" && status == "developing") {
            next.review_note = validate_text(
                patch.review_note.as_deref().unwrap_or_default(), "退回原因", MAX_DESCRIPTION, true,
            )?;
        }
    }

    let revision = current.revision + 1;
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE collab_plans SET title=?2, summary=?3, solution_md=?4, breakdown_json=?5,
         status=?6, review_note=?7, approved_by=?8, approved_at=?9, revision=?10,
         updated_by=?11, updated_at=?12 WHERE id=?1 AND revision=?13",
        rusqlite::params![
            id,
            next.title,
            next.summary,
            next.solution_md,
            serde_json::to_string(&next.breakdown)?,
            next.status,
            next.review_note,
            next.approved_by,
            next.approved_at,
            revision,
            actor.id,
            now,
            expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict(format!(
            "版本冲突：方案已被其他操作修改（当前 revision={}）",
            current.revision
        )));
    }
    write_audit(
        conn,
        &current.project_id,
        "plan",
        id,
        "update",
        actor,
        Some(current.revision),
        Some(revision),
        serde_json::json!({
            "fields": {
                "title": patch.title.is_some(),
                "summary": patch.summary.is_some(),
                "solution": patch.solution_md.is_some(),
                "breakdown": patch.breakdown.is_some(),
                "status": patch.status
            }
        }),
    )?;
    next.revision = revision;
    next.updated_at = now;
    next.updated_by = actor.id.clone();
    Ok(next)
}

fn normalize_breakdown(drafts: &[super::model::TaskDraft]) -> AppResult<Vec<super::model::TaskDraft>> {
    if drafts.len() > 50 {
        return Err(AppError::Validation("任务草案最多 50 条".to_string()));
    }
    drafts
        .iter()
        .map(|d| {
            Ok(super::model::TaskDraft {
                title: validate_text(&d.title, "任务标题", MAX_TITLE, true)?,
                description: validate_text(&d.description, "任务描述", MAX_DESCRIPTION, false)?,
                priority: d.priority.map(|p| p.min(3)),
            })
        })
        .collect()
}

fn apply_status_transition(
    conn: &Connection,
    actor: &Actor,
    current: &Plan,
    to: &str,
    note: Option<&str>,
) -> AppResult<()> {
    let to = validate_enum(to, PLAN_STATUSES, "方案状态")?;
    let allowed = match current.status.as_str() {
        "draft" => matches!(to.as_str(), "in_review" | "archived"),
        "changes_requested" => matches!(to.as_str(), "in_review" | "archived"),
        "in_review" => matches!(to.as_str(), "approved" | "changes_requested" | "archived"),
        "approved" => matches!(to.as_str(), "developing" | "archived"),
        "developing" => matches!(to.as_str(), "accepting" | "archived"),
        "accepting" => matches!(to.as_str(), "completed" | "developing" | "archived"),
        "completed" | "archived" => to == "archived",
        _ => false,
    };
    if !allowed {
        return Err(AppError::Conflict(format!(
            "非法状态转换：{} → {}",
            current.status, to
        )));
    }
    if matches!(to.as_str(), "approved" | "changes_requested" | "completed" | "archived")
        || (current.status == "accepting" && to == "developing")
    {
        actor.require_review()?;
    }
    if to == "completed" || (to == "accepting" && actor.kind != ActorKind::Ui) {
        let tasks = plan_tasks(conn, &current.id)?;
        if tasks.is_empty() || tasks.iter().any(|task| task.status != "completed") {
            return Err(AppError::Conflict("验收要求方案关联任务全部完成".into()));
        }
    }
    if to == "changes_requested" && note.unwrap_or("").trim().is_empty() {
        return Err(AppError::Validation("驳回必须填写原因".to_string()));
    }
    if to == "developing" {
        let has_tasks: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM collab_plan_links WHERE plan_id=?1 AND target_kind='task' LIMIT 1",
                rusqlite::params![current.id],
                |r| r.get(0),
            )
            .optional()?;
        if has_tasks.is_none() {
            return Err(AppError::Validation(
                "先拆解任务后才能进入开发中".to_string(),
            ));
        }
    }
    Ok(())
}

pub fn submit_plan(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
) -> AppResult<Plan> {
    actor.require(Capability::PlansWrite)?;
    let current = load_plan(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;
    if current.status == "in_review" {
        return Ok(current);
    }
    update_plan(
        conn,
        actor,
        id,
        expected_revision,
        &PlanPatch {
            status: Some("in_review".to_string()),
            ..Default::default()
        },
    )
}

pub fn review_plan(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    decision: &str,
    note: Option<&str>,
) -> AppResult<Plan> {
    actor.require_review()?;
    let current = load_plan(conn, id)?;
    let approving = match decision {
        "approve" => true,
        "reject" | "request_changes" => false,
        _ => return Err(AppError::Validation("审批决定必须是 approve 或 reject".into())),
    };
    let status = match (current.status.as_str(), approving) {
        ("in_review", true) => "approved",
        ("in_review", false) => "changes_requested",
        ("accepting", true) => "completed",
        ("accepting", false) => "developing",
        _ => return Err(AppError::Conflict(format!(
            "只有待审阅或待验收的方案可以审批（当前 {}）", current.status,
        ))),
    };
    update_plan(
        conn,
        actor,
        id,
        expected_revision,
        &PlanPatch {
            status: Some(status.to_string()),
            review_note: note.map(|s| s.to_string()),
            ..Default::default()
        },
    )
}

pub fn link_visual(
    conn: &Connection,
    actor: &Actor,
    plan_id: &str,
    document_id: &str,
) -> AppResult<PlanDetail> {
    actor.require(Capability::PlansWrite)?;
    let plan = load_plan(conn, plan_id)?;
    assert_project_scope(conn, actor, &plan.project_id)?;
    let doc: Option<String> = conn
        .query_row(
            "SELECT project_id FROM collab_visual_docs WHERE id=?1",
            rusqlite::params![document_id],
            |r| r.get(0),
        )
        .optional()?;
    let doc_project = doc.ok_or_else(|| AppError::NotFound("可视化文档不存在".to_string()))?;
    if doc_project != plan.project_id {
        return Err(AppError::Forbidden("不能关联其他项目的可视化".to_string()));
    }
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO collab_plan_links (id, plan_id, target_kind, target_id, created_at)
         VALUES (?1,?2,'visual',?3,?4)",
        rusqlite::params![new_id("pl"), plan_id, document_id, now_iso()],
    )?;
    if inserted > 0 {
        write_audit(
            conn,
            &plan.project_id,
            "plan",
            plan_id,
            "link_visual",
            actor,
            Some(plan.revision),
            Some(plan.revision),
            serde_json::json!({"documentId": document_id}),
        )?;
    }
    get_plan(conn, actor, plan_id)
}

pub fn get_plan(conn: &Connection, actor: &Actor, id: &str) -> AppResult<PlanDetail> {
    actor.require(Capability::PlansRead)?;
    let plan = load_plan(conn, id)?;
    assert_project_scope(conn, actor, &plan.project_id)?;

    let mut visuals_stmt = conn.prepare(
        "SELECT d.id, d.project_id, d.plan_id, d.title, d.description, d.kind, d.schema_version,
                d.source_format, d.source_content, d.renderer, d.preview_asset, d.status,
                d.version, d.revision, d.created_by, d.updated_by, d.created_at, d.updated_at
         FROM collab_visual_docs d
         JOIN collab_plan_links l ON l.target_kind='visual' AND l.target_id=d.id
         WHERE l.plan_id=?1 ORDER BY d.updated_at DESC",
    )?;
    let visuals = visuals_stmt
        .query_map(rusqlite::params![id], super::visual::map_doc_row)?
        .collect::<Result<Vec<VisualDocument>, _>>()?;

    let tasks = plan_tasks(conn, id)?;
    let evidence = super::issue::evidence_for(conn, "plan", id)?;
    Ok(PlanDetail {
        plan,
        visuals,
        tasks,
        evidence,
    })
}

pub fn plan_tasks(conn: &Connection, plan_id: &str) -> AppResult<Vec<PlanTaskRef>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.status, t.completed_at
         FROM collab_plan_links l JOIN tasks t ON t.id=l.target_id
         WHERE l.plan_id=?1 AND l.target_kind='task'
         ORDER BY t.created_at",
    )?;
    let rows = stmt.query_map(rusqlite::params![plan_id], |r| {
        Ok(PlanTaskRef {
            task_id: r.get(0)?,
            title: r.get(1)?,
            status: r.get(2)?,
            completed_at: r.get(3)?,
            orphan: false,
        })
    })?;
    let mut out: Vec<PlanTaskRef> = rows.collect::<Result<Vec<_>, _>>()?;

    // 找出已孤儿的链接（任务被删除），只标注，不自动清理。
    let mut stmt = conn.prepare(
        "SELECT target_id FROM collab_plan_links l
         WHERE l.plan_id=?1 AND l.target_kind='task'
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=l.target_id)",
    )?;
    let orphans = stmt
        .query_map(rusqlite::params![plan_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for task_id in orphans {
        out.push(PlanTaskRef {
            task_id,
            title: "（任务已删除）".to_string(),
            status: "orphan".to_string(),
            completed_at: None,
            orphan: true,
        });
    }
    Ok(out)
}

pub fn create_tasks_from_plan(
    conn: &Connection,
    actor: &Actor,
    id: &str,
) -> AppResult<PlanTasksResult> {
    actor.require(Capability::PlansWrite)?;
    let plan = load_plan(conn, id)?;
    assert_project_scope(conn, actor, &plan.project_id)?;
    if plan.status != "approved" && plan.status != "developing" {
        return Err(AppError::Conflict(
            "只有已批准（或开发中）的方案可以拆解任务".to_string(),
        ));
    }
    if plan.breakdown.is_empty() {
        return Err(AppError::Validation(
            "方案没有任务草案，无法拆解".to_string(),
        ));
    }

    let existing = plan_tasks(conn, id)?;
    if !existing.is_empty() {
        return Ok(PlanTasksResult {
            plan,
            created: Vec::new(),
            existing: existing.iter().map(|t| t.task_id.clone()).collect(),
            tasks: existing,
        });
    }

    let project_root = crate::project_hub::service::ensure_project_for_plan_tx(conn, &plan.project_id)?;
    let mut created = Vec::new();
    let now = now_iso();
    for draft in &plan.breakdown {
        let task_id = create_task_tx(
            conn,
            TaskInput {
                title: draft.title.clone(),
                description: draft.description.clone(),
                priority: draft.priority.or(Some(2)),
                ..Default::default()
            },
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO collab_plan_links (id, plan_id, target_kind, target_id, created_at)
             VALUES (?1,?2,'task',?3,?4)",
            rusqlite::params![new_id("pl"), plan.id, task_id, now],
        )?;
        crate::commands::project_workspace::workspace_task_link_add_tx(conn, &project_root, &task_id)?;
        created.push(task_id);
    }

    // 状态推进：approved → developing（同事务）。
    let revision = plan.revision + 1;
    let _ = conn.execute(
        "UPDATE collab_plans SET status='developing', revision=?2, updated_by=?3, updated_at=?4
         WHERE id=?1 AND revision=?5",
        rusqlite::params![id, revision, actor.id, now, plan.revision],
    );
    write_audit(
        conn,
        &plan.project_id,
        "plan",
        id,
        "create_tasks",
        actor,
        Some(plan.revision),
        Some(revision),
        serde_json::json!({"created": created.len()}),
    )?;

    let tasks = plan_tasks(conn, id)?;
    let mut updated = plan;
    updated.status = "developing".to_string();
    updated.revision = revision;
    updated.updated_at = now;
    updated.updated_by = actor.id.clone();
    Ok(PlanTasksResult {
        plan: updated,
        created,
        existing: Vec::new(),
        tasks,
    })
}

pub fn plan_progress(conn: &Connection, actor: &Actor, id: &str) -> AppResult<PlanProgress> {
    actor.require(Capability::PlansRead)?;
    let plan = load_plan(conn, id)?;
    assert_project_scope(conn, actor, &plan.project_id)?;
    let tasks = plan_tasks(conn, id)?;
    let total = tasks.len() as i64;
    let completed = tasks.iter().filter(|t| t.status == "completed").count() as i64;
    let orphan = tasks.iter().filter(|t| t.orphan).count() as i64;
    let percent = if total == 0 {
        None
    } else {
        Some(((completed * 100) / total).min(100))
    };
    Ok(PlanProgress {
        total,
        completed,
        percent,
        orphan,
    })
}

pub fn list_plans(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    status: Option<&str>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<Plan>> {
    actor.require(Capability::PlansRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let (page, size, offset) = page_args(page, page_size);
    let total: i64 = match status {
        Some(s) => {
            validate_enum(s, PLAN_STATUSES, "方案状态")?;
            conn.query_row(
                "SELECT COUNT(*) FROM collab_plans WHERE project_id=?1 AND status=?2",
                rusqlite::params![project_id, s],
                |r| r.get(0),
            )?
        }
        None => conn.query_row(
            "SELECT COUNT(*) FROM collab_plans WHERE project_id=?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )?,
    };
    let items = match status {
        Some(s) => conn
            .prepare(
                &format!(
                    "SELECT {COLS} FROM collab_plans WHERE project_id=?1 AND status=?2 \
                     ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4"
                ),
            )?
            .query_map(rusqlite::params![project_id, s, size, offset], map_row)?
            .collect::<Result<Vec<_>, _>>()?,
        None => conn
            .prepare(
                &format!(
                    "SELECT {COLS} FROM collab_plans WHERE project_id=?1 \
                     ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3"
                ),
            )?
            .query_map(rusqlite::params![project_id, size, offset], map_row)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(Page::new(items, total, page, size))
}

#[allow(dead_code)]
fn assert_ui_for_review(actor: &Actor) {
    debug_assert!(actor.kind == ActorKind::Ui || actor.kind == ActorKind::System);
}

#[allow(dead_code)]
fn unused(_e: &Evidence) {
    let _ = MAX_TITLE;
    let _ = PAGE_MAX;
}
