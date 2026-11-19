//! 受控文件同步：扫描 `inbox/`、校验信封、导入、冲突检测与解决。
//!
//! 为什么不能「无差别双向监听」：Task Dock 自己写投影会产生写事件，若再把文件当输入就会
//! 无限回环。这里用四层事实区分来源：
//! 1) 只有 `inbox/`、`tasks/inbox/`、`knowledge/inbox/` 允许导入；
//! 2) 每个写入文件都登记 `exported_hash`，内容相同视为自身写入（跳过）；
//! 3) 导入前先占幂等声明（`agent_import_claims`），成功后归档到 `_imported/`；
//! 4) 文件**默认没有写权限**：先按目录策略判定，未授权只登记待审核请求。
//!
//! 审计与幂等是两条独立链路：业务写入成功但归档失败时，声明已置 `ok`，下一轮不会重复写入。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions::{self as perms, FileImportDecision, ImportIdentity};
use super::{
    handoff, service, store, validation, workspace, Identity, Principal, MAX_IMPORT_BYTES,
    MAX_SCAN_FILES,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportEnvelope {
    pub schema: String,
    pub kind: String,
    #[serde(default)]
    pub base_revision: Option<i64>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// 文件自称的 Agent。**不是认证凭据**，只用于审计与目录绑定校验。
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct ParsedDocument {
    pub envelope: ImportEnvelope,
    pub format: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ScanReport {
    pub scanned: u32,
    pub imported: u32,
    pub skipped: u32,
    pub failed: u32,
    pub conflicts: u32,
    /// 未授权/默认策略下等待人工批准的条数（不写业务表）。
    pub pending_review: u32,
    pub files: Vec<String>,
    pub messages: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncStatus {
    pub workspace: Option<workspace::WorkspaceStatus>,
    pub pending_imports: i64,
    pub conflicts: i64,
    pub pending_reviews: i64,
    pub last_error: Option<String>,
    pub recent_events: Vec<store::SyncEventRecord>,
}

/// 待审核的导入请求（只存元数据，正文留在共享目录）。
#[derive(Clone, Debug, Serialize)]
pub struct ImportRequest {
    pub id: String,
    pub workspace_row_id: String,
    pub rel_path: String,
    pub content_hash: String,
    pub kind: String,
    pub project_id: String,
    pub claimed_agent_id: String,
    pub status: String,
    pub reason: String,
    pub created_at: String,
    pub updated_at: String,
    pub decided_at: Option<String>,
    pub decided_by: String,
}

fn sha256(text: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 解析 JSON 信封或 Markdown（front matter）文档。
pub fn parse_external_document(raw: &str, path: &Path) -> AppResult<ParsedDocument> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "json" {
        let envelope: ImportEnvelope = serde_json::from_str(raw)?;
        if envelope.schema != "taskdock.import/1" {
            return Err(validation(format!(
                "schema 必须为 taskdock.import/1（当前 {}）",
                envelope.schema
            )));
        }
        validate_envelope(&envelope)?;
        return Ok(ParsedDocument {
            envelope,
            format: "json".into(),
        });
    }
    // Markdown：front matter + 正文
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let body_start = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| validation("Markdown 导入必须包含 --- front matter"))?;
    let end = body_start
        .find("\n---")
        .ok_or_else(|| validation("front matter 未闭合（缺少 --- 结束行）"))?;
    let front = &body_start[..end];
    let body = body_start[end + 4..].trim_start_matches(['\r', '\n']);
    let mut kind = String::new();
    let mut base_revision: Option<i64> = None;
    let mut project_id: Option<String> = None;
    let mut title: Option<String> = None;
    let mut agent_id: Option<String> = None;
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        match key {
            "kind" => kind = value.to_string(),
            "base_revision" => base_revision = value.parse().ok(),
            "project_id" => project_id = Some(value.to_string()),
            "title" => title = Some(value.to_string()),
            "agent_id" => agent_id = Some(value.to_string()),
            _ => {}
        }
    }
    if kind.is_empty() {
        return Err(validation("front matter 缺少 kind"));
    }
    // ID 标准：`taskdock_id` 是规范字段，`task_id` 作为唯一别名接受；
    // 两者同时出现且不一致时拒绝，避免长期无规则共存。
    let canonical_id = front_value(front, "taskdock_id");
    let alias_id = front_value(front, "task_id");
    let task_id = match (canonical_id, alias_id) {
        (Some(a), Some(b)) if a != b => {
            return Err(validation(
                "front matter 的 taskdock_id 与 task_id 不一致；请只保留 taskdock_id",
            ))
        }
        (Some(a), _) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let payload = match kind.as_str() {
        "knowledge.create" => json!({
            "title": title.unwrap_or_else(|| "未命名".into()),
            "content": body,
            "kb_id": front_value(front, "kb_id"),
        }),
        "decision.create" => json!({
            "title": title.unwrap_or_else(|| "未命名决策".into()),
            "decision": body,
            "context": front_value(front, "context").unwrap_or_default(),
        }),
        "task.create" => json!({
            "title": title.unwrap_or_else(|| "未命名任务".into()),
            "description": body,
        }),
        "task.update" => json!({
            "task_id": task_id.unwrap_or_default(),
            "title": title.unwrap_or_else(|| "未命名任务".into()),
            "description": body,
        }),
        "task.complete" => json!({ "task_id": task_id.unwrap_or_default() }),
        "handoff.create" => json!({
            "to_agent_id": front_value(front, "to_agent_id").unwrap_or_default(),
            "summary": title.unwrap_or_else(|| body.chars().take(200).collect()),
            "task_id": task_id,
        }),
        "report.create" => json!({
            "summary": title.unwrap_or_else(|| body.chars().take(200).collect()),
            "handoff_id": front_value(front, "handoff_id"),
            "task_id": task_id,
        }),
        _ => json!({ "content": body, "title": title, "task_id": task_id }),
    };
    let envelope = ImportEnvelope {
        schema: "taskdock.import/1".into(),
        kind,
        base_revision,
        project_id,
        agent_id,
        payload,
    };
    validate_envelope(&envelope)?;
    Ok(ParsedDocument {
        envelope,
        format: "markdown".into(),
    })
}

fn front_value(front: &str, key: &str) -> Option<String> {
    front.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim() == key {
            let value = v.trim().trim_matches('"').to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        } else {
            None
        }
    })
}

pub const KINDS: &[&str] = &[
    "task.create",
    "task.update",
    "task.complete",
    "knowledge.create",
    "decision.create",
    "handoff.create",
    "report.create",
];

fn validate_envelope(envelope: &ImportEnvelope) -> AppResult<()> {
    if !KINDS.contains(&envelope.kind.as_str()) {
        return Err(validation(format!(
            "kind 必须是 {} 之一（当前 {}）",
            KINDS.join("|"),
            envelope.kind
        )));
    }
    let payload = envelope
        .payload
        .as_object()
        .ok_or_else(|| validation("payload 必须是对象"))?;
    let require = |key: &str| -> AppResult<()> {
        payload
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
            .then_some(())
            .ok_or_else(|| validation(format!("payload 缺少非空字段 {key}")))
    };
    match envelope.kind.as_str() {
        "task.create" => require("title")?,
        "task.update" | "task.complete" => require("task_id")?,
        "knowledge.create" => {
            require("title")?;
            require("content")?;
        }
        "decision.create" => require("title")?,
        "handoff.create" => {
            require("to_agent_id")?;
            require("summary")?;
        }
        "report.create" => require("summary")?,
        _ => {}
    }
    let creates = matches!(
        envelope.kind.as_str(),
        "task.create" | "knowledge.create" | "decision.create" | "handoff.create" | "report.create"
    );
    if !creates && envelope.base_revision.is_none() {
        return Err(validation(
            "更新类导入必须提供 base_revision（否则视为静默覆盖）",
        ));
    }
    Ok(())
}

fn payload<'a>(doc: &'a ParsedDocument, key: &str) -> Option<&'a str> {
    doc.envelope.payload.get(key).and_then(|v| v.as_str())
}

fn payload_strings(doc: &ParsedDocument, key: &str) -> Vec<String> {
    doc.envelope
        .payload
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 导入目标项目：显式 project_id > payload.project_id > 任务所属项目。
/// 用于项目范围校验，不用于“猜”一个项目。
fn import_target_project(db: &Db, doc: &ParsedDocument) -> AppResult<String> {
    if let Some(pid) = doc
        .envelope
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Ok(pid.to_string());
    }
    if let Some(pid) = payload(doc, "project_id").map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(pid.to_string());
    }
    if let Some(task_id) = payload(doc, "task_id").filter(|v| !v.trim().is_empty()) {
        if let Some(pid) = db.with_read(|conn| perms::task_project(conn, task_id))? {
            return Ok(pid);
        }
    }
    Ok(String::new())
}

fn claimed_identity(doc: &ParsedDocument) -> ImportIdentity {
    match doc
        .envelope
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(id) => ImportIdentity::ClaimedAgent(id.to_string()),
        None => ImportIdentity::Unknown,
    }
}

/// 导入一份已通过校验的文档。返回一条可读摘要，供扫描报告展示。
///
/// 写入前再做一次能力预检（入口层可能已判过，但服务层不能依赖调用方）。
pub fn import_document(
    db: &Db,
    principal: &Principal,
    doc: &ParsedDocument,
) -> AppResult<String> {
    let kind = doc.envelope.kind.as_str();
    let capability = perms::resolve_import_capability(kind)
        .ok_or_else(|| validation(format!("未支持的导入类型: {kind}")))?;
    let project_id = import_target_project(db, doc)?;
    if let Some(grant) = principal.import.as_ref() {
        perms::check_import_project_scope(grant, &project_id)?;
    }
    let resource_id = payload(doc, "task_id").unwrap_or("");
    perms::require(db, principal, capability, resource_id)?;

    let base = doc.envelope.base_revision;
    match kind {
        "task.create" => {
            let input = service::TaskCreateInput {
                title: payload(doc, "title").unwrap_or_default().to_string(),
                description: payload(doc, "description").unwrap_or_default().to_string(),
                priority: doc
                    .envelope
                    .payload
                    .get("priority")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.min(3) as u8),
                category: payload(doc, "category").map(str::to_string),
                tags: payload_strings(doc, "tags").into(),
                due_at: payload(doc, "due_at").map(str::to_string),
                remind_at: payload(doc, "remind_at").map(str::to_string),
                advance_minutes: doc
                    .envelope
                    .payload
                    .get("advance_minutes")
                    .and_then(|v| v.as_i64()),
            };
            let task = service::create_task(db, principal, input)?;
            Ok(format!("创建任务 {}（{}）", task.id, task.title))
        }
        "task.update" => {
            let id = payload(doc, "task_id").unwrap_or_default();
            let patch = service::TaskPatch {
                title: payload(doc, "title").map(str::to_string),
                description: payload(doc, "description").map(str::to_string),
                priority: doc
                    .envelope
                    .payload
                    .get("priority")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.min(3) as u8),
                category: payload(doc, "category").map(str::to_string),
                tags: doc
                    .envelope
                    .payload
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    }),
                due_at: payload(doc, "due_at").map(str::to_string),
                clear_due_at: false,
                remind_at: payload(doc, "remind_at").map(str::to_string),
                clear_remind_at: false,
                advance_minutes: None,
            };
            let task = service::update_task(db, principal, id, patch, base)?;
            Ok(format!("更新任务 {}（revision 校验通过）", task.id))
        }
        "task.complete" => {
            let id = payload(doc, "task_id").unwrap_or_default();
            let task = service::complete_task(db, principal, id, base)?;
            Ok(format!("完成任务 {}（当前 {}）", task.id, task.status))
        }
        "knowledge.create" => {
            let input = service::KnowledgeCreateInput {
                title: payload(doc, "title").unwrap_or_default().to_string(),
                content: payload(doc, "content").unwrap_or_default().to_string(),
                kb_id: payload(doc, "kb_id").map(str::to_string),
                kb_name: payload(doc, "kb_name").map(str::to_string),
            };
            let document = service::create_knowledge(db, principal, input)?;
            Ok(format!("写入知识 {}（{}）", document.id, document.title))
        }
        "decision.create" => {
            let input = store::DecisionInput {
                title: payload(doc, "title").unwrap_or_default().to_string(),
                project_id: doc
                    .envelope
                    .project_id
                    .clone()
                    .or_else(|| payload(doc, "project_id").map(str::to_string)),
                project_kind: payload(doc, "project_kind").map(str::to_string),
                context: payload(doc, "context").unwrap_or_default().to_string(),
                decision: payload(doc, "decision").unwrap_or_default().to_string(),
                consequences: payload(doc, "consequences").unwrap_or_default().to_string(),
                alternatives: payload(doc, "alternatives").unwrap_or_default().to_string(),
                tags: payload_strings(doc, "tags"),
                status: payload(doc, "status").map(str::to_string),
            };
            let decision = store::create_decision(db, principal, input)?;
            Ok(format!("记录决策 {}（{}）", decision.id, decision.title))
        }
        "handoff.create" => {
            let input = store::HandoffInput {
                to_agent_id: payload(doc, "to_agent_id").unwrap_or_default().to_string(),
                summary: payload(doc, "summary").unwrap_or_default().to_string(),
                task_id: payload(doc, "task_id").map(str::to_string),
                project_id: doc
                    .envelope
                    .project_id
                    .clone()
                    .or_else(|| payload(doc, "project_id").map(str::to_string)),
                project_kind: payload(doc, "project_kind").map(str::to_string),
                completed_items: payload_strings(doc, "completed_items"),
                pending_items: payload_strings(doc, "pending_items"),
                decisions: Vec::new(),
                files_changed: payload_strings(doc, "files_changed"),
                risks: payload_strings(doc, "risks"),
                next_steps: payload_strings(doc, "next_steps"),
            };
            let created = handoff::create_handoff(db, principal, input)?;
            Ok(format!(
                "创建交接 {}（{} → {}）",
                created.handoff.id, created.handoff.from_agent_id, created.handoff.to_agent_id
            ))
        }
        "report.create" => {
            let input = store::ReportInput {
                summary: payload(doc, "summary").unwrap_or_default().to_string(),
                result: payload(doc, "result").map(str::to_string),
                handoff_id: payload(doc, "handoff_id").map(str::to_string),
                project_id: doc
                    .envelope
                    .project_id
                    .clone()
                    .or_else(|| payload(doc, "project_id").map(str::to_string)),
                task_id: payload(doc, "task_id").map(str::to_string),
                completed_items: payload_strings(doc, "completed_items"),
                pending_items: payload_strings(doc, "pending_items"),
                files_changed: payload_strings(doc, "files_changed"),
                evidence: doc
                    .envelope
                    .payload
                    .get("evidence")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
                risks: payload_strings(doc, "risks"),
            };
            let out = handoff::create_report(db, principal, input)?;
            Ok(format!("提交报告 {}（{}）", out.report.id, out.report.result))
        }
        other => Err(validation(format!("未支持的导入类型: {other}"))),
    }
}

/// 幂等键：请求身份 + 操作类型 + 请求标识（相对路径 + 内容 Hash）。
/// 单看内容 Hash 会把「不同文件、相同内容」误判为同一操作。
fn claim_key(rel_path: &str, kind: &str, hash: &str, actor: &str) -> String {
    let mut raw = String::new();
    for part in [rel_path, kind, hash, actor] {
        raw.push_str(part);
        raw.push('\u{1f}');
    }
    sha256(&raw)
}

/// 返回 true = 本次扫描取得执行权；false = 已有成功/进行中的同请求。
fn claim_import(
    db: &Db,
    workspace_row_id: &str,
    rel_path: &str,
    kind: &str,
    hash: &str,
    actor: &str,
) -> AppResult<bool> {
    let key = claim_key(rel_path, kind, hash, actor);
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT status FROM agent_import_claims
                 WHERE workspace_row_id = ?1 AND claim_key = ?2",
                rusqlite::params![workspace_row_id, key],
                |r| r.get(0),
            )
            .ok();
        match existing.as_deref() {
            Some("ok") => Ok(false),
            Some("inflight") => Ok(false),
            _ => {
                conn.execute(
                    "INSERT INTO agent_import_claims
                       (id, workspace_row_id, claim_key, rel_path, kind, content_hash, actor,
                        status, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,'inflight',?8,?8)
                     ON CONFLICT(workspace_row_id, claim_key) DO UPDATE SET
                       status='inflight', updated_at=excluded.updated_at",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        workspace_row_id,
                        key,
                        rel_path,
                        kind,
                        hash,
                        actor,
                        now,
                    ],
                )?;
                Ok(true)
            }
        }
    })
}

fn finish_claim(db: &Db, workspace_row_id: &str, rel_path: &str, kind: &str, hash: &str, actor: &str) {
    let key = claim_key(rel_path, kind, hash, actor);
    let _ = db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_import_claims SET status='ok', updated_at=?3
             WHERE workspace_row_id=?1 AND claim_key=?2",
            rusqlite::params![workspace_row_id, key, crate::agents::now_iso()],
        )?;
        Ok(())
    });
}

fn release_claim(db: &Db, workspace_row_id: &str, rel_path: &str, kind: &str, hash: &str, actor: &str) {
    let key = claim_key(rel_path, kind, hash, actor);
    let _ = db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM agent_import_claims WHERE workspace_row_id=?1 AND claim_key=?2",
            rusqlite::params![workspace_row_id, key],
        )?;
        Ok(())
    });
}

fn upsert_import_request(
    db: &Db,
    workspace_row_id: &str,
    rel_path: &str,
    hash: &str,
    doc: &ParsedDocument,
    project_id: &str,
    reason: &str,
) -> AppResult<()> {
    let now = crate::agents::now_iso();
    let detail = json!({
        "kind": doc.envelope.kind,
        "format": doc.format,
        "base_revision": doc.envelope.base_revision,
        "summary": doc.envelope.payload.get("title")
            .or_else(|| doc.envelope.payload.get("summary"))
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    });
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO agent_import_requests
               (id, workspace_row_id, rel_path, content_hash, kind, project_id, claimed_agent_id,
                status, reason, detail_json, created_at, updated_at, decided_at, decided_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?10,NULL,'')
             ON CONFLICT(workspace_row_id, rel_path) DO UPDATE SET
               content_hash=excluded.content_hash,
               kind=excluded.kind,
               project_id=excluded.project_id,
               claimed_agent_id=excluded.claimed_agent_id,
               reason=excluded.reason,
               detail_json=excluded.detail_json,
               updated_at=excluded.updated_at",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                workspace_row_id,
                rel_path,
                hash,
                doc.envelope.kind,
                project_id,
                doc.envelope.agent_id.as_deref().unwrap_or(""),
                reason,
                serde_json::to_string(&detail)?,
                now,
            ],
        )?;
        Ok(())
    })
}

pub fn list_import_requests(db: &Db, status: Option<&str>) -> AppResult<Vec<ImportRequest>> {
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_row_id, rel_path, content_hash, kind, project_id,
                    claimed_agent_id, status, reason, created_at, updated_at, decided_at, decided_by
             FROM agent_import_requests
             WHERE workspace_row_id = ?1 AND (?2 IS NULL OR status = ?2)
             ORDER BY created_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map(rusqlite::params![row.id, status], |r| {
            Ok(ImportRequest {
                id: r.get(0)?,
                workspace_row_id: r.get(1)?,
                rel_path: r.get(2)?,
                content_hash: r.get(3)?,
                kind: r.get(4)?,
                project_id: r.get(5)?,
                claimed_agent_id: r.get(6)?,
                status: r.get(7)?,
                reason: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
                decided_at: r.get(11)?,
                decided_by: r.get(12)?,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    })
}

fn get_import_request(db: &Db, id: &str) -> AppResult<ImportRequest> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT id, workspace_row_id, rel_path, content_hash, kind, project_id,
                    claimed_agent_id, status, reason, created_at, updated_at, decided_at, decided_by
             FROM agent_import_requests WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok(ImportRequest {
                    id: r.get(0)?,
                    workspace_row_id: r.get(1)?,
                    rel_path: r.get(2)?,
                    content_hash: r.get(3)?,
                    kind: r.get(4)?,
                    project_id: r.get(5)?,
                    claimed_agent_id: r.get(6)?,
                    status: r.get(7)?,
                    reason: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                    decided_at: r.get(11)?,
                    decided_by: r.get(12)?,
                })
            },
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound("导入请求不存在".into())
            }
            other => AppError::from(other),
        })
    })
}

fn set_import_request_status(
    db: &Db,
    id: &str,
    status: &str,
    reason: &str,
    decided_by: &str,
) -> AppResult<()> {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_import_requests
             SET status=?2, reason=?3, decided_at=?4, decided_by=?5, updated_at=?4
             WHERE id=?1",
            rusqlite::params![id, status, reason, now, decided_by],
        )?;
        Ok(())
    })
}

/// 扫描上下文：谁触发的扫描。文件本身不会触发扫描。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanActor {
    /// UI 手动扫描：仍走同一策略，不因“人点了按钮”就自动批准。
    LocalUi,
    /// 后台监听 / 系统维护。
    System,
}

fn scan_actor(principal: &Principal) -> AppResult<ScanActor> {
    match principal.identity {
        Identity::LocalHuman => Ok(ScanActor::LocalUi),
        Identity::SystemInternal => Ok(ScanActor::System),
        Identity::RegisteredAgent => Err(AppError::Forbidden(
            "Agent 不能触发目录扫描；请使用 sync/scan 之外的单条导入接口".into(),
        )),
        Identity::FileImport => Err(AppError::Forbidden(
            "文件导入不能触发扫描（避免自授权循环）".into(),
        )),
    }
}

/// 扫描并导入。策略判定与人工批准共用 `authorize_file_import` / `import_document`。
pub fn scan(db: &Db, actor: &Principal, row: &workspace::WorkspaceRow) -> AppResult<ScanReport> {
    let _actor_kind = scan_actor(actor)?;
    let root = PathBuf::from(&row.root_path);
    if !root.join(super::WORKSPACE_MARKER).exists() {
        return Err(AppError::NotFound("工作空间缺少标记文件，拒绝扫描".into()));
    }
    let mut report = ScanReport::default();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for dir in workspace::IMPORT_DIRS {
        let base = root.join(dir.replace('/', std::path::MAIN_SEPARATOR_STR));
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !path.is_file() || name.starts_with('.') {
                continue;
            }
            files.push((format!("{dir}/{name}"), path));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.truncate(MAX_SCAN_FILES);
    let imported_dir = root.join("inbox").join("_imported");
    let _ = fs::create_dir_all(&imported_dir);
    let rejected_dir = root.join("inbox").join("_rejected");
    let _ = fs::create_dir_all(&rejected_dir);
    let now = crate::agents::now_iso();

    for (rel, path) in files {
        report.scanned += 1;
        let meta = fs::metadata(&path);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        if size > MAX_IMPORT_BYTES {
            report.failed += 1;
            report.messages.push(format!("{rel}: 超过 256KiB 上限"));
            workspace::log_event(
                db, &row.id, "import", "too_large", &rel, "", "", "failed",
                "超过单文件大小上限", None, "",
            );
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(err) => {
                report.failed += 1;
                report.messages.push(format!("{rel}: 读取失败 {err}"));
                continue;
            }
        };
        let hash = sha256(&raw);
        let doc = match parse_external_document(&raw, &path) {
            Ok(doc) => doc,
            Err(err) => {
                report.failed += 1;
                report
                    .messages
                    .push(format!("{rel}: {}", err.user_message()));
                workspace::log_event(
                    db, &row.id, "import", "invalid", &rel, "", "", "failed",
                    &err.user_message(), None, "",
                );
                // 非法信封归档到失败区，避免每轮扫描重复报错、阻塞 pending 计数。
                let _ = archive_if_unchanged(&path, &rejected_dir, &now, &hash);
                continue;
            }
        };
        let kind = doc.envelope.kind.clone();
        let Some(capability) = perms::resolve_import_capability(&kind) else {
            report.failed += 1;
            report.messages.push(format!("{rel}: 未支持的导入类型 {kind}"));
            let _ = archive_if_unchanged(&path, &rejected_dir, &now, &hash);
            continue;
        };
        let project_id = match import_target_project(db, &doc) {
            Ok(pid) => pid,
            Err(err) => {
                report.failed += 1;
                report.messages.push(format!("{rel}: {}", err.user_message()));
                continue;
            }
        };
        let identity = claimed_identity(&doc);
        let decision = perms::authorize_file_import(
            db,
            &row.id,
            &rel,
            &identity,
            capability,
            &project_id,
        )?;
        let import_principal = match decision {
            FileImportDecision::Allowed(principal) => principal,
            FileImportDecision::NeedsReview { reason, .. } => {
                report.pending_review += 1;
                report
                    .messages
                    .push(format!("{rel}: 待人工批准（{reason}）"));
                if let Err(err) =
                    upsert_import_request(db, &row.id, &rel, &hash, &doc, &project_id, &reason)
                {
                    report.failed += 1;
                    report
                        .messages
                        .push(format!("{rel}: 待审核记录写入失败 {}", err.user_message()));
                }
                workspace::log_event(
                    db, &row.id, "import", "pending_review", &rel, &kind, "", "skipped",
                    &reason, doc.envelope.base_revision, "",
                );
                // 文件保留在 Inbox，人工批准时按原路径重新读取。
                continue;
            }
            FileImportDecision::Rejected { reason, .. } => {
                report.failed += 1;
                report.messages.push(format!("{rel}: 拒绝（{reason}）"));
                workspace::log_event(
                    db, &row.id, "import", "rejected", &rel, &kind, "", "failed",
                    &reason, doc.envelope.base_revision, "",
                );
                let _ = archive_if_unchanged(&path, &rejected_dir, &now, &hash);
                continue;
            }
        };
        let actor_label = import_principal.label();
        if !claim_import(db, &row.id, &rel, &kind, &hash, &actor_label)? {
            report.skipped += 1;
            report.messages.push(format!("{rel}: 相同请求已导入，跳过"));
            let _ = archive_if_unchanged(&path, &imported_dir, &now, &hash);
            continue;
        }
        match import_document(db, &import_principal, &doc) {
            Ok(message) => {
                finish_claim(db, &row.id, &rel, &kind, &hash, &actor_label);
                report.imported += 1;
                report.files.push(rel.clone());
                report.messages.push(format!("{rel}: {message}"));
                let _ = db.with_conn(|conn| {
                    store::record_sync_event(
                        conn,
                        &store::SyncEvent {
                            workspace_row_id: &row.id,
                            direction: "import",
                            event_kind: &kind,
                            rel_path: &rel,
                            resource_kind: doc.envelope.kind.split('.').next().unwrap_or(""),
                            resource_id: doc
                                .envelope
                                .payload
                                .get("task_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            revision: doc.envelope.base_revision,
                            status: "ok",
                            message: &message,
                            content_hash: &hash,
                            request_id: "",
                        },
                    )
                });
                if let Err(err) = archive_if_unchanged(&path, &imported_dir, &now, &hash) {
                    // 业务已成功：不能回滚，也不能让下一轮重复写入（claim 已 ok）。
                    report.messages.push(format!(
                        "{rel}: 已导入但归档失败（{err}）；后续扫描不会重复写入"
                    ));
                    workspace::log_event(
                        db, &row.id, "import", "archive_failed", &rel, &kind, "", "failed",
                        &format!("导入成功但归档失败: {err}"), doc.envelope.base_revision, "",
                    );
                }
            }
            Err(err) => {
                release_claim(db, &row.id, &rel, &kind, &hash, &actor_label);
                if let AppError::Conflict(_) = &err {
                    report.conflicts += 1;
                    report
                        .messages
                        .push(format!("{rel}: 冲突 {}", err.user_message()));
                    let current_revision = doc
                        .envelope
                        .payload
                        .get("task_id")
                        .and_then(|v| v.as_str())
                        .and_then(|task_id| service::task_version(db, task_id).ok())
                        .map(|(rev, _)| rev)
                        .unwrap_or(0);
                    let conflict = store::SyncConflict {
                        id: uuid::Uuid::new_v4().to_string(),
                        rel_path: rel.clone(),
                        resource_kind: kind.clone(),
                        resource_id: doc
                            .envelope
                            .payload
                            .get("task_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        db_revision: current_revision,
                        file_revision: doc.envelope.base_revision.unwrap_or(0),
                        db_hash: String::new(),
                        file_hash: hash.clone(),
                        status: "open".into(),
                        resolution: String::new(),
                        detail_json: serde_json::to_string(&json!({
                            "kind": kind,
                            "message": err.user_message(),
                            "project_id": project_id,
                        }))
                        .unwrap_or_else(|_| "{}".into()),
                        detected_at: now.clone(),
                        resolved_at: None,
                    };
                    let _ =
                        db.with_conn(|conn| store::upsert_conflict(conn, &row.id, &conflict));
                    workspace::log_event(
                        db,
                        &row.id,
                        "import",
                        "conflict",
                        &rel,
                        "",
                        "",
                        "conflict",
                        &err.user_message(),
                        doc.envelope.base_revision,
                        "",
                    );
                } else {
                    report.failed += 1;
                    report.messages.push(format!("{rel}: {}", err.user_message()));
                    workspace::log_event(
                        db,
                        &row.id,
                        "import",
                        "failed",
                        &rel,
                        "",
                        "",
                        "failed",
                        &err.user_message(),
                        doc.envelope.base_revision,
                        "",
                    );
                }
            }
        }
    }
    workspace::touch_scan(db, &row.id, &now)?;
    if report.imported > 0 || report.conflicts > 0 {
        workspace::touch_import(db, &row.id, &now)?;
    }
    Ok(report)
}

/// 人工批准单次导入。只有显式可信本机身份可调用。
/// 批准后仍走 `import_document` 的完整校验，不会获得超出该 kind 的能力。
pub fn approve_import(
    db: &Db,
    approver: &Principal,
    request_id: &str,
    note: &str,
) -> AppResult<String> {
    if !approver.is_trusted_local() {
        return Err(AppError::Forbidden("只有本机用户可以批准文件导入".into()));
    }
    let request = get_import_request(db, request_id)?;
    if request.status != "pending" {
        return Err(AppError::Conflict(format!(
            "导入请求状态为 {}，不能重复批准",
            request.status
        )));
    }
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    if row.id != request.workspace_row_id {
        return Err(AppError::NotFound("导入请求不属于当前工作空间".into()));
    }
    let root = PathBuf::from(&row.root_path);
    let path = root.join(request.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let raw = fs::read_to_string(&path)
        .map_err(|err| AppError::Validation(format!("导入文件不可读: {err}")))?;
    let hash = sha256(&raw);
    if hash != request.content_hash {
        set_import_request_status(
            db,
            &request.id,
            "failed",
            "文件内容在待审核期间已变化，请人工重新检查",
            &approver.label(),
        )?;
        return Err(AppError::Conflict(
            "文件内容已变化，拒绝按旧内容批准".into(),
        ));
    }
    let doc = parse_external_document(&raw, &path)?;
    if doc.envelope.kind != request.kind {
        set_import_request_status(
            db,
            &request.id,
            "failed",
            "kind 与待审核记录不一致",
            &approver.label(),
        )?;
        return Err(AppError::Validation("文件 kind 与待审核记录不一致".into()));
    }
    let capability = perms::resolve_import_capability(&doc.envelope.kind)
        .ok_or_else(|| validation("未支持的导入类型"))?;
    let project_id = import_target_project(db, &doc)?;
    let grant = perms::manual_import_grant(capability, &project_id, &approver.label());
    let principal = Principal::file_import_granted(grant, doc.envelope.agent_id.as_deref().unwrap_or(""));
    let actor_label = principal.label();
    if !claim_import(
        db,
        &row.id,
        &request.rel_path,
        &request.kind,
        &request.content_hash,
        &actor_label,
    )? {
        set_import_request_status(db, &request.id, "imported", "相同请求此前已导入", &approver.label())?;
        return Ok("相同内容此前已导入，未重复写入".into());
    }
    match import_document(db, &principal, &doc) {
        Ok(message) => {
            finish_claim(
                db,
                &row.id,
                &request.rel_path,
                &request.kind,
                &request.content_hash,
                &actor_label,
            );
            let note = if note.trim().is_empty() {
                message.clone()
            } else {
                format!("{message}；批准备注：{note}")
            };
            set_import_request_status(db, &request.id, "imported", &note, &approver.label())?;
            let _ = db.with_conn(|conn| {
                store::record_sync_event(
                    conn,
                    &store::SyncEvent {
                        workspace_row_id: &row.id,
                        direction: "import",
                        event_kind: &request.kind,
                        rel_path: &request.rel_path,
                        resource_kind: request.kind.split('.').next().unwrap_or(""),
                        resource_id: doc
                            .envelope
                            .payload
                            .get("task_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                        revision: doc.envelope.base_revision,
                        status: "ok",
                        message: &format!("人工批准：{message}"),
                        content_hash: &request.content_hash,
                        request_id: &request.id,
                    },
                )
            });
            workspace::log_event(
                db,
                &row.id,
                "import",
                "approved",
                &request.rel_path,
                &request.kind,
                "",
                "ok",
                &format!("人工批准（{}）", approver.label()),
                doc.envelope.base_revision,
                "",
            );
            let _ = archive_if_unchanged(&path, &root.join("inbox").join("_imported"), &crate::agents::now_iso(), &hash);
            Ok(message)
        }
        Err(err) => {
            release_claim(
                db,
                &row.id,
                &request.rel_path,
                &request.kind,
                &request.content_hash,
                &actor_label,
            );
            set_import_request_status(
                db,
                &request.id,
                "failed",
                &err.user_message(),
                &approver.label(),
            )?;
            Err(err)
        }
    }
}

/// 人工拒绝：保留文件到 `_rejected/`，可追溯拒绝原因。
pub fn reject_import(
    db: &Db,
    approver: &Principal,
    request_id: &str,
    reason: &str,
) -> AppResult<()> {
    if !approver.is_trusted_local() {
        return Err(AppError::Forbidden("只有本机用户可以拒绝文件导入".into()));
    }
    let request = get_import_request(db, request_id)?;
    if request.status != "pending" {
        return Err(AppError::Conflict("该导入请求已被处理".into()));
    }
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    let root = PathBuf::from(&row.root_path);
    let path = root.join(request.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let reason = if reason.trim().is_empty() {
        "人工拒绝"
    } else {
        reason.trim()
    };
    set_import_request_status(db, &request.id, "rejected", reason, &approver.label())?;
    workspace::log_event(
        db,
        &row.id,
        "import",
        "rejected_by_human",
        &request.rel_path,
        &request.kind,
        "",
        "failed",
        reason,
        None,
        "",
    );
    let hash = fs::read_to_string(&path).map(|raw| sha256(&raw)).unwrap_or_default();
    if !hash.is_empty() {
        let _ = archive_if_unchanged(
            &path,
            &root.join("inbox").join("_rejected"),
            &crate::agents::now_iso(),
            &hash,
        );
    }
    Ok(())
}

fn archive_if_unchanged(
    path: &Path,
    imported_dir: &Path,
    now: &str,
    expected_hash: &str,
) -> std::io::Result<()> {
    let current = fs::read_to_string(path)?;
    if sha256(&current) != expected_hash {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "文件在扫描过程中发生变化，保留原文件待下一轮处理",
        ));
    }
    archive(path, imported_dir, now)
}

fn archive(path: &Path, imported_dir: &Path, now: &str) -> std::io::Result<()> {
    let stamp = now.replace([':', '.', '+'], "-");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "import".into());
    let target = imported_dir.join(format!("{stamp}-{name}"));
    fs::create_dir_all(imported_dir)?;
    fs::rename(path, &target).or_else(|_| {
        fs::copy(path, &target)?;
        fs::remove_file(path)
    })
}

pub fn status(db: &Db) -> AppResult<SyncStatus> {
    let row = workspace::active(db)?;
    let Some(row) = row else {
        return Ok(SyncStatus {
            workspace: None,
            pending_imports: 0,
            conflicts: 0,
            pending_reviews: 0,
            last_error: None,
            recent_events: Vec::new(),
        });
    };
    let ws = workspace::status(db)?;
    let pending = ws.as_ref().map(|w| w.pending_imports).unwrap_or(0);
    let conflicts = store::list_conflicts(db, &row.id)?
        .into_iter()
        .filter(|c| c.status == "open")
        .count() as i64;
    let pending_reviews = list_import_requests(db, Some("pending"))
        .map(|items| items.len() as i64)
        .unwrap_or(0);
    let events = store::list_sync_events(db, &row.id, 20)?;
    let last_error = events
        .iter()
        .find(|event| event.status == "failed" || event.status == "conflict")
        .map(|event| format!("{}: {}", event.rel_path, event.message));
    Ok(SyncStatus {
        workspace: ws,
        pending_imports: pending,
        conflicts,
        pending_reviews,
        last_error,
        recent_events: events,
    })
}

pub fn list_conflicts(db: &Db) -> AppResult<Vec<store::SyncConflict>> {
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    store::list_conflicts(db, &row.id)
}

/// 冲突归属的工作空间（`SyncConflict` 本身不携带该列）。
fn conflict_workspace(db: &Db, id: &str) -> AppResult<String> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT workspace_row_id FROM agent_sync_conflicts WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("冲突不存在".into()),
            other => AppError::from(other),
        })
    })
}

/// 冲突的资源类型 → 真实写能力。冲突表里的 `resource_kind` 存的是导入 kind
/// （`task.update` / `knowledge.create`），不能一律按 TasksWrite 判定。
pub fn capability_for_conflict(resource_kind: &str) -> AppResult<Capability> {
    let family = resource_kind.split('.').next().unwrap_or(resource_kind);
    match family {
        "task" => Ok(Capability::TasksWrite),
        "knowledge" => Ok(Capability::KnowledgeWrite),
        "decision" => Ok(Capability::DecisionsWrite),
        "handoff" | "report" => Ok(Capability::HandoffsWrite),
        other => Err(validation(format!(
            "冲突资源类型不支持自动解决: {other}"
        ))),
    }
}

pub fn conflict_detail(db: &Db, id: &str) -> AppResult<Value> {
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    let conflict = store::get_conflict(db, id)?;
    if conflict_workspace(db, id)? != row.id {
        return Err(AppError::NotFound("冲突不属于当前工作空间".into()));
    }
    let path = PathBuf::from(&row.root_path)
        .join(conflict.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let file_content = fs::read_to_string(&path).ok();
    Ok(json!({
        "conflict": conflict,
        "file_exists": path.exists(),
        "file_content": file_content,
        "capability": capability_for_conflict(&conflict.resource_kind).ok().map(|cap| cap.as_str()),
        "allowed_resolutions": ["db", "file", "dismiss"],
    }))
}

/// 人工解决冲突：
/// - `db`：保留数据库版本，删除外部文件；
/// - `dismiss`：仅关闭冲突记录，文件保留供人工处理；
/// - `file`：用当前版本作为 base 重新导入（明确表示接受外部内容）。
///
/// 任何一步失败都不会把冲突标记为已解决；文件读取失败不删除文件。
pub fn resolve_conflict(
    db: &Db,
    principal: &Principal,
    id: &str,
    resolution: &str,
) -> AppResult<store::SyncConflict> {
    let resolution = resolution.trim();
    if !matches!(resolution, "db" | "file" | "dismiss") {
        return Err(validation(format!(
            "resolution 必须是 db|file|dismiss（当前 {resolution}）"
        )));
    }
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    let conflict = store::get_conflict(db, id)?;
    if conflict_workspace(db, id)? != row.id {
        return Err(AppError::NotFound("冲突不属于当前工作空间".into()));
    }
    if conflict.status != "open" {
        return Err(AppError::Conflict(format!(
            "冲突状态为 {}，不能重复解决",
            conflict.status
        )));
    }
    let capability = capability_for_conflict(&conflict.resource_kind)?;
    perms::require(db, principal, capability, &conflict.resource_id)?;
    let root = PathBuf::from(&row.root_path);
    let path = root.join(conflict.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    match resolution {
        "db" => {
            if path.exists() {
                fs::remove_file(&path).map_err(|err| {
                    AppError::Io(std::io::Error::new(
                        err.kind(),
                        format!("保留数据库版本失败：无法删除外部文件: {err}"),
                    ))
                })?;
            }
        }
        "dismiss" => {}
        "file" => {
            let raw = fs::read_to_string(&path)
                .map_err(|e| validation(format!("冲突文件不可读: {e}")))?;
            let hash = sha256(&raw);
            if !conflict.file_hash.is_empty() && hash != conflict.file_hash {
                return Err(AppError::Conflict(
                    "冲突文件在检测后已变化，请刷新冲突列表后重新处理".into(),
                ));
            }
            let mut doc = parse_external_document(&raw, &path)?;
            if doc.envelope.kind != conflict.resource_kind {
                return Err(AppError::Conflict("冲突文件类型与记录不一致".into()));
            }
            // 目标必须仍然存在，否则“接受外部版本”会变成创建另一条资源。
            if let Some(task_id) = doc.envelope.payload.get("task_id").and_then(|v| v.as_str()) {
                service::fetch_task(db, principal, task_id)?;
                let current = service::task_version(db, task_id)?.0;
                doc.envelope.base_revision = Some(current);
            } else if doc.envelope.kind.starts_with("knowledge.") {
                let id = doc
                    .envelope
                    .payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| validation("知识冲突缺少文档 ID"))?;
                service::get_knowledge(db, principal, id)?;
            }
            // 重新检查权限（外部内容可能指向另一个项目/资源）。
            perms::require(db, principal, capability, &conflict.resource_id)?;
            import_document(db, principal, &doc)?;
            if path.exists() {
                fs::remove_file(&path).map_err(|err| {
                    AppError::Io(std::io::Error::new(
                        err.kind(),
                        format!("导入成功但删除冲突文件失败: {err}"),
                    ))
                })?;
            }
        }
        _ => unreachable!(),
    }
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_sync_conflicts SET status=?2, resolution=?3, resolved_at=?4 WHERE id=?1",
            rusqlite::params![
                id,
                match resolution {
                    "db" => "resolved_db",
                    "file" => "resolved_file",
                    _ => "dismissed",
                },
                resolution,
                crate::agents::now_iso()
            ],
        )?;
        Ok(())
    })?;
    // 刷新投影状态：该路径不再被视为已同步，下一次导出会重写。
    if resolution == "file" {
        let _ = db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM agent_workspace_files WHERE workspace_row_id=?1 AND rel_path=?2",
                rusqlite::params![row.id, conflict.rel_path],
            )?;
            Ok(())
        });
    }
    workspace::log_event(
        db,
        &row.id,
        "resolve",
        "conflict",
        &conflict.rel_path,
        &conflict.resource_kind,
        &conflict.resource_id,
        "ok",
        &format!("解决方式 {resolution}"),
        None,
        "",
    );
    store::get_conflict(db, id)
}

/// 便捷：当前工作空间根目录（初始化后才有）。
pub fn root_path(db: &Db) -> AppResult<PathBuf> {
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    Ok(PathBuf::from(row.root_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_task_update_carries_task_id() {
        let raw = "---\nkind: task.update\ntaskdock_id: task-1\nbase_revision: 3\ntitle: 新标题\n---\n更新后的描述\n";
        let doc = parse_external_document(raw, Path::new("inbox/a.md")).unwrap();
        assert_eq!(doc.envelope.kind, "task.update");
        assert_eq!(payload(&doc, "task_id").as_deref(), Some("task-1"));
        assert_eq!(payload(&doc, "title").as_deref(), Some("新标题"));
        assert_eq!(payload(&doc, "description").as_deref(), Some("更新后的描述"));
        assert_eq!(doc.envelope.base_revision, Some(3));
    }

    #[test]
    fn markdown_task_update_requires_base_revision() {
        let raw = "---\nkind: task.update\ntaskdock_id: task-1\ntitle: 新标题\n---\n正文\n";
        let err = parse_external_document(raw, Path::new("inbox/a.md")).unwrap_err();
        assert!(err.user_message().contains("base_revision"));
    }

    #[test]
    fn conflicting_id_fields_are_rejected() {
        let raw = "---\nkind: task.update\ntaskdock_id: a\ntask_id: b\nbase_revision: 1\n---\nx\n";
        let err = parse_external_document(raw, Path::new("inbox/a.md")).unwrap_err();
        assert!(err.user_message().contains("不一致"));
    }

    #[test]
    fn conflict_capability_follows_resource_family() {
        assert_eq!(
            capability_for_conflict("knowledge.create").unwrap(),
            Capability::KnowledgeWrite
        );
        assert_eq!(
            capability_for_conflict("decision.create").unwrap(),
            Capability::DecisionsWrite
        );
        assert_eq!(
            capability_for_conflict("handoff.create").unwrap(),
            Capability::HandoffsWrite
        );
        assert!(capability_for_conflict("unknown.create").is_err());
    }
}
