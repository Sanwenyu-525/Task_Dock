//! 任务 MCP 工具（读取 + 创建 + 更新 + 统计）。
//!
//! 复用边界：
//! - 读取走 `commands::tasks::list_tasks_inner` / `get_task`，与桌面端同一筛选语义；
//! - 创建/更新走 `commands::tasks::create_task_tx` / `update_task_in_conn`，
//!   与命令层同一校验、同一提醒重建、同一事务边界；
//! - **本轮不开放删除、批量修改、状态机跳转**：`toggle_task` 会写完成分析并推进
//!   重复任务期次，属于用户操作语义；Agent 只能通过 `taskdock_update_task` 修改
//!   标题/描述/优先级/分类/标签/时间，不得伪造完成。
//!
//! 授权：`tasks.read` / `tasks.write` 能力，`resource_id` 为空表示全局，
//! 非空表示仅该任务；列表与统计只接受全局能力（避免逐条授权被列表绕过）。

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::agent_access::store::{self, ActivityEntry};
use crate::agent_access::{Principal, Source};
use crate::commands::tasks::{
    create_task_tx, get_task_in_conn, list_tasks_inner, update_task_in_conn, TaskFilter, TaskInput,
};
use crate::db::{Db, Task};
use crate::error::AppError;
use crate::mcp::permissions::{self, Capability};
use crate::mcp::tools::{arg_str, outcome, require_str, schema, CallOutcome, ToolCtx, ToolDef, ToolError};
use crate::mcp::PlanningChanged;

fn agent_principal(ctx: &ToolCtx) -> Principal {
    Principal::agent(
        ctx.agent.row_id.clone(),
        ctx.agent.agent_id.clone(),
        Source::Mcp,
    )
}

/// 旧 MCP 任务工具复用 Agent 访问层的 revision 口径，保证
/// create → get → complete 之间 base_revision 可闭合。
fn attach_revision(db: &Db, task: &mut Task) -> Result<(), AppError> {
    task.revision = Some(db.with_read(|conn| {
        let (counter, counter_at, _) = store::read_revision(conn, "task", &task.id)?;
        Ok(store::effective_revision(
            counter,
            &counter_at,
            &task.updated_at,
        ))
    })?);
    Ok(())
}

fn log_task_activity(
    conn: &Connection,
    ctx: &ToolCtx,
    action: &str,
    task_id: &str,
    revision: i64,
    detail: &str,
) {
    let principal = agent_principal(ctx);
    let _ = store::write_activity(
        conn,
        &ActivityEntry {
            principal: &principal,
            action,
            resource_kind: "task",
            resource_id: task_id,
            project_id: "",
            request_id: "",
            success: true,
            error_code: "",
            detail,
            revision: Some(revision),
            duration_ms: 0,
        },
    );
}

pub(crate) fn defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "taskdock_list_tasks",
            description: "列出 Task Dock 任务（按视图/状态/分类/标签/关键词筛选）。需要 tasks.read 全局能力。",
            input_schema: schema(
                json!({
                    "view": { "type": "string", "enum": ["today","tomorrow","week","all","overdue","due_today","scheduled"] },
                    "status": { "type": "string", "enum": ["pending","completed","all"] },
                    "category": { "type": "string" },
                    "tag": { "type": "string" },
                    "priority": { "type": "integer", "minimum": 0, "maximum": 3 },
                    "search": { "type": "string", "maxLength": 200 },
                    "sort": { "type": "string", "enum": ["due","priority","created","completed","scheduled"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_task",
            description: "读取单个任务详情（含截止、提醒、标签与关联数量）。需要 tasks.read 全局或该任务授权。",
            input_schema: schema(
                json!({ "task_id": { "type": "string" } }),
                &["task_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_create_task",
            description: "创建任务。需要 tasks.write 全局能力；不改变既有任务状态机。",
            input_schema: schema(
                json!({
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 4000 },
                    "priority": { "type": "integer", "minimum": 0, "maximum": 3 },
                    "category": { "type": "string", "maxLength": 64 },
                    "tags": { "type": "array", "items": { "type": "string", "maxLength": 32 }, "maxItems": 20 },
                    "due_at": { "type": ["string","null"], "description": "RFC3339 截止时间；null 表示无" },
                    "requestId": {
                        "type": "string", "maxLength": 128,
                        "description": "可选幂等键：客户端重试同一写操作时传相同值"
                    }
                }),
                &["title"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_update_task",
            description: "更新任务字段（标题/描述/优先级/分类/标签/截止）。必须提供 expected_updated_at 防止静默覆盖；不允许标记完成。",
            input_schema: schema(
                json!({
                    "task_id": { "type": "string" },
                    "expected_updated_at": { "type": "string", "description": "读取结果中的 updated_at；不匹配返回冲突与当前值" },
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 4000 },
                    "priority": { "type": "integer", "minimum": 0, "maximum": 3 },
                    "category": { "type": "string", "maxLength": 64 },
                    "tags": { "type": "array", "items": { "type": "string", "maxLength": 32 }, "maxItems": 20 },
                    "due_at": { "type": ["string","null"] },
                    "requestId": { "type": "string", "maxLength": 128 }
                }),
                &["task_id", "expected_updated_at", "title"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_task_stats",
            description: "读取任务统计：待办、逾期、今日到期、今日完成、最近截止时间。需要 tasks.read 全局能力。",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_due_tasks",
            description: "列出逾期或今日到期任务（只读）。需要 tasks.read 全局能力。",
            input_schema: schema(
                json!({
                    "scope": { "type": "string", "enum": ["overdue","due_today"], "description": "默认 overdue" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                }),
                &[],
            ),
            write: false,
        },
    ]
}

fn ensure_read_global(ctx: &ToolCtx) -> Result<(), ToolError> {
    let ok = ctx
        .db
        .with_read(|conn| permissions::has_global(conn, &ctx.agent.row_id, Capability::TasksRead))
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(
            "未授权 tasks.read 能力（需要用户在 MCP 设置中为该 Agent 授予任务读取）".into(),
        ))
    }
}

/// 连接级任务读取判定（写事务内使用，避免再次进入 `Db::with_read` 造成自锁）。
pub(crate) fn has_task_read(
    conn: &Connection,
    agent_row_id: &str,
    task_id: &str,
) -> Result<bool, AppError> {
    if permissions::has_global(conn, agent_row_id, Capability::TasksRead)? {
        return Ok(true);
    }
    permissions::has(conn, agent_row_id, Capability::TasksRead, task_id)
}

fn ensure_read_one(ctx: &ToolCtx, task_id: &str) -> Result<(), ToolError> {
    let allowed = ctx
        .db
        .with_read(|conn| has_task_read(conn, &ctx.agent.row_id, task_id))
        .map_err(ToolError::Failed)?;
    if allowed {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权读取任务 {task_id}（缺少 tasks.read 全局或该任务授权）"
        )))
    }
}

fn ensure_write_one(ctx: &ToolCtx, conn: &Connection, task_id: &str) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许写任务（需要 project_rw 且具备 tasks.write）",
            ctx.agent.scope.as_str()
        )));
    }
    let allowed = permissions::has_global(conn, &ctx.agent.row_id, Capability::TasksWrite)
        .map_err(ToolError::Failed)?
        || permissions::has(conn, &ctx.agent.row_id, Capability::TasksWrite, task_id)
            .map_err(ToolError::Failed)?;
    if allowed {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权写入任务 {task_id}（缺少 tasks.write 全局或该任务授权）"
        )))
    }
}

fn ensure_write_global(ctx: &ToolCtx, conn: &Connection) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许写任务（需要 project_rw 且具备 tasks.write）",
            ctx.agent.scope.as_str()
        )));
    }
    let ok = permissions::has_global(conn, &ctx.agent.row_id, Capability::TasksWrite)
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(
            "未授权 tasks.write 能力（创建任务需要全局写授权）".into(),
        ))
    }
}

/// 幂等重放授权：返回 true 表示该工具由本模块负责。
pub(crate) fn authorize_replay(
    ctx: &ToolCtx,
    conn: &Connection,
    name: &str,
    args: &Value,
) -> Result<bool, ToolError> {
    match name {
        "taskdock_create_task" => {
            ensure_write_global(ctx, conn)?;
            Ok(true)
        }
        "taskdock_update_task" => {
            let id = require_str(args, "task_id")?;
            ensure_write_one(ctx, conn, &id)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn filter_from_args(args: &Value) -> Result<TaskFilter, ToolError> {
    let view = arg_str(args, "view").map(str::to_string);
    if let Some(view) = &view {
        if !["today", "tomorrow", "week", "all", "overdue", "due_today", "scheduled"]
            .contains(&view.as_str())
        {
            return Err(ToolError::Failed(AppError::Validation(format!(
                "非法 view: {view}"
            ))));
        }
    }
    let status = arg_str(args, "status").map(str::to_string);
    if let Some(status) = &status {
        if !["pending", "completed", "all"].contains(&status.as_str()) {
            return Err(ToolError::Failed(AppError::Validation(format!(
                "非法 status: {status}"
            ))));
        }
    }
    let sort = arg_str(args, "sort").map(str::to_string);
    if let Some(sort) = &sort {
        if !["due", "priority", "created", "completed", "scheduled"].contains(&sort.as_str()) {
            return Err(ToolError::Failed(AppError::Validation(format!(
                "非法 sort: {sort}"
            ))));
        }
    }
    Ok(TaskFilter {
        view,
        status,
        category: arg_str(args, "category").map(str::to_string),
        tag: arg_str(args, "tag").map(str::to_string),
        priority: args
            .get("priority")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(3) as u8),
        search: arg_str(args, "search").map(str::to_string),
        sort,
        limit: args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
    })
}

fn input_from_args(args: &Value, require_title: bool) -> Result<TaskInput, ToolError> {
    let title = if require_title {
        require_str(args, "title")?
    } else {
        arg_str(args, "title").unwrap_or_default().to_string()
    };
    let tags = args.get("tags").and_then(|v| v.as_array()).map(|items| {
        items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    });
    Ok(TaskInput {
        title,
        description: arg_str(args, "description").unwrap_or_default().to_string(),
        priority: args
            .get("priority")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(3) as u8),
        category: arg_str(args, "category").map(str::to_string),
        tags,
        due_at: args
            .get("due_at")
            .map(|v| v.as_str().map(str::to_string)),
        remind_at: None,
        advance_minutes: None,
        recurrence: None,
    })
}

/// 返回 `Some(outcome)` 表示本模块处理了该工具；`None` 交给后续模块。
pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    write_conn: Option<&Connection>,
) -> Result<Option<CallOutcome>, ToolError> {
    let db = ctx.db.as_ref();
    match name {
        "taskdock_list_tasks" => {
            ensure_read_global(ctx)?;
            let filter = filter_from_args(args)?;
            let mut tasks = list_tasks_inner(db, filter).map_err(ToolError::Failed)?;
            for task in tasks.iter_mut() {
                attach_revision(db, task).map_err(ToolError::Failed)?;
            }
            let value = serde_json::to_value(tasks).map_err(AppError::from)?;
            Ok(Some(outcome(value, "task", String::new(), None)))
        }
        "taskdock_get_task" => {
            let id = require_str(args, "task_id")?;
            ensure_read_one(ctx, &id)?;
            let mut task = db
                .with_read(|conn| get_task_in_conn(conn, &id))
                .map_err(ToolError::Failed)?;
            attach_revision(db, &mut task).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(task).map_err(AppError::from)?;
            Ok(Some(outcome(value, "task", id, None)))
        }
        "taskdock_list_due_tasks" => {
            ensure_read_global(ctx)?;
            let scope = arg_str(args, "scope").unwrap_or("overdue");
            if !["overdue", "due_today"].contains(&scope) {
                return Err(ToolError::Failed(AppError::Validation(format!(
                    "非法 scope: {scope}"
                ))));
            }
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 200) as u32)
                .or(Some(100));
            let mut tasks = list_tasks_inner(
                db,
                TaskFilter {
                    view: Some(scope.to_string()),
                    status: Some("pending".into()),
                    limit,
                    ..Default::default()
                },
            )
            .map_err(ToolError::Failed)?;
            for task in tasks.iter_mut() {
                attach_revision(db, task).map_err(ToolError::Failed)?;
            }
            let value = serde_json::to_value(tasks).map_err(AppError::from)?;
            Ok(Some(outcome(value, "task", String::new(), None)))
        }
        "taskdock_task_stats" => {
            ensure_read_global(ctx)?;
            let value = crate::commands::tasks::task_stats_inner(db).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(value).map_err(AppError::from)?;
            Ok(Some(outcome(value, "task", String::new(), None)))
        }
        "taskdock_create_task" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            ensure_write_global(ctx, conn)?;
            let input = input_from_args(args, true)?;
            let task_id = create_task_tx(conn, input).map_err(ToolError::Failed)?;
            let mut task = get_task_in_conn(conn, &task_id).map_err(ToolError::Failed)?;
            let principal = agent_principal(ctx);
            let revision = store::bump_revision(
                conn,
                "task",
                &task_id,
                &principal,
                &task.updated_at,
                "",
            )
            .map_err(ToolError::Failed)?;
            task.revision = Some(revision);
            log_task_activity(conn, ctx, "task.create", &task_id, revision, "创建任务");
            let value = serde_json::to_value(&task).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "task",
                task_id.clone(),
                Some(PlanningChanged {
                    kind: "task",
                    project_id: None,
                    feature_id: None,
                    revision: Some(revision),
                }),
            )))
        }
        "taskdock_update_task" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let task_id = require_str(args, "task_id")?;
            let expected = require_str(args, "expected_updated_at")?;
            ensure_write_one(ctx, conn, &task_id)?;
            let current = get_task_in_conn(conn, &task_id).map_err(ToolError::Failed)?;
            if current.updated_at != expected {
                return Err(ToolError::Failed(AppError::Conflict(format!(
                    "任务已被其他操作更新（当前 updated_at={}，提交的 expected_updated_at={}），请重新读取后再写",
                    current.updated_at, expected
                ))));
            }
            let input = input_from_args(args, true)?;
            let mut input = input;
            // 未传字段保持既有值：MCP 局部更新不得清空用户内容。
            if args.get("description").is_none() {
                input.description = current.description.clone();
            }
            if args.get("priority").is_none() {
                input.priority = Some(current.priority);
            }
            if args.get("category").is_none() {
                input.category = Some(current.category.clone());
            }
            if args.get("tags").is_none() {
                input.tags = Some(current.tags.clone());
            }
            let mut task = update_task_in_conn(conn, &task_id, input).map_err(ToolError::Failed)?;
            let principal = agent_principal(ctx);
            let revision = store::bump_revision(
                conn,
                "task",
                &task_id,
                &principal,
                &task.updated_at,
                "",
            )
            .map_err(ToolError::Failed)?;
            task.revision = Some(revision);
            log_task_activity(conn, ctx, "task.update", &task_id, revision, "更新任务");
            let value = serde_json::to_value(&task).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "task",
                task_id,
                Some(PlanningChanged {
                    kind: "task",
                    project_id: None,
                    feature_id: None,
                    revision: Some(revision),
                }),
            )))
        }
        _ => Ok(None),
    }
}

/// 任务统计的可复用内核（命令层与 MCP 共用，避免两套口径）。
pub(crate) fn count_pending(conn: &Connection) -> Result<i64, AppError> {
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )
    .map_err(AppError::from)
}
