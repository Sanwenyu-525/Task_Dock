//! 项目工作空间命令层（v49）。
//!
//! 语义约定：
//! - Project Workspace 是跨工具的长期工作容器，不替代 `dev_projects`（单仓库登记）、
//!   `scenarios`（启动清单）或 `workspace_snapshots`（现场快照）；
//! - `dev_project_id`、`root_path` 都是引用：本层只登记与读取，**绝不移动、覆盖或
//!   删除外部文件/领域数据**；目标消失时由读侧如实返回失效状态；
//! - `workspace_items` 是通用事项/阶段节点（集数、镜头、角色、构建、测试、问题…），
//!   不引入第二套任务系统；跨工具关联仍由 `workspace_task_links` 指向现有任务；
//! - 所有写入先做命令层校验，数据库 CHECK/外键做最后兜底；错误信息面向用户可读。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 合法的工作空间类型（与迁移 v57 的 CHECK 约束保持一致；
/// v57 在 v49 的四类基础上追加 `novel`，历史迁移本身不改）。
pub const PROJECT_KINDS: &[&str] = &["development", "game", "ai_comic", "general", "novel"];
/// 项目状态：归档只影响列表展示与默认排序，不删除任何数据。
pub const PROJECT_STATUSES: &[&str] = &["active", "archived"];
/// 通用事项状态（与迁移 v49 的 CHECK 约束保持一致）。
pub const ITEM_STATUSES: &[&str] = &["todo", "doing", "blocked", "done", "archived"];

const MAX_NAME_CHARS: usize = 120;
const MAX_NOTE_CHARS: usize = 4000;
const MAX_PATH_CHARS: usize = 4096;
const MAX_MODULE_CHARS: usize = 64;
const MAX_STAGE_CHARS: usize = 64;
const MAX_ITEM_TITLE_CHARS: usize = 240;
const MAX_LAYOUT_BYTES: usize = 256 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;

// ── 返回模型 ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    /// 只登记路径，绝不写入；空串 = 未设置。
    pub root_path: String,
    /// 读时计算：root_path 当前是否存在且为目录（不落库）。
    pub root_exists: bool,
    /// 弱引用 `dev_projects.id`；目标被删除后保留原 ID。
    pub dev_project_id: Option<String>,
    /// 读时计算：关联的开发项目当前是否存在。
    pub dev_project_exists: bool,
    /// 读时计算的开发项目名称（目标不存在时为 None）。
    pub dev_project_name: Option<String>,
    pub note: String,
    pub item_count: i64,
    pub task_link_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInstance {
    pub project_id: String,
    pub active_module: String,
    /// 模块布局 JSON（库内为对象字符串；损坏行读侧降级为 "{}"）。
    pub layout_json: String,
    pub last_opened_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub stage: String,
    pub status: String,
    pub sort_order: i64,
    pub metadata_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskLink {
    pub project_id: String,
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub due_at: Option<String>,
    pub created_at: String,
}

/// 当前持久化事实的只读进度，不把 Agent completed 当作任务完成，也不自动完成父事项。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectProgress {
    pub project_id: String,
    pub items_total: i64,
    pub items_todo: i64,
    pub items_doing: i64,
    pub items_blocked: i64,
    pub items_done: i64,
    pub items_archived: i64,
    /// 分母不含 archived；没有有效事项时为 null，不能显示为 100%。
    pub items_percent: Option<i64>,
    pub linked_tasks_total: i64,
    pub linked_tasks_completed: i64,
    pub linked_tasks_percent: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelVolume {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 章节列表项：不含正文，避免打开项目时把整本正文全部读入内存。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelChapterSummary {
    pub id: String,
    pub project_id: String,
    pub volume_id: Option<String>,
    pub title: String,
    /// 非空白字符数，由正文保存时更新。
    pub word_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NovelChapter {
    #[serde(flatten)]
    pub summary: NovelChapterSummary,
    pub content: String,
}

// ── 命令响应包装 ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct WorkspaceProjectList {
    pub projects: Vec<WorkspaceProject>,
}

#[derive(Serialize)]
pub struct WorkspaceProjectSaved {
    pub project: WorkspaceProject,
}

#[derive(Serialize)]
pub struct WorkspaceInstanceGot {
    pub instance: WorkspaceInstance,
}

#[derive(Serialize)]
pub struct WorkspaceItemList {
    pub items: Vec<WorkspaceItem>,
}

#[derive(Serialize)]
pub struct WorkspaceItemSaved {
    pub item: WorkspaceItem,
}

#[derive(Serialize)]
pub struct WorkspaceTaskLinkList {
    pub links: Vec<WorkspaceTaskLink>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOk {
    pub ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActiveProject {
    pub project_id: String,
}

#[derive(Serialize)]
pub struct NovelVolumeList {
    pub volumes: Vec<NovelVolume>,
}

#[derive(Serialize)]
pub struct NovelVolumeSaved {
    pub volume: NovelVolume,
}

#[derive(Serialize)]
pub struct NovelChapterList {
    pub chapters: Vec<NovelChapterSummary>,
}

#[derive(Serialize)]
pub struct NovelChapterSaved {
    pub chapter: NovelChapterSummary,
}

#[derive(Serialize)]
pub struct NovelChapterGot {
    pub chapter: NovelChapter,
}

// ── 行映射与公共校验 ─────────────────────────────────────────────────

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceProject> {
    let root_path: String = row.get("root_path")?;
    let dev_project_id: Option<String> = row.get("dev_project_id")?;
    let dev_project_name: Option<String> = row.get("dev_project_name")?;
    Ok(WorkspaceProject {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        status: row.get("status")?,
        root_exists: !root_path.is_empty() && Path::new(&root_path).is_dir(),
        root_path,
        dev_project_exists: dev_project_name.is_some(),
        dev_project_name,
        dev_project_id,
        note: row.get("note")?,
        item_count: row.get("item_count")?,
        task_link_count: row.get("task_link_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceItem> {
    let raw_metadata: String = row.get("metadata_json")?;
    let metadata_json = match serde_json::from_str::<serde_json::Value>(&raw_metadata) {
        Ok(value) if value.is_object() => raw_metadata,
        _ => "{}".to_string(),
    };
    Ok(WorkspaceItem {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        parent_id: row.get("parent_id")?,
        title: row.get("title")?,
        stage: row.get("stage")?,
        status: row.get("status")?,
        sort_order: row.get("sort_order")?,
        metadata_json,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn validate_enum(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(AppError::Validation(format!(
            "{} 只允许 {} 之一，收到 {:?}",
            field,
            allowed.join(" | "),
            value
        )))
    }
}

fn validate_text(
    value: &str,
    field: &str,
    max_chars: usize,
    allow_empty: bool,
) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!(
            "{field}超过 {max_chars} 字符"
        )));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

fn normalize_json_object(
    raw: Option<String>,
    field: &str,
    max_bytes: usize,
) -> AppResult<String> {
    let Some(s) = raw else {
        return Ok("{}".to_string());
    };
    let s = s.trim();
    if s.is_empty() {
        return Ok("{}".to_string());
    }
    if s.len() > max_bytes {
        return Err(AppError::Validation(format!("{field}超过大小上限")));
    }
    let value: serde_json::Value = serde_json::from_str(s)
        .map_err(|_| AppError::Validation(format!("{field}必须是合法 JSON")))?;
    if !value.is_object() {
        return Err(AppError::Validation(format!("{field}必须是 JSON 对象")));
    }
    Ok(s.to_string())
}

fn normalize_optional_id(raw: Option<String>, field: &str) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(None);
            }
            if value.chars().count() > 64 || value.chars().any(|c| c.is_control()) {
                return Err(AppError::Validation(format!("{field}格式非法")));
            }
            Ok(Some(value.to_string()))
        }
    }
}

fn validate_root_path(raw: Option<String>) -> AppResult<String> {
    let raw = raw.unwrap_or_default();
    let root_path = raw.trim();
    if root_path.is_empty() {
        return Ok(String::new());
    }
    if root_path.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::Validation("项目路径过长".into()));
    }
    // 路径策略唯一来源：拒绝 UNC / `\\?\` / 盘符相对 / 非法字符（与创建服务同一口径）。
    if let Some(reason) = crate::project_hub::service::root_path_violation(root_path) {
        return Err(AppError::Validation(
            crate::project_hub::service::root_path_error(reason),
        ));
    }
    Ok(root_path.to_string())
}

fn ensure_project_exists(conn: &Connection, project_id: &str) -> AppResult<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "工作空间项目不存在: {project_id}"
        )))
    }
}

/// 小说专用命令的统一类型/状态门禁：
/// - 只有 `kind = novel` 的项目可读写小说卷/章；
/// - `require_active` 为 true 时（所有写入）还要求 `status = active`；
///   读取允许归档项目，保证归档后正文仍可查看。
fn ensure_novel_project(
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
    if kind != "novel" {
        return Err(AppError::Validation(
            "该操作仅对小说项目开放".to_string(),
        ));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，正文与章节只读；恢复为进行中后才能修改".to_string(),
        ));
    }
    Ok(())
}

/// 仅按章节 ID 操作时，先取所属项目再做类型/状态检查，避免先读出正文再拒绝。
pub(crate) fn chapter_project_id(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM novel_chapters WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("章节不存在或已被删除".into()))
}

fn read_project(conn: &Connection, id: &str) -> AppResult<WorkspaceProject> {
    conn.query_row(
        "SELECT p.id, p.name, p.kind, p.status, p.root_path, p.dev_project_id,
                p.note, p.created_at, p.updated_at,
                d.name AS dev_project_name,
                (SELECT COUNT(*) FROM workspace_items i WHERE i.project_id = p.id) AS item_count,
                (SELECT COUNT(*) FROM workspace_task_links l WHERE l.project_id = p.id) AS task_link_count
         FROM workspace_projects p
         LEFT JOIN dev_projects d ON d.id = p.dev_project_id
         WHERE p.id = ?1",
        params![id],
        row_to_project,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {id}")))
}

/// 设置当前工作空间项目（空 = 清除）。只接受存在项目的 ID 或空串，
/// 避免把任意字符串写成活跃项目。
fn set_active_project(conn: &Connection, project_id: &str) -> AppResult<()> {
    let now = now_iso();
    if project_id.is_empty() {
        conn.execute(
            "DELETE FROM application_settings WHERE key = 'workspace_active_project'",
            [],
        )?;
        return Ok(());
    }
    ensure_project_exists(conn, project_id)?;
    let value = serde_json::to_string(project_id)?;
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES ('workspace_active_project', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![value, now],
    )?;
    Ok(())
}

// ── 项目 CRUD ────────────────────────────────────────────────────────

/// 项目列表：默认先 active 后 archived，同状态按更新时间倒序。
/// `status` 可筛选；非法值直接报校验错误，不静默忽略。
pub fn workspace_project_list_impl(
    db: &Db,
    status: Option<String>,
) -> AppResult<Vec<WorkspaceProject>> {
    let status = match status.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        None => None,
        Some(value) => Some(validate_enum(&value, "status", PROJECT_STATUSES)?),
    };
    db.with_read(|conn| {
        let sql = "SELECT p.id, p.name, p.kind, p.status, p.root_path, p.dev_project_id,
                          p.note, p.created_at, p.updated_at,
                          d.name AS dev_project_name,
                          (SELECT COUNT(*) FROM workspace_items i WHERE i.project_id = p.id) AS item_count,
                          (SELECT COUNT(*) FROM workspace_task_links l WHERE l.project_id = p.id) AS task_link_count
                   FROM workspace_projects p
                   LEFT JOIN dev_projects d ON d.id = p.dev_project_id
                   WHERE (?1 IS NULL OR p.status = ?1)
                   ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
                            p.updated_at DESC, p.name";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![status], row_to_project)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

/// 保存项目：id 为空 = 新建；`root_path` 允许为空（未设置）或必须是绝对路径。
/// 目录不存在不阻止保存（移动硬盘/网络盘可能暂时离线），读侧返回 rootExists=false。
///
/// 收敛后：项目名称/类型与初始计划统一交给 `ProjectService`（项目根 + 计划同一事务）；
/// 根目录、开发仓库引用与备注仍由工作空间专属接口写入。
pub fn workspace_project_save_impl(
    db: &Db,
    id: Option<String>,
    name: String,
    kind: String,
    root_path: Option<String>,
    dev_project_id: Option<String>,
    note: Option<String>,
) -> AppResult<WorkspaceProject> {
    let name = validate_text(&name, "项目名称", MAX_NAME_CHARS, false)?;
    let kind = validate_enum(&kind, "项目类型", PROJECT_KINDS)?;
    let root_path = validate_root_path(root_path)?;
    let dev_project_id = normalize_optional_id(dev_project_id, "关联开发项目")?;
    let note = match note {
        None => String::new(),
        Some(value) => validate_text(&value, "备注", MAX_NOTE_CHARS, true)?,
    };
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = match id {
        None => {
            let summary = crate::project_hub::service::create_project_root(
                db,
                crate::project_hub::service::CreateProjectRootInput {
                    name,
                    kind,
                    description: String::new(),
                    goal: String::new(),
                    target_date: None,
                    root_path: Some(root_path),
                    dev_project_id,
                    note: Some(note),
                    template_id: None,
                    plan_name: None,
                    plan_description: None,
                    plan_status: None,
                    plan_sort_order: None,
                },
            )?;
            summary.id
        }
        Some(id) => {
            db.with_transaction(|conn| {
                // 本机工作空间编辑器（单一本地人类）：名称/类型是同一入口的编辑字段，
                // 不是并发补丁通道；按领域内部接口写入，revision 照常 +1。
                crate::project_hub::service::apply_project_root_fields_tx(
                    conn,
                    &id,
                    crate::project_hub::service::ProjectRootPatch {
                        name: Some(name),
                        kind: Some(kind),
                        ..Default::default()
                    },
                    None,
                )?;
                conn.execute(
                    "UPDATE workspace_projects
                     SET root_path = ?1, dev_project_id = ?2, note = ?3, updated_at = ?4
                     WHERE id = ?5",
                    params![root_path, dev_project_id, note, now_iso(), id],
                )?;
                // 旧数据修复：编辑即收敛，保证项目始终有合法 active 计划。
                crate::project_hub::service::ensure_project_plan_tx(conn, &id)?;
                Ok(())
            })?;
            id
        }
    };
    db.with_read(|conn| read_project(conn, &saved_id))
}

pub fn workspace_project_get_impl(db: &Db, id: &str) -> AppResult<WorkspaceProject> {
    db.with_read(|conn| read_project(conn, id))
}

pub fn workspace_project_progress_impl(db: &Db, project_id: &str) -> AppResult<WorkspaceProjectProgress> {
    db.with_read(|conn| {
        ensure_project_exists(conn, project_id)?;
        // 单条 SQL 给出一致快照，任务计数与事项计数分开，避免关联任务被重复计入同一百分比。
        conn.query_row(
            "SELECT COUNT(*),
                COALESCE(SUM(status = 'todo'), 0), COALESCE(SUM(status = 'doing'), 0),
                COALESCE(SUM(status = 'blocked'), 0), COALESCE(SUM(status = 'done'), 0),
                COALESCE(SUM(status = 'archived'), 0),
                (SELECT COUNT(*) FROM workspace_task_links l JOIN tasks t ON t.id = l.task_id WHERE l.project_id = ?1),
                (SELECT COUNT(*) FROM workspace_task_links l JOIN tasks t ON t.id = l.task_id
                 WHERE l.project_id = ?1 AND t.status = 'completed')
             FROM workspace_items WHERE project_id = ?1",
            params![project_id],
            |row| {
                let total: i64 = row.get(0)?;
                let done: i64 = row.get(4)?;
                let archived: i64 = row.get(5)?;
                let task_total: i64 = row.get(6)?;
                let task_completed: i64 = row.get(7)?;
                Ok(WorkspaceProjectProgress {
                    project_id: project_id.to_string(), items_total: total,
                    items_todo: row.get(1)?, items_doing: row.get(2)?, items_blocked: row.get(3)?,
                    items_done: done, items_archived: archived,
                    items_percent: (total > archived).then(|| done * 100 / (total - archived)),
                    linked_tasks_total: task_total, linked_tasks_completed: task_completed,
                    linked_tasks_percent: (task_total > 0).then(|| task_completed * 100 / task_total),
                })
            },
        ).map_err(AppError::from)
    })
}

/// 归档/恢复项目：只改项目生命周期状态，不删除项目、事项、任务关联或外部文件，
/// 也不改写计划执行状态（两个轴互不覆盖）。
pub fn workspace_project_set_status_impl(
    db: &Db,
    id: &str,
    status: String,
) -> AppResult<WorkspaceProject> {
    let status = validate_enum(&status, "项目状态", PROJECT_STATUSES)?;
    crate::project_hub::service::set_project_status(db, id, &status)?;
    workspace_project_get_impl(db, id)
}

/// 删除项目：统一走 `ProjectService::delete_project`。
/// 级联删除项目根下的计划容器、项目域数据与工作空间登记；任务、知识库、Skill、
/// MCP 与共享能力只解除关联，不删除本体；外部目录与开发项目登记不受影响。
pub fn workspace_project_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    crate::project_hub::service::delete_project(db, id)?;
    Ok(())
}

/// 显式设置活跃项目（空 = 清除）；只接受已存在项目。
pub fn workspace_set_active_project_impl(db: &Db, project_id: Option<String>) -> AppResult<String> {
    let project_id = project_id.unwrap_or_default().trim().to_string();
    db.with_conn(|conn| {
        set_active_project(conn, &project_id)?;
        Ok(())
    })?;
    Ok(project_id)
}

// ── 实例状态 ────────────────────────────────────────────────────────

pub fn workspace_instance_get_impl(db: &Db, project_id: &str) -> AppResult<WorkspaceInstance> {
    db.with_read(|conn| {
        ensure_project_exists(conn, project_id)?;
        let instance = conn
            .query_row(
                "SELECT project_id, active_module, layout_json, last_opened_at
                 FROM workspace_instances WHERE project_id = ?1",
                params![project_id],
                |row| {
                    let raw_layout: String = row.get("layout_json")?;
                    let layout_json = match serde_json::from_str::<serde_json::Value>(&raw_layout)
                    {
                        Ok(value) if value.is_object() => raw_layout,
                        _ => "{}".to_string(),
                    };
                    Ok(WorkspaceInstance {
                        project_id: row.get("project_id")?,
                        active_module: row.get("active_module")?,
                        layout_json,
                        last_opened_at: row.get("last_opened_at")?,
                    })
                },
            )
            .optional()?;
        Ok(instance.unwrap_or_else(|| WorkspaceInstance {
            project_id: project_id.to_string(),
            active_module: "overview".to_string(),
            layout_json: "{}".to_string(),
            last_opened_at: None,
        }))
    })
}

/// 保存实例状态（upsert）：**只更新该项目自己的模块与布局**。
///
/// 不写 `workspace_active_project`：活跃项目属于「用户的项目选择」，
/// 由 `workspace_set_active_project` / 打开项目这些显式意图维护。旧实现在这里
/// 顺手写活跃键，导致「切到 B 之后，A 的延迟模块保存把活跃项目改回 A」。
pub fn workspace_instance_save_impl(
    db: &Db,
    project_id: &str,
    active_module: String,
    layout_json: Option<String>,
) -> AppResult<WorkspaceInstance> {
    let active_module = {
        let module = validate_text(&active_module, "活动模块", MAX_MODULE_CHARS, false)?;
        module
    };
    // 省略布局表示只切换模块；显式传 {} 才清空布局。
    let layout_json = layout_json
        .map(|value| normalize_json_object(Some(value), "布局", MAX_LAYOUT_BYTES))
        .transpose()?;
    let now = now_iso();
    db.with_conn(|conn| {
        ensure_project_exists(conn, project_id)?;
        conn.execute(
            "INSERT INTO workspace_instances (project_id, active_module, layout_json, last_opened_at)
             VALUES (?1, ?2, COALESCE(?3, '{}'), ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               active_module = excluded.active_module,
               layout_json = COALESCE(?3, workspace_instances.layout_json),
               last_opened_at = excluded.last_opened_at",
            params![project_id, active_module, layout_json, now],
        )?;
        Ok(())
    })?;
    workspace_instance_get_impl(db, project_id)
}

// ── 通用事项 ────────────────────────────────────────────────────────

pub fn workspace_item_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<WorkspaceItem>> {
    db.with_read(|conn| {
        ensure_project_exists(conn, project_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, parent_id, title, stage, status, sort_order,
                    metadata_json, created_at, updated_at
             FROM workspace_items
             WHERE project_id = ?1
             ORDER BY sort_order, created_at, id",
        )?;
        let rows = stmt.query_map(params![project_id], row_to_item)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

/// 父事项校验：必须同项目，且沿 parent 链上溯不得回到自身（防环）。
fn validate_parent(
    conn: &Connection,
    project_id: &str,
    item_id: Option<&str>,
    parent_id: Option<&str>,
) -> AppResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if item_id == Some(parent_id) {
        return Err(AppError::Validation("事项不能以自身为父级".into()));
    }
    let mut cursor = Some(parent_id.to_string());
    // 防御性上限：数据被外部改坏形成环时也不能无限循环。
    for _ in 0..128 {
        let Some(current) = cursor else {
            return Ok(());
        };
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT project_id, parent_id FROM workspace_items WHERE id = ?1",
                params![current],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((parent_project, next)) = row else {
            return Err(AppError::Validation("父级事项不存在".into()));
        };
        if parent_project != project_id {
            return Err(AppError::Validation("父级事项不属于当前项目".into()));
        }
        if item_id == Some(current.as_str()) {
            return Err(AppError::Validation("事项层级不能形成循环".into()));
        }
        cursor = next;
    }
    Err(AppError::Validation("事项层级过深或存在循环".into()))
}

/// 保存事项：id 为空 = 新建；更新时项目不可变（防止跨项目搬移绕过校验）。
pub fn workspace_item_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    parent_id: Option<String>,
    title: String,
    stage: Option<String>,
    status: Option<String>,
    sort_order: Option<i64>,
    metadata_json: Option<String>,
) -> AppResult<WorkspaceItem> {
    let title = validate_text(&title, "事项标题", MAX_ITEM_TITLE_CHARS, false)?;
    let stage = match stage {
        None => String::new(),
        Some(value) => validate_text(&value, "阶段", MAX_STAGE_CHARS, true)?,
    };
    let status = match status {
        None => "todo".to_string(),
        Some(value) => validate_enum(&value, "事项状态", ITEM_STATUSES)?,
    };
    let sort_order = sort_order.unwrap_or(0);
    if !(-1_000_000..=1_000_000).contains(&sort_order) {
        return Err(AppError::Validation("排序值超出范围".into()));
    }
    let metadata_json = normalize_json_object(metadata_json, "事项元数据", MAX_METADATA_BYTES)?;
    let parent_id = normalize_optional_id(parent_id, "父级事项")?;
    let project_id = project_id.trim().to_string();
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_project_exists(conn, &project_id)?;
        match id {
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                validate_parent(conn, &project_id, Some(&id), parent_id.as_deref())?;
                let now = now_iso();
                conn.execute(
                    "INSERT INTO workspace_items
                     (id, project_id, parent_id, title, stage, status, sort_order,
                      metadata_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![
                        id,
                        project_id,
                        parent_id,
                        title,
                        stage,
                        status,
                        sort_order,
                        metadata_json,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing_project: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM workspace_items WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(existing_project) = existing_project else {
                    return Err(AppError::NotFound(format!("事项不存在: {id}")));
                };
                if existing_project != project_id {
                    return Err(AppError::Validation("事项所属项目不可变更".into()));
                }
                validate_parent(conn, &project_id, Some(&id), parent_id.as_deref())?;
                let now = now_iso();
                conn.execute(
                    "UPDATE workspace_items
                     SET parent_id = ?1, title = ?2, stage = ?3, status = ?4,
                         sort_order = ?5, metadata_json = ?6, updated_at = ?7
                     WHERE id = ?8",
                    params![
                        parent_id,
                        title,
                        stage,
                        status,
                        sort_order,
                        metadata_json,
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
            "SELECT id, project_id, parent_id, title, stage, status, sort_order,
                    metadata_json, created_at, updated_at
             FROM workspace_items WHERE id = ?1",
            params![saved_id],
            row_to_item,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("事项不存在: {saved_id}")))
    })
}

/// 删除事项：级联删除其子事项；任务与外部文件不受影响。
pub fn workspace_item_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    let deleted = db.with_conn(|conn| {
        let deleted = conn.execute("DELETE FROM workspace_items WHERE id = ?1", params![id])?;
        Ok::<usize, AppError>(deleted)
    })?;
    if deleted == 0 {
        return Err(AppError::NotFound(format!("事项不存在: {id}")));
    }
    Ok(())
}

// ── 任务关联 ────────────────────────────────────────────────────────

pub fn workspace_task_link_list_impl(
    db: &Db,
    project_id: &str,
) -> AppResult<Vec<WorkspaceTaskLink>> {
    db.with_read(|conn| {
        ensure_project_exists(conn, project_id)?;
        let mut stmt = conn.prepare(
            "SELECT l.project_id, l.task_id, l.created_at,
                    t.title, t.status, t.priority, t.due_at
             FROM workspace_task_links l
             JOIN tasks t ON t.id = l.task_id
             WHERE l.project_id = ?1
             ORDER BY l.created_at, t.id",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(WorkspaceTaskLink {
                project_id: row.get("project_id")?,
                task_id: row.get("task_id")?,
                title: row.get("title")?,
                status: row.get("status")?,
                priority: row.get("priority")?,
                due_at: row.get("due_at")?,
                created_at: row.get("created_at")?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

/// 关联现有任务：只存关联，不复制任务内容；重复关联幂等。
pub fn workspace_task_link_add_impl(
    db: &Db,
    project_id: &str,
    task_id: &str,
) -> AppResult<()> {
    db.with_conn(|conn| workspace_task_link_add_tx(conn, project_id, task_id))
}

/// 连接级关联（v82）：供文件导入在**带守卫的写事务**内复用。
///
/// 与 [`workspace_task_link_add_impl`] 语义一致，唯一区别是复用调用方提供的连接，
/// 让「建任务 + 关联项目」与「导入租约校验」落在同一个事务边界内：
/// 不会出现「任务已建、关联失败」导致重试时重复建任务。
pub fn workspace_task_link_add_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    task_id: &str,
) -> AppResult<()> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err(AppError::Validation("任务 ID 不能为空".into()));
    }
    let now = now_iso();
    ensure_project_exists(conn, project_id)?;
    let task_exists = conn
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1",
            params![task_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !task_exists {
        return Err(AppError::NotFound(format!("任务不存在: {task_id}")));
    }
    conn.execute(
        "INSERT OR IGNORE INTO workspace_task_links (project_id, task_id, created_at)
         VALUES (?1, ?2, ?3)",
        params![project_id, task_id, now],
    )?;
    Ok(())
}

pub fn workspace_task_unlink_impl(
    db: &Db,
    project_id: &str,
    task_id: &str,
) -> AppResult<()> {
    let deleted = db.with_conn(|conn| {
        ensure_project_exists(conn, project_id)?;
        let deleted = conn.execute(
            "DELETE FROM workspace_task_links WHERE project_id = ?1 AND task_id = ?2",
            params![project_id, task_id],
        )?;
        Ok::<usize, AppError>(deleted)
    })?;
    if deleted == 0 {
        return Err(AppError::NotFound("任务关联不存在".into()));
    }
    Ok(())
}

// ── 小说卷/章（B1，v58）─────────────────────────────────────────────
//
// 设计边界：卷 → 章两级；正文是纯文本，按章存储；不复制任务系统，不建第二套
// 项目容器。章节的 volume_id 允许为空（未分卷草稿），卷/章都必须属于同一项目；
// 删除卷会级联删除其章节，删除项目会级联删除卷与章（由 v58 外键保证）。

const MAX_NOVEL_TITLE_CHARS: usize = 240;
/// 单章正文上限：8 MiB。纯文本按字节计，避免 `String` 复制导致的内存放大。
const MAX_CHAPTER_CONTENT_BYTES: usize = 8 * 1024 * 1024;

fn row_to_volume(row: &rusqlite::Row<'_>) -> rusqlite::Result<NovelVolume> {
    Ok(NovelVolume {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_chapter_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NovelChapterSummary> {
    Ok(NovelChapterSummary {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        volume_id: row.get("volume_id")?,
        title: row.get("title")?,
        word_count: row.get("word_count")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_volume(conn: &Connection, id: &str) -> AppResult<NovelVolume> {
    conn.query_row(
        "SELECT id, project_id, title, sort_order, created_at, updated_at
         FROM novel_volumes WHERE id = ?1",
        params![id],
        row_to_volume,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("卷不存在或已被删除".into()))
}

pub(crate) fn read_chapter_summary(conn: &Connection, id: &str) -> AppResult<NovelChapterSummary> {
    conn.query_row(
        "SELECT id, project_id, volume_id, title, word_count, sort_order, created_at, updated_at
         FROM novel_chapters WHERE id = ?1",
        params![id],
        row_to_chapter_summary,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("章节不存在或已被删除".into()))
}

pub(crate) fn read_chapter(conn: &Connection, id: &str) -> AppResult<NovelChapter> {
    conn.query_row(
        "SELECT id, project_id, volume_id, title, content, word_count, sort_order,
                created_at, updated_at
         FROM novel_chapters WHERE id = ?1",
        params![id],
        |row| {
            let summary = row_to_chapter_summary(row)?;
            Ok(NovelChapter {
                summary,
                content: row.get("content")?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("章节不存在或已被删除".into()))
}

/// 卷必须存在且属于同一项目；None 表示未分卷，直接通过。
fn ensure_volume_belongs(
    conn: &Connection,
    project_id: &str,
    volume_id: Option<&str>,
) -> AppResult<()> {
    let Some(volume_id) = volume_id else {
        return Ok(());
    };
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, project_id FROM novel_volumes WHERE id = ?1",
            params![volume_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((_, owner)) = row else {
        return Err(AppError::Validation("所属卷不存在".into()));
    };
    if owner != project_id {
        return Err(AppError::Validation("所属卷不属于当前项目".into()));
    }
    Ok(())
}

fn validate_sort_order(value: i64) -> AppResult<i64> {
    if !(-1_000_000..=1_000_000).contains(&value) {
        return Err(AppError::Validation("排序值超出范围".into()));
    }
    Ok(value)
}

fn next_volume_sort(conn: &Connection, project_id: &str) -> AppResult<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM novel_volumes WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(max.saturating_add(1))
}

fn next_chapter_sort(
    conn: &Connection,
    project_id: &str,
    volume_id: Option<&str>,
) -> AppResult<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM novel_chapters
         WHERE project_id = ?1 AND volume_id IS ?2",
        params![project_id, volume_id],
        |row| row.get(0),
    )?;
    Ok(max.saturating_add(1))
}

/// 正文只做大小与控制字符校验，**不去首尾空白**：缩进与空行属于作者内容。
fn validate_chapter_body(raw: &str) -> AppResult<String> {
    if raw.len() > MAX_CHAPTER_CONTENT_BYTES {
        return Err(AppError::Validation(format!(
            "正文超过 {} MiB 上限",
            MAX_CHAPTER_CONTENT_BYTES / (1024 * 1024)
        )));
    }
    if raw.contains('\0') {
        return Err(AppError::Validation("正文含非法控制字符".into()));
    }
    Ok(raw.to_string())
}

/// 字数：非空白字符数（中文按字、英文按字符），与编辑器展示口径一致。
fn count_chapter_words(raw: &str) -> i64 {
    raw.chars().filter(|c| !c.is_whitespace()).count() as i64
}

pub fn novel_volume_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<NovelVolume>> {
    db.with_read(|conn| {
        ensure_novel_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, sort_order, created_at, updated_at
             FROM novel_volumes WHERE project_id = ?1
             ORDER BY sort_order, created_at, id",
        )?;
        let rows = stmt.query_map(params![project_id], row_to_volume)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn novel_volume_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    title: String,
    sort_order: Option<i64>,
) -> AppResult<NovelVolume> {
    let title = validate_text(&title, "卷标题", MAX_NOVEL_TITLE_CHARS, false)?;
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_novel_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_volume_sort(conn, &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO novel_volumes
                     (id, project_id, title, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![id, project_id, title, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM novel_volumes WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("卷不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("卷不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                conn.execute(
                    "UPDATE novel_volumes
                     SET title = ?2, sort_order = ?3, updated_at = ?4
                     WHERE id = ?1 AND project_id = ?5",
                    params![id, title, order, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_volume(conn, &saved_id))
}

pub fn novel_volume_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let owner: Option<String> = conn
            .query_row(
                "SELECT project_id FROM novel_volumes WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(owner) = owner else {
            return Err(AppError::NotFound("卷不存在或已被删除".into()));
        };
        ensure_novel_project(conn, &owner, true)?;
        // 章节由 v58 外键 ON DELETE CASCADE 一并删除。
        conn.execute("DELETE FROM novel_volumes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// 章节列表的防御性上限：Agent 入口另有 50/200 的分页窗口，这里只是避免
/// 桌面端在异常数据下一次性装载无限行（正常项目远低于该值）。
const MAX_NOVEL_CHAPTER_ROWS: i64 = 5000;

pub fn novel_chapter_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<NovelChapterSummary>> {
    db.with_read(|conn| {
        let (rows, _total) = novel_chapter_list_page_in_conn(
            conn,
            project_id,
            MAX_NOVEL_CHAPTER_ROWS as u32,
            0,
        )?;
        Ok(rows)
    })
}

/// 章节分页读取（Agent 领域入口共用；调用方持有读连接，禁止再开 `db.with_read`）。
///
/// 返回 `(当前页, 真实总数)`；列表项仍不含正文。
pub(crate) fn novel_chapter_list_page_in_conn(
    conn: &Connection,
    project_id: &str,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<NovelChapterSummary>, u32)> {
    ensure_novel_project(conn, project_id, false)?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM novel_chapters WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, project_id, volume_id, title, word_count, sort_order,
                created_at, updated_at
         FROM novel_chapters WHERE project_id = ?1
         ORDER BY sort_order, created_at, id
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(
        params![project_id, limit as i64, offset as i64],
        row_to_chapter_summary,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(AppError::from)?);
    }
    Ok((out, total.max(0) as u32))
}

pub fn novel_chapter_get_impl(db: &Db, id: &str) -> AppResult<NovelChapter> {
    db.with_read(|conn| {
        let project_id = chapter_project_id(conn, id)?;
        ensure_novel_project(conn, &project_id, false)?;
        read_chapter(conn, id)
    })
}

/// 保存章节元信息（新建/改名/移动到卷/调整顺序），正文保持不变。
pub fn novel_chapter_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    volume_id: Option<String>,
    title: String,
    sort_order: Option<i64>,
) -> AppResult<NovelChapterSummary> {
    let title = validate_text(&title, "章节标题", MAX_NOVEL_TITLE_CHARS, false)?;
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let volume_id = normalize_optional_id(volume_id, "所属卷")?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_novel_project(conn, &project_id, true)?;
        ensure_volume_belongs(conn, &project_id, volume_id.as_deref())?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_chapter_sort(conn, &project_id, volume_id.as_deref())?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO novel_chapters
                     (id, project_id, volume_id, title, content, word_count, sort_order,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, '', 0, ?5, ?6, ?6)",
                    params![id, project_id, volume_id, title, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64, String)> = conn
                    .query_row(
                        "SELECT project_id, sort_order, updated_at FROM novel_chapters WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((owner, current_order, previous_at)) = existing else {
                    return Err(AppError::NotFound("章节不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("章节不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                conn.execute(
                    "UPDATE novel_chapters
                     SET volume_id = ?2, title = ?3, sort_order = ?4, updated_at = ?5
                     WHERE id = ?1 AND project_id = ?6",
                    params![id, volume_id, title, order, now, project_id],
                )?;
                // UI 写业务行时同步推进版本，Agent 之后能读到真实变化，
                // 不会把「无计数器基线」误当成 revision 0。
                crate::agent_access::domains::revision::note_ui_write(
                    conn,
                    "novel.chapter",
                    &id,
                    &previous_at,
                    &now,
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_chapter_summary(conn, &saved_id))
}

/// 正文自动保存：只更新 content / word_count / updated_at。
pub fn novel_chapter_save_content_impl(
    db: &Db,
    id: &str,
    content: String,
) -> AppResult<NovelChapterSummary> {
    db.with_transaction(|conn| {
        let previous_at: String = conn.query_row(
            "SELECT updated_at FROM novel_chapters WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let (_project_id, saved_at) =
            novel_chapter_save_content_in_conn(conn, id, content)?;
        // UI 自动保存正文同样推进版本；Agent 领域核心走 `_in_conn`，不会重复推进。
        crate::agent_access::domains::revision::note_ui_write(
            conn,
            "novel.chapter",
            id,
            &previous_at,
            &saved_at,
        )?;
        Ok(())
    })?;
    db.with_read(|conn| read_chapter_summary(conn, id))
}

/// 正文写入的事务内实现（Agent 领域层复用）：调用方必须已处于事务中，
/// 这样领域层的版本校验、业务写入与 revision 推进才能原子提交。
///
/// 返回 `(project_id, saved_at)`：`saved_at` 是本次写入的 `updated_at`，供 revision 使用。
pub(crate) fn novel_chapter_save_content_in_conn(
    conn: &rusqlite::Connection,
    id: &str,
    content: String,
) -> AppResult<(String, String)> {
    let content = validate_chapter_body(&content)?;
    let word_count = count_chapter_words(&content);
    let project_id = chapter_project_id(conn, id)?;
    ensure_novel_project(conn, &project_id, true)?;
    let saved_at = now_iso();
    conn.execute(
        "UPDATE novel_chapters
         SET content = ?2, word_count = ?3, updated_at = ?4
         WHERE id = ?1",
        params![id, content, word_count, saved_at],
    )?;
    Ok((project_id, saved_at))
}

/// 读取章节当前的业务更新时间（领域层做版本快照与归属校验用）。
pub(crate) fn novel_chapter_updated_at(
    conn: &rusqlite::Connection,
    id: &str,
) -> AppResult<String> {
    conn.query_row(
        "SELECT updated_at FROM novel_chapters WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("章节不存在或已被删除".into()))
}

pub fn novel_chapter_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = chapter_project_id(conn, id)?;
        ensure_novel_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM novel_chapters WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── Tauri 命令 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn workspace_project_list(
    db: State<'_, Arc<Db>>,
    status: Option<String>,
) -> AppResult<WorkspaceProjectList> {
    Ok(WorkspaceProjectList {
        projects: workspace_project_list_impl(&db, status)?,
    })
}

#[tauri::command]
pub fn workspace_project_get(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<WorkspaceProjectSaved> {
    Ok(WorkspaceProjectSaved {
        project: workspace_project_get_impl(&db, &id)?,
    })
}

#[tauri::command]
pub fn workspace_project_progress(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<WorkspaceProjectProgress> {
    workspace_project_progress_impl(&db, &project_id)
}

#[tauri::command]
pub fn workspace_project_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    name: String,
    kind: String,
    root_path: Option<String>,
    dev_project_id: Option<String>,
    note: Option<String>,
) -> AppResult<WorkspaceProjectSaved> {
    Ok(WorkspaceProjectSaved {
        project: workspace_project_save_impl(&db, id, name, kind, root_path, dev_project_id, note)?,
    })
}

#[tauri::command]
pub fn workspace_project_set_status(
    db: State<'_, Arc<Db>>,
    id: String,
    status: String,
) -> AppResult<WorkspaceProjectSaved> {
    Ok(WorkspaceProjectSaved {
        project: workspace_project_set_status_impl(&db, &id, status)?,
    })
}

#[tauri::command]
pub fn workspace_project_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkspaceOk> {
    workspace_project_delete_impl(&db, &id)?;
    Ok(WorkspaceOk { ok: true })
}

#[tauri::command]
pub fn workspace_set_active_project(
    db: State<'_, Arc<Db>>,
    project_id: Option<String>,
) -> AppResult<WorkspaceActiveProject> {
    Ok(WorkspaceActiveProject {
        project_id: workspace_set_active_project_impl(&db, project_id)?,
    })
}

#[tauri::command]
pub fn workspace_instance_get(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<WorkspaceInstanceGot> {
    Ok(WorkspaceInstanceGot {
        instance: workspace_instance_get_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn workspace_instance_save(
    db: State<'_, Arc<Db>>,
    project_id: String,
    active_module: String,
    layout_json: Option<String>,
) -> AppResult<WorkspaceInstanceGot> {
    Ok(WorkspaceInstanceGot {
        instance: workspace_instance_save_impl(&db, &project_id, active_module, layout_json)?,
    })
}

#[tauri::command]
pub fn workspace_item_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<WorkspaceItemList> {
    Ok(WorkspaceItemList {
        items: workspace_item_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn workspace_item_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    parent_id: Option<String>,
    title: String,
    stage: Option<String>,
    status: Option<String>,
    sort_order: Option<i64>,
    metadata_json: Option<String>,
) -> AppResult<WorkspaceItemSaved> {
    Ok(WorkspaceItemSaved {
        item: workspace_item_save_impl(
            &db,
            id,
            project_id,
            parent_id,
            title,
            stage,
            status,
            sort_order,
            metadata_json,
        )?,
    })
}

#[tauri::command]
pub fn workspace_item_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkspaceOk> {
    workspace_item_delete_impl(&db, &id)?;
    Ok(WorkspaceOk { ok: true })
}

#[tauri::command]
pub fn workspace_task_link_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<WorkspaceTaskLinkList> {
    Ok(WorkspaceTaskLinkList {
        links: workspace_task_link_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn workspace_task_link_add(
    db: State<'_, Arc<Db>>,
    project_id: String,
    task_id: String,
) -> AppResult<WorkspaceOk> {
    workspace_task_link_add_impl(&db, &project_id, &task_id)?;
    Ok(WorkspaceOk { ok: true })
}

#[tauri::command]
pub fn workspace_task_unlink(
    db: State<'_, Arc<Db>>,
    project_id: String,
    task_id: String,
) -> AppResult<WorkspaceOk> {
    workspace_task_unlink_impl(&db, &project_id, &task_id)?;
    Ok(WorkspaceOk { ok: true })
}

// ── 小说卷/章命令（B1，v58）────────────────────────────────────────

#[tauri::command]
pub fn novel_volume_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<NovelVolumeList> {
    Ok(NovelVolumeList {
        volumes: novel_volume_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn novel_volume_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    title: String,
    sort_order: Option<i64>,
) -> AppResult<NovelVolumeSaved> {
    Ok(NovelVolumeSaved {
        volume: novel_volume_save_impl(&db, id, project_id, title, sort_order)?,
    })
}

#[tauri::command]
pub fn novel_volume_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkspaceOk> {
    novel_volume_delete_impl(&db, &id)?;
    Ok(WorkspaceOk { ok: true })
}

#[tauri::command]
pub fn novel_chapter_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<NovelChapterList> {
    Ok(NovelChapterList {
        chapters: novel_chapter_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn novel_chapter_get(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<NovelChapterGot> {
    Ok(NovelChapterGot {
        chapter: novel_chapter_get_impl(&db, &id)?,
    })
}

#[tauri::command]
pub fn novel_chapter_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    volume_id: Option<String>,
    title: String,
    sort_order: Option<i64>,
) -> AppResult<NovelChapterSaved> {
    Ok(NovelChapterSaved {
        chapter: novel_chapter_save_impl(
            &db,
            id,
            project_id,
            volume_id,
            title,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn novel_chapter_save_content(
    db: State<'_, Arc<Db>>,
    id: String,
    content: String,
) -> AppResult<NovelChapterSaved> {
    Ok(NovelChapterSaved {
        chapter: novel_chapter_save_content_impl(&db, &id, content)?,
    })
}

#[tauri::command]
pub fn novel_chapter_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkspaceOk> {
    novel_chapter_delete_impl(&db, &id)?;
    Ok(WorkspaceOk { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-project-workspace-{}-{}",
            name,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn create_project(db: &Db, name: &str, kind: &str) -> WorkspaceProject {
        workspace_project_save_impl(
            db,
            None,
            name.to_string(),
            kind.to_string(),
            None,
            None,
            None,
        )
        .expect("创建项目")
    }

    #[test]
    fn backend_round2_progress_is_project_scoped_and_has_no_fake_empty_percent() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "progress", "general");
        let other = create_project(&db, "other", "game");
        let empty = workspace_project_progress_impl(&db, &project.id).unwrap();
        assert_eq!(empty.items_percent, None);
        assert_eq!(empty.linked_tasks_percent, None);
        for status in ITEM_STATUSES {
            workspace_item_save_impl(&db, None, project.id.clone(), None, status.to_string(),
                None, Some(status.to_string()), None, None).unwrap();
        }
        workspace_item_save_impl(&db, None, other.id, None, "unrelated".into(),
            None, Some("done".into()), None, None).unwrap();
        db.with_conn(|conn| {
            conn.execute("INSERT INTO tasks (id,title,status,created_at,updated_at)
                VALUES ('progress-done','done','completed','now','now'),
                       ('progress-open','open','pending','now','now')", [])?;
            Ok(())
        }).unwrap();
        workspace_task_link_add_impl(&db, &project.id, "progress-done").unwrap();
        workspace_task_link_add_impl(&db, &project.id, "progress-open").unwrap();
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        let progress = workspace_project_progress_impl(&db, &project.id).unwrap();
        assert_eq!(progress.items_total, 5);
        assert_eq!((progress.items_todo, progress.items_doing, progress.items_blocked, progress.items_done, progress.items_archived), (1,1,1,1,1));
        assert_eq!(progress.items_percent, Some(25));
        assert_eq!((progress.linked_tasks_total, progress.linked_tasks_completed, progress.linked_tasks_percent), (2,1,Some(50)));
        assert!(workspace_project_progress_impl(&db, "missing").is_err());
    }

    #[test]
    fn project_crud_keeps_external_paths_and_clears_active_on_delete() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("crud");
        let root = dir.to_string_lossy().to_string();

        let project = workspace_project_save_impl(
            &db,
            None,
            "  我的项目  ".into(),
            "development".into(),
            Some(root.clone()),
            None,
            Some("  备注  ".into()),
        )
        .unwrap();
        assert_eq!(project.name, "我的项目");
        assert_eq!(project.root_path, root);
        assert!(project.root_exists);
        assert_eq!(project.status, "active");
        assert_eq!(project.item_count, 0);

        let updated = workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "改名".into(),
            "game".into(),
            Some(root.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(updated.name, "改名");
        assert_eq!(updated.kind, "game");
        assert_eq!(updated.id, project.id);

        workspace_set_active_project_impl(&db, Some(project.id.clone())).unwrap();
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        let active = workspace_project_list_impl(&db, Some("active".into())).unwrap();
        assert!(active.is_empty());
        let archived = workspace_project_list_impl(&db, Some("archived".into())).unwrap();
        assert_eq!(archived.len(), 1);

        workspace_project_delete_impl(&db, &project.id).unwrap();
        assert!(dir.is_dir(), "删除工作空间不得删除外部目录");
        let value = db.get_setting("workspace_active_project").unwrap();
        assert!(value.is_none(), "删除活跃项目后必须清除活跃键");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn active_project_rejects_unknown_id_and_preserves_previous() {
        let db = Db::open_in_memory().unwrap();
        let a = create_project(&db, "A", "general");
        workspace_set_active_project_impl(&db, Some(a.id.clone())).unwrap();

        // 不存在（或已删除）的项目不能写成活跃项目，也不能把旧值清掉。
        assert!(workspace_set_active_project_impl(&db, Some("ws-missing".into())).is_err());
        let active = db
            .get_setting("workspace_active_project")
            .unwrap()
            .and_then(|v| v.as_str().map(str::to_string));
        assert_eq!(active, Some(a.id.clone()));

        // 空值 = 用户显式清除。
        workspace_set_active_project_impl(&db, None).unwrap();
        assert!(db.get_setting("workspace_active_project").unwrap().is_none());
    }

    #[test]
    fn project_validation_rejects_relative_path_and_bad_enum() {
        let db = Db::open_in_memory().unwrap();
        let relative = workspace_project_save_impl(
            &db,
            None,
            "相对".into(),
            "general".into(),
            Some("relative/path".into()),
            None,
            None,
        );
        assert!(relative.is_err());
        let bad_kind = workspace_project_save_impl(
            &db,
            None,
            "类型".into(),
            "music".into(),
            None,
            None,
            None,
        );
        assert!(bad_kind.is_err());
        let blank_name = workspace_project_save_impl(
            &db,
            None,
            "   ".into(),
            "general".into(),
            None,
            None,
            None,
        );
        assert!(blank_name.is_err());
        // 空路径合法：项目可先创建，稍后再登记目录
        assert!(
            workspace_project_save_impl(
                &db,
                None,
                "无路径".into(),
                "general".into(),
                None,
                None,
                None
            )
            .is_ok()
        );
    }

    #[test]
    fn instance_defaults_and_upsert_does_not_touch_active_project() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "实例", "general");
        let default = workspace_instance_get_impl(&db, &project.id).unwrap();
        assert_eq!(default.active_module, "overview");
        assert_eq!(default.layout_json, "{}");
        assert!(default.last_opened_at.is_none());

        let saved = workspace_instance_save_impl(
            &db,
            &project.id,
            "items".into(),
            Some(r#"{"left":300}"#.into()),
        )
        .unwrap();
        assert_eq!(saved.active_module, "items");
        assert_eq!(saved.layout_json, r#"{"left":300}"#);
        assert!(saved.last_opened_at.is_some());

        // 模块保存是「该项目自己的状态」，不得隐式改写全局活跃项目。
        assert!(db.get_setting("workspace_active_project").unwrap().is_none());
        assert!(workspace_instance_save_impl(&db, &project.id, "items".into(), Some("[]".into())).is_err());
    }

    #[test]
    fn backend_continuation_module_only_save_preserves_layout() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "布局", "general");
        workspace_instance_save_impl(
            &db, &project.id, "overview".into(), Some(r#"{"left":300}"#.into()),
        ).unwrap();
        let saved = workspace_instance_save_impl(&db, &project.id, "items".into(), None).unwrap();
        assert_eq!(saved.active_module, "items");
        assert_eq!(saved.layout_json, r#"{"left":300}"#);
        let cleared = workspace_instance_save_impl(
            &db, &project.id, "items".into(), Some("{}".into()),
        ).unwrap();
        assert_eq!(cleared.layout_json, "{}");
    }

    #[test]
    fn backend_continuation_project_delete_rolls_back_on_setting_failure() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "原子删除", "general");
        workspace_set_active_project_impl(&db, Some(project.id.clone())).unwrap();
        db.with_conn(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_active_delete BEFORE DELETE ON application_settings
                WHEN OLD.key = 'workspace_active_project'
                BEGIN SELECT RAISE(ABORT, 'injected failure'); END;")?;
            Ok(())
        }).unwrap();
        assert!(workspace_project_delete_impl(&db, &project.id).is_err());
        assert!(workspace_project_get_impl(&db, &project.id).is_ok());
    }

    /// 活跃项目由显式选择决定：A 的延迟模块保存不能覆盖用户后来选的 B。
    #[test]
    fn instance_save_never_overwrites_later_active_selection() {
        let db = Db::open_in_memory().unwrap();
        let a = create_project(&db, "A", "general");
        let b = create_project(&db, "B", "general");

        workspace_set_active_project_impl(&db, Some(b.id.clone())).unwrap();
        // A 的模块保存（例如切换项目前发出的请求，晚到）
        workspace_instance_save_impl(&db, &a.id, "items".into(), Some("{}".into())).unwrap();
        let active = db
            .get_setting("workspace_active_project")
            .unwrap()
            .and_then(|v| v.as_str().map(str::to_string));
        assert_eq!(active, Some(b.id.clone()));

        // 显式恢复到 A 之后再读，仍以显式选择为准。
        workspace_set_active_project_impl(&db, Some(a.id.clone())).unwrap();
        let active = db
            .get_setting("workspace_active_project")
            .unwrap()
            .and_then(|v| v.as_str().map(str::to_string));
        assert_eq!(active, Some(a.id));
    }

    #[test]
    fn items_support_parent_cycle_guard_and_cascade_delete() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "事项", "ai_comic");
        let other = create_project(&db, "其他", "general");

        let root = workspace_item_save_impl(
            &db,
            None,
            project.id.clone(),
            None,
            "第一集".into(),
            Some("storyboard".into()),
            Some("doing".into()),
            Some(1),
            None,
        )
        .unwrap();
        let child = workspace_item_save_impl(
            &db,
            None,
            project.id.clone(),
            Some(root.id.clone()),
            "镜头 1".into(),
            None,
            None,
            Some(0),
            Some(r#"{"shot":1}"#.into()),
        )
        .unwrap();
        assert_eq!(child.status, "todo");
        assert_eq!(child.parent_id.as_deref(), Some(root.id.as_str()));

        // 自身为父级
        assert!(workspace_item_save_impl(
            &db,
            Some(root.id.clone()),
            project.id.clone(),
            Some(root.id.clone()),
            "第一集".into(),
            None,
            None,
            None,
            None
        )
        .is_err());
        // 跨项目父级
        assert!(workspace_item_save_impl(
            &db,
            None,
            other.id.clone(),
            Some(root.id.clone()),
            "子项".into(),
            None,
            None,
            None,
            None
        )
        .is_err());
        // 循环：child → root，再把 root.parent 设为 child
        assert!(workspace_item_save_impl(
            &db,
            Some(root.id.clone()),
            project.id.clone(),
            Some(child.id.clone()),
            "第一集".into(),
            None,
            None,
            None,
            None
        )
        .is_err());
        // 非法状态
        assert!(workspace_item_save_impl(
            &db,
            None,
            project.id.clone(),
            None,
            "坏状态".into(),
            None,
            Some("unknown".into()),
            None,
            None
        )
        .is_err());
        // 删除父级级联删除子级
        workspace_item_delete_impl(&db, &root.id).unwrap();
        assert!(workspace_item_list_impl(&db, &project.id).unwrap().is_empty());
    }

    #[test]
    fn task_links_require_existing_task_and_are_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "关联", "development");
        assert!(workspace_task_link_add_impl(&db, &project.id, "missing").is_err());

        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', '任务一', ?1, ?1)",
                params![now],
            )?;
            Ok(())
        })
        .unwrap();

        workspace_task_link_add_impl(&db, &project.id, "t1").unwrap();
        workspace_task_link_add_impl(&db, &project.id, "t1").unwrap();
        let links = workspace_task_link_list_impl(&db, &project.id).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].title, "任务一");

        workspace_task_unlink_impl(&db, &project.id, "t1").unwrap();
        assert!(workspace_task_link_list_impl(&db, &project.id).unwrap().is_empty());
        assert!(workspace_task_unlink_impl(&db, &project.id, "t1").is_err());
    }

    /// novel（创作工作台 A 阶段）：新增的小说类型复用既有项目/实例/事项/任务关联
    /// 命令，不引入第二套 CRUD；同时锁定「非法类型仍拒绝、其他四种类型不受影响」。
    #[test]
    fn novel_project_supports_crud_status_instance_items_and_task_links() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "长篇小说", "novel");
        assert_eq!(project.kind, "novel");
        assert_eq!(project.status, "active");

        // 编辑：类型保持 novel，根目录与备注可保存（仍是同一个项目 ID）。
        let dir = temp_dir("novel");
        let root = dir.to_string_lossy().to_string();
        let updated = workspace_project_save_impl(
            &db,
            Some(project.id.clone()),
            "长篇小说（改）".into(),
            "novel".into(),
            Some(root.clone()),
            None,
            Some("科幻题材".into()),
        )
        .unwrap();
        assert_eq!(updated.id, project.id);
        assert_eq!(updated.kind, "novel");
        assert_eq!(updated.name, "长篇小说（改）");
        assert_eq!(updated.root_path, root);
        assert_eq!(updated.note, "科幻题材");

        // 设为当前工作空间项目；归档后从 active 列表消失，恢复后回来。
        workspace_set_active_project_impl(&db, Some(project.id.clone())).unwrap();
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        assert!(workspace_project_list_impl(&db, Some("active".into()))
            .unwrap()
            .is_empty());
        workspace_project_set_status_impl(&db, &project.id, "active".into()).unwrap();
        assert_eq!(
            workspace_project_list_impl(&db, Some("active".into()))
                .unwrap()
                .len(),
            1
        );

        // 窗口实例 + 写作事项：复用 workspace_instances / workspace_items。
        workspace_instance_save_impl(
            &db,
            &project.id,
            "items".into(),
            Some(
                r#"{"version":1,"moduleOrder":["items","overview"],"hiddenModules":[],"activeModule":"items"}"#
                    .into(),
            ),
        )
        .unwrap();
        let instance = workspace_instance_get_impl(&db, &project.id).unwrap();
        assert_eq!(instance.active_module, "items");

        let item = workspace_item_save_impl(
            &db,
            None,
            project.id.clone(),
            None,
            "第一章".into(),
            Some("chapter".into()),
            Some("doing".into()),
            Some(0),
            Some(r#"{"words":0}"#.into()),
        )
        .unwrap();
        assert_eq!(item.stage, "chapter");
        assert_eq!(workspace_item_list_impl(&db, &project.id).unwrap().len(), 1);

        // 任务关联：复用既有 tasks 系统，只建弱引用。
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t-novel', '写第一章', ?1, ?1)",
                params![now],
            )?;
            Ok(())
        })
        .unwrap();
        workspace_task_link_add_impl(&db, &project.id, "t-novel").unwrap();
        assert_eq!(workspace_task_link_list_impl(&db, &project.id).unwrap().len(), 1);

        // 项目列表按 novel 返回类型，并带真实计数（不是前端拼的演示数据）。
        let listed = workspace_project_list_impl(&db, None).unwrap();
        assert!(listed.iter().any(|p| p.id == project.id
            && p.kind == "novel"
            && p.item_count == 1
            && p.task_link_count == 1));

        // 非法类型仍拒绝；其他四种类型仍可正常创建。
        assert!(
            workspace_project_save_impl(&db, None, "非法".into(), "music".into(), None, None, None)
                .is_err()
        );
        for kind in ["development", "game", "ai_comic", "general"] {
            let p = create_project(&db, kind, kind);
            assert_eq!(p.kind, kind);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B1（v58）：卷 → 章两级、正文原文保存、字数统计、项目隔离与级联删除。
    #[test]
    fn novel_chapters_support_volumes_content_autosave_and_cascade() {
        let db = Db::open_in_memory().unwrap();
        let project = create_project(&db, "长篇", "novel");
        let other = create_project(&db, "另一本", "novel");

        // 卷：新建自动排在末尾；重命名/排序可保存。
        let v1 = novel_volume_save_impl(&db, None, project.id.clone(), "第一卷".into(), None).unwrap();
        assert_eq!(v1.sort_order, 0);
        let v2 = novel_volume_save_impl(&db, None, project.id.clone(), "第二卷".into(), None).unwrap();
        assert_eq!(v2.sort_order, 1);
        let renamed = novel_volume_save_impl(
            &db,
            Some(v1.id.clone()),
            project.id.clone(),
            "卷一（改）".into(),
            Some(5),
        )
        .unwrap();
        assert_eq!(renamed.title, "卷一（改）");
        assert_eq!(renamed.sort_order, 5);
        assert_eq!(novel_volume_list_impl(&db, &project.id).unwrap().len(), 2);

        // 章：可挂在卷下，也可未分卷；列表不含正文。
        let c1 = novel_chapter_save_impl(
            &db,
            None,
            project.id.clone(),
            Some(v2.id.clone()),
            "第一章".into(),
            None,
        )
        .unwrap();
        assert_eq!(c1.volume_id.as_deref(), Some(v2.id.as_str()));
        assert_eq!(c1.word_count, 0);
        let c2 = novel_chapter_save_impl(
            &db,
            None,
            project.id.clone(),
            None,
            "未分卷草稿".into(),
            None,
        )
        .unwrap();
        assert_eq!(c2.volume_id, None);
        assert_eq!(novel_chapter_list_impl(&db, &project.id).unwrap().len(), 2);

        // 正文：保留首尾空白与换行，字数按非空白字符；读取与写入一致。
        let raw = "  第一章\n开局。\n\n  结尾  ";
        let saved =
            novel_chapter_save_content_impl(&db, &c1.id, raw.to_string()).unwrap();
        assert_eq!(saved.word_count, 8); // 第一章开局。结尾 = 8 个非空白字符
        let got = novel_chapter_get_impl(&db, &c1.id).unwrap();
        assert_eq!(got.content, raw);
        assert_eq!(got.summary.word_count, 8);

        // 8 MiB 上限：超出即拒绝，且不清空既有正文。
        let too_long = "a".repeat(MAX_CHAPTER_CONTENT_BYTES + 1);
        assert!(novel_chapter_save_content_impl(&db, &c2.id, too_long).is_err());
        assert_eq!(novel_chapter_get_impl(&db, &c2.id).unwrap().content, "");

        // 元信息更新（改名 + 移到另一卷）不覆盖正文。
        let moved = novel_chapter_save_impl(
            &db,
            Some(c1.id.clone()),
            project.id.clone(),
            Some(v1.id.clone()),
            "第一章（改）".into(),
            Some(3),
        )
        .unwrap();
        assert_eq!(moved.title, "第一章（改）");
        assert_eq!(moved.volume_id.as_deref(), Some(v1.id.as_str()));
        assert_eq!(novel_chapter_get_impl(&db, &c1.id).unwrap().content, raw);

        // 跨项目引用卷必须拒绝；另一项目看不到本项目的卷/章。
        assert!(novel_chapter_save_impl(
            &db,
            None,
            other.id.clone(),
            Some(v1.id.clone()),
            "越界".into(),
            None,
        )
        .is_err());
        assert!(novel_volume_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(novel_chapter_list_impl(&db, &other.id).unwrap().is_empty());

        // 删除卷级联删除其章节；删除项目级联删除剩余卷/章，且无外键违例。
        novel_volume_delete_impl(&db, &v1.id).unwrap();
        assert!(novel_chapter_get_impl(&db, &c1.id).is_err());
        assert_eq!(novel_chapter_list_impl(&db, &project.id).unwrap().len(), 1);
        workspace_project_delete_impl(&db, &project.id).unwrap();
        assert!(novel_volume_list_impl(&db, &project.id).is_err());
        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    /// B1 第二轮：小说专用命令必须校验项目类型与状态；归档只读但可读。
    #[test]
    fn novel_commands_enforce_kind_and_archived_read_only() {
        let db = Db::open_in_memory().unwrap();
        let novel = create_project(&db, "小说", "novel");
        let v1 = novel_volume_save_impl(
            &db,
            None,
            novel.id.clone(),
            "第一卷".into(),
            None,
        )
        .unwrap();
        let c1 = novel_chapter_save_impl(
            &db,
            None,
            novel.id.clone(),
            Some(v1.id.clone()),
            "第一章".into(),
            None,
        )
        .unwrap();
        novel_chapter_save_content_impl(&db, &c1.id, "可读正文".into()).unwrap();

        // 非小说项目：读写一律拒绝（不能借小说命令读到/写入任何卷章数据）。
        for kind in ["game", "development", "general", "ai_comic"] {
            let p = create_project(&db, kind, kind);
            assert!(
                novel_volume_list_impl(&db, &p.id).is_err(),
                "{kind} 不应读取小说卷"
            );
            assert!(
                novel_chapter_list_impl(&db, &p.id).is_err(),
                "{kind} 不应读取小说章"
            );
            assert!(
                novel_volume_save_impl(
                    &db,
                    None,
                    p.id.clone(),
                    "偷渡卷".into(),
                    None
                )
                .is_err(),
                "{kind} 不应新建小说卷"
            );
            assert!(
                novel_chapter_save_impl(
                    &db,
                    None,
                    p.id.clone(),
                    None,
                    "偷渡章".into(),
                    None
                )
                .is_err(),
                "{kind} 不应新建小说章"
            );
        }

        // 直接构造一条挂在 general 项目下的“历史脏数据”，get 必须在读取正文前拒绝。
        let general = create_project(&db, "通用", "general");
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO novel_chapters
                 (id, project_id, volume_id, title, content, word_count, sort_order,
                  created_at, updated_at)
                 VALUES ('legacy-general', ?1, NULL, '旧章', '不应读出', 4, 0, ?2, ?2)",
                params![general.id, now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        assert!(novel_chapter_get_impl(&db, "legacy-general").is_err());
        assert!(novel_chapter_save_content_impl(&db, "legacy-general", "改写".into()).is_err());
        assert!(novel_chapter_delete_impl(&db, "legacy-general").is_err());

        // 归档：读取允许，所有写入拒绝。
        workspace_project_set_status_impl(&db, &novel.id, "archived".into()).unwrap();
        assert_eq!(novel_volume_list_impl(&db, &novel.id).unwrap().len(), 1);
        assert_eq!(novel_chapter_list_impl(&db, &novel.id).unwrap().len(), 1);
        assert_eq!(
            novel_chapter_get_impl(&db, &c1.id).unwrap().content,
            "可读正文"
        );
        assert!(novel_volume_save_impl(
            &db,
            Some(v1.id.clone()),
            novel.id.clone(),
            "改名".into(),
            None
        )
        .is_err());
        assert!(novel_volume_delete_impl(&db, &v1.id).is_err());
        assert!(novel_chapter_save_impl(
            &db,
            Some(c1.id.clone()),
            novel.id.clone(),
            Some(v1.id.clone()),
            "改名".into(),
            None
        )
        .is_err());
        assert!(novel_chapter_save_content_impl(&db, &c1.id, "归档改写".into()).is_err());
        assert!(novel_chapter_delete_impl(&db, &c1.id).is_err());
        assert_eq!(
            novel_chapter_get_impl(&db, &c1.id).unwrap().content,
            "可读正文"
        );

        // 恢复 active 后可正常编辑。
        workspace_project_set_status_impl(&db, &novel.id, "active".into()).unwrap();
        novel_chapter_save_content_impl(&db, &c1.id, "恢复后正文".into()).unwrap();
        assert_eq!(
            novel_chapter_get_impl(&db, &c1.id).unwrap().content,
            "恢复后正文"
        );
        novel_volume_delete_impl(&db, &v1.id).unwrap();
        assert!(novel_chapter_get_impl(&db, &c1.id).is_err());
        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }
}
