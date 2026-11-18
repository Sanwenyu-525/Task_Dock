//! 统一业务服务层：CLI / MCP / REST / 文件 四个入口的读写都经过这里。
//!
//! 为什么这一层存在：四个入口不允许各自实现业务 SQL。任务/规划/知识直接复用既有
//! `*_impl`（同一校验、同一事务、同一活动流），本模块只补：
//! - 统一的项目视图（规划中心 + 项目工作空间）；
//! - 版本读取/推进与冲突拒绝（`agent_resource_revisions` + 业务 `updated_at`）；
//! - 审计（成功写 `agent_activity_logs`）；
//! - 面向 Agent 的 snake_case 输出（知识库既有结构是 camelCase，这里显式映射）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::capability::knowledge as kb;
use crate::commands::planning::{
    activity_page_impl, list_features_impl, list_milestones_impl, list_projects_impl,
    load_project_tx, PlanningActivity, PlanningFeature, PlanningMilestone, PlanningProject,
};
use crate::commands::project_workspace::{
    workspace_item_list_impl, workspace_project_get_impl, workspace_project_list_impl,
    workspace_task_link_list_impl, WorkspaceProject,
};
use crate::commands::tasks::{
    create_task_tx, get_task, get_task_in_conn, list_tasks_inner, toggle_task_inner,
    update_task_in_conn, TaskFilter, TaskInput,
};
use crate::db::{Db, Task};
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions as perms;
use super::{missing_arg, store, validation, Page, Principal};

/// 数据目录：与无头 CLI / stdio 子命令遵循同一隔离规则（`TASK_DOCK_DATA_DIR` 优先）。
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    std::env::var("APPDATA")
        .map(|a| PathBuf::from(a).join("com.taskdock.desktop"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

// ── 项目 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    /// planning | workspace
    pub kind: String,
    pub status: String,
    pub description: String,
    pub updated_at: String,
    pub revision: i64,
    pub feature_total: i64,
    pub feature_done: i64,
    pub task_total: i64,
    pub item_total: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectDetail {
    pub summary: ProjectSummary,
    pub project: Value,
    pub milestones: Vec<PlanningMilestone>,
    pub features: Vec<PlanningFeature>,
    pub items: Vec<Value>,
    pub tasks: Vec<Value>,
    pub activity: Vec<PlanningActivity>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectStatus {
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub progress_percent: i64,
    pub counts: Value,
    pub blocked: Vec<Value>,
    pub next_steps: Vec<String>,
    pub updated_at: String,
    pub revision: i64,
}

fn planning_summary(project: &PlanningProject) -> ProjectSummary {
    ProjectSummary {
        id: project.id.clone(),
        name: project.name.clone(),
        kind: "planning".into(),
        status: project.status.clone(),
        description: project.description.clone(),
        updated_at: project.updated_at.clone(),
        revision: project.revision,
        feature_total: project.stats.feature_total,
        feature_done: project.stats.feature_completed,
        task_total: 0,
        item_total: 0,
    }
}

fn workspace_summary(db: &Db, project: &WorkspaceProject) -> AppResult<ProjectSummary> {
    let (counter, counter_at, _) = db.with_read(|conn| {
        store::read_revision(conn, "project", &project.id)
    })?;
    let revision = store::effective_revision(counter, &counter_at, &project.updated_at);
    Ok(ProjectSummary {
        id: project.id.clone(),
        name: project.name.clone(),
        kind: "workspace".into(),
        status: project.status.clone(),
        description: project.note.clone(),
        updated_at: project.updated_at.clone(),
        revision,
        feature_total: 0,
        feature_done: 0,
        task_total: project.task_link_count,
        item_total: project.item_count,
    })
}

/// 合并两个既有项目体系（不新建第三套项目表）。
pub fn list_projects(
    db: &Db,
    principal: &Principal,
    kind: Option<&str>,
    q: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<ProjectSummary>, Page)> {
    perms::require(db, principal, Capability::ProjectsRead, "")?;
    let keyword = q.map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty());
    let mut out: Vec<ProjectSummary> = Vec::new();
    if kind.is_none() || kind == Some("planning") {
        for project in list_projects_impl(db, Some(true))? {
            out.push(planning_summary(&project));
        }
    }
    if kind.is_none() || kind == Some("workspace") {
        for project in workspace_project_list_impl(db, None)? {
            out.push(workspace_summary(db, &project)?);
        }
    }
    if let Some(k) = keyword {
        out.retain(|p| {
            p.name.to_lowercase().contains(&k) || p.description.to_lowercase().contains(&k)
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
    let total = out.len() as u32;
    let page = Page::new(limit, offset, total);
    let start = (offset as usize).min(out.len());
    let end = (start + limit as usize).min(out.len());
    Ok((out[start..end].to_vec(), page))
}

pub fn get_project(db: &Db, principal: &Principal, id: &str) -> AppResult<ProjectDetail> {
    perms::require(db, principal, Capability::ProjectsRead, id)?;
    let kind = db.with_read(|conn| perms::project_exists(conn, id))?;
    match kind {
        Some("planning") => {
            let project = db.with_read(|conn| load_project_tx(conn, id))?;
            let milestones = list_milestones_impl(db, id.to_string())?;
            let features = list_features_impl(db, id.to_string())?;
            let activity = activity_page_impl(db, id.to_string(), None, Some(20), Some(0))?
                .items;
            Ok(ProjectDetail {
                summary: planning_summary(&project),
                project: serde_json::to_value(&project)?,
                milestones,
                features,
                items: Vec::new(),
                tasks: Vec::new(),
                activity,
            })
        }
        Some("workspace") => {
            let project = workspace_project_get_impl(db, id)?;
            let items = workspace_item_list_impl(db, id)?;
            let links = workspace_task_link_list_impl(db, id)?;
            Ok(ProjectDetail {
                summary: workspace_summary(db, &project)?,
                project: serde_json::to_value(&project)?,
                milestones: Vec::new(),
                features: Vec::new(),
                items: links
                    .iter()
                    .map(|l| json!({ "kind": "task_link", "task_id": l.task_id, "title": l.title }))
                    .chain(
                        items
                            .iter()
                            .map(|i| serde_json::to_value(i).unwrap_or(Value::Null)),
                    )
                    .collect(),
                tasks: links
                    .iter()
                    .map(|l| {
                        json!({
                            "task_id": l.task_id,
                            "title": l.title,
                            "status": l.status,
                            "priority": l.priority,
                            "due_at": l.due_at,
                        })
                    })
                    .collect(),
                activity: Vec::new(),
            })
        }
        _ => Err(AppError::NotFound(format!("项目不存在: {id}"))),
    }
}

pub fn project_status(db: &Db, principal: &Principal, id: &str) -> AppResult<ProjectStatus> {
    let detail = get_project(db, principal, id)?;
    let mut blocked = Vec::new();
    let mut next_steps = Vec::new();
    let mut progress = 0i64;
    let counts = if detail.summary.kind == "planning" {
        let features = &detail.features;
        let mut by_status = std::collections::BTreeMap::<String, i64>::new();
        for f in features {
            *by_status.entry(f.status.clone()).or_insert(0) += 1;
            if f.status == "blocked" {
                blocked.push(json!({ "feature_id": f.id, "title": f.title, "priority": f.priority }));
            }
            if f.status != "completed" && f.status != "paused" {
                for step in &f.steps {
                    if !step.done {
                        next_steps.push(format!("{} / {}", f.title, step.title));
                    }
                }
            }
        }
        if !features.is_empty() {
            let done = by_status.get("completed").copied().unwrap_or(0);
            progress = done * 100 / features.len() as i64;
        }
        json!({
            "features": by_status,
            "milestones": detail.milestones.len(),
        })
    } else {
        let items = &detail.items;
        let mut by_status = std::collections::BTreeMap::<String, i64>::new();
        for item in items {
            let status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            *by_status.entry(status.clone()).or_insert(0) += 1;
            if status == "blocked" {
                blocked.push(item.clone());
            }
            if status != "done" && status != "archived" {
                if let Some(title) = item.get("title").and_then(|v| v.as_str()) {
                    next_steps.push(title.to_string());
                }
            }
        }
        let done = by_status.get("done").copied().unwrap_or(0);
        if !items.is_empty() {
            progress = done * 100 / items.len() as i64;
        }
        json!({
            "items": by_status,
            "linked_tasks": detail.tasks.len(),
        })
    };
    next_steps.truncate(20);
    let status = detail.summary.status.clone();
    Ok(ProjectStatus {
        project_id: detail.summary.id.clone(),
        name: detail.summary.name.clone(),
        kind: detail.summary.kind.clone(),
        status,
        progress_percent: progress,
        counts,
        blocked,
        next_steps,
        updated_at: detail.summary.updated_at.clone(),
        revision: detail.summary.revision,
    })
}

// ── 任务 ─────────────────────────────────────────────────────────

pub fn list_tasks(
    db: &Db,
    principal: &Principal,
    filter: TaskFilter,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Task>, Page)> {
    perms::require(db, principal, Capability::TasksRead, "")?;
    let mut filter = filter;
    filter.limit = None;
    let all = list_tasks_inner(db, filter)?;
    let total = all.len() as u32;
    let page = Page::new(limit, offset, total);
    let start = (offset as usize).min(all.len());
    let end = (start + limit as usize).min(all.len());
    let mut items = all[start..end].to_vec();
    attach_task_revisions(db, &mut items)?;
    Ok((items, page))
}

pub fn fetch_task(db: &Db, principal: &Principal, id: &str) -> AppResult<Task> {
    perms::require(db, principal, Capability::TasksRead, id)?;
    let mut task = get_task(db, id)?;
    attach_task_revisions(db, std::slice::from_mut(&mut task))?;
    Ok(task)
}

/// 给任务补上 Agent 入口需要的有效 revision（不改变桌面端既有 Task 契约）。
pub fn task_revision(db: &Db, task: &Task) -> AppResult<i64> {
    db.with_read(|conn| {
        let (counter, counter_at, _) = store::read_revision(conn, "task", &task.id)?;
        Ok(store::effective_revision(counter, &counter_at, &task.updated_at))
    })
}

fn attach_task_revisions(db: &Db, tasks: &mut [Task]) -> AppResult<()> {
    if tasks.is_empty() {
        return Ok(());
    }
    db.with_read(|conn| {
        for task in tasks.iter_mut() {
            let (counter, counter_at, _) = store::read_revision(conn, "task", &task.id)?;
            task.revision = Some(store::effective_revision(
                counter,
                &counter_at,
                &task.updated_at,
            ));
        }
        Ok(())
    })
}

/// 任务的当前版本（计数器 + 业务 `updated_at` 双校验）。
pub fn task_version(db: &Db, id: &str) -> AppResult<(i64, String)> {
    db.with_read(|conn| {
        let task = get_task_in_conn(conn, id)?;
        let (counter, counter_at, _) = store::read_revision(conn, "task", id)?;
        let revision = store::effective_revision(counter, &counter_at, &task.updated_at);
        Ok((revision, task.updated_at))
    })
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct TaskCreateInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub remind_at: Option<String>,
    #[serde(default)]
    pub advance_minutes: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct TaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub clear_due_at: bool,
    #[serde(default)]
    pub remind_at: Option<String>,
    #[serde(default)]
    pub clear_remind_at: bool,
    #[serde(default)]
    pub advance_minutes: Option<i64>,
}

fn validate_task_input(title: &str, tags: &Option<Vec<String>>) -> AppResult<()> {
    if title.trim().is_empty() {
        return Err(validation("任务标题不能为空"));
    }
    store::check_text("title", title, 200)?;
    if let Some(tags) = tags {
        let owned = tags.clone();
        store::check_items("tags", &owned)?;
    }
    Ok(())
}

pub fn create_task(
    db: &Db,
    principal: &Principal,
    input: TaskCreateInput,
) -> AppResult<Task> {
    perms::require(db, principal, Capability::TasksWrite, "")?;
    validate_task_input(&input.title, &input.tags)?;
    let task_input = TaskInput {
        title: input.title,
        description: input.description,
        priority: input.priority,
        category: input.category,
        tags: input.tags,
        due_at: input.due_at.map(Some),
        remind_at: input.remind_at.map(Some),
        advance_minutes: input.advance_minutes,
        recurrence: None,
    };
    let (mut task, revision) = db.with_transaction(|conn| {
        let id = create_task_tx(conn, task_input)?;
        let task = get_task_in_conn(conn, &id)?;
        let revision =
            store::bump_revision(conn, "task", &id, principal, &task.updated_at, "")?;
        Ok((task, revision))
    })?;
    task.revision = Some(revision);
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "task.create",
            resource_kind: "task",
            resource_id: &task.id,
            project_id: "",
            request_id: "",
            success: true,
            error_code: "",
            detail: "创建任务",
            revision: Some(revision),
            duration_ms: 0,
        },
    );
    Ok(task)
}

/// 局部更新：未给字段保持原值（复用既有 `update_task_in_conn` 的三态语义）。
pub fn update_task(
    db: &Db,
    principal: &Principal,
    id: &str,
    patch: TaskPatch,
    base_revision: Option<i64>,
) -> AppResult<Task> {
    perms::require(db, principal, Capability::TasksWrite, id)?;
    let (mut task, revision, prior) = db.with_transaction(|conn| {
        let existing = get_task_in_conn(conn, id)?;
        let (counter, counter_at, _) = store::read_revision(conn, "task", id)?;
        let effective = store::effective_revision(counter, &counter_at, &existing.updated_at);
        if let Some(base) = base_revision {
            if base != effective {
                return Err(AppError::Conflict(format!(
                    "任务版本已变化（当前 revision={effective}，updated_at={}，提交 base_revision={base}）",
                    existing.updated_at
                )));
            }
        }
        let title = patch.title.clone().unwrap_or_else(|| existing.title.clone());
        validate_task_input(&title, &patch.tags)?;
        let due_at = if patch.clear_due_at {
            Some(None)
        } else {
            patch.due_at.clone().map(Some)
        };
        let remind_at = if patch.clear_remind_at {
            Some(None)
        } else {
            patch.remind_at.clone().map(Some)
        };
        let input = TaskInput {
            title,
            description: patch
                .description
                .clone()
                .unwrap_or_else(|| existing.description.clone()),
            priority: patch.priority.or(Some(existing.priority)),
            category: patch.category.clone().or(Some(existing.category.clone())),
            tags: patch.tags.clone().or(Some(existing.tags.clone())),
            due_at,
            remind_at,
            advance_minutes: patch.advance_minutes.or(Some(existing.advance_minutes)),
            recurrence: None,
        };
        let task = update_task_in_conn(conn, id, input)?;
        let revision =
            store::bump_revision(conn, "task", id, principal, &task.updated_at, "")?;
        Ok((task, revision, existing.updated_at))
    })?;
    let _ = prior;
    task.revision = Some(revision);
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "task.update",
            resource_kind: "task",
            resource_id: id,
            project_id: "",
            request_id: "",
            success: true,
            error_code: "",
            detail: "更新任务",
            revision: Some(revision),
            duration_ms: 0,
        },
    );
    Ok(task)
}

/// 完成任务：复用既有切换逻辑（含完成事件、提醒、重复任务期次推进）。
/// 已完成任务再次调用是幂等的，返回当前状态。
pub fn complete_task(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: Option<i64>,
) -> AppResult<Task> {
    perms::require(db, principal, Capability::TasksWrite, id)?;
    let current = get_task(db, id)?;
    if current.status == "completed" {
        return Ok(current);
    }
    let (revision, _) = task_version(db, id)?;
    if let Some(base) = base_revision {
        if base != revision {
            return Err(AppError::Conflict(format!(
                "任务版本已变化（当前 revision={revision}，提交 base_revision={base}）"
            )));
        }
    }
    let mut task = toggle_task_inner(db, id)?;
    let next = db.with_conn(|conn| {
        store::bump_revision(conn, "task", id, principal, &task.updated_at, "")
    })?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "task.complete",
            resource_kind: "task",
            resource_id: id,
            project_id: "",
            request_id: "",
            success: true,
            error_code: "",
            detail: if task.status == "completed" {
                "任务已完成"
            } else {
                "重复任务期次已完成并推进"
            },
            revision: Some(next),
            duration_ms: 0,
        },
    );
    task.revision = Some(next);
    Ok(task)
}

// ── 规划 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct PlanView {
    pub project_id: String,
    pub name: String,
    pub status: String,
    pub target_date: Option<String>,
    pub revision: i64,
    pub updated_at: String,
    pub milestones: Vec<PlanningMilestone>,
    pub features: Vec<PlanningFeature>,
    pub activity: Vec<PlanningActivity>,
    pub progress_percent: i64,
}

fn plan_from_project(
    db: &Db,
    project: PlanningProject,
    with_activity: bool,
) -> AppResult<PlanView> {
    let milestones = list_milestones_impl(db, project.id.clone())?;
    let features = list_features_impl(db, project.id.clone())?;
    let activity = if with_activity {
        activity_page_impl(db, project.id.clone(), None, Some(30), Some(0))?.items
    } else {
        Vec::new()
    };
    let progress = if features.is_empty() {
        0
    } else {
        let done = features.iter().filter(|f| f.status == "completed").count() as i64;
        done * 100 / features.len() as i64
    };
    Ok(PlanView {
        project_id: project.id,
        name: project.name,
        status: project.status,
        target_date: project.target_date,
        revision: project.revision,
        updated_at: project.updated_at,
        milestones,
        features,
        activity,
        progress_percent: progress,
    })
}

pub fn list_plans(
    db: &Db,
    principal: &Principal,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<PlanView>, Page)> {
    perms::require(db, principal, Capability::PlansRead, project_id.unwrap_or(""))?;
    let mut plans = Vec::new();
    match project_id {
        Some(id) => {
            let project = db.with_read(|conn| load_project_tx(conn, id))?;
            plans.push(plan_from_project(db, project, false)?);
        }
        None => {
            for project in list_projects_impl(db, Some(false))? {
                plans.push(plan_from_project(db, project, false)?);
            }
        }
    }
    let total = plans.len() as u32;
    let page = Page::new(limit, offset, total);
    let start = (offset as usize).min(plans.len());
    let end = (start + limit as usize).min(plans.len());
    Ok((plans[start..end].to_vec(), page))
}

/// 当前计划：优先 `in_progress`，其次 `planning`；都没有则返回 None（不猜）。
pub fn current_plan(db: &Db, principal: &Principal) -> AppResult<Option<PlanView>> {
    perms::require(db, principal, Capability::PlansRead, "")?;
    let projects = list_projects_impl(db, Some(false))?;
    let pick = projects
        .iter()
        .find(|p| p.status == "in_progress")
        .or_else(|| projects.iter().find(|p| p.status == "planning"))
        .cloned();
    match pick {
        Some(project) => Ok(Some(plan_from_project(db, project, true)?)),
        None => Ok(None),
    }
}

pub fn get_plan(db: &Db, principal: &Principal, project_id: &str) -> AppResult<PlanView> {
    perms::require(db, principal, Capability::PlansRead, project_id)?;
    let project = db.with_read(|conn| load_project_tx(conn, project_id))?;
    plan_from_project(db, project, true)
}

// ── 知识库 ───────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeBaseInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub document_count: i64,
    pub updated_at: String,
}

pub fn list_knowledge_bases(db: &Db, principal: &Principal) -> AppResult<Vec<KnowledgeBaseInfo>> {
    perms::require(db, principal, Capability::KnowledgeRead, "")?;
    let bases = kb::list_bases_impl(db, None, None)?;
    Ok(bases
        .into_iter()
        .map(|b| KnowledgeBaseInfo {
            id: b.id,
            name: b.name,
            description: b.description,
            kind: b.kind,
            document_count: b.doc_count,
            updated_at: b.updated_at,
        })
        .collect())
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeHit {
    pub doc_id: String,
    pub kb_id: String,
    pub kb_name: String,
    pub title: String,
    pub source_kind: String,
    pub snippet: String,
    pub rank: u8,
    pub updated_at: String,
}

pub fn search_knowledge(
    db: &Db,
    principal: &Principal,
    query: &str,
    kb_ids: &[String],
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<KnowledgeHit>, Page)> {
    perms::require(db, principal, Capability::KnowledgeRead, "")?;
    let page = kb::search_impl(db, query, kb_ids, None, None, limit, offset)?;
    let hits = page
        .hits
        .into_iter()
        .map(|h| KnowledgeHit {
            doc_id: h.doc_id,
            kb_id: h.kb_id,
            kb_name: h.kb_name,
            title: h.title,
            source_kind: h.source_kind,
            snippet: h.snippet,
            rank: h.rank,
            updated_at: h.updated_at,
        })
        .collect();
    Ok((
        hits,
        Page {
            limit,
            offset,
            total: page.total.max(0) as u32,
            has_more: page.has_more,
        },
    ))
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeDoc {
    pub id: String,
    pub kb_id: String,
    pub title: String,
    pub source_kind: String,
    pub source_mode: String,
    pub status: String,
    pub chunk_count: i64,
    pub revision: i64,
    pub content: String,
    pub truncated: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn doc_out(db: &Db, detail: kb::KnowledgeDocumentDetail) -> AppResult<KnowledgeDoc> {
    let doc = detail.document;
    let (counter, counter_at, _) = db.with_read(|conn| {
        store::read_revision(conn, "knowledge", &doc.id)
    })?;
    let revision = store::effective_revision(counter, &counter_at, &doc.updated_at);
    Ok(KnowledgeDoc {
        id: doc.id,
        kb_id: doc.kb_id,
        title: doc.title,
        source_kind: doc.source_kind,
        source_mode: doc.source_mode,
        status: doc.status,
        chunk_count: doc.chunk_count,
        revision,
        content: detail.content,
        truncated: detail.truncated,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
    })
}

pub fn get_knowledge(db: &Db, principal: &Principal, id: &str) -> AppResult<KnowledgeDoc> {
    perms::require(db, principal, Capability::KnowledgeRead, "")?;
    let detail = kb::get_document_impl(db, id)?;
    doc_out(db, detail)
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct KnowledgeCreateInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub kb_id: Option<String>,
    #[serde(default)]
    pub kb_name: Option<String>,
}

const AGENT_INBOX_BASE: &str = "Agent Inbox";

fn resolve_kb(db: &Db, kb_id: Option<&str>, kb_name: Option<&str>) -> AppResult<String> {
    if let Some(id) = kb_id.map(str::trim).filter(|v| !v.is_empty()) {
        db.with_read(|conn| {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM knowledge_bases WHERE id = ?1)",
                rusqlite::params![id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!("知识库不存在: {id}")));
            }
            Ok(())
        })?;
        return Ok(id.to_string());
    }
    let name = kb_name
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(AGENT_INBOX_BASE);
    db.with_read(|conn| {
        let found: Option<String> = conn
            .query_row(
                "SELECT id FROM knowledge_bases WHERE name = ?1 ORDER BY created_at LIMIT 1",
                rusqlite::params![name],
                |r| r.get(0),
            )
            .ok();
        Ok(found)
    })?
    .map_or_else(
        || {
            let base = kb::create_base_impl(
                db,
                kb::KnowledgeBaseInput {
                    name: name.to_string(),
                    description: "由 Agent 写入的知识（默认落点）".into(),
                    kind: "personal".into(),
                    project_id: None,
                    workspace_id: None,
                },
            )?;
            Ok(base.id)
        },
        Ok,
    )
}

pub fn create_knowledge(
    db: &Db,
    principal: &Principal,
    input: KnowledgeCreateInput,
) -> AppResult<KnowledgeDoc> {
    perms::require(db, principal, Capability::KnowledgeWrite, "")?;
    store::check_text("title", &input.title, 200)?;
    let kb_id = resolve_kb(db, input.kb_id.as_deref(), input.kb_name.as_deref())?;
    let (report, doc_id) =
        kb::create_text_impl(db, &kb_id, &input.title, &input.content)?;
    let doc_id = match doc_id {
        Some(id) => id,
        None => {
            // 内容重复：返回库内同 hash 的既有文档，让调用方拿到稳定 id（不新建副本）。
            let hash_doc = db.with_read(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT id FROM knowledge_documents WHERE kb_id = ?1
                     AND content_hash = (SELECT content_hash FROM knowledge_documents
                       WHERE kb_id = ?1 AND title = ?2 ORDER BY updated_at DESC LIMIT 1)
                     ORDER BY updated_at DESC LIMIT 1",
                        rusqlite::params![kb_id, input.title],
                        |r| r.get::<_, String>(0),
                    )
                    .ok())
            })?;
            match hash_doc {
                Some(id) => id,
                None => {
                    return Err(AppError::Conflict(format!(
                        "知识写入未产生文档（{} 条重复），且无法定位既有文档",
                        report.duplicates
                    )))
                }
            }
        }
    };
    let detail = kb::get_document_impl(db, &doc_id)?;
    let updated_at = detail.document.updated_at.clone();
    let revision = db.with_conn(|conn| {
        store::bump_revision(conn, "knowledge", &doc_id, principal, &updated_at, "")
    })?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "knowledge.create",
            resource_kind: "knowledge",
            resource_id: &doc_id,
            project_id: "",
            request_id: "",
            success: true,
            error_code: "",
            detail: "写入知识文档",
            revision: Some(revision),
            duration_ms: 0,
        },
    );
    doc_out(db, detail)
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct KnowledgePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

/// 只允许更新「正文即唯一来源」的文档（text/note/capture）；文件来源必须改原文件后重建索引。
pub fn update_knowledge(
    db: &Db,
    principal: &Principal,
    id: &str,
    patch: KnowledgePatch,
    base_revision: Option<i64>,
) -> AppResult<KnowledgeDoc> {
    perms::require(db, principal, Capability::KnowledgeWrite, "")?;
    let detail = kb::get_document_impl(db, id)?;
    let doc = detail.document;
    let (counter, counter_at, _) = db.with_read(|conn| {
        store::read_revision(conn, "knowledge", id)
    })?;
    let revision = store::effective_revision(counter, &counter_at, &doc.updated_at);
    if let Some(base) = base_revision {
        if base != revision {
            return Err(AppError::Conflict(format!(
                "知识文档版本已变化（当前 revision={revision}，提交 base_revision={base}）"
            )));
        }
    }
    let title = patch.title.unwrap_or(doc.title.clone());
    store::check_text("title", &title, 200)?;
    if patch.content.is_some()
        && !matches!(doc.source_kind.as_str(), "text" | "note" | "capture")
    {
        return Err(validation(format!(
            "文档来源为 {}（{}），正文由来源文件决定，请更新原文件后重建索引",
            doc.source_kind, doc.source_mode
        )));
    }
    let now = crate::agents::now_iso();
    let content_changed = patch.content.is_some();
    db.with_conn(|conn| {
        if content_changed {
            let content = patch.content.unwrap_or_default();
            let content = content.trim().to_string();
            if content.is_empty() {
                return Err(validation("正文不能为空"));
            }
            let hash = {
                use sha2::Digest;
                let digest = sha2::Sha256::digest(content.as_bytes());
                digest.iter().map(|b| format!("{:02x}", b)).collect::<String>()
            };
            conn.execute(
                "UPDATE knowledge_documents SET title=?2, content=?3, size_bytes=?4,
                   content_hash=?5, status='pending', error='', updated_at=?6 WHERE id=?1",
                rusqlite::params![id, title, content, content.len() as i64, hash, now],
            )?;
        } else {
            conn.execute(
                "UPDATE knowledge_documents SET title=?2, updated_at=?3 WHERE id=?1",
                rusqlite::params![id, title, now],
            )?;
        }
        Ok(())
    })?;
    if content_changed {
        kb::reindex_document_impl(db, &data_dir(), id)?;
    }
    let detail = kb::get_document_impl(db, id)?;
    let updated_at = detail.document.updated_at.clone();
    let next = db.with_conn(|conn| {
        store::bump_revision(conn, "knowledge", id, principal, &updated_at, "")
    })?;
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "knowledge.update",
            resource_kind: "knowledge",
            resource_id: id,
            project_id: "",
            request_id: "",
            success: true,
            error_code: "",
            detail: "更新知识文档",
            revision: Some(next),
            duration_ms: 0,
        },
    );
    doc_out(db, detail)
}

// ── 跨类型搜索 ───────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub project_id: String,
    pub updated_at: String,
    pub relevance: i64,
}

fn score(text: &str, keyword: &str) -> i64 {
    let lower = text.to_lowercase();
    let k = keyword.to_lowercase();
    if lower == k {
        100
    } else if lower.starts_with(&k) {
        70
    } else if lower.contains(&k) {
        40
    } else {
        0
    }
}

pub fn search_all(
    db: &Db,
    principal: &Principal,
    query: &str,
    kinds: &[String],
    limit: u32,
) -> AppResult<Vec<SearchHit>> {
    perms::require(db, principal, Capability::ProjectsRead, "")?;
    let q = query.trim();
    if q.is_empty() {
        return Err(validation("搜索关键词不能为空"));
    }
    let want = |kind: &str| kinds.is_empty() || kinds.iter().any(|k| k == kind);
    let mut hits: Vec<SearchHit> = Vec::new();
    if want("task") {
        perms::require(db, principal, Capability::TasksRead, "")?;
        let filter = TaskFilter {
            search: Some(q.to_string()),
            status: Some("all".into()),
            ..Default::default()
        };
        for task in list_tasks_inner(db, filter)? {
            let relevance = score(&task.title, q) + score(&task.description, q) / 2;
            if relevance > 0 {
                hits.push(SearchHit {
                    kind: "task".into(),
                    id: task.id,
                    title: task.title,
                    snippet: truncate(&task.description, 160),
                    project_id: String::new(),
                    updated_at: task.updated_at,
                    relevance,
                });
            }
        }
    }
    if want("knowledge") {
        perms::require(db, principal, Capability::KnowledgeRead, "")?;
        let (items, _) = search_knowledge(db, principal, q, &[], 20, 0)?;
        for hit in items {
            hits.push(SearchHit {
                kind: "knowledge".into(),
                id: hit.doc_id,
                title: hit.title,
                snippet: truncate(&hit.snippet, 200),
                project_id: String::new(),
                updated_at: hit.updated_at,
                relevance: 30 - hit.rank as i64 * 5,
            });
        }
    }
    if want("decision") {
        perms::require(db, principal, Capability::DecisionsRead, "")?;
        let (items, _) = store::list_decisions(db, None, None, 50, 0)?;
        for decision in items {
            let relevance = score(&decision.title, q)
                + score(&decision.decision, q) / 2
                + score(&decision.context, q) / 3;
            if relevance > 0 {
                hits.push(SearchHit {
                    kind: "decision".into(),
                    id: decision.id,
                    title: decision.title,
                    snippet: truncate(&decision.decision, 200),
                    project_id: decision.project_id,
                    updated_at: decision.updated_at,
                    relevance,
                });
            }
        }
    }
    if want("project") {
        let (projects, _) = list_projects(db, principal, None, Some(q), 50, 0)?;
        for project in projects {
            hits.push(SearchHit {
                kind: "project".into(),
                id: project.id.clone(),
                title: project.name,
                snippet: truncate(&project.description, 160),
                project_id: project.id,
                updated_at: project.updated_at,
                relevance: 45,
            });
        }
    }
    hits.sort_by(|a, b| {
        b.relevance
            .cmp(&a.relevance)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.id.cmp(&b.id))
    });
    hits.truncate(limit as usize);
    Ok(hits)
}

fn truncate(raw: &str, max: usize) -> String {
    let flat = raw.replace('\n', " ");
    if flat.chars().count() <= max {
        return flat;
    }
    flat.chars().take(max).collect::<String>() + "…"
}

// ── 系统状态 ─────────────────────────────────────────────────────

pub fn status_snapshot(db: &Db, principal: &Principal) -> AppResult<Value> {
    perms::require_any_read(db, principal)?;
    let counts = db.with_read(|conn| {
        let mut map = serde_json::Map::new();
        for (key, table) in [
            ("tasks", "tasks"),
            ("planning_projects", "planning_projects"),
            ("workspace_projects", "workspace_projects"),
            ("knowledge_bases", "knowledge_bases"),
            ("knowledge_documents", "knowledge_documents"),
            ("decisions", "agent_decisions"),
            ("handoffs", "agent_handoffs"),
            ("reports", "agent_work_reports"),
            ("agents", "mcp_agents"),
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap_or(0);
            map.insert(key.to_string(), json!(n));
        }
        let pending_tasks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        map.insert("pending_tasks".into(), json!(pending_tasks));
        Ok(Value::Object(map))
    })?;
    let workspace = super::workspace::status(db)?;
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": super::PROTOCOL,
        "protocol_version": super::PROTOCOL_VERSION,
        "schema_version": super::SCHEMA_VERSION,
        "counts": counts,
        "workspace": serde_json::to_value(workspace)?,
        "interfaces": {
            "cli": true,
            "mcp": crate::db::Settings::load(db).map(|s| s.mcp_server_enabled).unwrap_or(false),
            "rest": crate::db::Settings::load(db).map(|s| s.agent_api_enabled).unwrap_or(false),
            "filesystem": true,
        },
    }))
}

/// 便捷：保证存在至少一个可解析的 key（用于 CLI 报错信息完整）。
pub fn require_id(value: Option<&str>, name: &str) -> AppResult<String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => Ok(v.to_string()),
        None => Err(missing_arg(name)),
    }
}

