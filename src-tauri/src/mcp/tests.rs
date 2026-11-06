//! MCP 模块测试：授权、项目隔离、并发冲突、幂等、审计、bridge 传输降级。
//!
//! 端到端（真实子进程 spawn `--mcp-server`）见 src-tauri/tests/mcp_e2e.rs。

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::commands::planning::{create_feature_impl, create_project_impl, ProjectInput};
use crate::db::Db;
use crate::error::AppResult;
use crate::mcp::auth::{self, McpAgentRow, McpScope};
use crate::mcp::bridge::{ToolRpcError, TransportFailure};
use crate::mcp::tools::{run_tool_call, ToolCtx};
use crate::mcp::{write_transport_config, PlanningChanged};

fn memdb() -> Arc<Db> {
    Arc::new(Db::open_in_memory().unwrap())
}

fn collector() -> (crate::mcp::ChangeEmitter, Arc<Mutex<Vec<PlanningChanged>>>) {
    let log: Arc<Mutex<Vec<PlanningChanged>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    let emit: crate::mcp::ChangeEmitter = Arc::new(move |c| {
        sink.lock().unwrap().push(c);
    });
    (emit, log)
}

/// 建一个 Agent 并返回 (row, token)；scope 立即生效。
fn make_agent(db: &Db, agent_id: &str, scope: &str) -> (McpAgentRow, String) {
    let created = auth::create_agent(db, agent_id, "测试 Agent").unwrap();
    let token = created.token;
    auth::set_agent_scope(db, &created.info.id, scope).unwrap();
    let row = db
        .with_conn(|c| auth::find_agent_by_token(c, &token))
        .unwrap()
        .unwrap();
    (row, token)
}

fn ctx_for(db: &Arc<Db>, agent: &McpAgentRow) -> ToolCtx {
    let (emit, _) = collector();
    ToolCtx {
        db: db.clone(),
        agent: agent.clone(),
        emit,
    }
}

fn call_ok(ctx: &ToolCtx, name: &str, args: Value) -> Value {
    let result = run_tool_call(ctx, name, &args).unwrap_or_else(|e| {
        panic!("{name} 应成功，得到 RPC 错误: {e:?}");
    });
    assert_eq!(result["isError"], false, "{name} 业务失败: {result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    serde_json::from_str(text).unwrap()
}

fn tool_err(ctx: &ToolCtx, name: &str, args: Value) -> crate::error::AppError {
    let result = run_tool_call(ctx, name, &args).expect("应为 isError result");
    assert_eq!(result["isError"], true, "应为业务失败 result: {result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    crate::error::AppError::Validation(payload["message"].as_str().unwrap().to_string())
}

fn rpc_err(ctx: &ToolCtx, name: &str, args: Value) -> ToolRpcError {
    run_tool_call(ctx, name, &args).expect_err("应为 RPC 错误（授权拒绝）")
}

fn proj_input(name: &str) -> ProjectInput {
    ProjectInput {
        name: name.into(),
        description: String::new(),
        status: None,
        target_date: None,
    }
}

// ── 工具发现 ─────────────────────────────────────────────────────────

#[test]
fn tool_defs_are_complete_and_unique() {
    let defs = crate::mcp::tools::tool_defs();
    assert_eq!(defs.len(), 18, "应为 18 个工具");
    let mut names: Vec<_> = defs.iter().map(|d| d.name).collect();
    let total = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), total, "工具名不得重复");
    assert!(defs.iter().all(|d| d.input_schema["type"] == "object"));
    // 写工具必须都要求 expected_revision；例外见模块注释（追加/关联/创建）
    let no_revision_required = [
        "taskdock_create_project",
        "taskdock_create_feature",
        "taskdock_add_progress_note",
        "taskdock_link_agent_session",
        "taskdock_unlink_agent_session",
    ];
    for d in defs.iter().filter(|d| d.write) {
        let req = d.input_schema["required"].as_array().unwrap();
        let has_rev = req.iter().any(|v| v == "expected_revision");
        assert!(
            has_rev || no_revision_required.contains(&d.name),
            "{} 缺少 expected_revision 要求",
            d.name
        );
    }
}

#[test]
fn tools_list_over_protocol_exposes_all() {
    let payload = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    let resp =
        crate::mcp::protocol::handle_request_value(&payload, &|_, _| unreachable!()).unwrap();
    let tools = resp["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 18);
    assert!(tools
        .iter()
        .any(|t| t["name"] == "taskdock_submit_for_review"));
}

// ── 授权与项目隔离 ───────────────────────────────────────────────────

#[test]
fn disabled_scope_is_denied_for_reads_and_writes() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "a1", "disabled");
    let ctx = ctx_for(&db, &agent);
    let e = rpc_err(&ctx, "taskdock_list_projects", json!({}));
    assert_eq!(e.code, crate::mcp::protocol::ERR_FORBIDDEN);
    let e = rpc_err(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "P", "requestId": "r1" }),
    );
    assert_eq!(e.code, crate::mcp::protocol::ERR_FORBIDDEN);
    // 拒绝也要留审计
    let n: i64 = db
        .with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM mcp_audit_log WHERE authz = 0",
                [],
                |r| r.get(0),
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert!(n >= 2, "授权拒绝应写审计: {n}");
}

#[test]
fn readonly_scope_can_read_but_not_write() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "ro", "readonly");
    let ctx = ctx_for(&db, &agent);
    let _ = call_ok(&ctx, "taskdock_list_projects", json!({}));
    let e = rpc_err(&ctx, "taskdock_create_project", json!({ "name": "P" }));
    assert_eq!(e.code, crate::mcp::protocol::ERR_FORBIDDEN);
    assert!(e.message.contains("project_rw"));
}

#[test]
fn project_rw_without_grant_cannot_write_existing_project() {
    let db = memdb();
    let p = create_project_impl(&db, proj_input("用户项目")).unwrap();
    let (agent, _) = make_agent(&db, "rw", "project_rw");
    let ctx = ctx_for(&db, &agent);

    // project_rw 只读取已授权项目；未授权项目名称不能出现在列表中。
    let listed = call_ok(&ctx, "taskdock_list_projects", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 0);
    let e = rpc_err(&ctx, "taskdock_get_project", json!({ "project_id": p.id }));
    assert_eq!(e.code, crate::mcp::protocol::ERR_FORBIDDEN);
    // 写未授权项目 → 拒绝
    let e = rpc_err(
        &ctx,
        "taskdock_update_project",
        json!({
            "project_id": p.id,
            "expected_revision": p.revision,
            "name": "越权改名",
        }),
    );
    assert_eq!(e.code, crate::mcp::protocol::ERR_FORBIDDEN);
    assert!(e.message.contains(&p.id), "拒绝消息应包含项目 id");
    // 内容未被改动
    let after = db
        .with_read(|c| crate::commands::planning::load_project_tx(c, &p.id))
        .unwrap();
    assert_eq!(after.name, "用户项目");
}

#[test]
fn project_isolation_between_agents() {
    let db = memdb();
    let p1 = create_project_impl(&db, proj_input("P1")).unwrap();
    let p2 = create_project_impl(&db, proj_input("P2")).unwrap();
    let (agent_a, _) = make_agent(&db, "agent-a", "project_rw");
    let ctx_a = ctx_for(&db, &agent_a);
    // agent-a 授权 P1
    auth::grant_project(&db, &agent_a.row_id, &p1.id).unwrap();

    let listed = call_ok(&ctx_a, "taskdock_list_projects", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], p1.id);
    let denied_read = rpc_err(
        &ctx_a,
        "taskdock_get_project",
        json!({ "project_id": p2.id }),
    );
    assert_eq!(denied_read.code, crate::mcp::protocol::ERR_FORBIDDEN);

    // P1 可写
    let _ = call_ok(
        &ctx_a,
        "taskdock_update_project",
        json!({
            "project_id": p1.id,
            "expected_revision": p1.revision,
            "description": "a 可写",
        }),
    );
    // P2 拒绝
    let e = rpc_err(
        &ctx_a,
        "taskdock_update_project",
        json!({
            "project_id": p2.id,
            "expected_revision": p2.revision,
            "description": "越权",
        }),
    );
    assert_eq!(e.code, crate::mcp::protocol::ERR_FORBIDDEN);
}

#[test]
fn project_rw_reads_are_limited_to_grants_and_revocation_is_immediate() {
    let db = memdb();
    let p1 = create_project_impl(&db, proj_input("可读项目")).unwrap();
    let p2 = create_project_impl(&db, proj_input("不可读项目")).unwrap();
    let f1 = create_feature_impl(
        &db,
        p1.id.clone(),
        crate::commands::planning::FeatureInput {
            title: "可读功能".into(),
            description: String::new(),
            acceptance_criteria: String::new(),
            status: None,
            priority: None,
            milestone_id: None,
            target_date: None,
        },
    )
    .unwrap();
    let f2 = create_feature_impl(
        &db,
        p2.id.clone(),
        crate::commands::planning::FeatureInput {
            title: "不可读功能".into(),
            description: String::new(),
            acceptance_criteria: String::new(),
            status: None,
            priority: None,
            milestone_id: None,
            target_date: None,
        },
    )
    .unwrap();
    let (agent_a, _) = make_agent(&db, "read-scope-a", "project_rw");
    auth::grant_project(&db, &agent_a.row_id, &p1.id).unwrap();
    let ctx_a = ctx_for(&db, &agent_a);

    let (agent_b, _) = make_agent(&db, "read-scope-b", "project_rw");
    auth::grant_project(&db, &agent_b.row_id, &p2.id).unwrap();
    let ctx_b = ctx_for(&db, &agent_b);
    let _ = call_ok(
        &ctx_b,
        "taskdock_link_agent_session",
        json!({
            "feature_id": f2.id,
            "agent_source": "claude-code",
            "session_id": "private-session",
        }),
    );

    let listed = call_ok(&ctx_a, "taskdock_list_projects", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], p1.id);
    assert_eq!(
        call_ok(
            &ctx_a,
            "taskdock_list_features",
            json!({ "project_id": p1.id }),
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
    for (name, args) in [
        ("taskdock_list_features", json!({ "project_id": p2.id })),
        ("taskdock_get_feature", json!({ "feature_id": f2.id })),
    ] {
        let error = rpc_err(&ctx_a, name, args);
        assert_eq!(error.code, crate::mcp::protocol::ERR_FORBIDDEN);
    }
    let hidden_session_links = call_ok(
        &ctx_a,
        "taskdock_get_agent_links",
        json!({ "session_id": "private-session" }),
    );
    assert_eq!(hidden_session_links.as_array().unwrap().len(), 0);
    let visible_links = call_ok(
        &ctx_b,
        "taskdock_get_agent_links",
        json!({ "session_id": "private-session" }),
    );
    assert_eq!(visible_links.as_array().unwrap().len(), 1);

    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM mcp_agent_grants WHERE agent_row_id = ?1 AND project_id = ?2",
            rusqlite::params![agent_a.row_id, p1.id],
        )
        .map_err(crate::error::AppError::from)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        call_ok(&ctx_a, "taskdock_list_projects", json!({}))
            .as_array()
            .unwrap()
            .len(),
        0,
        "撤销项目授权后列表立即不再返回该项目"
    );
    assert_eq!(f1.project_id, p1.id);
}

// ── 撤销立即生效 ─────────────────────────────────────────────────────

#[test]
fn revocation_takes_effect_immediately() {
    let db = memdb();
    let (agent, token) = make_agent(&db, "revoke-me", "project_rw");
    assert!(db
        .with_conn(|c| auth::find_agent_by_token(c, &token))
        .unwrap()
        .is_some());
    auth::revoke_agent(&db, &agent.row_id).unwrap();
    assert!(
        db.with_conn(|c| auth::find_agent_by_token(c, &token))
            .unwrap()
            .is_none(),
        "撤销后同一 token 必须立即失效"
    );
    let ctx = ctx_for(&db, &agent);
    let error = rpc_err(&ctx, "taskdock_list_projects", json!({}));
    assert_eq!(error.code, crate::mcp::protocol::ERR_UNAUTHORIZED);
    // 重复撤销幂等
    auth::revoke_agent(&db, &agent.row_id).unwrap();
}

// ── 写路径：revision / 冲突 / 语义限制 ──────────────────────────────

#[test]
fn write_tools_enforce_expected_revision_and_bump() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "writer", "project_rw");
    let ctx = ctx_for(&db, &agent);

    // 缺 expected_revision → 明确错误
    let created = call_ok(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "MCP 项目", "requestId": "c1" }),
    );
    assert_eq!(created["revision"], 1);
    let project_id = created["id"].as_str().unwrap().to_string();

    // 缺 expected_revision → 明确错误（不执行写）
    let err = tool_err(
        &ctx,
        "taskdock_update_project",
        json!({ "project_id": project_id, "name": "缺版本号" }),
    );
    assert!(err.to_string().contains("expected_revision"));

    // 创建后自动授权：可以直接更新
    let updated = call_ok(
        &ctx,
        "taskdock_update_project",
        json!({
            "project_id": project_id,
            "expected_revision": 1,
            "name": "MCP 项目 v2",
        }),
    );
    assert_eq!(updated["revision"], 2, "写成功 revision +1");

    // 过期 revision → Conflict（isError result，消息带当前 revision）
    let err = tool_err(
        &ctx,
        "taskdock_update_project",
        json!({
            "project_id": project_id,
            "expected_revision": 1,
            "name": "迟到写入",
        }),
    );
    assert!(
        err.to_string().contains("当前 2"),
        "冲突应带当前 revision: {err}"
    );
}

#[test]
fn feature_completed_is_user_only_and_submit_for_review_flow() {
    let db = memdb();
    let p = create_project_impl(&db, proj_input("P")).unwrap();
    let (agent, _) = make_agent(&db, "ag", "project_rw");
    auth::grant_project(&db, &agent.row_id, &p.id).unwrap();
    let ctx = ctx_for(&db, &agent);

    let f = call_ok(
        &ctx,
        "taskdock_create_feature",
        json!({ "project_id": p.id, "title": "登录" }),
    );
    assert_eq!(f["status"], "planned");
    let feature_id = f["id"].as_str().unwrap().to_string();

    // 直接置 completed → 拒绝
    let err = tool_err(
        &ctx,
        "taskdock_update_feature",
        json!({
            "feature_id": feature_id,
            "expected_revision": f["revision"],
            "status": "completed",
        }),
    );
    assert!(err.to_string().contains("completed"));

    let in_progress = call_ok(
        &ctx,
        "taskdock_update_feature",
        json!({
            "feature_id": feature_id,
            "expected_revision": f["revision"],
            "status": "in_progress",
        }),
    );

    // submit_for_review → review + activity
    let submitted = call_ok(
        &ctx,
        "taskdock_submit_for_review",
        json!({
            "feature_id": feature_id,
            "expected_revision": in_progress["revision"],
            "note": "实现完成，请验收",
        }),
    );
    assert_eq!(submitted["status"], "review");
    let kinds: Vec<String> = db
        .with_conn(|c| {
            let mut st = c
                .prepare("SELECT kind FROM planning_activity WHERE feature_id = ?1 ORDER BY rowid")
                .map_err(crate::error::AppError::from)?;
            let rows = st
                .query_map(rusqlite::params![feature_id], |r| r.get::<_, String>(0))
                .map_err(crate::error::AppError::from)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert!(
        kinds.contains(&"status_change".to_string()) && kinds.contains(&"note".to_string()),
        "提交验收应写 status_change 与 note 历史: {kinds:?}"
    );

    // 说明为空时按可选说明处理；超长说明失败不能留下状态或 activity 半成功。
    let second = call_ok(
        &ctx,
        "taskdock_create_feature",
        json!({ "project_id": p.id, "title": "第二项" }),
    );
    let too_long = "n".repeat(2001);
    let error = tool_err(
        &ctx,
        "taskdock_submit_for_review",
        json!({
            "feature_id": second["id"],
            "expected_revision": second["revision"],
            "note": too_long,
        }),
    );
    assert!(error.to_string().contains("2000"));
    let after_failed_submit = db
        .with_read(|conn| {
            crate::commands::planning::load_feature_tx(conn, second["id"].as_str().unwrap())
        })
        .unwrap();
    assert_eq!(after_failed_submit.status, "planned");
    assert_eq!(
        after_failed_submit.revision,
        second["revision"].as_i64().unwrap()
    );
    let second_activity_count: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM planning_activity WHERE feature_id = ?1",
                rusqlite::params![second["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_eq!(second_activity_count, 0);

    let submitted_without_note = call_ok(
        &ctx,
        "taskdock_submit_for_review",
        json!({
            "feature_id": second["id"],
            "expected_revision": second["revision"],
            "note": "   ",
        }),
    );
    assert_eq!(submitted_without_note["status"], "review");
    let second_activity_count: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM planning_activity WHERE feature_id = ?1",
                rusqlite::params![second["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_eq!(second_activity_count, 1, "空白 note 不应写入日志");

    // 已 review 再提交 → 拒绝；且 update_feature 不能改到 completed
    let err = tool_err(
        &ctx,
        "taskdock_submit_for_review",
        json!({ "feature_id": feature_id, "expected_revision": submitted["revision"] }),
    );
    assert!(err.to_string().contains("review"));
}

#[test]
fn step_tools_go_through_feature_revision() {
    let db = memdb();
    let p = create_project_impl(&db, proj_input("P")).unwrap();
    let (agent, _) = make_agent(&db, "ag2", "project_rw");
    auth::grant_project(&db, &agent.row_id, &p.id).unwrap();
    let ctx = ctx_for(&db, &agent);
    let f = call_ok(
        &ctx,
        "taskdock_create_feature",
        json!({ "project_id": p.id, "title": "功能" }),
    );
    let feature_id = f["id"].as_str().unwrap().to_string();

    let with_step = call_ok(
        &ctx,
        "taskdock_add_step",
        json!({
            "feature_id": feature_id,
            "title": "设计",
            "expected_revision": f["revision"],
        }),
    );
    assert_eq!(with_step["revision"], 2);
    let step_id = with_step["steps"][0]["id"].as_str().unwrap().to_string();

    let done = call_ok(
        &ctx,
        "taskdock_update_step",
        json!({ "step_id": step_id, "expected_revision": 2, "done": true }),
    );
    assert_eq!(done["steps"][0]["done"], true);
    assert_eq!(done["revision"], 3);

    // 旧 revision 冲突
    let err = tool_err(
        &ctx,
        "taskdock_update_step",
        json!({ "step_id": step_id, "expected_revision": 2, "done": false }),
    );
    assert!(err.to_string().contains("当前 3"));
}

// ── request_id 幂等 ─────────────────────────────────────────────────

#[test]
fn same_request_id_replays_original_result_without_double_execute() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "idem", "project_rw");
    let ctx = ctx_for(&db, &agent);
    let args = json!({ "name": "幂等项目", "requestId": "req-42" });

    let first = call_ok(&ctx, "taskdock_create_project", args.clone());
    let second = call_ok(&ctx, "taskdock_create_project", args);
    assert_eq!(first["id"], second["id"], "同 request_id 应返回原结果");
    assert_eq!(second["revision"], 1, "重放不得消耗 revision");

    // 库内只有一个项目
    let count: i64 = db
        .with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM planning_projects", [], |r| r.get(0))
                .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_eq!(count, 1, "重复请求不得重复执行");
    // 幂等成功记录只有一条
    let audits: i64 = db
        .with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM mcp_audit_log WHERE action='taskdock_create_project' AND request_id='req-42' AND success=1",
                [], |r| r.get(0),
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_eq!(audits, 1, "幂等键唯一索引应只允许一条成功记录");
}

#[test]
fn same_request_id_with_different_arguments_is_rejected() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "idem-conflict", "project_rw");
    let ctx = ctx_for(&db, &agent);

    let first = call_ok(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "参数 A", "requestId": "same-id" }),
    );
    let conflict = tool_err(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "参数 B", "requestId": "same-id" }),
    );
    assert!(conflict.to_string().contains("不同参数"));
    let projects: Vec<String> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare("SELECT name FROM planning_projects ORDER BY name")?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_eq!(projects, vec!["参数 A"]);
    assert_eq!(first["name"], "参数 A");
}

#[test]
fn request_id_is_scoped_to_agent_and_action() {
    let db = memdb();
    let (agent_a, _) = make_agent(&db, "idem-scope-a", "project_rw");
    let (agent_b, _) = make_agent(&db, "idem-scope-b", "project_rw");
    let ctx_a = ctx_for(&db, &agent_a);
    let ctx_b = ctx_for(&db, &agent_b);

    let project_a = call_ok(
        &ctx_a,
        "taskdock_create_project",
        json!({ "name": "Agent A 项目", "requestId": "shared" }),
    );
    let feature = call_ok(
        &ctx_a,
        "taskdock_create_feature",
        json!({
            "project_id": project_a["id"],
            "title": "Agent A 功能",
            "requestId": "shared",
        }),
    );
    let project_b = call_ok(
        &ctx_b,
        "taskdock_create_project",
        json!({ "name": "Agent B 项目", "requestId": "shared" }),
    );
    assert_ne!(project_a["id"], project_b["id"]);
    assert_eq!(feature["title"], "Agent A 功能");

    let counts = db
        .with_conn(|conn| {
            let projects: i64 =
                conn.query_row("SELECT COUNT(*) FROM planning_projects", [], |r| r.get(0))?;
            let features: i64 =
                conn.query_row("SELECT COUNT(*) FROM planning_features", [], |r| r.get(0))?;
            let audits: i64 = conn.query_row(
                "SELECT COUNT(*) FROM mcp_audit_log WHERE request_id='shared' AND success=1",
                [],
                |r| r.get(0),
            )?;
            Ok((projects, features, audits))
        })
        .unwrap();
    assert_eq!(counts, (2, 1, 3));
}

#[test]
fn concurrent_same_request_id_creates_one_project_and_one_success_audit() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "idem-race", "project_rw");
    let args = json!({ "name": "并发幂等", "requestId": "shared-request" });
    let threads = 12;

    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..threads {
            let db = db.clone();
            let agent = agent.clone();
            let args = args.clone();
            handles.push(scope.spawn(move || {
                let (emit, _) = collector();
                let ctx = ToolCtx { db, agent, emit };
                call_ok(&ctx, "taskdock_create_project", args)
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });

    let first_id = results[0]["id"].as_str().unwrap();
    assert!(results.iter().all(|value| value["id"] == first_id));
    let counts = db
        .with_conn(|conn| {
            let projects: i64 = conn.query_row("SELECT COUNT(*) FROM planning_projects", [], |r| r.get(0))?;
            let audits: i64 = conn.query_row(
                "SELECT COUNT(*) FROM mcp_audit_log
                 WHERE action='taskdock_create_project' AND request_id='shared-request' AND success=1",
                [],
                |r| r.get(0),
            )?;
            Ok((projects, audits))
        })
        .unwrap();
    assert_eq!(counts, (1, 1));
}

#[test]
fn replay_requires_current_scope_and_project_grant() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "idem-revoke", "project_rw");
    let ctx = ctx_for(&db, &agent);
    let created = call_ok(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "授权后撤销", "requestId": "grant-replay" }),
    );

    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM mcp_agent_grants WHERE agent_row_id = ?1 AND project_id = ?2",
            rusqlite::params![agent.row_id, created["id"].as_str().unwrap()],
        )
        .map_err(crate::error::AppError::from)?;
        Ok(())
    })
    .unwrap();
    let denied = rpc_err(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "授权后撤销", "requestId": "grant-replay" }),
    );
    assert_eq!(denied.code, crate::mcp::protocol::ERR_FORBIDDEN);

    auth::set_agent_scope(&db, &agent.row_id, "readonly").unwrap();
    let denied = rpc_err(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "授权后撤销", "requestId": "grant-replay" }),
    );
    assert_eq!(denied.code, crate::mcp::protocol::ERR_FORBIDDEN);
}

#[test]
fn failed_audit_insert_rolls_back_mcp_business_write() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "audit-fail", "project_rw");
    let ctx = ctx_for(&db, &agent);
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_mcp_success_audit
             BEFORE INSERT ON mcp_audit_log
             WHEN NEW.action = 'taskdock_create_project' AND NEW.success = 1
             BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;",
        )
        .map_err(crate::error::AppError::from)
    })
    .unwrap();

    let error = run_tool_call(
        &ctx,
        "taskdock_create_project",
        &json!({ "name": "必须回滚", "requestId": "audit-failure" }),
    )
    .expect_err("审计无法持久化时写工具不应返回成功");
    assert_eq!(error.code, crate::mcp::protocol::INTERNAL_ERROR);
    let project_count: i64 = db
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM planning_projects", [], |row| {
                row.get(0)
            })
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_eq!(project_count, 0, "业务写入须随审计失败回滚");
}

// ── 审计与事件 ──────────────────────────────────────────────────────

#[test]
fn audits_record_reads_writes_and_failures_without_secrets() {
    let db = memdb();
    let p = create_project_impl(&db, proj_input("P")).unwrap();
    let (agent, token) = make_agent(&db, "aud", "project_rw");
    auth::grant_project(&db, &agent.row_id, &p.id).unwrap();
    let ctx = ctx_for(&db, &agent);

    let _ = call_ok(&ctx, "taskdock_list_projects", json!({}));
    let _ = call_ok(
        &ctx,
        "taskdock_update_project",
        json!({ "project_id": p.id, "expected_revision": p.revision, "name": "X2" }),
    );
    // 一次业务失败（冲突）
    let _ = tool_err(
        &ctx,
        "taskdock_update_project",
        json!({ "project_id": p.id, "expected_revision": p.revision, "name": "X3" }),
    );
    let _ = tool_err(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "日期校验失败", "target_date": "PRIVATE_DATE_SENTINEL" }),
    );

    let rows: Vec<(String, String, i64, i64, String, String)> = db
        .with_conn(|c| {
            let mut st = c
                .prepare(
                    "SELECT action, entity_id, success, authz, detail, result_json FROM mcp_audit_log ORDER BY rowid",
                )
                .map_err(crate::error::AppError::from)?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map_err(crate::error::AppError::from)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert!(rows
        .iter()
        .any(|(a, _, s, z, _, _)| a == "taskdock_list_projects" && *s == 1 && *z == 1));
    assert!(rows
        .iter()
        .any(|(a, e, s, _, _, res)| a == "taskdock_update_project"
            && *s == 1
            && *e == p.id
            && res.contains("\"revision\":2")));
    assert!(rows
        .iter()
        .any(|(a, _, s, _, _, _)| a == "taskdock_update_project" && *s == 0));
    // 绝不含 token
    let all = rows.iter().map(|r| format!("{r:?}")).collect::<String>();
    assert!(!all.contains(&token), "审计不得包含 token 明文");
    assert!(
        !all.contains("PRIVATE_DATE_SENTINEL"),
        "审计错误详情不得包含用户提交的原始值"
    );
}

#[test]
fn successful_writes_emit_planning_changed() {
    let db = memdb();
    let (emit, log) = collector();
    let (agent, _) = make_agent(&db, "emit", "project_rw");
    let ctx = ToolCtx {
        db: db.clone(),
        agent,
        emit,
    };
    let created = call_ok(
        &ctx,
        "taskdock_create_project",
        json!({ "name": "事件项目" }),
    );
    let events = log.lock().unwrap();
    assert_eq!(events.len(), 1, "一次写一个事件: {events:?}");
    assert_eq!(events[0].kind, "project");
    assert_eq!(
        events[0].project_id.as_deref(),
        Some(created["id"].as_str().unwrap())
    );
    assert_eq!(events[0].revision, Some(1));
}

// ── link / unlink / 查询工具 ────────────────────────────────────────

#[test]
fn link_unlink_roundtrip_and_filters() {
    let db = memdb();
    let p = create_project_impl(&db, proj_input("P")).unwrap();
    let f = create_feature_impl(
        &db,
        p.id.clone(),
        crate::commands::planning::FeatureInput {
            title: "功能".into(),
            description: String::new(),
            acceptance_criteria: String::new(),
            status: None,
            priority: None,
            milestone_id: None,
            target_date: None,
        },
    )
    .unwrap();
    let (agent, _) = make_agent(&db, "linker", "project_rw");
    auth::grant_project(&db, &agent.row_id, &p.id).unwrap();
    let ctx = ctx_for(&db, &agent);

    let linked = call_ok(
        &ctx,
        "taskdock_link_agent_session",
        json!({
            "feature_id": f.id,
            "agent_source": "claude-code",
            "session_id": "sess-1",
        }),
    );
    assert_eq!(linked[0]["status"], "linked");

    // 重复 link：upsert，不产生第二行
    let again = call_ok(
        &ctx,
        "taskdock_link_agent_session",
        json!({
            "feature_id": f.id,
            "agent_source": "claude-code",
            "session_id": "sess-1",
        }),
    );
    assert_eq!(again.as_array().unwrap().len(), 1);

    // 过滤查询
    let filtered = call_ok(
        &ctx,
        "taskdock_get_agent_links",
        json!({ "project_id": p.id, "agent_source": "claude-code" }),
    );
    assert_eq!(filtered.as_array().unwrap().len(), 1);

    // unlink → 标记 unlinked
    let unlinked = call_ok(
        &ctx,
        "taskdock_unlink_agent_session",
        json!({
            "feature_id": f.id,
            "agent_source": "claude-code",
            "session_id": "sess-1",
        }),
    );
    assert_eq!(unlinked[0]["status"], "unlinked");
    // 不存在的关联 unlink → 业务错误
    let err = tool_err(
        &ctx,
        "taskdock_unlink_agent_session",
        json!({
            "feature_id": f.id,
            "agent_source": "codex",
            "session_id": "nope",
        }),
    );
    assert!(err.to_string().contains("未找到关联记录"));
}

#[test]
fn unknown_tool_is_rpc_invalid_params() {
    let db = memdb();
    let (agent, _) = make_agent(&db, "x", "project_rw");
    let ctx = ctx_for(&db, &agent);
    let e = rpc_err(&ctx, "taskdock_delete_everything", json!({}));
    assert_eq!(e.code, crate::mcp::protocol::INVALID_PARAMS);
}

// ── 传输文件与 stdio 降级 ───────────────────────────────────────────

/// 环境变量类测试的串行锁（cargo test 并行运行时避免 TASK_DOCK_DATA_DIR 竞争）。
static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn transport_config_roundtrip() {
    let dir = std::env::temp_dir().join(format!("td-mcp-transport-{}", uuid::Uuid::new_v4()));
    write_transport_config(&dir, 52844, "tok-1", true).unwrap();
    let cfg: crate::mcp::McpTransport =
        serde_json::from_str(&std::fs::read_to_string(crate::mcp::transport_path(&dir)).unwrap())
            .unwrap();
    assert_eq!(
        (cfg.port, cfg.token.as_str(), cfg.enabled),
        (52844, "tok-1", true)
    );
    write_transport_config(&dir, 0, "", false).unwrap();
    let cfg: crate::mcp::McpTransport =
        serde_json::from_str(&std::fs::read_to_string(crate::mcp::transport_path(&dir)).unwrap())
            .unwrap();
    assert!(!cfg.enabled);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn post_json_fails_clearly_without_transport_file() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("td-mcp-absent-{}", uuid::Uuid::new_v4()));
    std::env::set_var("TASK_DOCK_DATA_DIR", &dir);
    let err = crate::mcp::bridge::post_json("{}").unwrap_err();
    std::env::remove_var("TASK_DOCK_DATA_DIR");
    match err {
        TransportFailure::Unreachable(msg) => {
            assert!(msg.contains("不存在"), "应明确说明文件不存在: {msg}");
        }
        other => panic!("应为 Unreachable: {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn post_json_fails_when_disabled() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("td-mcp-disabled-{}", uuid::Uuid::new_v4()));
    write_transport_config(&dir, 12345, "t", false).unwrap();
    std::env::set_var("TASK_DOCK_DATA_DIR", &dir);
    let err = crate::mcp::bridge::post_json("{}").unwrap_err();
    std::env::remove_var("TASK_DOCK_DATA_DIR");
    match err {
        TransportFailure::Unreachable(msg) => assert!(msg.contains("未启用"), "{msg}"),
        other => panic!("应为 Unreachable: {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn scope_flags_are_consistent() {
    assert!(!McpScope::Disabled.can_read());
    assert!(!McpScope::Disabled.can_write());
    assert!(McpScope::ReadOnly.can_read());
    assert!(!McpScope::ReadOnly.can_write());
    assert!(McpScope::ProjectRw.can_read());
    assert!(McpScope::ProjectRw.can_write());
}

#[test]
fn token_hash_is_stable_and_agent_lookup_works() -> AppResult<()> {
    let db = memdb();
    let created = auth::create_agent(&db, "lookup", "查询测试")?;
    assert!(created.token.starts_with("tdm_"));
    let row = db.with_conn(|c| auth::find_agent_by_token(c, &created.token))?;
    assert!(row.is_some(), "正确 token 应能解析身份");
    let wrong = db.with_conn(|c| auth::find_agent_by_token(c, "tdm_wrong"))?;
    assert!(wrong.is_none());
    assert!(
        !db.with_conn(|c| auth::has_project_grant(c, &row.unwrap().row_id, "p"))?,
        "无授权时应为 false"
    );
    Ok(())
}

#[test]
fn token_rotation_invalidates_the_previous_token_and_returns_the_same_identity() {
    let db = memdb();
    let created = auth::create_agent(&db, "rotate", "轮换测试").unwrap();
    let rotated = auth::rotate_agent_token(&db, &created.info.id).unwrap();

    assert_eq!(rotated.info.id, created.info.id);
    assert_ne!(rotated.token, created.token);
    let old = db
        .with_conn(|conn| auth::find_agent_by_token(conn, &created.token))
        .unwrap();
    let new = db
        .with_conn(|conn| auth::find_agent_by_token(conn, &rotated.token))
        .unwrap();
    assert!(old.is_none(), "轮换提交后旧 token 应立即失效");
    assert_eq!(new.unwrap().row_id, created.info.id);

    let stored_hash: String = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT token_hash FROM mcp_agents WHERE id = ?1",
                rusqlite::params![created.info.id],
                |row| row.get(0),
            )
            .map_err(crate::error::AppError::from)
        })
        .unwrap();
    assert_ne!(stored_hash, rotated.token);
    assert_eq!(stored_hash, auth::sha256_hex(&rotated.token));
}

#[test]
fn revoking_a_project_grant_blocks_the_next_read() {
    let db = memdb();
    let project = create_project_impl(&db, proj_input("撤权项目")).unwrap();
    let (agent, _) = make_agent(&db, "grant-revoke", "project_rw");
    auth::grant_project(&db, &agent.row_id, &project.id).unwrap();
    let ctx = ctx_for(&db, &agent);

    let loaded = call_ok(
        &ctx,
        "taskdock_get_project",
        json!({ "project_id": project.id }),
    );
    assert_eq!(loaded["id"], project.id);

    let info = auth::revoke_project(&db, &agent.row_id, &project.id).unwrap();
    assert!(!info.granted_project_ids.contains(&project.id));
    let denied = rpc_err(
        &ctx,
        "taskdock_get_project",
        json!({ "project_id": project.id }),
    );
    assert_eq!(denied.code, crate::mcp::protocol::ERR_FORBIDDEN);
}

#[test]
fn audit_page_is_bounded_and_excludes_operation_payloads() {
    let db = memdb();
    let created = auth::create_agent(&db, "audit-ui", "审计 UI").unwrap();
    db.with_conn(|conn| {
        for index in 0..3 {
            crate::mcp::audit::write(
                conn,
                &crate::mcp::audit::AuditEntry {
                    agent_row_id: Some(&created.info.id),
                    agent_id: &created.info.agent_id,
                    action: "taskdock_update_project",
                    entity_type: "project",
                    entity_id: &format!("project-{index}"),
                    request_id: &format!("request-{index}"),
                    success: index != 1,
                    authz: index != 1,
                    detail: "PRIVATE_DETAIL_SENTINEL",
                    result_json: "PRIVATE_RESULT_SENTINEL",
                },
            )?;
        }
        Ok(())
    })
    .unwrap();

    let first = db
        .with_read(|conn| crate::mcp::audit::list_page(conn, 0, 2))
        .unwrap();
    let second = db
        .with_read(|conn| crate::mcp::audit::list_page(conn, 2, 2))
        .unwrap();
    assert_eq!(first.total, 3);
    assert_eq!(first.items.len(), 2);
    assert_eq!(second.items.len(), 1);
    assert_eq!(first.items[0].error_category, None);
    assert_eq!(
        first.items[1].error_category.as_deref(),
        Some("authorization_denied")
    );

    let public = serde_json::to_string(&first).unwrap();
    assert!(!public.contains("PRIVATE_DETAIL_SENTINEL"));
    assert!(!public.contains("PRIVATE_RESULT_SENTINEL"));
    assert!(!public.contains("request-"));

    let clamped = db
        .with_read(|conn| crate::mcp::audit::list_page(conn, 0, u32::MAX))
        .unwrap();
    assert_eq!(clamped.limit, 100);
}
