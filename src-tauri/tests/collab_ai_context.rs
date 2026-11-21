//! AI 修改上下文集成测试（独立文件）：
//! - 原型 AI 修改必须按 pageId 定位，不静默回退第一页；
//! - selection 必须属于目标页面，否则明确报错；
//! - 提案保留 baseRevision，应用时版本变化必须 CONFLICT；
//! - 未配置模型时明确标记为规则生成。

use std::sync::Once;

use rusqlite::Connection;

use task_dock_lib::collab::actor::Actor;
use task_dock_lib::collab::model::*;
use task_dock_lib::collab::service::Core;
use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;

const PROJECT: &str = "proj-ai-context";

static ENV_INIT: Once = Once::new();

fn isolate_data_dir() {
    ENV_INIT.call_once(|| {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-collab-ai-context-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("临时数据目录");
        std::env::set_var("TASK_DOCK_DATA_DIR", dir);
    });
}

fn setup() -> Db {
    isolate_data_dir();
    let db = Db::open_in_memory().expect("内存库");
    db.with_transaction(|conn: &Connection| {
        conn.execute(
            "INSERT INTO planning_projects (id, name, description, status, created_at, updated_at)
             VALUES (?1, 'AI 上下文测试', '测试', 'planning', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![PROJECT],
        )?;
        Ok(())
    })
    .expect("项目");
    db
}

fn create_two_page_prototype(db: &Db) -> VisualDocument {
    let content = serde_json::json!({
        "schemaVersion": 1,
        "viewport": {"width": 400, "height": 640},
        "pages": [
            {"id":"page-1","name":"首页","components":[
                {"id":"c1","type":"text","x":10,"y":10,"w":200,"h":40,
                 "props":{"text":"首页说明"},"style":{},"events":{}}
            ]},
            {"id":"page-2","name":"第二页","components":[
                {"id":"c2","type":"button","x":10,"y":10,"w":120,"h":40,
                 "props":{"label":"下一步"},"style":{},"events":{}}
            ]}
        ],
        "state": {}
    });
    db.with_transaction(|conn| {
        Core::new(conn).create_visual(
            &Actor::ui(),
            PROJECT,
            &VisualInput {
                title: "两页原型".to_string(),
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
    .expect("原型")
}

#[test]
fn ai_modify_uses_the_requested_page_only() {
    let db = setup();
    let ui = Actor::ui();
    let doc = create_two_page_prototype(&db);

    let proposal = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc.id,
                Some("page-2"),
                "补充一句说明",
                &["c2".to_string()],
            )
        })
        .expect("提案");

    assert_eq!(proposal.base_revision, doc.revision);
    let content: serde_json::Value =
        serde_json::from_str(&proposal.proposed_content).expect("JSON");
    let pages = content["pages"].as_array().expect("pages");
    assert_eq!(pages[0]["components"].as_array().expect("第一页").len(), 1);
    assert_eq!(pages[1]["components"].as_array().expect("第二页").len(), 2);
    let added = &pages[1]["components"][1];
    assert_eq!(added["props"]["text"], "补充一句说明");
    assert!(
        added["y"].as_f64().unwrap_or(0.0) >= 50.0,
        "新组件应位于选中组件下方：{added}"
    );

    // 提案不落库：文档版本与内容不变。
    let unchanged = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc.id))
        .expect("读取");
    assert_eq!(unchanged.version, doc.version);
    assert_eq!(unchanged.revision, doc.revision);

    // 提案记录里带 pageId 与生成方式，便于审计区分规则生成。
    let params: serde_json::Value =
        serde_json::from_str(&proposal.job.params_json).expect("params");
    assert_eq!(params["pageId"], "page-2");
    assert_eq!(params["baseRevision"], doc.revision);
    assert_eq!(params["generator"], "local-structured-rules");
    assert_eq!(proposal.job.provider, "local-structured");
}

#[test]
fn ai_modify_never_falls_back_to_first_page_or_last_component() {
    let db = setup();
    let ui = Actor::ui();
    let doc = create_two_page_prototype(&db);

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc.id,
                None,
                "补充说明",
                &[],
            )
        })
        .expect_err("缺少 pageId 必须拒绝");
    assert!(matches!(err, AppError::Validation(_)), "实际：{err}");

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc.id,
                Some("page-404"),
                "补充说明",
                &[],
            )
        })
        .expect_err("页面不存在必须报错");
    assert!(matches!(err, AppError::NotFound(_)), "实际：{err}");

    // 选中组件属于第一页，但目标页是第二页 → 明确拒绝，绝不跨页修改。
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc.id,
                Some("page-2"),
                "补充说明",
                &["c1".to_string()],
            )
        })
        .expect_err("跨页 selection 必须拒绝");
    assert!(matches!(err, AppError::Validation(_)), "实际：{err}");

    // 图类型不接受 pageId，避免入口参数被静默忽略。
    let graph = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "流程图".to_string(),
                    description: String::new(),
                    kind: "flowchart".to_string(),
                    source_format: "json".to_string(),
                    source_content: serde_json::json!({
                        "nodes": [
                            {"id":"n1","label":"开始","kind":"start","x":40,"y":40,"config":{}},
                            {"id":"n2","label":"结束","kind":"end","x":240,"y":40,"config":{}}
                        ],
                        "edges": [{"id":"e1","from":"n1","to":"n2","label":""}],
                        "layout": {"direction":"LR","width":600,"height":320}
                    })
                    .to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("流程图");
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &graph.id,
                Some("page-1"),
                "补充说明",
                &[],
            )
        })
        .expect_err("图类型不接受 pageId");
    assert!(matches!(err, AppError::Validation(_)), "实际：{err}");
}

#[test]
fn ai_proposal_applies_with_base_revision_and_conflicts_after_change() {
    let db = setup();
    let ui = Actor::ui();
    let doc = create_two_page_prototype(&db);

    let proposal = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc.id,
                Some("page-2"),
                "补充一句说明",
                &[],
            )
        })
        .expect("提案");

    // 生成提案后，文档被另一个操作推进了一个版本。
    let edited = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                doc.revision,
                &VisualPatch {
                    title: Some("并发改标题".to_string()),
                    ..Default::default()
                },
                "并发修改",
            )
        })
        .expect("并发修改");
    assert_eq!(edited.revision, doc.revision + 1);

    // 用旧 baseRevision 应用提案 → CONFLICT，不得覆盖别人的修改。
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                proposal.base_revision,
                &VisualPatch {
                    source_content: Some(proposal.proposed_content.clone()),
                    authoring_mode: Some("ai_assisted".to_string()),
                    ai_job_id: Some(proposal.job.id.clone()),
                    ..Default::default()
                },
                &proposal.summary,
            )
        })
        .expect_err("版本变化必须冲突");
    assert!(matches!(err, AppError::Conflict(_)), "实际：{err}");

    // 重新生成后（baseRevision = 当前 revision）可以应用，并记录 AI Job。
    let fresh = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(
                &ui,
                &doc.id,
                Some("page-2"),
                "补充一句说明",
                &[],
            )
        })
        .expect("新提案");
    assert_eq!(fresh.base_revision, edited.revision);

    let applied = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &doc.id,
                fresh.base_revision,
                &VisualPatch {
                    source_content: Some(fresh.proposed_content.clone()),
                    authoring_mode: Some("ai_assisted".to_string()),
                    ai_job_id: Some(fresh.job.id.clone()),
                    ..Default::default()
                },
                &fresh.summary,
            )
        })
        .expect("应用提案");
    assert_eq!(applied.version, edited.version + 1);
    assert_eq!(applied.authoring_mode, "ai_assisted");
    let version = db
        .with_conn(|conn| Core::new(conn).visual_version(&ui, &doc.id, applied.version))
        .expect("版本快照");
    assert!(version.snapshot.contains(&fresh.job.id), "版本快照必须记录 AI Job");

    // 伪造/跨文档的 AI Job 不得被应用。
    let other = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "另一个原型".to_string(),
                    description: String::new(),
                    kind: "prototype".to_string(),
                    source_format: "json".to_string(),
                    source_content: doc.source_content.clone(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect("第二份文档");
    let err = db
        .with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui,
                &other.id,
                other.revision,
                &VisualPatch {
                    source_content: Some(fresh.proposed_content.clone()),
                    ai_job_id: Some(fresh.job.id.clone()),
                    ..Default::default()
                },
                "跨文档应用",
            )
        })
        .expect_err("跨文档 AI 提案必须拒绝");
    assert!(matches!(err, AppError::Validation(_)), "实际：{err}");
}

#[test]
fn ai_notice_states_rule_generation_not_a_model() {
    let db = setup();
    let notice = db
        .with_conn(|conn| Ok(Core::new(conn).ai_notice()))
        .expect("notice");
    assert_eq!(notice["textProvider"], "local-structured");
    assert_eq!(notice["textMode"], "local-structured");
    assert!(notice["notice"]
        .as_str()
        .unwrap_or_default()
        .contains("不是模型生成"));
    assert!(notice["imageProvider"].is_null(), "图像生成未配置供应商");
}
