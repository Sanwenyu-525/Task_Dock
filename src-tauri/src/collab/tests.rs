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
