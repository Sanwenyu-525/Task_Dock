//! 统一业务服务门面。
//!
//! IPC（`commands.rs`）与 MCP（`mcp_tools.rs`）都只调用这里；接入层不做业务判断，
//! 保证同一操作在不同入口得到相同权限、校验与审计行为。

use rusqlite::Connection;
use serde_json::Value;

use crate::error::AppResult;

use super::actor::{self, Actor};
use super::ai;
use super::context;
use super::evidence;
use super::issue;
use super::model::*;
use super::plan;
use super::prototype;
use super::visual;

pub struct Core<'a> {
    pub conn: &'a Connection,
}

impl<'a> Core<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    // ── 上下文 ──
    pub fn project_context(
        &self,
        actor: &Actor,
        project_id: &str,
        include: &[String],
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<ProjectContext> {
        context::get_project_context(self.conn, actor, project_id, include, page, page_size)
    }

    pub fn project_overview(&self, actor: &Actor, project_id: &str) -> AppResult<ProjectContext> {
        context::get_project_overview(self.conn, actor, project_id)
    }

    pub fn project_knowledge(
        &self,
        actor: &Actor,
        project_id: &str,
        query: Option<&str>,
        limit: Option<i64>,
    ) -> AppResult<Vec<String>> {
        context::get_project_knowledge(self.conn, actor, project_id, query, limit)
    }

    // ── 需求 / Bug ──
    pub fn create_issue(
        &self,
        actor: &Actor,
        project_id: &str,
        input: &IssueInput,
    ) -> AppResult<IssueCreateResult> {
        issue::create_issue(self.conn, actor, project_id, input)
    }

    pub fn update_issue(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        patch: &IssuePatch,
    ) -> AppResult<Issue> {
        issue::update_issue(self.conn, actor, id, expected_revision, patch)
    }

    pub fn get_issue(&self, actor: &Actor, id: &str) -> AppResult<IssueDetail> {
        issue::get_issue(self.conn, actor, id)
    }

    pub fn list_issues(
        &self,
        actor: &Actor,
        project_id: &str,
        filter: &IssueFilter,
    ) -> AppResult<Page<Issue>> {
        issue::list_issues(self.conn, actor, project_id, filter)
    }

    pub fn archive_issue(&self, actor: &Actor, id: &str, expected_revision: i64) -> AppResult<Issue> {
        issue::archive_issue(self.conn, actor, id, expected_revision)
    }

    pub fn assign_issue(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        assignee: &str,
    ) -> AppResult<Issue> {
        issue::assign_issue(self.conn, actor, id, expected_revision, assignee)
    }

    pub fn link_issue(
        &self,
        actor: &Actor,
        id: &str,
        target_kind: &str,
        target_id: &str,
        relation: &str,
    ) -> AppResult<IssueDetail> {
        issue::link_issue(self.conn, actor, id, target_kind, target_id, relation)
    }

    /// 相似需求/Bug 识别：只返回候选，绝不自动合并或删除。
    pub fn detect_duplicates(
        &self,
        actor: &Actor,
        project_id: &str,
        title: &str,
        description: &str,
        kind: &str,
        exclude_id: Option<&str>,
    ) -> AppResult<Vec<DuplicateCandidate>> {
        actor.require(super::actor::Capability::IssuesRead)?;
        actor::assert_project_scope(self.conn, actor, project_id)?;
        let mut items =
            issue::detect_duplicates_conn(self.conn, project_id, kind, title, description, 8)?;
        if let Some(exclude) = exclude_id {
            items.retain(|c| c.id != exclude);
        }
        Ok(items)
    }

    pub fn resolve_bug(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        resolution: &str,
    ) -> AppResult<Issue> {
        issue::resolve_bug(self.conn, actor, id, expected_revision, resolution)
    }

    pub fn verify_bug(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        evidence_id: &str,
    ) -> AppResult<Issue> {
        issue::verify_bug(self.conn, actor, id, expected_revision, evidence_id)
    }

    // ── 证据 ──
    pub fn attach_evidence_path(
        &self,
        actor: &Actor,
        project_id: &str,
        input: &EvidenceInput,
    ) -> AppResult<Evidence> {
        evidence::attach_path(self.conn, actor, project_id, input)
    }

    pub fn attach_evidence_text(
        &self,
        actor: &Actor,
        project_id: &str,
        input: &EvidenceInput,
    ) -> AppResult<Evidence> {
        evidence::attach_text(self.conn, actor, project_id, input)
    }

    pub fn list_evidence(
        &self,
        actor: &Actor,
        project_id: &str,
        subject_kind: Option<&str>,
        subject_id: Option<&str>,
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<Page<Evidence>> {
        match (subject_kind, subject_id) {
            (Some(kind), Some(id)) => {
                let items = evidence::list_evidence(self.conn, actor, kind, id)?;
                let (page, size, offset) = super::model::page_args(page, page_size);
                let total = items.len() as i64;
                let sliced: Vec<Evidence> = items
                    .into_iter()
                    .skip(offset as usize)
                    .take(size as usize)
                    .collect();
                Ok(Page::new(sliced, total, page, size))
            }
            _ => evidence::list_for_project(self.conn, actor, project_id, page, page_size),
        }
    }

    // ── 方案 ──
    pub fn create_plan_from_issue(&self, actor: &Actor, issue_id: &str) -> AppResult<Plan> {
        plan::create_plan_from_issue(self.conn, actor, issue_id)
    }

    pub fn update_plan(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        patch: &PlanPatch,
    ) -> AppResult<Plan> {
        plan::update_plan(self.conn, actor, id, expected_revision, patch)
    }

    pub fn get_plan(&self, actor: &Actor, id: &str) -> AppResult<PlanDetail> {
        plan::get_plan(self.conn, actor, id)
    }

    pub fn list_plans(
        &self,
        actor: &Actor,
        project_id: &str,
        status: Option<&str>,
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<Page<Plan>> {
        plan::list_plans(self.conn, actor, project_id, status, page, page_size)
    }

    pub fn submit_plan(&self, actor: &Actor, id: &str, expected_revision: i64) -> AppResult<Plan> {
        plan::submit_plan(self.conn, actor, id, expected_revision)
    }

    pub fn review_plan(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        decision: &str,
        note: Option<&str>,
    ) -> AppResult<Plan> {
        plan::review_plan(self.conn, actor, id, expected_revision, decision, note)
    }

    pub fn link_visual(&self, actor: &Actor, plan_id: &str, document_id: &str) -> AppResult<PlanDetail> {
        plan::link_visual(self.conn, actor, plan_id, document_id)
    }

    pub fn create_tasks_from_plan(&self, actor: &Actor, id: &str) -> AppResult<PlanTasksResult> {
        plan::create_tasks_from_plan(self.conn, actor, id)
    }

    pub fn plan_tasks(&self, actor: &Actor, id: &str) -> AppResult<Vec<PlanTaskRef>> {
        Ok(self.get_plan(actor, id)?.tasks)
    }

    pub fn plan_progress(&self, actor: &Actor, id: &str) -> AppResult<PlanProgress> {
        plan::plan_progress(self.conn, actor, id)
    }

    // ── 可视化 ──
    pub fn create_visual(
        &self,
        actor: &Actor,
        project_id: &str,
        input: &VisualInput,
    ) -> AppResult<VisualDocument> {
        visual::create_document(self.conn, actor, project_id, input)
    }

    pub fn update_visual(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        patch: &VisualPatch,
        summary: &str,
    ) -> AppResult<VisualDocument> {
        visual::update_document(self.conn, actor, id, expected_revision, patch, summary)
    }

    pub fn get_visual(&self, actor: &Actor, id: &str) -> AppResult<VisualDocument> {
        visual::get_document(self.conn, actor, id)
    }

    pub fn list_visuals(
        &self,
        actor: &Actor,
        project_id: &str,
        kind: Option<&str>,
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<Page<VisualDocument>> {
        visual::list_documents(self.conn, actor, project_id, kind, page, page_size)
    }

    pub fn delete_visual(&self, actor: &Actor, id: &str) -> AppResult<VisualDocument> {
        visual::delete_document(self.conn, actor, id)
    }

    pub fn visual_versions(
        &self,
        actor: &Actor,
        id: &str,
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<Page<VisualVersion>> {
        visual::list_versions(self.conn, actor, id, page, page_size)
    }

    pub fn visual_version(&self, actor: &Actor, id: &str, version: i64) -> AppResult<VisualVersion> {
        visual::get_document(self.conn, actor, id)?;
        visual::get_version(self.conn, id, version)
    }

    pub fn restore_visual(
        &self,
        actor: &Actor,
        id: &str,
        version: i64,
        expected_revision: i64,
    ) -> AppResult<VisualDocument> {
        visual::restore_version(self.conn, actor, id, version, expected_revision)
    }

    pub fn compare_visual(
        &self,
        actor: &Actor,
        id: &str,
        from: i64,
        to: i64,
    ) -> AppResult<VisualDiff> {
        visual::compare_versions(self.conn, actor, id, from, to)
    }

    pub fn export_visual(
        &self,
        actor: &Actor,
        id: &str,
        format: &str,
    ) -> AppResult<ExportResult> {
        visual::export_document(self.conn, actor, id, format)
    }

    pub fn renderers(&self) -> Value {
        serde_json::to_value(visual::list_renderers()).unwrap_or(Value::Null)
    }

    // ── 原型 ──
    pub fn apply_prototype_patch(
        &self,
        actor: &Actor,
        id: &str,
        expected_revision: i64,
        ops: &[PatchOp],
        summary: &str,
    ) -> AppResult<VisualDocument> {
        prototype::apply_patch(self.conn, actor, id, expected_revision, ops, summary)
    }

    pub fn prototype_state(&self, actor: &Actor, id: &str) -> AppResult<PrototypeState> {
        visual::get_document(self.conn, actor, id).and_then(|doc| {
            let content: Value = serde_json::from_str(&doc.source_content)
                .map_err(|_| crate::error::AppError::Validation("原型内容损坏".to_string()))?;
            Ok(prototype::default_state(&content))
        })
    }

    pub fn dispatch_prototype_event(
        &self,
        actor: &Actor,
        id: &str,
        state: PrototypeState,
        event: &PrototypeEvent,
    ) -> AppResult<PrototypeState> {
        prototype::dispatch_event(self.conn, actor, id, state, event)
    }

    pub fn validate_prototype_flow(
        &self,
        actor: &Actor,
        id: &str,
    ) -> AppResult<InteractionFlowReport> {
        prototype::validate_flow(self.conn, actor, id)
    }

    // ── AI ──
    pub fn generate_visual(
        &self,
        actor: &Actor,
        project_id: &str,
        plan_id: Option<&str>,
        issue_id: Option<&str>,
        kind: &str,
        prompt: &str,
    ) -> AppResult<AiJob> {
        ai::generate_visual(self.conn, actor, project_id, plan_id, issue_id, kind, prompt)
    }

    pub fn create_image_job(
        &self,
        actor: &Actor,
        project_id: &str,
        plan_id: Option<&str>,
        prompt: &str,
        params: Option<Value>,
    ) -> AppResult<AiJob> {
        ai::create_image_job(self.conn, actor, project_id, plan_id, prompt, params)
    }

    pub fn list_ai_jobs(
        &self,
        actor: &Actor,
        project_id: &str,
        status: Option<&str>,
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<Page<AiJob>> {
        ai::list_jobs(self.conn, actor, project_id, status, page, page_size)
    }

    pub fn cancel_ai_job(&self, actor: &Actor, id: &str) -> AppResult<AiJob> {
        ai::cancel_job(self.conn, actor, id)
    }

    pub fn ai_notice(&self) -> Value {
        ai::provider_notice()
    }

    // ── 审计 ──
    pub fn list_audit(
        &self,
        project_id: &str,
        entity_kind: Option<&str>,
        page: Option<i64>,
        page_size: Option<i64>,
    ) -> AppResult<Page<AuditEntry>> {
        actor::list_audit(self.conn, project_id, entity_kind, page, page_size)
    }
}
