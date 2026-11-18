//! 受控文件同步：扫描 `inbox/`、校验信封、导入、冲突检测与解决。
//!
//! 为什么不能「无差别双向监听」：Task Dock 自己写投影会产生写事件，若再把文件当输入就会
//! 无限回环。这里用三层事实区分来源：
//! 1) 只有 `inbox/`、`tasks/inbox/`、`knowledge/inbox/` 允许导入；
//! 2) 每个写入文件都登记 `exported_hash`，内容相同视为自身写入（跳过）；
//! 3) 导入成功后文件被移到 `_imported/`，重复同步不会重复执行；同内容再次提交按 hash 去重。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions as perms;
use super::{handoff, service, store, validation, workspace, Principal, MAX_IMPORT_BYTES, MAX_SCAN_FILES};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportEnvelope {
    pub schema: String,
    pub kind: String,
    #[serde(default)]
    pub base_revision: Option<i64>,
    #[serde(default)]
    pub project_id: Option<String>,
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
    pub files: Vec<String>,
    pub messages: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncStatus {
    pub workspace: Option<workspace::WorkspaceStatus>,
    pub pending_imports: i64,
    pub conflicts: i64,
    pub recent_events: Vec<store::SyncEventRecord>,
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
            _ => {}
        }
    }
    if kind.is_empty() {
        return Err(validation("front matter 缺少 kind"));
    }
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
        _ => json!({ "content": body, "title": title }),
    };
    let envelope = ImportEnvelope {
        schema: "taskdock.import/1".into(),
        kind,
        base_revision,
        project_id,
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
            Some(v.trim().trim_matches('"').to_string())
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
    if envelope.kind != "task.create"
        && envelope.kind != "knowledge.create"
        && envelope.kind != "decision.create"
        && envelope.kind != "handoff.create"
        && envelope.kind != "report.create"
        && envelope.base_revision.is_none()
    {
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

/// 导入一份已通过校验的文档。返回一条可读摘要，供扫描报告展示。
pub fn import_document(
    db: &Db,
    principal: &Principal,
    doc: &ParsedDocument,
) -> AppResult<String> {
    let kind = doc.envelope.kind.as_str();
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

/// 扫描并导入。`principal` 的来源必须是 `Source::File`（由调用方构造）。
pub fn scan(db: &Db, principal: &Principal, row: &workspace::WorkspaceRow) -> AppResult<ScanReport> {
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
        // 同内容已成功导入过 → 跳过（防重复建任务/重复写知识）。
        let seen: bool = db.with_read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_sync_events
                  WHERE workspace_row_id=?1 AND direction='import' AND status='ok'
                    AND content_hash=?2)",
                    rusqlite::params![row.id, hash],
                    |r| r.get(0),
                )
                .unwrap_or(false))
        })?;
        if seen {
            report.skipped += 1;
            report.messages.push(format!("{rel}: 相同内容已导入，跳过"));
            let _ = archive(&path, &imported_dir, &now);
            continue;
        }
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
                continue;
            }
        };
        match import_document(db, principal, &doc) {
            Ok(message) => {
                report.imported += 1;
                report.files.push(rel.clone());
                report.messages.push(format!("{rel}: {message}"));
                let kind = doc.envelope.kind.clone();
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
                let _ = archive(&path, &imported_dir, &now);
            }
            Err(err) => {
                if let AppError::Conflict(_) = &err {
                    report.conflicts += 1;
                    report
                        .messages
                        .push(format!("{rel}: 冲突 {}", err.user_message()));
                    let conflict = store::SyncConflict {
                        id: uuid::Uuid::new_v4().to_string(),
                        rel_path: rel.clone(),
                        resource_kind: doc.envelope.kind.clone(),
                        resource_id: doc
                            .envelope
                            .payload
                            .get("task_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        db_revision: 0,
                        file_revision: doc.envelope.base_revision.unwrap_or(0),
                        db_hash: String::new(),
                        file_hash: hash.clone(),
                        status: "open".into(),
                        resolution: String::new(),
                        detail_json: serde_json::to_string(&json!({
                            "kind": doc.envelope.kind,
                            "message": err.user_message(),
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

fn archive(path: &Path, imported_dir: &Path, now: &str) -> std::io::Result<()> {
    let stamp = now.replace([':', '.', '+'], "-");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "import".into());
    let target = imported_dir.join(format!("{stamp}-{name}"));
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
            recent_events: Vec::new(),
        });
    };
    let ws = workspace::status(db)?;
    let pending = ws.as_ref().map(|w| w.pending_imports).unwrap_or(0);
    let conflicts = store::list_conflicts(db, &row.id)?
        .into_iter()
        .filter(|c| c.status == "open")
        .count() as i64;
    let events = store::list_sync_events(db, &row.id, 20)?;
    Ok(SyncStatus {
        workspace: ws,
        pending_imports: pending,
        conflicts,
        recent_events: events,
    })
}

pub fn list_conflicts(db: &Db) -> AppResult<Vec<store::SyncConflict>> {
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    store::list_conflicts(db, &row.id)
}

/// 人工解决冲突：
/// - `db`：保留数据库版本，删除外部文件；
/// - `dismiss`：仅关闭冲突记录，文件保留供人工处理；
/// - `file`：用当前版本作为 base 重新导入（明确表示接受外部内容）。
pub fn resolve_conflict(
    db: &Db,
    principal: &Principal,
    id: &str,
    resolution: &str,
) -> AppResult<store::SyncConflict> {
    perms::require(db, principal, Capability::TasksWrite, "")?;
    let row = workspace::active(db)?
        .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
    let conflict = store::get_conflict(db, id)?;
    let root = PathBuf::from(&row.root_path);
    let path = root.join(conflict.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    match resolution {
        "db" => {
            if path.exists() {
                let _ = fs::remove_file(&path);
            }
        }
        "dismiss" => {}
        "file" => {
            let raw = fs::read_to_string(&path)
                .map_err(|e| validation(format!("冲突文件不可读: {e}")))?;
            let mut doc = parse_external_document(&raw, &path)?;
            let current = match doc.envelope.payload.get("task_id").and_then(|v| v.as_str()) {
                Some(task_id) => Some(service::task_version(db, task_id)?.0),
                None => None,
            };
            doc.envelope.base_revision = current.or(doc.envelope.base_revision);
            import_document(db, principal, &doc)?;
            if path.exists() {
                let _ = fs::remove_file(&path);
            }
        }
        other => {
            return Err(validation(format!(
                "resolution 必须是 db|file|dismiss（当前 {other}）"
            )))
        }
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
