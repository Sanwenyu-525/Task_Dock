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
        // v91 起项目授权外键指向 workspace_projects：与历史迁移同一规则，
        // 为计划补建同 ID 项目根，授权键（PROJECT）既是根也是计划容器。
        conn.execute(
            "INSERT INTO workspace_projects (id, name, kind, status, created_at, updated_at)
             VALUES (?1, '协作测试项目', 'general', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![PROJECT],
        )?;
        conn.execute(
            "INSERT INTO planning_projects (id, name, description, status, created_at, updated_at, workspace_project_id)
             VALUES (?1, '协作测试项目', '测试', 'planning', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?1)",
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
    assert_eq!(plan.breakdown.len(), 2, "从需求创建方案应带默认任务草案");
    assert!(plan.breakdown.iter().any(|d| d.title.starts_with("实现：")));
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
    let linked = crate::commands::project_workspace::workspace_task_link_list_impl(&db, PROJECT)
        .expect("project tasks");
    assert_eq!(linked.len(), tasks.created.len());
    assert!(linked.iter().all(|item| tasks.created.contains(&item.task_id)));

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
                    authoring_mode: None,
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
                    authoring_mode: None,
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
                    authoring_mode: None,
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
                    remove_keys: None,
                    x: None,
                    y: None,
                    name: None,
                    page: None,
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
    let content: serde_json::Value =
        serde_json::from_str(&doc.source_content).expect("原型 JSON");
    let pages = content
        .get("pages")
        .and_then(|v| v.as_array())
        .expect("pages");
    assert!(pages.len() >= 2, "默认原型应包含确认页与结果页");
    for page in pages {
        for comp in page
            .get("components")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let x = comp.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let w = comp.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
            assert!(x + w <= 320.0, "默认原型必须能在 320px 预览宽度内放下：{comp}");
        }
    }
    assert!(
        pages.iter().any(|p| {
            p.get("components")
                .and_then(|v| v.as_array())
                .map(|cs| {
                    cs.iter().any(|c| {
                        c.get("events")
                            .and_then(|e| e.get("onClick"))
                            .and_then(|e| e.get("action"))
                            .and_then(|v| v.as_str())
                            == Some("navigate")
                    })
                })
                .unwrap_or(false)
        }),
        "默认原型至少一个可导航按钮"
    );

    let state = db
        .with_conn(|conn| Core::new(conn).prototype_state(&ui, &doc.id))
        .expect("原型状态");
    let next = db
        .with_conn(|conn| {
            Core::new(conn).dispatch_prototype_event(
                &ui,
                &doc.id,
                state,
                &PrototypeEvent {
                    action: "navigate".to_string(),
                    target: Some("page-2".to_string()),
                    value: None,
                },
            )
        })
        .expect("默认原型应可导航");
    assert_eq!(next.current_page, "page-2");

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
fn graph_editor_positions_and_canvas_are_preserved() {
    let db = setup();
    let ui = Actor::ui();
    let content = serde_json::json!({
        "nodes": [
            {"id":"a","label":"开始","kind":"start","x":120,"y":80,"color":"#ff0000","config":{}},
            {"id":"b","label":"处理","kind":"process","x":420,"y":260,"config":{}}
        ],
        "edges": [{"id":"e1","from":"a","to":"b","label":"下一步"}],
        "layout": {"direction":"LR","width":900,"height":600}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "可编辑图".to_string(),
                    description: String::new(),
                    kind: "flowchart".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("创建图");
    let stored: serde_json::Value = serde_json::from_str(&doc.source_content).expect("JSON");
    assert_eq!(stored["nodes"][0]["x"], 120.0);
    assert_eq!(stored["nodes"][1]["y"], 260.0);
    assert_eq!(stored["nodes"][0]["color"], "#ff0000");
    assert_eq!(stored["layout"]["width"], 900.0);
    assert_eq!(stored["layout"]["direction"], "LR");
    assert_eq!(doc.authoring_mode, "manual");

    // 人工拖动后再保存：坐标必须原样保留，生成新版本。
    let moved = serde_json::json!({
        "nodes": [
            {"id":"a","label":"开始","kind":"start","x":150,"y":100,"config":{}},
            {"id":"b","label":"处理","kind":"process","x":460,"y":300,"config":{}}
        ],
        "edges": [{"id":"e1","from":"a","to":"b","label":"下一步"}],
        "layout": {"direction":"LR","width":900,"height":600}
    });
    let updated = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                doc.revision,
                &VisualPatch {
                    source_content: Some(moved.to_string()),
                    ..Default::default()
                },
                "拖动节点",
            )
        })
        .expect("保存位置");
    assert_eq!(updated.version, 2);
    let stored: serde_json::Value = serde_json::from_str(&updated.source_content).expect("JSON");
    assert_eq!(stored["nodes"][0]["x"], 150.0);
    assert_eq!(stored["nodes"][1]["y"], 300.0);

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                updated.revision,
                &VisualPatch {
                    source_content: Some(
                        serde_json::json!({
                            "nodes":[{"id":"a","label":"开始","kind":"start","x":99999,"y":0}],
                            "edges":[],
                            "layout":{"direction":"TB"}
                        })
                        .to_string(),
                    ),
                    ..Default::default()
                },
                "非法坐标",
            )
        })
        .expect_err("坐标超限必须拒绝");
    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn prototype_page_ops_are_atomic() {
    let db = setup();
    let ui = Actor::ui();
    let content = serde_json::json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [{"id":"page-1","name":"首页","components":[]}],
        "state": {}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "分页原型".to_string(),
                    description: String::new(),
                    kind: "prototype".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("原型");

    let page_op = |op: &str, page_id: Option<&str>, name: Option<&str>| PatchOp {
        op: op.to_string(),
        page_id: page_id.map(str::to_string),
        component_id: None,
        component: None,
        patch: None,
        remove_keys: None,
        x: None,
        y: None,
        name: name.map(str::to_string),
        page: None,
    };
    let added = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                doc.revision,
                &[
                    page_op("page_add", None, Some("详情页")),
                    page_op("page_rename", Some("page-1"), Some("首页改名")),
                ],
                "新增并改名页面",
            )
        })
        .expect("页面 Patch");
    assert_eq!(added.version, 2);
    let parsed: serde_json::Value = serde_json::from_str(&added.source_content).expect("JSON");
    let pages = parsed["pages"].as_array().expect("pages");
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0]["name"], "首页改名");
    assert_eq!(pages[1]["name"], "详情页");

    // 同一批 Patch 中后续操作非法：整体失败，页面与版本都不变。
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                added.revision,
                &[
                    page_op("page_add", None, Some("不应落库")),
                    PatchOp {
                        op: "remove".to_string(),
                        page_id: Some("page-1".to_string()),
                        component_id: Some("missing".to_string()),
                        component: None,
                        patch: None,
                        remove_keys: None,
                        x: None,
                        y: None,
                        name: None,
                        page: None,
                    },
                ],
                "部分失败",
            )
        })
        .expect_err("非法操作必须整体失败");
    assert!(matches!(err, AppError::NotFound(_)));
    let unchanged = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc.id))
        .expect("读取");
    assert_eq!(unchanged.version, 2, "失败的批量 Patch 不得生成版本");
    let parsed: serde_json::Value = serde_json::from_str(&unchanged.source_content).expect("JSON");
    assert_eq!(parsed["pages"].as_array().expect("pages").len(), 2);

    let renamed = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                unchanged.revision,
                &[page_op("page_remove", Some("page-1"), None)],
                "删除页面",
            )
        })
        .expect("删除页面");
    assert_eq!(renamed.version, 3);
    let remaining: serde_json::Value =
        serde_json::from_str(&renamed.source_content).expect("JSON");
    assert_eq!(remaining["pages"].as_array().expect("pages").len(), 1);
}

#[test]
fn prototype_patch_updates_and_removes_object_fields() {
    let db = setup();
    let ui = Actor::ui();
    let content = serde_json::json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [
            {"id":"page-1","name":"首页","components":[
                {"id":"c1","type":"button","x":10,"y":10,"w":120,"h":40,
                 "props":{"label":"下一步","variant":"primary","disabled":false},
                 "style":{"bg":"#123456","radius":"8px","fontSize":"13px"},
                 "events":{"onClick":{"action":"navigate","target":"page-2"},
                           "onChange":{"action":"toggle","target":"c1"}}}
            ]},
            {"id":"page-2","name":"详情","components":[]}
        ],
        "state": {}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "字段删除原型".to_string(),
                    description: String::new(),
                    kind: "prototype".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
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
                    op: "update".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: Some("c1".to_string()),
                    component: None,
                    patch: Some(serde_json::json!({
                        "props": {"label": "继续", "disabled": true},
                        "style": {"radius": "4px"},
                        "events": {"onClick": {"action": "navigate", "target": "page-1"}},
                        "x": 24
                    })),
                    remove_keys: Some(
                        [
                            ("props".to_string(), vec!["variant".to_string()]),
                            ("style".to_string(), vec!["bg".to_string()]),
                            ("events".to_string(), vec!["onChange".to_string()]),
                        ]
                        .into_iter()
                        .collect(),
                    ),
                    x: None,
                    y: None,
                    name: None,
                    page: None,
                }],
                "改文案并删除废弃字段",
            )
        })
        .expect("patch");
    assert_eq!(patched.version, 2, "一次 Patch 只产生一个版本");

    let parsed: serde_json::Value = serde_json::from_str(&patched.source_content).expect("JSON");
    let comp = &parsed["pages"][0]["components"][0];
    assert_eq!(comp["props"]["label"], "继续");
    assert_eq!(comp["props"]["disabled"], true);
    assert!(comp["props"].get("variant").is_none(), "props 字段必须可删除");
    assert!(comp["style"].get("bg").is_none(), "style 字段必须可删除");
    assert_eq!(comp["style"]["radius"], "4px");
    assert_eq!(comp["style"]["fontSize"], "13px", "未提及的字段保持原值");
    assert!(comp["events"].get("onChange").is_none(), "events 字段必须可删除");
    assert_eq!(comp["events"]["onClick"]["target"], "page-1");
    assert_eq!(comp["x"], 24.0);

    // style 操作同样支持删除；removeKeys 携带其它段名必须被拒绝。
    let styled = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                patched.revision,
                &[PatchOp {
                    op: "style".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: Some("c1".to_string()),
                    component: None,
                    patch: Some(serde_json::json!({"fontSize": "15px"})),
                    remove_keys: Some(
                        [("style".to_string(), vec!["radius".to_string()])]
                            .into_iter()
                            .collect(),
                    ),
                    x: None,
                    y: None,
                    name: None,
                    page: None,
                }],
                "调整字号",
            )
        })
        .expect("style patch");
    let parsed: serde_json::Value = serde_json::from_str(&styled.source_content).expect("JSON");
    let comp = &parsed["pages"][0]["components"][0];
    assert_eq!(comp["style"]["fontSize"], "15px");
    assert!(comp["style"].get("radius").is_none());

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                styled.revision,
                &[PatchOp {
                    op: "style".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: Some("c1".to_string()),
                    component: None,
                    patch: Some(serde_json::json!({"radius": "2px"})),
                    remove_keys: Some(
                        [("events".to_string(), vec!["onClick".to_string()])]
                            .into_iter()
                            .collect(),
                    ),
                    x: None,
                    y: None,
                    name: None,
                    page: None,
                }],
                "非法组合",
            )
        })
        .expect_err("style 操作不得删除 events");
    assert!(matches!(err, AppError::Validation(_)));

    // 删除不存在的键是幂等空操作：请求成功，但内容没变 → 不产生新版本。
    let noop = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                styled.revision,
                &[PatchOp {
                    op: "update".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: Some("c1".to_string()),
                    component: None,
                    patch: None,
                    remove_keys: Some(
                        [("props".to_string(), vec!["不存在".to_string()])]
                            .into_iter()
                            .collect(),
                    ),
                    x: None,
                    y: None,
                    name: None,
                    page: None,
                }],
                "幂等删除",
            )
        })
        .expect("幂等删除不应失败");
    assert_eq!(
        noop.version, styled.version,
        "没有实际变化的 Patch 不得生成版本"
    );
}

#[test]
fn prototype_patch_rejects_type_change_and_conflicts() {
    let db = setup();
    let ui = Actor::ui();
    let content = serde_json::json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [{"id":"page-1","name":"首页","components":[
            {"id":"c1","type":"button","x":10,"y":10,"w":120,"h":40,
             "props":{"label":"确定"},"style":{},"events":{}}
        ]}],
        "state": {}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "类型保护".to_string(),
                    description: String::new(),
                    kind: "prototype".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("原型");

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                doc.revision,
                &[PatchOp {
                    op: "update".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: Some("c1".to_string()),
                    component: None,
                    patch: Some(serde_json::json!({"type": "text"})),
                    remove_keys: None,
                    x: None,
                    y: None,
                    name: None,
                    page: None,
                }],
                "改类型",
            )
        })
        .expect_err("不允许通过 patch 改类型");
    assert!(matches!(err, AppError::Validation(_)));

    // 中途失败：前一个合法操作也不得落库。
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                doc.revision,
                &[
                    PatchOp {
                        op: "update".to_string(),
                        page_id: Some("page-1".to_string()),
                        component_id: Some("c1".to_string()),
                        component: None,
                        patch: Some(serde_json::json!({"props": {"label": "已改"}})),
                        remove_keys: None,
                        x: None,
                        y: None,
                        name: None,
                        page: None,
                    },
                    PatchOp {
                        op: "remove".to_string(),
                        page_id: Some("page-1".to_string()),
                        component_id: Some("missing".to_string()),
                        component: None,
                        patch: None,
                        remove_keys: None,
                        x: None,
                        y: None,
                        name: None,
                        page: None,
                    },
                ],
                "中途失败",
            )
        })
        .expect_err("中途失败必须整体回滚");
    assert!(matches!(err, AppError::NotFound(_)));
    let unchanged = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc.id))
        .expect("读取");
    assert_eq!(unchanged.version, 1);
    assert!(unchanged.source_content.contains("确定"));

    // revision 冲突：旧 revision 不得覆盖新版本。
    let updated = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                doc.revision,
                &[PatchOp {
                    op: "page_rename".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: None,
                    component: None,
                    patch: None,
                    remove_keys: None,
                    x: None,
                    y: None,
                    name: Some("改过的首页".to_string()),
                    page: None,
                }],
                "改名",
            )
        })
        .expect("改名");
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).apply_prototype_patch(
                &ui,
                &doc.id,
                doc.revision,
                &[PatchOp {
                    op: "page_rename".to_string(),
                    page_id: Some("page-1".to_string()),
                    component_id: None,
                    component: None,
                    patch: None,
                    remove_keys: None,
                    x: None,
                    y: None,
                    name: Some("并发覆盖".to_string()),
                    page: None,
                }],
                "并发改名",
            )
        })
        .expect_err("旧 revision 必须冲突");
    assert!(matches!(err, AppError::Conflict(_)));
    let current = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc.id))
        .expect("读取");
    assert_eq!(current.version, updated.version);
    assert!(current.source_content.contains("改过的首页"));
}

#[test]
fn mcp_patch_tool_matches_backend_capabilities() {
    let db = Arc::new(setup());
    let row = mcp_row("mcp-patch", McpScope::ProjectRw);
    insert_agent(&db, &row, true);
    let ctx = ToolCtx {
        db: db.clone(),
        agent: row,
        emit: Arc::new(|_| {}),
    };

    // schema 必须声明后端真正支持的页面级操作与字段删除。
    let defs = super::mcp_tools::definitions_for_registry();
    let def = defs
        .iter()
        .find(|d| d.name == "taskdock_collab_patch_prototype")
        .expect("patch 工具存在");
    let ops = def.input_schema["properties"]["ops"]["items"]["properties"]["op"]["enum"]
        .as_array()
        .expect("op enum");
    let ops: Vec<&str> = ops.iter().filter_map(|v| v.as_str()).collect();
    for expected in [
        "add", "update", "remove", "move", "style", "events", "page_add", "page_remove",
        "page_rename",
    ] {
        assert!(ops.contains(&expected), "MCP schema 缺少操作：{expected}");
    }
    assert!(def.input_schema["properties"]["ops"]["items"]["properties"]
        .get("removeKeys")
        .is_some());
    assert!(def.input_schema["properties"]["ops"]["items"]["properties"]
        .get("page")
        .is_some());

    let content = serde_json::json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [{"id":"page-1","name":"首页","components":[
            {"id":"c1","type":"text","x":10,"y":10,"w":120,"h":40,
             "props":{"text":"旧文案"},"style":{"bg":"#fff"},"events":{}}
        ]}],
        "state": {}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &Actor::ui(),
                PROJECT,
                &VisualInput {
                    title: "MCP 原型".to_string(),
                    description: String::new(),
                    kind: "prototype".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("原型");

    let call = |args: serde_json::Value| {
        db.with_transaction(|conn| {
            super::mcp_tools::call(&ctx, "taskdock_collab_patch_prototype", &args, Some(conn))
                .expect("collab 接管")
                .map_err(|e| match e {
                    crate::mcp::tools::ToolError::Authz(msg) => AppError::Forbidden(msg),
                    crate::mcp::tools::ToolError::Failed(err) => err,
                })
        })
    };

    // 旧版调用方式（仅 add/update）必须继续可用。
    let first = call(serde_json::json!({
        "document_id": doc.id,
        "expected_revision": doc.revision,
        "ops": [{
            "op": "update",
            "pageId": "page-1",
            "componentId": "c1",
            "patch": {"props": {"text": "新文案"}}
        }]
    }))
    .expect("旧版 update");
    assert_eq!(first.value["version"], 2);

    // 页面级 + removeKeys 必须由 MCP 真正执行，而不是被 schema 拒绝。
    let second = call(serde_json::json!({
        "document_id": doc.id,
        "expected_revision": first.value["revision"],
        "ops": [
            {"op": "page_add", "name": "第二页"},
            {
                "op": "update",
                "pageId": "page-1",
                "componentId": "c1",
                "removeKeys": {"style": ["bg"]}
            },
            {"op": "page_rename", "pageId": "page-1", "name": "首页改名"}
        ]
    }))
    .expect("页面级 Patch");
    let parsed: serde_json::Value =
        serde_json::from_str(second.value["sourceContent"].as_str().expect("内容")).expect("JSON");
    assert_eq!(parsed["pages"].as_array().expect("pages").len(), 2);
    assert_eq!(parsed["pages"][0]["name"], "首页改名");
    assert!(parsed["pages"][0]["components"][0]["style"]
        .get("bg")
        .is_none());

    let removed = call(serde_json::json!({
        "document_id": doc.id,
        "expected_revision": second.value["revision"],
        "ops": [{"op": "page_remove", "pageId": "page-1"}]
    }))
    .expect("页面删除");
    let parsed: serde_json::Value =
        serde_json::from_str(removed.value["sourceContent"].as_str().expect("内容")).expect("JSON");
    assert_eq!(parsed["pages"].as_array().expect("pages").len(), 1);
}

#[test]
fn visual_update_without_content_change_does_not_create_version() {
    let db = setup();
    let ui = Actor::ui();
    let content = serde_json::json!({
        "nodes": [
            {"id":"n1","label":"开始","kind":"start","x":40,"y":40,"config":{}},
            {"id":"n2","label":"结束","kind":"end","x":240,"y":40,"config":{}}
        ],
        "edges": [{"id":"e1","from":"n1","to":"n2","label":""}],
        "layout": {"direction":"LR","width":600,"height":320}
    });
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "空保存图表".to_string(),
                    description: String::new(),
                    kind: "flowchart".to_string(),
                    source_format: "json".to_string(),
                    source_content: content.to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("图表");

    // 与当前内容完全一致的保存：不写库、不产生版本。
    let same = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                doc.revision,
                &VisualPatch {
                    title: Some(doc.title.clone()),
                    source_content: Some(doc.source_content.clone()),
                    source_format: Some("json".to_string()),
                    ..Default::default()
                },
                "无修改保存",
            )
        })
        .expect("空保存");
    assert_eq!(same.version, doc.version, "空保存不得生成版本");
    assert_eq!(same.revision, doc.revision, "空保存不得推进 revision");
    let versions = db
        .with_conn(|conn| Core::new(conn).visual_versions(&ui, &doc.id, None, None))
        .expect("版本列表");
    assert_eq!(versions.total, 1, "只应有创建时的 v1");

    // 过期 revision 即使内容相同也必须 CONFLICT，不能被“空操作”掩盖。
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                doc.revision + 9,
                &VisualPatch {
                    source_content: Some(doc.source_content.clone()),
                    ..Default::default()
                },
                "过期 revision",
            )
        })
        .expect_err("过期 revision 必须冲突");
    assert!(matches!(err, AppError::Conflict(_)), "实际：{err}");
}

#[test]
fn authoring_mode_tracks_ai_and_manual_edits() {
    let db = setup();
    let ui = Actor::ui();
    let job = db
        .with_transaction(|conn| {
            Core::new(conn).generate_visual(
                &ui,
                PROJECT,
                None,
                None,
                "flowchart",
                "提交需求 -> 审阅方案 -> 批准 -> 生成任务",
            )
        })
        .expect("AI 生成");
    let doc_id = job.document_id.clone().expect("document id");
    let doc = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc_id))
        .expect("文档");
    assert_eq!(doc.authoring_mode, "ai_generated");
    let content: serde_json::Value = serde_json::from_str(&doc.source_content).expect("JSON");
    let labels: Vec<&str> = content["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .filter_map(|n| n.get("label").and_then(|v| v.as_str()))
        .collect();
    assert!(labels.contains(&"审阅方案"), "用户指令必须进入生成结果：{labels:?}");

    let versions = db
        .with_conn(|conn| Core::new(conn).visual_versions(&ui, &doc_id, Some(1), Some(10)))
        .expect("版本");
    assert_eq!(versions.items[0].authoring_mode, "ai_generated");

    // 人工修改 AI 内容：文档升级为混合创作，本次版本记录 manual。
    let edited = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc_id,
                doc.revision,
                &VisualPatch {
                    title: Some("人工改标题".to_string()),
                    ..Default::default()
                },
                "人工修改",
            )
        })
        .expect("人工修改");
    assert_eq!(edited.authoring_mode, "ai_assisted");
    let versions = db
        .with_conn(|conn| Core::new(conn).visual_versions(&ui, &doc_id, Some(1), Some(10)))
        .expect("版本");
    assert_eq!(versions.items[0].authoring_mode, "manual");

    // AI 修改提案：只返回候选，不生成版本；确认后应用才生成新版本。
    let proposal = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc_id,
                None,
                "复核 -> 归档",
                &[],
            )
        })
        .expect("AI 提案");
    let after_proposal = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc_id))
        .expect("文档");
    assert_eq!(after_proposal.version, edited.version, "提案不得直接落库");
    assert_eq!(proposal.base_revision, edited.revision);
    let applied = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc_id,
                proposal.base_revision,
                &VisualPatch {
                    source_content: Some(proposal.proposed_content.clone()),
                    authoring_mode: Some("ai_assisted".to_string()),
                    ..Default::default()
                },
                &proposal.summary,
            )
        })
        .expect("应用提案");
    assert_eq!(applied.version, edited.version + 1);
    assert_eq!(applied.authoring_mode, "ai_assisted");
}

#[test]
fn visual_assets_are_scoped_deduped_and_readable() {
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("taskdock-collab-assets-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    std::env::set_var("TASK_DOCK_DATA_DIR", &dir);

    let db = setup();
    let ui = Actor::ui();
    let src = dir.join("shot.png");
    std::fs::write(&src, b"fake-png-bytes").expect("写入图片");

    let first = db
        .with_transaction(|conn| {
            Core::new(conn).import_visual_asset(
                &ui,
                PROJECT,
                &VisualAssetInput {
                    path: src.to_string_lossy().to_string(),
                    title: "截图".to_string(),
                    document_id: None,
                },
            )
        })
        .expect("导入");
    assert_eq!(first.mime, "image/png");
    assert_eq!(first.status, "active");
    let again = db
        .with_transaction(|conn| {
            Core::new(conn).import_visual_asset(
                &ui,
                PROJECT,
                &VisualAssetInput {
                    path: src.to_string_lossy().to_string(),
                    title: "重复".to_string(),
                    document_id: None,
                },
            )
        })
        .expect("去重");
    assert_eq!(first.id, again.id, "同项目同 sha256 必须去重");

    let content = db
        .with_conn(|conn| Core::new(conn).read_visual_asset(&ui, &first.id))
        .expect("受控读取");
    assert_eq!(content.mime, "image/png");
    assert!(!content.base64.is_empty());

    let bad = dir.join("evil.exe");
    std::fs::write(&bad, b"x").expect("写入非法文件");
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).import_visual_asset(
                &ui,
                PROJECT,
                &VisualAssetInput {
                    path: bad.to_string_lossy().to_string(),
                    title: String::new(),
                    document_id: None,
                },
            )
        })
        .expect_err("扩展名白名单必须拒绝");
    assert!(matches!(err, AppError::Validation(_)));

    let archived = db
        .with_transaction(|conn| Core::new(conn).archive_visual_asset(&ui, &first.id))
        .expect("归档");
    assert_eq!(archived.status, "archived");
    std::env::remove_var("TASK_DOCK_DATA_DIR");
    let _ = std::fs::remove_dir_all(&dir);
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
    assert_eq!(names.len(), 27, "MCP 工具数量必须稳定");
    assert!(names.contains(&"taskdock_collab_create_issue"));
    assert!(names.contains(&"taskdock_collab_create_bug"));
    assert!(names.contains(&"taskdock_collab_create_visualization"));
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

    // Agent 通用结构化创建：与 UI/AI 共用 Core，来源记为 agent_authored。
    let graph = serde_json::json!({
        "nodes": [
            {"id":"a","label":"入口","kind":"start","x":40,"y":40,"config":{}},
            {"id":"b","label":"出口","kind":"end","x":280,"y":40,"config":{}}
        ],
        "edges": [{"id":"e1","from":"a","to":"b","label":""}],
        "layout": {"direction":"LR","width":600,"height":320}
    });
    let created_visual = db
        .with_transaction(|conn| {
            super::mcp_tools::call(
                &ctx,
                "taskdock_collab_create_visualization",
                &serde_json::json!({
                    "project_id": PROJECT,
                    "kind": "flowchart",
                    "title": "Agent 提交的流程图",
                    "source_format": "json",
                    "source_content": graph.to_string()
                }),
                Some(conn),
            )
            .expect("工具必须由 collab 接管")
                .map_err(|e| match e {
                    crate::mcp::tools::ToolError::Authz(msg) => AppError::Forbidden(msg),
                    crate::mcp::tools::ToolError::Failed(err) => err,
                })
        })
        .expect("Agent 创建可视化");
    assert_eq!(created_visual.value["authoringMode"], "agent_authored");
    assert_eq!(created_visual.value["version"], 1);
}

#[test]
fn managed_project_mcp_lifecycle_requires_human_review_and_finished_handoff() {
    use crate::mcp::tools::run_tool_call;
    use serde_json::{json, Value};

    fn call(ctx: &ToolCtx, name: &str, args: Value) -> Result<Value, String> {
        let out = run_tool_call(ctx, name, &args).map_err(|e| e.message)?;
        let text = out["content"][0]["text"].as_str().expect("MCP text");
        if out["isError"] == true {
            Err(text.to_owned())
        } else {
            Ok(serde_json::from_str(text).expect("MCP JSON"))
        }
    }

    let db = Arc::new(Db::open_in_memory().expect("isolated database"));
    let make_agent = |id| {
        let agent = mcp_row(id, McpScope::ProjectRw);
        insert_agent(&db, &agent, false);
        for cap in ["projects.read", "projects.create", "projects.write", "tasks.read",
                    "tasks.write", "handoffs.read", "handoffs.write"] {
            crate::mcp::permissions::grant(&db, &agent.row_id, cap, "").expect("capability");
        }
        ToolCtx { db: db.clone(), agent, emit: Arc::new(|_| {}) }
    };
    let sender = make_agent("owner");
    let recipient = make_agent("recipient");
    let project = call(&sender, "taskdock_create_project", json!({
        "name": "Managed project", "requestId": "project-1"
    })).unwrap();
    let root = project["projectId"].as_str().unwrap();
    let plan_id = project["activePlanId"].as_str().unwrap();
    assert_ne!(root, plan_id);
    let close_args = json!({ "project_id": root });
    assert!(call(&recipient, "taskdock_get_project_closeout", close_args.clone()).is_err());

    let milestone = call(&sender, "taskdock_save_milestone", json!({
        "plan_id": plan_id, "name": "Milestone", "requestId": "milestone-1"
    })).unwrap();
    let edit = json!({
        "plan_id": plan_id, "milestone_id": milestone["id"], "name": "Updated",
        "expected_revision": milestone["revision"]
    });
    assert!(call(&sender, "taskdock_save_milestone", edit.clone()).is_ok());
    assert!(call(&sender, "taskdock_save_milestone", edit).is_err());

    let issue = call(&sender, "taskdock_collab_create_issue", json!({
        "project_id": plan_id, "kind": "feature", "title": "Managed requirement",
        "description": "Implement and verify"
    })).unwrap();
    let issue_id = issue["issue"]["id"].as_str().unwrap();
    let plan = call(&sender, "taskdock_collab_create_plan", json!({ "issue_id": issue_id })).unwrap();
    let scheme = plan["id"].as_str().unwrap();
    let submitted = call(&sender, "taskdock_collab_submit_plan", json!({
        "plan_id": scheme, "expected_revision": plan["revision"]
    })).unwrap();

    let split = || call(&sender, "taskdock_collab_create_tasks_from_plan", json!({ "plan_id": scheme }));
    assert!(split().is_err());
    let ui = Actor::ui();
    let human_review = |revision, decision, note| db.with_transaction(|conn| {
        Core::new(conn).review_plan(&ui, scheme, revision, decision, note)
    }).unwrap();
    let returned = human_review(
        submitted["revision"].as_i64().unwrap(), "request_changes", Some("Refine"),
    );
    let submitted = call(&sender, "taskdock_collab_submit_plan", json!({
        "plan_id": scheme, "expected_revision": returned.revision
    })).unwrap();
    human_review(submitted["revision"].as_i64().unwrap(), "approve", None);
    let generated = split().unwrap();
    assert_eq!(split().unwrap()["created"], json!([]));

    let tasks = call(&sender, "taskdock_list_tasks", json!({ "project_id": root })).unwrap();
    let tasks = tasks["items"].as_array().unwrap();
    assert!(!tasks.is_empty());
    assert!(tasks.iter().all(|task| generated["created"].as_array().unwrap().contains(&task["id"])));
    let request_acceptance = || call(&sender, "taskdock_collab_submit_plan", json!({
        "plan_id": scheme, "expected_revision": generated["plan"]["revision"], "stage": "acceptance"
    }));
    assert!(request_acceptance().is_err());
    for task in tasks {
        call(&sender, "taskdock_complete_task", json!({
            "task_id": task["id"], "expected_revision": task["revision"]
        })).unwrap();
    }
    let accepting = request_acceptance().unwrap();
    let accepted = PlanPatch { status: Some("completed".into()), ..Default::default() };
    let accepting_revision = accepting["revision"].as_i64().unwrap();
    let external = Actor::agent(&sender.agent, "mcp");
    assert!(db.with_transaction(|conn| {
        Core::new(conn).update_plan(&external, scheme, accepting_revision, &accepted)
    }).is_err());
    let returned = human_review(accepting_revision, "request_changes", Some("Add verification"));
    assert_eq!(returned.status, "developing");
    assert_eq!(returned.review_note, "Add verification");
    let resubmitted = call(&sender, "taskdock_collab_submit_plan", json!({
        "plan_id": scheme, "expected_revision": returned.revision, "stage": "acceptance"
    })).unwrap();
    let accepted = human_review(resubmitted["revision"].as_i64().unwrap(), "approve", None);
    assert_eq!(accepted.status, "completed");
    call(&sender, "taskdock_collab_update_issue", json!({
        "issue_id": issue_id, "expected_revision": issue["issue"]["revision"], "status": "resolved"
    })).unwrap();

    crate::mcp::auth::grant_project(&db, &recipient.agent.row_id, root).unwrap();
    let handoff = call(&sender, "taskdock_create_handoff", json!({
        "project_id": root, "to_agent_id": recipient.agent.agent_id, "summary": "Ready to hand over"
    })).unwrap();
    let id = handoff["handoff"]["id"].as_str().unwrap();
    let status = call(&sender, "taskdock_get_project_closeout", close_args.clone()).unwrap();
    assert_eq!(status["pending_handoffs"], 1);
    assert_eq!(status["ready"], false);
    let close = || call(&sender, "taskdock_close_project", json!({
        "project_id": root, "expected_revision": status["revision"], "requestId": "close"
    }));
    assert!(close().is_err());
    let accept_args = json!({ "handoff_id": id, "base_revision": handoff["revision"], "action": "accept" });
    assert!(call(&sender, "taskdock_transition_handoff", accept_args.clone()).is_err());
    let handoff = call(&recipient, "taskdock_transition_handoff", accept_args).unwrap();
    call(&recipient, "taskdock_submit_work_report", json!({
        "handoff_id": id, "summary": "Release evidence", "result": "completed"
    })).unwrap();
    let reports = call(&sender, "taskdock_list_work_reports", json!({ "handoff_id": id })).unwrap();
    assert_eq!(reports["items"].as_array().unwrap().len(), 1);
    call(&recipient, "taskdock_transition_handoff", json!({
        "handoff_id": id, "base_revision": handoff["revision"], "action": "complete"
    })).unwrap();
    let archived = close().unwrap();
    assert_eq!(archived["status"], "archived");
    assert_eq!(close().unwrap()["revision"], archived["revision"]);
    let reopened = call(&sender, "taskdock_update_project", json!({
        "project_id": root, "expected_revision": archived["revision"], "lifecycle_status": "active"
    })).unwrap();
    assert_eq!(reopened["status"], "active");
}
