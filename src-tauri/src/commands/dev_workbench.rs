//! 开发工作台命令层（v48）：开发项目登记、git 只读探测、交接文档版本、
//! 敏感内容扫描与验收记录。
//!
//! 语义约定：
//! - dev_projects 与 tasks/planning 是弱关联：本层不校验任务/规划是否存在，
//!   失效展示由前端读侧负责；
//! - dev_handoff_packs 按版本追加，旧版本永不覆盖：task_id 有值时以 task_id
//!   为版本键，task_id 为空时以 title 为版本键；
//! - dev_acceptance_records 只追加不修改；subject_kind/verdict 由命令层先校验，
//!   数据库 CHECK 兜底拦截；
//! - 交接文档入库前由前端调用 dev_handoff_secret_scan 预检，扫描结果只含
//!   位置与类型，不含命中原文。

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::devwork::git::{self, DevGitInfo};
use crate::devwork::secrets::{self, SecretFinding};
use crate::error::{AppError, AppResult};

/// 合法的验收对象类型（与迁移 v48 的 CHECK 约束保持一致）。
pub const SUBJECT_KINDS: &[&str] = &["task", "planning_feature"];
/// 合法的验收结论（与迁移 v48 的 CHECK 约束保持一致）。
pub const VERDICTS: &[&str] = &["pass", "fail", "blocked", "not_verified"];

// ── 返回模型 ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevProject {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    /// 读时计算：root_path 当前是否存在且为目录（不落库）。
    /// false = 目录被移动/删除，前端如实展示失效状态，不由后端联动清理。
    pub exists: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevHandoffPack {
    pub id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub version: i64,
    pub content_md: String,
    /// 来源摘要（JSON 对象字符串），原样保存，由前端解释。
    pub source_summary: String,
    /// 敏感扫描结果（JSON 对象字符串），原样保存，由前端解释。
    pub secret_scan: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevAcceptanceRecord {
    pub id: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub verdict: String,
    pub summary: String,
    /// 证据路径列表（库内为 JSON 数组字符串，读时解析；损坏行降级为空数组）。
    pub evidence: Vec<String>,
    pub created_at: String,
}

// ── 命令响应包装 ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DevProjectList {
    pub projects: Vec<DevProject>,
}

#[derive(Serialize)]
pub struct DevProjectSaved {
    pub project: DevProject,
}

#[derive(Serialize)]
pub struct DevOk {
    pub ok: bool,
}

#[derive(Serialize)]
pub struct DevHandoffSaved {
    pub pack: DevHandoffPack,
}

#[derive(Serialize)]
pub struct DevHandoffList {
    pub packs: Vec<DevHandoffPack>,
}

#[derive(Serialize)]
pub struct DevHandoffGot {
    pub pack: DevHandoffPack,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSecretScan {
    pub findings: Vec<SecretFinding>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct DevAcceptanceSaved {
    pub record: DevAcceptanceRecord,
}

#[derive(Serialize)]
pub struct DevAcceptanceList {
    pub records: Vec<DevAcceptanceRecord>,
}

// ── 行映射与公共校验 ─────────────────────────────────────────────────

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<DevProject> {
    let root_path: String = row.get("root_path")?;
    Ok(DevProject {
        id: row.get("id")?,
        name: row.get("name")?,
        exists: Path::new(&root_path).is_dir(),
        root_path,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_handoff(row: &rusqlite::Row<'_>) -> rusqlite::Result<DevHandoffPack> {
    Ok(DevHandoffPack {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        title: row.get("title")?,
        version: row.get("version")?,
        content_md: row.get("content_md")?,
        source_summary: row.get("source_summary")?,
        secret_scan: row.get("secret_scan")?,
        created_at: row.get("created_at")?,
    })
}

fn row_to_acceptance(row: &rusqlite::Row<'_>) -> rusqlite::Result<DevAcceptanceRecord> {
    let evidence_raw: String = row.get("evidence")?;
    // 损坏行（非 JSON 数组）降级为空数组：历史记录读取永远不能 500。
    let evidence: Vec<String> = serde_json::from_str(&evidence_raw).unwrap_or_default();
    Ok(DevAcceptanceRecord {
        id: row.get("id")?,
        subject_kind: row.get("subject_kind")?,
        subject_id: row.get("subject_id")?,
        verdict: row.get("verdict")?,
        summary: row.get("summary")?,
        evidence,
        created_at: row.get("created_at")?,
    })
}

/// 唯一索引冲突 → Conflict：dev_projects 的 root_path 唯一。
fn map_unique_conflict(err: rusqlite::Error) -> AppError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            AppError::Conflict("该目录已登记为其他开发项目".into())
        }
        _ => AppError::from(err),
    }
}

/// source_summary / secret_scan 归一：空缺补 "{}"，非空必须是 JSON 对象。
/// 前端把扫描结果序列化后传回，这里守住列的 JSON 契约（坏值在写入前报错，
/// 不静默落库让读侧解析失败）。
fn normalize_json_object(raw: Option<String>, field: &str) -> AppResult<String> {
    match raw {
        None => Ok("{}".to_string()),
        Some(s) => {
            let s = s.trim();
            if s.is_empty() {
                return Ok("{}".to_string());
            }
            let value: serde_json::Value = serde_json::from_str(s)
                .map_err(|_| AppError::Validation(format!("{field} 必须是合法 JSON")))?;
            if !value.is_object() {
                return Err(AppError::Validation(format!("{field} 必须是 JSON 对象")));
            }
            Ok(s.to_string())
        }
    }
}

// ── 开发项目 ─────────────────────────────────────────────────────────

/// 项目列表：按 name 排序；exists 为读时计算的目录存在性。
pub fn dev_project_list_impl(db: &Db) -> AppResult<Vec<DevProject>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, root_path, note, created_at, updated_at
             FROM dev_projects ORDER BY name",
        )?;
        let rows = stmt.query_map([], row_to_project)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

/// 保存项目：id 空 = 新建（保留各自 created_at），否则按 id 更新。
/// root_path 必须是存在的绝对路径目录；root_path 唯一，冲突报 Conflict。
pub fn dev_project_save_impl(
    db: &Db,
    id: Option<String>,
    name: String,
    root_path: String,
    note: Option<String>,
) -> AppResult<DevProject> {
    let name = name.trim();
    let root_path = root_path.trim();
    if name.is_empty() {
        return Err(AppError::Validation("项目名称不能为空".into()));
    }
    if root_path.is_empty() {
        return Err(AppError::Validation("项目路径不能为空".into()));
    }
    let path = Path::new(root_path);
    if !path.is_absolute() {
        return Err(AppError::Validation("项目路径必须是绝对路径".into()));
    }
    if !path.is_dir() {
        return Err(AppError::Validation("项目路径不存在或不是目录".into()));
    }
    let note = note.unwrap_or_default();
    let id = match id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let now = now_iso();
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO dev_projects (id, name, root_path, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![id, name, root_path, note, now],
                )
                .map_err(map_unique_conflict)?;
                Ok(())
            })?;
            id
        }
        Some(id) => {
            let now = now_iso();
            let updated = db.with_conn(|conn| {
                let updated = conn
                    .execute(
                        "UPDATE dev_projects SET name = ?1, root_path = ?2, note = ?3, updated_at = ?4
                         WHERE id = ?5",
                        params![name, root_path, note, now, id],
                    )
                    .map_err(map_unique_conflict)?;
                Ok::<i64, AppError>(updated as i64)
            })?;
            if updated == 0 {
                return Err(AppError::NotFound(format!("开发项目不存在: {id}")));
            }
            id
        }
    };
    dev_project_get_impl(db, &id)
}

pub fn dev_project_get_impl(db: &Db, id: &str) -> AppResult<DevProject> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, name, root_path, note, created_at, updated_at
             FROM dev_projects WHERE id = ?1",
            params![id],
            row_to_project,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("开发项目不存在: {id}")))
    })
}

pub fn dev_project_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    let deleted = db.with_conn(|conn| {
        let deleted = conn.execute("DELETE FROM dev_projects WHERE id = ?1", params![id])?;
        Ok::<i64, AppError>(deleted as i64)
    })?;
    if deleted == 0 {
        return Err(AppError::NotFound(format!("开发项目不存在: {id}")));
    }
    Ok(())
}

// ── git 只读探测 ─────────────────────────────────────────────────────

/// 探测目录的 git 状态：转发 devwork::git::probe（只读，不落库）。
pub fn dev_project_probe_impl(root_path: String) -> DevGitInfo {
    git::probe(root_path.trim())
}

// ── 交接文档 ─────────────────────────────────────────────────────────

/// 保存交接文档（按版本追加）：version = 同键当前最大版本 + 1。
/// 版本键：task_id 有值用 task_id；为空用 title（task_id IS NULL AND title = ?）。
pub fn dev_handoff_save_impl(
    db: &Db,
    task_id: Option<String>,
    title: String,
    content_md: String,
    source_summary: Option<String>,
    secret_scan: Option<String>,
) -> AppResult<DevHandoffPack> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("交接文档标题不能为空".into()));
    }
    // 空串按未关联处理，保持「task_id 为空 → 以 title 为键」的一致语义
    let task_id = task_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let source_summary = normalize_json_object(source_summary, "source_summary")?;
    let secret_scan = normalize_json_object(secret_scan, "secret_scan")?;
    let now = now_iso();
    let id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        // 版本号在写连接上查询 + 插入（同一互斥锁内串行），不存在并发重号
        let version: i64 = match &task_id {
            Some(tid) => conn.query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM dev_handoff_packs WHERE task_id = ?1",
                params![tid],
                |r| r.get(0),
            )?,
            None => conn.query_row(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM dev_handoff_packs
                 WHERE task_id IS NULL AND title = ?1",
                params![title],
                |r| r.get(0),
            )?,
        };
        conn.execute(
            "INSERT INTO dev_handoff_packs (id, task_id, title, version, content_md, source_summary, secret_scan, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, task_id, title, version, content_md, source_summary, secret_scan, now],
        )?;
        Ok(())
    })?;
    dev_handoff_get_impl(db, &id)
}

/// 交接文档列表：created_at 倒序（同秒再按 version 倒序）。
/// limit 默认 20、上限 100；task_id 有值时只返回该任务的版本。
pub fn dev_handoff_list_impl(
    db: &Db,
    task_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<DevHandoffPack>> {
    // 0/负数按默认窗口处理，超上限收敛到 100（响应体积可控）
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let task_id = task_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    db.with_read(|conn| {
        let filtered = task_id.is_some();
        let mut stmt = conn.prepare(if filtered {
            "SELECT id, task_id, title, version, content_md, source_summary, secret_scan, created_at
             FROM dev_handoff_packs WHERE task_id = ?1
             ORDER BY created_at DESC, version DESC LIMIT ?2"
        } else {
            "SELECT id, task_id, title, version, content_md, source_summary, secret_scan, created_at
             FROM dev_handoff_packs
             ORDER BY created_at DESC, version DESC LIMIT ?1"
        })?;
        let rows = if let Some(tid) = task_id {
            stmt.query_map(params![tid, limit], row_to_handoff)?
        } else {
            stmt.query_map(params![limit], row_to_handoff)?
        };
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn dev_handoff_get_impl(db: &Db, id: &str) -> AppResult<DevHandoffPack> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, task_id, title, version, content_md, source_summary, secret_scan, created_at
             FROM dev_handoff_packs WHERE id = ?1",
            params![id],
            row_to_handoff,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("交接文档不存在: {id}")))
    })
}

pub fn dev_handoff_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    let deleted = db.with_conn(|conn| {
        let deleted = conn.execute("DELETE FROM dev_handoff_packs WHERE id = ?1", params![id])?;
        Ok::<i64, AppError>(deleted as i64)
    })?;
    if deleted == 0 {
        return Err(AppError::NotFound(format!("交接文档不存在: {id}")));
    }
    Ok(())
}

// ── 敏感内容扫描 ─────────────────────────────────────────────────────

/// 对一组文本做敏感内容扫描：转发 devwork::secrets::scan。
/// 输出只含位置与类型，不含命中原文；truncated 表示某文本超行数上限。
pub fn dev_handoff_secret_scan_impl(texts: Vec<String>) -> DevSecretScan {
    let outcome = secrets::scan(&texts);
    DevSecretScan {
        findings: outcome.findings,
        truncated: outcome.truncated,
    }
}

// ── 验收记录 ─────────────────────────────────────────────────────────

/// 写入验收记录（只追加）：subject_kind/verdict 命令层先校验，CHECK 兜底。
/// 不校验任务/规划是否存在：弱关联，失效展示由前端负责。
pub fn dev_acceptance_record_create_impl(
    db: &Db,
    subject_kind: String,
    subject_id: String,
    verdict: String,
    summary: String,
    evidence: Option<Vec<String>>,
) -> AppResult<DevAcceptanceRecord> {
    if !SUBJECT_KINDS.contains(&subject_kind.as_str()) {
        return Err(AppError::Validation(format!(
            "subject_kind 只允许 {} 之一，收到 {:?}",
            SUBJECT_KINDS.join(" | "),
            subject_kind
        )));
    }
    if !VERDICTS.contains(&verdict.as_str()) {
        return Err(AppError::Validation(format!(
            "verdict 只允许 {} 之一，收到 {:?}",
            VERDICTS.join(" | "),
            verdict
        )));
    }
    let subject_id = subject_id.trim();
    if subject_id.is_empty() {
        return Err(AppError::Validation("subject_id 不能为空".into()));
    }
    // 空缺补 '[]'，否则序列化为 JSON 数组字符串（列契约：合法 JSON）
    let evidence_json = match evidence {
        None => "[]".to_string(),
        Some(items) => serde_json::to_string(&items)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO dev_acceptance_records (id, subject_kind, subject_id, verdict, summary, evidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, subject_kind, subject_id, verdict, summary, evidence_json, now],
        )?;
        Ok(())
    })?;
    Ok(DevAcceptanceRecord {
        id,
        subject_kind,
        subject_id: subject_id.to_string(),
        verdict,
        summary,
        evidence: serde_json::from_str(&evidence_json).unwrap_or_default(),
        created_at: now,
    })
}

/// 验收记录列表：created_at 倒序；subject_kind/subject_id 可选过滤；
/// limit 默认 50、上限 200。
pub fn dev_acceptance_record_list_impl(
    db: &Db,
    subject_kind: Option<String>,
    subject_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<DevAcceptanceRecord>> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    db.with_read(|conn| {
        // 过滤条件全部是字符串绑定，按出现顺序生成占位符
        let mut binds: Vec<String> = Vec::new();
        let mut sql = "SELECT id, subject_kind, subject_id, verdict, summary, evidence, created_at
                       FROM dev_acceptance_records"
            .to_string();
        if let Some(kind) = subject_kind.filter(|s| !s.trim().is_empty()) {
            binds.push(kind);
            sql.push_str(&format!(
                " WHERE subject_kind = ?{}",
                binds.len()
            ));
        }
        if let Some(sid) = subject_id.filter(|s| !s.trim().is_empty()) {
            if binds.is_empty() {
                sql.push_str(" WHERE");
            } else {
                sql.push_str(" AND");
            }
            binds.push(sid);
            sql.push_str(&format!(" subject_id = ?{}", binds.len()));
        }
        sql.push_str(&format!(
            " ORDER BY created_at DESC LIMIT ?{}",
            binds.len() + 1
        ));
        binds.push(limit.to_string());
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), row_to_acceptance)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

// ── Tauri 命令（参数名由前端 invoke 以 camelCase 传入）────────────────

#[tauri::command]
pub fn dev_project_list(db: State<'_, Arc<Db>>) -> AppResult<DevProjectList> {
    Ok(DevProjectList {
        projects: dev_project_list_impl(&db)?,
    })
}

#[tauri::command]
pub fn dev_project_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    name: String,
    root_path: String,
    note: Option<String>,
) -> AppResult<DevProjectSaved> {
    Ok(DevProjectSaved {
        project: dev_project_save_impl(&db, id, name, root_path, note)?,
    })
}

#[tauri::command]
pub fn dev_project_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<DevOk> {
    dev_project_delete_impl(&db, &id)?;
    Ok(DevOk { ok: true })
}

#[tauri::command]
pub fn dev_project_probe(root_path: String) -> DevGitInfo {
    dev_project_probe_impl(root_path)
}

#[tauri::command]
pub fn dev_handoff_save(
    db: State<'_, Arc<Db>>,
    task_id: Option<String>,
    title: String,
    content_md: String,
    source_summary: Option<String>,
    secret_scan: Option<String>,
) -> AppResult<DevHandoffSaved> {
    Ok(DevHandoffSaved {
        pack: dev_handoff_save_impl(&db, task_id, title, content_md, source_summary, secret_scan)?,
    })
}

#[tauri::command]
pub fn dev_handoff_list(
    db: State<'_, Arc<Db>>,
    task_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<DevHandoffList> {
    Ok(DevHandoffList {
        packs: dev_handoff_list_impl(&db, task_id, limit)?,
    })
}

#[tauri::command]
pub fn dev_handoff_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<DevHandoffGot> {
    Ok(DevHandoffGot {
        pack: dev_handoff_get_impl(&db, &id)?,
    })
}

#[tauri::command]
pub fn dev_handoff_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<DevOk> {
    dev_handoff_delete_impl(&db, &id)?;
    Ok(DevOk { ok: true })
}

#[tauri::command]
pub fn dev_handoff_secret_scan(texts: Vec<String>) -> DevSecretScan {
    dev_handoff_secret_scan_impl(texts)
}

#[tauri::command]
pub fn dev_acceptance_record_create(
    db: State<'_, Arc<Db>>,
    subject_kind: String,
    subject_id: String,
    verdict: String,
    summary: String,
    evidence: Option<Vec<String>>,
) -> AppResult<DevAcceptanceSaved> {
    Ok(DevAcceptanceSaved {
        record: dev_acceptance_record_create_impl(
            &db, subject_kind, subject_id, verdict, summary, evidence,
        )?,
    })
}

#[tauri::command]
pub fn dev_acceptance_record_list(
    db: State<'_, Arc<Db>>,
    subject_kind: Option<String>,
    subject_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<DevAcceptanceList> {
    Ok(DevAcceptanceList {
        records: dev_acceptance_record_list_impl(&db, subject_kind, subject_id, limit)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    /// 真实存在的临时目录（保存校验要求目录存在）。
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-devwork-cmd-{}-{}",
            name,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn project_save_list_and_exists_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("proj");
        let saved = dev_project_save_impl(
            &db,
            None,
            "  Task Dock  ".into(),
            dir.to_string_lossy().to_string(),
            Some("主仓库".into()),
        )
        .unwrap();
        // 名称与备注去首尾空白
        assert_eq!(saved.name, "Task Dock");
        assert_eq!(saved.note, "主仓库");
        assert!(saved.exists, "存在的目录必须报告 exists=true");

        let list = dev_project_list_impl(&db).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);
        assert!(list[0].exists);

        // 不存在的路径登记后 exists=false（读时计算，不落库）
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO dev_projects (id, name, root_path, note, created_at, updated_at)
                 VALUES ('ghost', '消失', 'C:/no/such/dir-xyz', '', 't', 't')",
                [],
            )
            .map_err(AppError::from)
        })
        .unwrap();
        let list = dev_project_list_impl(&db).unwrap();
        assert_eq!(list.len(), 2);
        let ghost = list.iter().find(|p| p.id == "ghost").unwrap();
        assert!(!ghost.exists, "消失的目录必须报告 exists=false");
        // 列表按 name 排序（Task Dock < 消失）
        assert_eq!(list[0].name, "Task Dock");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_save_rejects_invalid_input() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("valid");

        // 空名称
        let err = dev_project_save_impl(&db, None, "  ".into(), dir.to_string_lossy().to_string(), None)
            .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 空路径
        let err = dev_project_save_impl(&db, None, "名称".into(), "  ".into(), None).unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 相对路径
        let err = dev_project_save_impl(&db, None, "名称".into(), "relative/path".into(), None)
            .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 不存在的目录
        let err = dev_project_save_impl(
            &db,
            None,
            "名称".into(),
            "C:/definitely/not/exist-taskdock".into(),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 指向文件而非目录
        let file = dir.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        let err = dev_project_save_impl(&db, None, "名称".into(), file.to_string_lossy().to_string(), None)
            .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        assert_eq!(dev_project_list_impl(&db).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_root_path_is_unique() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("dup");
        let path = dir.to_string_lossy().to_string();
        dev_project_save_impl(&db, None, "第一个".into(), path.clone(), None).unwrap();
        // 同目录再次登记 → Conflict
        let err = dev_project_save_impl(&db, None, "第二个".into(), path, None).unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_update_keeps_created_at_and_conflicts_on_taken_path() {
        let db = Db::open_in_memory().unwrap();
        let dir_a = temp_dir("upd-a");
        let dir_b = temp_dir("upd-b");
        let a = dev_project_save_impl(
            &db,
            None,
            "A".into(),
            dir_a.to_string_lossy().to_string(),
            None,
        )
        .unwrap();
        let _b = dev_project_save_impl(
            &db,
            None,
            "B".into(),
            dir_b.to_string_lossy().to_string(),
            None,
        )
        .unwrap();

        // 更新 A：改名称，created_at 不变
        let updated = dev_project_save_impl(
            &db,
            Some(a.id.clone()),
            "A2".into(),
            dir_a.to_string_lossy().to_string(),
            Some("备注".into()),
        )
        .unwrap();
        assert_eq!(updated.id, a.id);
        assert_eq!(updated.created_at, a.created_at, "更新必须保留 created_at");
        assert_eq!(updated.name, "A2");
        assert_ne!(updated.updated_at, "", "更新后 updated_at 刷新");

        // 更新 A 的路径为 B 已占用的路径 → Conflict
        let err = dev_project_save_impl(
            &db,
            Some(a.id.clone()),
            "A2".into(),
            dir_b.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn project_delete_reports_not_found_for_missing() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("del");
        let saved =
            dev_project_save_impl(&db, None, "P".into(), dir.to_string_lossy().to_string(), None)
                .unwrap();
        dev_project_delete_impl(&db, &saved.id).unwrap();
        assert_eq!(dev_project_list_impl(&db).unwrap().len(), 0);
        let err = dev_project_delete_impl(&db, &saved.id).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        let err = dev_project_get_impl(&db, &saved.id).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_version_increments_per_key_with_isolation() {
        let db = Db::open_in_memory().unwrap();
        let pack = |task_id: Option<&str>, title: &str| {
            dev_handoff_save_impl(
                &db,
                task_id.map(|s| s.to_string()),
                title.to_string(),
                format!("# {title}"),
                None,
                None,
            )
            .unwrap()
        };

        // task A 的版本序列：不同 title 共享同一 task 键
        assert_eq!(pack(Some("task-a"), "交接一").version, 1);
        assert_eq!(pack(Some("task-a"), "交接二").version, 2);
        // task B 独立计数
        assert_eq!(pack(Some("task-b"), "交接一").version, 1);
        // 无任务：按 title 计数，且不同 title 互不影响
        assert_eq!(pack(None, "自由交接").version, 1);
        assert_eq!(pack(None, "自由交接").version, 2);
        assert_eq!(pack(None, "另一篇").version, 1);

        // 列表按 task 过滤
        let list = dev_handoff_list_impl(&db, Some("task-a".into()), None).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|p| p.task_id.as_deref() == Some("task-a")));
    }

    #[test]
    fn handoff_list_orders_by_created_at_then_version_and_caps_limit() {
        let db = Db::open_in_memory().unwrap();
        // 直接落库控制 created_at，验证同秒按 version 倒序
        db.with_conn(|conn| {
            for (id, version, created) in [
                ("h1", 1, "2026-01-01T00:00:00+00:00"),
                ("h2", 2, "2026-01-01T00:00:00+00:00"),
                ("h3", 3, "2026-01-01T00:00:00+00:00"),
                ("h4", 1, "2026-01-02T00:00:00+00:00"),
            ] {
                conn.execute(
                    "INSERT INTO dev_handoff_packs (id, task_id, title, version, content_md, created_at)
                     VALUES (?1, NULL, 't', ?2, 'md', ?3)",
                    params![id, version, created],
                )
                .map_err(AppError::from)?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();
        let list = dev_handoff_list_impl(&db, None, None).unwrap();
        let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["h4", "h3", "h2", "h1"], "时间倒序，同秒 version 倒序");

        // limit 默认 20、上限 100：灌 105 行后验证收敛
        db.with_conn(|conn| {
            for i in 0..105 {
                conn.execute(
                    "INSERT INTO dev_handoff_packs (id, task_id, title, version, content_md, created_at)
                     VALUES (?1, 'cap', 't', ?2, 'md', ?3)",
                    params![format!("cap-{i}"), i, format!("2026-02-03T00:00:{i:02}+00:00")],
                )
                .map_err(AppError::from)?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();
        let all = dev_handoff_list_impl(&db, None, None).unwrap();
        assert_eq!(all.len(), 20, "缺省 limit 必须是 20");
        let capped = dev_handoff_list_impl(&db, None, Some(500)).unwrap();
        assert_eq!(capped.len(), 100, "limit 必须收敛到上限 100");
        let one = dev_handoff_list_impl(&db, None, Some(1)).unwrap();
        assert_eq!(one.len(), 1);

        // 空串 task_id 视为不过滤（与保存路径的空串归一一致）
        let empty_filter = dev_handoff_list_impl(&db, Some("  ".into()), Some(500)).unwrap();
        assert_eq!(empty_filter.len(), 100);
    }

    #[test]
    fn handoff_get_and_delete_report_not_found() {
        let db = Db::open_in_memory().unwrap();
        let saved = dev_handoff_save_impl(
            &db,
            None,
            "交接".into(),
            "内容".into(),
            Some("{\"files\": 3}".into()),
            Some("{\"findings\": []}".into()),
        )
        .unwrap();
        let got = dev_handoff_get_impl(&db, &saved.id).unwrap();
        assert_eq!(got.source_summary, "{\"files\": 3}");
        assert_eq!(got.secret_scan, "{\"findings\": []}");

        dev_handoff_delete_impl(&db, &saved.id).unwrap();
        let err = dev_handoff_get_impl(&db, &saved.id).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        let err = dev_handoff_delete_impl(&db, &saved.id).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn handoff_save_rejects_bad_title_and_bad_json_fields() {
        let db = Db::open_in_memory().unwrap();
        let err = dev_handoff_save_impl(&db, None, "  ".into(), "内容".into(), None, None)
            .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 非法 JSON / 非对象：写入前报错，不落库
        let err = dev_handoff_save_impl(
            &db,
            None,
            "交接".into(),
            "内容".into(),
            Some("not-json".into()),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        let err = dev_handoff_save_impl(
            &db,
            None,
            "交接".into(),
            "内容".into(),
            None,
            Some("[1,2]".into()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 空串按缺省 "{}" 处理
        let pack = dev_handoff_save_impl(
            &db,
            None,
            "交接".into(),
            "内容".into(),
            Some("  ".into()),
            Some(String::new()),
        )
        .unwrap();
        assert_eq!(pack.source_summary, "{}");
        assert_eq!(pack.secret_scan, "{}");
    }

    #[test]
    fn secret_scan_command_passthrough_reports_positions_only() {
        let out = dev_handoff_secret_scan_impl(vec![
            "safe\npassword=abcdef12345".into(),
            "AKIAIOSFODNN7EXAMPLE".into(),
        ]);
        assert_eq!(out.findings.len(), 2);
        assert_eq!(out.findings[0].kind, "generic_assignment");
        assert_eq!(out.findings[0].line, 2);
        assert_eq!(out.findings[1].kind, "aws_key_id");
        assert!(!out.truncated);
        let serialized = serde_json::to_string(&out).unwrap();
        assert!(!serialized.contains("abcdef12345"));
        assert!(!serialized.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn acceptance_create_validates_and_appends() {
        let db = Db::open_in_memory().unwrap();
        let record = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            " 42 ".into(),
            "pass".into(),
            "核心链路通过".into(),
            Some(vec!["docs/a.md".into(), "docs/b.md".into()]),
        )
        .unwrap();
        assert_eq!(record.subject_id, "42");
        assert_eq!(record.evidence, vec!["docs/a.md", "docs/b.md"]);

        // 无证据 → '[]'
        let empty = dev_acceptance_record_create_impl(
            &db,
            "planning_feature".into(),
            "f1".into(),
            "blocked".into(),
            "阻塞".into(),
            None,
        )
        .unwrap();
        assert!(empty.evidence.is_empty());

        // 非法 subject_kind / verdict / 空 subject_id：命令层先拦截
        let err = dev_acceptance_record_create_impl(
            &db,
            "note".into(),
            "42".into(),
            "pass".into(),
            String::new(),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        let err = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "42".into(),
            "maybe".into(),
            String::new(),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        let err = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "  ".into(),
            "pass".into(),
            String::new(),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
    }

    #[test]
    fn acceptance_list_filters_orders_and_caps() {
        let db = Db::open_in_memory().unwrap();
        let mk = |kind: &str, sid: &str, verdict: &str, created: &str| {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO dev_acceptance_records (id, subject_kind, subject_id, verdict, summary, evidence, created_at)
                     VALUES (?1, ?2, ?3, ?4, '', '[]', ?5)",
                    params![uuid::Uuid::new_v4().to_string(), kind, sid, verdict, created],
                )
                .map_err(AppError::from)?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        };
        mk("task", "t1", "pass", "2026-01-01T00:00:00+00:00");
        mk("task", "t1", "fail", "2026-01-02T00:00:00+00:00");
        mk("planning_feature", "f1", "blocked", "2026-01-03T00:00:00+00:00");

        // created_at 倒序
        let all = dev_acceptance_record_list_impl(&db, None, None, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].verdict, "blocked");
        assert_eq!(all[2].verdict, "pass");

        // 双过滤
        let filtered = dev_acceptance_record_list_impl(
            &db,
            Some("task".into()),
            Some("t1".into()),
            None,
        )
        .unwrap();
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|r| r.subject_id == "t1"));
        // 只有 kind
        let by_kind = dev_acceptance_record_list_impl(
            &db,
            Some("planning_feature".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(by_kind.len(), 1);
        assert_eq!(by_kind[0].subject_kind, "planning_feature");
        // 只有 subject_id
        let by_id =
            dev_acceptance_record_list_impl(&db, None, Some("t1".into()), None).unwrap();
        assert_eq!(by_id.len(), 2);

        // limit 上限 200：灌 210 行验证收敛
        db.with_conn(|conn| {
            for i in 0..210 {
                conn.execute(
                    "INSERT INTO dev_acceptance_records (id, subject_kind, subject_id, verdict, summary, evidence, created_at)
                     VALUES (?1, 'task', 'bulk', 'pass', '', '[]', ?2)",
                    params![uuid::Uuid::new_v4().to_string(), format!("2026-03-01T00:00:{:05.2}+00:00", i as f64 / 100.0)],
                )
                .map_err(AppError::from)?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();
        let default_list = dev_acceptance_record_list_impl(&db, None, None, None).unwrap();
        assert_eq!(default_list.len(), 50, "缺省 limit 必须是 50");
        let capped = dev_acceptance_record_list_impl(&db, None, None, Some(999)).unwrap();
        assert_eq!(capped.len(), 200, "limit 必须收敛到上限 200");
    }

    #[test]
    fn acceptance_subject_kinds_and_verdicts_match_migration_check() {
        // 命令层常量必须与迁移 v48 的 CHECK 约束一致，避免「命令层放行、数据库拦截」
        let db = Db::open_in_memory().unwrap();
        for kind in SUBJECT_KINDS {
            for verdict in VERDICTS {
                dev_acceptance_record_create_impl(
                    &db,
                    (*kind).into(),
                    "x".into(),
                    (*verdict).into(),
                    String::new(),
                    None,
                )
                .unwrap_or_else(|e| panic!("{kind}/{verdict} 必须可写入: {e}"));
            }
        }
        let count: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM dev_acceptance_records", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(count as usize, SUBJECT_KINDS.len() * VERDICTS.len());
    }
}
