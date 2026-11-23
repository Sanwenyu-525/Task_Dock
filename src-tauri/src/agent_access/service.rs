//! 统一业务服务层：CLI / MCP / REST / 文件 四个入口的读写都经过这里。
//!
//! 为什么这一层存在：四个入口不允许各自实现业务 SQL。任务/规划/知识直接复用既有
//! `*_impl`（同一校验、同一事务、同一活动流），本模块只补：
//! - 统一的项目视图（规划中心 + 项目工作空间）；
//! - 版本读取/推进与冲突拒绝（`agent_resource_revisions` + 业务 `updated_at`）；
//! - 审计（成功写 `agent_activity_logs`）；
//! - 面向 Agent 的 snake_case 输出（知识库既有结构是 camelCase，这里显式映射）。

use std::path::PathBuf;

use rusqlite::OptionalExtension;
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
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    /// 项目根 ID（canonical）。
    pub project_id: String,
    /// 本次返回的功能/里程碑所属计划（可能来自入参计划 ID）。
    pub plan_id: Option<String>,
    pub active_plan_id: Option<String>,
    /// 该项目的全部计划（含归档）。
    pub plans: Vec<crate::project_hub::service::ProjectPlanSummary>,
    pub summary: ProjectSummary,
    pub project: Value,
    pub milestones: Vec<PlanningMilestone>,
    pub features: Vec<PlanningFeature>,
    pub items: Vec<Value>,
    pub tasks: Vec<Value>,
    pub activity: Vec<PlanningActivity>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub project_id: String,
    pub plan_id: Option<String>,
    pub active_plan_id: Option<String>,
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

/// 统一项目摘要：`id` 恒为项目根，计划只作为 `activePlanId` 出现。
///
/// 旧的 `kind=planning|workspace` 不再返回：那是两个「伪实体」，同一项目会出现两行。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    /// 项目类型（general / novel / game / ai_comic / development）
    pub kind: String,
    pub status: String,
    /// 项目描述：事实源是 `workspace_projects.description` 列（PATCH /projects 可写），
    /// 不再混用工作空间「备注」（note）。
    pub description: String,
    /// 项目目标：事实源是 `workspace_projects.goal` 列（PATCH /projects 可写）。
    pub goal: String,
    pub root_path: String,
    pub root_exists: bool,
    pub active_plan_id: Option<String>,
    pub plan_count: i64,
    pub updated_at: String,
    pub revision: i64,
    pub feature_total: i64,
    pub feature_done: i64,
    pub task_total: i64,
    pub item_total: i64,
}

fn project_summary(db: &Db, project: &WorkspaceProject) -> AppResult<ProjectSummary> {
    // 项目根 revision 唯一事实源 = workspace_projects.revision（v93 列），
    // 与 REST PATCH /projects/{id} 的并发判定同一来源；计划 revision 只保护计划行。
    let (plan_count, feature_total, feature_done, active_plan_id, revision, description, goal) = db.with_read(|conn| {
        let row = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM planning_projects WHERE workspace_project_id = ?1),
               (SELECT COUNT(*) FROM planning_features f
                  JOIN planning_projects p ON p.id = f.project_id
                 WHERE p.workspace_project_id = ?1),
               (SELECT COUNT(*) FROM planning_features f
                  JOIN planning_projects p ON p.id = f.project_id
                 WHERE p.workspace_project_id = ?1 AND f.status = 'completed'),
               (SELECT active_plan_id FROM workspace_projects WHERE id = ?1),
               (SELECT revision FROM workspace_projects WHERE id = ?1),
               (SELECT COALESCE(description, '') FROM workspace_projects WHERE id = ?1),
               (SELECT COALESCE(goal, '') FROM workspace_projects WHERE id = ?1)
             ",
            rusqlite::params![project.id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )?;
        Ok(row)
    })?;
    Ok(ProjectSummary {
        id: project.id.clone(),
        name: project.name.clone(),
        kind: project.kind.clone(),
        status: project.status.clone(),
        description,
        goal,
        root_path: project.root_path.clone(),
        root_exists: project.root_exists,
        active_plan_id,
        plan_count,
        updated_at: project.updated_at.clone(),
        revision,
        feature_total,
        feature_done,
        task_total: project.task_link_count,
        item_total: project.item_count,
    })
}

/// 项目列表：**每个项目根一行**，计划不再作为独立项目出现。
///
/// 授权过滤（统一模型）：全局 `projects.read`（readonly 或授权了全部项目）返回所有项目；
/// 只有项目级授权（能力 resource_id 或 `mcp_agent_grants`）的 Agent 只看到被授权的项目；
/// 什么授权都没有返回 FORBIDDEN。`total` 是过滤后的数量。
///
/// `kind` 参数保留兼容：`planning` / `workspace` 是旧调用方的伪类型，按「全部项目」处理；
/// 其他值按项目类型过滤（general / novel / ...）。
pub fn list_projects(
    db: &Db,
    principal: &Principal,
    kind: Option<&str>,
    q: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<ProjectSummary>, Page)> {
    let reads = perms::authorized_reads(db, principal)?;
    if reads.projects.is_empty() {
        return Err(perms::denial(Capability::ProjectsRead));
    }
    let keyword = q.map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty());
    let kind_filter = kind
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "planning" && *v != "workspace");
    let mut out: Vec<ProjectSummary> = Vec::new();
    for project in workspace_project_list_impl(db, None)? {
        if !reads.projects.allows(&project.id) {
            continue;
        }
        let summary = project_summary(db, &project)?;
        if let Some(kind) = kind_filter {
            if summary.kind != kind {
                continue;
            }
        }
        if let Some(keyword) = &keyword {
            if !summary.name.to_lowercase().contains(keyword)
                && !summary.description.to_lowercase().contains(keyword)
            {
                continue;
            }
        }
        out.push(summary);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
    let total = out.len() as u32;
    let page = Page::new(limit, offset, total);
    let start = (offset as usize).min(out.len());
    let end = (start + limit as usize).min(out.len());
    Ok((out[start..end].to_vec(), page))
}

/// 解析合法项目根；旧计划缺项目根时在事务内补建（与 v78 迁移同一规则）。
fn resolve_or_repair_project(db: &Db, id: &str) -> AppResult<Option<(String, Option<String>)>> {
    let resolved = db.with_read(|conn| crate::project_hub::service::resolve_project_ref(conn, id))?;
    match resolved {
        Some(crate::project_hub::service::ProjectRef::Project(project_id)) => {
            Ok(Some((project_id.0, None)))
        }
        Some(crate::project_hub::service::ProjectRef::Plan { plan_id, project_id }) => {
            Ok(Some((project_id.0, Some(plan_id.0))))
        }
        None => {
            let repaired = db.with_transaction(|conn| {
                crate::project_hub::service::ensure_project_for_plan_tx(conn, id)
            });
            match repaired {
                Ok(project_id) => Ok(Some((project_id, Some(id.to_string())))),
                Err(AppError::Validation(_)) | Err(AppError::NotFound(_)) => Ok(None),
                Err(error) => Err(error),
            }
        }
    }
}

pub fn get_project(db: &Db, principal: &Principal, id: &str) -> AppResult<ProjectDetail> {
    let id = id.trim();
    if id.is_empty() {
        return Err(missing_arg("project_id"));
    }
    let (project_id, requested_plan) = resolve_or_repair_project(db, id)?
        .ok_or_else(|| AppError::NotFound(format!("项目不存在: {id}")))?;
    // 授权一律按项目根判定：计划 ID 只是入参兼容，不能成为跨项目授权的入口。
    perms::require(db, principal, Capability::ProjectsRead, &project_id)?;

    let project = workspace_project_get_impl(db, &project_id)?;
    let active_plan_id: Option<String> = db.with_read(|conn| {
        conn.query_row(
            "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)
    })?;
    let plans = db.with_read(|conn| crate::project_hub::service::list_plan_summaries(conn, &project_id))?;
    let plan_id = requested_plan
        .or_else(|| {
            plans
                .iter()
                .find(|plan| plan.is_active && !plan.archived)
                .map(|plan| plan.id.clone())
        })
        .or_else(|| plans.first().map(|plan| plan.id.clone()));

    let (milestones, features, activity) = match plan_id.as_deref() {
        Some(plan_id) => {
            let milestones = list_milestones_impl(db, plan_id.to_string())?;
            let features = list_features_impl(db, plan_id.to_string())?;
            let activity = activity_page_impl(db, plan_id.to_string(), None, Some(20), Some(0))?
                .items;
            (milestones, features, activity)
        }
        None => (Vec::new(), Vec::new(), Vec::new()),
    };
    let links = workspace_task_link_list_impl(db, &project_id)?;
    let items = workspace_item_list_impl(db, &project_id)?;
    let mut project_value = serde_json::to_value(&project)?;
    if let Some(object) = project_value.as_object_mut() {
        object.insert("projectId".into(), json!(project_id));
        object.insert("activePlanId".into(), json!(active_plan_id));
        object.insert("planCount".into(), json!(plans.len()));
    }
    Ok(ProjectDetail {
        project_id: project_id.clone(),
        plan_id: plan_id.clone(),
        active_plan_id: active_plan_id.clone(),
        plans,
        summary: project_summary(db, &project)?,
        project: project_value,
        milestones,
        features,
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
        activity,
    })
}

pub fn project_status(db: &Db, principal: &Principal, id: &str) -> AppResult<ProjectStatus> {
    let detail = get_project(db, principal, id)?;
    let mut blocked = Vec::new();
    let mut next_steps = Vec::new();
    let mut progress = 0i64;
    let mut by_status = std::collections::BTreeMap::<String, i64>::new();
    for feature in &detail.features {
        *by_status.entry(feature.status.clone()).or_insert(0) += 1;
        if feature.status == "blocked" {
            blocked.push(json!({ "feature_id": feature.id, "title": feature.title, "priority": feature.priority }));
        }
        if feature.status != "completed" && feature.status != "paused" {
            for step in &feature.steps {
                if !step.done {
                    next_steps.push(format!("{} / {}", feature.title, step.title));
                }
            }
        }
    }
    if !detail.features.is_empty() {
        let done = by_status.get("completed").copied().unwrap_or(0);
        progress = done * 100 / detail.features.len() as i64;
    }
    next_steps.truncate(20);
    Ok(ProjectStatus {
        project_id: detail.project_id.clone(),
        plan_id: detail.plan_id.clone(),
        active_plan_id: detail.active_plan_id.clone(),
        name: detail.summary.name.clone(),
        kind: detail.summary.kind.clone(),
        status: detail.summary.status.clone(),
        progress_percent: progress,
        counts: json!({
            "features": by_status,
            "milestones": detail.milestones.len(),
            "plans": detail.plans.len(),
            "tasks": detail.tasks.len(),
            "items": detail.summary.item_total,
        }),
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
    create_task_guarded(db, principal, input, &store::NoGuard, "")
}

/// 带**事务内守卫**的创建（v82 文件导入用）。
///
/// `guard.check(conn)` 与业务写入、`guard.complete(conn)` 位于**同一个写事务**内：
/// 校验不通过 → 整个事务回滚，业务数据零写入；租约与业务数据同时提交。
///
/// `project_id` 非空时，任务与项目关联也在同一事务内落库，
/// 避免「任务已建、关联失败」造成重试时重复建任务。
pub fn create_task_guarded(
    db: &Db,
    principal: &Principal,
    input: TaskCreateInput,
    guard: &dyn store::WriteGuard,
    project_id: &str,
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
    let project_id = project_id.trim().to_string();
    let (mut task, revision) = db.with_transaction(|conn| {
        guard.check(conn)?;
        let id = create_task_tx(conn, task_input)?;
        if !project_id.is_empty() {
            crate::commands::project_workspace::workspace_task_link_add_tx(
                conn,
                &project_id,
                &id,
            )?;
        }
        let task = get_task_in_conn(conn, &id)?;
        let revision =
            store::bump_revision(conn, "task", &id, principal, &task.updated_at, "")?;
        guard.record_operation(conn, "task", &id)?;
        guard.complete(conn)?;
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
            project_id: &project_id,
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
    update_task_guarded(db, principal, id, patch, base_revision, &store::NoGuard)
}

/// 带**事务内守卫**的局部更新（v82 文件导入用）。
///
/// 守卫与业务写入同事务：租约失效时更新整体回滚，不会产生「版本已推进但业务未改」。
pub fn update_task_guarded(
    db: &Db,
    principal: &Principal,
    id: &str,
    patch: TaskPatch,
    base_revision: Option<i64>,
    guard: &dyn store::WriteGuard,
) -> AppResult<Task> {
    perms::require(db, principal, Capability::TasksWrite, id)?;
    let (mut task, revision, prior) = db.with_transaction(|conn| {
        guard.check(conn)?;
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
        guard.record_operation(conn, "task", id)?;
        guard.complete(conn)?;
        Ok((task, revision, existing.updated_at))
    })?;
    let _ = prior;
    task.revision = Some(revision);
    let project_id = task_project_id(db, id);
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "task.update",
            resource_kind: "task",
            resource_id: id,
            project_id: &project_id,
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

/// 完成任务：**完成语义**，绝不触发「重新打开」。
///
/// 普通入口与文件导入入口共用 [`complete_task_guarded`]：状态切换、提醒、
/// 重复任务期次推进、版本推进与守卫全部落在**同一个写事务**里。已完成任务
/// 再次调用是幂等终态（不写库、不推进 revision）。
pub fn complete_task(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: Option<i64>,
) -> AppResult<Task> {
    complete_task_guarded(db, principal, id, base_revision, &store::NoGuard)
}

/// 带**事务内守卫**的完成任务（v82 文件导入 / REST 幂等共用）。
///
/// 语义固定为 `pending → completed`（重复任务为「消耗当前期次并推进」）：
/// - 已完成任务：幂等返回当前状态，不再写库；
/// - 其它状态（cancelled 等）：`CONFLICT`，不得被静默改成 completed；
/// - revision 校验、业务写入、版本推进、守卫收尾同事务提交，
///   任一步失败整体回滚，不会出现「状态变了但 revision 未变」。
pub fn complete_task_guarded(
    db: &Db,
    principal: &Principal,
    id: &str,
    base_revision: Option<i64>,
    guard: &dyn store::WriteGuard,
) -> AppResult<Task> {
    perms::require(db, principal, Capability::TasksWrite, id)?;
    let now = crate::agents::now_iso();
    let (mut task, next) = db.with_transaction(|conn| {
        guard.check(conn)?;
        let task = get_task_in_conn(conn, id)?;
        let (counter, counter_at, _) = store::read_revision(conn, "task", id)?;
        let effective = store::effective_revision(counter, &counter_at, &task.updated_at);
        if let Some(base) = base_revision {
            if base != effective {
                return Err(AppError::Conflict(format!(
                    "任务版本已变化（当前 revision={effective}，updated_at={}，提交 base_revision={base}）",
                    task.updated_at
                )));
            }
        }
        if task.status == "completed" {
            // 幂等终态：业务不写、版本不推进，只回传当前状态。
            return Ok((task, effective));
        }
        if task.status != "pending" {
            return Err(AppError::Conflict(format!(
                "任务当前状态为 {}，无法完成",
                task.status
            )));
        }
        let updated = if task.recurrence.is_some() {
            // 重复任务：完成即消耗当前期次并推进（期次 CAS 保证不重复推进）。
            let outcome =
                crate::scheduler::advance_recurrence_tx(conn, id, task.due_at.as_deref(), &chrono::Utc::now())?;
            match &outcome {
                crate::scheduler::AdvanceOutcome::Advanced { from_due, .. } => {
                    crate::task_analytics::record_completion(
                        conn,
                        id,
                        &now,
                        from_due.as_deref(),
                        &task.category,
                        task.priority as i64,
                        "recurring",
                    )?;
                    get_task_in_conn(conn, id)?
                }
                // 并发完成同一期：期次已被推进，本次不重复记录完成事件。
                crate::scheduler::AdvanceOutcome::Conflict => {
                    return Err(AppError::Conflict(
                        "重复任务期次已被其他请求推进，请刷新后重试".into(),
                    ))
                }
                // 规则结束 / 无规则：按普通任务完成处理。
                crate::scheduler::AdvanceOutcome::Exhausted
                | crate::scheduler::AdvanceOutcome::NoRule => {
                    mark_task_completed(conn, id, &task, &now)?
                }
            }
        } else {
            mark_task_completed(conn, id, &task, &now)?
        };
        let revision = store::bump_revision(conn, "task", id, principal, &updated.updated_at, "")?;
        guard.record_operation(conn, "task", id)?;
        guard.complete(conn)?;
        Ok((updated, revision))
    })?;
    let project_id = task_project_id(db, id);
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "task.complete",
            resource_kind: "task",
            resource_id: id,
            project_id: &project_id,
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

/// 普通任务完成：条件更新 + 提醒关闭 + 完成统计，全部在调用方事务内。
fn mark_task_completed(
    conn: &rusqlite::Connection,
    id: &str,
    task: &Task,
    now: &str,
) -> AppResult<Task> {
    let changed = conn.execute(
        "UPDATE tasks SET status='completed', completed_at=?1, updated_at=?1
         WHERE id=?2 AND status='pending' AND updated_at=?3",
        rusqlite::params![now, id, task.updated_at],
    )?;
    if changed != 1 {
        return Err(AppError::Conflict("任务已发生变化，请刷新后重试".into()));
    }
    conn.execute(
        "UPDATE task_reminders SET fired=1, fired_at=?1 WHERE task_id=?2 AND fired=0",
        rusqlite::params![now, id],
    )?;
    crate::task_analytics::record_completion(
        conn,
        id,
        now,
        task.due_at.as_deref(),
        &task.category,
        task.priority as i64,
        "once",
    )?;
    get_task_in_conn(conn, id)
}

/// 任务真实归属项目（活动日志与权限过滤共用）；无关联返回空串。
fn task_project_id(db: &Db, task_id: &str) -> String {
    db.with_read(|conn| perms::task_project(conn, task_id))
        .ok()
        .flatten()
        .unwrap_or_default()
}

// ── 规划 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    /// 计划 ID（`planning_projects.id`）。
    pub id: String,
    /// 所属项目根 ID（`workspace_projects.id`）——授权与上下文一律用它。
    pub project_id: String,
    pub name: String,
    pub status: String,
    pub is_active: bool,
    pub archived: bool,
    pub target_date: Option<String>,
    pub revision: i64,
    pub updated_at: String,
    pub milestones: Vec<PlanningMilestone>,
    pub features: Vec<PlanningFeature>,
    pub activity: Vec<PlanningActivity>,
    pub progress_percent: i64,
}

fn plan_view_from_plan(
    db: &Db,
    summary: crate::project_hub::service::ProjectPlanSummary,
    with_activity: bool,
) -> AppResult<PlanView> {
    let milestones = list_milestones_impl(db, summary.id.clone())?;
    let features = list_features_impl(db, summary.id.clone())?;
    let activity = if with_activity {
        activity_page_impl(db, summary.id.clone(), None, Some(30), Some(0))?.items
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
        id: summary.id,
        project_id: summary.project_id,
        name: summary.name,
        status: summary.status,
        is_active: summary.is_active,
        archived: summary.archived,
        target_date: summary.target_date,
        revision: summary.revision,
        updated_at: summary.updated_at,
        milestones,
        features,
        activity,
        progress_percent: progress,
    })
}

fn plan_view_from_legacy_project(
    db: &Db,
    project: PlanningProject,
    with_activity: bool,
) -> AppResult<PlanView> {
    let project_id = db.with_read(|conn| {
        crate::project_hub::service::resolve_project_root(conn, &project.id)
    })?;
    let summary = crate::project_hub::service::ProjectPlanSummary {
        id: project.id,
        project_id: project_id.unwrap_or_default(),
        name: project.name,
        description: project.description,
        status: project.status,
        target_date: project.target_date,
        is_active: true,
        archived: false,
        revision: project.revision,
        created_at: project.created_at,
        updated_at: project.updated_at,
    };
    plan_view_from_plan(db, summary, with_activity)
}

/// 计划列表（独立于项目列表）。`projectId` 可传项目根或计划 ID 过滤。
pub fn list_plans(
    db: &Db,
    principal: &Principal,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<PlanView>, Page)> {
    let filter_root = match project_id.map(str::trim).filter(|v| !v.is_empty()) {
        Some(id) => Some(
            db.with_read(|conn| crate::project_hub::service::resolve_project_root(conn, id))?
                .ok_or_else(|| AppError::NotFound(format!("项目不存在: {id}")))?,
        ),
        None => None,
    };
    perms::require(
        db,
        principal,
        Capability::PlansRead,
        filter_root.as_deref().unwrap_or(""),
    )?;
    let mut plans = Vec::new();
    match filter_root {
        Some(root) => {
            let summaries = db.with_read(|conn| {
                crate::project_hub::service::list_plan_summaries(conn, &root)
            })?;
            for summary in summaries {
                plans.push(plan_view_from_plan(db, summary, false)?);
            }
        }
        None => {
            for project in list_projects_impl(db, Some(true))? {
                plans.push(plan_view_from_legacy_project(db, project, false)?);
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
    let plans = db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT p.id FROM planning_projects p
             WHERE p.archived = 0
             ORDER BY CASE p.status WHEN 'in_progress' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END,
                      p.updated_at DESC
             LIMIT 1",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })?;
    match plans.first() {
        Some(plan_id) => {
            let summary =
                db.with_read(|conn| crate::project_hub::service::load_plan_summary(conn, plan_id))?;
            Ok(Some(plan_view_from_plan(db, summary, true)?))
        }
        None => Ok(None),
    }
}

/// 计划详情：**入参严格是计划 ID**（`planning_projects.id`）。
///
/// 项目根 ID 不再自动解析成 active 计划：同一路径的 GET/PATCH 必须同义，
/// 否则 `/plans/{id}` 的 id 在读写两侧含义不同。项目根 → active 计划请用
/// [`current_plan`]（`GET /api/v1/plans/current`）或 `get_project`（含 activePlanId）。
pub fn get_plan(db: &Db, principal: &Principal, id: &str) -> AppResult<PlanView> {
    let (root, plan_hint) = match db
        .with_read(|conn| crate::project_hub::service::resolve_project_ref(conn, id))?
    {
        Some(crate::project_hub::service::ProjectRef::Project(_)) => {
            return Err(AppError::Validation(format!(
                "{id} 是项目根 ID，不是计划；请使用 GET /api/v1/projects/{id} 读取项目根，或 GET /api/v1/plans/current 读取当前计划"
            )));
        }
        Some(crate::project_hub::service::ProjectRef::Plan {
            plan_id,
            project_id,
        }) => (project_id.0, Some(plan_id.0)),
        None => return Err(AppError::NotFound(format!("计划不存在: {id}"))),
    };
    perms::require(db, principal, Capability::PlansRead, &root)?;
    let plan_id = plan_hint.ok_or_else(|| AppError::NotFound(format!("计划不存在: {id}")))?;
    let summary =
        db.with_read(|conn| crate::project_hub::service::load_plan_summary(conn, &plan_id))?;
    plan_view_from_plan(db, summary, true)
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

// ── 统一授权查询（v82）────────────────────────────────────────────
//
// 四个入口不允许再直接调用 `store::list_*` / `store::get_*`。所有读取都在这里
// 完成「身份 → 能力 → 资源真实归属」判定，并返回已过滤结果或明确的 FORBIDDEN。
// 1) 认证通过但未授权 = FORBIDDEN，不返回空列表让调用方猜；
// 2) 未知项目/资源不回退全局授权；
// 3) 过滤在服务端 SQL 完成，分页与 total 同步正确，不依赖前端。

/// 决策列表（授权过滤）。
pub fn list_decisions_authorized(
    db: &Db,
    principal: &Principal,
    project: Option<&str>,
    status: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<store::Decision>, Page)> {
    let limit = limit.clamp(1, 200);
    if let Some(pid) = project.map(str::trim).filter(|v| !v.is_empty()) {
        // 过滤入参兼容计划 ID：解析到项目根后按根判定与查询。
        let root = db
            .with_read(|conn| perms::resolve_project_root(conn, pid))?
            .ok_or_else(|| AppError::NotFound(format!("项目不存在: {pid}")))?;
        // 精确项目读取：能力必须覆盖该项目；未授权直接 FORBIDDEN。
        perms::require(db, principal, Capability::DecisionsRead, &root)?;
        return store::list_decisions(db, Some(&root), status, limit, offset);
    }
    let reads = perms::authorized_reads(db, principal)?;
    if reads.decisions.global {
        return store::list_decisions(db, None, status, limit, offset);
    }
    if reads.decisions.ids.is_empty() {
        return Err(perms::denial(Capability::DecisionsRead));
    }
    let projects: Vec<String> = reads.decisions.ids.iter().cloned().collect();
    store::list_decisions_in_projects(db, &projects, false, status, limit, offset)
}

/// 决策详情（授权过滤）：真实项目归属决定可见性。
pub fn get_decision_authorized(
    db: &Db,
    principal: &Principal,
    id: &str,
) -> AppResult<store::Decision> {
    let decision = store::get_decision(db, id)?;
    let project = decision.project_id.trim();
    if project.is_empty() {
        // 无项目决策只对全局 decisions.read 可见。
        perms::require(db, principal, Capability::DecisionsRead, "")?;
        return Ok(decision);
    }
    // 历史行可能以计划 ID 归属：解析到项目根再判定；解析不出（悬空旧数据）
    // 按无授权处理，不静默放行。
    let scope = db
        .with_read(|conn| perms::resolve_project_root(conn, project))?
        .unwrap_or_default();
    perms::require(db, principal, Capability::DecisionsRead, &scope)?;
    Ok(decision)
}

/// 活动记录（授权过滤）。没有项目范围的活动（`rest.failed` 等）只对本机
/// 身份或对应能力的全局授权可见。
pub fn list_activity_authorized(
    db: &Db,
    principal: &Principal,
    query: &store::ActivityQuery,
) -> AppResult<(Vec<store::ActivityRecord>, Page)> {
    let reads = perms::authorized_reads(db, principal)?;
    if matches!(
        principal.identity,
        super::Identity::LocalHuman | super::Identity::SystemInternal
    ) {
        return store::list_activity_scoped(db, query, None);
    }
    if reads.is_empty() {
        return Err(super::forbidden("没有任何可读取的资源，活动记录不可见"));
    }
    // 项目全局读：活动本质是项目内元数据，可直接放开。
    if reads.projects.global {
        return store::list_activity_scoped(db, query, None);
    }
    let mut scope = store::ActivityScope {
        projects: reads.projects.ids.iter().cloned().collect(),
        tasks: reads.tasks.ids.iter().cloned().collect(),
        knowledge: reads.knowledge.ids.iter().cloned().collect(),
        decisions: reads.decisions.ids.iter().cloned().collect(),
        handoffs: reads.handoffs.ids.iter().cloned().collect(),
        plans: reads.plans.ids.iter().cloned().collect(),
        global_kinds: Vec::new(),
    };
    if reads.tasks.global {
        scope.global_kinds.push("task".into());
    }
    if reads.knowledge.global {
        scope.global_kinds.push("knowledge".into());
    }
    if reads.decisions.global {
        scope.global_kinds.push("decision".into());
    }
    if reads.handoffs.global {
        scope.global_kinds.push("handoff".into());
        scope.global_kinds.push("report".into());
    }
    if reads.plans.global {
        scope.global_kinds.push("plan".into());
    }
    if scope.hides_everything() {
        return Err(super::forbidden("没有任何可读取的资源，活动记录不可见"));
    }
    store::list_activity_scoped(db, query, Some(&scope))
}

/// 授权后的知识库 ID 集合：`None` = 全局授权。
pub fn authorized_knowledge_base_ids(
    db: &Db,
    principal: &Principal,
) -> AppResult<Option<Vec<String>>> {
    let reads = perms::authorized_reads(db, principal)?;
    if reads.knowledge.global {
        return Ok(None);
    }
    if reads.knowledge.ids.is_empty() {
        return Err(perms::denial(Capability::KnowledgeRead));
    }
    let ids: Vec<String> = reads.knowledge.ids.iter().cloned().collect();
    let n = ids.len();
    let block = |start: usize| {
        (start..start + n)
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let (ph_id, ph_project, ph_workspace) = (block(1), block(n + 1), block(2 * n + 1));
    let allowed = db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT id FROM knowledge_bases
             WHERE id IN ({ph_id})
                OR (project_id IS NOT NULL AND project_id <> '' AND project_id IN ({ph_project}))
                OR (workspace_id IS NOT NULL AND workspace_id <> '' AND workspace_id IN ({ph_workspace}))"
        ))?;
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        for _ in 0..3 {
            params.extend(ids.iter().map(|v| rusqlite::types::Value::Text(v.clone())));
        }
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            r.get::<_, String>(0)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok::<_, AppError>(out)
    })?;
    Ok(Some(allowed))
}

/// 知识索引（不含正文）授权过滤：权限判定先于数据导出。
pub fn knowledge_index_authorized(db: &Db, principal: &Principal) -> AppResult<Value> {
    let allowed = authorized_knowledge_base_ids(db, principal)?;
    let Some(allowed) = allowed else {
        return super::projection::export_knowledge_snapshot(db);
    };
    let allowed: std::collections::HashSet<String> = allowed.into_iter().collect();
    let snapshot = super::projection::export_knowledge_snapshot(db)?;
    let mut bases = Vec::new();
    if let Some(items) = snapshot.get("bases").and_then(Value::as_array) {
        for base in items {
            let id = base.get("id").and_then(Value::as_str).unwrap_or("");
            if allowed.contains(id) {
                bases.push(base.clone());
            }
        }
    }
    let mut docs = Vec::new();
    if let Some(items) = snapshot.get("documents").and_then(Value::as_array) {
        for doc in items {
            let kb_id = doc.get("kb_id").and_then(Value::as_str).unwrap_or("");
            if allowed.contains(kb_id) {
                docs.push(doc.clone());
            }
        }
    }
    Ok(json!({ "bases": bases, "documents": docs }))
}

pub fn search_knowledge(
    db: &Db,
    principal: &Principal,
    query: &str,
    kb_ids: &[String],
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<KnowledgeHit>, Page)> {
    let allowed = authorized_knowledge_base_ids(db, principal)?;
    let scoped: Vec<String> = if kb_ids.is_empty() {
        match &allowed {
            None => Vec::new(),
            Some(ids) => {
                if ids.is_empty() {
                    return Ok((
                        Vec::new(),
                        Page {
                            limit,
                            offset,
                            total: 0,
                            has_more: false,
                        },
                    ));
                }
                ids.clone()
            }
        }
    } else {
        for kb_id in kb_ids {
            let id = kb_id.trim();
            if id.is_empty() {
                continue;
            }
            if let Some(allowed) = &allowed {
                if !allowed.iter().any(|v| v == id) {
                    return Err(perms::denial(Capability::KnowledgeRead));
                }
            }
            let exists = db.with_read(|conn| {
                let n: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM knowledge_bases WHERE id = ?1",
                    rusqlite::params![id],
                    |r| r.get(0),
                )?;
                Ok::<_, AppError>(n > 0)
            })?;
            if !exists {
                return Err(AppError::NotFound(format!("知识库不存在: {id}")));
            }
        }
        kb_ids.to_vec()
    };
    let page = kb::search_impl(db, query, &scoped, None, None, limit, offset)?;
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
    // 先读文档取真实知识库归属，再按知识库授权判定（资源级，不是前端过滤）。
    let detail = kb::get_document_impl(db, id)?;
    let kb_id = detail.document.kb_id.clone();
    match authorized_knowledge_base_ids(db, principal)? {
        None => {}
        Some(allowed) => {
            if !allowed.iter().any(|v| v == &kb_id) {
                return Err(perms::denial(Capability::KnowledgeRead));
            }
        }
    }
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
    create_knowledge_guarded(db, principal, input, &store::NoGuard)
}

/// 带**事务内守卫**的知识写入（v82 文件导入用）。
///
/// 知识文档写入与导入租约校验落在同一个写事务内：租约失效时文档写入整体回滚，
/// 不会留下「文档已存在但租约未完成」的重复导入窗口。
pub fn create_knowledge_guarded(
    db: &Db,
    principal: &Principal,
    input: KnowledgeCreateInput,
    guard: &dyn store::WriteGuard,
) -> AppResult<KnowledgeDoc> {
    perms::require(db, principal, Capability::KnowledgeWrite, "")?;
    store::check_text("title", &input.title, 200)?;
    let kb_id = resolve_kb(db, input.kb_id.as_deref(), input.kb_name.as_deref())?;
    let title = input.title.clone();
    let content = input.content.clone();
    let (report, doc_id, created_revision) = db.with_transaction(|conn| {
        guard.check(conn)?;
        let (report, doc_id) = kb::create_text_impl_in_conn(conn, &kb_id, &title, &content)?;
        // 版本推进与文档写入同事务：不存在「文档已建但版本未记」的窗口。
        let (revision, created_id) = match doc_id.as_deref() {
            Some(id) => {
                let updated_at: String = conn.query_row(
                    "SELECT updated_at FROM knowledge_documents WHERE id=?1",
                    rusqlite::params![id],
                    |r| r.get(0),
                )?;
                let revision =
                    store::bump_revision(conn, "knowledge", id, principal, &updated_at, "")?;
                (Some(revision), Some(id.to_string()))
            }
            None => (None, None),
        };
        if let Some(id) = created_id.as_deref() {
            guard.record_operation(conn, "knowledge", id)?;
        }
        guard.complete(conn)?;
        Ok((report, doc_id, revision))
    })?;
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
    let revision = match created_revision {
        Some(revision) => revision,
        // 重复内容：既有文档没有新写入，回读当前有效版本，不额外推进。
        None => {
            let (counter, counter_at, _) = db.with_read(|conn| {
                store::read_revision(conn, "knowledge", &doc_id)
            })?;
            store::effective_revision(
                counter,
                &counter_at,
                &detail.document.updated_at,
            )
        }
    };
    let project_id = knowledge_project_id(db, &detail.document.kb_id);
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "knowledge.create",
            resource_kind: "knowledge",
            resource_id: &doc_id,
            project_id: &project_id,
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
    update_knowledge_guarded(db, principal, id, patch, base_revision, &store::NoGuard)
}

/// 带**事务内守卫**的知识更新（v82 文件导入 / REST 幂等共用）。
///
/// 一致性要点：
/// - revision 校验在事务内基于业务行 `updated_at` 重新计算，不信任事务外快照；
/// - 文档更新、`status='pending'` 与 revision 推进**同事务提交**，
///   不会出现「正文已改但 revision 未变」或反向的不一致；
/// - 索引重建在事务外执行（避免长事务）；失败时文档保持 `pending` 且写入
///   `error`，由 [`repair_pending_knowledge`] 在后续检索/状态查询时重试，
///   最终与文档正文一致。
pub fn update_knowledge_guarded(
    db: &Db,
    principal: &Principal,
    id: &str,
    patch: KnowledgePatch,
    base_revision: Option<i64>,
    guard: &dyn store::WriteGuard,
) -> AppResult<KnowledgeDoc> {
    perms::require(db, principal, Capability::KnowledgeWrite, "")?;
    let title = patch.title.clone();
    if let Some(title) = title.as_deref() {
        store::check_text("title", title, 200)?;
    }
    let content = patch.content.clone();
    let content_changed = content.is_some();
    let now = crate::agents::now_iso();
    let next = db.with_transaction(|conn| {
        guard.check(conn)?;
        let (doc_title, source_kind, source_mode, doc_updated_at): (String, String, String, String) =
            conn.query_row(
                "SELECT title, source_kind, source_mode, updated_at FROM knowledge_documents WHERE id=?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::NotFound(format!("知识文档不存在: {id}")))?;
        let (counter, counter_at, _) = store::read_revision(conn, "knowledge", id)?;
        let revision = store::effective_revision(counter, &counter_at, &doc_updated_at);
        if let Some(base) = base_revision {
            if base != revision {
                return Err(AppError::Conflict(format!(
                    "知识文档版本已变化（当前 revision={revision}，提交 base_revision={base}）"
                )));
            }
        }
        if content_changed && !matches!(source_kind.as_str(), "text" | "note" | "capture") {
            return Err(validation(format!(
                "文档来源为 {source_kind}（{source_mode}），正文由来源文件决定，请更新原文件后重建索引"
            )));
        }
        let title = title.unwrap_or(doc_title);
        if let Some(content) = content {
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
        let next = store::bump_revision(conn, "knowledge", id, principal, &now, "")?;
        guard.record_operation(conn, "knowledge", id)?;
        guard.complete(conn)?;
        Ok(next)
    })?;
    // 索引重建在事务外：失败不撤销正文（正文已提交），但留下可恢复的 pending 状态。
    if content_changed {
        if let Err(err) = kb::reindex_document_impl(db, &data_dir(), id) {
            tracing::warn!("知识文档 {id} 索引重建失败，保持 pending 待重试: {err}");
            let _ = db.with_conn(|conn| {
                conn.execute(
                    "UPDATE knowledge_documents SET status='pending', error=?2 WHERE id=?1",
                    rusqlite::params![id, truncate(&err.user_message(), 500)],
                )
                .map(|_| ())
                .map_err(AppError::from)
            });
        }
    }
    let detail = kb::get_document_impl(db, id)?;
    let project_id = knowledge_project_id(db, &detail.document.kb_id);
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: "knowledge.update",
            resource_kind: "knowledge",
            resource_id: id,
            project_id: &project_id,
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

/// 重试索引失败的 pending 文档（有界，避免把长索引塞进请求路径）。
///
/// 返回成功重建的数量。单次最多 20 篇，失败保持 pending，下一次继续。
pub fn repair_pending_knowledge(db: &Db, kb_id: Option<&str>) -> AppResult<u32> {
    let ids: Vec<String> = db.with_read(|conn| {
        let (sql, params): (&str, Vec<rusqlite::types::Value>) = match kb_id {
            Some(kb) => (
                "SELECT id FROM knowledge_documents WHERE status='pending' AND kb_id=?1
                 ORDER BY updated_at LIMIT 20",
                vec![rusqlite::types::Value::Text(kb.to_string())],
            ),
            None => (
                "SELECT id FROM knowledge_documents WHERE status='pending'
                 ORDER BY updated_at LIMIT 20",
                Vec::new(),
            ),
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok::<_, AppError>(out)
    })?;
    let mut repaired = 0u32;
    for id in ids {
        if kb::reindex_document_impl(db, &data_dir(), &id).is_ok() {
            repaired += 1;
        }
    }
    Ok(repaired)
}

/// 知识库真实归属项目（活动日志与权限过滤共用）；无归属返回空串。
fn knowledge_project_id(db: &Db, kb_id: &str) -> String {
    db.with_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT COALESCE(NULLIF(project_id,''), NULLIF(workspace_id,''), '')
                 FROM knowledge_bases WHERE id=?1",
                rusqlite::params![kb_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(AppError::from)?
            .unwrap_or_default())
    })
    .unwrap_or_default()
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

