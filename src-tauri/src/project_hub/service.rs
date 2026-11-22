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
use sha2::{Digest, Sha256};

use crate::agents::now_iso;
use crate::commands::planning::PROJECT_STATUSES as PLAN_STATUSES;
use crate::commands::project_workspace::{PROJECT_KINDS, PROJECT_STATUSES as WORKSPACE_PROJECT_STATUSES};
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub(crate) const MAX_NAME: usize = 120;
pub(crate) const MAX_DESCRIPTION: usize = 4000;
pub(crate) const MAX_GOAL: usize = 2000;
pub(crate) const MAX_TASK_TITLE: usize = 240;
pub(crate) const MAX_PHASES: usize = 50;
pub(crate) const MAX_FEATURES: usize = 2000;
pub(crate) const MAX_TASKS: usize = 300;
pub(crate) const MAX_CAPABILITIES: usize = 100;
pub(crate) const MAX_GOALS: usize = 100;
/// `planning_features.priority` 的合法取值（CHECK 约束）。
pub(crate) const FEATURE_PRIORITIES: &[&str] = &["P0", "P1", "P2"];

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
    /// 项目根乐观并发版本（v93）：只随项目根字段写入递增，与计划 revision 独立。
    pub revision: i64,
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
    /// 阶段内功能数（`planning_features.milestone_id = 阶段 ID`）。
    pub feature_count: i64,
    pub completed_feature_count: i64,
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
    pub feature_count: i64,
    pub completed_feature_count: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFeature {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    /// 所属阶段（`planning_features.milestone_id` 指向阶段行）。
    pub milestone_id: Option<String>,
    pub acceptance_criteria: String,
    pub target_date: Option<String>,
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
    /// 已做过可用性校验（`last_checked_at IS NOT NULL`）的关联数。
    /// `resource_count=0` = 确认没有资源；`resource_count>0 && verified=0` = 关联了但从未校验。
    pub verified_resource_count: i64,
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
    /// 功能（`planning_features`）：阶段进度的计算单元。
    pub features: Vec<ProjectFeature>,
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
pub struct CreateFeatureInput {
    pub title: String,
    /// 验收标准（`planning_features.acceptance_criteria`）；空串表示尚未填写。
    #[serde(default)]
    pub acceptance: String,
    /// `P0` / `P1` / `P2`；缺省 `P1`（表默认值）。
    pub priority: Option<String>,
    /// 所属阶段在 `phases` 中的下标；`None` = 暂未分阶段。
    pub phase_index: Option<usize>,
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
    /// 阶段归属：`phases` 中的下标；`None` = 全项目能力需求。
    /// 不接受 -1 之类的哨兵值：未分配阶段必须是 `null`。
    pub phase_index: Option<usize>,
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
    /// 功能草案：随项目同事务落库到 `planning_features`，通过 `phase_index` 关联阶段。
    #[serde(default)]
    pub features: Vec<CreateFeatureInput>,
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
    /// 乐观并发（v93）：Some 时与当前项目根 revision 比对，不匹配返回 Conflict。
    pub expected_revision: Option<i64>,
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
        revision: row.get(10)?,
        phase_count: row.get(11)?,
        task_count: row.get(12)?,
        completed_task_count: row.get(13)?,
        capability_count: row.get(14)?,
        capability_gap_count: row.get(15)?,
        deliverable_count: row.get(16)?,
    })
}

fn summary_sql() -> &'static str {
    "SELECT p.id, p.name, p.kind, p.status, p.description, p.goal, p.target_date,
            p.active_plan_id, p.created_at, p.updated_at, p.revision,
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
             WHERE workspace_project_id = ?1 AND is_active = 1 AND archived = 0
             ORDER BY updated_at DESC LIMIT 1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?;

    let goals = load_goals(conn, project_id)?;
    let phases = load_phases(conn, project_id, plan_id.as_deref())?;
    let milestones = load_milestones(conn, plan_id.as_deref())?;
    let features = load_features(conn, plan_id.as_deref())?;
    let capabilities = load_capabilities(conn, project_id)?;
    let tasks = load_tasks(conn, project_id, plan_id.as_deref())?;
    let deliverables = load_deliverables(conn, project_id)?;
    let events = load_events(conn, project_id)?;
    let risks = derive_risks(&project, &phases, &capabilities, &tasks);

    Ok(ProjectHubSnapshot {
        project,
        plan_id,
        goals,
        phases,
        milestones,
        features,
        capabilities,
        tasks,
        deliverables,
        events,
        risks,
    })
}

fn load_features(conn: &Connection, plan_id: Option<&str>) -> AppResult<Vec<ProjectFeature>> {
    let Some(plan_id) = plan_id else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, title, description, status, priority, milestone_id, acceptance_criteria,
                target_date, sort_order
         FROM planning_features
         WHERE project_id = ?1
         ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(params![plan_id], |r| {
        Ok(ProjectFeature {
            id: r.get(0)?,
            title: r.get(1)?,
            description: r.get(2)?,
            status: r.get(3)?,
            priority: r.get(4)?,
            milestone_id: r.get(5)?,
            acceptance_criteria: r.get(6)?,
            target_date: r.get(7)?,
            sort_order: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
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
                  WHERE l.project_id = ?1 AND l.phase_id = m.id AND t.status = 'completed'),
                (SELECT COUNT(*) FROM planning_features f WHERE f.project_id = ?2 AND f.milestone_id = m.id),
                (SELECT COUNT(*) FROM planning_features f WHERE f.project_id = ?2 AND f.milestone_id = m.id
                  AND f.status = 'completed')
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
            feature_count: r.get(8)?,
            completed_feature_count: r.get(9)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_milestones(conn: &Connection, plan_id: Option<&str>) -> AppResult<Vec<ProjectMilestone>> {
    let Some(plan_id) = plan_id else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, name, description, target_date, phase_id, sort_order,
                (SELECT COUNT(*) FROM planning_features f WHERE f.project_id = ?1 AND f.milestone_id = m.id),
                (SELECT COUNT(*) FROM planning_features f WHERE f.project_id = ?1 AND f.milestone_id = m.id
                  AND f.status = 'completed')
         FROM planning_milestones m
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
            feature_count: r.get(6)?,
            completed_feature_count: r.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_capabilities(conn: &Connection, project_id: &str) -> AppResult<Vec<ProjectCapabilityRequirement>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, c.id, c.name, c.category, c.description, c.mastery,
                r.necessity, r.target_level, r.assessment_level, r.status, r.impact,
                r.alternative, r.phase_id,
                (SELECT COUNT(*) FROM capability_resource_links l
                  WHERE l.capability_id = c.id
                    AND (l.project_id = r.project_id OR l.scope = 'global')),
                (SELECT COUNT(*) FROM capability_resource_links l
                  WHERE l.capability_id = c.id AND l.availability = 'available'
                    AND (l.project_id = r.project_id OR l.scope = 'global')),
                (SELECT COUNT(*) FROM capability_resource_links l
                  WHERE l.capability_id = c.id AND l.last_checked_at IS NOT NULL
                    AND (l.project_id = r.project_id OR l.scope = 'global'))
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
            verified_resource_count: r.get(15)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_tasks(
    conn: &Connection,
    project_id: &str,
    plan_id: Option<&str>,
) -> AppResult<Vec<ProjectTaskItem>> {
    // 阶段/里程碑归属必须与**当前 active 计划**一致：
    // 多计划共用项目根时，任务行可以来自旧计划（项目级实体保留），
    // 但阶段/里程碑只有在属于 active 计划时才展示，绝不串到别的计划。
    let active_plan = plan_id.unwrap_or("");
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.status, t.priority, t.due_at, t.completed_at,
                (SELECT l.phase_id FROM task_plan_links l
                  WHERE l.project_id = ?1 AND l.task_id = t.id AND l.phase_id <> ''
                    AND l.phase_id IN (SELECT id FROM planning_milestones
                                        WHERE project_id = ?2 AND kind = 'phase')
                  LIMIT 1),
                (SELECT l.milestone_id FROM task_plan_links l
                  WHERE l.project_id = ?1 AND l.task_id = t.id AND l.milestone_id <> ''
                    AND l.milestone_id IN (SELECT id FROM planning_milestones
                                            WHERE project_id = ?2 AND kind = 'milestone')
                  LIMIT 1)
         FROM tasks t
         WHERE t.id IN (SELECT task_id FROM task_plan_links WHERE project_id = ?1)
            OR t.id IN (SELECT task_id FROM workspace_task_links WHERE project_id = ?1)
         ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.due_at, t.created_at",
    )?;
    let rows = stmt.query_map(params![project_id, active_plan], |r| {
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

pub(crate) fn clean_text(value: &str, field: &str, max: usize, allow_empty: bool) -> AppResult<String> {
    let text = value.trim().to_string();
    if text.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if text.chars().count() > max {
        return Err(AppError::Validation(format!("{field}过长")));
    }
    Ok(text)
}

pub(crate) fn clean_enum(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let text = value.trim();
    if !allowed.contains(&text) {
        return Err(AppError::Validation(format!("{field}取值不支持：{text}")));
    }
    Ok(text.to_string())
}

pub(crate) fn clean_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
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

/// 路径策略的唯一判定（后端所有入口 + 前端 `checkWorkspacePath` 同一口径）。
///
/// 只接受**本地绝对路径**：
/// - Windows：盘符绝对路径 `X:\…` / `X:/…`；拒绝 UNC（`\\server\share`、`//server/share`）、
///   verbatim/设备路径（`\\?\…`、`\\.\…`）、盘符相对（`C:foo`）与普通相对路径；
/// - Linux / macOS：以 `/` 开头的绝对路径。
///
/// 为什么拒绝 UNC：`create_new` 与崩溃恢复都依赖「存在性 / 空目录」的可靠判定，
/// 网络盘断连会把「不可访问」伪装成「不存在」，恢复线程会据此误判并删除用户目录。
/// 若将来要支持网络目录，必须先补连接可用性探测与独立的安全验证，不能只放开校验。
pub(crate) fn root_path_violation(text: &str) -> Option<&'static str> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        if text.starts_with("\\\\") || text.starts_with("//") {
            return Some("unc");
        }
        let bytes = text.as_bytes();
        let drive_absolute = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        if !drive_absolute {
            return Some("not-absolute");
        }
        // 盘符后的 `:` 同样非法（如 `C:\a:b`），所以从第 3 个字节开始查。
        if has_illegal_path_chars(&text[2..]) {
            return Some("illegal-char");
        }
        None
    }
    #[cfg(not(windows))]
    {
        if !text.starts_with('/') {
            return Some("not-absolute");
        }
        if has_illegal_path_chars(text) {
            return Some("illegal-char");
        }
        None
    }
}

/// Windows 目录名非法字符 + 控制字符（无法创建目录）。
pub(crate) fn has_illegal_path_chars(rest: &str) -> bool {
    rest.chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
}

/// 路径策略的可读文案：后端错误与前端提示共用，避免两处措辞不一致。
pub(crate) fn root_path_error(reason: &str) -> String {
    match reason {
        "unc" => "不支持网络目录（UNC）或 \\\\?\\ 扩展路径：请选择本地磁盘上的工作目录".into(),
        "illegal-char" => "工作目录含非法字符（< > : \" | ? *）".into(),
        _ => "工作目录必须是绝对路径（如 D:\\Projects\\demo）".into(),
    }
}

/// 路径比较键：Windows 忽略大小写与分隔符差异（`D:/Work` 与 `d:\work\` 同键），
/// macOS 默认不区分大小写，Linux 保留原始大小写。
///
/// 只用于**相等**判定（引用检查、日志去重），绝不做前缀归属判断。
pub(crate) fn path_key(path: &str) -> String {
    let mut text = path.trim().to_string();
    #[cfg(windows)]
    {
        text = text.replace('/', "\\");
        while text.len() > 3 && text.ends_with('\\') {
            text.pop();
        }
        text.make_ascii_lowercase();
    }
    #[cfg(target_os = "macos")]
    {
        while text.len() > 1 && text.ends_with('/') {
            text.pop();
        }
        text.make_ascii_lowercase();
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        while text.len() > 1 && text.ends_with('/') {
            text.pop();
        }
    }
    text
}

/// 两个路径是否指向同一位置（空路径永远不相等）。
pub(crate) fn same_path(left: &str, right: &str) -> bool {
    !left.trim().is_empty() && !right.trim().is_empty() && path_key(left) == path_key(right)
}

pub(crate) fn clean_root_path(value: Option<String>) -> AppResult<String> {
    let Some(value) = value else { return Ok(String::new()) };
    let text = value.trim().to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    if let Some(reason) = root_path_violation(&text) {
        return Err(AppError::Validation(root_path_error(reason)));
    }
    Ok(text)
}

/// 规范化后的创建请求：摘要必须基于「清洗后的值」，否则同一语义的两种写法会算出不同摘要。
#[derive(Clone, Debug)]
pub(crate) struct CleanCreate {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) description: String,
    pub(crate) goal: String,
    pub(crate) target_date: Option<String>,
    pub(crate) root_path: String,
    pub(crate) template_id: String,
    pub(crate) client_request_id: String,
    pub(crate) goals: Vec<(String, String)>,
    pub(crate) phases: Vec<CleanPhase>,
    pub(crate) features: Vec<CleanFeature>,
    pub(crate) tasks: Vec<CleanTask>,
    pub(crate) capabilities: Vec<CleanCapability>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanPhase {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) target_date: Option<String>,
    pub(crate) start_date: Option<String>,
    pub(crate) milestones: Vec<(String, String, Option<String>)>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanFeature {
    pub(crate) title: String,
    pub(crate) acceptance: String,
    pub(crate) priority: String,
    pub(crate) phase_index: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanTask {
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) due_at: Option<String>,
    pub(crate) priority: i64,
    pub(crate) phase_index: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanCapability {
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) necessity: String,
    pub(crate) target_level: String,
    pub(crate) impact: String,
    pub(crate) alternative: String,
    pub(crate) phase_index: Option<usize>,
}

pub(crate) fn clean_create(input: &CreateProjectInput) -> AppResult<CleanCreate> {
    let name = clean_text(&input.name, "项目名称", MAX_NAME, false)?;
    let kind = clean_enum(&input.kind, "项目类型", PROJECT_KINDS)?;
    let description = clean_text(&input.description, "项目描述", MAX_DESCRIPTION, true)?;
    let goal = clean_text(&input.goal, "项目目标", MAX_GOAL, true)?;
    let target_date = clean_date(input.target_date.clone(), "目标日期")?;
    let root_path = clean_root_path(input.root_path.clone())?;
    let template_id = input
        .template_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();
    let client_request_id = input
        .client_request_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();
    if input.phases.len() > MAX_PHASES {
        return Err(AppError::Validation("阶段数量过多".into()));
    }
    if input.features.len() > MAX_FEATURES {
        return Err(AppError::Validation("功能数量过多".into()));
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

    let goals = input
        .goals
        .iter()
        .map(|item| {
            Ok((
                clean_text(&item.title, "目标", MAX_NAME, false)?,
                clean_text(&item.note, "目标说明", MAX_DESCRIPTION, true)?,
            ))
        })
        .collect::<AppResult<Vec<_>>>()?;

    let phases = input
        .phases
        .iter()
        .map(|item| {
            let milestones = item
                .milestones
                .iter()
                .map(|milestone| {
                    Ok((
                        clean_text(&milestone.name, "里程碑名称", MAX_NAME, false)?,
                        clean_text(&milestone.description, "里程碑说明", MAX_DESCRIPTION, true)?,
                        clean_date(milestone.target_date.clone(), "里程碑日期")?,
                    ))
                })
                .collect::<AppResult<Vec<_>>>()?;
            Ok(CleanPhase {
                name: clean_text(&item.name, "阶段名称", MAX_NAME, false)?,
                description: clean_text(&item.description, "阶段说明", MAX_DESCRIPTION, true)?,
                target_date: clean_date(item.target_date.clone(), "阶段目标日期")?,
                start_date: clean_date(item.start_date.clone(), "阶段开始日期")?,
                milestones,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    let features = input
        .features
        .iter()
        .map(|item| {
            let phase_index = item.phase_index.filter(|index| *index < phases.len());
            if item.phase_index.is_some() && phase_index.is_none() {
                return Err(AppError::Validation(format!(
                    "功能「{}」所属阶段不存在",
                    item.title.trim()
                )));
            }
            Ok(CleanFeature {
                title: clean_text(&item.title, "功能名称", MAX_TASK_TITLE, false)?,
                acceptance: clean_text(&item.acceptance, "验收标准", MAX_DESCRIPTION, true)?,
                priority: clean_enum(
                    item.priority.as_deref().unwrap_or("P1"),
                    "功能优先级",
                    FEATURE_PRIORITIES,
                )?,
                phase_index,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    let tasks = input
        .tasks
        .iter()
        .map(|item| {
            let phase_index = item.phase_index.filter(|index| *index < phases.len());
            if item.phase_index.is_some() && phase_index.is_none() {
                return Err(AppError::Validation(format!(
                    "任务「{}」所属阶段不存在",
                    item.title.trim()
                )));
            }
            Ok(CleanTask {
                title: clean_text(&item.title, "任务标题", MAX_TASK_TITLE, false)?,
                description: clean_text(&item.description, "任务描述", MAX_DESCRIPTION, true)?,
                due_at: clean_date(item.due_at.clone(), "任务截止时间")?,
                priority: item.priority.unwrap_or(2).clamp(0, 3),
                phase_index,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    let capabilities = input
        .capabilities
        .iter()
        .map(|item| {
            let phase_index = item.phase_index.filter(|index| *index < phases.len());
            if item.phase_index.is_some() && phase_index.is_none() {
                return Err(AppError::Validation(format!(
                    "能力「{}」所属阶段不存在",
                    item.name.trim()
                )));
            }
            Ok(CleanCapability {
                name: clean_text(&item.name, "能力名称", MAX_NAME, false)?,
                category: clean_enum(&item.category, "能力分类", CAPABILITY_CATEGORIES)?,
                necessity: clean_enum(&item.necessity, "能力必要性", NECESSITIES)?,
                target_level: clean_enum(&item.target_level, "目标能力水平", LEVELS)?,
                impact: clean_text(&item.impact, "能力影响", MAX_DESCRIPTION, true)?,
                alternative: clean_text(&item.alternative, "替代方案", MAX_DESCRIPTION, true)?,
                phase_index,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    Ok(CleanCreate {
        name,
        kind,
        description,
        goal,
        target_date,
        root_path,
        template_id,
        client_request_id,
        goals,
        phases,
        features,
        tasks,
        capabilities,
    })
}

/// 规范化请求摘要：同一份语义请求恒得同一摘要；参数变化必然改变摘要。
pub(crate) fn request_digest(clean: &CleanCreate) -> String {
    let canonical = serde_json::json!({
        "name": clean.name,
        "kind": clean.kind,
        "description": clean.description,
        "goal": clean.goal,
        "targetDate": clean.target_date,
        "rootPath": clean.root_path,
        "templateId": clean.template_id,
        "goals": clean.goals,
        "phases": clean.phases.iter().map(|phase| serde_json::json!({
            "name": phase.name,
            "description": phase.description,
            "targetDate": phase.target_date,
            "startDate": phase.start_date,
            "milestones": phase.milestones,
        })).collect::<Vec<_>>(),
        "features": clean.features.iter().map(|feature| serde_json::json!({
            "title": feature.title,
            "acceptance": feature.acceptance,
            "priority": feature.priority,
            "phaseIndex": feature.phase_index,
        })).collect::<Vec<_>>(),
        "tasks": clean.tasks.iter().map(|task| serde_json::json!({
            "title": task.title,
            "description": task.description,
            "dueAt": task.due_at,
            "priority": task.priority,
            "phaseIndex": task.phase_index,
        })).collect::<Vec<_>>(),
        "capabilities": clean.capabilities.iter().map(|capability| serde_json::json!({
            "name": capability.name,
            "category": capability.category,
            "necessity": capability.necessity,
            "targetLevel": capability.target_level,
            "impact": capability.impact,
            "alternative": capability.alternative,
            "phaseIndex": capability.phase_index,
        })).collect::<Vec<_>>(),
    });
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 项目中枢创建入口（自然语言/模板/手动）。
///
/// 只做「把草案转成统一请求」，事务、幂等、目录初始化全部交给
/// `project_hub::creation`——本函数不含任何创建 SQL。
pub fn create_project(db: &Db, input: CreateProjectInput) -> AppResult<ProjectHubSnapshot> {
    let mode = super::creation::DirectoryMode::default_for(
        input.root_path.as_deref().unwrap_or_default(),
    );
    let request = super::creation::CreateProjectRequest::from_hub_input(input, mode);
    let result = super::creation::create(db, request)?;
    db.with_read(|conn| load_snapshot(conn, &result.project.id))
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

pub(crate) fn load_summary(conn: &Connection, project_id: &str) -> AppResult<ProjectSummary> {
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
///
/// 同样收敛到统一创建服务：目录模式按「有路径 = 关联已有目录」推断，
/// `workspace_project_save` 不负责创建目录（快速创建的新目录走 `project_create`）。
pub fn create_project_root(db: &Db, input: CreateProjectRootInput) -> AppResult<ProjectSummary> {
    let root = input.root_path.clone().unwrap_or_default();
    let request = super::creation::CreateProjectRequest {
        client_request_id: String::new(),
        name: input.name,
        kind: input.kind,
        description: input.description,
        goal: input.goal,
        target_date: input.target_date,
        template_id: input.template_id,
        root_path: input.root_path,
        directory_mode: super::creation::DirectoryMode::default_for(&root),
        dev_project_id: input.dev_project_id,
        note: input.note,
        plan_name: input.plan_name,
        plan_description: input.plan_description,
        plan_status: input.plan_status,
        draft: super::creation::InitialPlanDraft::default(),
        agent_access_policy: super::creation::AgentAccessPolicy::None,
        principal: super::creation::RequestPrincipal::local_human(),
    };
    let result = super::creation::create(db, request)?;
    Ok(result.project)
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

/// 乐观并发（v37 计划 / v93 项目根）：校验 expected_revision 与当前 revision 一致。
/// 不匹配返回 Conflict（携带当前 revision），防止客户端后写无声覆盖。
/// 不传（None）保持旧行为——UI 命令向后兼容，MCP/REST 工具层对根更新强制传值。
pub(crate) fn check_expected_revision_tx(
    conn: &Connection,
    table: &str,
    id: &str,
    expected: Option<i64>,
) -> AppResult<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let current: i64 = conn
        .query_row(
            &format!("SELECT revision FROM {table} WHERE id = ?1"),
            rusqlite::params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("对象不存在: {}", id)))?;
    if current != expected {
        return Err(AppError::Conflict(format!(
            "版本冲突：期望 revision {expected}，当前 {current}（请重新读取后再提交）"
        )));
    }
    Ok(())
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
    // 项目根 revision（v93）：同一事务内「读 → 比对 → 递增」，不匹配即 Conflict。
    check_expected_revision_tx(conn, "workspace_projects", project_id, patch.expected_revision)?;

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
             status = ?6, updated_at = ?7, revision = revision + 1
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

/// 计划摘要（对外统一读模型）：`project_id` 是所属项目根，`id` 才是计划 ID。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPlanSummary {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub target_date: Option<String>,
    pub is_active: bool,
    pub archived: bool,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

const PLAN_SUMMARY_SQL: &str =
    "SELECT p.id, COALESCE(NULLIF(p.workspace_project_id, ''), ''), p.name, p.description,
            p.status, p.target_date, p.is_active, p.archived, p.revision, p.created_at, p.updated_at
     FROM planning_projects p";

fn row_to_plan_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectPlanSummary> {
    Ok(ProjectPlanSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        status: row.get(4)?,
        target_date: row.get(5)?,
        is_active: row.get::<_, i64>(6)? != 0,
        archived: row.get::<_, i64>(7)? != 0,
        revision: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn load_plan_summary(conn: &Connection, plan_id: &str) -> AppResult<ProjectPlanSummary> {
    conn.query_row(
        &format!("{PLAN_SUMMARY_SQL} WHERE p.id = ?1"),
        params![plan_id],
        row_to_plan_summary,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("计划不存在: {plan_id}")))
}

/// 项目的全部计划（含归档），按 active 优先、创建时间升序。
pub fn list_plan_summaries(
    conn: &Connection,
    project_id: &str,
) -> AppResult<Vec<ProjectPlanSummary>> {
    let mut stmt = conn.prepare(&format!(
        "{PLAN_SUMMARY_SQL} WHERE p.workspace_project_id = ?1
         ORDER BY p.is_active DESC, p.archived ASC, p.created_at ASC"
    ))?;
    let rows = stmt.query_map(params![project_id], row_to_plan_summary)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(AppError::from)?);
    }
    Ok(out)
}

/// 项目根 ID（`workspace_projects.id`）。与计划 ID 是两种类型，禁止混用：
/// 授权、持久化归属、操作记录一律用它。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProjectId(pub String);

/// 计划 ID（`planning_projects.id`）。只作为**入参兼容**存在：
/// 解析后立刻换成项目根，绝不能写进授权或 `project_id` 字段。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PlanId(pub String);

impl ProjectId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl PlanId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 项目根解析结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectRef {
    /// 传入的就是项目根。
    Project(ProjectId),
    /// 传入的是计划 ID，已解析到所属项目根。
    Plan { plan_id: PlanId, project_id: ProjectId },
}

impl ProjectRef {
    /// 授权与持久化只认项目根。
    pub fn project_id(&self) -> &ProjectId {
        match self {
            ProjectRef::Project(id) => id,
            ProjectRef::Plan { project_id, .. } => project_id,
        }
    }
}

/// 把「项目 ID 或计划 ID」统一解析为项目根。
///
/// 只读，不做修复：旧数据缺项目链时返回 `None`，由调用方在事务内调用
/// [`ensure_project_for_plan_tx`] 补建（见 `agent_access::service`）。
pub fn resolve_project_ref(conn: &Connection, id: &str) -> AppResult<Option<ProjectRef>> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let is_root: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM workspace_projects WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    if is_root.is_some() {
        return Ok(Some(ProjectRef::Project(ProjectId(id.to_string()))));
    }
    let plan: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT NULLIF(trim(workspace_project_id), ''), 1 FROM planning_projects WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(match plan {
        Some((Some(project_id), _)) => Some(ProjectRef::Plan {
            plan_id: PlanId(id.to_string()),
            project_id: ProjectId(project_id),
        }),
        Some((None, _)) => None,
        None => None,
    })
}

/// 只解析项目根 ID（不区分来源）。
pub fn resolve_project_root(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(resolve_project_ref(conn, id)?.map(|resolved| resolved.project_id().0.clone()))
}

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
        if plan.is_active && !plan.archived {
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
             WHERE workspace_project_id = ?1 AND is_active = 1 AND archived = 0
             ORDER BY updated_at DESC LIMIT 1",
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
    // 只有未归档计划可以作为继任；全部归档时新建计划，绝不静默复活归档计划。
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM planning_projects
             WHERE workspace_project_id = ?1 AND archived = 0
             ORDER BY sort_order, updated_at DESC LIMIT 1",
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
///
/// 不变量：active 计划不得处于 archived 状态。归档计划必须显式恢复
/// （`archive_plan(..., false)`）后才能激活，避免「归档即隐藏」被静默绕过。
pub(crate) fn activate_plan_tx(conn: &Connection, plan_id: &str) -> AppResult<String> {
    let plan = load_plan_row(conn, plan_id)?;
    if plan.archived {
        return Err(AppError::Conflict(
            "计划已归档，不能直接设为当前计划；请先恢复该计划".into(),
        ));
    }
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

/// 归档 / 恢复计划容器（不变量内核）。
///
/// - 归档非当前计划：直接归档；
/// - 归档当前计划且存在未归档继任者：同一事务内切换 active 并更新项目指针；
/// - 归档当前计划且没有未归档继任者：返回 `Conflict`，不允许把项目变成「无 active 计划」；
/// - 恢复归档计划：只清 `archived`，不自动激活（激活仍需显式调用 `activate_plan`）。
pub(crate) fn archive_plan_tx(conn: &Connection, plan_id: &str, archived: bool) -> AppResult<()> {
    let plan = load_plan_row(conn, plan_id)?;
    let now = now_iso();
    if !archived {
        conn.execute(
            "UPDATE planning_projects SET archived = 0, updated_at = ?2 WHERE id = ?1",
            params![plan_id, now],
        )?;
        return Ok(());
    }
    if plan.archived {
        return Ok(());
    }
    let project_id = plan
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let Some(project_id) = project_id else {
        // 尚无项目根的遗留计划：直接归档，补链在下次写入时完成。
        conn.execute(
            "UPDATE planning_projects SET archived = 1, updated_at = ?2 WHERE id = ?1",
            params![plan_id, now],
        )?;
        return Ok(());
    };
    if !plan.is_active {
        conn.execute(
            "UPDATE planning_projects SET archived = 1, updated_at = ?2 WHERE id = ?1",
            params![plan_id, now],
        )?;
        conn.execute(
            "UPDATE workspace_projects SET updated_at = ?2 WHERE id = ?1",
            params![project_id, now],
        )?;
        return Ok(());
    }

    // 归档当前计划：必须存在同项目、未归档的继任者。
    let successor: Option<String> = conn
        .query_row(
            &format!(
                "SELECT id FROM planning_projects
                 WHERE ({OWNED_PLANS_WHERE}) AND id <> ?2 AND archived = 0
                 ORDER BY sort_order, updated_at DESC, id ASC LIMIT 1"
            ),
            params![project_id, plan_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(next) = successor else {
        return Err(AppError::Conflict(
            "当前计划没有未归档的继任计划，已拒绝归档；请先新建或恢复一个计划".into(),
        ));
    };
    // 唯一索引要求同一项目最多一个 is_active=1：先清当前计划，再置继任。
    conn.execute(
        "UPDATE planning_projects SET is_active = 0 WHERE id = ?1",
        params![plan_id],
    )?;
    conn.execute(
        "UPDATE planning_projects SET is_active = 1, updated_at = ?2 WHERE id = ?1",
        params![next, now],
    )?;
    conn.execute(
        "UPDATE workspace_projects SET active_plan_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![project_id, next, now],
    )?;
    conn.execute(
        "UPDATE planning_projects SET archived = 1, updated_at = ?2 WHERE id = ?1",
        params![plan_id, now],
    )?;
    Ok(())
}

pub fn archive_plan(db: &Db, plan_id: &str, archived: bool) -> AppResult<()> {
    db.with_transaction(|conn| archive_plan_tx(conn, plan_id, archived))
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
        // 名称契约（v87）：项目名称是唯一事实来源，计划名称只是镜像。
        // 允许省略（默认取项目名），但拒绝独立命名——否则项目重命名时
        // 要么覆盖用户自定义名称，要么让两处名称长期互相矛盾。
        let name = match input.name {
            Some(value) => {
                let value = clean_text(&value, "计划名称", MAX_NAME, false)?;
                if value != project_name {
                    return Err(AppError::Validation(
                        "计划名称跟随项目名称，不支持单独命名；请先修改项目名称".into(),
                    ));
                }
                value
            }
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
///
/// 弱引用处置（同一事务，不静默丢业务数据）：
/// - `task_plan_links`：删除该计划的阶段/里程碑关联，但先把任务补登到
///   `workspace_task_links`，保证任务作为项目级实体继续存在；
/// - `plan_dependencies`：删除指向被删阶段的依赖（依赖本身没有独立业务含义）；
/// - `project_capability_requirements.phase_id` / `project_deliverables.phase_id`：
///   **清空阶段归属、保留实体**。交付物与能力需求是项目级业务数据，
///   不因计划删除而消失；需要继续挂阶段的，由用户在继任计划中重新指定；
/// - `plan_versions`：保留为历史快照（只读历史，不随计划删除）。
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
            // 继任者只能从未归档计划中选择；没有合法继任者则拒绝删除。
            let successor: Option<String> = conn
                .query_row(
                    &format!(
                        "SELECT id FROM planning_projects
                         WHERE ({OWNED_PLANS_WHERE}) AND id <> ?2 AND archived = 0
                         ORDER BY sort_order, updated_at DESC, id ASC LIMIT 1"
                    ),
                    params![project_id, plan_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(next) = successor else {
                return Err(AppError::Conflict(
                    "当前计划没有未归档的继任计划，已拒绝删除；请先新建或恢复一个计划".into(),
                ));
            };
            // 唯一索引要求同一项目最多一个 is_active=1：先清当前计划，再置继任。
            conn.execute(
                "UPDATE planning_projects SET is_active = 0 WHERE id = ?1",
                params![plan_id],
            )?;
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

    // ── 计划级弱引用清理（先收集 ID，再按 ID 清理）────────────────────
    let phase_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM planning_milestones WHERE project_id = ?1 AND kind = 'phase'",
        )?;
        let rows = stmt.query_map(params![plan_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)?
    };
    let milestone_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM planning_milestones WHERE project_id = ?1 AND kind = 'milestone'",
        )?;
        let rows = stmt.query_map(params![plan_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)?
    };
    let mut preserved_tasks = 0usize;
    let mut removed_task_links = 0usize;
    let mut removed_dependencies = 0usize;
    let mut detached_capabilities = 0usize;
    let mut detached_deliverables = 0usize;
    if let Some(project_id) = project_id.as_deref() {
        // 任务必须继续存在：先把仅靠计划关联的任务补登到项目级关联。
        for phase_id in &phase_ids {
            preserved_tasks += conn.execute(
                "INSERT OR IGNORE INTO workspace_task_links (project_id, task_id, created_at)
                 SELECT ?1, l.task_id, ?3 FROM task_plan_links l
                  WHERE l.project_id = ?1 AND l.phase_id = ?2",
                params![project_id, phase_id, now],
            )?;
        }
        for milestone_id in &milestone_ids {
            preserved_tasks += conn.execute(
                "INSERT OR IGNORE INTO workspace_task_links (project_id, task_id, created_at)
                 SELECT ?1, l.task_id, ?3 FROM task_plan_links l
                  WHERE l.project_id = ?1 AND l.milestone_id = ?2",
                params![project_id, milestone_id, now],
            )?;
        }
        // 计划级任务关联整体删除：phase_id / milestone_id 属于被删计划的行。
        for phase_id in &phase_ids {
            removed_task_links += conn.execute(
                "DELETE FROM task_plan_links WHERE project_id = ?1 AND phase_id = ?2",
                params![project_id, phase_id],
            )?;
        }
        for milestone_id in &milestone_ids {
            removed_task_links += conn.execute(
                "DELETE FROM task_plan_links WHERE project_id = ?1 AND milestone_id = ?2",
                params![project_id, milestone_id],
            )?;
        }
        for phase_id in &phase_ids {
            removed_dependencies += conn.execute(
                "DELETE FROM plan_dependencies
                  WHERE project_id = ?1 AND (phase_id = ?2 OR depends_on_phase_id = ?2)",
                params![project_id, phase_id],
            )?;
        }
        // 能力需求与交付物：清空阶段归属，保留实体（项目级业务数据）。
        for phase_id in &phase_ids {
            detached_capabilities += conn.execute(
                "UPDATE project_capability_requirements SET phase_id = NULL, updated_at = ?3
                  WHERE project_id = ?1 AND phase_id = ?2",
                params![project_id, phase_id, now],
            )?;
            detached_deliverables += conn.execute(
                "UPDATE project_deliverables SET phase_id = NULL, updated_at = ?3
                  WHERE project_id = ?1 AND phase_id = ?2",
                params![project_id, phase_id, now],
            )?;
        }
        // 兜底：清理指向「已不属于本项目任何计划」的阶段 ID（历史脏数据）。
        // 只清能力/交付物的阶段归属；任务关联不动其他计划的行。
        conn.execute(
            "UPDATE project_capability_requirements SET phase_id = NULL, updated_at = ?2
              WHERE project_id = ?1 AND phase_id IS NOT NULL
                AND phase_id NOT IN (SELECT id FROM planning_milestones
                                      WHERE project_id IN (SELECT id FROM planning_projects
                                                            WHERE workspace_project_id = ?1))",
            params![project_id, now],
        )?;
        conn.execute(
            "UPDATE project_deliverables SET phase_id = NULL, updated_at = ?2
              WHERE project_id = ?1 AND phase_id IS NOT NULL
                AND phase_id NOT IN (SELECT id FROM planning_milestones
                                      WHERE project_id IN (SELECT id FROM planning_projects
                                                            WHERE workspace_project_id = ?1))",
            params![project_id, now],
        )?;
    }

    conn.execute(
        "DELETE FROM planning_projects WHERE id = ?1",
        params![plan_id],
    )?;
    if let Some(project_id) = project_id {
        conn.execute(
            "INSERT INTO project_events
             (id, project_id, kind, actor, summary, payload_json, created_at)
             VALUES (?1, ?2, 'plan_deleted', 'user', ?3, ?4, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                project_id,
                format!("删除计划「{}」并清理计划级关联", plan.name),
                serde_json::json!({
                    "planId": plan_id,
                    "phases": phase_ids.len(),
                    "milestones": milestone_ids.len(),
                    "tasksPreserved": preserved_tasks,
                    "taskLinksRemoved": removed_task_links,
                    "dependenciesRemoved": removed_dependencies,
                    "capabilitiesDetached": detached_capabilities,
                    "deliverablesDetached": detached_deliverables,
                })
                .to_string(),
                now
            ],
        )?;
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
        "SELECT id, is_active, workspace_project_id, archived FROM planning_projects WHERE {OWNED_PLANS_WHERE}"
    ))?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? != 0,
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            r.get::<_, i64>(3)? != 0,
        ))
    })?;
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    let mut plan_count = 0i64;
    let mut archived_plan_count = 0i64;
    let mut active_ids = Vec::new();
    let mut archived_active_ids = Vec::new();
    let mut archived_ids = Vec::new();
    for row in rows {
        let (id, is_active, linked, archived) = row?;
        plan_count += 1;
        if archived {
            archived_plan_count += 1;
            archived_ids.push(id.clone());
        }
        if is_active {
            active_ids.push(id.clone());
            if archived {
                archived_active_ids.push(id.clone());
            }
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
        if !archived_active_ids.is_empty() {
            blocking.push(format!(
                "active 计划 {} 处于 archived 状态",
                archived_active_ids.join(", ")
            ));
        }
        if archived_plan_count == plan_count {
            blocking.push("项目全部计划均已归档，没有可用计划".to_string());
        }
        match active_plan_id.as_deref() {
            None => blocking.push("项目 active_plan_id 为空".to_string()),
            Some(pointer) if !active_ids.iter().any(|id| id == pointer) => {
                blocking.push("active_plan_id 未指向本项目的 active 计划".to_string())
            }
            Some(pointer) if archived_ids.iter().any(|id| id == pointer) => {
                blocking.push("active_plan_id 指向已归档计划".to_string())
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

    // ── 计划级弱引用完整性（v87）─────────────────────────────────────
    // 口径：
    // - 跨项目引用是 blocking：它意味着数据归属被写错（安全/一致性风险）；
    // - 指向不存在或非当前计划的引用是 warning：任务/交付物实体仍在，
    //   只是阶段归属需要重新指定，不应当阻塞项目读取。
    let active_plan = active_plan_id.clone().unwrap_or_default();
    let task_phase_outside: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_plan_links l
          WHERE l.project_id = ?1 AND l.phase_id <> ''
            AND NOT EXISTS (SELECT 1 FROM planning_milestones m
                             WHERE m.id = l.phase_id AND m.project_id = ?2)",
        params![project_id, active_plan],
        |r| r.get(0),
    )?;
    if task_phase_outside > 0 {
        warnings.push(format!(
            "{task_phase_outside} 条任务阶段关联不属于当前计划，将按「未分阶段」展示"
        ));
    }
    let task_milestone_outside: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_plan_links l
          WHERE l.project_id = ?1 AND l.milestone_id <> ''
            AND NOT EXISTS (SELECT 1 FROM planning_milestones m
                             WHERE m.id = l.milestone_id AND m.project_id = ?2)",
        params![project_id, active_plan],
        |r| r.get(0),
    )?;
    if task_milestone_outside > 0 {
        warnings.push(format!(
            "{task_milestone_outside} 条任务里程碑关联不属于当前计划，将按「未归属」展示"
        ));
    }
    let cross_project_task_refs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_plan_links l
           JOIN planning_milestones m ON m.id = l.phase_id
           JOIN planning_projects p ON p.id = m.project_id
          WHERE l.project_id = ?1 AND COALESCE(p.workspace_project_id, '') <> ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    if cross_project_task_refs > 0 {
        blocking.push(format!(
            "{cross_project_task_refs} 条任务阶段关联指向其他项目的阶段"
        ));
    }
    let capability_cross_project: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_capability_requirements r
           JOIN planning_milestones m ON m.id = r.phase_id
           JOIN planning_projects p ON p.id = m.project_id
          WHERE r.project_id = ?1 AND COALESCE(p.workspace_project_id, '') <> ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    if capability_cross_project > 0 {
        blocking.push(format!(
            "{capability_cross_project} 条能力需求阶段关联指向其他项目的阶段"
        ));
    }
    let deliverable_cross_project: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_deliverables d
           JOIN planning_milestones m ON m.id = d.phase_id
           JOIN planning_projects p ON p.id = m.project_id
          WHERE d.project_id = ?1 AND COALESCE(p.workspace_project_id, '') <> ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    if deliverable_cross_project > 0 {
        blocking.push(format!(
            "{deliverable_cross_project} 条交付物阶段关联指向其他项目的阶段"
        ));
    }
    let dangling_capability_phases: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_capability_requirements r
          WHERE r.project_id = ?1 AND r.phase_id IS NOT NULL AND r.phase_id <> ''
            AND NOT EXISTS (SELECT 1 FROM planning_milestones m WHERE m.id = r.phase_id)",
        params![project_id],
        |r| r.get(0),
    )?;
    if dangling_capability_phases > 0 {
        warnings.push(format!(
            "{dangling_capability_phases} 条能力需求的阶段已不存在（保留实体，阶段归属待重新指定）"
        ));
    }
    let dangling_deliverable_phases: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_deliverables d
          WHERE d.project_id = ?1 AND d.phase_id IS NOT NULL AND d.phase_id <> ''
            AND NOT EXISTS (SELECT 1 FROM planning_milestones m WHERE m.id = d.phase_id)",
        params![project_id],
        |r| r.get(0),
    )?;
    if dangling_deliverable_phases > 0 {
        warnings.push(format!(
            "{dangling_deliverable_phases} 条交付物的阶段已不存在（保留实体，阶段归属待重新指定）"
        ));
    }
    let dangling_dependencies: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plan_dependencies d
          WHERE d.project_id = ?1
            AND (NOT EXISTS (SELECT 1 FROM planning_milestones m WHERE m.id = d.phase_id)
              OR NOT EXISTS (SELECT 1 FROM planning_milestones m WHERE m.id = d.depends_on_phase_id))",
        params![project_id],
        |r| r.get(0),
    )?;
    if dangling_dependencies > 0 {
        warnings.push(format!("{dangling_dependencies} 条计划阶段依赖指向已不存在的阶段"));
    }
    let version_project_mismatch: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plan_versions v
          WHERE v.project_id <> ?1
            AND v.plan_id IN (SELECT id FROM planning_projects WHERE workspace_project_id = ?1)",
        params![project_id],
        |r| r.get(0),
    )?;
    if version_project_mismatch > 0 {
        blocking.push(format!(
            "{version_project_mismatch} 条计划版本的项目归属与计划不一致"
        ));
    }
    let version_missing_plan: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plan_versions v
          WHERE v.project_id = ?1
            AND NOT EXISTS (SELECT 1 FROM planning_projects p WHERE p.id = v.plan_id)",
        params![project_id],
        |r| r.get(0),
    )?;
    if version_missing_plan > 0 {
        warnings.push(format!(
            "{version_missing_plan} 条计划版本属于已删除计划（保留为历史快照）"
        ));
    }

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

