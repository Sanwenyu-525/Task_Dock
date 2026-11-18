//! 协作中心单元/集成测试（真实 SQLite 内存库，不 mock 业务层）。

use std::sync::Arc;

use rusqlite::Connection;

use crate::db::Db;
use crate::error::AppError;
use crate::mcp::auth::{McpAgentRow, McpScope};
use crate::mcp::tools::ToolCtx;

use super::actor::Actor;
use super::model::*;
use super::service::Core;

const PROJECT: &str = "proj-collab-test";

fn setup() -> Db {
    let db = Db::open_in_memory().expect("内存库");
    db.with_transaction(|conn: &Connection| {
        conn.execute(
            "INSERT INTO planning_projects (id, name, description, status, created_at, updated_at)
             VALUES (?1, '协作测试项目', '测试', 'planning', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![PROJECT],
        )?;
        Ok(())
    })
    .expect("项目");
    db
}

fn feature_input(title: &str) -> IssueInput {
    IssueInput {
        kind: "feature".to_string(),
        title: title.to_string(),
        description: "需要统一可视化规划".to_string(),
        acceptance: "能看到流程图与原型".to_string(),
        ..Default::default()
    }
}

fn bug_input(title: &str) -> IssueInput {
    IssueInput {
        kind: "bug".to_string(),
        title: title.to_string(),
        description: "点击按钮崩溃".to_string(),
        repro_steps: vec!["打开页面".to_string(), "点击按钮".to_string()],
        expected_result: Some("正常跳转".to_string()),
        actual_result: Some("应用退出".to_string()),
        environment: Some("Windows 11 / v0.5.0".to_string()),
        ..Default::default()
    }
}

fn mcp_row(id: &str, scope: McpScope) -> McpAgentRow {
    McpAgentRow {
        row_id: id.to_string(),
        agent_id: format!("agent-{id}"),
        display_name: format!("Agent {id}"),
        scope,
    }
}

fn insert_agent(db: &Db, row: &McpAgentRow, grant: bool) {
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO mcp_agents (id, agent_id, display_name, token_hash, scope, created_at, updated_at)
             VALUES (?1,?2,?3,'hash',?4,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            rusqlite::params![
                row.row_id,
                row.agent_id,
                row.display_name,
                match row.scope {
                    McpScope::Disabled => "disabled",
                    McpScope::ReadOnly => "readonly",
                    McpScope::ProjectRw => "project_rw",
                }
            ],
        )?;
        if grant {
            conn.execute(
                "INSERT INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
                 VALUES (?1,?2,?3,'2026-01-01T00:00:00Z')",
                rusqlite::params![format!("g-{}", row.row_id), row.row_id, PROJECT],
            )?;
        }
        Ok(())
    })
    .expect("agent");
}

#[test]
fn issue_create_is_idempotent_and_detects_duplicates() {
    let db = setup();
    let actor = Actor::ui();
    let mut input = feature_input("统一可视化引擎");
    input.client_request_id = Some("req-1".to_string());

    let first = db
        .with_transaction(|conn| Core::new(conn).create_issue(&actor, PROJECT, &input))
        .expect("创建");
    assert!(!first.idempotent_replay);

    let replay = db
        .with_transaction(|conn| Core::new(conn).create_issue(&actor, PROJECT, &input))
        .expect("幂等重放");
    assert!(replay.idempotent_replay);
    assert_eq!(first.issue.id, replay.issue.id);

    let second = db
        .with_transaction(|conn| {
            Core::new(conn).create_issue(&actor, PROJECT, &feature_input("统一可视化引擎"))
        })
        .expect("创建相似需求");
    assert!(
        second
            .duplicate_candidates
            .iter()
            .any(|c| c.id == first.issue.id),
        "相似需求应作为候选返回，而不是自动合并"
    );
}

#[test]
fn stale_revision_is_rejected() {
    let db = setup();
    let actor = Actor::ui();
    let created = db
        .with_transaction(|conn| Core::new(conn).create_issue(&actor, PROJECT, &feature_input("并发")))
        .expect("创建");

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).update_issue(
                &actor,
                &created.issue.id,
                99,
                &IssuePatch {
                    title: Some("覆盖".to_string()),
                    ..Default::default()
                },
            )
        })
        .expect_err("旧 revision 必须失败");
    match err {
        AppError::Conflict(msg) => assert!(msg.contains("revision")),
        other => panic!("期望冲突，实际 {other:?}"),
    }
}

#[test]
fn agent_scope_and_grant_are_enforced() {
    let db = setup();
    let readonly = mcp_row("a-read", McpScope::ReadOnly);
    insert_agent(&db, &readonly, true);
    let actor = Actor::agent(&readonly, "mcp");

    let list = db
        .with_conn(|conn| Core::new(conn).list_issues(&actor, PROJECT, &IssueFilter::default()))
        .expect("只读列表");
    assert_eq!(list.total, 0);

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).create_issue(&actor, PROJECT, &feature_input("只读写入"))
        })
        .expect_err("只读 Agent 不能写");
    assert!(matches!(err, AppError::Forbidden(_)));

    let rw_no_grant = mcp_row("a-rw", McpScope::ProjectRw);
    insert_agent(&db, &rw_no_grant, false);
    let actor = Actor::agent(&rw_no_grant, "mcp");
    let err = db
        .with_conn(|conn| Core::new(conn).list_issues(&actor, PROJECT, &IssueFilter::default()))
        .expect_err("未授权项目不可读");
    assert!(matches!(err, AppError::Forbidden(_)));

    let rw = mcp_row("a-rw2", McpScope::ProjectRw);
    insert_agent(&db, &rw, true);
    let actor = Actor::agent(&rw, "mcp");
    let created = db
        .with_transaction(|conn| {
            Core::new(conn).create_issue(&actor, PROJECT, &feature_input("授权写入"))
        })
        .expect("授权后可写");
    assert_eq!(created.issue.source, "mcp");
}

#[test]
fn plan_requires_review_and_can_create_tasks() {
    let db = setup();
    let ui = Actor::ui();
    let issue = db
        .with_transaction(|conn| Core::new(conn).create_issue(&ui, PROJECT, &feature_input("规划审批")))
        .expect("issue");

    let plan = db
        .with_transaction(|conn| Core::new(conn).create_plan_from_issue(&ui, &issue.issue.id))
        .expect("plan");
    let updated = db
        .with_transaction(|conn| {
            Core::new(conn).update_plan(
                &ui,
                &plan.id,
                plan.revision,
                &PlanPatch {
                    summary: Some("方案摘要".to_string()),
                    solution_md: Some("## 方案".to_string()),
                    breakdown: Some(vec![
                        TaskDraft {
                            title: "实现引擎".to_string(),
                            description: "".to_string(),
                            priority: Some(1),
                        },
                        TaskDraft {
                            title: "接入页面".to_string(),
                            description: "".to_string(),
                            priority: Some(2),
                        },
                    ]),
                    ..Default::default()
                },
            )
        })
        .expect("update");

    let submitted = db
        .with_transaction(|conn| Core::new(conn).submit_plan(&ui, &plan.id, updated.revision))
        .expect("submit");
    assert_eq!(submitted.status, "in_review");

    // Agent 即使有写权限也不能审批。
    let agent = mcp_row("a-plan", McpScope::ProjectRw);
    insert_agent(&db, &agent, true);
    let agent_actor = Actor::agent(&agent, "mcp");
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).review_plan(&agent_actor, &plan.id, submitted.revision, "approve", None)
        })
        .expect_err("Agent 不能审批");
    assert!(matches!(err, AppError::Forbidden(_)));

    let approved = db
        .with_transaction(|conn| {
            Core::new(conn).review_plan(&ui, &plan.id, submitted.revision, "approve", None)
        })
        .expect("approve");
    assert_eq!(approved.status, "approved");

    let tasks = db
        .with_transaction(|conn| Core::new(conn).create_tasks_from_plan(&ui, &plan.id))
        .expect("拆解任务");
    assert_eq!(tasks.created.len(), 2);
    assert_eq!(tasks.plan.status, "developing");

    let progress = db
        .with_conn(|conn| Core::new(conn).plan_progress(&ui, &plan.id))
        .expect("进度");
    assert_eq!(progress.total, 2);
    assert_eq!(progress.completed, 0);
    assert_eq!(progress.percent, Some(0));

    // 幂等：再次拆解返回已存在任务，不重复创建。
    let again = db
        .with_transaction(|conn| Core::new(conn).create_tasks_from_plan(&ui, &plan.id))
        .expect("重复拆解");
    assert!(again.created.is_empty());
    assert_eq!(again.existing.len(), 2);
}

#[test]
fn visual_versions_diff_and_restore() {
    let db = setup();
    let ui = Actor::ui();
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "流程".to_string(),
                    description: "".to_string(),
                    kind: "flowchart".to_string(),
                    source_format: "mermaid".to_string(),
                    source_content: "graph TD\n A[开始] --> B[结束]".to_string(),
                    plan_id: None,
                    preview_asset: None,
                },
            )
        })
        .expect("创建可视化");
    assert_eq!(doc.version, 1);
    assert_eq!(doc.renderer, "graph-svg");

    let updated = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                doc.revision,
                &VisualPatch {
                    title: Some("流程 v2".to_string()),
                    ..Default::default()
                },
                "改标题",
            )
        })
        .expect("更新");
    assert_eq!(updated.version, 2);
    assert_eq!(updated.revision, 2);

    let diff = db
        .with_conn(|conn| Core::new(conn).compare_visual(&ui, &doc.id, 1, 2))
        .expect("diff");
    assert!(diff.changed >= 1);

    let restored = db
        .with_transaction(|conn| Core::new(conn).restore_visual(&ui, &doc.id, 1, updated.revision))
        .expect("恢复");
    assert_eq!(restored.title, "流程");
    assert_eq!(restored.version, 3);
}

#[test]
fn malicious_visual_content_is_rejected() {
    let db = setup();
    let ui = Actor::ui();
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "xss".to_string(),
                    description: "".to_string(),
                    kind: "flowchart".to_string(),
                    source_format: "mermaid".to_string(),
                    source_content: "graph TD\n A[\"<script>alert(1)</script>\"] --> B[结束]"
                        .to_string(),
                    plan_id: None,
                    preview_asset: None,
                },
            )
        })
        .expect_err("脚本内容必须拒绝");
    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn prototype_patch_events_and_flow_validation() {
    let db = setup();
    let ui = Actor::ui();
    let content = serde_json::json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [
            {"id":"page-1","name":"首页","components":[
                {"id":"c1","type":"button","x":10,"y":10,"w":120,"h":40,
                 "props":{"label":"下一步"},"style":{},"events":{"onClick":{"action":"navigate","target":"page-2"}}}
            ]},
            {"id":"page-2","name":"详情","components":[
                {"id":"c2","type":"text","x":10,"y":10,"w":200,"h":40,
                 "props":{"text":"完成"},"style":{},"events":{}}
            ]}
        ],
        "state": {}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "原型".to_string(),
                    description: "".to_string(),
                    kind: "prototype".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                },
            )
        })
        .expect("原型");

    let patched = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                doc.revision,
                &[PatchOp {
                    op: "add".to_string(),
                    page_id: Some("page-2".to_string()),
                    component_id: None,
                    component: Some(serde_json::json!({
                        "id":"c3","type":"badge","x":10,"y":60,"w":80,"h":24,
                        "props":{"text":"新增"},"style":{},"events":{}
                    })),
                    patch: None,
                    x: None,
                    y: None,
                }],
                "加徽标",
            )
        })
        .expect("patch");
    assert_eq!(patched.version, 2);

    let state = db
        .with_conn(|conn| Core::new(conn).prototype_state(&ui, &doc.id))
        .expect("state");
    assert_eq!(state.current_page, "page-1");

    let next = db
        .with_conn(|conn| {
            Core::new(conn).dispatch_prototype_event(
                &ui,
                &doc.id,
                state.clone(),
                &PrototypeEvent {
                    action: "navigate".to_string(),
                    target: Some("page-2".to_string()),
                    value: None,
                },
            )
        })
        .expect("navigate");
    assert_eq!(next.current_page, "page-2");

    let toggled = db
        .with_conn(|conn| {
            Core::new(conn).dispatch_prototype_event(
                &ui,
                &doc.id,
                next,
                &PrototypeEvent {
                    action: "toggle".to_string(),
                    target: Some("c3".to_string()),
                    value: None,
                },
            )
        })
        .expect("toggle");
    assert_eq!(toggled.values.get("c3"), Some(&serde_json::json!(true)));

    let report = db
        .with_conn(|conn| Core::new(conn).validate_prototype_flow(&ui, &doc.id))
        .expect("flow");
    assert!(report.ok, "单向导航不应有环：{:?}", report.issues);
}

#[test]
fn bug_evidence_resolve_and_verify() {
    let db = setup();
    let ui = Actor::ui();
    let bug = db
        .with_transaction(|conn| Core::new(conn).create_issue(&ui, PROJECT, &bug_input("崩溃")))
        .expect("bug");

    let evidence = db
        .with_transaction(|conn| {
            Core::new(conn).attach_evidence_text(
                &ui,
                PROJECT,
                &EvidenceInput {
                    subject_kind: "issue".to_string(),
                    subject_id: bug.issue.id.clone(),
                    kind: "log".to_string(),
                    title: "崩溃日志".to_string(),
                    path: None,
                    text: Some("panic at click".to_string()),
                    mime: None,
                    meta: None,
                },
            )
        })
        .expect("证据");

    let detail = db
        .with_conn(|conn| Core::new(conn).get_issue(&ui, &bug.issue.id))
        .expect("详情");
    assert_eq!(detail.evidence_count, 1);

    let resolved = db
        .with_transaction(|conn| {
            Core::new(conn).resolve_bug(&ui, &bug.issue.id, bug.issue.revision, "已修复")
        })
        .expect("解决");
    assert_eq!(resolved.status, "resolved");

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).verify_bug(&ui, &bug.issue.id, resolved.revision, "")
        })
        .expect_err("无证据不能验收");
    assert!(matches!(err, AppError::Validation(_)));

    let verified = db
        .with_transaction(|conn| {
            Core::new(conn).verify_bug(&ui, &bug.issue.id, resolved.revision, &evidence.id)
        })
        .expect("验收");
    assert_eq!(verified.status, "verified");
}

#[test]
fn ai_generation_records_real_provider_and_no_fake_image() {
    let db = setup();
    let ui = Actor::ui();
    let job = db
        .with_transaction(|conn| {
            Core::new(conn).generate_visual(&ui, PROJECT, None, None, "prototype", "生成原型")
        })
        .expect("生成");
    assert_eq!(job.status, "succeeded");
    assert_eq!(job.provider, "local-structured");
    assert!(job.document_id.is_some());

    let doc = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, job.document_id.as_deref().unwrap()))
        .expect("文档");
    assert_eq!(doc.kind, "prototype");

    let image = db
        .with_transaction(|conn| {
            Core::new(conn).create_image_job(&ui, PROJECT, None, "生成配图", None)
        })
        .expect("图像任务");
    assert_eq!(image.status, "provider_unavailable");
    assert_eq!(image.error_code.as_deref(), Some("PROVIDER_UNAVAILABLE"));
}

#[test]
fn audit_log_is_written_for_writes() {
    let db = setup();
    let ui = Actor::ui();
    let created = db
        .with_transaction(|conn| Core::new(conn).create_issue(&ui, PROJECT, &feature_input("审计")))
        .expect("创建");
    let audit = db
        .with_conn(|conn| Core::new(conn).list_audit(PROJECT, Some("issue"), Some(1), Some(50)))
        .expect("审计");
    assert!(audit
        .items
        .iter()
        .any(|e| e.entity_id == created.issue.id && e.action == "create"));
}

#[test]
fn mcp_tools_are_stable_and_share_core() {
    let db = Arc::new(setup());
    let row = mcp_row("mcp-row", McpScope::ProjectRw);
    insert_agent(&db, &row, true);
    let ctx = ToolCtx {
        db: db.clone(),
        agent: row,
        emit: Arc::new(|_| {}),
    };

    let defs = super::mcp_tools::definitions_for_registry();
    let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
    assert_eq!(names.len(), 26, "MCP 工具数量必须稳定");
    assert!(names.contains(&"taskdock_collab_create_issue"));
    assert!(names.contains(&"taskdock_collab_create_bug"));
    assert!(names.contains(&"taskdock_collab_generate_visualization"));
    assert!(!names.contains(&"taskdock_collab_approve_plan"), "Agent 不得直接审批");

    let created = db
        .with_transaction(|conn| {
            super::mcp_tools::call(
                &ctx,
                "taskdock_collab_create_issue",
                &serde_json::json!({
                    "project_id": PROJECT,
                    "kind": "feature",
                    "title": "MCP 提交的需求",
                    "description": "与 IPC 共用 Core",
                    "priority": "P1",
                    "requestId": "mcp-req-1"
                }),
                Some(conn),
            )
            .expect("工具必须由 collab 接管")
                .map_err(|e| match e {
                    crate::mcp::tools::ToolError::Authz(msg) => AppError::Forbidden(msg),
                    crate::mcp::tools::ToolError::Failed(err) => err,
                })
        })
        .expect("写工具成功");
    let issue_id = created.value["issue"]["id"].as_str().expect("issue id").to_string();

    let mut labels = std::collections::BTreeSet::new();
    for def in &defs {
        assert!(labels.insert(def.name), "MCP 工具名重复：{}", def.name);
        assert!(!def.description.is_empty(), "工具描述不能为空：{}", def.name);
    }

    // 读工具走 ctx.db.with_conn（不在外部事务内），验证同一 Core 读取。
    let read = super::mcp_tools::call(
        &ctx,
        "taskdock_collab_get_issue",
        &serde_json::json!({ "issue_id": issue_id }),
        None,
    )
    .expect("读工具")
    .expect("读取成功");
    assert_eq!(read.value["issue"]["source"], "mcp");
    assert_eq!(read.value["issue"]["sourceSession"], "");
}
