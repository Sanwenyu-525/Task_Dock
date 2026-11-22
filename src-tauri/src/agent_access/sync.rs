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

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions::{self as perms, FileImportDecision, ImportIdentity};
use super::{
    forbidden, handoff, operations, service, store, validation, workspace, Identity, ImportGrant,
    Principal, MAX_IMPORT_BYTES, MAX_SCAN_FILES,
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

pub(crate) fn sha256(text: &str) -> String {
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
    let body = body_start[end + 4..]
        .trim_start_matches(['\r', '\n'])
        .trim_end_matches(['\r', '\n']);
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

/// 文件声明的项目（`envelope.project_id` / `payload.project_id`）。
///
/// **只用于一致性校验与审计，不得用于权限判定**——命名即约束。v81 的
/// `import_target_project()` 先信任这里的值，导致「伪造 project_id」即可越过项目边界。
fn declared_project(doc: &ParsedDocument) -> String {
    if let Some(pid) = doc
        .envelope
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return pid.to_string();
    }
    payload(doc, "project_id")
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|item| !item.trim().is_empty())
}

/// 按**真实数据库**推导资源的项目归属。查不到就是 `None`，不猜。
///
/// - task → `workspace_task_links`（`perms::task_project`）；
/// - decision → `agent_decisions.project_id`；
/// - handoff → `agent_handoffs.project_id`；
/// - report → 报告自身归属，回退到其 handoff 的项目；
/// - knowledge → 文档 → 知识库 → 项目（创建阶段用载荷 `kb_id`）。
fn resource_project(
    db: &Db,
    kind: &str,
    doc: &ParsedDocument,
    resource_id: &str,
) -> AppResult<Option<String>> {
    let family = kind.split('.').next().unwrap_or(kind);
    let explicit = resource_id.trim();
    // 显式资源 ID 优先，其次才是载荷里的同义字段。
    let pick = |keys: &[&str]| -> String {
        if !explicit.is_empty() {
            return explicit.to_string();
        }
        keys.iter()
            .find_map(|key| payload(doc, key))
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    match family {
        "task" => {
            let id = pick(&["task_id"]);
            if id.is_empty() {
                return Ok(None);
            }
            db.with_read(|conn| perms::task_project(conn, &id))
        }
        "decision" => {
            let id = pick(&["decision_id", "id"]);
            if id.is_empty() {
                return Ok(None);
            }
            db.with_read(|conn| {
                Ok(non_empty(
                    conn.query_row(
                        "SELECT project_id FROM agent_decisions WHERE id = ?1",
                        rusqlite::params![id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?,
                ))
            })
        }
        "handoff" => {
            let id = pick(&["handoff_id", "id"]);
            if id.is_empty() {
                return Ok(None);
            }
            db.with_read(|conn| {
                Ok(non_empty(
                    conn.query_row(
                        "SELECT project_id FROM agent_handoffs WHERE id = ?1",
                        rusqlite::params![id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?,
                ))
            })
        }
        "report" => {
            let id = pick(&["report_id", "id"]);
            if id.is_empty() {
                return Ok(None);
            }
            db.with_read(|conn| {
                Ok(non_empty(
                    conn.query_row(
                        "SELECT COALESCE(NULLIF(r.project_id, ''), h.project_id)
                         FROM agent_work_reports r
                         LEFT JOIN agent_handoffs h ON h.id = r.handoff_id
                         WHERE r.id = ?1",
                        rusqlite::params![id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten(),
                ))
            })
        }
        "knowledge" => {
            let doc_id = pick(&["document_id", "id"]);
            db.with_read(|conn| {
                if !doc_id.is_empty() {
                    let from_doc: Option<String> = conn
                        .query_row(
                            "SELECT kb.project_id FROM knowledge_documents d
                             JOIN knowledge_bases kb ON kb.id = d.kb_id
                             WHERE d.id = ?1",
                            rusqlite::params![doc_id],
                            |r| r.get::<_, Option<String>>(0),
                        )
                        .optional()?
                        .flatten();
                    if let Some(pid) = non_empty(from_doc) {
                        return Ok(Some(pid));
                    }
                }
                let kb_id = payload(doc, "kb_id").map(str::trim).unwrap_or("");
                if kb_id.is_empty() {
                    return Ok(None);
                }
                let from_kb: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM knowledge_bases WHERE id = ?1",
                        rusqlite::params![kb_id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten();
                Ok(non_empty(from_kb))
            })
        }
        _ => Ok(None),
    }
}

/// 一次导入的**有效归属项目**：权限判定与业务落库都只能用它。
///
/// - 更新类（`task.update` / `task.complete`）：必须有数据库推导出的真实归属；
///   查不到 → `forbidden`；文件声明与真实不一致 → `forbidden`；返回真实归属。
/// - 创建类：授权限定项目 → 返回 `grant.project_id`（声明不一致 → `forbidden`）；
///   全局授权 → 用文件声明（`report.create` 由 handoff 推导）。
pub(crate) fn effective_import_project(
    db: &Db,
    grant: Option<&ImportGrant>,
    kind: &str,
    doc: &ParsedDocument,
) -> AppResult<String> {
    let declared = declared_project(doc);
    let scope = grant
        .map(|item| item.project_id.trim().to_string())
        .unwrap_or_default();
    let is_update = matches!(kind, "task.update" | "task.complete");

    if is_update {
        let real = non_empty(resource_project(db, kind, doc, "")?);
        let Some(grant) = grant else {
            // 本机/内部主体：归属以业务层的 NotFound 为准，这里只给能算到的值。
            return Ok(real.unwrap_or(declared));
        };
        let real = real.ok_or_else(|| {
            forbidden(format!(
                "无法确定 {kind} 目标的真实项目归属；项目授权下不允许写入无归属资源"
            ))
        })?;
        if !declared.is_empty() && declared != real {
            return Err(forbidden(format!(
                "文件声明的 project_id={declared} 与资源真实归属 {real} 不一致"
            )));
        }
        perms::check_import_project_scope(grant, &real)?;
        return Ok(real);
    }

    // 授权限定项目（`grant = None` 时 scope 为空，等价于全局授权）。
    if !scope.is_empty() {
        if !declared.is_empty() && declared != scope {
            return Err(forbidden(format!(
                "导入授权仅允许项目 {scope}（文件声明 {declared}）"
            )));
        }
        // 创建类也要校验「借壳」：载荷指向的资源（如 kb_id / handoff_id）若已属其他项目，一律拒绝。
        if let Some(real) = non_empty(resource_project(db, kind, doc, "")?) {
            if real != scope {
                return Err(forbidden(format!(
                    "导入授权仅允许项目 {scope}（目标资源属于 {real}）"
                )));
            }
        }
        // 报告的真实归属来自 handoff：必须与授权项目一致，
        // 否则「声明项目 = 授权项目、handoff 属于别的项目」就能跨项目写报告。
        if kind == "report.create" {
            if let Some(real) = handoff_project(db, doc)? {
                if real != scope {
                    return Err(forbidden(format!(
                        "导入授权仅允许项目 {scope}（交接属于 {real}）"
                    )));
                }
            }
        }
        return Ok(scope);
    }

    // 全局授权：创建类用文件声明；报告优先由 handoff 推导（P2-2 由 Agent D 收紧）。
    if kind == "report.create" {
        if let Some(real) = handoff_project(db, doc)? {
            if !declared.is_empty() && declared != real {
                return Err(forbidden(format!(
                    "文件声明的 project_id={declared} 与交接所属项目 {real} 不一致"
                )));
            }
            return Ok(real);
        }
    }
    Ok(declared)
}

/// 报告所关联交接的真实项目归属（`agent_handoffs.project_id`）。
///
/// 报告的归属**只能**来自 handoff：文件声明的 `project_id` 不构成授权依据。
/// 「报告归属 → 授权项目」的比较必须在项目根域上进行：历史交接行可能仍以
/// 计划 ID 归属（v92 之前写入），这里先解析为项目根；解析不出（项目已删除/
/// 悬空旧行）保持现行为返回原值，由导入链路的存在性校验拒绝。
fn handoff_project(db: &Db, doc: &ParsedDocument) -> AppResult<Option<String>> {
    let handoff_id = payload(doc, "handoff_id")
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let Some(handoff_id) = handoff_id else {
        return Ok(None);
    };
    let project_id = db.with_read(|conn| {
        Ok(non_empty(
            conn.query_row(
                "SELECT project_id FROM agent_handoffs WHERE id = ?1",
                rusqlite::params![handoff_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?,
        ))
    })?;
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let root = db
        .with_read(|conn| crate::project_hub::service::resolve_project_root(conn, &project_id))?;
    Ok(Some(root.unwrap_or(project_id)))
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

/// 创建类落库时的项目字段：以已校验的**有效归属**为准，文件声明只在校验阶段使用。
fn project_field(project_id: &str) -> Option<String> {
    non_empty(Some(project_id.to_string()))
}

/// 导入一份已通过校验的文档。返回一条可读摘要，供扫描报告展示。
///
/// 写入前再做一次能力预检（入口层可能已判过，但服务层不能依赖调用方）。
pub fn import_document(
    db: &Db,
    principal: &Principal,
    doc: &ParsedDocument,
) -> AppResult<String> {
    import_document_guarded(db, principal, doc, &store::NoGuard)
}

/// 带**事务内守卫**的导入（v82：租约 fencing）。
///
/// `guard` 的 `check` / `complete` 与业务写入处于**同一个写事务**：
/// - 租约已被他人抢占（`attempt` 不匹配）或已过期 → `check` 失败 → 事务回滚，
///   业务数据**零写入**（旧执行者无法在新执行者取得租约后继续提交数据）；
/// - 业务写入成功 → `complete` 在同一事务内把租约置 `ok`，
///   因此「业务已写、租约未完成」的窗口不存在（崩溃后两者都不生效，可安全重试）。
pub fn import_document_guarded(
    db: &Db,
    principal: &Principal,
    doc: &ParsedDocument,
    guard: &dyn store::WriteGuard,
) -> AppResult<String> {
    let kind = doc.envelope.kind.as_str();
    let capability = perms::resolve_import_capability(kind)
        .ok_or_else(|| validation(format!("未支持的导入类型: {kind}")))?;
    // 归属只认 `effective_import_project`（数据库推导 + 授权范围），文件声明仅作一致性校验。
    let project_id = perms::check_import_resource_scope(db, principal.import.as_ref(), kind, doc)?;
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
            // 关联是项目工作空间语义：先把入参（兼容计划 ID）解析为项目根并确认真实存在，
            // 再做业务写入，避免「任务已建、关联失败」留下半条数据（失败会释放租约并允许重试）。
            // 不能再用旧 project_kind 字符串比较判断项目有效性。
            let attach_project = if project_id.trim().is_empty() {
                String::new()
            } else {
                db.with_read(|conn| {
                    crate::project_hub::service::resolve_project_root(conn, &project_id)
                })?
                .ok_or_else(|| {
                    validation(format!(
                        "授权项目 {project_id} 不是项目工作空间中的项目，无法关联导入任务"
                    ))
                })?
            };
            // 建任务 + 关联项目 + 租约收尾在同一个事务内（守卫贯穿其中）。
            let task = service::create_task_guarded(db, principal, input, guard, &attach_project)?;
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
            let task = service::update_task_guarded(db, principal, id, patch, base, guard)?;
            Ok(format!("更新任务 {}（revision 校验通过）", task.id))
        }
        "task.complete" => {
            let id = payload(doc, "task_id").unwrap_or_default();
            let task = service::complete_task_guarded(db, principal, id, base, guard)?;
            Ok(format!("完成任务 {}（当前 {}）", task.id, task.status))
        }
        "knowledge.create" => {
            let input = service::KnowledgeCreateInput {
                title: payload(doc, "title").unwrap_or_default().to_string(),
                content: payload(doc, "content").unwrap_or_default().to_string(),
                kb_id: payload(doc, "kb_id").map(str::to_string),
                kb_name: payload(doc, "kb_name").map(str::to_string),
            };
            let document = service::create_knowledge_guarded(db, principal, input, guard)?;
            Ok(format!("写入知识 {}（{}）", document.id, document.title))
        }
        "decision.create" => {
            let input = store::DecisionInput {
                title: payload(doc, "title").unwrap_or_default().to_string(),
                project_id: project_field(&project_id),
                // 归属与类型由 store 按项目根推导，文件声明的旧 project_kind 不参与判定。
                project_kind: None,
                context: payload(doc, "context").unwrap_or_default().to_string(),
                decision: payload(doc, "decision").unwrap_or_default().to_string(),
                consequences: payload(doc, "consequences").unwrap_or_default().to_string(),
                alternatives: payload(doc, "alternatives").unwrap_or_default().to_string(),
                tags: payload_strings(doc, "tags"),
                status: payload(doc, "status").map(str::to_string),
            };
            let decision = store::create_decision_guarded(db, principal, input, guard)?;
            Ok(format!("记录决策 {}（{}）", decision.id, decision.title))
        }
        "handoff.create" => {
            let input = store::HandoffInput {
                to_agent_id: payload(doc, "to_agent_id").unwrap_or_default().to_string(),
                summary: payload(doc, "summary").unwrap_or_default().to_string(),
                task_id: payload(doc, "task_id").map(str::to_string),
                project_id: project_field(&project_id),
                // 交接归属由 handoff 层解析为项目根，旧 project_kind 声明不参与判定。
                project_kind: None,
                completed_items: payload_strings(doc, "completed_items"),
                pending_items: payload_strings(doc, "pending_items"),
                decisions: Vec::new(),
                files_changed: payload_strings(doc, "files_changed"),
                risks: payload_strings(doc, "risks"),
                next_steps: payload_strings(doc, "next_steps"),
            };
            let created = handoff::create_handoff_guarded(db, principal, input, guard)?;
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
                project_id: project_field(&project_id),
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
            let out = handoff::create_report_guarded(db, principal, input, guard)?;
            Ok(format!("提交报告 {}（{}）", out.report.id, out.report.result))
        }
        other => Err(validation(format!("未支持的导入类型: {other}"))),
    }
}

/// 幂等键：操作类型 + 请求标识（相对路径 + 内容 Hash）+ 稳定 actor。
/// 单看内容 Hash 会把「不同文件、相同内容」误判为同一操作。
pub(crate) fn claim_key(rel_path: &str, kind: &str, hash: &str, actor: &str) -> String {
    let mut raw = String::new();
    for part in [rel_path, kind, hash, actor] {
        raw.push_str(part);
        raw.push('\u{1f}');
    }
    sha256(&raw)
}

/// 幂等认领的稳定 `actor`：**不能**用 `principal.label()`。
///
/// scan 与 approve 的 label 天然不同（`file:...` vs `local`），一旦把它算进 claim_key，
/// 同一文件会被当成两次不同操作写入两遍。这里固定为常量。
const IMPORT_LEASE_ACTOR: &str = "file-import";

/// 租约时长（秒）。进程崩溃后最多 5 分钟内不可被抢占。
const IMPORT_LEASE_SECS: i64 = 300;

/// 每次执行独立的租约持有者标识（同一 actor 的两次执行必须可区分）。
fn lease_owner(scene: &str) -> String {
    format!("{scene}:{}", uuid::Uuid::new_v4())
}

/// 登记/更新待审核请求（P2-1）。
///
/// - 首次出现：`pending`；
/// - 同一路径、**同一内容**再次出现：保持原状态（幂等，已 `imported` 的不回到 pending）；
/// - 同一路径、**内容变化**：重置为 `pending`、清空决策信息、`attempt + 1`，
///   并把旧结论追加进 `detail_json.history[]`（只追加，不覆盖，保留审计）。
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
    let summary = doc
        .envelope
        .payload
        .get("title")
        .or_else(|| doc.envelope.payload.get("summary"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let detail = json!({
        "kind": doc.envelope.kind,
        "format": doc.format,
        "base_revision": doc.envelope.base_revision,
        "summary": summary,
    });
    let claimed_agent = doc.envelope.agent_id.as_deref().unwrap_or("");
    let kind = doc.envelope.kind.as_str();
    db.with_conn(|conn| {
        let existing = conn
            .query_row(
                "SELECT content_hash, status, reason, detail_json, decided_at, decided_by
                 FROM agent_import_requests
                 WHERE workspace_row_id = ?1 AND rel_path = ?2",
                rusqlite::params![workspace_row_id, rel_path],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((old_hash, old_status, old_reason, old_detail, decided_at, decided_by)) = existing
        else {
            conn.execute(
                "INSERT INTO agent_import_requests
                   (id, workspace_row_id, rel_path, content_hash, kind, project_id, claimed_agent_id,
                    status, reason, detail_json, created_at, updated_at, decided_at, decided_by)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?10,NULL,'')",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    workspace_row_id,
                    rel_path,
                    hash,
                    kind,
                    project_id,
                    claimed_agent,
                    reason,
                    serde_json::to_string(&detail)?,
                    now,
                ],
            )?;
            return Ok(());
        };
        if old_hash == hash {
            // 内容未变：只更新时间戳，不碰状态与决策（幂等）。
            conn.execute(
                "UPDATE agent_import_requests SET updated_at = ?3
                 WHERE workspace_row_id = ?1 AND rel_path = ?2",
                rusqlite::params![workspace_row_id, rel_path, now],
            )?;
            return Ok(());
        }
        // 内容变化：把旧结论写进 history，再重置为待审核。
        let mut merged: Value = serde_json::from_str(&old_detail)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let history_entry = json!({
            "status": old_status,
            "reason": old_reason,
            "decided_at": decided_at,
            "decided_by": decided_by,
            "content_hash": old_hash,
            "at": now,
        });
        if let Some(object) = merged.as_object_mut() {
            for (key, value) in detail.as_object().cloned().unwrap_or_default() {
                object.insert(key, value);
            }
            let history = object
                .entry("history".to_string())
                .or_insert_with(|| json!([]));
            if let Some(items) = history.as_array_mut() {
                items.push(history_entry);
            }
        }
        conn.execute(
            "UPDATE agent_import_requests
             SET content_hash=?3, kind=?4, project_id=?5, claimed_agent_id=?6, reason=?7,
                 detail_json=?8, status='pending', decided_at=NULL, decided_by='',
                 decided_hash='', lease_owner='', lease_expires_at=NULL,
                 attempt=attempt+1, updated_at=?9
             WHERE workspace_row_id=?1 AND rel_path=?2",
            rusqlite::params![
                workspace_row_id,
                rel_path,
                hash,
                kind,
                project_id,
                claimed_agent,
                reason,
                serde_json::to_string(&merged)?,
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

/// 记录本次结论所依据的内容 Hash（只由已成功的导入写入）。
fn set_decided_hash(db: &Db, id: &str, hash: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_import_requests SET decided_hash=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![id, hash, crate::agents::now_iso()],
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
    // 崩溃恢复：清掉过期租约，否则进程异常退出后会卡住 5 分钟。
    if let Err(err) = store::reclaim_expired_import_leases(db) {
        tracing::warn!(error = %err, "回收过期导入租约失败");
    }
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
        // 策略判定阶段只有「文件声明」可用；真实归属在 import_document 里由
        // `effective_import_project` 推导，声明值**不**参与授权结论。
        let declared = declared_project(&doc);
        let identity = claimed_identity(&doc);
        let decision =
            perms::authorize_file_import(db, &row.id, &rel, &identity, capability, &declared)?;
        let import_principal = match decision {
            FileImportDecision::Allowed(principal) => principal,
            FileImportDecision::NeedsReview { reason, .. } => {
                report.pending_review += 1;
                report
                    .messages
                    .push(format!("{rel}: 待人工批准（{reason}）"));
                if let Err(err) =
                    upsert_import_request(db, &row.id, &rel, &hash, &doc, &declared, &reason)
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
        // 幂等租约：`actor` 必须是稳定值，scan 与 approve 才能算出同一个 claim_key。
        let key = claim_key(&rel, &kind, &hash, IMPORT_LEASE_ACTOR);
        let owner = lease_owner("scan");
        let claim = store::claim_import_lease(
            db,
            &row.id,
            &key,
            &rel,
            &kind,
            &hash,
            IMPORT_LEASE_ACTOR,
            &owner,
            IMPORT_LEASE_SECS,
        )?;
        let lease = match claim {
            store::LeaseClaim::Acquired(lease) => lease,
            store::LeaseClaim::AlreadyImported { finished_at } => {
                // 已成功过：只归档，绝不重写业务表。
                report.skipped += 1;
                report
                    .messages
                    .push(format!("{rel}: 相同内容已于 {finished_at} 导入，跳过"));
                workspace::log_event(
                    db, &row.id, "import", "already_imported", &rel, &kind, "", "skipped",
                    &format!("此前已导入（{finished_at}）"), doc.envelope.base_revision, "",
                );
                let _ = archive_if_unchanged(&path, &imported_dir, &now, &hash);
                continue;
            }
            store::LeaseClaim::InProgress { owner, until } => {
                // 别人正在写：文件必须留在 inbox，归档会让执行者读不到内容。
                report.skipped += 1;
                report.messages.push(format!(
                    "{rel}: 执行者 {owner} 正在导入（租约至 {until}），保留到下一轮"
                ));
                workspace::log_event(
                    db, &row.id, "import", "in_progress", &rel, &kind, "", "skipped",
                    &format!("执行者 {owner} 持有租约至 {until}"),
                    doc.envelope.base_revision, "",
                );
                continue;
            }
        };
        // 写入前复查租约仍归自己（快速失败；真正的原子保证在事务内的守卫）。
        if !store::holds_import_lease(db, &row.id, &lease.claim_key, &lease.owner)? {
            report.skipped += 1;
            report
                .messages
                .push(format!("{rel}: 导入租约已失效，保留到下一轮"));
            workspace::log_event(
                db, &row.id, "import", "lease_lost", &rel, &kind, "", "skipped",
                "写入前复查发现租约不再归本执行者", doc.envelope.base_revision, "",
            );
            continue;
        }
        // 事务内守卫：校验（owner + attempt + 未过期）与业务写入、租约置 ok 同事务。
        let lease_guard = store::ImportLeaseGuard::new(
            &row.id,
            &lease.claim_key,
            &lease.owner,
            lease.attempt,
        );
        // 受控导入的业务写入：从认领成功后开始记录，DB 提交与归档分开收敛。
        let operation = operations::try_start(
            db,
            &import_principal,
            &operations::OperationInput {
                action: if kind.ends_with(".create") {
                    "import.create"
                } else {
                    "import.apply"
                },
                resource_kind: kind.split('.').next().unwrap_or("import"),
                resource_id: "",
                project_id: "",
                request_id: "",
                detail: &rel,
            },
        );
        // v86.1：业务事务与操作终态同事务提交（导入租约守卫 + 操作守卫）。
        // 数据库提交成功而操作记录失败/进程退出时，不会再把「其实已导入」显示成未完成。
        let operation_guard = operations::OperationGuard::new(
            operation
                .as_ref()
                .map(|op| op.id.clone())
                .unwrap_or_default(),
        );
        let guarded = operations::CompositeGuard::new(&lease_guard, &operation_guard);
        match import_document_guarded(db, &import_principal, &doc, &guarded) {
            Ok(message) => {
                // 租约已在业务事务内置 ok（与业务数据同事务提交），此处无需再收尾。
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
                let archive_error = archive_if_unchanged(&path, &imported_dir, &now, &hash).err();
                if let Some(err) = &archive_error {
                    // 业务已成功：不能回滚，也不能让下一轮重复写入（租约已置 ok）。
                    report.messages.push(format!(
                        "{rel}: 已导入但归档失败（{err}）；后续扫描不会重复写入"
                    ));
                    workspace::log_event(
                        db, &row.id, "import", "archive_failed", &rel, &kind, "", "failed",
                        &format!("导入成功但归档失败: {err}"), doc.envelope.base_revision, "",
                    );
                }
                if let Some(op) = &operation {
                    let detail = match &archive_error {
                        Some(err) => format!("{rel}：{message}；归档失败（{err}），数据库已提交"),
                        None => format!("{rel}：{message}"),
                    };
                    let result = operations::OperationResult::new()
                        .revision(doc.envelope.base_revision)
                        .detail(detail.clone());
                    let result = match doc.envelope.payload.get("task_id").and_then(|v| v.as_str())
                    {
                        Some(id) => result.resource(&op.resource_kind, id),
                        None => result,
                    };
                    // 事务内已 committed 时 `complete` 返回 None：只追加归档/详情，
                    // 状态保持 committed（业务确实已提交，归档失败不是业务失败）。
                    match operations::complete(db, &op.id, &result) {
                        Ok(Some(_)) => {}
                        _ => {
                            let _ = operations::append_detail(db, &op.id, &detail);
                            operations::notify_current(db, &op.id);
                        }
                    }
                }
            }
            Err(err) => {
                // 失败：释放租约，文件留在 inbox 允许重试；不得归档、不得写 imported。
                if let Some(op) = &operation {
                    let _ = operations::fail(db, &op.id, &err);
                }
                store::release_import_lease(db, &row.id, &lease.claim_key, &lease.owner);
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
                            "declared_project_id": declared,
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
    // 人工批准同样走 `effective_import_project`：手工 grant 只带「文件声明」，
    // 真实归属与一致性校验由 import_document 内部统一完成，不得另写一套。
    let grant = perms::manual_import_grant(capability, &declared_project(&doc), &approver.label());
    let principal =
        Principal::file_import_granted(grant, doc.envelope.agent_id.as_deref().unwrap_or(""));
    // 与 scan 共用同一租约（actor 固定），避免同内容被扫描与批准各写一遍。
    let key = claim_key(
        &request.rel_path,
        &request.kind,
        &request.content_hash,
        IMPORT_LEASE_ACTOR,
    );
    // 人工审批也是一次受控写入：从「已解析、待认领」开始记录操作。
    let operation = operations::try_start(
        db,
        approver,
        &operations::OperationInput {
            action: "import.approve",
            resource_kind: request.kind.split('.').next().unwrap_or("import"),
            resource_id: "",
            project_id: &request.project_id,
            request_id: &request.id,
            detail: "",
        },
    );
    let owner = lease_owner("approve");
    let claim = store::claim_import_lease(
        db,
        &row.id,
        &key,
        &request.rel_path,
        &request.kind,
        &request.content_hash,
        IMPORT_LEASE_ACTOR,
        &owner,
        IMPORT_LEASE_SECS,
    )?;
    let lease = match claim {
        store::LeaseClaim::Acquired(lease) => lease,
        store::LeaseClaim::InProgress { owner, until } => {
            // 请求状态保持不变：另一执行者可能成功，也可能失败后允许重试。
            return Err(AppError::Conflict(format!(
                "另一执行者 {owner} 正在导入（租约至 {until}），请稍后重试"
            )));
        }
        store::LeaseClaim::AlreadyImported { finished_at } => {
            // 真实结论：此前已经成功写入，不重复写业务表。
            set_import_request_status(
                db,
                &request.id,
                "imported",
                "相同内容此前已导入",
                &approver.label(),
            )?;
            set_decided_hash(db, &request.id, &request.content_hash)?;
            if let Some(op) = &operation {
                let _ = operations::complete(
                    db,
                    &op.id,
                    &operations::OperationResult::new()
                        .revision(doc.envelope.base_revision)
                        .detail(format!("相同内容此前已于 {finished_at} 导入，未重复写入")),
                );
            }
            return Ok(format!("相同内容此前已于 {finished_at} 导入，未重复写入"));
        }
    };
    if let Some(op) = &operation {
        let _ = operations::update_phase(db, &op.id, operations::OperationPhase::Writing);
    }
    // 与 scan 使用**完全相同**的租约守卫与业务写入路径：
    // 人工批准不是绕过自动导入安全验证的后门。
    let lease_guard = store::ImportLeaseGuard::new(
        &row.id,
        &lease.claim_key,
        &lease.owner,
        lease.attempt,
    );
    // 与 scan 相同：业务提交、租约置 ok、操作置 committed 同事务。
    let operation_guard = operations::OperationGuard::new(
        operation
            .as_ref()
            .map(|op| op.id.clone())
            .unwrap_or_default(),
    );
    let guarded = operations::CompositeGuard::new(&lease_guard, &operation_guard);
    match import_document_guarded(db, &principal, &doc, &guarded) {
        Ok(message) => {
            // 租约已在业务事务内置 ok（与业务数据同事务提交）。
            let note = if note.trim().is_empty() {
                message.clone()
            } else {
                format!("{message}；批准备注：{note}")
            };
            set_import_request_status(db, &request.id, "imported", &note, &approver.label())?;
            set_decided_hash(db, &request.id, &request.content_hash)?;
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
            // 数据库已提交；文件归档是**后续**动作，失败只如实记入操作详情，
            // 不改写成业务失败（否则用户会误以为需要重试写入）。
            let archived = archive_if_unchanged(
                &path,
                &root.join("inbox").join("_imported"),
                &crate::agents::now_iso(),
                &hash,
            )
            .is_ok();
            if let Some(op) = &operation {
                let detail = if archived {
                    format!("人工批准：{message}")
                } else {
                    format!("人工批准：{message}；文件归档失败（数据库已提交，不会重复写入）")
                };
                let result = operations::OperationResult::new()
                    .revision(doc.envelope.base_revision)
                    .detail(detail.clone());
                let result = match doc.envelope.payload.get("task_id").and_then(|v| v.as_str()) {
                    Some(id) => result.resource(&op.resource_kind, id),
                    None => result,
                };
                match operations::complete(db, &op.id, &result) {
                    Ok(Some(_)) => {}
                    _ => {
                        let _ = operations::append_detail(db, &op.id, &detail);
                        operations::notify_current(db, &op.id);
                    }
                }
            }
            Ok(message)
        }
        Err(err) => {
            // 失败：释放租约让后续可重试，请求置 failed（不得置 imported）。
            if let Some(op) = &operation {
                let _ = operations::fail(db, &op.id, &err);
            }
            store::release_import_lease(db, &row.id, &lease.claim_key, &lease.owner);
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
    // 拒绝也是需要留痕的操作决定：状态为 failed（error_code=REJECTED），
    // 不得伪装为成功写入。
    let operation = operations::try_start(
        db,
        approver,
        &operations::OperationInput {
            action: "import.reject",
            resource_kind: request.kind.split('.').next().unwrap_or("import"),
            resource_id: "",
            project_id: &request.project_id,
            request_id: &request.id,
            detail: "",
        },
    );
    if let Err(err) = set_import_request_status(db, &request.id, "rejected", reason, &approver.label()) {
        if let Some(op) = &operation {
            let _ = operations::fail(db, &op.id, &err);
        }
        return Err(err);
    }
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
    let mut archived = true;
    if !hash.is_empty() {
        archived = archive_if_unchanged(
            &path,
            &root.join("inbox").join("_rejected"),
            &crate::agents::now_iso(),
            &hash,
        )
        .is_ok();
    }
    if let Some(op) = &operation {
        let detail = if archived {
            format!("人工拒绝：{reason}")
        } else {
            format!("人工拒绝：{reason}；文件未能移入 _rejected（数据库已记录拒绝）")
        };
        let _ = operations::fail_with(
            db,
            &op.id,
            operations::OperationStatus::Failed,
            "REJECTED",
            &detail,
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
