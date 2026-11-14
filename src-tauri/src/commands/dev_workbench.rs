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
    /// v50：该交接包要交给哪个 Agent 会话执行（与 task_agent_links 同一身份口径）。
    pub agent_source_id: Option<String>,
    pub agent_session_external_id: Option<String>,
    /// 读时派生：会话标题（会话被删除时为 None，不落库、不猜测）。
    pub agent_session_title: Option<String>,
    /// 读时派生：该 (source, session_external_id) 当前是否仍存在。
    pub agent_session_available: bool,
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
    /// v50：本记录针对哪个 Agent 轮次（人工登记时可选标注；历史记录为 None）。
    pub agent_source_id: Option<String>,
    pub agent_session_external_id: Option<String>,
    pub agent_run_external_id: Option<String>,
}

/// 一个「Agent 已完成、可人工验收」的轮次候选（读时派生，不落库）。
///
/// 只从真实关联链取数：任务 → task_agent_links → agent_sessions → agent_runs。
/// `accepted_*` 有值表示该任务已针对这一轮次登记过验收记录（仍然可以再次登记，
/// 例如返工后复验；记录只追加）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevAgentRunCandidate {
    pub source_id: String,
    pub session_external_id: String,
    /// agent_sessions.id（行 ID，供前端按会话继续查轮次）。
    pub session_id: String,
    pub session_title: String,
    pub session_status: String,
    /// 关联来源：user（手工关联）| auto（导航目标影子关联）。
    pub link_origin: String,
    pub run_external_id: String,
    pub run_task_title: Option<String>,
    pub run_status: String,
    pub ended_at: Option<String>,
    pub updated_at: String,
    pub accepted_record_id: Option<String>,
    pub accepted_verdict: Option<String>,
    pub accepted_at: Option<String>,
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

#[derive(Serialize, Debug)]
pub struct DevAgentRunCandidates {
    pub runs: Vec<DevAgentRunCandidate>,
    /// 超出 limit 时为 true：前端如实提示「还有更多」，不静默截断。
    pub truncated: bool,
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

/// 交接包读取的公共 SELECT：LEFT JOIN 会话表派生标题与有效性，
/// 会话/来源被删除时标题为 NULL、available=0（历史版本仍原样保留）。
const HANDOFF_SELECT: &str = "SELECT p.id, p.task_id, p.title, p.version, p.content_md,
        p.source_summary, p.secret_scan, p.created_at,
        p.agent_source_id, p.agent_session_external_id,
        s.title AS agent_session_title,
        (s.id IS NOT NULL) AS agent_session_available
 FROM dev_handoff_packs p
 LEFT JOIN agent_sessions s
   ON s.source_id = p.agent_source_id
  AND s.external_id = p.agent_session_external_id";

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
        agent_source_id: row.get("agent_source_id")?,
        agent_session_external_id: row.get("agent_session_external_id")?,
        agent_session_title: row.get("agent_session_title")?,
        agent_session_available: row.get::<_, i64>("agent_session_available")? != 0,
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
        agent_source_id: row.get("agent_source_id")?,
        agent_session_external_id: row.get("agent_session_external_id")?,
        agent_run_external_id: row.get("agent_run_external_id")?,
    })
}

/// Agent 弱引用三元组归一：全空 → 全 None；只给一部分 → Validation。
///
/// `require_run=false` 用于交接包（只关联会话，不绑定轮次）。
/// 这里只做形状校验；「是否真实存在」由各命令按自己的语义再查。
fn normalize_agent_refs(
    source_id: Option<String>,
    session_external_id: Option<String>,
    run_external_id: Option<String>,
    require_run: bool,
) -> AppResult<(Option<String>, Option<String>, Option<String>)> {
    let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let source = norm(source_id);
    let session = norm(session_external_id);
    let run = norm(run_external_id);
    if source.is_none() && session.is_none() && run.is_none() {
        return Ok((None, None, None));
    }
    let pair_missing = source.is_none() || session.is_none();
    let run_missing = require_run && run.is_none();
    if pair_missing || run_missing {
        return Err(AppError::Validation(if require_run {
            "Agent 轮次关联必须同时提供 agentSourceId / agentSessionExternalId / agentRunExternalId"
                .into()
        } else {
            "Agent 会话关联必须同时提供 agentSourceId / agentSessionExternalId".into()
        }));
    }
    if !require_run && run.is_some() {
        return Err(AppError::Validation(
            "交接包只关联会话，不接受单一轮次字段".into(),
        ));
    }
    Ok((source, session, run))
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
///
/// v50：可同时登记「交给哪个 Agent 会话」；会话必须真实存在（不以标题猜身份），
/// 身份口径与 task_agent_links 一致：`(source_id, agent_sessions.external_id)`。
pub fn dev_handoff_save_impl(
    db: &Db,
    task_id: Option<String>,
    title: String,
    content_md: String,
    source_summary: Option<String>,
    secret_scan: Option<String>,
    agent_source_id: Option<String>,
    agent_session_external_id: Option<String>,
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
    let (agent_source_id, agent_session_external_id, _) =
        normalize_agent_refs(agent_source_id, agent_session_external_id, None, false)?;
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
        if let (Some(src), Some(ses)) = (&agent_source_id, &agent_session_external_id) {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2)",
                params![src, ses],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!(
                    "Agent 会话不存在：{src}/{ses}"
                )));
            }
        }
        conn.execute(
            "INSERT INTO dev_handoff_packs
             (id, task_id, title, version, content_md, source_summary, secret_scan, created_at,
              agent_source_id, agent_session_external_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                task_id,
                title,
                version,
                content_md,
                source_summary,
                secret_scan,
                now,
                agent_source_id,
                agent_session_external_id
            ],
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
        let mut stmt = conn.prepare(&if filtered {
            format!(
                "{HANDOFF_SELECT} WHERE p.task_id = ?1
                 ORDER BY p.created_at DESC, p.version DESC LIMIT ?2"
            )
        } else {
            format!(
                "{HANDOFF_SELECT}
                 ORDER BY p.created_at DESC, p.version DESC LIMIT ?1"
            )
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
            &format!("{HANDOFF_SELECT} WHERE p.id = ?1"),
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
///
/// v50：可标注本次人工验收针对哪个 Agent 轮次。给了三元组就必须真实存在
/// （来源 + 会话 + 轮次），避免前端拼错身份或伪造「某轮次已验收」。
/// 记录本身仍然只由用户显式选择结论后写入，Agent 完成事件不会自动落库。
pub fn dev_acceptance_record_create_impl(
    db: &Db,
    subject_kind: String,
    subject_id: String,
    verdict: String,
    summary: String,
    evidence: Option<Vec<String>>,
    agent_source_id: Option<String>,
    agent_session_external_id: Option<String>,
    agent_run_external_id: Option<String>,
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
    let (agent_source_id, agent_session_external_id, agent_run_external_id) =
        normalize_agent_refs(
            agent_source_id,
            agent_session_external_id,
            agent_run_external_id,
            true,
        )?;
    // 空缺补 '[]'，否则序列化为 JSON 数组字符串（列契约：合法 JSON）
    let evidence_json = match evidence {
        None => "[]".to_string(),
        Some(items) => serde_json::to_string(&items)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    db.with_conn(|conn| {
        if let (Some(src), Some(ses), Some(run)) = (
            &agent_source_id,
            &agent_session_external_id,
            &agent_run_external_id,
        ) {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM agent_runs r
                    JOIN agent_sessions s ON s.id = r.session_id
                    WHERE s.source_id = ?1 AND s.external_id = ?2
                      AND r.external_run_id = ?3 AND r.origin = 'real'
                 )",
                params![src, ses, run],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!(
                    "Agent 轮次不存在：{src}/{ses}/{run}"
                )));
            }
        }
        conn.execute(
            "INSERT INTO dev_acceptance_records
             (id, subject_kind, subject_id, verdict, summary, evidence, created_at,
              agent_source_id, agent_session_external_id, agent_run_external_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                subject_kind,
                subject_id,
                verdict,
                summary,
                evidence_json,
                now,
                agent_source_id,
                agent_session_external_id,
                agent_run_external_id
            ],
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
        agent_source_id,
        agent_session_external_id,
        agent_run_external_id,
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
        let mut sql = "SELECT id, subject_kind, subject_id, verdict, summary, evidence, created_at,
                              agent_source_id, agent_session_external_id, agent_run_external_id
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

// ── Agent 已完成轮次（待人工验收候选）────────────────────────────────

/// 列出「当前任务关联会话里已完成、尚未被同一任务验收记录引用」的 Agent 轮次。
///
/// 只读派生，不落库、不自动创建验收记录：
/// - 关联链：task_agent_links ∪ 本任务交接包绑定的会话（v50）→ agent_sessions
///   → agent_runs（origin='real'）；
/// - 只取 `status='completed'`（失败轮次属于问题排查，不进验收候选）；
/// - 已登记过的轮次仍返回，并带 `accepted_*`，供前端展示「已验收」而不是隐藏；
/// - 按结束时间倒序，limit 默认 10 / 上限 50，超限 `truncated=true`。
pub fn dev_acceptance_agent_runs_impl(
    db: &Db,
    task_id: String,
    limit: Option<i64>,
) -> AppResult<DevAgentRunCandidates> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err(AppError::Validation("task_id 不能为空".into()));
    }
    let limit = limit.unwrap_or(10).clamp(1, 50);
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "WITH raw AS (
                SELECT source_id, session_external_id, MAX(origin) AS origin
                FROM task_agent_links
                WHERE task_id = ?1
                GROUP BY source_id, session_external_id
                UNION ALL
                -- v50：交接包已绑定的会话同样属于本任务的执行链（不要求再手工关联）
                SELECT agent_source_id, agent_session_external_id, 'handoff' AS origin
                FROM dev_handoff_packs
                WHERE task_id = ?1
                  AND agent_source_id IS NOT NULL
                  AND agent_session_external_id IS NOT NULL
             ),
             linked AS (
                SELECT source_id, session_external_id,
                       CASE WHEN MAX(origin) = 'user' THEN 'user'
                            WHEN MAX(origin) = 'handoff' THEN 'handoff'
                            ELSE 'auto' END AS link_origin
                FROM raw
                GROUP BY source_id, session_external_id
             )
             SELECT l.source_id, l.session_external_id, l.link_origin,
                    s.id AS session_id, s.title AS session_title, s.status AS session_status,
                    r.external_run_id, r.task_title AS run_task_title,
                    r.status AS run_status, r.ended_at, r.updated_at,
                    ar.id AS accepted_record_id, ar.verdict AS accepted_verdict,
                    ar.created_at AS accepted_at
             FROM linked l
             JOIN agent_sessions s
               ON s.source_id = l.source_id AND s.external_id = l.session_external_id
             JOIN agent_runs r
               ON r.session_id = s.id AND r.origin = 'real'
             LEFT JOIN dev_acceptance_records ar
               ON ar.subject_kind = 'task' AND ar.subject_id = ?1
              AND ar.agent_source_id = l.source_id
              AND ar.agent_session_external_id = l.session_external_id
              AND ar.agent_run_external_id = r.external_run_id
             WHERE s.origin = 'real'
               AND r.status = 'completed'
               AND r.external_run_id IS NOT NULL
             ORDER BY COALESCE(r.ended_at, r.updated_at) DESC, r.id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![task_id, limit + 1], |r| {
            Ok(DevAgentRunCandidate {
                source_id: r.get(0)?,
                session_external_id: r.get(1)?,
                link_origin: r.get(2)?,
                session_id: r.get(3)?,
                session_title: r.get(4)?,
                session_status: r.get(5)?,
                run_external_id: r.get(6)?,
                run_task_title: r.get(7)?,
                run_status: r.get(8)?,
                ended_at: r.get(9)?,
                updated_at: r.get(10)?,
                accepted_record_id: r.get(11)?,
                accepted_verdict: r.get(12)?,
                accepted_at: r.get(13)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::from)?);
        }
        let truncated = out.len() as i64 > limit;
        out.truncate(limit as usize);
        Ok(DevAgentRunCandidates {
            runs: out,
            truncated,
        })
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
    agent_source_id: Option<String>,
    agent_session_external_id: Option<String>,
) -> AppResult<DevHandoffSaved> {
    Ok(DevHandoffSaved {
        pack: dev_handoff_save_impl(
            &db,
            task_id,
            title,
            content_md,
            source_summary,
            secret_scan,
            agent_source_id,
            agent_session_external_id,
        )?,
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
    agent_source_id: Option<String>,
    agent_session_external_id: Option<String>,
    agent_run_external_id: Option<String>,
) -> AppResult<DevAcceptanceSaved> {
    Ok(DevAcceptanceSaved {
        record: dev_acceptance_record_create_impl(
            &db,
            subject_kind,
            subject_id,
            verdict,
            summary,
            evidence,
            agent_source_id,
            agent_session_external_id,
            agent_run_external_id,
        )?,
    })
}

#[tauri::command]
pub fn dev_acceptance_agent_runs(
    db: State<'_, Arc<Db>>,
    task_id: String,
    limit: Option<i64>,
) -> AppResult<DevAgentRunCandidates> {
    dev_acceptance_agent_runs_impl(&db, task_id, limit)
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
            None,
            None,
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
        let err = dev_handoff_save_impl(
            &db,
            None,
            "  ".into(),
            "内容".into(),
            None,
            None,
            None,
            None,
        )
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
            None,
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
            None,
            None,
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
            None,
            None,
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
            None,
            None,
            None,
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
            None,
            None,
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
            None,
            None,
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
            None,
            None,
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
            None,
            None,
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
                    None,
                    None,
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

    /// 真实 Agent 图的最小夹具：来源 / 会话 / 已完成轮次 / 任务 / 用户关联。
    fn seed_agent_graph(db: &Db, now: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('src-a', '来源 A', ?1, ?1)",
                [now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO agent_sessions
                 (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-a', 'src-a', 'ext-a', '会话 A', 'idle', ?1, ?1)",
                [now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO agent_runs
                 (id, session_id, source_id, external_run_id, task_title, status,
                  started_at, updated_at, ended_at)
                 VALUES ('run-a', 'sess-a', 'src-a', 'run-ext-1', '实现登录', 'completed',
                         ?1, ?1, ?1)",
                [now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at)
                 VALUES ('task-x', '任务 X', ?1, ?1)",
                [now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO task_agent_links
                 (id, task_id, source_id, session_external_id, run_external_id, created_at)
                 VALUES ('link-x', 'task-x', 'src-a', 'ext-a', NULL, ?1)",
                [now],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn handoff_save_links_agent_session_and_derives_availability() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        seed_agent_graph(&db, &now);

        let pack = dev_handoff_save_impl(
            &db,
            Some("task-x".into()),
            "交接".into(),
            "内容".into(),
            None,
            None,
            Some("src-a".into()),
            Some("ext-a".into()),
        )
        .unwrap();
        assert_eq!(pack.agent_source_id.as_deref(), Some("src-a"));
        assert_eq!(pack.agent_session_external_id.as_deref(), Some("ext-a"));
        assert_eq!(pack.agent_session_title.as_deref(), Some("会话 A"));
        assert!(pack.agent_session_available);

        // 列表查询同样携带派生字段（不是只写不读）
        let list = dev_handoff_list_impl(&db, Some("task-x".into()), None).unwrap();
        assert_eq!(list[0].agent_session_title.as_deref(), Some("会话 A"));
        assert!(list[0].agent_session_available);

        // 会话被删除：历史版本保留，available=false 且不猜测标题
        db.with_conn(|conn| {
            conn.execute("DELETE FROM agent_sessions WHERE id = 'sess-a'", [])
                .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let after = dev_handoff_get_impl(&db, &pack.id).unwrap();
        assert!(!after.agent_session_available);
        assert!(after.agent_session_title.is_none());
        assert_eq!(after.content_md, "内容");
        assert_eq!(after.agent_session_external_id.as_deref(), Some("ext-a"));
    }

    #[test]
    fn handoff_agent_session_requires_complete_pair_and_existing_session() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        seed_agent_graph(&db, &now);

        // 只给 source：形状不完整，写入前拒绝
        let err = dev_handoff_save_impl(
            &db,
            None,
            "交接".into(),
            "内容".into(),
            None,
            None,
            Some("src-a".into()),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");

        // 会话不存在：不以标题/前缀猜测身份
        let err = dev_handoff_save_impl(
            &db,
            None,
            "交接".into(),
            "内容".into(),
            None,
            None,
            Some("src-a".into()),
            Some("missing".into()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");

        // 失败不落库
        assert!(dev_handoff_list_impl(&db, None, None).unwrap().is_empty());
    }

    #[test]
    fn acceptance_records_agent_run_provenance_roundtrip_and_validation() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        seed_agent_graph(&db, &now);

        let rec = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "task-x".into(),
            "pass".into(),
            "人工核对通过".into(),
            None,
            Some("src-a".into()),
            Some("ext-a".into()),
            Some("run-ext-1".into()),
        )
        .unwrap();
        assert_eq!(rec.agent_source_id.as_deref(), Some("src-a"));
        assert_eq!(rec.agent_session_external_id.as_deref(), Some("ext-a"));
        assert_eq!(rec.agent_run_external_id.as_deref(), Some("run-ext-1"));

        let list = dev_acceptance_record_list_impl(
            &db,
            Some("task".into()),
            Some("task-x".into()),
            None,
        )
        .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].agent_run_external_id.as_deref(), Some("run-ext-1"));

        // 轮次不存在 → NOT_FOUND（不伪造「某轮次已验收」）
        let err = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "task-x".into(),
            "pass".into(),
            "x".into(),
            None,
            Some("src-a".into()),
            Some("ext-a".into()),
            Some("missing-run".into()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");

        // 三元组缺项 → VALIDATION_ERROR
        let err = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "task-x".into(),
            "pass".into(),
            "x".into(),
            None,
            Some("src-a".into()),
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");

        // 不关联轮次的历史写法仍然可用（三个字段全空）
        let plain = dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "task-x".into(),
            "fail".into(),
            "历史写法".into(),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(plain.agent_run_external_id.is_none());
    }

    #[test]
    fn agent_run_candidates_are_task_scoped_completed_only_and_mark_accepted() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        seed_agent_graph(&db, &now);

        // 同会话的 running 轮次与缺 external_run_id 的完成轮次都不进候选
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_runs
                 (id, session_id, source_id, external_run_id, task_title, status,
                  started_at, updated_at, ended_at)
                 VALUES ('run-live', 'sess-a', 'src-a', 'run-ext-live', '进行中', 'running',
                         ?1, ?1, NULL)",
                [&now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO agent_runs
                 (id, session_id, source_id, external_run_id, task_title, status,
                  started_at, updated_at, ended_at)
                 VALUES ('run-noext', 'sess-a', 'src-a', NULL, '无外部 ID', 'completed',
                         ?1, ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            // 未关联到任务的会话，即使完成也不属于本任务候选
            conn.execute(
                "INSERT INTO agent_sessions
                 (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-other', 'src-a', 'ext-other', '无关会话', 'idle', ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO agent_runs
                 (id, session_id, source_id, external_run_id, task_title, status,
                  started_at, updated_at, ended_at)
                 VALUES ('run-other', 'sess-other', 'src-a', 'run-ext-other', '无关', 'completed',
                         ?1, ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let out = dev_acceptance_agent_runs_impl(&db, "task-x".into(), None).unwrap();
        assert_eq!(out.runs.len(), 1, "只返回本任务关联会话的完成轮次");
        assert_eq!(out.runs[0].run_external_id, "run-ext-1");
        assert_eq!(out.runs[0].link_origin, "user");
        assert!(out.runs[0].accepted_record_id.is_none());
        assert!(!out.truncated);

        // 人工登记后：同一轮次标记已验收但仍返回（不隐藏历史）
        dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "task-x".into(),
            "pass".into(),
            "通过".into(),
            None,
            Some("src-a".into()),
            Some("ext-a".into()),
            Some("run-ext-1".into()),
        )
        .unwrap();
        let accepted = dev_acceptance_agent_runs_impl(&db, "task-x".into(), None).unwrap();
        assert_eq!(accepted.runs[0].accepted_verdict.as_deref(), Some("pass"));
        assert!(accepted.runs[0].accepted_record_id.is_some());

        // auto（导航目标影子关联）也作为真实关联链参与，并如实标注 origin
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO task_agent_links
                 (id, task_id, source_id, session_external_id, run_external_id, origin, created_at)
                 VALUES ('link-auto', 'task-x', 'src-a', 'ext-other', NULL, 'auto', ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let with_auto = dev_acceptance_agent_runs_impl(&db, "task-x".into(), None).unwrap();
        assert_eq!(with_auto.runs.len(), 2);
        let auto = with_auto
            .runs
            .iter()
            .find(|r| r.run_external_id == "run-ext-other")
            .expect("auto 关联轮次必须出现");
        assert_eq!(auto.link_origin, "auto");

        // limit 与截断提示
        let limited = dev_acceptance_agent_runs_impl(&db, "task-x".into(), Some(1)).unwrap();
        assert_eq!(limited.runs.len(), 1);
        assert!(limited.truncated, "超过 limit 必须如实标记 truncated");

        // 无关联任务为空；空 task_id 拒绝
        assert!(dev_acceptance_agent_runs_impl(&db, "task-other".into(), None)
            .unwrap()
            .runs
            .is_empty());
        let err = dev_acceptance_agent_runs_impl(&db, "  ".into(), None).unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
    }

    #[test]
    fn agent_run_candidates_include_handoff_bound_sessions_with_origin() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        // 只建交接包关联、不建 task_agent_links：完成轮次仍应进入候选
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('src-h', '来源 H', ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO agent_sessions
                 (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-h', 'src-h', 'ext-h', '交接包会话', 'idle', ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO agent_runs
                 (id, session_id, source_id, external_run_id, task_title, status,
                  started_at, updated_at, ended_at)
                 VALUES ('run-h', 'sess-h', 'src-h', 'run-ext-h', '交接包执行', 'completed',
                         ?1, ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at)
                 VALUES ('task-h', '任务 H', ?1, ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let pack = dev_handoff_save_impl(
            &db,
            Some("task-h".into()),
            "交接 H".into(),
            "内容".into(),
            None,
            None,
            Some("src-h".into()),
            Some("ext-h".into()),
        )
        .unwrap();
        assert!(pack.agent_session_available);

        let out = dev_acceptance_agent_runs_impl(&db, "task-h".into(), None).unwrap();
        assert_eq!(out.runs.len(), 1);
        assert_eq!(out.runs[0].run_external_id, "run-ext-h");
        assert_eq!(out.runs[0].link_origin, "handoff");

        // 同一会话同时有手工关联时，以 user 为最高优先级（不重复出两行）
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO task_agent_links
                 (id, task_id, source_id, session_external_id, run_external_id, origin, created_at)
                 VALUES ('link-h', 'task-h', 'src-h', 'ext-h', NULL, 'user', ?1)",
                [&now],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let merged = dev_acceptance_agent_runs_impl(&db, "task-h".into(), None).unwrap();
        assert_eq!(merged.runs.len(), 1, "同一会话不得重复出两行");
        assert_eq!(merged.runs[0].link_origin, "user");
    }
}
