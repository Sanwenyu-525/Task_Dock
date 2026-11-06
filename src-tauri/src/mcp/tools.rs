//! MCP 工具集语义实现（18 个）+ 审计与 request_id 幂等封装。
//!
//! 分层约束：
//! - 所有实体读写都走 `commands/planning.rs` 的 `*_impl`（同一校验、同一事务、
//!   同一 activity 留痕），绝不直接拼 SQL 写 planning 表；
//! - 写工具**强制** `expected_revision`（乐观并发，防止多客户端后写无声覆盖），
//!   冲突返回明确错误（携带当前 revision）；
//! - 授权：读工具要求 scope ∈ {readonly, project_rw}；写工具要求 scope=project_rw
//!   且持有对应项目 grant（create_project 例外：project_rw 可新建项目，
//!   创建后自动授予该项目，便于同一 Agent 继续推进）；
//! - `taskdock_update_feature` 拒绝 status='completed'（验收完成由用户判定）；
//!   `taskdock_submit_for_review` 只能置 'review'；
//! - 有意偏离说明：`taskdock_add_progress_note` 与 link/unlink 只追加 activity
//!   与关联表，不修改项目/功能内容，不存在丢失更新风险，因此不要求也不消耗
//!   expected_revision（其余全部写工具强制）。

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::commands::planning::{
    add_note_impl, add_step_impl, create_feature_impl, create_project_impl, list_features_impl,
    list_milestones_impl, list_projects_impl, load_feature_tx, load_project_tx,
    update_feature_impl, update_project_impl, update_step_impl, FeatureInput, FeaturePatch,
    ProjectInput, ProjectPatch, StepPatch,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::audit::{self, AuditEntry};
use crate::mcp::auth::{self, McpAgentRow};
use crate::mcp::{PlanningChanged, PLANNING_CHANGED_EVENT};

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

fn schema(props: Value, required: &[&str]) -> Value {
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
    DEFS.get_or_init(|| vec![
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
            description: "创建用户项目（scope=project_rw 即可）。创建后自动授予本 Agent 该项目的写授权。",
            input_schema: schema(
                json!({
                    "name": { "type": "string", "maxLength": 100 },
                    "description": { "type": "string", "maxLength": 2000 },
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
    ])
    .as_slice()
}

// ── 参数读取辅助 ─────────────────────────────────────────────────────

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn require_str(args: &Value, key: &str) -> Result<String, ToolError> {
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

fn require_revision(args: &Value) -> Result<i64, ToolError> {
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

/// 写授权：scope=project_rw 且持有该项目 grant；不满足返回 Authz。
fn ensure_grant(ctx: &ToolCtx, project_id: &str) -> Result<(), ToolError> {
    if !ctx.agent.scope.can_write() {
        return Err(ToolError::Authz(format!(
            "scope={} 不允许写操作（需要 project_rw）",
            ctx.agent.scope.as_str()
        )));
    }
    let granted = ctx
        .db
        .with_conn(|conn| auth::has_project_grant(conn, &ctx.agent.row_id, project_id))
        .map_err(ToolError::Failed)?;
    if granted {
        Ok(())
    } else {
        Err(ToolError::Authz(format!(
            "未授权项目: {project_id}（写操作需要该项目的 grant）"
        )))
    }
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

struct CallOutcome {
    value: Value,
    changed: Option<PlanningChanged>,
    entity_type: &'static str,
    entity_id: String,
}

fn outcome(
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

fn call(ctx: &ToolCtx, name: &str, args: &Value) -> Result<CallOutcome, ToolError> {
    let db = ctx.db.as_ref();
    let agent = &ctx.agent;
    match name {
        // ── 读工具（scope ∈ {readonly, project_rw}）────────────────
        "taskdock_list_projects" => {
            ensure_can_read(agent)?;
            let projects =
                list_projects_impl(db, args.get("include_archived").and_then(|v| v.as_bool()))?;
            let value = serde_json::to_value(projects).map_err(AppError::from)?;
            Ok(outcome(value, "project", String::new(), None))
        }
        "taskdock_get_project" => {
            ensure_can_read(agent)?;
            let id = require_str(args, "project_id")?;
            let p = db.with_read(|conn| load_project_tx(conn, &id))?;
            let value = serde_json::to_value(p).map_err(AppError::from)?;
            Ok(outcome(value, "project", id, None))
        }
        "taskdock_list_features" => {
            ensure_can_read(agent)?;
            let id = require_str(args, "project_id")?;
            let features = list_features_impl(db, id)?;
            let value = serde_json::to_value(features).map_err(AppError::from)?;
            Ok(outcome(value, "feature", String::new(), None))
        }
        "taskdock_get_feature" => {
            ensure_can_read(agent)?;
            let id = require_str(args, "feature_id")?;
            let value = db.with_read(|conn| {
                let f = load_feature_tx(conn, &id)?;
                let mut v = serde_json::to_value(&f).map_err(AppError::from)?;
                v["agent_links"] = agent_links_of(conn, &id)?;
                Ok::<_, AppError>(v)
            })?;
            Ok(outcome(value, "feature", id, None))
        }
        "taskdock_list_steps" => {
            ensure_can_read(agent)?;
            let id = require_str(args, "feature_id")?;
            let f = db.with_read(|conn| load_feature_tx(conn, &id))?;
            let value = serde_json::to_value(f.steps).map_err(AppError::from)?;
            Ok(outcome(value, "step", id, None))
        }
        "taskdock_list_milestones" => {
            ensure_can_read(agent)?;
            let id = require_str(args, "project_id")?;
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
            if !agent.scope.can_write() {
                return Err(ToolError::Authz(format!(
                    "scope={} 不允许创建项目（需要 project_rw）",
                    agent.scope.as_str()
                )));
            }
            let input = ProjectInput {
                name: require_str(args, "name")?,
                description: arg_str(args, "description").unwrap_or_default().to_string(),
                status: None,
                target_date: arg_str(args, "target_date").map(str::to_string),
            };
            let p = create_project_impl(db, input)?;
            // 创建者自动获得该项目授权，便于同一 Agent 继续推进（见交付报告）
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        agent.row_id,
                        p.id,
                        crate::agents::now_iso()
                    ],
                )
                .map_err(AppError::from)?;
                Ok(())
            })?;
            let revision = p.revision;
            let id = p.id.clone();
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
        "taskdock_update_project" => {
            let id = require_str(args, "project_id")?;
            let expected = require_revision(args)?;
            ensure_grant(ctx, &id)?;
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
            let p = update_project_impl(db, id.clone(), patch)?;
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
            let project_id = require_str(args, "project_id")?;
            ensure_grant(ctx, &project_id)?;
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
            let f = create_feature_impl(db, project_id.clone(), input)?;
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
            let id = require_str(args, "feature_id")?;
            let expected = require_revision(args)?;
            if arg_str(args, "status") == Some("completed") {
                return Err(ToolError::Failed(AppError::Validation(
                    "Agent 无权将功能标记为 completed（验收完成由用户在 Task Dock 中判定）；可提交 review"
                        .into(),
                )));
            }
            let project_id = db.with_read(|conn| project_of_feature(conn, &id))?;
            ensure_grant(ctx, &project_id)?;
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
            let f = update_feature_impl(db, id.clone(), patch)?;
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
            let feature_id = require_str(args, "feature_id")?;
            let expected = require_revision(args)?;
            let project_id = db.with_read(|conn| project_of_feature(conn, &feature_id))?;
            ensure_grant(ctx, &project_id)?;
            let f = add_step_impl(db, feature_id, require_str(args, "title")?, Some(expected))?;
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
            let step_id = require_str(args, "step_id")?;
            let expected = require_revision(args)?;
            let (_feature_id, project_id) = db.with_read(|conn| project_of_step(conn, &step_id))?;
            ensure_grant(ctx, &project_id)?;
            let patch = StepPatch {
                title: arg_str(args, "title").map(str::to_string),
                done: args.get("done").and_then(|v| v.as_bool()),
                expected_revision: Some(expected),
            };
            let f = update_step_impl(db, step_id, patch)?;
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
            let project_id = require_str(args, "project_id")?;
            ensure_grant(ctx, &project_id)?;
            let feature_id = arg_str(args, "feature_id").map(str::to_string);
            let message = require_str(args, "message")?;
            let a = add_note_impl(db, project_id.clone(), feature_id.clone(), message)?;
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
            let project_id = db.with_read(|conn| project_of_feature(conn, &feature_id))?;
            ensure_grant(ctx, &project_id)?;
            db.with_conn(|conn| {
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
                        return Err(AppError::Validation(format!(
                            "未找到关联记录: {agent_source}/{session_id}"
                        )));
                    }
                }
                Ok(())
            })?;
            let value = db.with_read(|conn| agent_links_of(conn, &feature_id))?;
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
            let feature_id = require_str(args, "feature_id")?;
            let expected = require_revision(args)?;
            let project_id = db.with_read(|conn| project_of_feature(conn, &feature_id))?;
            ensure_grant(ctx, &project_id)?;
            let current_status: String = db.with_read(|conn| {
                conn.query_row(
                    "SELECT status FROM planning_features WHERE id = ?1",
                    rusqlite::params![feature_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(AppError::from)?
                .ok_or_else(|| AppError::Validation(format!("功能不存在: {feature_id}")))
            })?;
            if current_status == "completed" {
                return Err(ToolError::Failed(AppError::Validation(
                    "功能已完成（completed），提交验收需用户在 Task Dock 中先重开".into(),
                )));
            }
            if current_status == "review" {
                return Err(ToolError::Failed(AppError::Validation(
                    "功能已处于 review 状态，无需重复提交".into(),
                )));
            }
            let patch = FeaturePatch {
                title: None,
                description: None,
                acceptance_criteria: None,
                status: Some("review".into()),
                priority: None,
                milestone_id: None,
                target_date: None,
                sort_order: None,
                expected_revision: Some(expected),
            };
            let f = update_feature_impl(db, feature_id.clone(), patch)?;
            if let Some(note) = arg_str(args, "note").filter(|s| !s.trim().is_empty()) {
                add_note_impl(
                    db,
                    project_id.clone(),
                    Some(feature_id.clone()),
                    note.to_string(),
                )?;
            }
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
        other => Err(ToolError::Failed(AppError::Validation(format!(
            "未知工具: {other}"
        )))),
    }
}

// ── MCP results 封装 + 审计/幂等 ────────────────────────────────────

fn mcp_result(value: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
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
    let Some(def) = tool_defs().iter().find(|t| t.name == name) else {
        return Err(ToolRpcError {
            code: crate::mcp::protocol::INVALID_PARAMS,
            message: format!("未知工具: {name}（见 tools/list）"),
            data: Value::Null,
        });
    };
    let request_id = request_id_of(args);

    // 写工具幂等重放：同 (agent, action, request_id) 的成功请求直接返回原结果
    if def.write && !request_id.is_empty() {
        let replay = ctx
            .db
            .with_conn(|conn| audit::find_replay(conn, &ctx.agent.row_id, name, &request_id))
            .ok()
            .flatten();
        if let Some(original) = replay {
            let value: Value =
                serde_json::from_str(&original).unwrap_or_else(|_| json!({ "replayed": true }));
            return Ok(mcp_result(&value, false));
        }
    }

    match call(ctx, name, args) {
        Ok(outcome) => {
            let result_json = serde_json::to_string(&outcome.value).unwrap_or_default();
            let revision = outcome.changed.as_ref().and_then(|c| c.revision);
            if def.write {
                let detail = match revision {
                    Some(rev) => format!("ok revision={rev}"),
                    None => "ok".to_string(),
                };
                let entry = AuditEntry {
                    agent_row_id: Some(&ctx.agent.row_id),
                    agent_id: &ctx.agent.agent_id,
                    action: name,
                    entity_type: outcome.entity_type,
                    entity_id: &outcome.entity_id,
                    request_id: &request_id,
                    success: true,
                    authz: true,
                    detail: &detail,
                    result_json: &result_json,
                };
                if let Err(e) = ctx.db.with_conn(|conn| audit::write(conn, &entry)) {
                    if audit::is_idempotency_conflict(&e) {
                        // 并发同键：按重放处理，返回已入库的原结果
                        if let Ok(Some(original)) = ctx.db.with_conn(|conn| {
                            audit::find_replay(conn, &ctx.agent.row_id, name, &request_id)
                        }) {
                            let value: Value = serde_json::from_str(&original)
                                .unwrap_or_else(|_| json!({ "replayed": true }));
                            return Ok(mcp_result(&value, false));
                        }
                    }
                    // 审计写失败不回滚业务写（业务已在事务内落库），记录并继续
                    tracing::warn!("MCP 审计写入失败: {e}");
                }
            } else {
                // 读工具也留审计（request_id 恒 ''，可重复记录）
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
                if let Err(e) = ctx.db.with_conn(|conn| audit::write(conn, &entry)) {
                    tracing::warn!("MCP 读审计写入失败: {e}");
                }
            }
            if let Some(changed) = outcome.changed {
                (ctx.emit)(changed);
            }
            Ok(mcp_result(&outcome.value, false))
        }
        Err(ToolError::Authz(msg)) => {
            let entry = AuditEntry {
                agent_row_id: Some(&ctx.agent.row_id),
                agent_id: &ctx.agent.agent_id,
                action: name,
                entity_type: "",
                entity_id: "",
                request_id: &request_id,
                success: false,
                authz: false,
                detail: &msg,
                result_json: "",
            };
            if let Err(e) = ctx.db.with_conn(|conn| audit::write(conn, &entry)) {
                tracing::warn!("MCP 拒绝审计写入失败: {e}");
            }
            Err(ToolRpcError {
                code: crate::mcp::protocol::ERR_FORBIDDEN,
                message: msg,
                data: json!({ "agent_id": ctx.agent.agent_id }),
            })
        }
        Err(ToolError::Failed(e)) => {
            let message = e.user_message();
            let entry = AuditEntry {
                agent_row_id: Some(&ctx.agent.row_id),
                agent_id: &ctx.agent.agent_id,
                action: name,
                entity_type: "",
                entity_id: "",
                request_id: "",
                success: false,
                authz: true,
                detail: &message,
                result_json: "",
            };
            if let Err(err) = ctx.db.with_conn(|conn| audit::write(conn, &entry)) {
                tracing::warn!("MCP 失败审计写入失败: {err}");
            }
            Ok(mcp_result(
                &json!({ "error": e.code(), "message": message }),
                true,
            ))
        }
    }
}

/// `planning-changed` 事件名（与前端 bridge.ts 契约一致）。
pub const EVENT_NAME: &str = PLANNING_CHANGED_EVENT;
