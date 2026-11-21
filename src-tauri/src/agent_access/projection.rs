//! 文件投影：把数据库中的项目/任务/知识/决策/上下文导出为可读文件。
//!
//! 关键规则：
//! - 只写协议目录，且每个文件都登记到 `agent_workspace_files`（含导出时的 revision 与 hash）；
//! - 内容未变化就跳过写入（`exported_hash` 判等），因此监听不会因自身写入而回环；
//! - 导出是**单向投影**，Agent 不能通过改这些文件回写数据库；回写只走 `inbox/` 受控导入。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::capability::knowledge as kb;
use crate::commands::planning::{list_features_impl, list_milestones_impl, list_projects_impl};
use crate::commands::project_workspace::workspace_project_list_impl;
use crate::commands::tasks::{list_tasks_inner, TaskFilter};
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::store;
use super::{service, workspace, Source, Principal, MAX_EXPORT_FILES};

#[derive(Clone, Debug, Default, Serialize)]
pub struct ExportReport {
    pub root_path: String,
    pub written: u32,
    pub skipped: u32,
    pub failed: u32,
    pub truncated: bool,
    pub files: Vec<String>,
}

fn sha256(text: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 写入并登记：返回 "written" / "skipped"。
#[allow(clippy::too_many_arguments)]
pub fn write_tracked(
    db: &Db,
    workspace_row_id: &str,
    root: &Path,
    rel_path: &str,
    resource_kind: &str,
    resource_id: &str,
    revision: i64,
    updated_at: &str,
    content: &str,
) -> AppResult<&'static str> {
    let path = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let hash = sha256(content);
    let previous: Option<(String, String)> = db.with_read(|conn| {
        conn.query_row(
            "SELECT exported_hash, last_seen_hash FROM agent_workspace_files
             WHERE workspace_row_id=?1 AND rel_path=?2",
            rusqlite::params![workspace_row_id, rel_path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
        .map_or(Ok(None), |v| Ok(Some(v)))
    })?;
    let disk_same = fs::read_to_string(&path)
        .map(|existing| sha256(&existing) == hash)
        .unwrap_or(false);
    let state = if disk_same {
        "skipped"
    } else {
        workspace::write_json_text(&path, content)?;
        "written"
    };
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO agent_workspace_files
               (id, workspace_row_id, rel_path, resource_kind, resource_id, exported_revision,
                exported_hash, last_seen_hash, size_bytes, state, exported_at, last_seen_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?8,'in_sync',?9,?9)
             ON CONFLICT(workspace_row_id, rel_path) DO UPDATE SET
               resource_kind = excluded.resource_kind,
               resource_id = excluded.resource_id,
               exported_revision = excluded.exported_revision,
               exported_hash = excluded.exported_hash,
               last_seen_hash = excluded.last_seen_hash,
               size_bytes = excluded.size_bytes,
               state = 'in_sync',
               exported_at = excluded.exported_at,
               last_seen_at = excluded.last_seen_at",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                workspace_row_id,
                rel_path,
                resource_kind,
                resource_id,
                revision,
                hash,
                content.len() as i64,
                if updated_at.is_empty() {
                    crate::agents::now_iso()
                } else {
                    updated_at.to_string()
                },
            ],
        )
        .map_err(AppError::from)?;
        Ok(())
    })?;
    let _ = previous;
    Ok(state)
}

fn project_markdown(db: &Db, id: &str, name: &str, kind: &str) -> AppResult<String> {
    let status = service::project_status(db, &Principal::local(Source::System), id)?;
    let mut out = format!("# {name}\n\n- id: `{id}`\n- kind: {kind}\n- status: {}\n- progress: {}%\n- updated_at: {}\n- revision: {}\n\n",
        status.status, status.progress_percent, status.updated_at, status.revision);
    out.push_str("## 统计\n\n```json\n");
    out.push_str(&serde_json::to_string_pretty(&status.counts)?);
    out.push_str("\n```\n\n");
    if !status.next_steps.is_empty() {
        out.push_str("## 下一步\n\n");
        for step in &status.next_steps {
            out.push_str(&format!("- {step}\n"));
        }
        out.push('\n');
    }
    if !status.blocked.is_empty() {
        out.push_str("## 阻塞\n\n");
        for item in &status.blocked {
            out.push_str(&format!("- {item}\n"));
        }
        out.push('\n');
    }
    Ok(out)
}

fn task_line(task: &crate::db::Task) -> String {
    let due = task
        .due_at
        .as_deref()
        .map(|d| format!("，截止 {d}"))
        .unwrap_or_default();
    format!(
        "- [{}] {}（`{}`，优先级 {}{}）\n",
        task.status, task.title, task.id, task.priority, due
    )
}

fn task_markdown(task: &crate::db::Task, revision: i64) -> String {
    let mut out = format!(
        "# {}\n\n- id: `{}`\n- status: {}\n- priority: {}\n- category: {}\n- due_at: {}\n- updated_at: {}\n- revision: {}\n\n",
        task.title,
        task.id,
        task.status,
        task.priority,
        task.category,
        task.due_at.as_deref().unwrap_or("-"),
        task.updated_at,
        revision
    );
    if !task.tags.is_empty() {
        out.push_str(&format!("tags: {}\n\n", task.tags.join(", ")));
    }
    out.push_str("## 描述\n\n");
    out.push_str(if task.description.trim().is_empty() {
        "（无）\n"
    } else {
        task.description.as_str()
    });
    out
}

fn knowledge_markdown(doc: &kb::KnowledgeDocument) -> String {
    format!(
        "# {}\n\n- id: `{}`\n- kb: `{}`\n- source: {}/{}\n- status: {}\n- chunks: {}\n- updated_at: {}\n\n> 正文请通过 `taskdock knowledge get {}` 读取（避免大文件投影）。\n",
        doc.title,
        doc.id,
        doc.kb_id,
        doc.source_kind,
        doc.source_mode,
        doc.status,
        doc.chunk_count,
        doc.updated_at,
        doc.id
    )
}

/// 全量导出（受 `MAX_EXPORT_FILES` 限制，超出时停止并标记 truncated）。
pub fn export_all(db: &Db, row: &workspace::WorkspaceRow) -> AppResult<ExportReport> {
    let root = PathBuf::from(&row.root_path);
    if !root.is_dir() || !root.join(super::WORKSPACE_MARKER).exists() {
        return Err(AppError::NotFound(
            "工作空间未初始化或缺少标记文件，拒绝导出".into(),
        ));
    }
    let mut report = ExportReport {
        root_path: row.root_path.clone(),
        ..Default::default()
    };
    let mut write = |rel: &str,
                     kind: &str,
                     id: &str,
                     revision: i64,
                     updated_at: &str,
                     content: String|
     -> AppResult<()> {
        if report.files.len() >= MAX_EXPORT_FILES {
            report.truncated = true;
            return Ok(());
        }
        match write_tracked(
            db,
            &row.id,
            &root,
            rel,
            kind,
            id,
            revision,
            updated_at,
            &content,
        ) {
            Ok("skipped") => report.skipped += 1,
            Ok(_) => report.written += 1,
            Err(err) => {
                report.failed += 1;
                workspace::log_event(
                    db, &row.id, "export", "write_error", rel, kind, id, "failed",
                    &err.user_message(), Some(revision), "",
                );
                return Ok(());
            }
        }
        report.files.push(rel.to_string());
        Ok(())
    };

    // manifest 永远是第一份文件（Agent 的入口）。
    let manifest = workspace::manifest_value(db, row)?;
    let manifest_text = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
    write("manifest.json", "manifest", &row.workspace_id, 0, "", manifest_text)?;

    let local = Principal::local(Source::System);

    // 项目：顶层只按**项目根**分目录，计划一律在 plans/{planId}/ 下。
    // 旧实现把计划 ID 当成项目目录，导致同一项目出现两份事实、且计划文件夹与项目同级。
    for project in workspace_project_list_impl(db, None)? {
        let project_id = project.id.clone();
        let active_plan: Option<String> = db.with_read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
                    rusqlite::params![project_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten())
        })?;
        let plans =
            db.with_read(|conn| crate::project_hub::service::list_plan_summaries(conn, &project_id))?;
        let summary = super::service::ProjectSummary {
            id: project.id.clone(),
            name: project.name.clone(),
            kind: project.kind.clone(),
            status: project.status.clone(),
            description: project.note.clone(),
            root_path: project.root_path.clone(),
            root_exists: project.root_exists,
            active_plan_id: active_plan.clone(),
            plan_count: plans.len() as i64,
            updated_at: project.updated_at.clone(),
            revision: 0,
            feature_total: 0,
            feature_done: 0,
            task_total: project.task_link_count,
            item_total: project.item_count,
        };
        let mut body = format!(
            "# {}\n\n- project_id: `{}`\n- kind: {}\n- status: {}\n- root_path: `{}`\n- active_plan_id: `{}`\n- plans: {}\n- items: {}\n- linked_tasks: {}\n- updated_at: {}\n\n",
            summary.name,
            summary.id,
            summary.kind,
            summary.status,
            project.root_path,
            active_plan.as_deref().unwrap_or("-"),
            plans.len(),
            summary.item_total,
            summary.task_total,
            summary.updated_at
        );
        if !project.note.trim().is_empty() {
            body.push_str(&format!("## 说明\n\n{}\n", project.note));
        }
        write(
            &format!("projects/{project_id}/project.md"),
            "project",
            &project_id,
            0,
            &summary.updated_at,
            body,
        )?;

        for plan in &plans {
            let features = list_features_impl(db, plan.id.clone()).unwrap_or_default();
            let mut text = format!("# {} · {}\n\n", project.name, plan.name);
            text.push_str(&format!(
                "- plan_id: `{}`\n- project_id: `{}`\n- status: {}\n- active: {}\n- revision: {}\n\n",
                plan.id, project_id, plan.status, plan.is_active, plan.revision
            ));
            for feature in &features {
                text.push_str(&format!(
                    "- [{}] {}（步骤 {}/{}，优先级 {}）\n",
                    feature.status,
                    feature.title,
                    feature.step_done,
                    feature.step_total,
                    feature.priority
                ));
            }
            write(
                &format!("projects/{project_id}/plans/{}/plan.md", plan.id),
                "plan",
                &project_id,
                plan.revision,
                &plan.updated_at,
                text,
            )?;
        }
        // 兼容指针：一个版本周期内保留，内容明确写出真实 planId，避免被当成项目实体。
        if let Some(active) = active_plan.as_deref() {
            let text = format!(
                "# {} · 当前计划\n\n- plan_id: `{active}`\n- 详见 `plans/{active}/plan.md`\n",
                project.name
            );
            write(
                &format!("projects/{project_id}/plans/current.md"),
                "plan",
                &project_id,
                0,
                &summary.updated_at,
                text,
            )?;
        }
        let milestones = active_plan
            .as_deref()
            .and_then(|plan_id| list_milestones_impl(db, plan_id.to_string()).ok())
            .unwrap_or_default();
        if !milestones.is_empty() {
            let mut text = format!("# {} · 里程碑\n\n", project.name);
            for milestone in &milestones {
                text.push_str(&format!(
                    "- {}（功能 {}/{}，目标 {}）\n",
                    milestone.name,
                    milestone.feature_completed,
                    milestone.feature_total,
                    milestone.target_date.as_deref().unwrap_or("-")
                ));
            }
            write(
                &format!("projects/{project_id}/architecture/milestones.md"),
                "plan",
                &project_id,
                0,
                &summary.updated_at,
                text,
            )?;
        }
        if let Ok(ctx) = super::context::build(
            db,
            &local,
            super::context::ContextRequest {
                project_id: Some(project_id.clone()),
                format: Some("markdown".into()),
                ..Default::default()
            },
        ) {
            write(
                &format!("projects/{project_id}/context.md"),
                "context",
                &project_id,
                0,
                &summary.updated_at,
                ctx.markdown,
            )?;
        }
    }
    // 任务
    let mut filter = TaskFilter {
        status: Some("all".into()),
        ..Default::default()
    };
    filter.limit = Some(1000);
    let tasks = list_tasks_inner(db, filter)?;
    let mut active = String::from("# 活跃任务\n\n");
    let mut completed = String::from("# 已完成任务\n\n");
    let mut todo = String::from("# 任务索引\n\n");
    for task in &tasks {
        todo.push_str(&task_line(task));
        if task.status == "completed" {
            completed.push_str(&task_line(task));
        } else {
            active.push_str(&task_line(task));
        }
    }
    let revision = |task: &crate::db::Task| -> i64 {
        db.with_read(|conn| {
            let (counter, counter_at, _) = store::read_revision(conn, "task", &task.id)?;
            Ok(store::effective_revision(
                counter,
                &counter_at,
                &task.updated_at,
            ))
        })
        .unwrap_or(0)
    };
    write("tasks/index.md", "task", "", 0, "", todo)?;
    write("tasks/active.md", "task", "", 0, "", active)?;
    write("tasks/completed.md", "task", "", 0, "", completed)?;
    for task in tasks.iter().take(200) {
        write(
            &format!("tasks/{}/{}.md", if task.status == "completed" { "completed" } else { "active" }, task.id),
            "task",
            &task.id,
            revision(task),
            &task.updated_at,
            task_markdown(task, revision(task)),
        )?;
    }

    // 知识库
    let bases = kb::list_bases_impl(db, None, None)?;
    let mut index = String::from("# 知识索引\n\n");
    for base in &bases {
        index.push_str(&format!("- {}（`{}`，{} 篇）\n", base.name, base.id, base.doc_count));
        write(
            &format!("knowledge/documents/_bases/{}.md", base.id),
            "knowledge",
            &base.id,
            0,
            &base.updated_at,
            format!(
                "# {}\n\n- id: `{}`\n- kind: {}\n- documents: {}\n- updated_at: {}\n\n{}\n",
                base.name, base.id, base.kind, base.doc_count, base.updated_at, base.description
            ),
        )?;
        let docs: Vec<kb::KnowledgeDocument> = db.with_read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kb_id, title, source_kind, source_mode, source_path, mime,
                            size_bytes, content_hash, status, error, chunk_count, indexed_at,
                            created_at, updated_at
                     FROM knowledge_documents WHERE kb_id = ?1
                     ORDER BY updated_at DESC LIMIT 200",
                )
                .map_err(AppError::from)?;
            let rows = stmt
                .query_map(rusqlite::params![base.id], |r| {
                    Ok(kb::KnowledgeDocument {
                        id: r.get(0)?,
                        kb_id: r.get(1)?,
                        title: r.get(2)?,
                        source_kind: r.get(3)?,
                        source_mode: r.get(4)?,
                        source_path: r.get(5)?,
                        mime: r.get(6)?,
                        size_bytes: r.get(7)?,
                        content_hash: r.get(8)?,
                        status: r.get(9)?,
                        error: r.get(10)?,
                        chunk_count: r.get(11)?,
                        indexed_at: r.get(12)?,
                        created_at: r.get(13)?,
                        updated_at: r.get(14)?,
                    })
                })
                .map_err(AppError::from)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(AppError::from)?);
            }
            Ok::<_, AppError>(out)
        })?;
        for doc in docs {
            write(
                &format!("knowledge/documents/{}.md", doc.id),
                "knowledge",
                &doc.id,
                0,
                &doc.updated_at,
                knowledge_markdown(&doc),
            )?;
        }
    }
    write("knowledge/index.md", "knowledge", "", 0, "", index)?;

    // 决策
    let (decisions, _) = store::list_decisions(db, None, None, 200, 0)?;
    let mut index = String::from("# 决策记录\n\n");
    for decision in decisions {
        index.push_str(&format!(
            "- [{}] {}（`{}`，{}）\n",
            decision.status, decision.title, decision.id, decision.updated_at
        ));
        let body = format!(
            "# {}\n\n- id: `{}`\n- status: {}\n- project: `{}`\n- created_by: {}\n- source: {}\n- updated_at: {}\n- revision: {}\n\n## 背景\n\n{}\n\n## 决策\n\n{}\n\n## 后果\n\n{}\n\n## 备选方案\n\n{}\n",
            decision.title, decision.id, decision.status, decision.project_id, decision.created_by,
            decision.source, decision.updated_at, decision.revision, decision.context,
            decision.decision, decision.consequences, decision.alternatives
        );
        write(
            &format!("decisions/{}.md", decision.id),
            "decision",
            &decision.id,
            decision.revision,
            &decision.updated_at,
            body,
        )?;
    }
    write("decisions/index.md", "decision", "", 0, "", index)?;

    // Agent 注册表
    let agents = crate::mcp::auth::list_agents(db)?;
    for agent in agents {
        write(
            &format!("agents/registry/{}.md", agent.agent_id),
            "agent",
            &agent.id,
            0,
            &agent.updated_at,
            format!(
                "# {}\n\n- agent_id: `{}`\n- scope: {}\n- created_at: {}\n- last_seen_at: {}\n- revoked: {}\n",
                agent.display_name,
                agent.agent_id,
                agent.scope,
                agent.created_at,
                agent.last_seen_at.as_deref().unwrap_or("-"),
                agent.revoked_at.is_some()
            ),
        )?;
    }

    // 上下文
    let context_request = super::context::ContextRequest {
        format: Some("markdown".into()),
        ..Default::default()
    };
    if let Ok(ctx) = super::context::build(db, &local, context_request) {
        write("context/current.md", "context", "", 0, "", ctx.markdown)?;
    }
    let (activity, _) = store::list_activity(
        db,
        &store::ActivityQuery {
            agent_id: None,
            interface: None,
            since: None,
            limit: 30,
            offset: 0,
        },
    )?;
    let mut recent = String::from("# 近期活动\n\n");
    for record in activity {
        recent.push_str(&format!(
            "- {} · {} {} · {}（{}）\n",
            record.created_at, record.agent_id, record.action, record.resource_kind, record.interface
        ));
    }
    write("context/recent.md", "context", "", 0, "", recent)?;
    let overview = format!(
        "# 系统概览\n\n- 协议: {}\n- 协议版本: {}\n- 工作空间: `{}`\n- 根目录: `{}`\n- 任务: {}\n- 知识文档: {}\n- 决策: {}\n- 交接: {}\n\n> 本文件由 Task Dock 自动生成，请勿手改；写入请用 inbox/ 导入信封。\n",
        super::PROTOCOL,
        super::PROTOCOL_VERSION,
        row.workspace_id,
        row.root_path,
        tasks.len(),
        bases.iter().map(|b| b.doc_count).sum::<i64>(),
        db.with_read(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM agent_decisions", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0))
        })?,
        db.with_read(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM agent_handoffs", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0))
        })?,
    );
    write("context/system-overview.md", "context", "", 0, "", overview)?;

    workspace::touch_export(db, &row.id, &crate::agents::now_iso())?;
    workspace::log_event(
        db,
        &row.id,
        "export",
        "snapshot",
        "",
        "workspace",
        &row.workspace_id,
        if report.failed > 0 { "failed" } else { "ok" },
        &format!(
            "写入 {}，跳过 {}，失败 {}",
            report.written, report.skipped, report.failed
        ),
        None,
        "",
    );
    Ok(report)
}

/// 单项目上下文导出（`export_project_context`）。
pub fn export_project_context(db: &Db, project_id: &str) -> AppResult<String> {
    let ctx = super::context::build(
        db,
        &Principal::local(Source::System),
        super::context::ContextRequest {
            project_id: Some(project_id.to_string()),
            format: Some("markdown".into()),
            ..Default::default()
        },
    )?;
    Ok(ctx.markdown)
}

/// 任务快照（JSON）。
pub fn export_task_snapshot(db: &Db, task_id: Option<&str>) -> AppResult<serde_json::Value> {
    match task_id {
        Some(id) => Ok(serde_json::to_value(service::fetch_task(
            db,
            &Principal::local(Source::System),
            id,
        )?)?),
        None => {
            let filter = TaskFilter {
                status: Some("all".into()),
                limit: Some(1000),
                ..Default::default()
            };
            let tasks = list_tasks_inner(db, filter)?;
            Ok(serde_json::json!({
                "count": tasks.len(),
                "tasks": tasks,
            }))
        }
    }
}

/// 知识快照（索引，不含正文）。
pub fn export_knowledge_snapshot(db: &Db) -> AppResult<serde_json::Value> {
    let bases = kb::list_bases_impl(db, None, None)?;
    let mut docs = Vec::new();
    for base in &bases {
        let items = db.with_read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kb_id, title, source_kind, status, chunk_count, updated_at
                     FROM knowledge_documents WHERE kb_id=?1 ORDER BY updated_at DESC LIMIT 500",
                )
                .map_err(AppError::from)?;
            let rows = stmt
                .query_map(rusqlite::params![base.id], |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "kb_id": r.get::<_, String>(1)?,
                        "title": r.get::<_, String>(2)?,
                        "source_kind": r.get::<_, String>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "chunk_count": r.get::<_, i64>(5)?,
                        "updated_at": r.get::<_, String>(6)?,
                    }))
                })
                .map_err(AppError::from)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(AppError::from)?);
            }
            Ok::<_, AppError>(out)
        })?;
        docs.extend(items);
    }
    Ok(serde_json::json!({
        "bases": bases.iter().map(|b| serde_json::json!({
            "id": b.id, "name": b.name, "kind": b.kind, "doc_count": b.doc_count,
        })).collect::<Vec<_>>(),
        "documents": docs,
    }))
}

