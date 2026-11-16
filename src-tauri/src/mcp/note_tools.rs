//! 笔记 MCP 工具（列表 / 详情 / 搜索 / 创建 / 更新 / 关联任务 / 任务进度记录）。
//!
//! 隐私边界（与 `notes/store.rs` 的分工）：
//! - 用户既有笔记默认**不可读**：只有 `notes.read` 全局授权，或对该笔记 id 的
//!   精确授权才可读；
//! - Agent 通过 MCP 创建的笔记记录在 `mcp_note_ownership`，只有创建它的 Agent
//!   可自由读写；
//! - 列表与搜索只接受全局 `notes.read`，避免用逐条授权被列表接口绕过；
//! - 删除、覆盖式重写、批量修改本轮不开放。更新必须携带 `expected_revision`，
//!   与笔记自身的乐观并发语义一致。
//!
//! 写入全部复用 `notes::store::create_in_conn/update_in_conn/set_task_link_in_conn`，
//! 与桌面端同一校验、同一 revision 语义、同一事务边界。

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::commands::tasks::get_task_in_conn;
use crate::error::AppError;
use crate::mcp::permissions::{self, Capability};
use crate::mcp::tools::{outcome, require_str, schema, CallOutcome, ToolCtx, ToolDef, ToolError};
use crate::mcp::PlanningChanged;
use crate::notes::store::{
    create_in_conn, get_in_conn, list, set_task_link_in_conn, update_in_conn, CreateNoteInput,
    ListFilter, UpdateNoteInput,
};

pub(crate) fn defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "taskdock_list_notes",
            description: "列出笔记（标题/摘要，不含完整正文）。需要 notes.read 全局能力。",
            input_schema: schema(
                json!({
                    "query": { "type": "string", "maxLength": 200 },
                    "pinned_only": { "type": "boolean" },
                    "favorite_only": { "type": "boolean" },
                    "task_id": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                    "offset": { "type": "integer", "minimum": 0 }
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_note",
            description: "读取单条笔记完整内容。需要 notes.read 全局授权、该笔记精确授权，或由本 Agent 创建。",
            input_schema: schema(
                json!({ "note_id": { "type": "string" } }),
                &["note_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_search_notes",
            description: "按关键词搜索笔记（标题+正文，返回摘要）。需要 notes.read 全局能力。",
            input_schema: schema(
                json!({
                    "query": { "type": "string", "maxLength": 200 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                }),
                &["query"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_create_note",
            description: "创建笔记（纯文本/Markdown 原文）。需要 notes.write 能力；创建的笔记自动归属本 Agent。",
            input_schema: schema(
                json!({
                    "title": { "type": "string", "maxLength": 200 },
                    "content": { "type": "string", "maxLength": 200000 },
                    "requestId": { "type": "string", "maxLength": 128 }
                }),
                &[],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_update_note",
            description: "更新笔记标题/正文。需要 notes.write 授权与 expected_revision；不匹配返回冲突，不静默覆盖。",
            input_schema: schema(
                json!({
                    "note_id": { "type": "string" },
                    "expected_revision": { "type": "integer" },
                    "title": { "type": "string", "maxLength": 200 },
                    "content": { "type": "string", "maxLength": 200000 },
                    "requestId": { "type": "string", "maxLength": 128 }
                }),
                &["note_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_link_note_task",
            description: "把笔记关联到任务（或传 null 取消关联）。需要该笔记写权限与任务读取权限。",
            input_schema: schema(
                json!({
                    "note_id": { "type": "string" },
                    "task_id": { "type": ["string","null"] },
                    "requestId": { "type": "string", "maxLength": 128 }
                }),
                &["note_id"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_add_task_progress",
            description: "以「任务关联笔记」形式记录任务进度（Task Dock 没有独立任务进度表，不做并行数据模型）。需要 notes.write 与该任务 tasks.read。",
            input_schema: schema(
                json!({
                    "task_id": { "type": "string" },
                    "message": { "type": "string", "maxLength": 4000 },
                    "title": { "type": "string", "maxLength": 200, "description": "可选标题，缺省为「进度 · 任务标题」" },
                    "requestId": { "type": "string", "maxLength": 128 }
                }),
                &["task_id", "message"],
            ),
            write: true,
        },
    ]
}

fn ensure_notes_read_global(ctx: &ToolCtx) -> Result<(), ToolError> {
    let ok = ctx
        .db
        .with_read(|conn| permissions::has_global(conn, &ctx.agent.row_id, Capability::NotesRead))
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(
            "未授权 notes.read 能力（列表/搜索需要用户授予全局笔记读取）".into(),
        ))
    }
}

fn ensure_note_read(ctx: &ToolCtx, note_id: &str) -> Result<(), ToolError> {
    let ok = ctx
        .db
        .with_read(|conn| permissions::can_read_note(conn, &ctx.agent.row_id, note_id))
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权读取笔记 {note_id}（需要 notes.read 授权或该笔记由本 Agent 创建）"
        )))
    }
}

fn ensure_note_write(ctx: &ToolCtx, conn: &Connection, note_id: &str) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许写笔记（需要 project_rw 且具备 notes.write）",
            ctx.agent.scope.as_str()
        )));
    }
    let ok = permissions::can_write_note(conn, &ctx.agent.row_id, note_id)
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权写入笔记 {note_id}（需要 notes.write 授权或该笔记由本 Agent 创建）"
        )))
    }
}

fn ensure_note_create(ctx: &ToolCtx, conn: &Connection) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许创建笔记（需要 project_rw 且具备 notes.write）",
            ctx.agent.scope.as_str()
        )));
    }
    let ok = permissions::can_create_note(conn, &ctx.agent.row_id).map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(
            "未授权 notes.write 能力（创建笔记需要用户授予笔记写权限）".into(),
        ))
    }
}

pub(crate) fn authorize_replay(
    ctx: &ToolCtx,
    conn: &Connection,
    name: &str,
    args: &Value,
) -> Result<bool, ToolError> {
    match name {
        "taskdock_create_note" => {
            ensure_note_create(ctx, conn)?;
            Ok(true)
        }
        "taskdock_update_note" | "taskdock_link_note_task" => {
            let note_id = require_str(args, "note_id")?;
            ensure_note_write(ctx, conn, &note_id)?;
            Ok(true)
        }
        "taskdock_add_task_progress" => {
            let task_id = require_str(args, "task_id")?;
            ensure_note_create(ctx, conn)?;
            ensure_task_read_for_link(ctx, conn, &task_id)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn ensure_task_read_for_link(
    ctx: &ToolCtx,
    conn: &Connection,
    task_id: &str,
) -> Result<(), ToolError> {
    let ok = crate::mcp::task_tools::has_task_read(conn, &ctx.agent.row_id, task_id)
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权读取任务 {task_id}（关联进度需要该任务的读取权限）"
        )))
    }
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    write_conn: Option<&Connection>,
) -> Result<Option<CallOutcome>, ToolError> {
    let db = ctx.db.as_ref();
    match name {
        "taskdock_list_notes" => {
            ensure_notes_read_global(ctx)?;
            let filter = ListFilter {
                query: string_arg(args, "query"),
                pinned_only: args
                    .get("pinned_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                favorite_only: args
                    .get("favorite_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                task_id: string_arg(args, "task_id"),
                workspace_id: None,
                limit: args.get("limit").and_then(|v| v.as_u64()).map(|v| v as u32),
                offset: args.get("offset").and_then(|v| v.as_u64()).map(|v| v as u32),
            };
            let notes = list(db, &filter).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(notes).map_err(AppError::from)?;
            Ok(Some(outcome(value, "note", String::new(), None)))
        }
        "taskdock_get_note" => {
            let id = require_str(args, "note_id")?;
            ensure_note_read(ctx, &id)?;
            let note = db.with_read(|conn| get_in_conn(conn, &id)).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(note).map_err(AppError::from)?;
            Ok(Some(outcome(value, "note", id, None)))
        }
        "taskdock_search_notes" => {
            ensure_notes_read_global(ctx)?;
            let query = require_str(args, "query")?;
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 100) as u32)
                .or(Some(50));
            let notes = crate::notes::store::search(db, &query, limit).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(notes).map_err(AppError::from)?;
            Ok(Some(outcome(value, "note", String::new(), None)))
        }
        "taskdock_create_note" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            ensure_note_create(ctx, conn)?;
            let input = CreateNoteInput {
                title: string_arg(args, "title"),
                content: string_arg(args, "content"),
            };
            let note = create_in_conn(conn, input).map_err(ToolError::Failed)?;
            permissions::record_note_owner(conn, &note.id, &ctx.agent.row_id)
                .map_err(ToolError::Failed)?;
            let value = serde_json::to_value(&note).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "note",
                note.id.clone(),
                Some(PlanningChanged {
                    kind: "note",
                    project_id: None,
                    feature_id: None,
                    revision: Some(note.revision),
                }),
            )))
        }
        "taskdock_update_note" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let note_id = require_str(args, "note_id")?;
            ensure_note_write(ctx, conn, &note_id)?;
            let expected = args
                .get("expected_revision")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| {
                    ToolError::Failed(AppError::Validation(
                        "更新笔记必须提供 expected_revision".into(),
                    ))
                })?;
            let current = get_in_conn(conn, &note_id).map_err(ToolError::Failed)?;
            let input = UpdateNoteInput {
                title: string_arg(args, "title").unwrap_or(current.title.clone()),
                content: string_arg(args, "content").unwrap_or(current.content.clone()),
                expected_revision: Some(expected),
                force: false,
            };
            let note = update_in_conn(conn, &note_id, input).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(&note).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "note",
                note_id,
                Some(PlanningChanged {
                    kind: "note",
                    project_id: None,
                    feature_id: None,
                    revision: Some(note.revision),
                }),
            )))
        }
        "taskdock_link_note_task" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let note_id = require_str(args, "note_id")?;
            ensure_note_write(ctx, conn, &note_id)?;
            let task_id = args
                .get("task_id")
                .map(|v| v.as_str().map(|s| s.trim().to_string()))
                .unwrap_or(None)
                .filter(|s| !s.is_empty());
            if let Some(task_id) = task_id.as_deref() {
                ensure_task_read_for_link(ctx, conn, task_id)?;
                get_task_in_conn(conn, task_id).map_err(ToolError::Failed)?;
            }
            let note = set_task_link_in_conn(conn, &note_id, task_id).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(&note).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "note",
                note_id,
                Some(PlanningChanged {
                    kind: "note",
                    project_id: None,
                    feature_id: None,
                    revision: Some(note.revision),
                }),
            )))
        }
        "taskdock_add_task_progress" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let task_id = require_str(args, "task_id")?;
            ensure_note_create(ctx, conn)?;
            ensure_task_read_for_link(ctx, conn, &task_id)?;
            let task = get_task_in_conn(conn, &task_id).map_err(ToolError::Failed)?;
            let message = require_str(args, "message")?;
            let title = string_arg(args, "title")
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("进度 · {}", task.title));
            let note = create_in_conn(
                conn,
                CreateNoteInput {
                    title: Some(title),
                    content: Some(message),
                },
            )
            .map_err(ToolError::Failed)?;
            permissions::record_note_owner(conn, &note.id, &ctx.agent.row_id)
                .map_err(ToolError::Failed)?;
            let note = set_task_link_in_conn(conn, &note.id, Some(task_id.clone()))
                .map_err(ToolError::Failed)?;
            let value = serde_json::to_value(&note).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "note",
                note.id.clone(),
                Some(PlanningChanged {
                    kind: "note",
                    project_id: None,
                    feature_id: None,
                    revision: Some(note.revision),
                }),
            )))
        }
        _ => Ok(None),
    }
}
