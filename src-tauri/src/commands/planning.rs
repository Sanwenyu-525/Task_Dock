//! 规划中心（v0.7）：用户自建多项目的功能规划、开发步骤、里程碑与进度历史。
//!
//! 数据边界（与内置路线图严格分离）：
//! - Task Dock 自身的功能规划是 `lib/featureCatalog.ts` 静态目录，不入库、
//!   不被本模块读写，也不允许用户编辑覆盖；
//! - 本模块只服务「我的项目」：SQLite `planning_*` 五张表（迁移 v18）。
//!
//! 语义约定：
//! - 功能状态与步骤进度相互独立，绝不由完成率推断状态
//!   （步骤 5/5 但功能仍处于 review 是合法状态）；
//! - 每次功能状态变化在同一事务写入 `status_change` 历史；
//!   步骤勾选/重开写入 `step_done`；用户开发日志为 `note`；
//! - 无步骤的功能不产出百分比（前端显示「未拆分步骤」）；
//!   无功能的项目不产出 0% 进度（前端显示空态）；
//! - 所有写操作失败整体回滚，不留半套数据。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use super::tasks::deserialize_optional_field;
use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const PROJECT_STATUSES: &[&str] = &["planning", "in_progress", "paused", "completed"];
pub const FEATURE_STATUSES: &[&str] = &[
    "planned",
    "in_progress",
    "review",
    "completed",
    "blocked",
    "paused",
];
pub const FEATURE_PRIORITIES: &[&str] = &["P0", "P1", "P2"];
pub const ACTIVITY_KINDS: &[&str] = &["note", "status_change", "step_done"];

// ── 返回模型 ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct ProjectStats {
    pub feature_total: i64,
    pub feature_completed: i64,
    pub feature_in_progress: i64,
    pub feature_blocked: i64,
    /// 以下计数用于总览统计卡；语义与功能状态一一对应。
    pub feature_planned: i64,
    pub feature_review: i64,
    pub feature_paused: i64,
    /// false = 项目还没有功能；此时 progress_percent 恒为 0，
    /// 前端必须显示「尚未添加功能」而不是 0% 进度。
    pub has_features: bool,
    pub progress_percent: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanningProject {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub archived: bool,
    pub target_date: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 乐观并发版本（v37）：每次项目内容写成功后 +1；更新路径可传
    /// expected_revision，不匹配返回 Conflict。缺省保持旧行为（向后兼容）。
    pub revision: i64,
    pub stats: ProjectStats,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanningStep {
    pub id: String,
    pub feature_id: String,
    pub title: String,
    pub done: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanningFeature {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    /// 验收标准（可空文本）；与 steps 分离，不用步骤冒充。
    pub acceptance_criteria: String,
    pub status: String,
    pub priority: String,
    pub milestone_id: Option<String>,
    pub milestone_name: Option<String>,
    pub target_date: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// 乐观并发版本（v37）：功能/步骤内容写成功后 +1；MCP 写工具强制校验。
    pub revision: i64,
    pub steps: Vec<PlanningStep>,
    /// 总步骤数；0 = 未拆分步骤（不产出百分比，前端如实显示）
    pub step_total: i64,
    pub step_done: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanningMilestone {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub target_date: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub feature_total: i64,
    pub feature_completed: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanningActivity {
    pub id: String,
    pub project_id: String,
    pub feature_id: Option<String>,
    /// 功能可能已被删除（历史级联清除前不可达此情况；保留 Option 仅为 JOIN 安全）
    pub feature_title: Option<String>,
    pub kind: String,
    pub old_status: Option<String>,
    pub new_status: Option<String>,
    pub message: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ActivityPage {
    pub items: Vec<PlanningActivity>,
    /// 按 limit+1 探测；true = 还有更早记录，可继续「加载更多」
    pub has_more: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanningAgentFeatureLink {
    pub id: String,
    pub feature_id: String,
    pub feature_title: String,
    pub project_id: String,
    pub project_name: String,
    pub agent_source: String,
    pub agent_name: Option<String>,
    pub session_id: String,
    pub status: String,
    pub agent_status: Option<String>,
    pub agent_session_id: Option<String>,
    pub last_seen_at: Option<String>,
    pub last_execution_at: Option<String>,
}

// ── 输入模型 ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Deserialize)]
pub struct ProjectPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// 三态：缺省 = 保持原值；null = 清除；值 = 设置
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub target_date: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
    /// 乐观并发（v37）：传入时校验当前 revision，不匹配返回 Conflict；不传保持旧行为
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

#[derive(Deserialize)]
pub struct FeatureInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance_criteria: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub milestone_id: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Deserialize)]
pub struct FeaturePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub acceptance_criteria: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    /// 三态：缺省 = 保持原关联；null = 取消关联；值 = 换关联
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub milestone_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub target_date: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
    /// 乐观并发（v37）：传入时校验当前 revision，不匹配返回 Conflict；不传保持旧行为
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

#[derive(Deserialize)]
pub struct MilestoneInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Deserialize)]
pub struct MilestonePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub target_date: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Deserialize)]
pub struct StepPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub done: Option<bool>,
    /// 乐观并发（v37）：校验所属功能的 revision；不传保持旧行为
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

// ── 校验与工具 ───────────────────────────────────────────────────────

fn check_name(name: &str, what: &str, max: usize) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation(format!("{}名称不能为空", what)));
    }
    if name.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{}名称超过 {} 字符",
            what, max
        )));
    }
    Ok(name.to_string())
}

fn check_text(text: &str, what: &str, max: usize) -> AppResult<String> {
    if text.chars().count() > max {
        return Err(AppError::Validation(format!("{}超过 {} 字符", what, max)));
    }
    Ok(text.to_string())
}

/// 目标日期统一为 `YYYY-MM-DD`（仅日期，不带时区；空串视为清除）。
fn normalize_date(date: &Option<String>) -> AppResult<Option<String>> {
    match date {
        None => Ok(None),
        Some(d) if d.trim().is_empty() => Ok(None),
        Some(d) => {
            let d = d.trim();
            chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .map_err(|_| AppError::Validation(format!("目标日期格式应为 YYYY-MM-DD：{}", d)))?;
            Ok(Some(d.to_string()))
        }
    }
}

/// 日期字段的更新意图（由三态 `Option<Option<String>>` 解析而来）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum DateUpdate {
    /// 请求未提及该字段：保持库中原值
    Keep,
    /// 写入新值（None = 清除）
    Set(Option<String>),
}

fn parse_date_update(v: &Option<Option<String>>) -> AppResult<DateUpdate> {
    match v {
        None => Ok(DateUpdate::Keep),
        Some(inner) => Ok(DateUpdate::Set(normalize_date(inner)?)),
    }
}

fn resolve_date(current: &Option<String>, upd: &DateUpdate) -> Option<String> {
    match upd {
        DateUpdate::Keep => current.clone(),
        DateUpdate::Set(v) => v.clone(),
    }
}

fn check_status(status: &str, allowed: &[&str], what: &str) -> AppResult<()> {
    if !allowed.contains(&status) {
        return Err(AppError::Validation(format!(
            "非法{}状态: {}",
            what, status
        )));
    }
    Ok(())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 追加到排序末尾。
fn next_sort_order(conn: &Connection, table: &str, scope: Option<(&str, &str)>) -> AppResult<i64> {
    let n: i64 = match scope {
        // 无占位符的分支不能绑参数（rusqlite 严格校验参数个数）
        None => conn
            .query_row(
                &format!("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {}", table),
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)?,
        Some((col, id)) => conn
            .query_row(
                &format!(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {} WHERE {} = ?1",
                    table, col
                ),
                rusqlite::params![id],
                |r| r.get(0),
            )
            .map_err(AppError::from)?,
    };
    Ok(n)
}

fn project_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM planning_projects WHERE id = ?1",
            rusqlite::params![id],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppError::from)?
        .is_some())
}

/// 乐观并发（v37）：校验 expected_revision 与当前 revision 一致。
/// 不匹配返回 Conflict（携带当前 revision），防止 MCP 客户端后写无声覆盖。
/// 不传（None）保持旧行为——UI 命令向后兼容，MCP 工具层强制传值。
fn check_expected_revision_tx(
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

// ── 行映射 ───────────────────────────────────────────────────────────

fn project_stats_from(
    total: i64,
    completed: i64,
    in_progress: i64,
    blocked: i64,
    planned: i64,
    review: i64,
    paused: i64,
) -> ProjectStats {
    let has_features = total > 0;
    ProjectStats {
        feature_total: total,
        feature_completed: completed,
        feature_in_progress: in_progress,
        feature_blocked: blocked,
        feature_planned: planned,
        feature_review: review,
        feature_paused: paused,
        has_features,
        progress_percent: if has_features {
            completed * 100 / total
        } else {
            0
        },
    }
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanningProject> {
    let stats = project_stats_from(
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
    );
    Ok(PlanningProject {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        status: row.get(3)?,
        archived: row.get::<_, i64>(4)? != 0,
        target_date: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        revision: row.get(16)?,
        stats,
    })
}

const PROJECT_SELECT: &str = "SELECT p.id, p.name, p.description, p.status, p.archived, p.target_date,
     p.sort_order, p.created_at, p.updated_at,
     COALESCE(f.total, 0), COALESCE(f.completed, 0), COALESCE(f.in_progress, 0), COALESCE(f.blocked, 0),
     COALESCE(f.planned, 0), COALESCE(f.review, 0), COALESCE(f.paused, 0), p.revision
   FROM planning_projects p
   LEFT JOIN (
     SELECT project_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END) AS planned,
            SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review,
            SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused
     FROM planning_features GROUP BY project_id
   ) f ON f.project_id = p.id";

/// 事务内按 id 读取项目（含统计）；不存在返回错误。
pub(crate) fn load_project_tx(conn: &Connection, id: &str) -> AppResult<PlanningProject> {
    let sql = format!("{} WHERE p.id = ?1", PROJECT_SELECT);
    conn.query_row(&sql, rusqlite::params![id], row_to_project)
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("项目不存在: {}", id)))
}

const FEATURE_SELECT: &str = "SELECT f.id, f.project_id, f.title, f.description, f.status, f.priority,
     f.milestone_id, m.name, f.target_date, f.sort_order, f.created_at, f.updated_at, f.completed_at,
     f.acceptance_criteria, f.revision
   FROM planning_features f
   LEFT JOIN planning_milestones m ON m.id = f.milestone_id";

fn row_to_feature(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanningFeature> {
    Ok(PlanningFeature {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        acceptance_criteria: row.get(13)?,
        status: row.get(4)?,
        priority: row.get(5)?,
        milestone_id: row.get(6)?,
        milestone_name: row.get(7)?,
        target_date: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        completed_at: row.get(12)?,
        revision: row.get(14)?,
        steps: Vec::new(),
        step_total: 0,
        step_done: 0,
    })
}

/// 事务内按 id 读取功能（含步骤与进度）；不存在返回错误。
pub(crate) fn load_feature_tx(conn: &Connection, id: &str) -> AppResult<PlanningFeature> {
    let sql = format!("{} WHERE f.id = ?1", FEATURE_SELECT);
    let mut feature = conn
        .query_row(&sql, rusqlite::params![id], row_to_feature)
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("功能不存在: {}", id)))?;
    attach_steps(conn, &mut feature)?;
    Ok(feature)
}

/// 读取功能下的步骤并计算步骤进度。
fn attach_steps(conn: &Connection, feature: &mut PlanningFeature) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, feature_id, title, done, sort_order, created_at, updated_at, completed_at
         FROM planning_feature_steps WHERE feature_id = ?1 ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(rusqlite::params![feature.id], |row| {
        Ok(PlanningStep {
            id: row.get(0)?,
            feature_id: row.get(1)?,
            title: row.get(2)?,
            done: row.get::<_, i64>(3)? != 0,
            sort_order: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            completed_at: row.get(7)?,
        })
    })?;
    let mut done = 0i64;
    for step in rows {
        let step = step.map_err(AppError::from)?;
        if step.done {
            done += 1;
        }
        feature.steps.push(step);
    }
    feature.step_total = feature.steps.len() as i64;
    feature.step_done = done;
    Ok(())
}

fn row_to_milestone(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanningMilestone> {
    Ok(PlanningMilestone {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        target_date: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        feature_total: row.get(8)?,
        feature_completed: row.get(9)?,
    })
}

const MILESTONE_SELECT: &str =
    "SELECT ms.id, ms.project_id, ms.name, ms.description, ms.target_date,
     ms.sort_order, ms.created_at, ms.updated_at,
     COALESCE(f.total, 0), COALESCE(f.completed, 0)
   FROM planning_milestones ms
   LEFT JOIN (
     SELECT milestone_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
     FROM planning_features WHERE milestone_id IS NOT NULL GROUP BY milestone_id
   ) f ON f.milestone_id = ms.id";

/// 事务内按 id 读取里程碑（含关联功能统计）。
fn load_milestone_tx(conn: &Connection, id: &str) -> AppResult<PlanningMilestone> {
    let sql = format!("{} WHERE ms.id = ?1", MILESTONE_SELECT);
    conn.query_row(&sql, rusqlite::params![id], row_to_milestone)
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("里程碑不存在: {}", id)))
}

/// 同一事务写入功能状态变化历史（spec 第五章：重要状态变更必须同事务留痕）。
fn record_status_change_tx(
    conn: &Connection,
    project_id: &str,
    feature_id: &str,
    old_status: &str,
    new_status: &str,
    message: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO planning_activity (id, project_id, feature_id, kind, old_status, new_status, message, created_at)
         VALUES (?1, ?2, ?3, 'status_change', ?4, ?5, ?6, ?7)",
        rusqlite::params![new_id(), project_id, feature_id, old_status, new_status, message, now_iso()],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// 同一事务写入步骤完成/重开事件。
fn record_step_event_tx(
    conn: &Connection,
    project_id: &str,
    feature_id: &str,
    message: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO planning_activity (id, project_id, feature_id, kind, message, created_at)
         VALUES (?1, ?2, ?3, 'step_done', ?4, ?5)",
        rusqlite::params![new_id(), project_id, feature_id, message, now_iso()],
    )
    .map_err(AppError::from)?;
    Ok(())
}

// ── 项目命令 ─────────────────────────────────────────────────────────
//
// 命令层是薄包装：核心逻辑放在 `*_impl(db: &Db, …)` 内核函数上，
// 单测可直接以 Db::open_in_memory 驱动完整读写路径，不经 Tauri 运行时。

pub(crate) fn list_projects_impl(
    db: &Db,
    include_archived: Option<bool>,
) -> AppResult<Vec<PlanningProject>> {
    let include_all = include_archived.unwrap_or(true);
    let sql = if include_all {
        format!(
            "{} ORDER BY p.archived ASC, p.sort_order ASC, p.created_at ASC",
            PROJECT_SELECT
        )
    } else {
        format!(
            "{} WHERE p.archived = 0 ORDER BY p.sort_order ASC, p.created_at ASC",
            PROJECT_SELECT
        )
    };
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_project)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn planning_list_projects(
    db: State<'_, Arc<Db>>,
    include_archived: Option<bool>,
) -> AppResult<Vec<PlanningProject>> {
    list_projects_impl(&db, include_archived)
}

pub(crate) fn create_project_tx(
    conn: &Connection,
    input: ProjectInput,
) -> AppResult<PlanningProject> {
    let name = check_name(&input.name, "项目", 100)?;
    let description = check_text(&input.description, "项目描述", 2000)?;
    let status = input.status.as_deref().unwrap_or("planning");
    check_status(status, PROJECT_STATUSES, "项目")?;
    let target_date = normalize_date(&input.target_date)?;
    let now = now_iso();
    let id = new_id();
    let sort_order = next_sort_order(conn, "planning_projects", None)?;
    conn.execute(
        "INSERT INTO planning_projects (id, name, description, status, archived, target_date, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?7)",
        rusqlite::params![id, name, description, status, target_date, sort_order, now],
    )
    .map_err(AppError::from)?;
    load_project_tx(conn, &id)
}

pub(crate) fn create_project_impl(db: &Db, input: ProjectInput) -> AppResult<PlanningProject> {
    db.with_transaction(|conn| create_project_tx(conn, input))
}

#[tauri::command]
pub fn planning_create_project(
    db: State<'_, Arc<Db>>,
    input: ProjectInput,
) -> AppResult<PlanningProject> {
    create_project_impl(&db, input)
}

pub(crate) fn update_project_tx(
    conn: &Connection,
    id: String,
    patch: ProjectPatch,
) -> AppResult<PlanningProject> {
    let name = match &patch.name {
        Some(n) => Some(check_name(n, "项目", 100)?),
        None => None,
    };
    let description = match &patch.description {
        Some(d) => Some(check_text(d, "项目描述", 2000)?),
        None => None,
    };
    if let Some(s) = &patch.status {
        check_status(s, PROJECT_STATUSES, "项目")?;
    }
    let now = now_iso();
    let current: (Option<String>, i64) = conn
        .query_row(
            "SELECT target_date, revision FROM planning_projects WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("项目不存在: {}", id)))?;
    let target_date = resolve_date(&current.0, &parse_date_update(&patch.target_date)?);
    check_expected_revision_tx(conn, "planning_projects", &id, patch.expected_revision)?;
    conn.execute(
        "UPDATE planning_projects SET
           name = COALESCE(?1, name),
           description = COALESCE(?2, description),
           status = COALESCE(?3, status),
           target_date = ?4,
           sort_order = COALESCE(?5, sort_order),
           revision = revision + 1,
           updated_at = ?6
         WHERE id = ?7",
        rusqlite::params![
            name,
            description,
            patch.status,
            target_date,
            patch.sort_order,
            now,
            id
        ],
    )
    .map_err(AppError::from)?;
    load_project_tx(conn, &id)
}

pub(crate) fn update_project_impl(
    db: &Db,
    id: String,
    patch: ProjectPatch,
) -> AppResult<PlanningProject> {
    db.with_transaction(|conn| update_project_tx(conn, id, patch))
}

#[tauri::command]
pub fn planning_update_project(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: ProjectPatch,
) -> AppResult<PlanningProject> {
    update_project_impl(&db, id, patch)
}

/// 归档 / 恢复：archived 与项目状态相互独立，归档不丢数据、可随时恢复。
pub(crate) fn archive_project_impl(
    db: &Db,
    id: String,
    archived: bool,
) -> AppResult<PlanningProject> {
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if !project_exists(&tx, &id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", id)));
        }
        tx.execute(
            "UPDATE planning_projects SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![archived as i64, now, id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    db.with_read(|conn| load_project_tx(conn, &id))
}

#[tauri::command]
pub fn planning_archive_project(
    db: State<'_, Arc<Db>>,
    id: String,
    archived: bool,
) -> AppResult<PlanningProject> {
    archive_project_impl(&db, id, archived)
}

/// 删除项目：级联删除其里程碑、功能、步骤与全部进度历史（FK ON DELETE CASCADE）。
/// 前端必须在调用前弹确认框说明影响面，防止误删。
pub(crate) fn delete_project_impl(db: &Db, id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if !project_exists(&tx, &id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", id)));
        }
        tx.execute(
            "DELETE FROM planning_projects WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

#[tauri::command]
pub fn planning_delete_project(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    delete_project_impl(&db, id)
}

/// 项目排序：按传入 id 顺序写入 sort_order；只允许调整已存在项目。
pub(crate) fn reorder_projects_impl(db: &Db, ids: Vec<String>) -> AppResult<()> {
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            let n = tx
                .execute(
                    "UPDATE planning_projects SET sort_order = ?1, updated_at = ?3 WHERE id = ?2",
                    rusqlite::params![i as i64, id, now],
                )
                .map_err(AppError::from)?;
            if n == 0 {
                return Err(AppError::Validation(format!("项目不存在: {}", id)));
            }
        }
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

#[tauri::command]
pub fn planning_reorder_projects(db: State<'_, Arc<Db>>, ids: Vec<String>) -> AppResult<()> {
    reorder_projects_impl(&db, ids)
}

// ── 功能命令 ─────────────────────────────────────────────────────────

pub(crate) fn list_features_impl(db: &Db, project_id: String) -> AppResult<Vec<PlanningFeature>> {
    db.with_read(|conn| {
        if !project_exists(conn, &project_id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
        }
        // 功能主列表 + 项目内全部步骤一次取回，Rust 端按 feature_id 分组
        let sql = format!(
            "{} WHERE f.project_id = ?1 ORDER BY f.sort_order, f.created_at",
            FEATURE_SELECT
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![project_id], row_to_feature)?;
        let mut features: Vec<PlanningFeature> = Vec::new();
        for r in rows {
            features.push(r.map_err(AppError::from)?);
        }
        let mut step_stmt = conn.prepare(
            "SELECT s.id, s.feature_id, s.title, s.done, s.sort_order, s.created_at, s.updated_at, s.completed_at
             FROM planning_feature_steps s
             JOIN planning_features f ON f.id = s.feature_id
             WHERE f.project_id = ?1 ORDER BY s.sort_order, s.created_at",
        )?;
        let step_rows = step_stmt.query_map(rusqlite::params![project_id], |row| {
            Ok(PlanningStep {
                id: row.get(0)?,
                feature_id: row.get(1)?,
                title: row.get(2)?,
                done: row.get::<_, i64>(3)? != 0,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })?;
        let mut steps_by_feature: std::collections::HashMap<String, Vec<PlanningStep>> =
            std::collections::HashMap::new();
        for s in step_rows {
            let step = s.map_err(AppError::from)?;
            steps_by_feature.entry(step.feature_id.clone()).or_default().push(step);
        }
        for f in features.iter_mut() {
            let mut done = 0i64;
            if let Some(steps) = steps_by_feature.get_mut(&f.id) {
                for s in steps.iter() {
                    if s.done {
                        done += 1;
                    }
                }
                f.steps = std::mem::take(steps);
            }
            f.step_total = f.steps.len() as i64;
            f.step_done = done;
        }
        Ok(features)
    })
}

#[tauri::command]
pub fn planning_list_features(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<Vec<PlanningFeature>> {
    list_features_impl(&db, project_id)
}

const PLANNING_AGENT_LINK_SELECT: &str = "SELECT l.id, l.feature_id, f.title, f.project_id,
       p.name, l.agent_source, a.display_name, l.session_id, l.status, s.status, s.id,
       s.last_seen_at,
       (SELECT MAX(r.started_at) FROM agent_runs r WHERE r.session_id = s.id)
   FROM feature_agent_links l
   JOIN planning_features f ON f.id = l.feature_id
   JOIN planning_projects p ON p.id = f.project_id
   LEFT JOIN agent_sources a ON a.id = l.agent_source
   LEFT JOIN agent_sessions s ON s.source_id = l.agent_source
       AND s.external_id = l.session_id AND s.origin = 'real'";

fn row_to_planning_agent_link(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PlanningAgentFeatureLink> {
    Ok(PlanningAgentFeatureLink {
        id: row.get(0)?,
        feature_id: row.get(1)?,
        feature_title: row.get(2)?,
        project_id: row.get(3)?,
        project_name: row.get(4)?,
        agent_source: row.get(5)?,
        agent_name: row.get(6)?,
        session_id: row.get(7)?,
        status: row.get(8)?,
        agent_status: row.get(9)?,
        agent_session_id: row.get(10)?,
        last_seen_at: row.get(11)?,
        last_execution_at: row.get(12)?,
    })
}

fn list_feature_agent_links_inner(
    conn: &Connection,
    feature_id: &str,
) -> AppResult<Vec<PlanningAgentFeatureLink>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM planning_features WHERE id = ?1)",
        rusqlite::params![feature_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::Validation(format!("功能不存在: {feature_id}")));
    }
    let sql =
        format!("{PLANNING_AGENT_LINK_SELECT} WHERE l.feature_id = ?1 ORDER BY l.created_at, l.id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![feature_id], row_to_planning_agent_link)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub(crate) fn list_feature_agent_links_impl(
    db: &Db,
    feature_id: &str,
) -> AppResult<Vec<PlanningAgentFeatureLink>> {
    db.with_read(|conn| list_feature_agent_links_inner(conn, feature_id))
}

#[tauri::command]
pub fn planning_list_feature_agent_links(
    db: State<'_, Arc<Db>>,
    feature_id: String,
) -> AppResult<Vec<PlanningAgentFeatureLink>> {
    list_feature_agent_links_impl(&db, &feature_id)
}

fn list_agent_feature_links_inner(
    conn: &Connection,
    agent_source: &str,
    session_id: &str,
) -> AppResult<Vec<PlanningAgentFeatureLink>> {
    let sql = format!(
        "{PLANNING_AGENT_LINK_SELECT}
         WHERE l.agent_source = ?1 AND l.session_id = ?2 AND l.status = 'linked'
         ORDER BY l.created_at DESC, l.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params![agent_source, session_id],
        row_to_planning_agent_link,
    )?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command]
pub fn planning_list_agent_feature_links(
    db: State<'_, Arc<Db>>,
    agent_source: String,
    session_id: String,
) -> AppResult<Vec<PlanningAgentFeatureLink>> {
    let agent_source = agent_source.trim();
    let session_id = session_id.trim();
    if agent_source.is_empty() || agent_source.chars().count() > 64 {
        return Err(AppError::Validation("Agent 来源无效".into()));
    }
    if session_id.is_empty() || session_id.chars().count() > 256 {
        return Err(AppError::Validation("Agent 会话 ID 无效".into()));
    }
    db.with_read(|conn| list_agent_feature_links_inner(conn, agent_source, session_id))
}

fn unlink_agent_session_impl(
    db: &Db,
    feature_id: &str,
    agent_source: &str,
    session_id: &str,
) -> AppResult<String> {
    db.with_transaction(|conn| {
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM planning_features WHERE id = ?1",
                rusqlite::params![feature_id],
                |row| row.get(0),
            )
            .optional()?;
        let project_id =
            project_id.ok_or_else(|| AppError::Validation(format!("功能不存在: {feature_id}")))?;
        let changed = conn.execute(
            "UPDATE feature_agent_links SET status = 'unlinked', last_event_at = ?4
             WHERE feature_id = ?1 AND agent_source = ?2 AND session_id = ?3 AND status = 'linked'",
            rusqlite::params![feature_id, agent_source, session_id, now_iso()],
        )?;
        if changed == 0 {
            return Err(AppError::Validation("未找到有效的 Agent 关联".into()));
        }
        Ok(project_id)
    })
}

#[tauri::command]
pub fn planning_unlink_agent_session(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    feature_id: String,
    agent_source: String,
    session_id: String,
) -> AppResult<()> {
    let project_id = unlink_agent_session_impl(&db, &feature_id, &agent_source, &session_id)?;
    let changed = crate::mcp::PlanningChanged {
        kind: "feature",
        project_id: Some(project_id),
        feature_id: Some(feature_id),
        revision: None,
    };
    let _ = tauri::Emitter::emit(&app, crate::mcp::PLANNING_CHANGED_EVENT, &changed);
    Ok(())
}

pub(crate) fn create_feature_tx(
    conn: &Connection,
    project_id: String,
    input: FeatureInput,
) -> AppResult<PlanningFeature> {
    let title = check_name(&input.title, "功能", 200)?;
    let description = check_text(&input.description, "功能描述", 2000)?;
    let acceptance_criteria = check_text(&input.acceptance_criteria, "验收标准", 4000)?;
    let status = input.status.as_deref().unwrap_or("planned");
    check_status(status, FEATURE_STATUSES, "功能")?;
    let priority = input.priority.as_deref().unwrap_or("P1");
    check_status(priority, FEATURE_PRIORITIES, "功能优先级")?;
    let target_date = normalize_date(&input.target_date)?;
    let now = now_iso();
    let id = new_id();
    if !project_exists(conn, &project_id)? {
        return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
    }
    if let Some(mid) = &input.milestone_id {
        check_milestone_in_project(conn, mid, &project_id)?;
    }
    let sort_order = next_sort_order(conn, "planning_features", Some(("project_id", &project_id)))?;
    conn.execute(
        "INSERT INTO planning_features (id, project_id, title, description, acceptance_criteria, status, priority, milestone_id, target_date, sort_order, created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)",
        rusqlite::params![
            id,
            project_id,
            title,
            description,
            acceptance_criteria,
            status,
            priority,
            input.milestone_id,
            target_date,
            sort_order,
            now,
            if status == "completed" { Some(&now) } else { None }
        ],
    )
    .map_err(AppError::from)?;
    record_status_change_tx(conn, &project_id, &id, "", status, "创建功能")?;
    load_feature_tx(conn, &id)
}

pub(crate) fn create_feature_impl(
    db: &Db,
    project_id: String,
    input: FeatureInput,
) -> AppResult<PlanningFeature> {
    db.with_transaction(|conn| create_feature_tx(conn, project_id, input))
}

#[tauri::command]
pub fn planning_create_feature(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: FeatureInput,
) -> AppResult<PlanningFeature> {
    create_feature_impl(&db, project_id, input)
}

/// 校验里程碑归属（存在且属于同一项目），用于功能创建/更新。
fn check_milestone_in_project(
    conn: &Connection,
    milestone_id: &str,
    project_id: &str,
) -> AppResult<()> {
    let belongs: Option<String> = conn
        .query_row(
            "SELECT project_id FROM planning_milestones WHERE id = ?1",
            rusqlite::params![milestone_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)?;
    if belongs.as_deref() != Some(project_id) {
        return Err(AppError::Validation(format!(
            "里程碑不属于该项目: {}",
            milestone_id
        )));
    }
    Ok(())
}

/// 更新功能。状态变化在同一事务写入 status_change 历史；
/// 标记 completed 时记录 completed_at，离开 completed 时清除；
/// 带未完成步骤直接标记完成是允许的（前端需先确认），历史里如实记录未完成数。
pub(crate) fn update_feature_tx(
    conn: &Connection,
    id: String,
    patch: FeaturePatch,
) -> AppResult<PlanningFeature> {
    let title = match &patch.title {
        Some(t) => Some(check_name(t, "功能", 200)?),
        None => None,
    };
    let description = match &patch.description {
        Some(d) => Some(check_text(d, "功能描述", 2000)?),
        None => None,
    };
    let acceptance_criteria = match &patch.acceptance_criteria {
        Some(a) => Some(check_text(a, "验收标准", 4000)?),
        None => None,
    };
    if let Some(s) = &patch.status {
        check_status(s, FEATURE_STATUSES, "功能")?;
    }
    if let Some(p) = &patch.priority {
        check_status(p, FEATURE_PRIORITIES, "功能优先级")?;
    }
    let now = now_iso();
    let current: (String, String, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT project_id, status, milestone_id, completed_at, target_date FROM planning_features WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("功能不存在: {}", id)))?;
    let (project_id, old_status, cur_milestone, cur_completed_at, cur_target_date) = current;
    check_expected_revision_tx(conn, "planning_features", &id, patch.expected_revision)?;

    // 里程碑三态：缺省保持 / null 清除 / 值校验归属后替换
    let milestone_id = match &patch.milestone_id {
        None => cur_milestone,
        Some(None) => None,
        Some(Some(mid)) => {
            check_milestone_in_project(conn, mid, &project_id)?;
            Some(mid.clone())
        }
    };
    let target_date = resolve_date(&cur_target_date, &parse_date_update(&patch.target_date)?);

    // completed_at：状态变化进入 completed 记时间，离开清除；未涉及状态时保持原值
    let status_changed = patch.status.is_some();
    let new_status = patch.status.clone().unwrap_or_else(|| old_status.clone());
    let completed_at = if status_changed {
        if new_status == "completed" {
            Some(now.clone())
        } else {
            None
        }
    } else {
        cur_completed_at
    };

    conn.execute(
        "UPDATE planning_features SET
           title = COALESCE(?1, title),
           description = COALESCE(?2, description),
           acceptance_criteria = COALESCE(?3, acceptance_criteria),
           status = ?4,
           priority = COALESCE(?5, priority),
           milestone_id = ?6,
           target_date = ?7,
           sort_order = COALESCE(?8, sort_order),
           completed_at = ?9,
           revision = revision + 1,
           updated_at = ?10
         WHERE id = ?11",
        rusqlite::params![
            title,
            description,
            acceptance_criteria,
            new_status,
            patch.priority,
            milestone_id,
            target_date,
            patch.sort_order,
            completed_at,
            now,
            id
        ],
    )
    .map_err(AppError::from)?;

    if status_changed && new_status != old_status {
        let mut message = String::new();
        if new_status == "completed" {
            let undone: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM planning_feature_steps WHERE feature_id = ?1 AND done = 0",
                    rusqlite::params![id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            if undone > 0 {
                message = format!("确认完成：仍有 {} 个未完成步骤", undone);
            }
        }
        record_status_change_tx(conn, &project_id, &id, &old_status, &new_status, &message)?;
    }
    load_feature_tx(conn, &id)
}

pub(crate) fn update_feature_impl(
    db: &Db,
    id: String,
    patch: FeaturePatch,
) -> AppResult<PlanningFeature> {
    db.with_transaction(|conn| update_feature_tx(conn, id, patch))
}

#[tauri::command]
pub fn planning_update_feature(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: FeaturePatch,
) -> AppResult<PlanningFeature> {
    update_feature_impl(&db, id, patch)
}

/// 删除功能：级联删除其步骤与进度历史（不留悬挂引用）。
pub(crate) fn delete_feature_impl(db: &Db, id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let n = tx
            .execute(
                "DELETE FROM planning_features WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(AppError::from)?;
        if n == 0 {
            return Err(AppError::Validation(format!("功能不存在: {}", id)));
        }
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

#[tauri::command]
pub fn planning_delete_feature(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    delete_feature_impl(&db, id)
}

/// 功能排序：按传入 id 顺序写入 sort_order（限定同一项目内）。
pub(crate) fn reorder_features_impl(
    db: &Db,
    project_id: String,
    ids: Vec<String>,
) -> AppResult<()> {
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if !project_exists(&tx, &project_id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
        }
        for (i, id) in ids.iter().enumerate() {
            let n = tx
                .execute(
                    "UPDATE planning_features SET sort_order = ?1, updated_at = ?3
                     WHERE id = ?2 AND project_id = ?4",
                    rusqlite::params![i as i64, id, now, project_id],
                )
                .map_err(AppError::from)?;
            if n == 0 {
                return Err(AppError::Validation(format!(
                    "功能不存在或不属于该项目: {}",
                    id
                )));
            }
        }
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

#[tauri::command]
pub fn planning_reorder_features(
    db: State<'_, Arc<Db>>,
    project_id: String,
    ids: Vec<String>,
) -> AppResult<()> {
    reorder_features_impl(&db, project_id, ids)
}

// ── 步骤命令 ─────────────────────────────────────────────────────────

/// 新增步骤。返回更新后的功能（含步骤与进度），前端就地替换。
/// expected_revision（v37）：传入时校验功能 revision（MCP 写工具强制）。
pub(crate) fn add_step_tx(
    conn: &Connection,
    feature_id: String,
    title: String,
    expected_revision: Option<i64>,
) -> AppResult<PlanningFeature> {
    let title = check_name(&title, "步骤", 200)?;
    let now = now_iso();
    let id = new_id();
    // 确认功能存在（顺带取 project_id 备用）
    let _project_id: String = conn
        .query_row(
            "SELECT project_id FROM planning_features WHERE id = ?1",
            rusqlite::params![feature_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("功能不存在: {}", feature_id)))?;
    check_expected_revision_tx(conn, "planning_features", &feature_id, expected_revision)?;
    let sort_order = next_sort_order(
        conn,
        "planning_feature_steps",
        Some(("feature_id", &feature_id)),
    )?;
    conn.execute(
        "INSERT INTO planning_feature_steps (id, feature_id, title, done, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)",
        rusqlite::params![id, feature_id, title, sort_order, now],
    )
    .map_err(AppError::from)?;
    conn.execute(
        "UPDATE planning_features SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, feature_id],
    )
    .map_err(AppError::from)?;
    load_feature_tx(conn, &feature_id)
}

pub(crate) fn add_step_impl(
    db: &Db,
    feature_id: String,
    title: String,
    expected_revision: Option<i64>,
) -> AppResult<PlanningFeature> {
    db.with_transaction(|conn| add_step_tx(conn, feature_id, title, expected_revision))
}

#[tauri::command]
pub fn planning_add_step(
    db: State<'_, Arc<Db>>,
    feature_id: String,
    title: String,
    expected_revision: Option<i64>,
) -> AppResult<PlanningFeature> {
    add_step_impl(&db, feature_id, title, expected_revision)
}

/// 更新步骤（改标题 / 勾选完成 / 重开）。
/// 勾选与重开在同一事务写入 step_done 历史并同步功能 updated_at。
pub(crate) fn update_step_tx(
    conn: &Connection,
    id: String,
    patch: StepPatch,
) -> AppResult<PlanningFeature> {
    let title = match &patch.title {
        Some(t) => Some(check_name(t, "步骤", 200)?),
        None => None,
    };
    let now = now_iso();
    let current: (String, String, i64, Option<String>) = conn
        .query_row(
            "SELECT s.feature_id, s.title, s.done, s.completed_at FROM planning_feature_steps s WHERE s.id = ?1",
            rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("步骤不存在: {}", id)))?;
    let (feature_id, old_title, old_done, cur_completed_at) = current;
    let project_id: String = conn
        .query_row(
            "SELECT project_id FROM planning_features WHERE id = ?1",
            rusqlite::params![feature_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    check_expected_revision_tx(
        conn,
        "planning_features",
        &feature_id,
        patch.expected_revision,
    )?;

    let new_title = title.clone().unwrap_or_else(|| old_title.clone());
    let done_touched = patch.done.is_some();
    let new_done = patch.done.unwrap_or(old_done != 0);
    let completed_at = if done_touched {
        if new_done {
            Some(now.clone())
        } else {
            None
        }
    } else {
        cur_completed_at
    };

    conn.execute(
        "UPDATE planning_feature_steps SET title = COALESCE(?1, title), done = ?2, completed_at = ?3, updated_at = ?4
         WHERE id = ?5",
        rusqlite::params![title, new_done as i64, completed_at, now, id],
    )
    .map_err(AppError::from)?;

    // 勾选状态实际变化才记录事件，避免重复点击刷历史
    if done_touched && new_done != (old_done != 0) {
        let message = if new_done {
            format!("完成步骤「{}」", new_title)
        } else {
            format!("重开步骤「{}」", new_title)
        };
        record_step_event_tx(conn, &project_id, &feature_id, &message)?;
    }
    // 步骤变化同步功能 revision 与 updated_at（卡片「最近更新」以此为准）
    conn.execute(
        "UPDATE planning_features SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, feature_id],
    )
    .map_err(AppError::from)?;
    load_feature_tx(conn, &feature_id)
}

pub(crate) fn update_step_impl(
    db: &Db,
    id: String,
    patch: StepPatch,
) -> AppResult<PlanningFeature> {
    db.with_transaction(|conn| update_step_tx(conn, id, patch))
}

#[tauri::command]
pub fn planning_update_step(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: StepPatch,
) -> AppResult<PlanningFeature> {
    update_step_impl(&db, id, patch)
}

pub(crate) fn delete_step_impl(db: &Db, id: String) -> AppResult<PlanningFeature> {
    let now = now_iso();
    let feature_id = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let feature_id: String = tx
            .query_row(
                "SELECT feature_id FROM planning_feature_steps WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::Validation(format!("步骤不存在: {}", id)))?;
        tx.execute(
            "DELETE FROM planning_feature_steps WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(AppError::from)?;
        tx.execute(
            "UPDATE planning_features SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, feature_id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(feature_id)
    })?;
    db.with_read(|conn| load_feature_tx(conn, &feature_id))
}

#[tauri::command]
pub fn planning_delete_step(db: State<'_, Arc<Db>>, id: String) -> AppResult<PlanningFeature> {
    delete_step_impl(&db, id)
}

/// 步骤排序：按传入 id 顺序写入 sort_order（限定同一功能下）。
pub(crate) fn reorder_steps_impl(
    db: &Db,
    feature_id: String,
    ids: Vec<String>,
) -> AppResult<PlanningFeature> {
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            let n = tx
                .execute(
                    "UPDATE planning_feature_steps SET sort_order = ?1, updated_at = ?3
                     WHERE id = ?2 AND feature_id = ?4",
                    rusqlite::params![i as i64, id, now, feature_id],
                )
                .map_err(AppError::from)?;
            if n == 0 {
                return Err(AppError::Validation(format!(
                    "步骤不存在或不属于该功能: {}",
                    id
                )));
            }
        }
        tx.execute(
            "UPDATE planning_features SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, feature_id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    db.with_read(|conn| load_feature_tx(conn, &feature_id))
}

#[tauri::command]
pub fn planning_reorder_steps(
    db: State<'_, Arc<Db>>,
    feature_id: String,
    ids: Vec<String>,
) -> AppResult<PlanningFeature> {
    reorder_steps_impl(&db, feature_id, ids)
}

// ── 里程碑命令 ───────────────────────────────────────────────────────

pub(crate) fn list_milestones_impl(
    db: &Db,
    project_id: String,
) -> AppResult<Vec<PlanningMilestone>> {
    db.with_read(|conn| {
        if !project_exists(conn, &project_id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
        }
        let sql = format!(
            "{} WHERE ms.project_id = ?1 ORDER BY ms.sort_order, ms.created_at",
            MILESTONE_SELECT
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![project_id], row_to_milestone)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn planning_list_milestones(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<Vec<PlanningMilestone>> {
    list_milestones_impl(&db, project_id)
}

pub(crate) fn create_milestone_impl(
    db: &Db,
    project_id: String,
    input: MilestoneInput,
) -> AppResult<PlanningMilestone> {
    let name = check_name(&input.name, "里程碑", 100)?;
    let description = check_text(&input.description, "里程碑描述", 2000)?;
    let target_date = normalize_date(&input.target_date)?;
    let now = now_iso();
    let id = new_id();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if !project_exists(&tx, &project_id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
        }
        let sort_order =
            next_sort_order(&tx, "planning_milestones", Some(("project_id", &project_id)))?;
        tx.execute(
            "INSERT INTO planning_milestones (id, project_id, name, description, target_date, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            rusqlite::params![id, project_id, name, description, target_date, sort_order, now],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    db.with_read(|conn| load_milestone_tx(conn, &id))
}

#[tauri::command]
pub fn planning_create_milestone(
    db: State<'_, Arc<Db>>,
    project_id: String,
    input: MilestoneInput,
) -> AppResult<PlanningMilestone> {
    create_milestone_impl(&db, project_id, input)
}

pub(crate) fn update_milestone_impl(
    db: &Db,
    id: String,
    patch: MilestonePatch,
) -> AppResult<PlanningMilestone> {
    let name = match &patch.name {
        Some(n) => Some(check_name(n, "里程碑", 100)?),
        None => None,
    };
    let description = match &patch.description {
        Some(d) => Some(check_text(d, "里程碑描述", 2000)?),
        None => None,
    };
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let current: (Option<String>,) = tx
            .query_row(
                "SELECT target_date FROM planning_milestones WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?,)),
            )
            .optional()
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::Validation(format!("里程碑不存在: {}", id)))?;
        let target_date = resolve_date(&current.0, &parse_date_update(&patch.target_date)?);
        tx.execute(
            "UPDATE planning_milestones SET
               name = COALESCE(?1, name),
               description = COALESCE(?2, description),
               target_date = ?3,
               sort_order = COALESCE(?4, sort_order),
               updated_at = ?5
             WHERE id = ?6",
            rusqlite::params![name, description, target_date, patch.sort_order, now, id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    db.with_read(|conn| load_milestone_tx(conn, &id))
}

#[tauri::command]
pub fn planning_update_milestone(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: MilestonePatch,
) -> AppResult<PlanningMilestone> {
    update_milestone_impl(&db, id, patch)
}

/// 删除里程碑：关联功能的 milestone_id 由 FK ON DELETE SET NULL 自动置空。
pub(crate) fn delete_milestone_impl(db: &Db, id: String) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let n = tx
            .execute(
                "DELETE FROM planning_milestones WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(AppError::from)?;
        if n == 0 {
            return Err(AppError::Validation(format!("里程碑不存在: {}", id)));
        }
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

#[tauri::command]
pub fn planning_delete_milestone(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    delete_milestone_impl(&db, id)
}

// ── 进度历史命令 ─────────────────────────────────────────────────────

/// 历史分页（时间倒序）。feature_id 省略时返回整个项目的历史。
/// 每页固定上限，项目长期使用不会一次性加载全部记录。
pub(crate) fn activity_page_impl(
    db: &Db,
    project_id: String,
    feature_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<ActivityPage> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let offset = offset.unwrap_or(0).max(0);
    db.with_read(|conn| {
        if !project_exists(conn, &project_id)? {
            return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
        }
        let sql = format!(
            "SELECT a.id, a.project_id, a.feature_id, f.title, a.kind, a.old_status, a.new_status, a.message, a.created_at
             FROM planning_activity a
             LEFT JOIN planning_features f ON f.id = a.feature_id
             WHERE a.project_id = ?1 {}
             ORDER BY a.created_at DESC, a.rowid DESC
             LIMIT ?2 OFFSET ?3",
            if feature_id.is_some() { "AND a.feature_id = ?4" } else { "" }
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = if let Some(fid) = &feature_id {
            stmt.query_map(
                rusqlite::params![project_id, limit + 1, offset, fid],
                row_to_activity,
            )?
        } else {
            stmt.query_map(rusqlite::params![project_id, limit + 1, offset], row_to_activity)?
        };
        let mut items = Vec::new();
        while let Some(r) = rows.next() {
            items.push(r.map_err(AppError::from)?);
        }
        let has_more = items.len() as i64 > limit;
        if has_more {
            items.truncate(limit as usize);
        }
        Ok(ActivityPage { items, has_more })
    })
}

#[tauri::command]
pub fn planning_activity_page(
    db: State<'_, Arc<Db>>,
    project_id: String,
    feature_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<ActivityPage> {
    activity_page_impl(&db, project_id, feature_id, limit, offset)
}

fn row_to_activity(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanningActivity> {
    Ok(PlanningActivity {
        id: row.get(0)?,
        project_id: row.get(1)?,
        feature_id: row.get(2)?,
        feature_title: row.get(3)?,
        kind: row.get(4)?,
        old_status: row.get(5)?,
        new_status: row.get(6)?,
        message: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// 用户主动提交的开发日志（kind = note）。不解析内容、不推断进度。
pub(crate) fn add_note_tx(
    conn: &Connection,
    project_id: String,
    feature_id: Option<String>,
    message: String,
) -> AppResult<PlanningActivity> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(AppError::Validation("记录内容不能为空".into()));
    }
    let message = check_text(&message, "记录内容", 2000)?;
    let now = now_iso();
    let id = new_id();
    if !project_exists(conn, &project_id)? {
        return Err(AppError::Validation(format!("项目不存在: {}", project_id)));
    }
    if let Some(fid) = &feature_id {
        let belongs: Option<String> = conn
            .query_row(
                "SELECT project_id FROM planning_features WHERE id = ?1",
                rusqlite::params![fid],
                |r| r.get(0),
            )
            .optional()
            .map_err(AppError::from)?;
        if belongs.as_deref() != Some(project_id.as_str()) {
            return Err(AppError::Validation(format!("功能不属于该项目: {}", fid)));
        }
    }
    conn.execute(
        "INSERT INTO planning_activity (id, project_id, feature_id, kind, message, created_at)
         VALUES (?1, ?2, ?3, 'note', ?4, ?5)",
        rusqlite::params![id, project_id, feature_id, message, now],
    )
    .map_err(AppError::from)?;
    conn.query_row(
        "SELECT a.id, a.project_id, a.feature_id, f.title, a.kind, a.old_status, a.new_status, a.message, a.created_at
         FROM planning_activity a
         LEFT JOIN planning_features f ON f.id = a.feature_id
         WHERE a.id = ?1",
        rusqlite::params![id],
        row_to_activity,
    )
    .map_err(AppError::from)
}

pub(crate) fn add_note_impl(
    db: &Db,
    project_id: String,
    feature_id: Option<String>,
    message: String,
) -> AppResult<PlanningActivity> {
    db.with_transaction(|conn| add_note_tx(conn, project_id, feature_id, message))
}

/// 提交待验收：只接受当前开发中的功能，更新状态与可选日志写入共用调用方事务。
pub(crate) fn submit_for_review_tx(
    conn: &Connection,
    feature_id: String,
    expected_revision: Option<i64>,
    note: Option<String>,
) -> AppResult<PlanningFeature> {
    let expected_revision = expected_revision
        .ok_or_else(|| AppError::Validation("提交待验收必须提供 expected_revision".into()))?;
    let (project_id, status): (String, String) = conn
        .query_row(
            "SELECT project_id, status FROM planning_features WHERE id = ?1",
            rusqlite::params![feature_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Validation(format!("功能不存在: {}", feature_id)))?;
    if status != "in_progress" {
        return Err(AppError::Conflict(format!(
            "只有开发中的功能可以提交待验收（当前状态：{}）",
            status
        )));
    }
    let note = note
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = &note {
        check_text(value, "验收说明", 2000)?;
    }

    let result = update_feature_tx(
        conn,
        feature_id.clone(),
        FeaturePatch {
            title: None,
            description: None,
            acceptance_criteria: None,
            status: Some("review".into()),
            priority: None,
            milestone_id: None,
            target_date: None,
            sort_order: None,
            expected_revision: Some(expected_revision),
        },
    )?;
    if let Some(note) = note {
        add_note_tx(conn, project_id, Some(feature_id), note)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn planning_add_note(
    db: State<'_, Arc<Db>>,
    project_id: String,
    feature_id: Option<String>,
    message: String,
) -> AppResult<PlanningActivity> {
    add_note_impl(&db, project_id, feature_id, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn proj_input(name: &str) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            description: String::new(),
            status: None,
            target_date: None,
        }
    }

    fn feat_input(title: &str) -> FeatureInput {
        FeatureInput {
            title: title.into(),
            description: String::new(),
            acceptance_criteria: String::new(),
            status: None,
            priority: None,
            milestone_id: None,
            target_date: None,
        }
    }

    fn count(db: &Db, sql: &str) -> i64 {
        db.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
            .unwrap()
    }

    #[test]
    fn project_crud_archive_and_delete_cascades() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("示例项目")).unwrap();
        assert_eq!(p.status, "planning");
        assert!(!p.archived);
        assert!(!p.stats.has_features, "空项目不得宣称 0% 进度");
        assert_eq!(p.stats.progress_percent, 0);

        let f = create_feature_impl(&db, p.id.clone(), feat_input("功能A")).unwrap();
        let s = add_step_impl(&db, f.id.clone(), "步骤1".into(), None).unwrap();
        add_note_impl(&db, p.id.clone(), Some(f.id.clone()), "开始开发".into()).unwrap();

        // 归档 → 列表默认仍返回（前端分组展示），排除归档时不返回
        let archived = archive_project_impl(&db, p.id.clone(), true).unwrap();
        assert!(archived.archived);
        assert!(list_projects_impl(&db, Some(false)).unwrap().is_empty());
        assert_eq!(list_projects_impl(&db, Some(true)).unwrap().len(), 1);
        archive_project_impl(&db, p.id.clone(), false).unwrap();

        // 更新项目字段
        let updated = update_project_impl(
            &db,
            p.id.clone(),
            ProjectPatch {
                name: Some("改名".into()),
                description: Some("描述".into()),
                status: Some("in_progress".into()),
                target_date: Some(Some("2026-12-01".into())),
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(updated.name, "改名");
        assert_eq!(updated.status, "in_progress");
        assert_eq!(updated.target_date.as_deref(), Some("2026-12-01"));

        // 删除项目级联清除功能 / 步骤 / 历史
        delete_project_impl(&db, p.id.clone()).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_features"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_feature_steps"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_activity"), 0);
        let _ = s;
    }

    #[test]
    fn feature_status_changes_write_activity_and_completed_at() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        let f = create_feature_impl(&db, p.id.clone(), feat_input("功能")).unwrap();
        // 创建即写入 status_change 历史
        let kinds: Vec<String> = db
            .with_conn(|c| {
                let mut st = c.prepare("SELECT kind FROM planning_activity ORDER BY rowid")?;
                let rows = st.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(kinds, vec!["status_change"]);

        let done = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: Some("completed".into()),
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert!(
            done.completed_at.is_some(),
            "进入 completed 应记 completed_at"
        );
        let back = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: Some("review".into()),
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert!(
            back.completed_at.is_none(),
            "离开 completed 应清除 completed_at"
        );

        // 三次状态事件：创建 + 完成 + 离开
        let n: i64 = count(
            &db,
            "SELECT COUNT(*) FROM planning_activity WHERE kind = 'status_change'",
        );
        assert_eq!(n, 3);

        // 状态非法值被拒绝
        let err = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: Some("done".into()),
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn acceptance_criteria_roundtrip_and_status_stats() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();

        // 验收标准与步骤相互独立：创建/更新都能持久化，空串代表未填写
        let mut input = feat_input("登录系统");
        input.acceptance_criteria = "登录成功后 3 秒内进入工作台".into();
        let f = create_feature_impl(&db, p.id.clone(), input).unwrap();
        assert_eq!(f.acceptance_criteria, "登录成功后 3 秒内进入工作台");
        assert_eq!(f.step_total, 0, "验收标准不会生成开发步骤");

        let updated = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: Some("错误密码连续 5 次触发限流".into()),
                status: None,
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(updated.acceptance_criteria, "错误密码连续 5 次触发限流");

        // 项目统计补充 planned / review / paused 三类计数
        for (title, status) in [
            ("待开发", "planned"),
            ("待验收", "review"),
            ("已暂停", "paused"),
            ("已完成", "completed"),
        ] {
            let mut next = feat_input(title);
            next.status = Some(status.into());
            create_feature_impl(&db, p.id.clone(), next).unwrap();
        }
        let listed = list_projects_impl(&db, None).unwrap();
        let stats = &listed[0].stats;
        assert_eq!(stats.feature_total, 5);
        assert_eq!(stats.feature_planned, 2);
        assert_eq!(stats.feature_review, 1);
        assert_eq!(stats.feature_paused, 1);
        assert_eq!(stats.feature_completed, 1);
        assert_eq!(stats.progress_percent, 20);
    }

    #[test]
    fn step_progress_and_stats() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        let f = create_feature_impl(&db, p.id.clone(), feat_input("登录系统")).unwrap();
        let s1 = add_step_impl(&db, f.id.clone(), "设计数据库".into(), None).unwrap();
        let s2 = add_step_impl(&db, f.id.clone(), "实现接口".into(), None).unwrap();
        add_step_impl(&db, f.id.clone(), "实现界面".into(), None).unwrap();

        update_step_impl(
            &db,
            s1.steps[0].id.clone(),
            StepPatch {
                title: None,
                done: Some(true),
                expected_revision: None,
            },
        )
        .unwrap();
        let f = update_step_impl(
            &db,
            s2.steps[1].id.clone(),
            StepPatch {
                title: None,
                done: Some(true),
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!((f.step_done, f.step_total), (2, 3), "2/3 步骤完成");

        // 完成事件在历史里
        let step_events: i64 = count(
            &db,
            "SELECT COUNT(*) FROM planning_activity WHERE kind = 'step_done'",
        );
        assert_eq!(step_events, 2);

        // 功能未完成 → 项目进度按功能算，不按步骤加权
        let listed = list_projects_impl(&db, None).unwrap();
        assert_eq!(listed[0].stats.feature_total, 1);
        assert_eq!(listed[0].stats.feature_completed, 0);
        assert_eq!(listed[0].stats.progress_percent, 0);
        assert!(listed[0].stats.has_features);

        // 功能标记完成（仍有未完成步骤）：允许，但历史如实记录
        let done = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: Some("completed".into()),
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(done.step_done, 2, "标记完成绝不静默改步骤");
        let msg: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT message FROM planning_activity WHERE kind='status_change' AND new_status='completed' ORDER BY rowid DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(
            msg.contains("1 个未完成步骤"),
            "历史应记录未完成数：{}",
            msg
        );
        let listed = list_projects_impl(&db, None).unwrap();
        assert_eq!(listed[0].stats.progress_percent, 100);

        // 重开步骤：记一次事件；重复同值不再记
        update_step_impl(
            &db,
            s1.steps[0].id.clone(),
            StepPatch {
                title: None,
                done: Some(false),
                expected_revision: None,
            },
        )
        .unwrap();
        update_step_impl(
            &db,
            s1.steps[0].id.clone(),
            StepPatch {
                title: None,
                done: Some(false),
                expected_revision: None,
            },
        )
        .unwrap();
        let step_events: i64 = count(
            &db,
            "SELECT COUNT(*) FROM planning_activity WHERE kind = 'step_done'",
        );
        assert_eq!(step_events, 3, "重开记一次，重复同值不记");
    }

    #[test]
    fn milestone_flow_and_cross_project_guard() {
        let db = memdb();
        let p1 = create_project_impl(&db, proj_input("P1")).unwrap();
        let p2 = create_project_impl(&db, proj_input("P2")).unwrap();
        let m = create_milestone_impl(
            &db,
            p1.id.clone(),
            MilestoneInput {
                name: "v0.1".into(),
                description: "首个可用版本".into(),
                target_date: None,
            },
        )
        .unwrap();
        let f = create_feature_impl(
            &db,
            p1.id.clone(),
            FeatureInput {
                title: "功能".into(),
                description: String::new(),
                acceptance_criteria: String::new(),
                status: None,
                priority: None,
                milestone_id: Some(m.id.clone()),
                target_date: None,
            },
        )
        .unwrap();
        assert_eq!(f.milestone_name.as_deref(), Some("v0.1"));

        // 里程碑统计
        let ms = list_milestones_impl(&db, p1.id.clone()).unwrap();
        assert_eq!((ms[0].feature_total, ms[0].feature_completed), (1, 0));

        // 跨项目里程碑被拒绝
        let err = create_feature_impl(
            &db,
            p2.id.clone(),
            FeatureInput {
                title: "功能".into(),
                description: String::new(),
                acceptance_criteria: String::new(),
                status: None,
                priority: None,
                milestone_id: Some(m.id.clone()),
                target_date: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // 删除里程碑 → 功能关联置空，功能不丢
        delete_milestone_impl(&db, m.id.clone()).unwrap();
        let fs = list_features_impl(&db, p1.id.clone()).unwrap();
        assert_eq!(fs.len(), 1);
        assert!(fs[0].milestone_id.is_none());
    }

    #[test]
    fn activity_pagination_is_time_desc_with_has_more() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        for i in 0..5 {
            add_note_impl(&db, p.id.clone(), None, format!("日志{}", i)).unwrap();
        }
        let page1 = activity_page_impl(&db, p.id.clone(), None, Some(2), Some(0)).unwrap();
        assert_eq!(page1.items.len(), 2);
        assert!(page1.has_more);
        let page3 = activity_page_impl(&db, p.id.clone(), None, Some(2), Some(4)).unwrap();
        assert_eq!(page3.items.len(), 1);
        assert!(!page3.has_more);
        // 时间倒序：第一页第一条是最新写入的
        assert_eq!(page1.items[0].message, "日志4");
        // 按功能过滤
        let f = create_feature_impl(&db, p.id.clone(), feat_input("F")).unwrap();
        add_note_impl(&db, p.id.clone(), Some(f.id.clone()), "功能日志".into()).unwrap();
        let filtered =
            activity_page_impl(&db, p.id.clone(), Some(f.id.clone()), None, None).unwrap();
        // 创建功能的 status_change + 功能日志
        assert_eq!(filtered.items.len(), 2);
        assert_eq!(filtered.items[0].kind, "note");
        assert_eq!(filtered.items[0].feature_title.as_deref(), Some("F"));
    }

    #[test]
    fn validation_rejects_bad_input() {
        let db = memdb();
        // 空名称
        assert!(create_project_impl(&db, proj_input("  ")).is_err());
        // 非法日期
        let err = create_project_impl(
            &db,
            ProjectInput {
                name: "P".into(),
                description: String::new(),
                status: None,
                target_date: Some("2026/12/01".into()),
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        // 空日志
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        assert!(add_note_impl(&db, p.id.clone(), None, "   ".into()).is_err());
        // 空步骤标题
        let f = create_feature_impl(&db, p.id.clone(), feat_input("F")).unwrap();
        assert!(add_step_impl(&db, f.id.clone(), "".into(), None).is_err());
        // 不存在的功能
        assert!(add_step_impl(&db, "nope".into(), "x".into(), None).is_err());
    }

    #[test]
    fn target_date_tri_state_semantics() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        let f = create_feature_impl(&db, p.id.clone(), feat_input("F")).unwrap();
        // 设置
        let f = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: None,
                priority: None,
                milestone_id: None,
                target_date: Some(Some("2026-11-20".into())),
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(f.target_date.as_deref(), Some("2026-11-20"));
        // 未提及 → 保持；只改标题不影响日期
        let f = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: Some("改名".into()),
                description: None,
                acceptance_criteria: None,
                status: None,
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(f.target_date.as_deref(), Some("2026-11-20"));
        assert_eq!(f.title, "改名");
        // null → 清除
        let f = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: None,
                priority: None,
                milestone_id: None,
                target_date: Some(None),
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert!(f.target_date.is_none());
    }

    #[test]
    fn expected_revision_guards_against_lost_updates() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        let f = create_feature_impl(&db, p.id.clone(), feat_input("F")).unwrap();
        assert_eq!(p.revision, 1, "新建实体 revision 从 1 起步");
        assert_eq!(f.revision, 1);

        // 期望匹配 → 成功且 revision +1
        let updated = update_project_impl(
            &db,
            p.id.clone(),
            ProjectPatch {
                name: Some("改名".into()),
                description: None,
                status: None,
                target_date: None,
                sort_order: None,
                expected_revision: Some(1),
            },
        )
        .unwrap();
        assert_eq!(updated.revision, 2);

        // 过期期望 → Conflict（带当前 revision），内容不被覆盖
        let err = update_project_impl(
            &db,
            p.id.clone(),
            ProjectPatch {
                name: Some("迟到写入".into()),
                description: None,
                status: None,
                target_date: None,
                sort_order: None,
                expected_revision: Some(1),
            },
        )
        .unwrap_err();
        match err {
            AppError::Conflict(msg) => {
                assert!(msg.contains("当前 2"), "冲突消息应带当前 revision: {msg}");
            }
            other => panic!("应返回 Conflict，实际: {other:?}"),
        }
        let current_name = db.with_read(|c| load_project_tx(c, &p.id)).unwrap().name;
        assert_eq!(current_name, "改名", "迟到的旧版本写入不得生效");

        // 不传 expected_revision → 保持旧行为（UI 兼容），revision 仍然 +1
        let updated = update_project_impl(
            &db,
            p.id.clone(),
            ProjectPatch {
                name: Some("再改".into()),
                description: None,
                status: None,
                target_date: None,
                sort_order: None,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(updated.revision, 3);

        // 功能更新同样受 revision 保护
        let f2 = update_feature_impl(
            &db,
            f.id.clone(),
            FeaturePatch {
                title: Some("F2".into()),
                description: None,
                acceptance_criteria: None,
                status: None,
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: Some(1),
            },
        )
        .unwrap();
        assert_eq!(f2.revision, 2);
        assert!(matches!(
            update_feature_impl(
                &db,
                f.id.clone(),
                FeaturePatch {
                    title: Some("过期".into()),
                    description: None,
                    acceptance_criteria: None,
                    status: None,
                    priority: None,
                    milestone_id: None,
                    target_date: None,
                    sort_order: None,
                    expected_revision: Some(1),
                },
            )
            .unwrap_err(),
            AppError::Conflict(_)
        ));

        // 步骤新增/更新走功能 revision：新增成功后 revision +1，旧期望冲突
        let s = add_step_impl(&db, f.id.clone(), "步骤".into(), Some(2)).unwrap();
        assert_eq!(s.revision, 3);
        let step_id = s.steps[0].id.clone();
        assert!(matches!(
            add_step_impl(&db, f.id.clone(), "过期步骤".into(), Some(2)).unwrap_err(),
            AppError::Conflict(_)
        ));
        let s2 = update_step_impl(
            &db,
            step_id.clone(),
            StepPatch {
                title: None,
                done: Some(true),
                expected_revision: Some(3),
            },
        )
        .unwrap();
        assert_eq!(s2.revision, 4);
        assert!(matches!(
            update_step_impl(
                &db,
                step_id,
                StepPatch {
                    title: None,
                    done: Some(false),
                    expected_revision: Some(3)
                },
            )
            .unwrap_err(),
            AppError::Conflict(_)
        ));

        // 不存在的对象按 Validation 报错（非 Conflict）
        assert!(matches!(
            update_project_impl(
                &db,
                "ghost".into(),
                ProjectPatch {
                    name: Some("x".into()),
                    description: None,
                    status: None,
                    target_date: None,
                    sort_order: None,
                    expected_revision: Some(1),
                },
            )
            .unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn submit_for_review_updates_feature_and_note_together() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        let project_id = p.id.clone();
        let mut input = feat_input("F");
        input.status = Some("in_progress".into());
        let f = create_feature_impl(&db, project_id.clone(), input).unwrap();

        let submitted = db
            .with_transaction(|conn| {
                submit_for_review_tx(
                    conn,
                    f.id.clone(),
                    Some(f.revision),
                    Some("请验收边界行为".into()),
                )
            })
            .unwrap();
        assert_eq!(submitted.status, "review");
        assert_eq!(submitted.revision, f.revision + 1);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM planning_activity WHERE kind = 'note'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM planning_activity WHERE kind = 'status_change'"
            ),
            2
        );
        assert!(matches!(
            db.with_transaction(|conn| {
                submit_for_review_tx(
                    conn,
                    f.id.clone(),
                    Some(f.revision),
                    Some("重复提交".into()),
                )
            })
            .unwrap_err(),
            AppError::Conflict(_)
        ));
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM planning_activity WHERE kind = 'note'"
            ),
            1
        );

        let mut empty_note_input = feat_input("空说明");
        empty_note_input.status = Some("in_progress".into());
        let empty_note_feature = create_feature_impl(&db, project_id, empty_note_input).unwrap();
        db.with_transaction(|conn| {
            submit_for_review_tx(
                conn,
                empty_note_feature.id.clone(),
                Some(empty_note_feature.revision),
                Some("   ".into()),
            )
        })
        .unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM planning_activity WHERE kind = 'note'"
            ),
            1
        );
    }

    #[test]
    fn submit_for_review_rolls_back_when_note_write_fails() {
        let db = memdb();
        let p = create_project_impl(&db, proj_input("P")).unwrap();
        let mut input = feat_input("F");
        input.status = Some("in_progress".into());
        let f = create_feature_impl(&db, p.id, input).unwrap();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_review_note BEFORE INSERT ON planning_activity
                 WHEN NEW.kind = 'note' BEGIN SELECT RAISE(ABORT, 'note write failed'); END;",
            )?;
            Ok(())
        })
        .unwrap();

        let result = db.with_transaction(|conn| {
            submit_for_review_tx(conn, f.id.clone(), Some(f.revision), Some("有说明".into()))
        });
        assert!(result.is_err());
        let current = db.with_read(|conn| load_feature_tx(conn, &f.id)).unwrap();
        assert_eq!(current.status, "in_progress");
        assert_eq!(current.revision, f.revision);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM planning_activity WHERE kind = 'status_change'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM planning_activity WHERE kind = 'note'"
            ),
            0
        );
    }

    #[test]
    fn feature_agent_links_use_real_session_state_and_unlink_in_place() {
        let db = memdb();
        let project = create_project_impl(&db, proj_input("P")).unwrap();
        let feature = create_feature_impl(&db, project.id.clone(), feat_input("F")).unwrap();
        let run_started = "2026-11-06T10:11:12Z";
        db.with_transaction(|conn| {
            // `codex` 由数据库迁移预置（v2 INSERT OR IGNORE），这里直接复用，
            // 重复插入会触发 agent_sources.id 唯一约束。
            conn.execute(
                "INSERT INTO agent_sessions
                 (id, source_id, external_id, title, status, first_seen_at, last_seen_at, origin)
                 VALUES ('session-row', 'codex', 'external-session', '会话', 'waiting', ?1, ?1, 'real')",
                rusqlite::params![now_iso()],
            )?;
            conn.execute(
                "INSERT INTO agent_runs (id, session_id, source_id, status, started_at, updated_at)
                 VALUES ('run-row', 'session-row', 'codex', 'waiting', ?1, ?1)",
                rusqlite::params![run_started],
            )?;
            conn.execute(
                "INSERT INTO feature_agent_links
                 (id, feature_id, agent_source, session_id, status, last_event_at, created_at)
                 VALUES ('known-link', ?1, 'codex', 'external-session', 'linked', ?2, '1')",
                rusqlite::params![feature.id, now_iso()],
            )?;
            conn.execute(
                "INSERT INTO feature_agent_links
                 (id, feature_id, agent_source, session_id, status, last_event_at, created_at)
                 VALUES ('unknown-link', ?1, 'missing-source', 'unknown-session', 'linked', ?2, '2')",
                rusqlite::params![feature.id, now_iso()],
            )?;
            Ok(())
        })
        .unwrap();

        let links = list_feature_agent_links_impl(&db, &feature.id).unwrap();
        assert_eq!(links.len(), 2);
        let known = links.iter().find(|link| link.id == "known-link").unwrap();
        // 来源显示名来自迁移预置的 agent_sources（id='codex'，display_name='Codex'）。
        assert_eq!(known.agent_name.as_deref(), Some("Codex"));
        assert_eq!(known.agent_status.as_deref(), Some("waiting"));
        assert_eq!(known.agent_session_id.as_deref(), Some("session-row"));
        assert_eq!(known.last_execution_at.as_deref(), Some(run_started));
        let unknown = links.iter().find(|link| link.id == "unknown-link").unwrap();
        assert!(unknown.agent_name.is_none());
        assert!(unknown.agent_status.is_none());
        assert!(unknown.agent_session_id.is_none());
        assert!(unknown.last_execution_at.is_none());

        let session_links = db
            .with_read(|conn| list_agent_feature_links_inner(conn, "codex", "external-session"))
            .unwrap();
        assert_eq!(session_links.len(), 1);
        assert_eq!(session_links[0].feature_id, feature.id);

        let project_id =
            unlink_agent_session_impl(&db, &feature.id, "codex", "external-session").unwrap();
        assert_eq!(project_id, project.id);
        let links = list_feature_agent_links_impl(&db, &feature.id).unwrap();
        assert_eq!(
            links
                .iter()
                .find(|link| link.id == "known-link")
                .unwrap()
                .status,
            "unlinked"
        );
        assert!(db
            .with_read(|conn| list_agent_feature_links_inner(conn, "codex", "external-session"))
            .unwrap()
            .is_empty());
        assert!(unlink_agent_session_impl(&db, &feature.id, "codex", "external-session").is_err());
    }
}
