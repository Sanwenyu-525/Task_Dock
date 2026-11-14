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
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 合法的工作空间类型（与迁移 v49 的 CHECK 约束保持一致）。
pub const PROJECT_KINDS: &[&str] = &["development", "game", "ai_comic", "general"];
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
    if root_path.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("项目路径含非法控制字符".into()));
    }
    if !Path::new(root_path).is_absolute() {
        return Err(AppError::Validation("项目路径必须是绝对路径".into()));
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
            let id = uuid::Uuid::new_v4().to_string();
            let now = now_iso();
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspace_projects
                     (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?7)",
                    params![id, name, kind, root_path, dev_project_id, note, now],
                )?;
                Ok(())
            })?;
            id
        }
        Some(id) => {
            let now = now_iso();
            let updated = db.with_conn(|conn| {
                let updated = conn.execute(
                    "UPDATE workspace_projects
                     SET name = ?1, kind = ?2, root_path = ?3, dev_project_id = ?4,
                         note = ?5, updated_at = ?6
                     WHERE id = ?7",
                    params![name, kind, root_path, dev_project_id, note, now, id],
                )?;
                Ok::<usize, AppError>(updated)
            })?;
            if updated == 0 {
                return Err(AppError::NotFound(format!("工作空间项目不存在: {id}")));
            }
            id
        }
    };
    db.with_read(|conn| read_project(conn, &saved_id))
}

pub fn workspace_project_get_impl(db: &Db, id: &str) -> AppResult<WorkspaceProject> {
    db.with_read(|conn| read_project(conn, id))
}

/// 归档/恢复项目：只改 status，不删除项目、事项、任务关联或外部文件。
pub fn workspace_project_set_status_impl(
    db: &Db,
    id: &str,
    status: String,
) -> AppResult<WorkspaceProject> {
    let status = validate_enum(&status, "项目状态", PROJECT_STATUSES)?;
    let now = now_iso();
    let updated = db.with_conn(|conn| {
        let updated = conn.execute(
            "UPDATE workspace_projects SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, id],
        )?;
        Ok::<usize, AppError>(updated)
    })?;
    if updated == 0 {
        return Err(AppError::NotFound(format!("工作空间项目不存在: {id}")));
    }
    workspace_project_get_impl(db, id)
}

/// 删除项目：只删除本地登记、实例、事项与任务关联（级联），
/// **不删除**外部目录、开发项目登记或任务；若它是活跃项目则同时清除活跃键。
pub fn workspace_project_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let deleted = conn.execute("DELETE FROM workspace_projects WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(AppError::NotFound(format!("工作空间项目不存在: {id}")));
        }
        // 活跃项目已被删除：清掉指向不存在项目的键，避免下次打开落空。
        let stored = serde_json::to_string(id)?;
        conn.execute(
            "DELETE FROM application_settings
             WHERE key = 'workspace_active_project' AND value = ?1",
            params![stored],
        )?;
        Ok(())
    })
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
    let layout_json = normalize_json_object(layout_json, "布局", MAX_LAYOUT_BYTES)?;
    let now = now_iso();
    db.with_conn(|conn| {
        ensure_project_exists(conn, project_id)?;
        conn.execute(
            "INSERT INTO workspace_instances (project_id, active_module, layout_json, last_opened_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               active_module = excluded.active_module,
               layout_json = excluded.layout_json,
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
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err(AppError::Validation("任务 ID 不能为空".into()));
    }
    let now = now_iso();
    db.with_conn(|conn| {
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
    })
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
}