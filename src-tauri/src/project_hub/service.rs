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
use crate::commands::project_workspace::PROJECT_KINDS;
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

pub fn list_projects(db: &Db) -> AppResult<Vec<ProjectSummary>> {
    db.with_read(|conn| {
        let sql = format!(
            "{} WHERE p.status = 'active' ORDER BY p.updated_at DESC, p.name",
            summary_sql()
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_summary)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
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
        let project_id = uuid::Uuid::new_v4().to_string();
        let plan_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO workspace_projects
             (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at,
              description, goal, target_date, active_plan_id)
             VALUES (?1, ?2, ?3, 'active', ?4, NULL, ?5, ?6, ?6, ?7, ?8, ?9, ?10)",
            params![
                project_id,
                name,
                kind,
                root_path,
                description,
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
             VALUES (?1, ?2, ?3, 'planning', 0, ?4,
                     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM planning_projects),
                     ?5, ?5, 1, ?6, ?7, 1)",
            params![plan_id, name, description, target_date, now, project_id, template_id],
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
