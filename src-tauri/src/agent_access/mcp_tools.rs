//! Agent 共享工作空间的新增 MCP 工具、Resources 与 Prompts。
//!
//! 这些工具**不复制**既有工具：任务/规划/知识仍调用同一 service 层与既有 `*_impl`。
//! 注册方式：`mcp::tools::tool_defs()` 追加 `defs()`，`call()` 先查 `is_owned()` 再分发。
//! 写工具在 `write: false` 下由 service 自己开事务（不与 MCP 写事务嵌套），
//! 授权、版本与审计由统一层负责。

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::tools::{arg_str, outcome, schema, CallOutcome, ToolCtx, ToolDef, ToolError};

use super::{context, handoff, service, store, workspace, Principal, Source};

fn principal_of(ctx: &ToolCtx) -> Principal {
    Principal::agent(ctx.agent.row_id.clone(), ctx.agent.agent_id.clone(), Source::Mcp)
}

/// 必填字符串参数（统一转成 `AppError`，与 service 的错误码体系一致）。
fn need(args: &Value, key: &str) -> AppResult<String> {
    arg_str(args, key)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::Validation(format!("缺少参数 {key}")))
}

fn strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

pub(crate) fn defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "taskdock_get_project_status",
            description: "读取项目状态：进度百分比、功能/条目计数、阻塞项与建议下一步。",
            input_schema: schema(
                json!({ "project_id": { "type": "string", "description": "规划项目或工作空间项目 ID" } }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_plans",
            description: "列出规划（里程碑 + 功能 + 进度），可按项目过滤。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                    "offset": { "type": "integer", "minimum": 0 }
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_current_plan",
            description: "读取当前进行中的规划（优先 in_progress，其次 planning）；没有则返回 null。",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_plan_details",
            description: "读取单个项目的完整计划：里程碑、功能、步骤与最近活动。",
            input_schema: schema(
                json!({ "project_id": { "type": "string" } }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_create_knowledge",
            description: "写入文本知识（默认落到项目知识库或 Agent Inbox），返回文档与 revision。",
            input_schema: schema(
                json!({
                    "title": { "type": "string", "maxLength": 200 },
                    "content": { "type": "string" },
                    "kb_id": { "type": "string" },
                    "kb_name": { "type": "string" }
                }),
                &["title", "content"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_update_knowledge",
            description: "更新文本知识正文/标题（需 expected_revision）；文件来源文档拒绝改正文。",
            input_schema: schema(
                json!({
                    "document_id": { "type": "string" },
                    "expected_revision": { "type": "integer" },
                    "title": { "type": "string" },
                    "content": { "type": "string" }
                }),
                &["document_id", "expected_revision"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_knowledge",
            description: "读取知识文档详情（含正文、分块数与 revision）。",
            input_schema: schema(
                json!({ "document_id": { "type": "string" } }),
                &["document_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_decisions",
            description: "列出架构/产品决策（ADR），可按项目与状态过滤。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "status": { "type": "string", "enum": ["proposed", "accepted", "superseded", "rejected"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_decision",
            description: "读取单条决策详情（背景/决策/后果/备选方案/revision）。",
            input_schema: schema(
                json!({ "decision_id": { "type": "string" } }),
                &["decision_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_create_decision",
            description: "记录一条决策（默认 proposed，可指定 accepted）。写入统一活动日志。",
            input_schema: schema(
                json!({
                    "title": { "type": "string" },
                    "decision": { "type": "string" },
                    "context": { "type": "string" },
                    "project_id": { "type": "string" },
                    "consequences": { "type": "string" },
                    "alternatives": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "status": { "type": "string", "enum": ["proposed", "accepted"] }
                }),
                &["title", "decision"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_complete_task",
            description: "完成任务（含完成事件、提醒与重复任务期次推进）；已完成再调用幂等。",
            input_schema: schema(
                json!({
                    "task_id": { "type": "string" },
                    "expected_revision": { "type": "integer" }
                }),
                &["task_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_project_context",
            description: "按项目装配上下文（Markdown + 结构化条目 + 访问方式），受 token 预算限制。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "budget_tokens": { "type": "integer", "minimum": 1000, "maximum": 24000 }
                }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_relevant_context",
            description: "按任务描述/任务 ID 装配相关上下文（项目、任务、计划、决策、知识、交接）。",
            input_schema: schema(
                json!({
                    "task": { "type": "string", "description": "自然语言任务描述" },
                    "task_id": { "type": "string" },
                    "project_id": { "type": "string" },
                    "budget_tokens": { "type": "integer", "minimum": 1000, "maximum": 24000 }
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_recent_context",
            description: "读取近期变更与四入口活动（不返回正文）。",
            input_schema: schema(
                json!({ "limit": { "type": "integer", "minimum": 1, "maximum": 100 } }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_create_handoff",
            description: "创建 Agent 交接（必须指定目标 Agent）；状态 pending，等待目标接收。",
            input_schema: schema(
                json!({
                    "to_agent_id": { "type": "string" },
                    "summary": { "type": "string", "maxLength": 2000 },
                    "project_id": { "type": "string" },
                    "task_id": { "type": "string" },
                    "completed_items": { "type": "array", "items": { "type": "string" } },
                    "pending_items": { "type": "array", "items": { "type": "string" } },
                    "files_changed": { "type": "array", "items": { "type": "string" } },
                    "risks": { "type": "array", "items": { "type": "string" } },
                    "next_steps": { "type": "array", "items": { "type": "string" } }
                }),
                &["to_agent_id", "summary"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_handoff",
            description: "读取交接详情（状态、来源、目标、关联任务、结构化字段与 revision）。",
            input_schema: schema(
                json!({ "handoff_id": { "type": "string" } }),
                &["handoff_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_handoffs",
            description: "列出交接，可按状态（pending/accepted/rejected/completed/cancelled）过滤。",
            input_schema: schema(
                json!({
                    "status": { "type": "string" },
                    "project_id": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_submit_work_report",
            description: "提交工作报告（追加式，不可修改）；可关联交接/项目/任务与证据元数据。",
            input_schema: schema(
                json!({
                    "summary": { "type": "string", "maxLength": 4000 },
                    "result": { "type": "string", "enum": ["completed", "partial", "blocked", "failed"] },
                    "project_id": { "type": "string" },
                    "task_id": { "type": "string" },
                    "handoff_id": { "type": "string" },
                    "completed_items": { "type": "array", "items": { "type": "string" } },
                    "pending_items": { "type": "array", "items": { "type": "string" } },
                    "files_changed": { "type": "array", "items": { "type": "string" } },
                    "risks": { "type": "array", "items": { "type": "string" } }
                }),
                &["summary"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_search",
            description: "跨类型检索：任务、知识、决策、项目（阶段一为 SQLite 关键词/标题匹配）。",
            input_schema: schema(
                json!({
                    "query": { "type": "string", "minLength": 1 },
                    "kinds": { "type": "array", "items": { "type": "string", "enum": ["task", "knowledge", "decision", "project"] } },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                }),
                &["query"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_agent_registry",
            description: "列出已注册 Agent（scope、厂商、最近访问、是否撤销）。",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
        ToolDef {
            name: "taskdock_agent_activity",
            description: "列出四入口统一活动日志（可按 agent/interface/since 过滤）。",
            input_schema: schema(
                json!({
                    "agent_id": { "type": "string" },
                    "interface": { "type": "string", "enum": ["cli", "mcp", "rest", "file", "ui", "system"] },
                    "since": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                }),
                &[],
            ),
            write: false,
        },
    ]
}

pub const NAMES: &[&str] = &[
    "taskdock_get_project_status",
    "taskdock_list_plans",
    "taskdock_get_current_plan",
    "taskdock_get_plan_details",
    "taskdock_create_knowledge",
    "taskdock_update_knowledge",
    "taskdock_get_knowledge",
    "taskdock_list_decisions",
    "taskdock_get_decision",
    "taskdock_create_decision",
    "taskdock_complete_task",
    "taskdock_get_project_context",
    "taskdock_get_relevant_context",
    "taskdock_get_recent_context",
    "taskdock_create_handoff",
    "taskdock_get_handoff",
    "taskdock_list_handoffs",
    "taskdock_submit_work_report",
    "taskdock_search",
    "taskdock_agent_registry",
    "taskdock_agent_activity",
];

pub fn is_owned(name: &str) -> bool {
    NAMES.contains(&name)
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    _write_conn: Option<&rusqlite::Connection>,
) -> Option<Result<CallOutcome, ToolError>> {
    let db = ctx.db.as_ref();
    let principal = principal_of(ctx);
    let result = (|| -> AppResult<(Value, &'static str, String)> {
        match name {
            "taskdock_get_project_status" => {
                let id = need(args, "project_id")?;
                let status = service::project_status(db, &principal, &id)?;
                Ok((serde_json::to_value(status)?, "project", id))
            }
            "taskdock_list_plans" => {
                let project = arg_str(args, "project_id");
                let limit = int_arg(args, "limit").unwrap_or(50).clamp(1, 200) as u32;
                let offset = int_arg(args, "offset").unwrap_or(0).max(0) as u32;
                let (plans, page) =
                    service::list_plans(db, &principal, project, limit, offset)?;
                Ok((
                    json!({ "items": plans, "page": page }),
                    "plan",
                    String::new(),
                ))
            }
            "taskdock_get_current_plan" => {
                let plan = service::current_plan(db, &principal)?;
                Ok((serde_json::to_value(plan)?, "plan", String::new()))
            }
            "taskdock_get_plan_details" => {
                let id = need(args, "project_id")?;
                let plan = service::get_plan(db, &principal, &id)?;
                Ok((serde_json::to_value(plan)?, "plan", id))
            }
            "taskdock_create_knowledge" => {
                let input = service::KnowledgeCreateInput {
                    title: need(args, "title")?,
                    content: need(args, "content")?,
                    kb_id: arg_str(args, "kb_id").map(str::to_string),
                    kb_name: arg_str(args, "kb_name").map(str::to_string),
                };
                let doc = service::create_knowledge(db, &principal, input)?;
                Ok((serde_json::to_value(&doc)?, "knowledge", doc.id))
            }
            "taskdock_update_knowledge" => {
                let id = need(args, "document_id")?;
                let patch = service::KnowledgePatch {
                    title: arg_str(args, "title").map(str::to_string),
                    content: arg_str(args, "content").map(str::to_string),
                };
                let doc = service::update_knowledge(
                    db,
                    &principal,
                    &id,
                    patch,
                    int_arg(args, "expected_revision"),
                )?;
                Ok((serde_json::to_value(&doc)?, "knowledge", id))
            }
            "taskdock_get_knowledge" => {
                let id = need(args, "document_id")?;
                let doc = service::get_knowledge(db, &principal, &id)?;
                Ok((serde_json::to_value(&doc)?, "knowledge", id))
            }
            "taskdock_list_decisions" => {
                let project = arg_str(args, "project_id");
                let status = arg_str(args, "status");
                let limit = int_arg(args, "limit").unwrap_or(50).clamp(1, 200) as u32;
                let (items, page) =
                    service::list_decisions_authorized(db, &principal, project, status, limit, 0)?;
                Ok((
                    json!({ "items": items, "page": page }),
                    "decision",
                    String::new(),
                ))
            }
            "taskdock_get_decision" => {
                let id = need(args, "decision_id")?;
                let decision = service::get_decision_authorized(db, &principal, &id)?;
                Ok((serde_json::to_value(&decision)?, "decision", id))
            }
            "taskdock_create_decision" => {
                let input = store::DecisionInput {
                    title: need(args, "title")?,
                    project_id: arg_str(args, "project_id").map(str::to_string),
                    project_kind: None,
                    context: arg_str(args, "context").unwrap_or("").to_string(),
                    decision: need(args, "decision")?,
                    consequences: arg_str(args, "consequences").unwrap_or("").to_string(),
                    alternatives: arg_str(args, "alternatives").unwrap_or("").to_string(),
                    tags: strings(args, "tags"),
                    status: arg_str(args, "status").map(str::to_string),
                };
                let created = store::create_decision(db, &principal, input)?;
                Ok((serde_json::to_value(&created)?, "decision", created.id))
            }
            "taskdock_complete_task" => {
                let id = need(args, "task_id")?;
                let task = service::complete_task(
                    db,
                    &principal,
                    &id,
                    int_arg(args, "expected_revision"),
                )?;
                Ok((serde_json::to_value(&task)?, "task", id))
            }
            "taskdock_get_project_context" => {
                let id = need(args, "project_id")?;
                let ctx = context::build(
                    db,
                    &principal,
                    context::ContextRequest {
                        project_id: Some(id.clone()),
                        budget_tokens: int_arg(args, "budget_tokens").map(|v| v as u32),
                        format: Some("json".into()),
                        ..Default::default()
                    },
                )?;
                Ok((context::to_json(&ctx)?, "context", id))
            }
            "taskdock_get_relevant_context" => {
                let ctx = context::build(
                    db,
                    &principal,
                    context::ContextRequest {
                        task: arg_str(args, "task").map(str::to_string),
                        task_id: arg_str(args, "task_id").map(str::to_string),
                        project_id: arg_str(args, "project_id").map(str::to_string),
                        budget_tokens: int_arg(args, "budget_tokens").map(|v| v as u32),
                        format: Some("json".into()),
                        ..Default::default()
                    },
                )?;
                Ok((
                    context::to_json(&ctx)?,
                    "context",
                    ctx.project_id.clone(),
                ))
            }
            "taskdock_get_recent_context" => {
                let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 100) as u32;
                let items = context::recent(db, &principal, limit)?;
                Ok((serde_json::to_value(items)?, "context", String::new()))
            }
            "taskdock_create_handoff" => {
                let input = store::HandoffInput {
                    to_agent_id: need(args, "to_agent_id")?,
                    summary: need(args, "summary")?,
                    task_id: arg_str(args, "task_id").map(str::to_string),
                    project_id: arg_str(args, "project_id").map(str::to_string),
                    project_kind: None,
                    completed_items: strings(args, "completed_items"),
                    pending_items: strings(args, "pending_items"),
                    decisions: args
                        .get("decisions")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                    files_changed: strings(args, "files_changed"),
                    risks: strings(args, "risks"),
                    next_steps: strings(args, "next_steps"),
                };
                let created = handoff::create_handoff(db, &principal, input)?;
                let id = created.handoff.id.clone();
                Ok((serde_json::to_value(&created)?, "handoff", id))
            }
            "taskdock_get_handoff" => {
                let id = need(args, "handoff_id")?;
                let item = handoff::get_handoff(db, &principal, &id)?;
                Ok((serde_json::to_value(&item)?, "handoff", id))
            }
            "taskdock_list_handoffs" => {
                let status = arg_str(args, "status");
                let project = arg_str(args, "project_id");
                let limit = int_arg(args, "limit").unwrap_or(50).clamp(1, 200) as u32;
                let (items, page) = handoff::list_handoffs(db, &principal, status, project, limit, 0)?;
                Ok((
                    json!({ "items": items, "page": page }),
                    "handoff",
                    String::new(),
                ))
            }
            "taskdock_submit_work_report" => {
                let input = store::ReportInput {
                    summary: need(args, "summary")?,
                    result: arg_str(args, "result").map(str::to_string),
                    handoff_id: arg_str(args, "handoff_id").map(str::to_string),
                    project_id: arg_str(args, "project_id").map(str::to_string),
                    task_id: arg_str(args, "task_id").map(str::to_string),
                    completed_items: strings(args, "completed_items"),
                    pending_items: strings(args, "pending_items"),
                    files_changed: strings(args, "files_changed"),
                    evidence: args
                        .get("evidence")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                    risks: strings(args, "risks"),
                };
                let out = handoff::create_report(db, &principal, input)?;
                let id = out.report.id.clone();
                Ok((serde_json::to_value(&out)?, "report", id))
            }
            "taskdock_search" => {
                let query = need(args, "query")?;
                let kinds = strings(args, "kinds");
                let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 50) as u32;
                let hits = service::search_all(db, &principal, &query, &kinds, limit)?;
                Ok((serde_json::to_value(hits)?, "search", String::new()))
            }
            "taskdock_agent_registry" => {
                let agents = handoff::list_agents(db, &principal)?;
                Ok((serde_json::to_value(agents)?, "agent", String::new()))
            }
            "taskdock_agent_activity" => {
                let limit = int_arg(args, "limit").unwrap_or(50).clamp(1, 100) as u32;
                let query = store::ActivityQuery {
                    agent_id: arg_str(args, "agent_id").map(str::to_string),
                    interface: arg_str(args, "interface").map(str::to_string),
                    since: arg_str(args, "since").map(str::to_string),
                    limit,
                    offset: 0,
                };
                let (items, page) = service::list_activity_authorized(db, &principal, &query)?;
                Ok((
                    json!({ "items": items, "page": page }),
                    "activity",
                    String::new(),
                ))
            }
            other => Err(AppError::NotFound(format!("未知工具 {other}"))),
        }
    })();
    Some(match result {
        Ok((value, kind, id)) => Ok(outcome(value, kind_static(kind), id, None)),
        Err(err) => Err(ToolError::Failed(err)),
    })
}

/// `outcome` 需要 `&'static str`；把有限集合映射为静态标签。
fn kind_static(kind: &'static str) -> &'static str {
    kind
}

// ── Resources ─────────────────────────────────────────────────────

pub fn resources() -> Vec<Value> {
    vec![
        json!({ "uri": "taskdock://manifest", "name": "Workspace Manifest", "mimeType": "application/json",
                "description": "协议、能力、接口与路径" }),
        json!({ "uri": "taskdock://projects", "name": "Projects", "mimeType": "application/json",
                "description": "项目列表（规划 + 工作空间）" }),
        json!({ "uri": "taskdock://tasks", "name": "Tasks", "mimeType": "application/json",
                "description": "任务快照（最多 200 条）" }),
        json!({ "uri": "taskdock://plans/current", "name": "Current Plan", "mimeType": "application/json",
                "description": "当前规划" }),
        json!({ "uri": "taskdock://knowledge/index", "name": "Knowledge Index", "mimeType": "application/json",
                "description": "知识库与文档索引（不含正文）" }),
        json!({ "uri": "taskdock://decisions", "name": "Decisions", "mimeType": "application/json",
                "description": "决策记录列表" }),
        json!({ "uri": "taskdock://agents/sessions", "name": "Agent Registry", "mimeType": "application/json",
                "description": "已注册 Agent 与最近访问" }),
        json!({ "uri": "taskdock://context/current", "name": "Current Context", "mimeType": "text/markdown",
                "description": "当前项目上下文（Markdown）" }),
        json!({ "uri": "taskdock://projects/{id}", "name": "Project Detail", "mimeType": "application/json",
                "description": "替换 {id} 为项目 ID" }),
        json!({ "uri": "taskdock://projects/{id}/context", "name": "Project Context", "mimeType": "text/markdown",
                "description": "替换 {id} 为项目 ID" }),
    ]
}

pub fn is_resource_uri(uri: &str) -> bool {
    uri.starts_with("taskdock://")
}

/// 资源按需读取：单个 URI 只装配该资源，不加载全部数据。
pub fn read_resource(db: &Db, principal: &Principal, uri: &str) -> AppResult<Value> {
    let text = |mime: &str, body: String| {
        json!({ "contents": [ { "uri": uri, "mimeType": mime, "text": body } ] })
    };
    let json_text = |value: Value| -> AppResult<String> { Ok(serde_json::to_string_pretty(&value)?) };
    match uri {
        "taskdock://manifest" => {
            let value = workspace::manifest(db)?;
            Ok(text("application/json", json_text(value)?))
        }
        "taskdock://projects" => {
            let (items, _) = service::list_projects(db, principal, None, None, 200, 0)?;
            Ok(text("application/json", json_text(serde_json::to_value(items)?)?))
        }
        "taskdock://tasks" => {
            let filter = crate::commands::tasks::TaskFilter {
                status: Some("all".into()),
                limit: Some(200),
                ..Default::default()
            };
            let (items, _) = service::list_tasks(db, principal, filter, 200, 0)?;
            Ok(text("application/json", json_text(serde_json::to_value(items)?)?))
        }
        "taskdock://plans/current" => {
            let plan = service::current_plan(db, principal)?;
            Ok(text("application/json", json_text(serde_json::to_value(plan)?)?))
        }
        "taskdock://knowledge/index" => {
            let value = service::knowledge_index_authorized(db, principal)?;
            Ok(text("application/json", json_text(value)?))
        }
        "taskdock://decisions" => {
            let (items, _) = service::list_decisions_authorized(db, principal, None, None, 200, 0)?;
            Ok(text("application/json", json_text(serde_json::to_value(items)?)?))
        }
        "taskdock://agents/sessions" => {
            let items = handoff::list_agents(db, principal)?;
            Ok(text("application/json", json_text(serde_json::to_value(items)?)?))
        }
        "taskdock://context/current" => {
            let ctx = context::build(db, principal, context::ContextRequest::default())?;
            Ok(text("text/markdown", ctx.markdown))
        }
        other => {
            if let Some(rest) = other.strip_prefix("taskdock://projects/") {
                let (id, with_context) = match rest.strip_suffix("/context") {
                    Some(id) => (id, true),
                    None => (rest, false),
                };
                if id.is_empty() || id.contains('/') {
                    return Err(AppError::NotFound(format!("未知资源 {other}")));
                }
                if with_context {
                    let ctx = context::build(
                        db,
                        principal,
                        context::ContextRequest {
                            project_id: Some(id.to_string()),
                            format: Some("markdown".into()),
                            ..Default::default()
                        },
                    )?;
                    Ok(text("text/markdown", ctx.markdown))
                } else {
                    let detail = service::get_project(db, principal, id)?;
                    Ok(text("application/json", json_text(serde_json::to_value(detail)?)?))
                }
            } else {
                Err(AppError::NotFound(format!("未知资源 {other}")))
            }
        }
    }
}

// ── Prompts ───────────────────────────────────────────────────────

pub fn prompts() -> Vec<Value> {
    vec![
        json!({
            "name": "understand_project",
            "description": "理解项目：读取项目状态、当前计划、决策与近期变更。",
            "arguments": [
                { "name": "project_id", "description": "项目 ID", "required": true }
            ]
        }),
        json!({
            "name": "continue_previous_work",
            "description": "承接上一个 Agent 的工作：读取交接与报告后继续。",
            "arguments": [
                { "name": "handoff_id", "description": "交接 ID", "required": true }
            ]
        }),
        json!({
            "name": "prepare_development_context",
            "description": "准备开发上下文：按任务描述装配相关任务、计划、决策、知识与约束。",
            "arguments": [
                { "name": "task", "description": "任务描述", "required": true },
                { "name": "project_id", "description": "项目 ID（可选）", "required": false }
            ]
        }),
        json!({
            "name": "review_architecture_decision",
            "description": "评审架构决策：读取背景、决策、后果与备选方案。",
            "arguments": [
                { "name": "decision_id", "description": "决策 ID", "required": true }
            ]
        }),
        json!({
            "name": "submit_work_handoff",
            "description": "提交交接：汇总完成项、未完成项、风险与下一步。",
            "arguments": [
                { "name": "to_agent_id", "description": "目标 Agent ID", "required": true },
                { "name": "summary", "description": "摘要", "required": true }
            ]
        }),
    ]
}

pub fn is_prompt(name: &str) -> bool {
    prompts().iter().any(|p| p["name"] == json!(name))
}

/// Prompt 只生成**可复用工作模板**，不偷偷执行写入。
pub fn build_prompt(db: &Db, principal: &Principal, name: &str, args: &Value) -> AppResult<Value> {
    let arg = |key: &str| -> AppResult<String> {
        arg_str(args, key)
            .map(str::to_string)
            .ok_or_else(|| AppError::Validation(format!("prompt {name} 缺少参数 {key}")))
    };
    let messages = match name {
        "understand_project" => {
            let project_id = arg("project_id")?;
            let ctx = context::build(
                db,
                principal,
                context::ContextRequest {
                    project_id: Some(project_id),
                    format: Some("markdown".into()),
                    ..Default::default()
                },
            )?;
            vec![
                json!({ "role": "user", "content": { "type": "text", "text":
                    "你是接手该项目的 Agent。请基于以下上下文，先用 5 条要点复述项目目标、当前进度、约束与风险，再给下一步建议。" } }),
                json!({ "role": "user", "content": { "type": "text", "text": ctx.markdown } }),
            ]
        }
        "continue_previous_work" => {
            let handoff_id = arg("handoff_id")?;
            let handoff = handoff::get_handoff(db, principal, &handoff_id)?;
            let context = context::build(
                db,
                principal,
                context::ContextRequest {
                    project_id: Some(handoff.project_id.clone()).filter(|p| !p.is_empty()),
                    task_id: handoff.task_id.clone(),
                    format: Some("markdown".into()),
                    ..Default::default()
                },
            )?;
            vec![
                json!({ "role": "user", "content": { "type": "text", "text":
                    "你要承接另一个 Agent 的工作。请先核对交接中的完成项与未完成项，指出不一致，再继续执行未完成项。" } }),
                json!({ "role": "user", "content": { "type": "text", "text": serde_json::to_string_pretty(&handoff)? } }),
                json!({ "role": "user", "content": { "type": "text", "text": context.markdown } }),
            ]
        }
        "prepare_development_context" => {
            let task = arg("task")?;
            let ctx = context::build(
                db,
                principal,
                context::ContextRequest {
                    task: Some(task),
                    project_id: arg_str(args, "project_id").map(str::to_string),
                    format: Some("markdown".into()),
                    ..Default::default()
                },
            )?;
            vec![
                json!({ "role": "user", "content": { "type": "text", "text":
                    "基于以下 Task Dock 上下文准备开发：列出不可违反的约束、相关决策、需要读取的知识，并给出最小可交付步骤。" } }),
                json!({ "role": "user", "content": { "type": "text", "text": ctx.markdown } }),
            ]
        }
        "review_architecture_decision" => {
            let decision_id = arg("decision_id")?;
            let decision = service::get_decision_authorized(db, principal, &decision_id)?;
            vec![
                json!({ "role": "user", "content": { "type": "text", "text":
                    "评审以下架构决策：它对当前实现有哪些约束？是否存在未记录的后果或更优备选？如需推翻必须新建决策而不是改写历史。" } }),
                json!({ "role": "user", "content": { "type": "text", "text": serde_json::to_string_pretty(&decision)? } }),
            ]
        }
        "submit_work_handoff" => {
            let to = arg("to_agent_id")?;
            let summary = arg("summary")?;
            vec![
                json!({ "role": "user", "content": { "type": "text", "text":
                    format!("请为交接给 {to} 准备结构化内容（completed_items / pending_items / files_changed / risks / next_steps），摘要：{summary}。确认后调用 taskdock_create_handoff 写入，而不是只输出文本。") } }),
            ]
        }
        other => return Err(AppError::NotFound(format!("未知 prompt {other}"))),
    };
    Ok(json!({ "description": name, "messages": messages }))
}

/// 工具 schema 的公共片段（供文档一致性与测试使用）。
pub fn schema_fingerprint() -> String {
    let defs = defs();
    defs.iter()
        .map(|d| d.name)
        .collect::<Vec<_>>()
        .join(",")
}

/// 预先检查：所有登记的工具都在 NAMES 中（防注册与分发漂移）。
pub fn check_registry() -> AppResult<()> {
    for def in defs() {
        if !is_owned(def.name) {
            return Err(AppError::Validation(format!(
                "工具 {} 未在分发表中登记",
                def.name
            )));
        }
    }
    Ok(())
}

/// 供 `mcp::tools::run_tool_call` 识别（避免与既有同名工具冲突）。
pub fn definitions_for_registry() -> Vec<ToolDef> {
    defs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_consistent() {
        check_registry().unwrap();
        assert_eq!(defs().len(), NAMES.len());
        for name in NAMES {
            assert!(name.starts_with("taskdock_"));
        }
    }
}


