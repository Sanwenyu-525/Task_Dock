//! 项目中枢读模型与“自然语言草案落地”写入服务。
//!
//! 设计边界：
//! - 读模型只返回事实，不返回不透明百分比；准备度/进度由前端已测试的领域函数计算。
//! - 创建走单事务；项目根是 `workspace_projects`，计划是 `planning_projects`，阶段复用
//!   `planning_milestones(kind='phase')`，任务复用 `tasks` + `task_plan_links`。
//! - 不在本层推断用户未提供的截止时间/预算；空值保持空值。
//! - `client_request_id` 幂等：同一请求重复提交返回已创建项目，不重复建项目/任务。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::agents::now_iso;
use crate::commands::planning::PROJECT_STATUSES as PLAN_STATUSES;
use crate::commands::project_workspace::{PROJECT_KINDS, PROJECT_STATUSES as WORKSPACE_PROJECT_STATUSES};
use crate::db::Db;
use crate::error::{AppError, AppResult};

const MAX_NAME: usize = 120;
const MAX_DESCRIPTION: usize = 4000;
const MAX_GOAL: usize = 2000;
const MAX_TASK_TITLE: usize = 240;
const MAX_PHASES: usize = 50;
const MAX_TASKS: usize = 300;
const MAX_CAPABILITIES: usize = 100;
const MAX_GOALS: usize = 100;

// ── 读模型 ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub description: String,
    pub goal: String,
    pub target_date: Option<String>,
    pub active_plan_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub phase_count: i64,
    pub task_count: i64,
    pub completed_task_count: i64,
    pub capability_count: i64,
    pub capability_gap_count: i64,
    pub deliverable_count: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoal {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub note: String,
    pub kind: String,
    pub metric: String,
    pub target_value: Option<f64>,
    pub unit: String,
    pub status: String,
    pub source: String,
    pub sort_order: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPhase {
    pub id: String,
    pub name: String,
    pub description: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub sort_order: i64,
    pub task_count: i64,
    pub completed_task_count: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMilestone {
    pub id: String,
    pub name: String,
    pub description: String,
    pub target_date: Option<String>,
    pub phase_id: Option<String>,
    pub sort_order: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapabilityRequirement {
    pub id: String,
    pub capability_id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub mastery: String,
    pub necessity: String,
    pub target_level: String,
    pub assessment_level: Option<String>,
    pub status: String,
    pub impact: String,
    pub alternative: String,
    pub phase_id: Option<String>,
    pub resource_count: i64,
    pub available_resource_count: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskItem {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub phase_id: Option<String>,
    pub milestone_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeliverable {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub phase_id: Option<String>,
    pub target_path: String,
    pub external_url: String,
    pub evidence: String,
    pub produced_at: Option<String>,
    pub accepted_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEventItem {
    pub id: String,
    pub kind: String,
    pub actor: String,
    pub summary: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHubSnapshot {
    pub project: ProjectSummary,
    pub plan_id: Option<String>,
    pub goals: Vec<ProjectGoal>,
    pub phases: Vec<ProjectPhase>,
    pub milestones: Vec<ProjectMilestone>,
    pub capabilities: Vec<ProjectCapabilityRequirement>,
    pub tasks: Vec<ProjectTaskItem>,
    pub deliverables: Vec<ProjectDeliverable>,
    pub events: Vec<ProjectEventItem>,
    pub risks: Vec<String>,
}

// ── 创建输入 ────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateGoalInput {
    pub title: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateMilestoneInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub target_date: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreatePhaseInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    #[serde(default)]
    pub milestones: Vec<CreateMilestoneInput>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub phase_index: Option<usize>,
    pub due_at: Option<String>,
    pub priority: Option<i64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateCapabilityInput {
    pub name: String,
    #[serde(default = "default_capability_category")]
    pub category: String,
    #[serde(default = "default_necessity")]
    pub necessity: String,
    #[serde(default = "default_target_level")]
    pub target_level: String,
    #[serde(default)]
    pub impact: String,
    #[serde(default)]
    pub alternative: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub goal: String,
    pub target_date: Option<String>,
    pub root_path: Option<String>,
    pub template_id: Option<String>,
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub goals: Vec<CreateGoalInput>,
    #[serde(default)]
    pub phases: Vec<CreatePhaseInput>,
    #[serde(default)]
    pub tasks: Vec<CreateTaskInput>,
    #[serde(default)]
    pub capabilities: Vec<CreateCapabilityInput>,
}

fn default_capability_category() -> String {
    "human".into()
}
fn default_necessity() -> String {
    "required".into()
}
fn default_target_level() -> String {
    "basic".into()
}

const CAPABILITY_CATEGORIES: &[&str] = &["human", "tool", "ai", "agent", "external"];
const NECESSITIES: &[&str] = &["required", "recommended", "optional"];
const LEVELS: &[&str] = &["expert", "proficient", "basic", "learning", "none", "unknown"];

// ── 统一写入契约 ────────────────────────────────────────────────────

/// 项目根写入输入：`planning_create_project`、`workspace_project_save` 与项目中枢共用。
/// 计划容器在同一次调用中创建，保证「项目根 + 初始计划」不出现半套数据。
#[derive(Clone, Debug)]
pub struct CreateProjectRootInput {
    pub name: String,
    pub kind: String,
    pub description: String,
    pub goal: String,
    pub target_date: Option<String>,
    pub root_path: Option<String>,
    /// 工作空间专属：弱引用 `dev_projects.id`（只登记，不级联删除）
    pub dev_project_id: Option<String>,
    /// 工作空间备注；None = 沿用描述（项目中枢/规划入口的历史行为）
    pub note: Option<String>,
    pub template_id: Option<String>,
    pub plan_name: Option<String>,
    pub plan_description: Option<String>,
    /// 计划执行状态（planning/in_progress/paused/completed），与项目 active/archived 无关
    pub plan_status: Option<String>,
    pub plan_sort_order: Option<i64>,
}

/// 项目根字段补丁：全部为 None 表示不修改。`target_date` 为三态：
/// `None` = 保持；`Some(None)` = 清空；`Some(Some(v))` = 设置。
#[derive(Clone, Debug, Default)]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub description: Option<String>,
    pub goal: Option<String>,
    pub status: Option<String>,
    pub target_date: Option<Option<String>>,
}

/// 计划容器写入输入（同一项目可有多个计划，只有一个 active）。
#[derive(Clone, Debug)]
pub struct CreatePlanInput {
    pub project_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub target_date: Option<String>,
    pub status: Option<String>,
    pub template_id: Option<String>,
    pub make_active: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteOutcome {
    pub deleted_plans: i64,
    pub unlinked_tasks: i64,
    pub released_knowledge: i64,
    pub released_skills: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntegrityReport {
    pub project_id: String,
    pub plan_count: i64,
    pub active_plan_count: i64,
    pub linked_task_count: i64,
    pub linked_knowledge_count: i64,
    pub linked_skill_count: i64,
    pub capability_requirement_count: i64,
    pub deliverable_count: i64,
    /// 阻塞项：必须修复后才能保证项目/计划一致性
    pub blocking: Vec<String>,
    /// 警告项：不阻塞写入，但需要用户确认或后续修复
    pub warnings: Vec<String>,
    pub ok: bool,
}


// ── 读模型实现 ──────────────────────────────────────────────────────

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        status: row.get(3)?,
        description: row.get(4)?,
        goal: row.get(5)?,
        target_date: row.get(6)?,
        active_plan_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        phase_count: row.get(10)?,
        task_count: row.get(11)?,
        completed_task_count: row.get(12)?,
        capability_count: row.get(13)?,
        capability_gap_count: row.get(14)?,
        deliverable_count: row.get(15)?,
    })
}

fn summary_sql() -> &'static str {
    "SELECT p.id, p.name, p.kind, p.status, p.description, p.goal, p.target_date,
            p.active_plan_id, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM planning_milestones m
              WHERE m.project_id = p.active_plan_id AND m.kind = 'phase') AS phase_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.id IN (
                SELECT task_id FROM task_plan_links WHERE project_id = p.id
                UNION SELECT task_id FROM workspace_task_links WHERE project_id = p.id
             )) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.status = 'completed' AND t.id IN (
                SELECT task_id FROM task_plan_links WHERE project_id = p.id
                UNION SELECT task_id FROM workspace_task_links WHERE project_id = p.id
             )) AS completed_task_count,
            (SELECT COUNT(*) FROM project_capability_requirements r
              WHERE r.project_id = p.id) AS capability_count,
            (SELECT COUNT(*) FROM project_capability_requirements r
              WHERE r.project_id = p.id AND r.assessment_level IS NULL) AS capability_gap_count,
            (SELECT COUNT(*) FROM project_deliverables d WHERE d.project_id = p.id) AS deliverable_count
       FROM workspace_projects p"
}

pub fn get_snapshot(db: &Db, project_id: &str) -> AppResult<ProjectHubSnapshot> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_read(|conn| load_snapshot(conn, project_id))
}

fn load_snapshot(conn: &Connection, project_id: &str) -> AppResult<ProjectHubSnapshot> {
    let project = conn
        .query_row(
            &format!("{} WHERE p.id = ?1", summary_sql()),
            params![project_id],
            row_to_summary,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("项目不存在或已删除".into()))?;

    let plan_id: Option<String> = conn
        .query_row(
            "SELECT id FROM planning_projects
             WHERE workspace_project_id = ?1 AND is_active = 1
             ORDER BY archived, updated_at DESC LIMIT 1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?;

    let goals = load_goals(conn, project_id)?;
    let phases = load_phases(conn, project_id, plan_id.as_deref())?;
    let milestones = load_milestones(conn, plan_id.as_deref())?;
    let capabilities = load_capabilities(conn, project_id)?;
    let tasks = load_tasks(conn, project_id)?;
    let deliverables = load_deliverables(conn, project_id)?;
    let events = load_events(conn, project_id)?;
    let risks = derive_risks(&project, &phases, &capabilities, &tasks);

    Ok(ProjectHubSnapshot {
        project,
        plan_id,
        goals,
        phases,
        milestones,
        capabilities,
        tasks,
        deliverables,
        events,
        risks,
    })
}

fn load_goals(conn: &Connection, project_id: &str) -> AppResult<Vec<ProjectGoal>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, title, note, kind, metric, target_value, unit, status, source, sort_order
         FROM project_goals WHERE project_id = ?1 ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(ProjectGoal {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            title: r.get(2)?,
            note: r.get(3)?,
            kind: r.get(4)?,
            metric: r.get(5)?,
            target_value: r.get(6)?,
            unit: r.get(7)?,
            status: r.get(8)?,
            source: r.get(9)?,
            sort_order: r.get(10)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_phases(
    conn: &Connection,
    project_id: &str,
    plan_id: Option<&str>,
) -> AppResult<Vec<ProjectPhase>> {
    let Some(plan_id) = plan_id else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT m.id, m.name, m.description, m.target_date, m.start_date, m.sort_order,
                (SELECT COUNT(*) FROM task_plan_links l WHERE l.project_id = ?1 AND l.phase_id = m.id),
                (SELECT COUNT(*) FROM task_plan_links l JOIN tasks t ON t.id = l.task_id
                  WHERE l.project_id = ?1 AND l.phase_id = m.id AND t.status = 'completed')
         FROM planning_milestones m
         WHERE m.project_id = ?2 AND m.kind = 'phase'
         ORDER BY m.sort_order, m.created_at",
    )?;
    let rows = stmt.query_map(params![project_id, plan_id], |r| {
        Ok(ProjectPhase {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            target_date: r.get(3)?,
            start_date: r.get(4)?,
            sort_order: r.get(5)?,
            task_count: r.get(6)?,
            completed_task_count: r.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_milestones(conn: &Connection, plan_id: Option<&str>) -> AppResult<Vec<ProjectMilestone>> {
    let Some(plan_id) = plan_id else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, name, description, target_date, phase_id, sort_order
         FROM planning_milestones
         WHERE project_id = ?1 AND kind = 'milestone'
         ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(params![plan_id], |r| {
        Ok(ProjectMilestone {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            target_date: r.get(3)?,
            phase_id: r.get(4)?,
            sort_order: r.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_capabilities(conn: &Connection, project_id: &str) -> AppResult<Vec<ProjectCapabilityRequirement>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, c.id, c.name, c.category, c.description, c.mastery,
                r.necessity, r.target_level, r.assessment_level, r.status, r.impact,
                r.alternative, r.phase_id,
                (SELECT COUNT(*) FROM capability_resource_links l WHERE l.capability_id = c.id),
                (SELECT COUNT(*) FROM capability_resource_links l
                  WHERE l.capability_id = c.id AND l.availability = 'available')
         FROM project_capability_requirements r
         JOIN project_capabilities c ON c.id = r.capability_id
         WHERE r.project_id = ?1
         ORDER BY CASE r.necessity WHEN 'required' THEN 0 WHEN 'recommended' THEN 1 ELSE 2 END,
                  r.sort_order, c.name",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(ProjectCapabilityRequirement {
            id: r.get(0)?,
            capability_id: r.get(1)?,
            name: r.get(2)?,
            category: r.get(3)?,
            description: r.get(4)?,
            mastery: r.get(5)?,
            necessity: r.get(6)?,
            target_level: r.get(7)?,
            assessment_level: r.get(8)?,
            status: r.get(9)?,
            impact: r.get(10)?,
            alternative: r.get(11)?,
            phase_id: r.get(12)?,
            resource_count: r.get(13)?,
            available_resource_count: r.get(14)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_tasks(conn: &Connection, project_id: &str) -> AppResult<Vec<ProjectTaskItem>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.status, t.priority, t.due_at, t.completed_at,
                (SELECT l.phase_id FROM task_plan_links l
                  WHERE l.project_id = ?1 AND l.task_id = t.id AND l.phase_id <> '' LIMIT 1),
                (SELECT l.milestone_id FROM task_plan_links l
                  WHERE l.project_id = ?1 AND l.task_id = t.id AND l.milestone_id <> '' LIMIT 1)
         FROM tasks t
         WHERE t.id IN (SELECT task_id FROM task_plan_links WHERE project_id = ?1)
            OR t.id IN (SELECT task_id FROM workspace_task_links WHERE project_id = ?1)
         ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.due_at, t.created_at",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(ProjectTaskItem {
            id: r.get(0)?,
            title: r.get(1)?,
            status: r.get(2)?,
            priority: r.get(3)?,
            due_at: r.get(4)?,
            completed_at: r.get(5)?,
            phase_id: r.get(6)?,
            milestone_id: r.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_deliverables(conn: &Connection, project_id: &str) -> AppResult<Vec<ProjectDeliverable>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, kind, status, phase_id, target_path, external_url, evidence,
                produced_at, accepted_at
         FROM project_deliverables
         WHERE project_id = ?1
         ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(ProjectDeliverable {
            id: r.get(0)?,
            title: r.get(1)?,
            kind: r.get(2)?,
            status: r.get(3)?,
            phase_id: r.get(4)?,
            target_path: r.get(5)?,
            external_url: r.get(6)?,
            evidence: r.get(7)?,
            produced_at: r.get(8)?,
            accepted_at: r.get(9)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_events(conn: &Connection, project_id: &str) -> AppResult<Vec<ProjectEventItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, actor, summary, created_at
         FROM project_events WHERE project_id = ?1
         ORDER BY created_at DESC LIMIT 20",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(ProjectEventItem {
            id: r.get(0)?,
            kind: r.get(1)?,
            actor: r.get(2)?,
            summary: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn derive_risks(
    project: &ProjectSummary,
    phases: &[ProjectPhase],
    capabilities: &[ProjectCapabilityRequirement],
    tasks: &[ProjectTaskItem],
) -> Vec<String> {
    let mut risks = Vec::new();
    let today = now_iso();
    if let Some(target) = project.target_date.as_deref() {
        if target < today.as_str() {
            risks.push("项目目标日期已过期".into());
        }
    }
    for task in tasks {
        if task.status == "pending" {
            if let Some(due) = task.due_at.as_deref() {
                if due < today.as_str() {
                    risks.push(format!("任务「{}」已逾期", task.title));
                }
            }
        }
    }
    for phase in phases {
        if phase.task_count == 0 {
            risks.push(format!("阶段「{}」还没有任务", phase.name));
        }
    }
    let unassessed_required = capabilities
        .iter()
        .filter(|c| c.necessity == "required" && c.assessment_level.is_none())
        .count();
    if unassessed_required > 0 {
        risks.push(format!("{unassessed_required} 项必需能力尚未评估"));
    }
    let blocked = capabilities
        .iter()
        .filter(|c| {
            c.necessity == "required"
                && c.assessment_level.as_deref() == Some("none")
                && c.status == "open"
        })
        .count();
    if blocked > 0 {
        risks.push(format!("{blocked} 项必需能力缺失且未解决"));
    }
    risks
}

// ── 创建实现 ────────────────────────────────────────────────────────

fn clean_text(value: &str, field: &str, max: usize, allow_empty: bool) -> AppResult<String> {
    let text = value.trim().to_string();
    if text.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if text.chars().count() > max {
        return Err(AppError::Validation(format!("{field}过长")));
    }
    Ok(text)
}

fn clean_enum(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let text = value.trim();
    if !allowed.contains(&text) {
        return Err(AppError::Validation(format!("{field}取值不支持：{text}")));
    }
    Ok(text.to_string())
}

fn clean_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let text = value.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() == 10
        && text.as_bytes()[4] == b'-'
        && text.as_bytes()[7] == b'-'
        && text[0..4].chars().all(|c| c.is_ascii_digit())
        && text[5..7].chars().all(|c| c.is_ascii_digit())
        && text[8..10].chars().all(|c| c.is_ascii_digit())
    {
        return Ok(Some(text.to_string()));
    }
    if chrono::DateTime::parse_from_rfc3339(text).is_ok() {
        return Ok(Some(text.to_string()));
    }
    Err(AppError::Validation(format!("{field}必须是 YYYY-MM-DD 或 RFC3339")))
}

fn clean_root_path(value: Option<String>) -> AppResult<String> {
    let Some(value) = value else { return Ok(String::new()) };
    let text = value.trim().to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    if !Path::new(&text).is_absolute() {
        return Err(AppError::Validation("工作目录必须是绝对路径".into()));
    }
    Ok(text)
}

pub fn create_project(db: &Db, input: CreateProjectInput) -> AppResult<ProjectHubSnapshot> {
    let name = clean_text(&input.name, "项目名称", MAX_NAME, false)?;
    let kind = clean_enum(&input.kind, "项目类型", PROJECT_KINDS)?;
    let description = clean_text(&input.description, "项目描述", MAX_DESCRIPTION, true)?;
    let goal = clean_text(&input.goal, "项目目标", MAX_GOAL, true)?;
    let target_date = clean_date(input.target_date, "目标日期")?;
    let root_path = clean_root_path(input.root_path)?;
    let template_id = input
        .template_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let client_request_id = input
        .client_request_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    if input.phases.len() > MAX_PHASES {
        return Err(AppError::Validation("阶段数量过多".into()));
    }
    if input.tasks.len() > MAX_TASKS {
        return Err(AppError::Validation("任务数量过多".into()));
    }
    if input.capabilities.len() > MAX_CAPABILITIES {
        return Err(AppError::Validation("能力需求数量过多".into()));
    }
    if input.goals.len() > MAX_GOALS {
        return Err(AppError::Validation("目标数量过多".into()));
    }

    db.with_transaction(|conn| {
        if !client_request_id.is_empty() {
            if let Some(existing) = conn
                .query_row(
                    "SELECT project_id FROM project_events
                     WHERE kind = 'project_created'
                       AND json_extract(payload_json, '$.clientRequestId') = ?1
                     ORDER BY created_at LIMIT 1",
                    params![client_request_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                return load_snapshot(conn, &existing);
            }
        }

        let now = now_iso();
        let (project_id, plan_id) = insert_project_root_tx(
            conn,
            &CreateProjectRootInput {
                name: name.clone(),
                kind: kind.clone(),
                description: description.clone(),
                goal,
                target_date,
                root_path: Some(root_path),
                dev_project_id: None,
                note: Some(description.clone()),
                template_id: Some(template_id.clone()),
                plan_name: Some(name.clone()),
                plan_description: Some(description),
                plan_status: Some("planning".into()),
                plan_sort_order: None,
            },
        )?;

        let mut goal_rows = Vec::new();
        for (index, item) in input.goals.iter().enumerate() {
            let title = clean_text(&item.title, "目标", MAX_NAME, false)?;
            let note = clean_text(&item.note, "目标说明", MAX_DESCRIPTION, true)?;
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO project_goals
                 (id, project_id, parent_id, title, note, kind, metric, target_value, unit,
                  status, sort_order, source, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?4, 'goal', '', NULL, '', 'active', ?5, 'user', ?6, ?6)",
                params![id, project_id, title, note, index as i64, now],
            )?;
            goal_rows.push(id);
        }
        let _ = goal_rows;

        let mut phase_ids = Vec::new();
        for (index, item) in input.phases.iter().enumerate() {
            let phase_name = clean_text(&item.name, "阶段名称", MAX_NAME, false)?;
            let phase_desc = clean_text(&item.description, "阶段说明", MAX_DESCRIPTION, true)?;
            let phase_target = clean_date(item.target_date.clone(), "阶段目标日期")?;
            let phase_start = clean_date(item.start_date.clone(), "阶段开始日期")?;
            let phase_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO planning_milestones
                 (id, project_id, name, description, target_date, sort_order, created_at, updated_at,
                  kind, start_date, phase_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'phase', ?8, NULL)",
                params![
                    phase_id,
                    plan_id,
                    phase_name,
                    phase_desc,
                    phase_target,
                    index as i64,
                    now,
                    phase_start
                ],
            )?;
            for (m_index, milestone) in item.milestones.iter().enumerate() {
                let title = clean_text(&milestone.name, "里程碑名称", MAX_NAME, false)?;
                let detail = clean_text(&milestone.description, "里程碑说明", MAX_DESCRIPTION, true)?;
                let date = clean_date(milestone.target_date.clone(), "里程碑日期")?;
                conn.execute(
                    "INSERT INTO planning_milestones
                     (id, project_id, name, description, target_date, sort_order, created_at,
                      updated_at, kind, start_date, phase_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'milestone', NULL, ?8)",
                    params![
                        uuid::Uuid::new_v4().to_string(),
                        plan_id,
                        title,
                        detail,
                        date,
                        m_index as i64,
                        now,
                        phase_id
                    ],
                )?;
            }
            phase_ids.push(phase_id);
        }

        for (index, item) in input.capabilities.iter().enumerate() {
            let cap_name = clean_text(&item.name, "能力名称", MAX_NAME, false)?;
            let category = clean_enum(&item.category, "能力分类", CAPABILITY_CATEGORIES)?;
            let necessity = clean_enum(&item.necessity, "能力必要性", NECESSITIES)?;
            let target_level = clean_enum(&item.target_level, "目标能力水平", LEVELS)?;
            let impact = clean_text(&item.impact, "能力影响", MAX_DESCRIPTION, true)?;
            let alternative = clean_text(&item.alternative, "替代方案", MAX_DESCRIPTION, true)?;

            conn.execute(
                "INSERT OR IGNORE INTO project_capabilities
                 (id, name, category, description, mastery, mastery_note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', 'unknown', '', ?4, ?4)",
                params![uuid::Uuid::new_v4().to_string(), cap_name, category, now],
            )?;
            let capability_id: String = conn.query_row(
                "SELECT id FROM project_capabilities WHERE name = ?1 AND category = ?2",
                params![cap_name, category],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO project_capability_requirements
                 (id, project_id, capability_id, phase_id, necessity, target_level,
                  assessment_level, status, impact, alternative, source, sort_order,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL, 'open', ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    project_id,
                    capability_id,
                    necessity,
                    target_level,
                    impact,
                    alternative,
                    if template_id.is_empty() { "user" } else { "template" },
                    index as i64,
                    now
                ],
            )?;
        }

        for (index, item) in input.tasks.iter().enumerate() {
            let title = clean_text(&item.title, "任务标题", MAX_TASK_TITLE, false)?;
            let description = clean_text(&item.description, "任务描述", MAX_DESCRIPTION, true)?;
            let due_at = clean_date(item.due_at.clone(), "任务截止时间")?;
            let priority = item.priority.unwrap_or(2).clamp(0, 3);
            let phase_id = item
                .phase_index
                .and_then(|i| phase_ids.get(i))
                .cloned()
                .unwrap_or_default();
            let task_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO tasks
                 (id, title, description, priority, status, category, tags, due_at,
                  remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at,
                  completed_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, '[]', ?6, NULL, 0, NULL, ?7, ?7, NULL)",
                params![task_id, title, description, priority, kind, due_at, now],
            )?;
            conn.execute(
                "INSERT INTO task_plan_links
                 (id, task_id, project_id, phase_id, milestone_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, '', ?5)",
                params![uuid::Uuid::new_v4().to_string(), task_id, project_id, phase_id, now],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO workspace_task_links (project_id, task_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![project_id, task_id, now],
            )?;
            let _ = index;
        }

        conn.execute(
            "INSERT INTO project_events
             (id, project_id, kind, actor, summary, payload_json, created_at)
             VALUES (?1, ?2, 'project_created', 'user', ?3, ?4, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                project_id,
                format!("创建项目「{name}」"),
                serde_json::json!({
                    "clientRequestId": client_request_id,
                    "templateId": template_id,
                    "kind": kind,
                })
                .to_string(),
                now
            ],
        )?;

        load_snapshot(conn, &project_id)
    })
}

// ── 项目根写入：唯一创建入口 ────────────────────────────────────────

/// 「本项目的计划」过滤器：新数据按 workspace_project_id 归属；
/// 兼容 v78 之前或旧代码写入、尚未补链但同 ID 的遗留计划。
const OWNED_PLANS_WHERE: &str =
    "workspace_project_id = ?1 OR (id = ?1 AND (workspace_project_id IS NULL OR workspace_project_id = ''))";

fn workspace_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM workspace_projects WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn load_summary(conn: &Connection, project_id: &str) -> AppResult<ProjectSummary> {
    conn.query_row(
        &format!("{} WHERE p.id = ?1", summary_sql()),
        params![project_id],
        row_to_summary,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("项目不存在或已删除".into()))
}

/// 项目根 + 初始计划的唯一写入内核。
///
/// 调用方必须已处于事务中；任一步失败整体回滚，不允许出现「有项目无计划」。
pub(crate) fn insert_project_root_tx(
    conn: &Connection,
    input: &CreateProjectRootInput,
) -> AppResult<(String, String)> {
    let name = clean_text(&input.name, "项目名称", MAX_NAME, false)?;
    let kind = clean_enum(&input.kind, "项目类型", PROJECT_KINDS)?;
    let description = clean_text(&input.description, "项目描述", MAX_DESCRIPTION, true)?;
    let goal = clean_text(&input.goal, "项目目标", MAX_GOAL, true)?;
    let target_date = clean_date(input.target_date.clone(), "目标日期")?;
    let root_path = clean_root_path(input.root_path.clone())?;
    let note = match input.note.clone() {
        Some(value) => clean_text(&value, "项目备注", MAX_DESCRIPTION, true)?,
        None => description.clone(),
    };
    let template_id = input
        .template_id
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let plan_name = match input.plan_name.clone() {
        Some(value) => clean_text(&value, "计划名称", MAX_NAME, false)?,
        None => name.clone(),
    };
    let plan_description = match input.plan_description.clone() {
        Some(value) => clean_text(&value, "计划描述", MAX_DESCRIPTION, true)?,
        None => description.clone(),
    };
    let plan_status = clean_enum(
        input.plan_status.as_deref().unwrap_or("planning"),
        "计划状态",
        PLAN_STATUSES,
    )?;
    let now = now_iso();
    let plan_sort_order = match input.plan_sort_order {
        Some(value) => value,
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM planning_projects",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)?,
    };
    let project_id = uuid::Uuid::new_v4().to_string();
    let plan_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO workspace_projects
         (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at,
          description, goal, target_date, active_plan_id)
         VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11)",
        params![
            project_id,
            name,
            kind,
            root_path,
            input.dev_project_id,
            note,
            now,
            description,
            goal,
            target_date,
            plan_id
        ],
    )?;
    conn.execute(
        "INSERT INTO planning_projects
         (id, name, description, status, archived, target_date, sort_order,
          created_at, updated_at, revision, workspace_project_id, template_id, is_active)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?7, 1, ?8, ?9, 1)",
        params![
            plan_id,
            plan_name,
            plan_description,
            plan_status,
            target_date,
            plan_sort_order,
            now,
            project_id,
            template_id
        ],
    )?;
    Ok((project_id, plan_id))
}

/// 创建工作空间项目（含初始计划）：供 `workspace_project_save` 等执行环境入口复用。
pub fn create_project_root(db: &Db, input: CreateProjectRootInput) -> AppResult<ProjectSummary> {
    db.with_transaction(|conn| {
        let (project_id, _) = insert_project_root_tx(conn, &input)?;
        load_summary(conn, &project_id)
    })
}

// ── 项目根读/改/删 ─────────────────────────────────────────────────

pub fn list_projects(db: &Db) -> AppResult<Vec<ProjectSummary>> {
    list_projects_filtered(db, false)
}

/// 项目列表；`include_archived=false` 时只返回 active。默认按更新时间倒序。
pub fn list_projects_filtered(db: &Db, include_archived: bool) -> AppResult<Vec<ProjectSummary>> {
    db.with_read(|conn| {
        let sql = format!(
            "{} WHERE (?1 = 1 OR p.status = 'active') ORDER BY p.updated_at DESC, p.name",
            summary_sql()
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![include_archived as i64], row_to_summary)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn get_project(db: &Db, project_id: &str) -> AppResult<ProjectSummary> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_read(|conn| load_summary(conn, project_id))
}

/// 修改项目根字段（名称/类型/描述/目标/日期/生命周期），并把兼容镜像列
/// （`planning_projects.name/description/target_date`）同步到该项目下的全部计划。
/// 调用方必须已处于事务中。
pub(crate) fn update_project_fields_tx(
    conn: &Connection,
    project_id: &str,
    patch: ProjectPatch,
) -> AppResult<()> {
    let (current_name, current_kind, current_description, current_goal, current_target, current_status):
        (String, String, String, String, Option<String>, String) = conn
        .query_row(
            "SELECT name, kind, description, goal, target_date, status
             FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;

    let name = match patch.name {
        Some(value) => clean_text(&value, "项目名称", MAX_NAME, false)?,
        None => current_name,
    };
    let kind = match patch.kind {
        Some(value) => clean_enum(&value, "项目类型", PROJECT_KINDS)?,
        None => current_kind,
    };
    let description = match patch.description {
        Some(value) => clean_text(&value, "项目描述", MAX_DESCRIPTION, true)?,
        None => current_description,
    };
    let goal = match patch.goal {
        Some(value) => clean_text(&value, "项目目标", MAX_GOAL, true)?,
        None => current_goal,
    };
    let target_date = match patch.target_date {
        Some(value) => clean_date(value, "目标日期")?,
        None => current_target,
    };
    let status = match patch.status {
        Some(value) => clean_enum(&value, "项目状态", WORKSPACE_PROJECT_STATUSES)?,
        None => current_status,
    };
    let now = now_iso();
    conn.execute(
        "UPDATE workspace_projects
         SET name = ?1, kind = ?2, description = ?3, goal = ?4, target_date = ?5,
             status = ?6, updated_at = ?7
         WHERE id = ?8",
        params![name, kind, description, goal, target_date, status, now, project_id],
    )?;
    // 计划容器上的同名字段只是兼容镜像，唯一事实来源是项目根。
    conn.execute(
        "UPDATE planning_projects
         SET name = ?1, description = ?2, target_date = ?3, updated_at = ?4
         WHERE workspace_project_id = ?5",
        params![name, description, target_date, now, project_id],
    )?;
    Ok(())
}

pub fn update_project(db: &Db, project_id: &str, patch: ProjectPatch) -> AppResult<ProjectSummary> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_transaction(|conn| {
        update_project_fields_tx(conn, &project_id, patch)?;
        load_summary(conn, &project_id)
    })
}

pub fn set_project_status(db: &Db, project_id: &str, status: &str) -> AppResult<ProjectSummary> {
    update_project(
        db,
        project_id,
        ProjectPatch {
            status: Some(status.to_string()),
            ..Default::default()
        },
    )
}

/// 归档 / 恢复项目根。只改项目生命周期状态，不修改计划执行状态。
pub fn archive_project(db: &Db, project_id: &str, archived: bool) -> AppResult<ProjectSummary> {
    set_project_status(db, project_id, if archived { "archived" } else { "active" })
}

/// 统一删除内核：先删计划容器（级联阶段/功能/步骤/历史/协作数据），再删项目根
/// （级联项目域与工作空间域）。任务、知识库、Skill、MCP、共享能力一律只解除关联。
pub(crate) fn delete_project_tx(
    conn: &Connection,
    project_id: &str,
) -> AppResult<ProjectDeleteOutcome> {
    if !workspace_exists(conn, project_id)? {
        return Err(AppError::NotFound(format!("工作空间项目不存在: {project_id}")));
    }
    let deleted_plans: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM planning_projects WHERE {OWNED_PLANS_WHERE}"),
        params![project_id],
        |r| r.get(0),
    )?;
    let unlinked_tasks: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
           SELECT task_id FROM workspace_task_links WHERE project_id = ?1
           UNION SELECT task_id FROM task_plan_links WHERE project_id = ?1
         )",
        params![project_id],
        |r| r.get(0),
    )?;
    let released_knowledge: i64 = conn.query_row(
        "SELECT COUNT(*) FROM knowledge_bases WHERE project_id = ?1 OR workspace_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    let released_skills: i64 = conn.query_row(
        "SELECT COUNT(*) FROM capability_skills WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;

    conn.execute(
        &format!("DELETE FROM planning_projects WHERE {OWNED_PLANS_WHERE}"),
        params![project_id],
    )?;
    conn.execute(
        "DELETE FROM workspace_projects WHERE id = ?1",
        params![project_id],
    )?;
    // 活跃项目已被删除：清掉指向不存在项目的键，避免下次打开落空。
    conn.execute(
        "DELETE FROM application_settings
         WHERE key = 'workspace_active_project' AND value = ?1",
        params![serde_json::to_string(project_id)?],
    )?;

    Ok(ProjectDeleteOutcome {
        deleted_plans,
        unlinked_tasks,
        released_knowledge,
        released_skills,
    })
}

pub fn delete_project(db: &Db, project_id: &str) -> AppResult<ProjectDeleteOutcome> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_transaction(|conn| delete_project_tx(conn, &project_id))
}

// ── 计划容器生命周期 ────────────────────────────────────────────────

struct PlanRow {
    project_id: Option<String>,
    name: String,
    description: String,
    target_date: Option<String>,
    archived: bool,
    is_active: bool,
    status: String,
}

fn load_plan_row(conn: &Connection, plan_id: &str) -> AppResult<PlanRow> {
    conn.query_row(
        "SELECT workspace_project_id, name, description, target_date, archived, is_active, status
         FROM planning_projects WHERE id = ?1",
        params![plan_id],
        |r| {
            Ok(PlanRow {
                project_id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                target_date: r.get(3)?,
                archived: r.get::<_, i64>(4)? != 0,
                is_active: r.get::<_, i64>(5)? != 0,
                status: r.get(6)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::Validation(format!("项目不存在: {plan_id}")))
}

fn insert_recovered_root_tx(
    conn: &Connection,
    project_id: &str,
    plan: &PlanRow,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO workspace_projects
         (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at,
          description, goal, target_date, active_plan_id)
         VALUES (?1, ?2, 'general', ?3, '', NULL, ?4, ?5, ?5, ?4, '', ?6, NULL)",
        params![
            project_id,
            plan.name,
            if plan.archived { "archived" } else { "active" },
            plan.description,
            now,
            plan.target_date
        ],
    )?;
    Ok(())
}

/// 解析计划所属项目；缺失/失效时补建项目根并回填 `workspace_project_id`。
/// 调用方必须已处于事务中。返回项目根 ID。
pub(crate) fn ensure_project_for_plan_tx(
    conn: &Connection,
    plan_id: &str,
) -> AppResult<String> {
    let plan = load_plan_row(conn, plan_id)?;
    let now = now_iso();
    if let Some(project_id) = plan
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let project_id = project_id.to_string();
        if !workspace_exists(conn, &project_id)? {
            insert_recovered_root_tx(conn, &project_id, &plan, &now)?;
        }
        if plan.is_active {
            // active_plan_id 为空或指向失效计划时，用当前计划修正。
            conn.execute(
                "UPDATE workspace_projects SET active_plan_id = ?2, updated_at = ?3
                 WHERE id = ?1
                   AND (active_plan_id IS NULL OR active_plan_id NOT IN (
                     SELECT id FROM planning_projects
                     WHERE workspace_project_id = ?1 AND is_active = 1
                   ))",
                params![project_id, plan_id, now],
            )?;
        }
        return Ok(project_id);
    }

    // 旧数据没有项目根：按 v78 迁移同一规则补建（同 ID 优先，冲突加 plan- 前缀）。
    let candidate = if workspace_exists(conn, plan_id)? {
        format!("plan-{plan_id}")
    } else {
        plan_id.to_string()
    };
    insert_recovered_root_tx(conn, &candidate, &plan, &now)?;
    conn.execute(
        "UPDATE planning_projects
         SET workspace_project_id = ?1, is_active = 1, updated_at = ?2
         WHERE id = ?3",
        params![candidate, now, plan_id],
    )?;
    conn.execute(
        "UPDATE workspace_projects SET active_plan_id = ?2 WHERE id = ?1",
        params![candidate, plan_id],
    )?;
    Ok(candidate)
}

/// 保证项目有一个 active 计划：已有则修正指针，没有计划则创建默认计划。
/// 用于旧数据修复与「工作空间项目被编辑」时的渐进收敛。
pub(crate) fn ensure_project_plan_tx(conn: &Connection, project_id: &str) -> AppResult<String> {
    let (name, description, target_date): (String, String, Option<String>) = conn
        .query_row(
            "SELECT name, description, target_date FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM planning_projects
             WHERE workspace_project_id = ?1 AND is_active = 1
             ORDER BY archived, updated_at DESC LIMIT 1",
            params![project_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        conn.execute(
            "UPDATE workspace_projects SET active_plan_id = ?2 WHERE id = ?1",
            params![project_id, existing],
        )?;
        return Ok(existing);
    }
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM planning_projects
             WHERE workspace_project_id = ?1
             ORDER BY archived ASC, updated_at DESC LIMIT 1",
            params![project_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        activate_plan_tx(conn, &existing)?;
        return Ok(existing);
    }

    let now = now_iso();
    let plan_id = uuid::Uuid::new_v4().to_string();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM planning_projects",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO planning_projects
         (id, name, description, status, archived, target_date, sort_order,
          created_at, updated_at, revision, workspace_project_id, template_id, is_active)
         VALUES (?1, ?2, ?3, 'planning', 0, ?4, ?5, ?6, ?6, 1, ?7, '', 1)",
        params![plan_id, name, description, target_date, sort_order, now, project_id],
    )?;
    conn.execute(
        "UPDATE workspace_projects SET active_plan_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![project_id, plan_id, now],
    )?;
    Ok(plan_id)
}

/// 在同一事务内切换 active 计划：先清零其余计划，再置一，并同步项目指针。
pub(crate) fn activate_plan_tx(conn: &Connection, plan_id: &str) -> AppResult<String> {
    let project_id = ensure_project_for_plan_tx(conn, plan_id)?;
    let now = now_iso();
    conn.execute(
        "UPDATE planning_projects SET is_active = 0, updated_at = ?2
         WHERE workspace_project_id = ?1 AND is_active = 1 AND id <> ?3",
        params![project_id, now, plan_id],
    )?;
    conn.execute(
        "UPDATE planning_projects SET is_active = 1, updated_at = ?2 WHERE id = ?1",
        params![plan_id, now],
    )?;
    conn.execute(
        "UPDATE workspace_projects SET active_plan_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![project_id, plan_id, now],
    )?;
    Ok(project_id)
}

pub fn activate_plan(db: &Db, plan_id: &str) -> AppResult<String> {
    db.with_transaction(|conn| activate_plan_tx(conn, plan_id))
}

/// 新建计划容器；`make_active=true` 时在同一事务切换 active 计划。
pub fn create_project_plan(db: &Db, input: CreatePlanInput) -> AppResult<String> {
    let project_id = input.project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_transaction(|conn| {
        let (project_name, project_description, project_target): (String, String, Option<String>) = conn
            .query_row(
                "SELECT name, description, target_date FROM workspace_projects WHERE id = ?1",
                params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
        let name = match input.name {
            Some(value) => clean_text(&value, "计划名称", MAX_NAME, false)?,
            None => project_name,
        };
        let description = match input.description {
            Some(value) => clean_text(&value, "计划描述", MAX_DESCRIPTION, true)?,
            None => project_description,
        };
        let target_date = match input.target_date {
            Some(value) => clean_date(Some(value), "目标日期")?,
            None => project_target,
        };
        let status = clean_enum(
            input.status.as_deref().unwrap_or("planning"),
            "计划状态",
            PLAN_STATUSES,
        )?;
        let template_id = input
            .template_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        let now = now_iso();
        let plan_id = uuid::Uuid::new_v4().to_string();
        let sort_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM planning_projects",
            [],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO planning_projects
             (id, name, description, status, archived, target_date, sort_order,
              created_at, updated_at, revision, workspace_project_id, template_id, is_active)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?7, 1, ?8, ?9, 0)",
            params![
                plan_id,
                name,
                description,
                status,
                target_date,
                sort_order,
                now,
                project_id,
                template_id
            ],
        )?;
        if input.make_active {
            activate_plan_tx(conn, &plan_id)?;
        }
        Ok(plan_id)
    })
}

/// 删除单个计划：最后一个计划受保护；删除 active 计划时在同一事务内选继任计划。
/// 项目根永不由本函数删除。
pub(crate) fn delete_plan_tx(conn: &Connection, plan_id: &str) -> AppResult<()> {
    let plan = load_plan_row(conn, plan_id)?;
    let project_id = plan
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let now = now_iso();
    if let Some(project_id) = project_id.as_deref() {
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM planning_projects WHERE {OWNED_PLANS_WHERE}"),
            params![project_id],
            |r| r.get(0),
        )?;
        if total <= 1 {
            return Err(AppError::Conflict(
                "这是项目最后一个计划，已拒绝删除；如需删除整个项目，请在项目工作空间执行"
                    .into(),
            ));
        }
        if plan.is_active {
            let successor: Option<String> = conn
                .query_row(
                    &format!(
                        "SELECT id FROM planning_projects
                         WHERE ({OWNED_PLANS_WHERE}) AND id <> ?2
                         ORDER BY archived ASC, updated_at DESC, id ASC LIMIT 1"
                    ),
                    params![project_id, plan_id],
                    |r| r.get(0),
                )
                .optional()?;
            // 唯一索引要求同一项目最多一个 is_active=1：先清当前计划，再置继任。
            conn.execute(
                "UPDATE planning_projects SET is_active = 0 WHERE id = ?1",
                params![plan_id],
            )?;
            if let Some(next) = successor {
                conn.execute(
                    "UPDATE planning_projects SET is_active = 1, updated_at = ?2 WHERE id = ?1",
                    params![next, now],
                )?;
                conn.execute(
                    "UPDATE workspace_projects SET active_plan_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![project_id, next, now],
                )?;
            }
        }
    }
    conn.execute(
        "DELETE FROM planning_projects WHERE id = ?1",
        params![plan_id],
    )?;
    if let Some(project_id) = project_id {
        conn.execute(
            "UPDATE workspace_projects SET updated_at = ?2 WHERE id = ?1",
            params![project_id, now],
        )?;
    }
    Ok(())
}

pub fn delete_plan(db: &Db, plan_id: &str) -> AppResult<()> {
    db.with_transaction(|conn| delete_plan_tx(conn, plan_id))
}

// ── 完整性校验 ──────────────────────────────────────────────────────

pub fn validate_project_integrity(
    db: &Db,
    project_id: &str,
) -> AppResult<ProjectIntegrityReport> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_read(|conn| integrity_in_conn(conn, project_id))
}

fn integrity_in_conn(conn: &Connection, project_id: &str) -> AppResult<ProjectIntegrityReport> {
    let active_plan_id: Option<String> = conn
        .query_row(
            "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;

    let mut stmt = conn.prepare(&format!(
        "SELECT id, is_active, workspace_project_id FROM planning_projects WHERE {OWNED_PLANS_WHERE}"
    ))?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? != 0,
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        ))
    })?;
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    let mut plan_count = 0i64;
    let mut active_ids = Vec::new();
    for row in rows {
        let (id, is_active, linked) = row?;
        plan_count += 1;
        if is_active {
            active_ids.push(id.clone());
        }
        if linked.trim().is_empty() {
            warnings.push(format!("计划 {id} 缺少 workspace_project_id，将在下次写入时自动补链"));
        }
    }
    if plan_count == 0 {
        blocking.push("项目没有任何计划（应有一个 active 计划）".to_string());
    } else {
        if active_ids.is_empty() {
            blocking.push("项目没有 active 计划".to_string());
        }
        if active_ids.len() > 1 {
            blocking.push(format!("同一项目存在 {} 个 active 计划", active_ids.len()));
        }
        match active_plan_id.as_deref() {
            None => blocking.push("项目 active_plan_id 为空".to_string()),
            Some(pointer) if !active_ids.iter().any(|id| id == pointer) => {
                blocking.push("active_plan_id 未指向本项目的 active 计划".to_string())
            }
            _ => {}
        }
    }

    let linked_task_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
           SELECT task_id FROM workspace_task_links WHERE project_id = ?1
           UNION SELECT task_id FROM task_plan_links WHERE project_id = ?1
         )",
        params![project_id],
        |r| r.get(0),
    )?;
    let dangling_tasks: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
           SELECT task_id FROM workspace_task_links WHERE project_id = ?1
           UNION SELECT task_id FROM task_plan_links WHERE project_id = ?1
         ) l WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = l.task_id)",
        params![project_id],
        |r| r.get(0),
    )?;
    if dangling_tasks > 0 {
        warnings.push(format!("{dangling_tasks} 条任务关联指向不存在的任务"));
    }
    let linked_knowledge_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM knowledge_bases WHERE project_id = ?1 OR workspace_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    let linked_skill_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM capability_skills WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    let capability_requirement_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_capability_requirements WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    let deliverable_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_deliverables WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;

    Ok(ProjectIntegrityReport {
        project_id: project_id.to_string(),
        plan_count,
        active_plan_count: active_ids.len() as i64,
        linked_task_count,
        linked_knowledge_count,
        linked_skill_count,
        capability_requirement_count,
        deliverable_count,
        ok: blocking.is_empty(),
        blocking,
        warnings,
    })
}

