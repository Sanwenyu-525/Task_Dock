//! 工作流只读与预览 MCP 工具。
//!
//! 安全边界：
//! - 本轮 **不提供执行工具**。工作流步骤会打开应用/网页/目录、进入场景或恢复现场，
//!   属于会影响用户桌面的动作；执行必须由用户在 Task Dock UI 内显式触发。
//!   Agent 只能读取、检查与预览，`taskdock_preview_workflow` 明确返回
//!   `requiresUserConfirmation: true` 与 `executionSupported: false`。
//! - 授权独立于项目写权限：需要 `workflows.read`（全局或该工作流 id）。
//! - 预览会逐步骤调用 `workflows::validate_step(..., check_references = true)`，
//!   与真正执行前的校验同一入口，避免「预览通过、执行失败」的假安心。

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::mcp::permissions::{self, Capability};
use crate::mcp::tools::{outcome, require_str, schema, CallOutcome, ToolCtx, ToolDef, ToolError};
use crate::workflows::store;

pub(crate) fn defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "taskdock_list_workflows",
            description: "列出工作流（名称、启用状态、步骤数、最近运行）。需要 workflows.read 全局能力。",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_workflow",
            description: "读取工作流详情与步骤（含 on_error 与参数）。需要 workflows.read 全局或该工作流授权。",
            input_schema: schema(
                json!({ "workflow_id": { "type": "string" } }),
                &["workflow_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_workflow_runs",
            description: "分页读取工作流运行历史（状态、进度、开始/结束时间）。需要 workflows.read 授权。",
            input_schema: schema(
                json!({
                    "workflow_id": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                    "offset": { "type": "integer", "minimum": 0 }
                }),
                &["workflow_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_check_workflow",
            description: "检查工作流是否可执行：逐步校验类型、参数与引用对象是否存在，返回阻塞原因。需要 workflows.read。",
            input_schema: schema(
                json!({ "workflow_id": { "type": "string" } }),
                &["workflow_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_preview_workflow",
            description: "预览执行计划（顺序、风险等级、桌面影响），不执行。执行必须由用户在 Task Dock UI 内确认触发。",
            input_schema: schema(
                json!({
                    "workflow_id": { "type": "string" },
                    "max_steps": { "type": "integer", "minimum": 1, "maximum": 100 }
                }),
                &["workflow_id"],
            ),
            write: false,
        },
    ]
}

fn ensure_read_global(ctx: &ToolCtx) -> Result<(), ToolError> {
    let ok = ctx
        .db
        .with_read(|conn| permissions::has_global(conn, &ctx.agent.row_id, Capability::WorkflowsRead))
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(
            "未授权 workflows.read 能力（列表需要用户授予全局工作流读取）".into(),
        ))
    }
}

fn ensure_read_one(ctx: &ToolCtx, workflow_id: &str) -> Result<(), ToolError> {
    let ok = ctx
        .db
        .with_read(|conn| {
            if permissions::has_global(conn, &ctx.agent.row_id, Capability::WorkflowsRead)? {
                return Ok(true);
            }
            permissions::has(
                conn,
                &ctx.agent.row_id,
                Capability::WorkflowsRead,
                workflow_id,
            )
        })
        .map_err(ToolError::Failed)?;
    if ok {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权读取工作流 {workflow_id}（缺少 workflows.read 全局或该工作流授权）"
        )))
    }
}

fn risk_of(step_type: &str) -> (&'static str, bool, &'static str) {
    match step_type {
        "create_task" => ("low", false, "只在本机创建任务，不改变桌面焦点"),
        "open_app" => ("medium", true, "会启动应用并抢占前台焦点"),
        "open_url" => ("medium", true, "会用默认浏览器打开网页并抢占焦点"),
        "open_path" => ("medium", true, "会调用系统默认程序打开文件/目录"),
        "enter_scene" => ("high", true, "会按场景清单批量打开应用/网页/目录"),
        "restore_workspace" => ("high", true, "会恢复窗口快照，影响当前桌面布局"),
        _ => ("unknown", false, "未知步骤类型，执行前必须人工确认"),
    }
}

fn step_type_label(step_type: &str) -> &'static str {
    match step_type {
        "open_app" => "打开应用 / 激活窗口",
        "open_url" => "打开网页",
        "open_path" => "打开文件或目录",
        "create_task" => "创建任务",
        "enter_scene" => "进入场景",
        "restore_workspace" => "恢复工作现场",
        _ => "未知步骤",
    }
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    _write_conn: Option<&Connection>,
) -> Result<Option<CallOutcome>, ToolError> {
    let db = ctx.db.as_ref();
    match name {
        "taskdock_list_workflows" => {
            ensure_read_global(ctx)?;
            let rows = store::list_workflows(db).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(rows).map_err(AppError::from)?;
            Ok(Some(outcome(value, "workflow", String::new(), None)))
        }
        "taskdock_get_workflow" => {
            let id = require_str(args, "workflow_id")?;
            ensure_read_one(ctx, &id)?;
            let (row, steps) = store::get_workflow(db, &id).map_err(ToolError::Failed)?;
            let value = json!({
                "workflow": serde_json::to_value(&row).map_err(AppError::from)?,
                "steps": serde_json::to_value(&steps).map_err(AppError::from)?,
            });
            Ok(Some(outcome(value, "workflow", id, None)))
        }
        "taskdock_list_workflow_runs" => {
            let id = require_str(args, "workflow_id")?;
            ensure_read_one(ctx, &id)?;
            let limit = args
                .get("limit")
                .and_then(|v| v.as_i64())
                .unwrap_or(20)
                .clamp(1, 100);
            let offset = args
                .get("offset")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .max(0);
            let page = store::list_runs(db, &id, limit, offset).map_err(ToolError::Failed)?;
            let value = serde_json::to_value(page).map_err(AppError::from)?;
            Ok(Some(outcome(value, "workflow_run", id, None)))
        }
        "taskdock_check_workflow" => {
            let id = require_str(args, "workflow_id")?;
            ensure_read_one(ctx, &id)?;
            let (row, steps) = store::get_workflow(db, &id).map_err(ToolError::Failed)?;
            let mut blockers = Vec::new();
            let mut checked = 0usize;
            for step in &steps {
                checked += 1;
                if let Err(error) = crate::workflows::validate_step(
                    db,
                    &step.step_type,
                    &step.params,
                    true,
                ) {
                    blockers.push(json!({
                        "stepId": step.id,
                        "order": step.display_order,
                        "type": step.step_type,
                        "reason": error.user_message(),
                        "enabled": step.enabled,
                    }));
                }
            }
            let enabled_steps = steps.iter().filter(|s| s.enabled).count();
            let executable = row.enabled && enabled_steps > 0 && blockers.is_empty();
            let value = json!({
                "workflowId": row.id,
                "enabled": row.enabled,
                "stepCount": steps.len(),
                "enabledStepCount": enabled_steps,
                "checkedStepCount": checked,
                "executable": executable,
                "blockers": blockers,
                "executionSupportedByMcp": false,
                "note": "MCP 不执行工作流；executable 仅表示在 Task Dock UI 内具备执行条件。",
            });
            Ok(Some(outcome(value, "workflow", id, None)))
        }
        "taskdock_preview_workflow" => {
            let id = require_str(args, "workflow_id")?;
            ensure_read_one(ctx, &id)?;
            let (row, steps) = store::get_workflow(db, &id).map_err(ToolError::Failed)?;
            let max_steps = args
                .get("max_steps")
                .and_then(|v| v.as_u64())
                .unwrap_or(100)
                .clamp(1, 100) as usize;
            let mut plan = Vec::new();
            let mut highest = "none";
            for step in steps.iter().filter(|s| s.enabled).take(max_steps) {
                let (risk, desktop, reason) = risk_of(&step.step_type);
                if rank(risk) > rank(highest) {
                    highest = risk;
                }
                plan.push(json!({
                    "order": step.display_order,
                    "stepId": step.id,
                    "type": step.step_type,
                    "label": step_type_label(&step.step_type),
                    "onError": step.on_error,
                    "risk": risk,
                    "desktopAffecting": desktop,
                    "reason": reason,
                    "params": step.params,
                }));
            }
            let pending_validation: Vec<Value> = steps
                .iter()
                .filter(|s| {
                    crate::workflows::validate_step(db, &s.step_type, &s.params, true).is_err()
                })
                .map(|s| json!({ "stepId": s.id, "type": s.step_type }))
                .collect();
            let value = json!({
                "workflowId": row.id,
                "name": row.name,
                "enabled": row.enabled,
                "plan": plan,
                "riskLevel": highest,
                "requiresUserConfirmation": true,
                "executionSupportedByMcp": false,
                "invalidSteps": pending_validation,
                "note": "预览只读。执行会打开应用/网页/目录或恢复桌面现场，必须由用户在 Task Dock 内确认。",
            });
            Ok(Some(outcome(value, "workflow", id, None)))
        }
        _ => Ok(None),
    }
}

fn rank(risk: &str) -> u8 {
    match risk {
        "none" => 0,
        "low" => 1,
        "medium" => 2,
        "high" => 3,
        _ => 4,
    }
}
