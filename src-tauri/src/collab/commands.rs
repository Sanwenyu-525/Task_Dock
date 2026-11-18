//! 协作中心 IPC 命令（UI 入口）。
//!
//! 本文件只做参数接收与调用 `Core`；所有权限、校验、审计在服务层完成。
//! Agent 入口是 `mcp_tools.rs`，两条入口共用同一 `Core`。

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::Value;
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;

use super::actor::Actor;
use super::model::*;
use super::service::Core;

fn ui_call<T>(db: &Db, f: impl FnOnce(&Core<'_>) -> AppResult<T>) -> AppResult<T> {
    db.with_conn(|conn: &Connection| f(&Core::new(conn)))
}

fn ui_write<T>(db: &Db, f: impl FnOnce(&Core<'_>) -> AppResult<T>) -> AppResult<T> {
    db.with_transaction(|conn: &Connection| f(&Core::new(conn)))
}

#[tauri::command]
pub fn collab_context_get(
    db: State<'_, Arc<Db>>,
    project_id: String,
    include: Option<Vec<String>>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<ProjectContext> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.project_context(
            &actor,
            &project_id,
            include.as_deref().unwrap_or(&[]),
            page,
            page_size,
        )
    })
}

#[tauri::command]
pub fn collab_context_overview(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ProjectContext> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.project_overview(&actor, &project_id))
}

#[tauri::command]
pub fn collab_context_knowledge(
    db: State<'_, Arc<Db>>,
    project_id: String,
    query: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<String>> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.project_knowledge(&actor, &project_id, query.as_deref(), limit)
    })
}

#[tauri::command]
pub fn collab_issue_create(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: IssueInput,
) -> AppResult<IssueCreateResult> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.create_issue(&actor, &project_id, &input))
}

#[tauri::command]
pub fn collab_issue_update(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    patch: IssuePatch,
) -> AppResult<Issue> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.update_issue(&actor, &id, expected_revision, &patch)
    })
}

#[tauri::command]
pub fn collab_issue_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<IssueDetail> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.get_issue(&actor, &id))
}

#[tauri::command]
pub fn collab_issue_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    filter: Option<IssueFilter>,
) -> AppResult<Page<Issue>> {
    let actor = Actor::ui();
    let filter = filter.unwrap_or_default();
    ui_call(&db, |core| core.list_issues(&actor, &project_id, &filter))
}

#[tauri::command]
pub fn collab_issue_archive(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
) -> AppResult<Issue> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.archive_issue(&actor, &id, expected_revision))
}

#[tauri::command]
pub fn collab_issue_assign(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    assignee: String,
) -> AppResult<Issue> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.assign_issue(&actor, &id, expected_revision, &assignee)
    })
}

#[tauri::command]
pub fn collab_issue_link(
    db: State<'_, Arc<Db>>,
    id: String,
    target_kind: String,
    target_id: String,
    relation: String,
) -> AppResult<IssueDetail> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.link_issue(&actor, &id, &target_kind, &target_id, &relation)
    })
}

#[tauri::command]
pub fn collab_issue_duplicates(
    db: State<'_, Arc<Db>>,
    project_id: String,
    title: String,
    description: Option<String>,
    kind: Option<String>,
    exclude_id: Option<String>,
) -> AppResult<Vec<DuplicateCandidate>> {
    let actor = Actor::ui();
    let kind = kind.unwrap_or_else(|| "bug".to_string());
    ui_call(&db, |core| {
        core.detect_duplicates(
            &actor,
            &project_id,
            &title,
            description.as_deref().unwrap_or(""),
            &kind,
            exclude_id.as_deref(),
        )
    })
}

#[tauri::command]
pub fn collab_issue_resolve(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    resolution: String,
) -> AppResult<Issue> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.resolve_bug(&actor, &id, expected_revision, &resolution)
    })
}

#[tauri::command]
pub fn collab_issue_verify(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    evidence_id: String,
) -> AppResult<Issue> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.verify_bug(&actor, &id, expected_revision, &evidence_id)
    })
}

#[tauri::command]
pub fn collab_evidence_attach(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: EvidenceInput,
) -> AppResult<Evidence> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.attach_evidence_path(&actor, &project_id, &input))
}

#[tauri::command]
pub fn collab_evidence_attach_text(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: EvidenceInput,
) -> AppResult<Evidence> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.attach_evidence_text(&actor, &project_id, &input))
}

#[tauri::command]
pub fn collab_evidence_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    subject_kind: Option<String>,
    subject_id: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<Evidence>> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.list_evidence(
            &actor,
            &project_id,
            subject_kind.as_deref(),
            subject_id.as_deref(),
            page,
            page_size,
        )
    })
}

#[tauri::command]
pub fn collab_plan_create_from_issue(
    db: State<'_, Arc<Db>>,
    issue_id: String,
) -> AppResult<Plan> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.create_plan_from_issue(&actor, &issue_id))
}

#[tauri::command]
pub fn collab_plan_update(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    patch: PlanPatch,
) -> AppResult<Plan> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.update_plan(&actor, &id, expected_revision, &patch)
    })
}

#[tauri::command]
pub fn collab_plan_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<PlanDetail> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.get_plan(&actor, &id))
}

#[tauri::command]
pub fn collab_plan_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    status: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<Plan>> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.list_plans(&actor, &project_id, status.as_deref(), page, page_size)
    })
}

#[tauri::command]
pub fn collab_plan_submit(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
) -> AppResult<Plan> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.submit_plan(&actor, &id, expected_revision))
}

#[tauri::command]
pub fn collab_plan_review(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    decision: String,
    note: Option<String>,
) -> AppResult<Plan> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.review_plan(
            &actor,
            &id,
            expected_revision,
            &decision,
            note.as_deref(),
        )
    })
}

#[tauri::command]
pub fn collab_plan_link_visual(
    db: State<'_, Arc<Db>>,
    plan_id: String,
    document_id: String,
) -> AppResult<PlanDetail> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.link_visual(&actor, &plan_id, &document_id))
}

#[tauri::command]
pub fn collab_plan_create_tasks(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<PlanTasksResult> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.create_tasks_from_plan(&actor, &id))
}

#[tauri::command]
pub fn collab_plan_tasks(db: State<'_, Arc<Db>>, id: String) -> AppResult<Vec<PlanTaskRef>> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.plan_tasks(&actor, &id))
}

#[tauri::command]
pub fn collab_plan_progress(db: State<'_, Arc<Db>>, id: String) -> AppResult<PlanProgress> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.plan_progress(&actor, &id))
}

#[tauri::command]
pub fn collab_visual_create(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: VisualInput,
) -> AppResult<VisualDocument> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.create_visual(&actor, &project_id, &input))
}

#[tauri::command]
pub fn collab_visual_update(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    patch: VisualPatch,
    change_summary: Option<String>,
) -> AppResult<VisualDocument> {
    let actor = Actor::ui();
    let summary = change_summary.unwrap_or_default();
    ui_write(&db, |core| {
        core.update_visual(&actor, &id, expected_revision, &patch, &summary)
    })
}

#[tauri::command]
pub fn collab_visual_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<VisualDocument> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.get_visual(&actor, &id))
}

#[tauri::command]
pub fn collab_visual_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    kind: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<VisualDocument>> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.list_visuals(&actor, &project_id, kind.as_deref(), page, page_size)
    })
}

#[tauri::command]
pub fn collab_visual_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<VisualDocument> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.delete_visual(&actor, &id))
}

#[tauri::command]
pub fn collab_visual_versions(
    db: State<'_, Arc<Db>>,
    id: String,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<VisualVersion>> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.visual_versions(&actor, &id, page, page_size))
}

#[tauri::command]
pub fn collab_visual_version(
    db: State<'_, Arc<Db>>,
    id: String,
    version: i64,
) -> AppResult<VisualVersion> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.visual_version(&actor, &id, version))
}

#[tauri::command]
pub fn collab_visual_restore(
    db: State<'_, Arc<Db>>,
    id: String,
    version: i64,
    expected_revision: i64,
) -> AppResult<VisualDocument> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.restore_visual(&actor, &id, version, expected_revision)
    })
}

#[tauri::command]
pub fn collab_visual_compare(
    db: State<'_, Arc<Db>>,
    id: String,
    from_version: i64,
    to_version: i64,
) -> AppResult<VisualDiff> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.compare_visual(&actor, &id, from_version, to_version)
    })
}

#[tauri::command]
pub fn collab_visual_export(
    db: State<'_, Arc<Db>>,
    id: String,
    format: String,
) -> AppResult<ExportResult> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.export_visual(&actor, &id, &format))
}

#[tauri::command]
pub fn collab_renderers(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    ui_call(&db, |core| Ok(core.renderers()))
}

#[tauri::command]
pub fn collab_prototype_state(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<PrototypeState> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.prototype_state(&actor, &id))
}

#[tauri::command]
pub fn collab_prototype_dispatch(
    db: State<'_, Arc<Db>>,
    id: String,
    state: PrototypeState,
    event: PrototypeEvent,
) -> AppResult<PrototypeState> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.dispatch_prototype_event(&actor, &id, state, &event)
    })
}

#[tauri::command]
pub fn collab_prototype_patch(
    db: State<'_, Arc<Db>>,
    id: String,
    expected_revision: i64,
    ops: Vec<PatchOp>,
    change_summary: Option<String>,
) -> AppResult<VisualDocument> {
    let actor = Actor::ui();
    let summary = change_summary.unwrap_or_default();
    ui_write(&db, |core| {
        core.apply_prototype_patch(&actor, &id, expected_revision, &ops, &summary)
    })
}

#[tauri::command]
pub fn collab_prototype_validate(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<InteractionFlowReport> {
    let actor = Actor::ui();
    ui_call(&db, |core| core.validate_prototype_flow(&actor, &id))
}

#[tauri::command]
pub fn collab_ai_generate(
    db: State<'_, Arc<Db>>,
    project_id: String,
    plan_id: Option<String>,
    issue_id: Option<String>,
    kind: String,
    prompt: String,
) -> AppResult<AiJob> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.generate_visual(
            &actor,
            &project_id,
            plan_id.as_deref(),
            issue_id.as_deref(),
            &kind,
            &prompt,
        )
    })
}

#[tauri::command]
pub fn collab_ai_image(
    db: State<'_, Arc<Db>>,
    project_id: String,
    plan_id: Option<String>,
    prompt: String,
    params: Option<Value>,
) -> AppResult<AiJob> {
    let actor = Actor::ui();
    ui_write(&db, |core| {
        core.create_image_job(&actor, &project_id, plan_id.as_deref(), &prompt, params)
    })
}

#[tauri::command]
pub fn collab_ai_jobs(
    db: State<'_, Arc<Db>>,
    project_id: String,
    status: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<AiJob>> {
    let actor = Actor::ui();
    ui_call(&db, |core| {
        core.list_ai_jobs(&actor, &project_id, status.as_deref(), page, page_size)
    })
}

#[tauri::command]
pub fn collab_ai_cancel(db: State<'_, Arc<Db>>, id: String) -> AppResult<AiJob> {
    let actor = Actor::ui();
    ui_write(&db, |core| core.cancel_ai_job(&actor, &id))
}

#[tauri::command]
pub fn collab_ai_notice(db: State<'_, Arc<Db>>) -> AppResult<Value> {
    ui_call(&db, |core| Ok(core.ai_notice()))
}

/// 审计只允许 UI 读取；MCP 不暴露该工具。
#[tauri::command]
pub fn collab_audit_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    entity_kind: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<AuditEntry>> {
    ui_call(&db, |core| {
        core.list_audit(&project_id, entity_kind.as_deref(), page, page_size)
    })
}
