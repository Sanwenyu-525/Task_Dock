//! 协作中心 MCP 工具（外部 Agent 入口）。
//!
//! 命名统一 `taskdock_collab_*`，与既有 `taskdock_*` 不冲突；所有工具都走
//! `Core` 服务层，权限来自 MCP scope + 项目 grant，审批类工具**不暴露**给 Agent。

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::mcp::tools::{
    outcome, require_revision, require_str, schema, CallOutcome, ToolCtx, ToolDef, ToolError,
};

use super::actor::Actor;
use super::model::*;
use super::service::Core;

const PREFIX: &str = "taskdock_collab_";

pub(crate) fn is_owned(name: &str) -> bool {
    name.starts_with(PREFIX)
}

fn map_err(e: AppError) -> ToolError {
    match e {
        AppError::Forbidden(_) => ToolError::Authz(e.to_string()),
        other => ToolError::Failed(other),
    }
}

fn arg_strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn actor_of(ctx: &ToolCtx) -> Actor {
    Actor::agent(&ctx.agent, "mcp")
}

fn read<T>(
    ctx: &ToolCtx,
    f: impl FnOnce(&Core<'_>) -> crate::error::AppResult<T>,
) -> Result<Value, ToolError>
where
    T: serde::Serialize,
{
    ctx.db
        .with_conn(|conn| {
            let core = Core::new(conn);
            let value = f(&core)?;
            serde_json::to_value(value).map_err(AppError::from)
        })
        .map_err(map_err)
}

fn write<T>(
    write_conn: Option<&Connection>,
    f: impl FnOnce(&Core<'_>) -> crate::error::AppResult<T>,
) -> Result<Value, ToolError>
where
    T: serde::Serialize,
{
    let conn = write_conn
        .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
    let core = Core::new(conn);
    let value = f(&core).map_err(map_err)?;
    serde_json::to_value(value).map_err(|e| ToolError::Failed(AppError::from(e)))
}

pub fn definitions_for_registry() -> Vec<ToolDef> {
    let project = json!({ "type": "string", "description": "规划中心项目 ID" });
    vec![
        ToolDef {
            name: "taskdock_collab_get_project_context",
            description:
                "读取项目上下文（概览/架构/知识/需求/Bug/方案/任务/可视化）。支持 include 分区、分页；Agent 只能读取已授权项目。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "include": { "type": "array", "items": { "type": "string" },
                        "description": "分区：overview/architecture/knowledge/issues/bugs/plans/tasks/visuals；空=overview+issues+plans+tasks" },
                    "page": { "type": "integer", "minimum": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 50 },
                }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_list_issues",
            description: "分页列出一个项目的需求与 Bug（可按状态/类型/优先级/关键词过滤）。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "status": { "type": "string" },
                    "kind": { "type": "string", "description": "feature/bug/improvement/..." },
                    "priority": { "type": "string", "description": "P0-P3" },
                    "search": { "type": "string", "maxLength": 200 },
                    "include_archived": { "type": "boolean" },
                    "page": { "type": "integer", "minimum": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 100 },
                }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_get_issue",
            description: "读取单条需求/Bug 详情，含关联、证据与关联方案。",
            input_schema: schema(
                json!({ "issue_id": { "type": "string" } }),
                &["issue_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_create_issue",
            description:
                "创建需求/改进/架构/性能/安全/技术债等条目。来源由服务端记录；requestId 相同会幂等重放。返回重复候选仅供提示，不自动合并。",
            input_schema: issue_schema(false),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_create_bug",
            description:
                "提交 Bug（描述、复现步骤、预期/实际结果、环境、相关文件）。可附证据；重复 Bug 只提示不自动合并。",
            input_schema: issue_schema(true),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_update_issue",
            description: "按 revision 乐观并发更新需求/Bug；不能把状态直接改为 verified/closed。",
            input_schema: schema(
                json!({
                    "issue_id": { "type": "string" },
                    "expected_revision": { "type": "integer", "minimum": 1 },
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 20000 },
                    "impact": { "type": "string", "maxLength": 5000 },
                    "priority": { "type": "string" },
                    "acceptance": { "type": "string", "maxLength": 5000 },
                    "repro_steps": { "type": "array", "items": { "type": "string" } },
                    "expected_result": { "type": "string", "maxLength": 5000 },
                    "actual_result": { "type": "string", "maxLength": 5000 },
                    "environment": { "type": "string", "maxLength": 2000 },
                    "related_files": { "type": "array", "items": { "type": "string" } },
                    "status": { "type": "string" },
                    "assignee": { "type": "string", "maxLength": 100 },
                }),
                &["issue_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_attach_evidence",
            description:
                "给需求/Bug/方案/任务/可视化附加证据（文件路径或文本）。文件 ≤32MiB，白名单扩展名；同一内容幂等去重。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "subject_kind": { "type": "string", "description": "issue/bug/plan/task/visual" },
                    "subject_id": { "type": "string" },
                    "kind": { "type": "string", "description": "screenshot/log/stack/video/report/test/other" },
                    "title": { "type": "string", "maxLength": 200 },
                    "path": { "type": "string", "description": "本机可读文件路径；与 text 二选一" },
                    "text": { "type": "string", "description": "文本证据内容 ≤1MiB；与 path 二选一" },
                    "mime": { "type": "string" },
                }),
                &["project_id", "subject_kind", "subject_id", "kind"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_list_plans",
            description: "分页列出项目方案（可按状态过滤）。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "status": { "type": "string" },
                    "page": { "type": "integer", "minimum": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 100 },
                }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_get_plan",
            description: "读取方案详情：正文、任务草案、关联可视化、已拆解任务、证据。",
            input_schema: schema(json!({ "plan_id": { "type": "string" } }), &["plan_id"]),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_create_plan",
            description:
                "从需求创建方案（同一需求只允许一个方案）。可同时写 summary/solution/breakdown；审批必须由开发者完成。",
            input_schema: schema(
                json!({
                    "issue_id": { "type": "string" },
                    "summary": { "type": "string", "maxLength": 2000 },
                    "solution": { "type": "string", "maxLength": 20000 },
                    "breakdown": { "type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string", "maxLength": 200 },
                            "description": { "type": "string", "maxLength": 5000 },
                            "priority": { "type": "integer", "minimum": 0, "maximum": 3 }
                        },
                        "required": ["title"],
                        "additionalProperties": false
                    }},
                }),
                &["issue_id"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_update_plan",
            description: "按 revision 更新方案内容/任务草案；状态推进走 submit，审批不可由 Agent 执行。",
            input_schema: schema(
                json!({
                    "plan_id": { "type": "string" },
                    "expected_revision": { "type": "integer", "minimum": 1 },
                    "title": { "type": "string", "maxLength": 200 },
                    "summary": { "type": "string", "maxLength": 2000 },
                    "solution": { "type": "string", "maxLength": 20000 },
                    "breakdown": { "type": "array", "items": { "type": "object" } },
                }),
                &["plan_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_submit_plan",
            description: "把草稿/修改中的方案提交审阅；Agent 只能提交，不能批准。",
            input_schema: schema(
                json!({
                    "plan_id": { "type": "string" },
                    "expected_revision": { "type": "integer", "minimum": 1 },
                }),
                &["plan_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_create_visualization",
            description:
                "提交任意结构化可视化文档（流程/架构/数据流/原型/静态图/Bug 标注）。内容必须是可重新编辑的结构化 JSON 或受限 Mermaid；服务端校验后生成 v1 并写审计，authoring_mode=agent_authored。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "kind": { "type": "string", "enum": [
                        "flowchart","architecture","dataflow","prototype","static_image","bug_annotation"
                    ] },
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 20000 },
                    "source_format": { "type": "string", "enum": ["json","mermaid","image","svg"] },
                    "source_content": { "type": "string", "description": "结构化内容；静态图/标注使用 assetId 引用已导入资产" },
                    "plan_id": { "type": "string", "description": "可选关联方案（必须同项目）" },
                }),
                &["project_id", "kind", "title", "source_content"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_generate_visualization",
            description:
                "用文本生成流程图/架构图/数据流图/原型。当前 Provider 为本地结构化规则生成（非模型），返回 job 中明确 provider/model。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "plan_id": { "type": "string" },
                    "issue_id": { "type": "string" },
                    "kind": { "type": "string", "enum": ["flowchart", "architecture", "dataflow", "prototype"] },
                    "prompt": { "type": "string", "maxLength": 4000 },
                }),
                &["project_id", "kind", "prompt"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_create_prototype",
            description: "生成可交互原型（结构化组件 DSL，不执行 HTML/JS）。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "plan_id": { "type": "string" },
                    "issue_id": { "type": "string" },
                    "prompt": { "type": "string", "maxLength": 4000 },
                }),
                &["project_id", "prompt"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_modify_visualization",
            description:
                "按 revision 更新可视化内容（结构化 JSON/Mermaid）；生成新版本，旧版本保留可回滚。",
            input_schema: schema(
                json!({
                    "document_id": { "type": "string" },
                    "expected_revision": { "type": "integer", "minimum": 1 },
                    "title": { "type": "string", "maxLength": 200 },
                    "source_content": { "type": "string", "description": "完整源内容（JSON 或 Mermaid）" },
                    "change_summary": { "type": "string", "maxLength": 500 },
                }),
                &["document_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_patch_prototype",
            description: "对原型做组件级增量 Patch（add/update/remove/move/style/events/page_add/page_remove/page_rename），生成新版本；update 可用 removeKeys 删除 props/style/events 字段。",
            input_schema: schema(
                json!({
                    "document_id": { "type": "string" },
                    "expected_revision": { "type": "integer", "minimum": 1 },
                    "ops": { "type": "array", "minItems": 1, "maxItems": 100, "items": {
                        "type": "object",
                        "properties": {
                            "op": { "type": "string", "enum": [
                                "add","update","remove","move","style","events",
                                "page_add","page_remove","page_rename"
                            ] },
                            "pageId": { "type": "string" },
                            "componentId": { "type": "string" },
                            "component": { "type": "object" },
                            "patch": { "type": "object" },
                            "removeKeys": {
                                "type": "object",
                                "properties": {
                                    "props": { "type": "array", "items": { "type": "string" }, "maxItems": 200 },
                                    "style": { "type": "array", "items": { "type": "string" }, "maxItems": 200 },
                                    "events": { "type": "array", "items": { "type": "string" }, "maxItems": 200 }
                                },
                                "additionalProperties": false
                            },
                            "x": { "type": "number" },
                            "y": { "type": "number" },
                            "name": { "type": "string" },
                            "page": { "type": "object" }
                        },
                        "required": ["op"],
                        "additionalProperties": false
                    }},
                    "change_summary": { "type": "string", "maxLength": 500 },
                }),
                &["document_id", "expected_revision", "ops"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_get_visualization",
            description: "读取可视化文档（含结构化源内容、renderer、version/revision）。",
            input_schema: schema(
                json!({ "document_id": { "type": "string" } }),
                &["document_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_list_visualizations",
            description: "分页列出项目可视化文档（可按类型）。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "kind": { "type": "string" },
                    "page": { "type": "integer", "minimum": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 100 },
                }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_visual_versions",
            description: "列出版本历史；compare 可比较两个版本。",
            input_schema: schema(
                json!({
                    "document_id": { "type": "string" },
                    "page": { "type": "integer", "minimum": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 100 },
                }),
                &["document_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_compare_visual_versions",
            description: "比较两个版本的字段/节点/组件差异。",
            input_schema: schema(
                json!({
                    "document_id": { "type": "string" },
                    "from_version": { "type": "integer", "minimum": 1 },
                    "to_version": { "type": "integer", "minimum": 1 },
                }),
                &["document_id", "from_version", "to_version"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_get_prototype",
            description: "读取原型文档与默认交互状态。",
            input_schema: schema(
                json!({ "document_id": { "type": "string" } }),
                &["document_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_prototype_state",
            description: "读取原型默认状态（当前页、弹窗、表单值）。",
            input_schema: schema(
                json!({ "document_id": { "type": "string" } }),
                &["document_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_create_tasks_from_plan",
            description: "把已批准方案的任务草案拆解为 TaskDock 任务；重复调用幂等返回已存在任务。",
            input_schema: schema(json!({ "plan_id": { "type": "string" } }), &["plan_id"]),
            write: true,
        },
        ToolDef {
            name: "taskdock_collab_plan_progress",
            description: "读取方案开发进度（任务总数/完成/孤儿；空分母返回 null）。",
            input_schema: schema(json!({ "plan_id": { "type": "string" } }), &["plan_id"]),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_detect_duplicates",
            description: "提交前检测相似需求/Bug，仅返回候选，不自动合并。",
            input_schema: schema(
                json!({
                    "project_id": project,
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 20000 },
                    "kind": { "type": "string" },
                    "exclude_id": { "type": "string" },
                }),
                &["project_id", "title"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_collab_ai_notice",
            description: "返回当前文本/图像 Provider 的真实状态（未配置图像时明确返回 null，不伪造）。",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
    ]
}

fn issue_schema(is_bug: bool) -> Value {
    let mut props = json!({
        "project_id": { "type": "string", "description": "规划中心项目 ID" },
        "title": { "type": "string", "maxLength": 200 },
        "description": { "type": "string", "maxLength": 20000 },
        "impact": { "type": "string", "maxLength": 5000 },
        "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
        "acceptance": { "type": "string", "maxLength": 5000 },
        "repro_steps": { "type": "array", "items": { "type": "string" } },
        "expected_result": { "type": "string", "maxLength": 5000 },
        "actual_result": { "type": "string", "maxLength": 5000 },
        "environment": { "type": "string", "maxLength": 2000 },
        "related_files": { "type": "array", "items": { "type": "string" } },
        "assignee": { "type": "string", "maxLength": 100 },
        "source_session": { "type": "string", "maxLength": 256 },
        "requestId": { "type": "string", "maxLength": 128 },
    });
    if !is_bug {
        props["kind"] = json!({
            "type": "string",
            "enum": ["feature","improvement","architecture","performance","security","tech_debt","other"],
            "description": "条目类型；bug 请用 create_bug"
        });
    }
    schema(props, &["project_id", "title"])
}

fn issue_input(args: &Value, kind: Option<&str>) -> Result<IssueInput, ToolError> {
    let title = require_str(args, "title")?;
    Ok(IssueInput {
        kind: kind
            .map(|s| s.to_string())
            .or_else(|| args.get("kind").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| "feature".to_string()),
        title,
        description: args
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        impact: args
            .get("impact")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        priority: args
            .get("priority")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        acceptance: args
            .get("acceptance")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        repro_steps: arg_strings(args, "repro_steps"),
        expected_result: args
            .get("expected_result")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        actual_result: args
            .get("actual_result")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        environment: args
            .get("environment")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        related_files: arg_strings(args, "related_files"),
        assignee: args
            .get("assignee")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        source_session: args
            .get("source_session")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        client_request_id: args
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

fn issue_patch(args: &Value) -> IssuePatch {
    IssuePatch {
        title: args.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
        description: args
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        impact: args.get("impact").and_then(|v| v.as_str()).map(|s| s.to_string()),
        priority: args
            .get("priority")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        acceptance: args
            .get("acceptance")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        repro_steps: args
            .get("repro_steps")
            .map(|_| arg_strings(args, "repro_steps")),
        expected_result: args
            .get("expected_result")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        actual_result: args
            .get("actual_result")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        environment: args
            .get("environment")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        related_files: args
            .get("related_files")
            .map(|_| arg_strings(args, "related_files")),
        status: args.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
        assignee: args
            .get("assignee")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

fn breakdown(args: &Value) -> Option<Vec<TaskDraft>> {
    args.get("breakdown").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|item| {
                item.get("title").and_then(|v| v.as_str()).map(|title| TaskDraft {
                    title: title.to_string(),
                    description: item
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    priority: item
                        .get("priority")
                        .and_then(|v| v.as_u64())
                        .map(|p| p.min(3) as u8),
                })
            })
            .collect()
    })
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    write_conn: Option<&Connection>,
) -> Option<Result<CallOutcome, ToolError>> {
    if !is_owned(name) {
        return None;
    }
    Some(call_owned(ctx, name, args, write_conn))
}

fn call_owned(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    write_conn: Option<&Connection>,
) -> Result<CallOutcome, ToolError> {
    let actor = actor_of(ctx);
    match name {
        "taskdock_collab_get_project_context" => {
            let project_id = require_str(args, "project_id")?;
            let include = arg_strings(args, "include");
            let page = args.get("page").and_then(|v| v.as_i64());
            let page_size = args.get("page_size").and_then(|v| v.as_i64());
            let value = read(ctx, |core| {
                core.project_context(&actor, &project_id, &include, page, page_size)
            })?;
            Ok(outcome(value, "project", project_id, None))
        }
        "taskdock_collab_list_issues" => {
            let project_id = require_str(args, "project_id")?;
            let filter = IssueFilter {
                status: args.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                kind: args.get("kind").and_then(|v| v.as_str()).map(|s| s.to_string()),
                priority: args
                    .get("priority")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                search: args.get("search").and_then(|v| v.as_str()).map(|s| s.to_string()),
                include_archived: args
                    .get("include_archived")
                    .and_then(|v| v.as_bool()),
                page: args.get("page").and_then(|v| v.as_i64()),
                page_size: args.get("page_size").and_then(|v| v.as_i64()),
            };
            let value = read(ctx, |core| core.list_issues(&actor, &project_id, &filter))?;
            Ok(outcome(value, "issue", String::new(), None))
        }
        "taskdock_collab_get_issue" => {
            let id = require_str(args, "issue_id")?;
            let value = read(ctx, |core| core.get_issue(&actor, &id))?;
            Ok(outcome(value, "issue", id, None))
        }
        "taskdock_collab_create_issue" | "taskdock_collab_create_bug" => {
            let project_id = require_str(args, "project_id")?;
            let bug = name.ends_with("create_bug");
            let input = issue_input(args, if bug { Some("bug") } else { None })?;
            let value = write(write_conn, |core| {
                core.create_issue(&actor, &project_id, &input)
            })?;
            Ok(outcome(value, "issue", String::new(), None))
        }
        "taskdock_collab_update_issue" => {
            let id = require_str(args, "issue_id")?;
            let expected = require_revision(args)?;
            let patch = issue_patch(args);
            let value = write(write_conn, |core| {
                core.update_issue(&actor, &id, expected, &patch)
            })?;
            Ok(outcome(value, "issue", id, None))
        }
        "taskdock_collab_attach_evidence" => {
            let project_id = require_str(args, "project_id")?;
            let input = EvidenceInput {
                subject_kind: require_str(args, "subject_kind")?,
                subject_id: require_str(args, "subject_id")?,
                kind: require_str(args, "kind")?,
                title: args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                path: args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()),
                text: args.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()),
                mime: args.get("mime").and_then(|v| v.as_str()).map(|s| s.to_string()),
                meta: None,
            };
            let has_path = input.path.is_some();
            let value = write(write_conn, |core| {
                if has_path {
                    core.attach_evidence_path(&actor, &project_id, &input)
                } else if input.text.is_some() {
                    core.attach_evidence_text(&actor, &project_id, &input)
                } else {
                    Err(AppError::Validation(
                        "attach_evidence 需要 path 或 text".to_string(),
                    ))
                }
            })?;
            Ok(outcome(value, "evidence", String::new(), None))
        }
        "taskdock_collab_list_plans" => {
            let project_id = require_str(args, "project_id")?;
            let status = args.get("status").and_then(|v| v.as_str());
            let page = args.get("page").and_then(|v| v.as_i64());
            let page_size = args.get("page_size").and_then(|v| v.as_i64());
            let value = read(ctx, |core| {
                core.list_plans(&actor, &project_id, status, page, page_size)
            })?;
            Ok(outcome(value, "plan", String::new(), None))
        }
        "taskdock_collab_get_plan" => {
            let id = require_str(args, "plan_id")?;
            let value = read(ctx, |core| core.get_plan(&actor, &id))?;
            Ok(outcome(value, "plan", id, None))
        }
        "taskdock_collab_create_plan" => {
            let issue_id = require_str(args, "issue_id")?;
            let value = write(write_conn, |core| {
                let plan = core.create_plan_from_issue(&actor, &issue_id)?;
                let summary = args.get("summary").and_then(|v| v.as_str());
                let solution = args.get("solution").and_then(|v| v.as_str());
                let bd = breakdown(args);
                if summary.is_none() && solution.is_none() && bd.is_none() {
                    return Ok(plan);
                }
                let patch = PlanPatch {
                    title: None,
                    summary: summary.map(|s| s.to_string()),
                    solution_md: solution.map(|s| s.to_string()),
                    breakdown: bd,
                    status: None,
                    review_note: None,
                };
                core.update_plan(&actor, &plan.id, plan.revision, &patch)
            })?;
            Ok(outcome(value, "plan", String::new(), None))
        }
        "taskdock_collab_update_plan" => {
            let id = require_str(args, "plan_id")?;
            let expected = require_revision(args)?;
            let patch = PlanPatch {
                title: args.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                summary: args
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                solution_md: args
                    .get("solution")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                breakdown: breakdown(args),
                status: None,
                review_note: None,
            };
            let value = write(write_conn, |core| {
                core.update_plan(&actor, &id, expected, &patch)
            })?;
            Ok(outcome(value, "plan", id, None))
        }
        "taskdock_collab_submit_plan" => {
            let id = require_str(args, "plan_id")?;
            let expected = require_revision(args)?;
            let value = write(write_conn, |core| {
                core.submit_plan(&actor, &id, expected)
            })?;
            Ok(outcome(value, "plan", id, None))
        }
        "taskdock_collab_create_visualization" => {
            let project_id = require_str(args, "project_id")?;
            let kind = require_str(args, "kind")?;
            let title = require_str(args, "title")?;
            let input = VisualInput {
                title,
                description: args
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind,
                source_format: args
                    .get("source_format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("json")
                    .to_string(),
                source_content: require_str(args, "source_content")?,
                plan_id: args.get("plan_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                preview_asset: None,
                authoring_mode: None,
            };
            let value = write(write_conn, |core| {
                core.create_visual(&actor, &project_id, &input)
            })?;
            Ok(outcome(value, "visual", String::new(), None))
        }
        "taskdock_collab_generate_visualization" => {
            let project_id = require_str(args, "project_id")?;
            let kind = require_str(args, "kind")?;
            let prompt = require_str(args, "prompt")?;
            let plan_id = args.get("plan_id").and_then(|v| v.as_str());
            let issue_id = args.get("issue_id").and_then(|v| v.as_str());
            let value = write(write_conn, |core| {
                core.generate_visual(&actor, &project_id, plan_id, issue_id, &kind, &prompt)
            })?;
            Ok(outcome(value, "ai_job", String::new(), None))
        }
        "taskdock_collab_create_prototype" => {
            let project_id = require_str(args, "project_id")?;
            let prompt = require_str(args, "prompt")?;
            let plan_id = args.get("plan_id").and_then(|v| v.as_str());
            let issue_id = args.get("issue_id").and_then(|v| v.as_str());
            let value = write(write_conn, |core| {
                core.generate_visual(
                    &actor,
                    &project_id,
                    plan_id,
                    issue_id,
                    "prototype",
                    &prompt,
                )
            })?;
            Ok(outcome(value, "ai_job", String::new(), None))
        }
        "taskdock_collab_modify_visualization" => {
            let id = require_str(args, "document_id")?;
            let expected = require_revision(args)?;
            let patch = VisualPatch {
                title: args.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                description: None,
                source_format: None,
                source_content: args
                    .get("source_content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                preview_asset: None,
                status: None,
                authoring_mode: None,
                ai_job_id: None,
            };
            let summary = args
                .get("change_summary")
                .and_then(|v| v.as_str())
                .unwrap_or("MCP 更新");
            let value = write(write_conn, |core| {
                core.update_visual(&actor, &id, expected, &patch, summary)
            })?;
            Ok(outcome(value, "visual", id, None))
        }
        "taskdock_collab_patch_prototype" => {
            let id = require_str(args, "document_id")?;
            let expected = require_revision(args)?;
            let ops: Vec<PatchOp> = args
                .get("ops")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or_else(|| {
                    ToolError::Failed(AppError::Validation("ops 参数不合法".to_string()))
                })?;
            let summary = args
                .get("change_summary")
                .and_then(|v| v.as_str())
                .unwrap_or("MCP 原型 Patch");
            let value = write(write_conn, |core| {
                core.apply_prototype_patch(&actor, &id, expected, &ops, summary)
            })?;
            Ok(outcome(value, "visual", id, None))
        }
        "taskdock_collab_get_visualization" => {
            let id = require_str(args, "document_id")?;
            let value = read(ctx, |core| core.get_visual(&actor, &id))?;
            Ok(outcome(value, "visual", id, None))
        }
        "taskdock_collab_list_visualizations" => {
            let project_id = require_str(args, "project_id")?;
            let kind = args.get("kind").and_then(|v| v.as_str());
            let page = args.get("page").and_then(|v| v.as_i64());
            let page_size = args.get("page_size").and_then(|v| v.as_i64());
            let value = read(ctx, |core| {
                core.list_visuals(&actor, &project_id, kind, page, page_size)
            })?;
            Ok(outcome(value, "visual", String::new(), None))
        }
        "taskdock_collab_visual_versions" => {
            let id = require_str(args, "document_id")?;
            let page = args.get("page").and_then(|v| v.as_i64());
            let page_size = args.get("page_size").and_then(|v| v.as_i64());
            let value = read(ctx, |core| {
                core.visual_versions(&actor, &id, page, page_size)
            })?;
            Ok(outcome(value, "visual_version", id, None))
        }
        "taskdock_collab_compare_visual_versions" => {
            let id = require_str(args, "document_id")?;
            let from = args
                .get("from_version")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少 from_version".into())))?;
            let to = args
                .get("to_version")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少 to_version".into())))?;
            let value = read(ctx, |core| core.compare_visual(&actor, &id, from, to))?;
            Ok(outcome(value, "visual_diff", id, None))
        }
        "taskdock_collab_get_prototype" | "taskdock_collab_prototype_state" => {
            let id = require_str(args, "document_id")?;
            let value = read(ctx, |core| core.prototype_state(&actor, &id))?;
            Ok(outcome(value, "prototype_state", id, None))
        }
        "taskdock_collab_create_tasks_from_plan" => {
            let id = require_str(args, "plan_id")?;
            let value = write(write_conn, |core| {
                core.create_tasks_from_plan(&actor, &id)
            })?;
            Ok(outcome(value, "plan", id, None))
        }
        "taskdock_collab_plan_progress" => {
            let id = require_str(args, "plan_id")?;
            let value = read(ctx, |core| core.plan_progress(&actor, &id))?;
            Ok(outcome(value, "plan_progress", id, None))
        }
        "taskdock_collab_detect_duplicates" => {
            let project_id = require_str(args, "project_id")?;
            let title = require_str(args, "title")?;
            let description = args
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("bug");
            let exclude = args.get("exclude_id").and_then(|v| v.as_str());
            let value = read(ctx, |core| {
                core.detect_duplicates(&actor, &project_id, &title, description, kind, exclude)
            })?;
            Ok(outcome(value, "issue", String::new(), None))
        }
        "taskdock_collab_ai_notice" => {
            let value = read(ctx, |core| Ok(core.ai_notice()))?;
            Ok(outcome(value, "ai_notice", String::new(), None))
        }
        other => Err(ToolError::Failed(AppError::NotFound(format!(
            "未知协作工具 {other}"
        )))),
    }
}
