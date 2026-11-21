//! MCP 工具集语义实现。
//!
//! 结构（2026-11 扩展后）：
//! - 本文件保留原始 18 个规划工具的**唯一实现**与调度、审计、幂等封装；
//! - 任务 / 笔记 / 工作流 / 文件工作区的工具分别在 `task_tools.rs`、
//!   `note_tools.rs`、`workflow_tools.rs`、`workspace_tools.rs`，通过
//!   [`tool_defs`] 注册、通过 [`call`] 分发，**不复制**授权与审计逻辑；
//! - 所有写工具仍走同一事务：业务写入 + 审计 + planning-changed 广播同事务提交。
//!
//! 分层约束：
//! - 所有实体读写都走 `commands/planning.rs` 的 `*_impl`（同一校验、同一事务、
//!   同一 activity 留痕），绝不直接拼 SQL 写 planning 表；
//! - 写工具**强制** `expected_revision`（乐观并发，防止多客户端后写无声覆盖），
//!   冲突返回明确错误（携带当前 revision）；
//! - 授权：readonly 是显式的全项目只读模式；project_rw 的读取和写入都限于 grant
//!   项目（create_project 例外：创建后自动授予该项目，便于同一 Agent 继续推进）；
//! - `taskdock_update_feature` 拒绝 status='completed'（验收完成由用户判定）；
//!   `taskdock_submit_for_review` 只能置 'review'；
//! - 有意偏离说明：`taskdock_add_progress_note` 与 link/unlink 只追加 activity
//!   与关联表，不修改项目/功能内容，不存在丢失更新风险，因此不要求也不消耗
//!   expected_revision（其余全部写工具强制）。

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::commands::planning::{
    list_features_impl, list_milestones_impl, list_projects_impl, load_feature_tx, load_project_tx,
    FeatureInput, FeaturePatch, ProjectInput, ProjectPatch, StepPatch,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::audit::{self, AuditEntry};
use crate::mcp::auth::{self, McpAgentRow};
use crate::mcp::{PlanningChanged, PLANNING_CHANGED_EVENT};
use crate::agent_access::{operations, Principal, Source};

/// 工具定义（tools/list 暴露；`write` 决定审计/幂等策略与授权层级）。
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub write: bool,
}

pub struct ToolCtx {
    pub db: std::sync::Arc<Db>,
    pub agent: McpAgentRow,
    pub emit: crate::mcp::ChangeEmitter,
}

/// 授权失败（→ JSON-RPC -32002，审计 authz=0）；其余业务失败（→ isError result）。
#[derive(Debug)]
pub enum ToolError {
    Authz(String),
    Failed(AppError),
}

impl From<AppError> for ToolError {
    fn from(e: AppError) -> Self {
        ToolError::Failed(e)
    }
}

pub(crate) fn schema(props: Value, required: &[&str]) -> Value {
    let mut s = json!({ "type": "object", "properties": props, "additionalProperties": false });
    if !required.is_empty() {
        s["required"] = json!(required);
    }
    s
}

fn request_id_prop() -> Value {
    json!({ "type": "string", "maxLength": 128, "description":
        "可选幂等键：客户端重试同一写操作时传相同值，将返回原结果而不重复执行" })
}

fn expected_revision_prop() -> Value {
    json!({ "type": "integer", "description":
        "必须：乐观并发版本。传入读取结果中的 revision；不匹配返回冲突与当前 revision" })
}

const DATE_DESC: &str = "目标日期 YYYY-MM-DD；null 表示清除";

pub fn tool_defs() -> &'static [ToolDef] {
    static DEFS: std::sync::OnceLock<Vec<ToolDef>> = std::sync::OnceLock::new();
    DEFS.get_or_init(|| {
        let mut defs = vec![
        ToolDef {
            name: "taskdock_list_projects",
            description: "列出 Task Dock 规划中心的用户项目（含统计与 revision）。不含 Task Dock 内置路线图。",
            input_schema: schema(
                json!({
                    "include_archived": { "type": "boolean", "description": "是否包含已归档项目，默认包含" },
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_project",
            description: "读取单个项目详情（含统计与 revision）。",
            input_schema: schema(
                json!({ "project_id": { "type": "string" } }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_features",
            description: "列出项目下全部功能（含步骤与 revision）。",
            input_schema: schema(
                json!({ "project_id": { "type": "string" } }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_feature",
            description: "读取单个功能详情（含步骤、验收标准与 Agent 会话关联）。",
            input_schema: schema(
                json!({ "feature_id": { "type": "string" } }),
                &["feature_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_steps",
            description: "列出功能下的开发步骤。",
            input_schema: schema(
                json!({ "feature_id": { "type": "string" } }),
                &["feature_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_milestones",
            description: "列出项目下的里程碑（里程碑只能由用户在 Task Dock 内管理）。",
            input_schema: schema(
                json!({ "project_id": { "type": "string" } }),
                &["project_id"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_progress",
            description: "读取进度：传 project_id 返回项目统计（按功能状态）；传 feature_id 返回功能步骤完成计数。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "feature_id": { "type": "string" },
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_get_agent_links",
            description: "查询功能与 Agent 会话的关联记录（可按项目/功能/来源/会话过滤）。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "feature_id": { "type": "string" },
                    "agent_source": { "type": "string" },
                    "session_id": { "type": "string" },
                }),
                &[],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_create_project",
            description: "创建项目（需要 projects.create 能力 + scope=project_rw）。返回 canonical projectId 与 activePlanId；只自动授予本 Agent 刚创建的项目，不扩大为全局权限。",
            input_schema: schema(
                json!({
                    "name": { "type": "string", "maxLength": 120 },
                    "kind": { "type": "string", "description": "项目类型：general/novel/game/ai_comic/development（默认 general）" },
                    "description": { "type": "string", "maxLength": 4000 },
                    "goal": { "type": "string", "maxLength": 2000 },
                    "template_id": { "type": "string", "description": "模板 ID（只登记，不展开）" },
                    "root_path": { "type": "string", "description": "已有工作目录（绝对路径）；不存在时登记为离线，不会创建目录" },
                    "target_date": { "type": "string", "description": DATE_DESC },
                    "requestId": request_id_prop(),
                }),
                &["name"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_update_project",
            description: "更新项目（名称/描述/状态/目标日期）。需要项目授权与 expected_revision。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "expected_revision": expected_revision_prop(),
                    "name": { "type": "string", "maxLength": 100 },
                    "description": { "type": "string", "maxLength": 2000 },
                    "status": { "type": "string", "enum": ["planning", "in_progress", "paused", "completed"] },
                    "target_date": { "type": ["string", "null"], "description": DATE_DESC },
                    "requestId": request_id_prop(),
                }),
                &["project_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_create_feature",
            description: "在项目中创建功能（含验收标准）。需要项目授权。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 2000 },
                    "acceptance_criteria": { "type": "string", "maxLength": 4000 },
                    "priority": { "type": "string", "enum": ["P0", "P1", "P2"] },
                    "milestone_id": { "type": "string" },
                    "target_date": { "type": "string", "description": DATE_DESC },
                    "requestId": request_id_prop(),
                }),
                &["project_id", "title"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_update_feature",
            description: "更新功能（标题/描述/验收标准/状态/优先级/里程碑/目标日期）。需要项目授权与 expected_revision。不允许置 status='completed'（验收完成由用户判定）。",
            input_schema: schema(
                json!({
                    "feature_id": { "type": "string" },
                    "expected_revision": expected_revision_prop(),
                    "title": { "type": "string", "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 2000 },
                    "acceptance_criteria": { "type": "string", "maxLength": 4000 },
                    "status": { "type": "string", "enum": ["planned", "in_progress", "review", "blocked", "paused"],
                                "description": "completed 由用户专属，Agent 不可设置" },
                    "priority": { "type": "string", "enum": ["P0", "P1", "P2"] },
                    "milestone_id": { "type": ["string", "null"] },
                    "target_date": { "type": ["string", "null"], "description": DATE_DESC },
                    "requestId": request_id_prop(),
                }),
                &["feature_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_add_step",
            description: "为功能追加开发步骤。需要项目授权与功能 expected_revision。",
            input_schema: schema(
                json!({
                    "feature_id": { "type": "string" },
                    "title": { "type": "string", "maxLength": 200 },
                    "expected_revision": expected_revision_prop(),
                    "requestId": request_id_prop(),
                }),
                &["feature_id", "title", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_update_step",
            description: "更新开发步骤（改标题/勾选完成/重开）。需要项目授权与功能 expected_revision。",
            input_schema: schema(
                json!({
                    "step_id": { "type": "string" },
                    "expected_revision": expected_revision_prop(),
                    "title": { "type": "string", "maxLength": 200 },
                    "done": { "type": "boolean" },
                    "requestId": request_id_prop(),
                }),
                &["step_id", "expected_revision"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_add_progress_note",
            description: "向项目/功能追加一条开发日志（activity note）。追加型操作，不要求 expected_revision。",
            input_schema: schema(
                json!({
                    "project_id": { "type": "string" },
                    "message": { "type": "string", "maxLength": 2000 },
                    "feature_id": { "type": "string" },
                    "requestId": request_id_prop(),
                }),
                &["project_id", "message"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_link_agent_session",
            description: "把本 Agent 的会话与功能关联（记录 agent_source + session_id），用于规划面板展示协作关系。",
            input_schema: schema(
                json!({
                    "feature_id": { "type": "string" },
                    "agent_source": { "type": "string", "maxLength": 64, "description": "来源标识，如 claude-code / codex" },
                    "session_id": { "type": "string", "maxLength": 256 },
                }),
                &["feature_id", "agent_source", "session_id"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_unlink_agent_session",
            description: "解除功能与 Agent 会话的关联（标记 unlinked，保留历史）。",
            input_schema: schema(
                json!({
                    "feature_id": { "type": "string" },
                    "agent_source": { "type": "string", "maxLength": 64 },
                    "session_id": { "type": "string", "maxLength": 256 },
                }),
                &["feature_id", "agent_source", "session_id"],
            ),
            write: true,
        },
        ToolDef {
            name: "taskdock_submit_for_review",
            description: "把功能提交验收：只能将 status 置为 'review'（从 completed 提交会被拒绝）。需要项目授权与 expected_revision。",
            input_schema: schema(
                json!({
                    "feature_id": { "type": "string" },
                    "expected_revision": expected_revision_prop(),
                    "note": { "type": "string", "maxLength": 2000, "description": "可选：随提交附带的说明，写入进度历史" },
                    "requestId": request_id_prop(),
                }),
                &["feature_id", "expected_revision"],
            ),
            write: true,
        },
        ];
        defs.extend(crate::mcp::task_tools::defs());
        defs.extend(crate::mcp::note_tools::defs());
        defs.extend(crate::mcp::workflow_tools::defs());
        defs.extend(crate::mcp::workspace_tools::defs());
        defs.extend(crate::mcp::knowledge_tools::defs());
        defs.extend(crate::mcp::capability_tools::defs());
        // Agent 共享工作空间（v76）：项目状态/计划/知识写/决策/上下文/交接/报告/检索。
        defs.extend(crate::agent_access::mcp_tools::definitions_for_registry());
        // 协作中心（v77）：项目上下文/需求/Bug/方案/可视化/原型。
        defs.extend(crate::collab::mcp_tools::definitions_for_registry());
        defs
    })
    .as_slice()
}

// ── 参数读取辅助 ─────────────────────────────────────────────────────

pub(crate) fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

pub(crate) fn require_str(args: &Value, key: &str) -> Result<String, ToolError> {
    let v = arg_str(args, key)
        .ok_or_else(|| ToolError::Failed(AppError::Validation(format!("缺少参数 {key}"))))?;
    let v = v.trim();
    if v.is_empty() {
        return Err(ToolError::Failed(AppError::Validation(format!(
            "参数 {key} 不能为空"
        ))));
    }
    Ok(v.to_string())
}

pub(crate) fn require_revision(args: &Value) -> Result<i64, ToolError> {
    args.get("expected_revision")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            ToolError::Failed(AppError::Validation(
                "写操作必须提供 expected_revision（当前实体 revision，见读取结果；防止并发覆盖）"
                    .into(),
            ))
        })
}

/// 写工具幂等键：客户端显式传 requestId；缺失/非法按空处理（不做幂等）。
/// 工具调用一开始就能确定的资源目标 `(kind, id, project_id)`。
///
/// 必须在**调用前**绑定：失败/冲突的操作不会走到「用返回值绑定真实 ID」那一步，
/// 若此时资源为空，UI 就无法把冲突显示到对应行上。创建类工具没有 ID，留空等提交后绑定。
fn operation_target(tool: &str, args: &Value) -> (String, String, String) {
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| args.get(*key).and_then(|v| v.as_str()).map(str::trim))
            .filter(|v| !v.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let kind = crate::agent_access::operations::resource_kind_for_tool(tool).to_string();
    let id = match kind.as_str() {
        "task" => pick(&["task_id"]),
        "feature" => pick(&["feature_id"]),
        "step" => pick(&["step_id"]),
        "milestone" => pick(&["milestone_id"]),
        "project" => pick(&["project_id"]),
        "note" => pick(&["note_id"]),
        "knowledge" => pick(&["document_id", "doc_id"]),
        _ => String::new(),
    };
    let project = pick(&["project_id"]);
    (kind, id, project)
}

fn request_id_of(args: &Value) -> String {
    args.get("requestId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 128)
        .unwrap_or("")
        .to_string()
}

fn reject_bad_enum(args: &Value, key: &str, allowed: &[&str], what: &str) -> Result<(), ToolError> {
    if let Some(v) = arg_str(args, key) {
        if !allowed.contains(&v) {
            return Err(ToolError::Failed(AppError::Validation(format!(
                "非法{what}: {v}"
            ))));
        }
    }
    Ok(())
}

// ── 授权辅助 ─────────────────────────────────────────────────────────

fn ensure_can_read(agent: &McpAgentRow) -> Result<(), ToolError> {
    if agent.scope.can_read() {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "scope={} 不允许调用读工具（需要 readonly 或 project_rw）",
            agent.scope.as_str()
        )))
    }
}

/// project_rw 的读取也限制在显式项目授权内；readonly 是用户显式选择的全项目只读模式。
fn ensure_can_read_project(ctx: &ToolCtx, project_id: &str) -> Result<(), ToolError> {
    ensure_can_read(&ctx.agent)?;
    if ctx.agent.scope == auth::McpScope::ReadOnly {
        return Ok(());
    }
    let granted = ctx
        .db
        .with_conn(|conn| auth::has_project_grant(conn, &ctx.agent.row_id, project_id))
        .map_err(ToolError::Failed)?;
    if granted {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权项目: {project_id}（读取需要该项目的 grant）"
        )))
    }
}

fn granted_project_ids(ctx: &ToolCtx) -> AppResult<std::collections::HashSet<String>> {
    ctx.db.with_read(|conn| {
        let mut stmt =
            conn.prepare("SELECT project_id FROM mcp_agent_grants WHERE agent_row_id = ?1")?;
        let rows = stmt.query_map(rusqlite::params![ctx.agent.row_id], |r| r.get(0))?;
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            ids.insert(row?);
        }
        Ok(ids)
    })
}

/// 写授权：scope=project_rw 且持有该项目 grant；不满足返回 Authz。
fn ensure_grant(
    ctx: &ToolCtx,
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许写操作（需要 project_rw）",
            ctx.agent.scope.as_str()
        )));
    }
    // 计划 ID 先反解析到项目根：授权挂在项目根上，计划级授权不能跨项目生效。
    let root = crate::project_hub::service::resolve_project_root(conn, project_id)
        .map_err(ToolError::Failed)?;
    let mut granted =
        auth::has_project_grant(conn, &ctx.agent.row_id, project_id).map_err(ToolError::Failed)?;
    if !granted {
        if let Some(root) = root.as_deref() {
            granted = auth::has_project_grant(conn, &ctx.agent.row_id, root)
                .map_err(ToolError::Failed)?;
        }
    }
    if granted {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权项目: {project_id}（写操作需要该项目的 grant）"
        )))
    }
}

/// 同一 write 事务中用于重放的权限校验，不执行任何业务副作用。
fn authorize_replay(
    ctx: &ToolCtx,
    conn: &rusqlite::Connection,
    name: &str,
    args: &Value,
    replay: &audit::Replay,
) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许重放写操作（需要 project_rw）",
            ctx.agent.scope.as_str()
        )));
    }
    // 资源扩展写工具：重放时按当前能力重新校验，不信任旧审计结论。
    if crate::mcp::task_tools::authorize_replay(ctx, conn, name, args)? {
        return Ok(());
    }
    if crate::mcp::note_tools::authorize_replay(ctx, conn, name, args)? {
        return Ok(());
    }
    let project_id = match name {
        "taskdock_create_project" => {
            if replay.entity_type != "project" || replay.entity_id.is_empty() {
                return Err(ToolError::Failed(AppError::Validation(
                    "幂等审计对象无效，拒绝重放".into(),
                )));
            }
            replay.entity_id.clone()
        }
        "taskdock_update_project" | "taskdock_create_feature" | "taskdock_add_progress_note" => {
            require_str(args, "project_id")?.to_string()
        }
        "taskdock_update_feature"
        | "taskdock_add_step"
        | "taskdock_link_agent_session"
        | "taskdock_unlink_agent_session"
        | "taskdock_submit_for_review" => {
            let feature_id = require_str(args, "feature_id")?;
            conn.query_row(
                "SELECT project_id FROM planning_features WHERE id = ?1",
                rusqlite::params![feature_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::Validation(format!("功能不存在: {feature_id}")))?
        }
        "taskdock_update_step" => {
            let step_id = require_str(args, "step_id")?;
            project_of_step(conn, &step_id)?.1
        }
        other => {
            return Err(ToolError::Failed(AppError::Validation(format!(
                "未知写工具: {other}"
            ))));
        }
    };
    ensure_grant(ctx, conn, &project_id)
}

fn request_fingerprint(args: &Value) -> String {
    let mut business_args = args.clone();
    if let Some(object) = business_args.as_object_mut() {
        object.remove("requestId");
    }
    use sha2::Digest;
    let digest =
        sha2::Sha256::digest(serde_json::to_vec(&business_args).expect("JSON values serialize"));
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn fingerprint_from_audit_detail(detail: &str) -> Option<&str> {
    detail
        .split_whitespace()
        .find_map(|part| part.strip_prefix("request_sha256="))
}

fn refreshed_context(ctx: &ToolCtx) -> Result<ToolCtx, crate::mcp::bridge::ToolRpcError> {
    let current = ctx
        .db
        .with_conn(|conn| auth::find_active_agent_by_row_id(conn, &ctx.agent.row_id))
        .map_err(|error| crate::mcp::bridge::ToolRpcError {
            code: crate::mcp::protocol::INTERNAL_ERROR,
            message: format!("MCP 身份状态读取失败: {}", error.user_message()),
            data: Value::Null,
        })?;
    let Some(agent) = current else {
        return Err(crate::mcp::bridge::ToolRpcError {
            code: crate::mcp::protocol::ERR_UNAUTHORIZED,
            message: "Agent 凭据已撤销或不存在".into(),
            data: Value::Null,
        });
    };
    Ok(ToolCtx {
        db: ctx.db.clone(),
        agent,
        emit: ctx.emit.clone(),
    })
}

/// 功能 → 所属项目（授权判定用）。
fn project_of_feature(conn: &rusqlite::Connection, feature_id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT project_id FROM planning_features WHERE id = ?1",
        rusqlite::params![feature_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::Validation(format!("功能不存在: {feature_id}")))
}

fn project_of_step(conn: &rusqlite::Connection, step_id: &str) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT s.feature_id, f.project_id FROM planning_feature_steps s
         JOIN planning_features f ON f.id = s.feature_id WHERE s.id = ?1",
        rusqlite::params![step_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::Validation(format!("步骤不存在: {step_id}")))
}

// ── 工具实现 ─────────────────────────────────────────────────────────

pub(crate) struct CallOutcome {
    pub(crate) value: Value,
    pub(crate) changed: Option<PlanningChanged>,
    pub(crate) entity_type: &'static str,
    pub(crate) entity_id: String,
}

pub(crate) fn outcome(
    value: Value,
    entity_type: &'static str,
    entity_id: String,
    changed: Option<PlanningChanged>,
) -> CallOutcome {
    CallOutcome {
        value,
        changed,
        entity_type,
        entity_id,
    }
}

fn agent_links_of(conn: &rusqlite::Connection, feature_id: &str) -> AppResult<Value> {
    let mut stmt = conn.prepare(
        "SELECT id, agent_source, session_id, status, last_event_at, created_at
         FROM feature_agent_links WHERE feature_id = ?1 ORDER BY created_at",
    )?;
    let rows = stmt.query_map(rusqlite::params![feature_id], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "agent_source": r.get::<_, String>(1)?,
            "session_id": r.get::<_, String>(2)?,
            "status": r.get::<_, String>(3)?,
            "last_event_at": r.get::<_, String>(4)?,
            "created_at": r.get::<_, String>(5)?,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(AppError::from)?);
    }
    Ok(Value::Array(out))
}

fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    write_conn: Option<&rusqlite::Connection>,
) -> Result<CallOutcome, ToolError> {
    let db = ctx.db.as_ref();
    let agent = &ctx.agent;
    // Agent 共享工作空间工具走统一 service 层（授权、版本、审计都在那一层）。
    if crate::agent_access::mcp_tools::is_owned(name) {
        return crate::agent_access::mcp_tools::call(ctx, name, args, write_conn).unwrap_or_else(
            || Err(ToolError::Failed(AppError::NotFound(format!("未知工具 {name}")))),
        );
    }
    if crate::collab::mcp_tools::is_owned(name) {
        return crate::collab::mcp_tools::call(ctx, name, args, write_conn).unwrap_or_else(
            || Err(ToolError::Failed(AppError::NotFound(format!("未知工具 {name}")))),
        );
    }
    match name {
        // ── 读工具（scope ∈ {readonly, project_rw}）────────────────
        "taskdock_list_projects" => {
            ensure_can_read(agent)?;
            let mut projects =
                list_projects_impl(db, args.get("include_archived").and_then(|v| v.as_bool()))?;
            if agent.scope == auth::McpScope::ProjectRw {
                let granted = granted_project_ids(ctx)?;
                projects.retain(|project| granted.contains(&project.id));
            }
            let value = serde_json::to_value(projects).map_err(AppError::from)?;
            Ok(outcome(value, "project", String::new(), None))
        }
        "taskdock_get_project" => {
            let id = require_str(args, "project_id")?;
            ensure_can_read_project(ctx, &id)?;
            let p = db.with_read(|conn| load_project_tx(conn, &id))?;
            let value = serde_json::to_value(p).map_err(AppError::from)?;
            Ok(outcome(value, "project", id, None))
        }
        "taskdock_list_features" => {
            let id = require_str(args, "project_id")?;
            ensure_can_read_project(ctx, &id)?;
            let features = list_features_impl(db, id)?;
            let value = serde_json::to_value(features).map_err(AppError::from)?;
            Ok(outcome(value, "feature", String::new(), None))
        }
        "taskdock_get_feature" => {
            ensure_can_read(agent)?;
            let id = require_str(args, "feature_id")?;
            let project_id = db.with_read(|conn| project_of_feature(conn, &id))?;
            ensure_can_read_project(ctx, &project_id)?;
            let value = db.with_read(|conn| {
                let f = load_feature_tx(conn, &id)?;
                let mut v = serde_json::to_value(&f).map_err(AppError::from)?;
                v["agent_links"] = agent_links_of(conn, &id)?;
                Ok::<_, AppError>(v)
            })?;
            Ok(outcome(value, "feature", id, None))
        }
        "taskdock_list_steps" => {
            let id = require_str(args, "feature_id")?;
            let project_id = db.with_read(|conn| project_of_feature(conn, &id))?;
            ensure_can_read_project(ctx, &project_id)?;
            let f = db.with_read(|conn| load_feature_tx(conn, &id))?;
            let value = serde_json::to_value(f.steps).map_err(AppError::from)?;
            Ok(outcome(value, "step", id, None))
        }
        "taskdock_list_milestones" => {
            let id = require_str(args, "project_id")?;
            ensure_can_read_project(ctx, &id)?;
            let ms = list_milestones_impl(db, id)?;
            let value = serde_json::to_value(ms).map_err(AppError::from)?;
            Ok(outcome(value, "milestone", String::new(), None))
        }
        "taskdock_get_progress" => {
            ensure_can_read(agent)?;
            let project_id = arg_str(args, "project_id").map(str::to_string);
            let feature_id = arg_str(args, "feature_id").map(str::to_string);
            if project_id.is_none() && feature_id.is_none() {
                return Err(ToolError::Failed(AppError::Validation(
                    "需要 project_id 或 feature_id 之一".into(),
                )));
            }
            if let Some(project_id) = &project_id {
                ensure_can_read_project(ctx, project_id)?;
            }
            if let Some(feature_id) = &feature_id {
                let feature_project = db.with_read(|conn| project_of_feature(conn, feature_id))?;
                ensure_can_read_project(ctx, &feature_project)?;
            }
            let value = db.with_read(|conn| {
                if let Some(fid) = &feature_id {
                    let f = load_feature_tx(conn, fid)?;
                    Ok(json!({
                        "scope": "feature",
                        "feature_id": f.id,
                        "project_id": f.project_id,
                        "status": f.status,
                        "step_total": f.step_total,
                        "step_done": f.step_done,
                        "revision": f.revision,
                    }))
                } else {
                    let pid = project_id.as_deref().unwrap_or_default();
                    let p = load_project_tx(conn, pid)?;
                    Ok(json!({
                        "scope": "project",
                        "project_id": p.id,
                        "stats": p.stats,
                        "revision": p.revision,
                    }))
                }
            })?;
            Ok(outcome(value, "project", String::new(), None))
        }
        "taskdock_get_agent_links" => {
            ensure_can_read(agent)?;
            // 过滤值提升为 owned String，满足 rusqlite 参数生命周期
            let project_id = arg_str(args, "project_id").map(str::to_string);
            let feature_id = arg_str(args, "feature_id").map(str::to_string);
            let agent_source = arg_str(args, "agent_source").map(str::to_string);
            let session_id = arg_str(args, "session_id").map(str::to_string);
            if let Some(project_id) = &project_id {
                ensure_can_read_project(ctx, project_id)?;
            }
            if let Some(feature_id) = &feature_id {
                let feature_project = db.with_read(|conn| project_of_feature(conn, feature_id))?;
                ensure_can_read_project(ctx, &feature_project)?;
            }
            let value = db.with_read(|conn| {
                let mut sql = String::from(
                    "SELECT l.id, l.feature_id, f.project_id, l.agent_source, l.session_id, l.status, l.last_event_at, l.created_at
                     FROM feature_agent_links l JOIN planning_features f ON f.id = l.feature_id WHERE 1=1",
                );
                let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
                if let Some(p) = &project_id {
                    sql.push_str(" AND f.project_id = ?");
                    params.push(p);
                }
                if let Some(f) = &feature_id {
                    sql.push_str(" AND l.feature_id = ?");
                    params.push(f);
                }
                if let Some(a) = &agent_source {
                    sql.push_str(" AND l.agent_source = ?");
                    params.push(a);
                }
                if let Some(s) = &session_id {
                    sql.push_str(" AND l.session_id = ?");
                    params.push(s);
                }
                if agent.scope == auth::McpScope::ProjectRw {
                    sql.push_str(
                        " AND EXISTS (SELECT 1 FROM mcp_agent_grants g
                                     WHERE g.agent_row_id = ? AND g.project_id = f.project_id)",
                    );
                    params.push(&agent.row_id);
                }
                sql.push_str(" ORDER BY l.created_at");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params.as_slice(), |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "feature_id": r.get::<_, String>(1)?,
                        "project_id": r.get::<_, String>(2)?,
                        "agent_source": r.get::<_, String>(3)?,
                        "session_id": r.get::<_, String>(4)?,
                        "status": r.get::<_, String>(5)?,
                        "last_event_at": r.get::<_, String>(6)?,
                        "created_at": r.get::<_, String>(7)?,
                    }))
                })?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r.map_err(AppError::from)?);
                }
                Ok::<_, AppError>(Value::Array(out))
            })?;
            Ok(outcome(value, "feature", String::new(), None))
        }

        // ── 写工具（scope=project_rw + 项目 grant）─────────────────
        "taskdock_create_project" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            if !agent.scope.can_write() {
                return Err(ToolError::Authz(format!(
                    "scope={} 不允许创建项目（需要 project_rw）",
                    agent.scope.as_str()
                )));
            }
            // 创建是独立能力：project_rw 只代表「可写」，不代表「可新建项目」。
            let can_create = crate::mcp::permissions::has_global(
                conn,
                &agent.row_id,
                crate::mcp::permissions::Capability::ProjectsCreate,
            )?;
            if !can_create {
                return Err(ToolError::Authz(
                    "权限不足：需要 projects.create。请在 Task Dock「能力中心 → Agent 接入」中显式授予"
                        .into(),
                ));
            }
            // 统一创建服务：项目根 + 初始计划同事务；返回 canonical projectId。
            // Agent 只能「关联已有目录」，不能创建新目录（目录创建必须由人类在 UI 确认）。
            let root_path = arg_str(args, "root_path").map(str::to_string);
            let mode = crate::project_hub::creation::DirectoryMode::default_for(
                root_path.as_deref().unwrap_or_default(),
            );
            let request = crate::project_hub::creation::CreateProjectRequest {
                client_request_id: arg_str(args, "requestId").unwrap_or_default().to_string(),
                name: require_str(args, "name")?.to_string(),
                kind: arg_str(args, "kind").unwrap_or("general").to_string(),
                description: arg_str(args, "description").unwrap_or_default().to_string(),
                goal: arg_str(args, "goal").unwrap_or_default().to_string(),
                target_date: arg_str(args, "target_date").map(str::to_string),
                template_id: arg_str(args, "template_id").map(str::to_string),
                root_path,
                directory_mode: mode,
                dev_project_id: None,
                note: None,
                plan_name: None,
                plan_description: None,
                plan_status: None,
                draft: Default::default(),
                agent_access_policy:
                    crate::project_hub::creation::AgentAccessPolicy::CreatorProjectAndPlan,
            };
            let created = crate::project_hub::creation::create_with_conn(conn, request)?;
            // 自动授权只作用于刚创建的项目根（+ 该计划 ID 兼容），绝不扩大为全局权限。
            crate::agent_access::permissions::grant_created_project_in_conn(
                conn,
                &agent.row_id,
                &created.project.id,
            )?;
            let revision = created.active_plan.revision;
            let value = serde_json::json!({
                // 旧字段 `id` 保留，但语义已修正为项目根 ID（不再是计划 ID）。
                "id": created.project.id,
                "projectId": created.project.id,
                "planId": created.active_plan.id,
                "activePlanId": created.active_plan.id,
                "project": created.project,
                "activePlan": created.active_plan,
                "workspace": created.workspace,
                "provisioningStatus": created.provisioning_status,
                "created": created.created,
            });
            Ok(outcome(
                value,
                "project",
                created.project.id.clone(),
                Some(PlanningChanged {
                    kind: "project",
                    project_id: Some(created.project.id),
                    feature_id: None,
                    revision: Some(revision),
                }),
            ))
        }
        "taskdock_update_project" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let id = require_str(args, "project_id")?;
            let expected = require_revision(args)?;
            ensure_grant(ctx, conn, &id)?;
            let patch = ProjectPatch {
                name: arg_str(args, "name").map(str::to_string),
                description: arg_str(args, "description").map(str::to_string),
                status: arg_str(args, "status").map(str::to_string),
                target_date: args
                    .get("target_date")
                    .map(|v| v.as_str().map(str::to_string)),
                sort_order: None,
                expected_revision: Some(expected),
            };
            let p = crate::commands::planning::update_project_tx(conn, id.clone(), patch)?;
            let revision = p.revision;
            let value = serde_json::to_value(&p).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "project",
                id.clone(),
                Some(PlanningChanged {
                    kind: "project",
                    project_id: Some(id),
                    feature_id: None,
                    revision: Some(revision),
                }),
            ))
        }
        "taskdock_create_feature" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let project_id = require_str(args, "project_id")?;
            ensure_grant(ctx, conn, &project_id)?;
            reject_bad_enum(
                args,
                "status",
                &["planned", "in_progress", "review", "blocked", "paused"],
                "功能状态",
            )?;
            reject_bad_enum(args, "priority", &["P0", "P1", "P2"], "功能优先级")?;
            let input = FeatureInput {
                title: require_str(args, "title")?,
                description: arg_str(args, "description").unwrap_or_default().to_string(),
                acceptance_criteria: arg_str(args, "acceptance_criteria")
                    .unwrap_or_default()
                    .to_string(),
                status: arg_str(args, "status").map(str::to_string),
                priority: arg_str(args, "priority").map(str::to_string),
                milestone_id: arg_str(args, "milestone_id").map(str::to_string),
                target_date: arg_str(args, "target_date").map(str::to_string),
            };
            let f = crate::commands::planning::create_feature_tx(conn, project_id.clone(), input)?;
            let (id, revision) = (f.id.clone(), f.revision);
            let value = serde_json::to_value(&f).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "feature",
                id.clone(),
                Some(PlanningChanged {
                    kind: "feature",
                    project_id: Some(project_id),
                    feature_id: Some(id),
                    revision: Some(revision),
                }),
            ))
        }
        "taskdock_update_feature" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let id = require_str(args, "feature_id")?;
            let expected = require_revision(args)?;
            if arg_str(args, "status") == Some("completed") {
                return Err(ToolError::Failed(AppError::Validation(
                    "Agent 无权将功能标记为 completed（验收完成由用户在 Task Dock 中判定）；可提交 review"
                        .into(),
                )));
            }
            let project_id = project_of_feature(conn, &id)?;
            ensure_grant(ctx, conn, &project_id)?;
            let patch = FeaturePatch {
                title: arg_str(args, "title").map(str::to_string),
                description: arg_str(args, "description").map(str::to_string),
                acceptance_criteria: arg_str(args, "acceptance_criteria").map(str::to_string),
                status: arg_str(args, "status").map(str::to_string),
                priority: arg_str(args, "priority").map(str::to_string),
                milestone_id: args
                    .get("milestone_id")
                    .map(|v| v.as_str().map(str::to_string)),
                target_date: args
                    .get("target_date")
                    .map(|v| v.as_str().map(str::to_string)),
                sort_order: None,
                expected_revision: Some(expected),
            };
            let f = crate::commands::planning::update_feature_tx(conn, id.clone(), patch)?;
            let (revision, feature_id) = (f.revision, f.id.clone());
            let value = serde_json::to_value(&f).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "feature",
                feature_id.clone(),
                Some(PlanningChanged {
                    kind: "feature",
                    project_id: Some(project_id),
                    feature_id: Some(feature_id),
                    revision: Some(revision),
                }),
            ))
        }
        "taskdock_add_step" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let feature_id = require_str(args, "feature_id")?;
            let expected = require_revision(args)?;
            let project_id = project_of_feature(conn, &feature_id)?;
            ensure_grant(ctx, conn, &project_id)?;
            let f = crate::commands::planning::add_step_tx(
                conn,
                feature_id,
                require_str(args, "title")?,
                Some(expected),
            )?;
            let (fid, revision) = (f.id.clone(), f.revision);
            let value = serde_json::to_value(&f).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "step",
                fid.clone(),
                Some(PlanningChanged {
                    kind: "step",
                    project_id: Some(project_id),
                    feature_id: Some(fid),
                    revision: Some(revision),
                }),
            ))
        }
        "taskdock_update_step" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let step_id = require_str(args, "step_id")?;
            let expected = require_revision(args)?;
            let (_feature_id, project_id) = project_of_step(conn, &step_id)?;
            ensure_grant(ctx, conn, &project_id)?;
            let patch = StepPatch {
                title: arg_str(args, "title").map(str::to_string),
                done: args.get("done").and_then(|v| v.as_bool()),
                expected_revision: Some(expected),
            };
            let f = crate::commands::planning::update_step_tx(conn, step_id, patch)?;
            let (fid, revision) = (f.id.clone(), f.revision);
            let value = serde_json::to_value(&f).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "step",
                fid.clone(),
                Some(PlanningChanged {
                    kind: "step",
                    project_id: Some(project_id),
                    feature_id: Some(fid),
                    revision: Some(revision),
                }),
            ))
        }
        "taskdock_add_progress_note" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let project_id = require_str(args, "project_id")?;
            ensure_grant(ctx, conn, &project_id)?;
            let feature_id = arg_str(args, "feature_id").map(str::to_string);
            let message = require_str(args, "message")?;
            let a = crate::commands::planning::add_note_tx(
                conn,
                project_id.clone(),
                feature_id.clone(),
                message,
            )?;
            let value = serde_json::to_value(&a).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "activity",
                a.id.clone(),
                Some(PlanningChanged {
                    kind: "activity",
                    project_id: Some(project_id),
                    feature_id,
                    revision: None,
                }),
            ))
        }
        "taskdock_link_agent_session" | "taskdock_unlink_agent_session" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let feature_id = require_str(args, "feature_id")?;
            let agent_source = require_str(args, "agent_source")?;
            let session_id = require_str(args, "session_id")?;
            if agent_source.chars().count() > 64 {
                return Err(ToolError::Failed(AppError::Validation(
                    "agent_source 超过 64 字符".into(),
                )));
            }
            if session_id.chars().count() > 256 {
                return Err(ToolError::Failed(AppError::Validation(
                    "session_id 超过 256 字符".into(),
                )));
            }
            let project_id = project_of_feature(conn, &feature_id)?;
            ensure_grant(ctx, conn, &project_id)?;
            let now = crate::agents::now_iso();
            if name == "taskdock_link_agent_session" {
                // UNIQUE(feature_id, agent_source, session_id)：重复 link 刷新状态与时间
                conn.execute(
                        "INSERT INTO feature_agent_links (id, feature_id, agent_source, session_id, status, last_event_at, created_at)
                         VALUES (?1, ?2, ?3, ?4, 'linked', ?5, ?5)
                         ON CONFLICT(feature_id, agent_source, session_id)
                         DO UPDATE SET status = 'linked', last_event_at = excluded.last_event_at",
                        rusqlite::params![
                            uuid::Uuid::new_v4().to_string(),
                            feature_id,
                            agent_source,
                            session_id,
                            now
                        ],
                    )
                    .map_err(AppError::from)?;
            } else {
                let n = conn
                    .execute(
                        "UPDATE feature_agent_links SET status = 'unlinked', last_event_at = ?4
                             WHERE feature_id = ?1 AND agent_source = ?2 AND session_id = ?3",
                        rusqlite::params![feature_id, agent_source, session_id, now],
                    )
                    .map_err(AppError::from)?;
                if n == 0 {
                    return Err(ToolError::Failed(AppError::Validation(format!(
                        "未找到关联记录: {agent_source}/{session_id}"
                    ))));
                }
            }
            let value = agent_links_of(conn, &feature_id)?;
            Ok(outcome(
                value,
                "feature",
                feature_id.clone(),
                Some(PlanningChanged {
                    kind: "feature",
                    project_id: Some(project_id),
                    feature_id: Some(feature_id),
                    revision: None,
                }),
            ))
        }
        "taskdock_submit_for_review" => {
            let conn = write_conn
                .ok_or_else(|| ToolError::Failed(AppError::Validation("缺少写事务".into())))?;
            let feature_id = require_str(args, "feature_id")?;
            let expected = require_revision(args)?;
            let project_id = project_of_feature(conn, &feature_id)?;
            ensure_grant(ctx, conn, &project_id)?;
            let f = crate::commands::planning::submit_for_review_tx(
                conn,
                feature_id.clone(),
                Some(expected),
                arg_str(args, "note").map(str::to_string),
            )?;
            let (fid, revision) = (f.id.clone(), f.revision);
            let value = serde_json::to_value(&f).map_err(AppError::from)?;
            Ok(outcome(
                value,
                "feature",
                fid.clone(),
                Some(PlanningChanged {
                    kind: "feature",
                    project_id: Some(project_id),
                    feature_id: Some(fid),
                    revision: Some(revision),
                }),
            ))
        }
        other => {
            // 资源扩展工具：授权、版本校验与业务写入在各子模块内完成，
            // 但审计、幂等、事务与事件广播仍由本文件统一处理。
            if let Some(outcome) =
                crate::mcp::task_tools::call(ctx, other, args, write_conn)?
            {
                return Ok(outcome);
            }
            if let Some(outcome) =
                crate::mcp::note_tools::call(ctx, other, args, write_conn)?
            {
                return Ok(outcome);
            }
            if let Some(outcome) =
                crate::mcp::workflow_tools::call(ctx, other, args, write_conn)?
            {
                return Ok(outcome);
            }
            if let Some(outcome) =
                crate::mcp::workspace_tools::call(ctx, other, args, write_conn)?
            {
                return Ok(outcome);
            }
            if let Some(outcome) =
                crate::mcp::knowledge_tools::call(ctx, other, args, write_conn)?
            {
                return Ok(outcome);
            }
            if let Some(outcome) =
                crate::mcp::capability_tools::call(ctx, other, args, write_conn)?
            {
                return Ok(outcome);
            }
            Err(ToolError::Failed(AppError::Validation(format!(
                "未知工具: {other}"
            ))))
        },
    }
}

// ── MCP results 封装 + 审计/幂等 ────────────────────────────────────

fn mcp_result(value: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
    mcp_text_result(text, is_error)
}

fn mcp_text_result(text: String, is_error: bool) -> Value {
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": is_error,
    })
}

/// 执行一次 tools/call：幂等重放 → 授权 → 执行 → 审计 → 广播 planning-changed。
/// 返回 MCP tools/call result；授权/身份失败以 Err(ToolRpcError) 交由协议层。
pub fn run_tool_call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
) -> Result<Value, crate::mcp::bridge::ToolRpcError> {
    use crate::mcp::bridge::ToolRpcError;
    // 整次工具调用计时： early return / 失败路径由 Drop 兜底记录一次耗时。
    let _timer = crate::diagnostics::metrics::OperationTimer::new("mcp", "tool_call");
    let Some(def) = tool_defs().iter().find(|t| t.name == name) else {
        return Err(ToolRpcError {
            code: crate::mcp::protocol::INVALID_PARAMS,
            message: format!("未知工具: {name}（见 tools/list）"),
            data: Value::Null,
        });
    };
    let ctx = refreshed_context(ctx)?;
    let request_id = request_id_of(args);

    if def.write {
        enum WriteResult {
            Fresh(CallOutcome),
            Replay(Value),
        }

        // ── 操作生命周期（v86）──
        // 幂等重放不得创建第二份 Operation：先做一次只读预检（索引命中），
        // 命中则本次请求不建操作；事务内仍会再校验一次，防并发竞态。
        let is_replay = if request_id.is_empty() {
            false
        } else {
            ctx.db
                .with_read(|conn| {
                    audit::find_replay_entry(conn, &ctx.agent.row_id, name, &request_id)
                })
                .map(|found| found.is_some())
                .unwrap_or(false)
        };
        let operation = if is_replay {
            None
        } else {
            let target = operation_target(name, args);
            operations::try_start(
                &ctx.db,
                &Principal::agent(
                    ctx.agent.row_id.clone(),
                    ctx.agent.agent_id.clone(),
                    Source::Mcp,
                ),
                &operations::OperationInput {
                    action: name,
                    resource_kind: &target.0,
                    resource_id: &target.1,
                    project_id: &target.2,
                    request_id: &request_id,
                    detail: "",
                },
            )
        };
        let operation_id = operation
            .as_ref()
            .map(|op| op.id.clone())
            .unwrap_or_default();
        // 租约：`operations::start` 已把本进程操作登记到共享调度器，
        // 长工具执行期间由它统一续租（不为单次调用创建线程）。
        let mut completed_operation: Option<operations::AgentOperation> = None;

        let fingerprint = request_fingerprint(args);
        // 已进入写事务前的真实阶段（UI 显示「正在写入」，不是估算进度）。
        if !operation_id.is_empty() {
            let _ = operations::update_phase(
                &ctx.db,
                &operation_id,
                operations::OperationPhase::Writing,
            );
        }
        let mut tool_error = None;
        let transaction = ctx.db.with_transaction(|conn| {
            let current_agent = auth::find_active_agent_by_row_id(conn, &ctx.agent.row_id)?;
            let Some(agent) = current_agent else {
                tool_error = Some(ToolError::Authz("Agent 凭据已撤销或不存在".into()));
                return Err(AppError::Validation("MCP Agent 已撤销".into()));
            };
            let tx_ctx = ToolCtx {
                db: ctx.db.clone(),
                agent,
                emit: ctx.emit.clone(),
            };

            if !request_id.is_empty() {
                if let Some(replay) =
                    audit::find_replay_entry(conn, &tx_ctx.agent.row_id, name, &request_id)?
                {
                    if let Err(error) = authorize_replay(&tx_ctx, conn, name, args, &replay) {
                        tool_error = Some(error);
                        return Err(AppError::Validation("MCP 重放授权失败".into()));
                    }
                    match fingerprint_from_audit_detail(&replay.detail) {
                        Some(saved) if saved == fingerprint.as_str() => {}
                        Some(_) => {
                            tool_error = Some(ToolError::Failed(AppError::Validation(
                                "requestId 已用于不同参数，请为新操作使用新的 requestId".into(),
                            )));
                            return Err(AppError::Validation("MCP requestId 参数冲突".into()));
                        }
                        None => {
                            tool_error = Some(ToolError::Failed(AppError::Validation(
                                "旧幂等记录没有参数摘要，无法安全重放；请使用新的 requestId".into(),
                            )));
                            return Err(AppError::Validation(
                                "MCP 旧 requestId 缺少参数摘要".into(),
                            ));
                        }
                    }
                    if replay.result_json.is_empty() {
                        tool_error = Some(ToolError::Failed(AppError::Validation(
                            "幂等审计结果为空，拒绝重新执行以避免重复写入".into(),
                        )));
                        return Err(AppError::Validation("MCP 幂等审计结果为空".into()));
                    }
                    let value = match serde_json::from_str(&replay.result_json) {
                        Ok(value) => value,
                        Err(_) => {
                            tool_error = Some(ToolError::Failed(AppError::Validation(
                                "幂等审计结果无法解析，拒绝重新执行".into(),
                            )));
                            return Err(AppError::Validation("MCP 幂等审计结果无法解析".into()));
                        }
                    };
                    return Ok(WriteResult::Replay(value));
                }
            }

            match call(&tx_ctx, name, args, Some(conn)) {
                Ok(outcome) => {
                    let result_json = serde_json::to_string(&outcome.value)?;
                    let revision = outcome.changed.as_ref().and_then(|c| c.revision);
                    let base_detail = match revision {
                        Some(rev) => format!("ok revision={rev}"),
                        None => "ok".to_string(),
                    };
                    let detail = if request_id.is_empty() {
                        base_detail
                    } else {
                        format!("{base_detail} request_sha256={fingerprint}")
                    };
                    let entry = AuditEntry {
                        agent_row_id: Some(&tx_ctx.agent.row_id),
                        agent_id: &tx_ctx.agent.agent_id,
                        action: name,
                        entity_type: outcome.entity_type,
                        entity_id: &outcome.entity_id,
                        request_id: &request_id,
                        success: true,
                        authz: true,
                        detail: &detail,
                        result_json: &result_json,
                    };
                    audit::write(conn, &entry)?;
                    // 操作完成与业务写入、审计**同一事务**提交：
                    // 业务回滚时 committed 一并回滚，不会出现「失败却显示成功」。
                    if !operation_id.is_empty() {
                        let mut result = operations::OperationResult::new()
                            .resource(outcome.entity_type, &outcome.entity_id)
                            .revision(revision);
                        if let Some(pid) =
                            outcome.changed.as_ref().and_then(|c| c.project_id.as_deref())
                        {
                            result = result.project(pid);
                        }
                        match operations::complete_tx(conn, &operation_id, &result) {
                            Ok(done) => completed_operation = done,
                            // 操作状态写失败不得回滚已成功的业务写入：保持 running，
                            // 租约到期后由恢复逻辑收敛为 interrupted。
                            Err(err) => tracing::warn!(
                                operation_id = %operation_id,
                                "MCP 操作完成状态未能随业务提交: {err}"
                            ),
                        }
                    }
                    Ok(WriteResult::Fresh(outcome))
                }
                Err(error) => {
                    tool_error = Some(error);
                    Err(AppError::Validation("MCP 写事务失败，已回滚".into()))
                }
            }
        });

        if let Some(error) = tool_error {
            if let ToolError::Failed(app_err) = &error {
                crate::diagnostics::metrics::record_failure("mcp", "tool_call", app_err);
            }
            // 业务事务已回滚：操作按真实错误收敛（冲突 → conflict，其余 → failed）。
            if !operation_id.is_empty() {
                let app_err = match &error {
                    ToolError::Authz(message) => AppError::Forbidden(message.clone()),
                    ToolError::Failed(AppError::Conflict(message)) => {
                        AppError::Conflict(message.clone())
                    }
                    ToolError::Failed(AppError::Validation(message)) => {
                        AppError::Validation(message.clone())
                    }
                    ToolError::Failed(AppError::NotFound(message)) => {
                        AppError::NotFound(message.clone())
                    }
                    ToolError::Failed(other) => AppError::Unavailable(other.user_message()),
                };
                let _ = operations::fail(&ctx.db, &operation_id, &app_err);
            }
            audit_tool_failure(&ctx, name, &request_id, &error)?;
            return tool_error_response(&ctx, error);
        }
        let result = transaction.map_err(|_| ToolRpcError {
            code: crate::mcp::protocol::INTERNAL_ERROR,
            message: "MCP 写入及其审计未能持久化，事务已回滚".into(),
            data: Value::Null,
        })?;
        return match result {
            WriteResult::Replay(value) => {
                if !operation_id.is_empty() {
                    // 预检后并发竞态退化为重放：如实记录，但绝不重复写业务数据。
                    let _ = operations::complete(
                        &ctx.db,
                        &operation_id,
                        &operations::OperationResult::new().detail("幂等重放，未重复写入"),
                    );
                }
                Ok(mcp_result(&value, false))
            }
            WriteResult::Fresh(outcome) => {
                if let Some(op) = &completed_operation {
                    operations::notify(op);
                }
                if let Some(changed) = outcome.changed {
                    (ctx.emit)(changed);
                }
                Ok(mcp_result(&outcome.value, false))
            }
        };
    }

    match call(&ctx, name, args, None) {
        Ok(outcome) => {
            let entry = AuditEntry {
                agent_row_id: Some(&ctx.agent.row_id),
                agent_id: &ctx.agent.agent_id,
                action: name,
                entity_type: outcome.entity_type,
                entity_id: &outcome.entity_id,
                request_id: "",
                success: true,
                authz: true,
                detail: "ok",
                result_json: "",
            };
            ctx.db
                .with_conn(|conn| audit::write(conn, &entry))
                .map_err(|_| ToolRpcError {
                    code: crate::mcp::protocol::INTERNAL_ERROR,
                    message: "MCP 读取审计未能持久化".into(),
                    data: Value::Null,
                })?;
            if matches!(name, "taskdock_get_project_context" | "taskdock_get_relevant_context") {
                match arg_str(args, "format") {
                    Some("compact_json") => return Ok(mcp_text_result(outcome.value.to_string(), false)),
                    Some("markdown") => {
                        if let Some(markdown) = outcome.value.get("markdown").and_then(Value::as_str) {
                            return Ok(mcp_text_result(markdown.to_string(), false));
                        }
                    }
                    _ => {}
                }
            }
            Ok(mcp_result(&outcome.value, false))
        }
        Err(error) => {
            if let ToolError::Failed(app_err) = &error {
                crate::diagnostics::metrics::record_failure("mcp", "tool_call", app_err);
            }
            audit_tool_failure(&ctx, name, "", &error)?;
            tool_error_response(&ctx, error)
        }
    }
}

fn audit_tool_failure(
    ctx: &ToolCtx,
    name: &str,
    request_id: &str,
    error: &ToolError,
) -> Result<(), crate::mcp::bridge::ToolRpcError> {
    use crate::mcp::bridge::ToolRpcError;
    let (detail, authz) = match error {
        ToolError::Authz(_) => ("authorization_denied".to_string(), false),
        ToolError::Failed(error) => (error.code().to_string(), true),
    };
    let entry = AuditEntry {
        agent_row_id: Some(&ctx.agent.row_id),
        agent_id: &ctx.agent.agent_id,
        action: name,
        entity_type: "",
        entity_id: "",
        request_id,
        success: false,
        authz,
        detail: &detail,
        result_json: "",
    };
    ctx.db
        .with_conn(|conn| audit::write(conn, &entry))
        .map_err(|_| ToolRpcError {
            code: crate::mcp::protocol::INTERNAL_ERROR,
            message: "MCP 操作失败，且失败审计未能持久化".into(),
            data: Value::Null,
        })
}

fn tool_error_response(
    ctx: &ToolCtx,
    error: ToolError,
) -> Result<Value, crate::mcp::bridge::ToolRpcError> {
    use crate::mcp::bridge::ToolRpcError;
    match error {
        ToolError::Authz(message) => Err(ToolRpcError {
            code: crate::mcp::protocol::ERR_FORBIDDEN,
            message,
            data: json!({ "agent_id": ctx.agent.agent_id }),
        }),
        ToolError::Failed(error) => {
            let message = error.user_message();
            Ok(mcp_result(
                &json!({ "error": error.code(), "message": message }),
                true,
            ))
        }
    }
}

/// `planning-changed` 事件名（与前端 bridge.ts 契约一致）。
pub const EVENT_NAME: &str = PLANNING_CHANGED_EVENT;
