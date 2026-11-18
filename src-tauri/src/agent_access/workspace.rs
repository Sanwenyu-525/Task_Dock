//! Agent 共享工作空间：注册、初始化、目录协议与 manifest。
//!
//! 安全边界：
//! - 目录由用户显式选择（设置项 `agent_workspace_path`），代码不扫描磁盘猜路径；
//! - 初始化只创建协议规定的空目录与标记文件，**不移动、不删除**任何既有文件；
//! - 已存在的目录若不是本协议工作空间（缺标记、且非空），拒绝初始化，避免污染用户目录。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

use super::store;
use super::{validation, PROTOCOL, PROTOCOL_VERSION, SCHEMA_VERSION, WORKSPACE_MARKER};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const DIRS: &[&str] = &[
    "projects",
    "tasks",
    "tasks/inbox",
    "tasks/active",
    "tasks/completed",
    "tasks/archive",
    "agents",
    "agents/registry",
    "agents/sessions",
    "agents/handoffs",
    "agents/reports",
    "knowledge",
    "knowledge/documents",
    "skills",
    "context",
    "decisions",
    "exports",
    "inbox",
];
pub const IMPORT_DIRS: &[&str] = &["inbox", "tasks/inbox", "knowledge/inbox"];

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub root_path: String,
    pub protocol_version: String,
    pub schema_version: String,
    pub enabled: bool,
    pub watch_enabled: bool,
    pub last_export_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub last_import_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceStatus {
    pub workspace_id: String,
    pub root_path: String,
    pub exists: bool,
    pub initialized: bool,
    pub watch_enabled: bool,
    pub protocol_version: String,
    pub schema_version: String,
    pub file_count: i64,
    pub pending_imports: i64,
    pub conflicts: i64,
    pub last_export_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub last_import_at: Option<String>,
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        name: r.get(2)?,
        root_path: r.get(3)?,
        protocol_version: r.get(4)?,
        schema_version: r.get(5)?,
        enabled: r.get::<_, i64>(6)? != 0,
        watch_enabled: r.get::<_, i64>(7)? != 0,
        last_export_at: r.get(8)?,
        last_scan_at: r.get(9)?,
        last_import_at: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

const SELECT_ROW: &str = "SELECT id, workspace_id, name, root_path, protocol_version, schema_version,
    enabled, watch_enabled, last_export_at, last_scan_at, last_import_at, created_at, updated_at
    FROM agent_workspaces";

pub fn active(db: &Db) -> AppResult<Option<WorkspaceRow>> {
    db.with_read(|conn| match conn.query_row(
        &format!("{SELECT_ROW} WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1"),
        [],
        row_from,
    ) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(AppError::from(err)),
    })
}

/// 默认目录：数据目录下 `TaskDock-Agent-Workspace`，与 Git 仓库彻底解耦。
pub fn default_path(db: &Db) -> PathBuf {
    let settings = Settings::load(db).ok();
    let configured = settings
        .as_ref()
        .map(|s| s.agent_workspace_path.trim().to_string())
        .unwrap_or_default();
    if !configured.is_empty() {
        return PathBuf::from(configured);
    }
    super::service::data_dir().join("TaskDock-Agent-Workspace")
}

fn ensure_absolute(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(validation("工作空间路径不能为空"));
    }
    if !path.is_absolute() {
        return Err(validation("工作空间路径必须是绝对路径"));
    }
    let text = path.to_string_lossy();
    // 拒绝磁盘根目录：导出上限 2000 个文件，落在根目录会污染整个盘。
    let trimmed = text.trim_end_matches(['\\', '/']);
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return Err(validation("工作空间不能是磁盘根目录，请选择独立子目录"));
    }
    Ok(path.to_path_buf())
}

/// 初始化（幂等）：创建目录树、标记与 manifest；已存在的非本协议非空目录会被拒绝。
pub fn init(db: &Db, path: Option<&str>, name: Option<&str>) -> AppResult<WorkspaceRow> {
    let raw = match path.map(str::trim).filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_path(db),
    };
    let root = ensure_absolute(&raw)?;
    if root.exists() && !root.is_dir() {
        return Err(validation(format!("路径不是目录: {}", root.display())));
    }
    let marker = root.join(WORKSPACE_MARKER);
    if root.exists() && !marker.exists() {
        let mut entries = fs::read_dir(&root).map_err(|e| {
            AppError::Validation(format!("目录不可读: {}（{e}）", root.display()))
        })?;
        if entries.next().is_some() {
            return Err(validation(format!(
                "目录非空且不是 Task Dock 工作空间，拒绝初始化以避免污染: {}",
                root.display()
            )));
        }
    }
    for dir in DIRS {
        fs::create_dir_all(root.join(dir)).map_err(|e| {
            AppError::Validation(format!("创建目录失败: {}（{e}）", dir))
        })?;
    }

    let now = crate::agents::now_iso();
    let existing = active(db)?;
    let (row_id, workspace_id) = match &existing {
        Some(row) => (row.id.clone(), row.workspace_id.clone()),
        None => (
            uuid::Uuid::new_v4().to_string(),
            format!("ws_{}", uuid::Uuid::new_v4().simple()),
        ),
    };
    let display_name = name
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("Task Dock Agent Workspace")
        .to_string();
    let root_text = root.to_string_lossy().to_string();

    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_workspaces WHERE id = ?1)",
            rusqlite::params![row_id],
            |r| r.get(0),
        )?;
        if exists {
            conn.execute(
                "UPDATE agent_workspaces SET name=?2, root_path=?3, protocol_version=?4,
                   schema_version=?5, enabled=1, updated_at=?6 WHERE id=?1",
                rusqlite::params![
                    row_id,
                    display_name,
                    root_text,
                    PROTOCOL_VERSION,
                    SCHEMA_VERSION,
                    now
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO agent_workspaces
                   (id, workspace_id, name, root_path, protocol_version, schema_version,
                    enabled, watch_enabled, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,1,0,?7,?7)",
                rusqlite::params![
                    row_id,
                    workspace_id,
                    display_name,
                    root_text,
                    PROTOCOL_VERSION,
                    SCHEMA_VERSION,
                    now
                ],
            )?;
        }
        Ok(())
    })?;

    let marker_doc = json!({
        "protocol": PROTOCOL,
        "protocol_version": PROTOCOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "workspace_id": workspace_id,
        "name": display_name,
        "created_at": now,
    });
    write_json(&marker, &marker_doc)?;

    let row = active(db)?.ok_or_else(|| AppError::NotFound("工作空间注册失败".into()))?;
    let manifest = manifest_value(db, &row)?;
    write_json(&root.join(MANIFEST_FILE), &manifest)?;
    Ok(row)
}

pub fn write_json(path: &Path, value: &Value) -> AppResult<()> {
    write_json_text(path, &format!("{}\n", serde_json::to_string_pretty(value)?))
}

/// 原子写文本：先写 `.tmp` 再替换，避免外部 Agent 读到半个文件。
pub fn write_json_text(path: &Path, text: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AppError::Validation(format!("创建目录失败: {}（{e}）", parent.display()))
        })?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| {
        AppError::Validation(format!("写入文件失败: {}（{e}）", tmp.display()))
    })?;
    fs::rename(&tmp, path).map_err(|e| {
        AppError::Validation(format!("替换文件失败: {}（{e}）", path.display()))
    })?;
    Ok(())
}

pub fn status(db: &Db) -> AppResult<Option<WorkspaceStatus>> {
    let row = match active(db)? {
        Some(row) => row,
        None => return Ok(None),
    };
    let root = PathBuf::from(&row.root_path);
    let exists = root.is_dir();
    let initialized = exists && root.join(WORKSPACE_MARKER).exists();
    let file_count = db.with_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT COUNT(*) FROM agent_workspace_files WHERE workspace_row_id = ?1",
                rusqlite::params![row.id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0))
    })?;
    let conflicts = db.with_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT COUNT(*) FROM agent_sync_conflicts
             WHERE workspace_row_id = ?1 AND status = 'open'",
                rusqlite::params![row.id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0))
    })?;
    let pending_imports = if initialized {
        count_files(&root.join("inbox")) as i64
            + count_files(&root.join("tasks/inbox")) as i64
            + count_files(&root.join("knowledge/inbox")) as i64
    } else {
        0
    };
    Ok(Some(WorkspaceStatus {
        workspace_id: row.workspace_id,
        root_path: row.root_path,
        exists,
        initialized,
        watch_enabled: row.watch_enabled,
        protocol_version: row.protocol_version,
        schema_version: row.schema_version,
        file_count,
        pending_imports,
        conflicts,
        last_export_at: row.last_export_at,
        last_scan_at: row.last_scan_at,
        last_import_at: row.last_import_at,
    }))
}

fn count_files(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .count()
}

/// manifest 是 Agent 的机器可读入口：能力、接口、协议、授权口径都在这里声明。
pub fn manifest(db: &Db) -> AppResult<Value> {
    let row = active(db)?.ok_or_else(|| {
        AppError::NotFound("Agent 工作空间尚未初始化（请先执行 taskdock sync init）".into())
    })?;
    manifest_value(db, &row)
}

pub fn manifest_value(db: &Db, row: &WorkspaceRow) -> AppResult<Value> {
    let settings = Settings::load(db);
    Ok(json!({
        "protocol": PROTOCOL,
        "protocol_version": PROTOCOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "workspace_id": row.workspace_id,
        "taskdock_version": env!("CARGO_PKG_VERSION"),
        "root_path": row.root_path,
        "interfaces": {
            "filesystem": true,
            "cli": true,
            "mcp": true,
            "rest": settings.as_ref().map(|s| s.agent_api_enabled).unwrap_or(false),
            "rest_base_url": settings.as_ref().ok().filter(|s| s.agent_api_enabled)
                .map(|s| format!("http://127.0.0.1:{}/api/v1", s.agent_api_port)),
            "remote": false,
        },
        "capabilities": [
            "projects.read",
            "plans.read",
            "tasks.read", "tasks.write",
            "knowledge.read", "knowledge.write",
            "decisions.read", "decisions.write",
            "context.read",
            "handoffs.read", "handoffs.write",
            "skills.read"
        ],
        "resources": {
            "projects": "planning_projects + workspace_projects",
            "tasks": "tasks",
            "plans": "planning_projects / milestones / features / steps",
            "knowledge": "knowledge_bases / knowledge_documents",
            "decisions": "agent_decisions",
            "handoffs": "agent_handoffs",
            "reports": "agent_work_reports",
        },
        "filesystem": {
            "import_dirs": IMPORT_DIRS,
            "envelope": "{\"schema\":\"taskdock.import/1\",\"kind\":\"task.create\",\"base_revision\":0,\"payload\":{...}}",
            "kinds": ["task.create","task.update","task.complete","knowledge.create","decision.create","handoff.create","report.create"],
            "max_file_bytes": super::MAX_IMPORT_BYTES,
        },
        "cli": {
            "binary": "taskdock",
            "json_flag": "--json",
            "example": "taskdock task list --json"
        },
        "mcp": {
            "transport": "stdio",
            "entry": "task-dock --mcp-server",
            "resources": "taskdock://manifest 等（见 docs/agent-workspace/mcp-specification.md）"
        },
        "permissions": {
            "default": "readonly",
            "write": "需逐能力授权（tasks.write / knowledge.write / decisions.write / handoffs.write）",
            "delete": "未开放",
            "tokens": "仅存 SHA-256，不在日志中输出"
        },
        "updated_at": row.last_export_at.clone().unwrap_or_else(|| row.updated_at.clone()),
    }))
}

/// 标记工作空间已导出（manifest 与同步索引的 updated_at 一起刷新）。
pub fn touch_export(db: &Db, workspace_row_id: &str, at: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_workspaces SET last_export_at=?2, updated_at=?2 WHERE id=?1",
            rusqlite::params![workspace_row_id, at],
        )?;
        Ok(())
    })
}

pub fn touch_scan(db: &Db, workspace_row_id: &str, at: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_workspaces SET last_scan_at=?2 WHERE id=?1",
            rusqlite::params![workspace_row_id, at],
        )?;
        Ok(())
    })
}

pub fn touch_import(db: &Db, workspace_row_id: &str, at: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_workspaces SET last_import_at=?2, updated_at=?2 WHERE id=?1",
            rusqlite::params![workspace_row_id, at],
        )?;
        Ok(())
    })
}

pub fn set_watch(db: &Db, workspace_row_id: &str, enabled: bool) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_workspaces SET watch_enabled=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![workspace_row_id, if enabled { 1 } else { 0 }, crate::agents::now_iso()],
        )?;
        Ok(())
    })
}

/// 文件导入时判断相对路径是否落在允许写入的目录内。
pub fn import_path_allowed(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    if normalized.contains("..") {
        return false;
    }
    IMPORT_DIRS
        .iter()
        .any(|dir| normalized == *dir || normalized.starts_with(&format!("{dir}/")))
}

/// 投影目录（只读给 Agent 看，不允许写入回导）。
pub fn projection_path_allowed(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    !normalized.contains("..")
        && !normalized.is_empty()
        && !normalized.eq_ignore_ascii_case(MANIFEST_FILE)
        && !normalized.eq_ignore_ascii_case(WORKSPACE_MARKER)
}

/// 记录一条同步事件（失败不阻断主流程）。
pub fn log_event(
    db: &Db,
    workspace_row_id: &str,
    direction: &str,
    event_kind: &str,
    rel_path: &str,
    resource_kind: &str,
    resource_id: &str,
    status: &str,
    message: &str,
    revision: Option<i64>,
    request_id: &str,
) {
    let _ = db.with_conn(|conn| {
        store::record_sync_event(
            conn,
            &store::SyncEvent {
                workspace_row_id,
                direction,
                event_kind,
                rel_path,
                resource_kind,
                resource_id,
                revision,
                status,
                message,
                content_hash: "",
                request_id,
            },
        )
    });
}

/// 简化：导出/扫描异常统一转成可读错误（不吞掉根因）。
pub fn io_error(what: &str, path: &Path, err: &std::io::Error) -> AppError {
    AppError::Validation(format!("{what}失败: {}（{err}）", path.display()))
}
