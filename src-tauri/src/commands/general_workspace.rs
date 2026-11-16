//! 通用工作空间专业后端（U1，2026-11-16）：项目模板 / 里程碑与阶段 / 项目资料 / 真实统计。
//!
//! ## 归属
//! 本文件由**通用线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `general_`，业务实现 `*_impl(db, ...)` 可单测，薄包装挂 `State<Arc<Db>>`。
//! - 写入门禁：`kind = general` 且 `status = active`；读取允许归档（只读）。
//! - 里程碑与事项/任务的关系都是**弱引用**：只存 ID，不复制事项/任务数据；
//!   关联事项引用 `workspace_items.id`，关联任务引用 `tasks.id`，不另建事项表。
//! - 资料只存路径 / 链接 / 笔记 ID 与元数据；删除关联**不得删除、移动、重命名原始文件**。
//! - 所有统计来自真实 SQLite 数据；没有数据的指标返回 0 / 空列表，不填充示例数字。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::navigation::{validate_local_path, validate_url};

/// v62：里程碑 / 项目资料（通用 U1）。
///
/// 表名已在契约 §4 冻结；`project_id` 级联删除；事项/任务/笔记均为弱引用，
/// 不在本文件加外键（目标删除后保留原 ID，读侧派生 `exists` / `alive`）。
pub const MIGRATION_62: (i64, &'static str) = (
    62,
    r#"
-- v62（通用 U1）：项目阶段/里程碑与项目资料。
CREATE TABLE general_milestones (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES workspace_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','done','skipped')),
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 弱引用 workspace_items.id / tasks.id；不加外键，目标消失后保留原 ID。
  linked_item_id TEXT,
  linked_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_general_milestones_project
  ON general_milestones(project_id, sort_order);

CREATE TABLE general_materials (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES workspace_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file','folder','link','note')),
  title TEXT NOT NULL,
  -- file/folder：绝对路径；link：http(s) URL；note：notes.id；其余为空串。
  path TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_general_materials_project
  ON general_materials(project_id, kind, sort_order);
"#,
);

// ── 校验常量 ──────────────────────────────────────────────────────────

const MAX_TITLE_CHARS: usize = 240;
const MAX_STAGE_CHARS: usize = 120;
const MAX_NOTE_CHARS: usize = 4000;
const MAX_PATH_CHARS: usize = 4096;
const MAX_REF_ID_CHARS: usize = 64;
const MAX_STAGES: usize = 20;
const MAX_TEMPLATE_ITEMS: usize = 200;
const MAX_TEMPLATE_MILESTONES: usize = 50;
const MAX_LIST_ROWS: i64 = 200;
const MILESTONE_STATUSES: &[&str] = &["open", "done", "skipped"];
const MATERIAL_KINDS: &[&str] = &["file", "folder", "link", "note"];

// ── 返回模型 ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMilestone {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub target_date: Option<String>,
    pub status: String,
    pub note: String,
    pub sort_order: i64,
    pub linked_item_id: Option<String>,
    pub linked_item_exists: bool,
    pub linked_item_title: Option<String>,
    pub linked_task_id: Option<String>,
    pub linked_task_exists: bool,
    pub linked_task_title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMaterial {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub note: String,
    /// 来源当前是否可用（文件/目录存在、URL 合法、笔记记录仍在）。
    pub alive: bool,
    /// 失效原因（仅 `alive = false` 时给出可读中文说明）。
    pub alive_reason: Option<String>,
    /// note 类型：关联笔记的当前标题；其他类型为空。
    pub linked_title: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneralActivityEvent {
    pub kind: String,
    pub ref_id: String,
    pub title: String,
    pub status: Option<String>,
    pub at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneralStats {
    pub total_items: i64,
    pub todo_items: i64,
    pub doing_items: i64,
    pub blocked_items: i64,
    pub done_items: i64,
    pub milestones_total: i64,
    pub milestones_open: i64,
    pub milestones_done: i64,
    pub milestones_skipped: i64,
    pub linked_tasks: i64,
    pub materials_total: i64,
    pub materials_alive: i64,
    pub current_milestone: Option<GeneralMilestone>,
    pub recent_activity: Vec<GeneralActivityEvent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMilestoneList {
    pub milestones: Vec<GeneralMilestone>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMilestoneSaved {
    pub milestone: GeneralMilestone,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMaterialList {
    pub materials: Vec<GeneralMaterial>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMaterialSaved {
    pub material: GeneralMaterial,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralStatsReport {
    pub stats: GeneralStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralApplyTemplateResult {
    pub applied: bool,
    pub items_created: i64,
    pub milestones_created: i64,
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralMaterialOpened {
    pub kind: String,
    pub opened: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralOk {
    pub ok: bool,
}

// ── 模板输入（前端常量下发，后端只做校验与真实落库）─────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMilestoneInput {
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateStageInput {
    pub title: String,
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub milestone: Option<TemplateMilestoneInput>,
}

// ── 校验与门禁 ─────────────────────────────────────────────────────────

fn validate_text(value: &str, field: &str, max_chars: usize, allow_empty: bool) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!("{field}超过 {max_chars} 字符")));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

fn validate_optional_id(raw: Option<String>, field: &str) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(None);
            }
            if value.chars().count() > MAX_REF_ID_CHARS || value.chars().any(|c| c.is_control()) {
                return Err(AppError::Validation(format!("{field}格式非法")));
            }
            Ok(Some(value.to_string()))
        }
    }
}

fn validate_date(raw: Option<String>) -> AppResult<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    let digits: Vec<char> = raw.chars().collect();
    let ok = digits.len() == 10
        && digits[4] == '-'
        && digits[7] == '-'
        && digits[0..4].iter().all(|c| c.is_ascii_digit())
        && digits[5..7].iter().all(|c| c.is_ascii_digit())
        && digits[8..10].iter().all(|c| c.is_ascii_digit());
    if !ok {
        return Err(AppError::Validation("目标日期必须是 YYYY-MM-DD 格式".into()));
    }
    Ok(Some(raw))
}

/// 通用项目统一门禁：`kind = general`；`require_active` 为 true 时（所有写入）
/// 还要求 `status = active`；读取允许归档项目。
fn ensure_general_project(
    conn: &Connection,
    project_id: &str,
    require_active: bool,
) -> AppResult<()> {
    let (kind, status): (String, String) = conn
        .query_row(
            "SELECT kind, status FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
    if kind != "general" {
        return Err(AppError::Validation(
            "该操作仅对通用项目开放".to_string(),
        ));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，阶段与资料只读；恢复为进行中后才能修改".to_string(),
        ));
    }
    Ok(())
}

fn milestone_project_id(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM general_milestones WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("里程碑不存在或已被删除".into()))
}

fn material_project_id(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM general_materials WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("资料关联不存在或已被删除".into()))
}

// ── 读取组装 ───────────────────────────────────────────────────────────

fn row_to_milestone(
    conn: &Connection,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<GeneralMilestone> {
    let id: String = row.get("id")?;
    let linked_item_id: Option<String> = row.get("linked_item_id")?;
    let linked_task_id: Option<String> = row.get("linked_task_id")?;
    let (linked_item_exists, linked_item_title) = match &linked_item_id {
        Some(item_id) => {
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM workspace_items WHERE id = ?1",
                    params![item_id],
                    |r| r.get(0),
                )
                .optional()?;
            (title.is_some(), title)
        }
        None => (false, None),
    };
    let (linked_task_exists, linked_task_title) = match &linked_task_id {
        Some(task_id) => {
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM tasks WHERE id = ?1",
                    params![task_id],
                    |r| r.get(0),
                )
                .optional()?;
            (title.is_some(), title)
        }
        None => (false, None),
    };
    Ok(GeneralMilestone {
        id,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        target_date: row.get("target_date")?,
        status: row.get("status")?,
        note: row.get("note")?,
        sort_order: row.get("sort_order")?,
        linked_item_id,
        linked_item_exists,
        linked_item_title,
        linked_task_id,
        linked_task_exists,
        linked_task_title,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn material_alive(
    conn: &Connection,
    kind: &str,
    path: &str,
) -> (bool, Option<String>, Option<String>) {
    match kind {
        "file" | "folder" => {
            let exists = Path::new(path).exists();
            if exists {
                (true, None, None)
            } else {
                (
                    false,
                    Some("文件或文件夹已不存在或被移动".to_string()),
                    None,
                )
            }
        }
        "link" => match validate_url(path) {
            Ok(()) => (true, None, None),
            Err(_) => (false, Some("链接地址无效或已失效".to_string()), None),
        },
        "note" => {
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM notes WHERE id = ?1",
                    params![path],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            match title {
                Some(title) => (true, None, Some(title)),
                None => (
                    false,
                    Some("关联笔记已被删除".to_string()),
                    None,
                ),
            }
        }
        _ => (false, Some("资料类型未知".to_string()), None),
    }
}

fn row_to_material(
    conn: &Connection,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<GeneralMaterial> {
    let kind: String = row.get("kind")?;
    let path: String = row.get("path")?;
    let (alive, alive_reason, linked_title) = material_alive(conn, &kind, &path);
    Ok(GeneralMaterial {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind,
        title: row.get("title")?,
        path,
        note: row.get("note")?,
        alive,
        alive_reason,
        linked_title,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ── 模板应用（D1）───────────────────────────────────────────────────────

/// 一次性批量创建事项与里程碑；同一事务内完成，任一步失败整体回滚。
/// 幂等：项目已有任何事项或里程碑时不再重复写入，返回 `applied = false`。
pub fn general_apply_template_impl(
    db: &Db,
    project_id: String,
    template_id: String,
    stages: Vec<TemplateStageInput>,
) -> AppResult<GeneralApplyTemplateResult> {
    let project_id = project_id.trim().to_string();
    let template_id = template_id.trim().to_string();
    if template_id.is_empty() || template_id.chars().count() > MAX_REF_ID_CHARS {
        return Err(AppError::Validation("模板 ID 非法".into()));
    }
    if stages.len() > MAX_STAGES {
        return Err(AppError::Validation("模板阶段数量非法".into()));
    }
    // 空白模板：不预置事项与里程碑，直接返回不初始化。
    if stages.is_empty() {
        return Ok(GeneralApplyTemplateResult {
            applied: false,
            items_created: 0,
            milestones_created: 0,
            reason: Some("空白项目不预置事项与里程碑".into()),
        });
    }
    let mut total_items = 0usize;
    let mut total_milestones = 0usize;
    for stage in &stages {
        validate_text(&stage.title, "阶段名称", MAX_STAGE_CHARS, false)?;
        if stage.items.len() > MAX_TEMPLATE_ITEMS {
            return Err(AppError::Validation("模板事项数量超出上限".into()));
        }
        for item in &stage.items {
            validate_text(item, "事项标题", MAX_TITLE_CHARS, false)?;
        }
        if let Some(milestone) = &stage.milestone {
            validate_text(&milestone.title, "里程碑名称", MAX_TITLE_CHARS, false)?;
        }
        total_items += stage.items.len();
        total_milestones += usize::from(stage.milestone.is_some());
    }
    if total_items > MAX_TEMPLATE_ITEMS {
        return Err(AppError::Validation("模板事项总数超出上限".into()));
    }
    if total_milestones > MAX_TEMPLATE_MILESTONES {
        return Err(AppError::Validation("模板里程碑总数超出上限".into()));
    }

    let existing: i64 = db.with_read(|conn| {
        ensure_general_project(conn, &project_id, true)?;
        let items: i64 = conn.query_row(
            "SELECT COUNT(*) FROM workspace_items WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        let milestones: i64 = conn.query_row(
            "SELECT COUNT(*) FROM general_milestones WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        Ok(items + milestones)
    })?;
    if existing > 0 {
        return Ok(GeneralApplyTemplateResult {
            applied: false,
            items_created: 0,
            milestones_created: 0,
            reason: Some("项目已有事项或里程碑，模板未重复应用".into()),
        });
    }

    let mut items_created = 0i64;
    let mut milestones_created = 0i64;
    db.with_transaction(|conn| {
        ensure_general_project(conn, &project_id, true)?;
        let now = now_iso();
        for (stage_index, stage) in stages.iter().enumerate() {
            let mut stage_item_ids: Vec<String> = Vec::new();
            for (item_index, item_title) in stage.items.iter().enumerate() {
                let item_id = uuid::Uuid::new_v4().to_string();
                let metadata = serde_json::json!({ "generalTemplate": template_id })
                    .to_string();
                conn.execute(
                    "INSERT INTO workspace_items
                     (id, project_id, parent_id, title, stage, status, sort_order,
                      metadata_json, created_at, updated_at)
                     VALUES (?1, ?2, NULL, ?3, ?4, 'todo', ?5, ?6, ?7, ?7)",
                    params![
                        item_id,
                        project_id,
                        item_title.trim(),
                        stage.title.trim(),
                        item_index as i64,
                        metadata,
                        now
                    ],
                )?;
                stage_item_ids.push(item_id);
                items_created += 1;
            }
            if let Some(milestone) = &stage.milestone {
                let milestone_id = uuid::Uuid::new_v4().to_string();
                let note = milestone.note.clone().unwrap_or_default();
                conn.execute(
                    "INSERT INTO general_milestones
                     (id, project_id, title, target_date, status, note, sort_order,
                      linked_item_id, linked_task_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, NULL, 'open', ?4, ?5, ?6, NULL, ?7, ?7)",
                    params![
                        milestone_id,
                        project_id,
                        milestone.title.trim(),
                        note.trim(),
                        stage_index as i64,
                        stage_item_ids.first().cloned(),
                        now
                    ],
                )?;
                milestones_created += 1;
            }
        }
        Ok(())
    })?;

    Ok(GeneralApplyTemplateResult {
        applied: true,
        items_created,
        milestones_created,
        reason: None,
    })
}

// ── 里程碑（D2）───────────────────────────────────────────────────────

pub fn general_milestone_list_impl(
    db: &Db,
    project_id: &str,
) -> AppResult<GeneralMilestoneList> {
    let milestones = db.with_read(|conn| {
        ensure_general_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, target_date, status, note, sort_order,
                    linked_item_id, linked_task_id, created_at, updated_at
             FROM general_milestones
             WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], |row| {
            row_to_milestone(conn, row)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })?;
    Ok(GeneralMilestoneList { milestones })
}

#[allow(clippy::too_many_arguments)]
pub fn general_milestone_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    title: String,
    target_date: Option<String>,
    status: Option<String>,
    note: Option<String>,
    linked_item_id: Option<String>,
    linked_task_id: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<GeneralMilestoneSaved> {
    let title = validate_text(&title, "里程碑名称", MAX_TITLE_CHARS, false)?;
    let target_date = validate_date(target_date)?;
    let status = match status {
        None => "open".to_string(),
        Some(value) => {
            let value = value.trim().to_string();
            if !MILESTONE_STATUSES.contains(&value.as_str()) {
                return Err(AppError::Validation(format!(
                    "里程碑状态只允许 {} 之一",
                    MILESTONE_STATUSES.join(" | ")
                )));
            }
            value
        }
    };
    let note = validate_text(&note.unwrap_or_default(), "里程碑备注", MAX_NOTE_CHARS, true)?;
    let linked_item_id = validate_optional_id(linked_item_id, "关联事项")?;
    let linked_task_id = validate_optional_id(linked_task_id, "关联任务")?;
    let sort_order = sort_order.unwrap_or(0);
    if !(-1_000_000..=1_000_000).contains(&sort_order) {
        return Err(AppError::Validation("排序值超出范围".into()));
    }
    let project_id = project_id.trim().to_string();
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_general_project(conn, &project_id, true)?;
        if let Some(item_id) = &linked_item_id {
            let item_project: Option<String> = conn
                .query_row(
                    "SELECT project_id FROM workspace_items WHERE id = ?1",
                    params![item_id],
                    |r| r.get(0),
                )
                .optional()?;
            match item_project {
                Some(p) if p == project_id => {}
                Some(_) => {
                    return Err(AppError::Validation("关联事项不属于当前项目".into()))
                }
                None => return Err(AppError::NotFound("关联事项不存在".into())),
            }
        }
        if let Some(task_id) = &linked_task_id {
            let task_exists = conn
                .query_row(
                    "SELECT 1 FROM tasks WHERE id = ?1",
                    params![task_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !task_exists {
                return Err(AppError::NotFound(format!("关联任务不存在: {task_id}")));
            }
        }
        match id {
            None => {
                let new_id = uuid::Uuid::new_v4().to_string();
                let now = now_iso();
                conn.execute(
                    "INSERT INTO general_milestones
                     (id, project_id, title, target_date, status, note, sort_order,
                      linked_item_id, linked_task_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    params![
                        new_id,
                        project_id,
                        title,
                        target_date,
                        status,
                        note,
                        sort_order,
                        linked_item_id,
                        linked_task_id,
                        now
                    ],
                )?;
                Ok::<String, AppError>(new_id)
            }
            Some(id) => {
                let existing_project: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM general_milestones WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(existing_project) = existing_project else {
                    return Err(AppError::NotFound(format!("里程碑不存在: {id}")));
                };
                if existing_project != project_id {
                    return Err(AppError::Validation("里程碑所属项目不可变更".into()));
                }
                let now = now_iso();
                conn.execute(
                    "UPDATE general_milestones
                     SET title = ?1, target_date = ?2, status = ?3, note = ?4,
                         sort_order = ?5, linked_item_id = ?6, linked_task_id = ?7,
                         updated_at = ?8
                     WHERE id = ?9",
                    params![
                        title,
                        target_date,
                        status,
                        note,
                        sort_order,
                        linked_item_id,
                        linked_task_id,
                        now,
                        id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, project_id, title, target_date, status, note, sort_order,
                    linked_item_id, linked_task_id, created_at, updated_at
             FROM general_milestones WHERE id = ?1",
            params![saved_id],
            |row| row_to_milestone(conn, row),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("里程碑不存在: {saved_id}")))
    })
    .map(|milestone| GeneralMilestoneSaved { milestone })
}

pub fn general_milestone_delete_impl(db: &Db, id: &str) -> AppResult<GeneralOk> {
    db.with_transaction(|conn| {
        let project_id = milestone_project_id(conn, id)?;
        ensure_general_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM general_milestones WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    Ok(GeneralOk { ok: true })
}

// ── 项目资料（D3）───────────────────────────────────────────────────────

pub fn general_material_list_impl(
    db: &Db,
    project_id: &str,
) -> AppResult<GeneralMaterialList> {
    let materials = db.with_read(|conn| {
        ensure_general_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, title, path, note, sort_order,
                    created_at, updated_at
             FROM general_materials
             WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], |row| {
            row_to_material(conn, row)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })?;
    Ok(GeneralMaterialList { materials })
}

fn validate_material_path(
    conn: &Connection,
    kind: &str,
    path: &str,
) -> AppResult<String> {
    let path = path.trim();
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::Validation("资料路径过长".into()));
    }
    match kind {
        "file" | "folder" => {
            validate_local_path(path)?;
            Ok(path.to_string())
        }
        "link" => {
            validate_url(path)?;
            Ok(path.to_string())
        }
        "note" => {
            if path.is_empty() || path.chars().count() > MAX_REF_ID_CHARS {
                return Err(AppError::Validation("笔记 ID 非法".into()));
            }
            let note_exists = conn
                .query_row(
                    "SELECT 1 FROM notes WHERE id = ?1",
                    params![path],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !note_exists {
                return Err(AppError::NotFound(format!("笔记不存在: {path}")));
            }
            Ok(path.to_string())
        }
        _ => Err(AppError::Validation("资料类型非法".into())),
    }
}

pub fn general_material_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    kind: String,
    title: String,
    path: String,
    note: Option<String>,
) -> AppResult<GeneralMaterialSaved> {
    let kind = kind.trim().to_string();
    if !MATERIAL_KINDS.contains(&kind.as_str()) {
        return Err(AppError::Validation(format!(
            "资料类型只允许 {} 之一",
            MATERIAL_KINDS.join(" | ")
        )));
    }
    let title = validate_text(&title, "资料标题", MAX_TITLE_CHARS, false)?;
    let note = validate_text(&note.unwrap_or_default(), "资料备注", MAX_NOTE_CHARS, true)?;
    let project_id = project_id.trim().to_string();
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_general_project(conn, &project_id, true)?;
        let path = validate_material_path(conn, &kind, &path)?;
        match id {
            None => {
                let new_id = uuid::Uuid::new_v4().to_string();
                let now = now_iso();
                conn.execute(
                    "INSERT INTO general_materials
                     (id, project_id, kind, title, path, note, sort_order,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
                    params![new_id, project_id, kind, title, path, note, now],
                )?;
                Ok::<String, AppError>(new_id)
            }
            Some(id) => {
                let existing_project: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM general_materials WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(existing_project) = existing_project else {
                    return Err(AppError::NotFound(format!("资料关联不存在: {id}")));
                };
                if existing_project != project_id {
                    return Err(AppError::Validation("资料所属项目不可变更".into()));
                }
                let now = now_iso();
                conn.execute(
                    "UPDATE general_materials
                     SET kind = ?1, title = ?2, path = ?3, note = ?4, updated_at = ?5
                     WHERE id = ?6",
                    params![kind, title, path, note, now, id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;

    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, project_id, kind, title, path, note, sort_order,
                    created_at, updated_at
             FROM general_materials WHERE id = ?1",
            params![saved_id],
            |row| row_to_material(conn, row),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("资料关联不存在: {saved_id}")))
    })
    .map(|material| GeneralMaterialSaved { material })
}

/// 删除关联：只删登记行，绝不删除、移动或重命名原始文件/笔记/链接目标。
pub fn general_material_delete_impl(db: &Db, id: &str) -> AppResult<GeneralOk> {
    db.with_transaction(|conn| {
        let project_id = material_project_id(conn, id)?;
        ensure_general_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM general_materials WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    Ok(GeneralOk { ok: true })
}

/// 打开资料来源：文件/目录走系统关联程序，链接走默认浏览器；
/// 笔记类型不在此处启动外部程序，由前端展示笔记标题与失效状态。
pub fn general_material_open_impl(
    app: &AppHandle,
    db: &Db,
    id: &str,
) -> AppResult<GeneralMaterialOpened> {
    let material = db.with_read(|conn| {
        let project_id = material_project_id(conn, id)?;
        ensure_general_project(conn, &project_id, false)?;
        conn.query_row(
            "SELECT kind, path FROM general_materials WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("资料关联不存在或已被删除".into()))
    })?;

    use tauri_plugin_opener::OpenerExt;
    match material.0.as_str() {
        "file" | "folder" => {
            let target = validate_local_path(&material.1)?;
            app.opener()
                .open_path(target.to_string_lossy().as_ref(), None::<&str>)
                .map_err(|e| AppError::Validation(format!("打开失败：{e}")))?;
            Ok(GeneralMaterialOpened {
                kind: material.0,
                opened: true,
            })
        }
        "link" => {
            validate_url(&material.1)?;
            app.opener()
                .open_url(material.1.trim(), None::<&str>)
                .map_err(|e| AppError::Validation(format!("打开链接失败：{e}")))?;
            Ok(GeneralMaterialOpened {
                kind: material.0,
                opened: true,
            })
        }
        "note" => Ok(GeneralMaterialOpened {
            kind: material.0,
            opened: false,
        }),
        other => Err(AppError::Validation(format!("未知资料类型: {other}"))),
    }
}

// ── 统计与活动记录（D4，全部来自真实数据）───────────────────────────────

fn count_by(conn: &Connection, sql: &str, project_id: &str) -> AppResult<i64> {
    conn.query_row(sql, params![project_id], |r| r.get(0)).map_err(AppError::from)
}

pub fn general_stats_impl(db: &Db, project_id: &str) -> AppResult<GeneralStatsReport> {
    let stats = db.with_read(|conn| {
        ensure_general_project(conn, project_id, false)?;

        let total_items = count_by(
            conn,
            "SELECT COUNT(*) FROM workspace_items WHERE project_id = ?1",
            project_id,
        )?;
        let todo_items = count_by(
            conn,
            "SELECT COUNT(*) FROM workspace_items WHERE project_id = ?1 AND status = 'todo'",
            project_id,
        )?;
        let doing_items = count_by(
            conn,
            "SELECT COUNT(*) FROM workspace_items WHERE project_id = ?1 AND status = 'doing'",
            project_id,
        )?;
        let blocked_items = count_by(
            conn,
            "SELECT COUNT(*) FROM workspace_items WHERE project_id = ?1 AND status = 'blocked'",
            project_id,
        )?;
        let done_items = count_by(
            conn,
            "SELECT COUNT(*) FROM workspace_items WHERE project_id = ?1 AND status = 'done'",
            project_id,
        )?;

        let milestones_total = count_by(
            conn,
            "SELECT COUNT(*) FROM general_milestones WHERE project_id = ?1",
            project_id,
        )?;
        let milestones_open = count_by(
            conn,
            "SELECT COUNT(*) FROM general_milestones WHERE project_id = ?1 AND status = 'open'",
            project_id,
        )?;
        let milestones_done = count_by(
            conn,
            "SELECT COUNT(*) FROM general_milestones WHERE project_id = ?1 AND status = 'done'",
            project_id,
        )?;
        let milestones_skipped = count_by(
            conn,
            "SELECT COUNT(*) FROM general_milestones WHERE project_id = ?1 AND status = 'skipped'",
            project_id,
        )?;

        let linked_tasks = count_by(
            conn,
            "SELECT COUNT(*) FROM workspace_task_links WHERE project_id = ?1",
            project_id,
        )?;

        let materials_total = count_by(
            conn,
            "SELECT COUNT(*) FROM general_materials WHERE project_id = ?1",
            project_id,
        )?;

        // 当前里程碑：状态 open，优先有目标日期且日期最近的，其次最早创建的。
        let current_milestone = conn
            .query_row(
                "SELECT id, project_id, title, target_date, status, note, sort_order,
                        linked_item_id, linked_task_id, created_at, updated_at
                 FROM general_milestones
                 WHERE project_id = ?1 AND status = 'open'
                 ORDER BY (target_date IS NULL), target_date, created_at, id
                 LIMIT 1",
                params![project_id],
                |row| row_to_milestone(conn, row),
            )
            .optional()?;

        // 活动记录：从事项/里程碑/资料/任务关联的真实时间戳推导，不编造事件。
        let mut events: Vec<GeneralActivityEvent> = Vec::new();

        let mut item_stmt = conn.prepare(
            "SELECT id, title, status, updated_at FROM workspace_items
             WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT 20",
        )?;
        for row in item_stmt.query_map(params![project_id], |r| {
            Ok(GeneralActivityEvent {
                kind: "item".into(),
                ref_id: r.get(0)?,
                title: r.get(1)?,
                status: Some(r.get(2)?),
                at: r.get(3)?,
            })
        })? {
            events.push(row?);
        }

        let mut milestone_stmt = conn.prepare(
            "SELECT id, title, status, updated_at FROM general_milestones
             WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT 20",
        )?;
        for row in milestone_stmt.query_map(params![project_id], |r| {
            Ok(GeneralActivityEvent {
                kind: "milestone".into(),
                ref_id: r.get(0)?,
                title: r.get(1)?,
                status: Some(r.get(2)?),
                at: r.get(3)?,
            })
        })? {
            events.push(row?);
        }

        let mut material_stmt = conn.prepare(
            "SELECT id, title, kind, created_at FROM general_materials
             WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 20",
        )?;
        for row in material_stmt.query_map(params![project_id], |r| {
            Ok(GeneralActivityEvent {
                kind: "material".into(),
                ref_id: r.get(0)?,
                title: r.get(1)?,
                status: Some(r.get(2)?),
                at: r.get(3)?,
            })
        })? {
            events.push(row?);
        }

        let mut link_stmt = conn.prepare(
            "SELECT l.task_id, t.title, l.created_at
             FROM workspace_task_links l
             JOIN tasks t ON t.id = l.task_id
             WHERE l.project_id = ?1 ORDER BY l.created_at DESC LIMIT 20",
        )?;
        for row in link_stmt.query_map(params![project_id], |r| {
            Ok(GeneralActivityEvent {
                kind: "taskLink".into(),
                ref_id: r.get(0)?,
                title: r.get(1)?,
                status: None,
                at: r.get(2)?,
            })
        })? {
            events.push(row?);
        }

        events.sort_by(|a, b| b.at.cmp(&a.at));
        events.truncate(20);

        let mut materials_alive = 0i64;
        let mut mat_stmt = conn.prepare(
            "SELECT kind, path FROM general_materials WHERE project_id = ?1",
        )?;
        for row in mat_stmt.query_map(params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (kind, path) = row?;
            if material_alive(conn, &kind, &path).0 {
                materials_alive += 1;
            }
        }

        Ok(GeneralStats {
            total_items,
            todo_items,
            doing_items,
            blocked_items,
            done_items,
            milestones_total,
            milestones_open,
            milestones_done,
            milestones_skipped,
            linked_tasks,
            materials_total,
            materials_alive,
            current_milestone,
            recent_activity: events,
        })
    })?;
    Ok(GeneralStatsReport { stats })
}

// ── 薄包装（lib.rs 注册由集成负责人完成）────────────────────────────────

#[tauri::command]
pub fn general_apply_template(
    state: State<'_, Arc<Db>>,
    project_id: String,
    template_id: String,
    stages: Vec<TemplateStageInput>,
) -> AppResult<GeneralApplyTemplateResult> {
    general_apply_template_impl(state.inner(), project_id, template_id, stages)
}

#[tauri::command]
pub fn general_milestone_list(
    state: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GeneralMilestoneList> {
    general_milestone_list_impl(state.inner(), &project_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn general_milestone_save(
    state: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    title: String,
    target_date: Option<String>,
    status: Option<String>,
    note: Option<String>,
    linked_item_id: Option<String>,
    linked_task_id: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<GeneralMilestoneSaved> {
    general_milestone_save_impl(
        state.inner(),
        id,
        project_id,
        title,
        target_date,
        status,
        note,
        linked_item_id,
        linked_task_id,
        sort_order,
    )
}

#[tauri::command]
pub fn general_milestone_delete(state: State<'_, Arc<Db>>, id: String) -> AppResult<GeneralOk> {
    general_milestone_delete_impl(state.inner(), &id)
}

#[tauri::command]
pub fn general_material_list(
    state: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GeneralMaterialList> {
    general_material_list_impl(state.inner(), &project_id)
}

#[tauri::command]
pub fn general_material_save(
    state: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    kind: String,
    title: String,
    path: String,
    note: Option<String>,
) -> AppResult<GeneralMaterialSaved> {
    general_material_save_impl(state.inner(), id, project_id, kind, title, path, note)
}

#[tauri::command]
pub fn general_material_delete(state: State<'_, Arc<Db>>, id: String) -> AppResult<GeneralOk> {
    general_material_delete_impl(state.inner(), &id)
}

#[tauri::command]
pub fn general_material_open(
    app: AppHandle,
    state: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<GeneralMaterialOpened> {
    general_material_open_impl(&app, state.inner(), &id)
}

#[tauri::command]
pub fn general_stats(
    state: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<GeneralStatsReport> {
    general_stats_impl(state.inner(), &project_id)
}

// ── 测试 ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::project_workspace::{
        workspace_item_list_impl, workspace_item_save_impl, workspace_project_save_impl,
        workspace_task_link_add_impl,
    };

    fn temp_db_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-general-{}-{}",
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir.join("test.db")
    }

    fn create_project(
        db: &Db,
        name: &str,
        kind: &str,
    ) -> crate::commands::project_workspace::WorkspaceProject {
        workspace_project_save_impl(db, None, name.to_string(), kind.to_string(), None, None, None)
            .expect("创建项目")
    }

    fn sample_stages() -> Vec<TemplateStageInput> {
        serde_json::from_value(serde_json::json!([
            {
                "title": "准备阶段",
                "items": ["调研目标", "列出清单"],
                "milestone": { "title": "准备完成", "note": "开工前检查" }
            },
            {
                "title": "执行阶段",
                "items": ["落地第一项", "落地第二项"],
                "milestone": { "title": "执行完成" }
            }
        ]))
        .expect("模板样例合法")
    }

    #[test]
    fn template_applies_real_items_and_milestones_and_is_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "通用项目", "general");

        let result = general_apply_template_impl(
            &db,
            project.id.clone(),
            "study-plan".into(),
            sample_stages(),
        )
        .unwrap();
        assert!(result.applied);
        assert_eq!(result.items_created, 4);
        assert_eq!(result.milestones_created, 2);

        let items = workspace_item_list_impl(&db, &project.id).unwrap();
        assert_eq!(items.len(), 4);
        assert!(items.iter().all(|i| i.status == "todo"));
        let milestones = general_milestone_list_impl(&db, &project.id).unwrap().milestones;
        assert_eq!(milestones.len(), 2);
        assert_eq!(milestones[0].linked_item_id.as_deref(), Some(items[0].id.as_str()));

        // 重复应用：幂等，不再产生重复数据。
        let again = general_apply_template_impl(
            &db,
            project.id.clone(),
            "study-plan".into(),
            sample_stages(),
        )
        .unwrap();
        assert!(!again.applied);
        assert_eq!(again.items_created, 0);
        assert_eq!(workspace_item_list_impl(&db, &project.id).unwrap().len(), 4);
        assert_eq!(general_milestone_list_impl(&db, &project.id).unwrap().milestones.len(), 2);
    }

    #[test]
    fn milestone_crud_links_item_and_task_and_stats_sync() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "里程碑", "general");

        let item = workspace_item_save_impl(
            &db,
            None,
            project.id.clone(),
            None,
            "首要事项".into(),
            None,
            Some("doing".into()),
            None,
            None,
        )
        .unwrap();

        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t-g', '关联任务', ?1, ?1)",
                params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        workspace_task_link_add_impl(&db, &project.id, "t-g").unwrap();

        let m = general_milestone_save_impl(
            &db,
            None,
            project.id.clone(),
            "阶段一".into(),
            Some("2026-12-01".into()),
            Some("open".into()),
            Some("备注".into()),
            Some(item.id.clone()),
            Some("t-g".into()),
            Some(0),
        )
        .unwrap()
        .milestone;
        assert_eq!(m.linked_item_title.as_deref(), Some("首要事项"));
        assert_eq!(m.linked_task_title.as_deref(), Some("关联任务"));
        assert!(m.linked_item_exists && m.linked_task_exists);

        // 编辑日期与状态。
        let updated = general_milestone_save_impl(
            &db,
            Some(m.id.clone()),
            project.id.clone(),
            "阶段一（改）".into(),
            Some("2026-12-05".into()),
            Some("done".into()),
            None,
            Some(item.id.clone()),
            Some("t-g".into()),
            Some(0),
        )
        .unwrap()
        .milestone;
        assert_eq!(updated.target_date.as_deref(), Some("2026-12-05"));
        assert_eq!(updated.status, "done");

        // 事项状态变化后统计同步：doing 事项 1，done 里程碑 1。
        let stats = general_stats_impl(&db, &project.id).unwrap().stats;
        assert_eq!(stats.total_items, 1);
        assert_eq!(stats.doing_items, 1);
        assert_eq!(stats.done_items, 0);
        assert_eq!(stats.milestones_total, 1);
        assert_eq!(stats.milestones_done, 1);
        assert_eq!(stats.linked_tasks, 1);
        assert!(stats.current_milestone.is_none()); // 没有 open 里程碑

        // 非法日期拒绝。
        assert!(general_milestone_save_impl(
            &db,
            Some(m.id.clone()),
            project.id.clone(),
            "阶段一".into(),
            Some("2026/12/05".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn materials_link_unlink_keeps_original_file_and_detects_missing() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "资料", "general");

        let dir = std::env::temp_dir().join(format!(
            "td-general-mat-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        std::fs::write(&file, "原始内容").unwrap();

        let mat = general_material_save_impl(
            &db,
            None,
            project.id.clone(),
            "file".into(),
            "原始笔记".into(),
            file.to_string_lossy().to_string(),
            None,
        )
        .unwrap()
        .material;
        assert!(mat.alive);
        assert!(mat.alive_reason.is_none());

        // 链接类型校验：危险协议拒绝。
        assert!(general_material_save_impl(
            &db,
            None,
            project.id.clone(),
            "link".into(),
            "页面".into(),
            "javascript:alert(1)".into(),
            None,
        )
        .is_err());
        let link = general_material_save_impl(
            &db,
            None,
            project.id.clone(),
            "link".into(),
            "示例站".into(),
            "https://example.com".into(),
            None,
        )
        .unwrap()
        .material;
        assert!(link.alive);

        // 笔记类型：缺失的笔记 ID 拒绝写入。
        assert!(general_material_save_impl(
            &db,
            None,
            project.id.clone(),
            "note".into(),
            "某笔记".into(),
            "note-missing".into(),
            None,
        )
        .is_err());

        // 删除关联：原文件仍然存在。
        general_material_delete_impl(&db, &mat.id).unwrap();
        assert!(file.exists(), "删除资料关联不得删除原始文件");
        assert_eq!(general_material_list_impl(&db, &project.id).unwrap().materials.len(), 1);

        // 不存在的路径拒绝注册。
        let ghost = general_material_save_impl(
            &db,
            None,
            project.id.clone(),
            "file".into(),
            "已删文件".into(),
            file.to_string_lossy().to_string(),
            None,
        );
        assert!(ghost.is_err(), "注册时路径必须存在");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kind_gate_isolation_and_archived_read_only() {
        let db = Db::open_in_memory().unwrap();
        let general = create_project(&db, "通用", "general");
        let novel = create_project(&db, "小说", "novel");
        let dev = create_project(&db, "开发", "development");

        // 非 general 类型写入被拒。
        assert!(general_milestone_save_impl(
            &db, None, novel.id.clone(), "越界".into(), None, None, None, None, None, None,
        )
        .is_err());
        assert!(general_material_save_impl(
            &db, None, dev.id.clone(), "link".into(), "越界".into(), "https://example.com".into(), None,
        )
        .is_err());

        // 跨项目隔离：另一项目看不到本项目里程碑/资料。
        let m = general_milestone_save_impl(
            &db, None, general.id.clone(), "阶段".into(), None, None, None, None, None, None,
        )
        .unwrap()
        .milestone;
        assert!(general_milestone_list_impl(&db, &novel.id).unwrap().milestones.is_empty());
        assert!(general_milestone_list_impl(&db, &dev.id).unwrap().milestones.is_empty());

        // 归档后写入拒绝、读取允许。
        crate::commands::project_workspace::workspace_project_set_status_impl(
            &db,
            &general.id,
            "archived".into(),
        )
        .unwrap();
        assert!(general_milestone_save_impl(
            &db, Some(m.id.clone()), general.id.clone(), "改名".into(), None, None, None, None, None, None,
        )
        .is_err());
        assert!(general_milestone_delete_impl(&db, &m.id).is_err());
        assert!(general_material_list_impl(&db, &general.id).unwrap().materials.is_empty());
        assert_eq!(general_milestone_list_impl(&db, &general.id).unwrap().milestones.len(), 1);

        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn multiple_templates_seed_distinct_projects_with_real_rows() {
        let db = Db::open_in_memory().unwrap();

        // 内容制作模板：3 阶段，7 个事项，3 个里程碑。
        let production = create_project(&db, "内容项目", "general");
        let production_stages: Vec<TemplateStageInput> = serde_json::from_value(serde_json::json!([
            { "title": "选题策划", "items": ["确定选题", "调研参考案例"], "milestone": { "title": "选题定稿" } },
            { "title": "素材准备", "items": ["收集素材", "整理素材清单"], "milestone": { "title": "素材就绪" } },
            { "title": "制作发布", "items": ["完成初稿", "审核修改", "发布成品"], "milestone": { "title": "成品交付" } }
        ]))
        .unwrap();
        let result = general_apply_template_impl(&db, production.id.clone(), "content-production".into(), production_stages).unwrap();
        assert!(result.applied);
        assert_eq!(result.items_created, 7);
        assert_eq!(result.milestones_created, 3);

        // 研究项目模板：3 阶段，6 个事项，3 个里程碑，与上一个项目隔离。
        let research = create_project(&db, "研究项目", "general");
        let research_stages: Vec<TemplateStageInput> = serde_json::from_value(serde_json::json!([
            { "title": "问题界定", "items": ["明确研究问题", "检索文献资料"], "milestone": { "title": "问题界定" } },
            { "title": "方案设计", "items": ["设计研究方法", "制定执行计划"], "milestone": { "title": "方案成型" } },
            { "title": "分析总结", "items": ["收集分析资料", "撰写结论报告"], "milestone": { "title": "成果交付" } }
        ]))
        .unwrap();
        let result2 = general_apply_template_impl(&db, research.id.clone(), "research".into(), research_stages).unwrap();
        assert!(result2.applied);
        assert_eq!(result2.items_created, 6);
        assert_eq!(result2.milestones_created, 3);

        assert_eq!(workspace_item_list_impl(&db, &production.id).unwrap().len(), 7);
        assert_eq!(general_milestone_list_impl(&db, &production.id).unwrap().milestones.len(), 3);
        assert_eq!(workspace_item_list_impl(&db, &research.id).unwrap().len(), 6);
        assert_eq!(general_milestone_list_impl(&db, &research.id).unwrap().milestones.len(), 3);
    }

    #[test]
    fn stats_empty_project_returns_zero_without_fake_data() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "空项目", "general");
        let stats = general_stats_impl(&db, &project.id).unwrap().stats;
        assert_eq!(stats.total_items, 0);
        assert_eq!(stats.done_items, 0);
        assert_eq!(stats.milestones_total, 0);
        assert_eq!(stats.materials_total, 0);
        assert_eq!(stats.linked_tasks, 0);
        assert!(stats.current_milestone.is_none());
        assert!(stats.recent_activity.is_empty());
    }

    #[test]
    fn tables_are_registered_in_backup_registry_and_persist_to_file() {
        use crate::commands::backup::{is_extended_table, table_rule};
        let rule_m = table_rule("general_milestones").expect("里程碑表已登记备份");
        let rule_mat = table_rule("general_materials").expect("资料表已登记备份");
        assert_eq!(rule_m.restore_order, 680);
        assert_eq!(rule_mat.restore_order, 682);
        assert!(!is_extended_table("general_milestones"));
        assert!(!is_extended_table("general_materials"));

        // 文件库落盘 → 重开 → 数据仍在（真实 SQLite 持久化）。
        let path = temp_db_path("persist");
        {
            let db = Db::open(&path).unwrap();
            let project = create_project(&db, "落盘项目", "general");
            general_milestone_save_impl(
                &db, None, project.id.clone(), "阶段一".into(), None, None, None, None, None, None,
            )
            .unwrap();
            general_material_save_impl(
                &db, None, project.id.clone(), "link".into(), "示例".into(),
                "https://example.com".into(), None,
            )
            .unwrap();
        }
        let reopened = Db::open(&path).unwrap();
        let projects =
            crate::commands::project_workspace::workspace_project_list_impl(&reopened, None)
                .unwrap();
        assert_eq!(projects.len(), 1);
        let original = projects.iter().find(|p| p.name == "落盘项目").unwrap();
        assert_eq!(
            general_milestone_list_impl(&reopened, &original.id).unwrap().milestones.len(),
            1
        );
        assert_eq!(
            general_material_list_impl(&reopened, &original.id).unwrap().materials.len(),
            1
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
