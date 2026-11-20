//! 创作工作台集成测试（v85）。
//!
//! 独立于 `src-tauri/src/agent_access/tests_v82_import.rs`（并行任务在途、当前无法编译）：
//! 只链接公开的 `task_dock_lib`，验证图表坐标、原型页面 Patch 原子性、创作来源、
//! AI 修改提案不落库、图片资产导入/去重/受控读取/归档。

use std::sync::Once;
use std::sync::Arc;

use rusqlite::Connection;

use task_dock_lib::collab::actor::Actor;
use task_dock_lib::collab::model::*;
use task_dock_lib::collab::service::Core;
use task_dock_lib::db::Db;

const PROJECT: &str = "proj-workbench-test";

static ENV_INIT: Once = Once::new();

fn isolate_data_dir() {
    ENV_INIT.call_once(|| {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-collab-workbench-{}",
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
             VALUES (?1, '创作工作台测试', '测试', 'planning', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![PROJECT],
        )?;
        Ok(())
    })
    .expect("项目");
    db
}

fn graph_input(title: &str, content: serde_json::Value) -> VisualInput {
    VisualInput {
        title: title.to_string(),
        description: String::new(),
        kind: "flowchart".to_string(),
        source_format: "json".to_string(),
        source_content: content.to_string(),
        plan_id: None,
        preview_asset: None,
        authoring_mode: None,
    }
}

#[test]
fn graph_editor_preserves_positions_and_rejects_bad_coordinates() {
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
            Core::new(conn).create_visual(&ui, PROJECT, &graph_input("可编辑图", content))
        })
        .expect("创建图");
    let stored: serde_json::Value = serde_json::from_str(&doc.source_content).expect("JSON");
    assert_eq!(stored["nodes"][0]["x"], 120.0);
    assert_eq!(stored["nodes"][1]["y"], 260.0);
    assert_eq!(stored["nodes"][0]["color"], "#ff0000");
    assert_eq!(stored["layout"]["width"], 900.0);
    assert_eq!(doc.authoring_mode, "manual");

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
    assert!(matches!(err, task_dock_lib::error::AppError::Validation(_)));
}

#[test]
fn prototype_page_patch_is_atomic() {
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
    assert!(matches!(err, task_dock_lib::error::AppError::NotFound(_)));
    let unchanged = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc.id))
        .expect("读取");
    assert_eq!(unchanged.version, 2, "失败的批量 Patch 不得生成版本");
    let parsed: serde_json::Value = serde_json::from_str(&unchanged.source_content).expect("JSON");
    assert_eq!(parsed["pages"].as_array().expect("pages").len(), 2);
}

#[test]
fn authoring_mode_and_ai_proposal_require_confirmation() {
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

    let proposal = db
        .with_transaction(|conn| {
            Core::new(conn).propose_visual_modification(&ui, &doc_id, "复核 -> 归档", &[])
        })
        .expect("AI 提案");
    let after = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc_id))
        .expect("文档");
    assert_eq!(after.version, edited.version, "提案不得直接落库");
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
    let db = setup();
    let ui = Actor::ui();
    let dir = std::env::temp_dir().join(format!(
        "taskdock-collab-workbench-files-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("临时文件目录");
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
    assert!(matches!(err, task_dock_lib::error::AppError::Validation(_)));

    let archived = db
        .with_transaction(|conn| Core::new(conn).archive_visual_asset(&ui, &first.id))
        .expect("归档");
    assert_eq!(archived.status, "archived");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn all_public_visual_types_are_creatable_by_agent_style_input() {
    // 代表性覆盖：静态图与标注使用资产引用；diff 不允许创建。
    let db = setup();
    let ui = Actor::ui();
    let dir = std::env::temp_dir().join(format!(
        "taskdock-collab-workbench-types-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("临时目录");
    let image = dir.join("ui.png");
    std::fs::write(&image, b"png").expect("图片");
    let asset = db
        .with_transaction(|conn| {
            Core::new(conn).import_visual_asset(
                &ui,
                PROJECT,
                &VisualAssetInput {
                    path: image.to_string_lossy().to_string(),
                    title: "UI".to_string(),
                    document_id: None,
                },
            )
        })
        .expect("资产");
    let annotation = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "Bug 标注".to_string(),
                    description: String::new(),
                    kind: "bug_annotation".to_string(),
                    source_format: "json".to_string(),
                    source_content: serde_json::json!({
                        "assetId": asset.id,
                        "width": 1280,
                        "height": 720,
                        "annotations": [{
                            "shape":"rect","x":10,"y":10,"w":100,"h":60,
                            "note":"按钮错位","severity":"high"
                        }]
                    })
                    .to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: Some("imported".to_string()),
                },
            )
        })
        .expect("标注文档");
    assert_eq!(annotation.authoring_mode, "imported");
    assert_eq!(annotation.renderer, "image-annotation");

    let err = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &VisualInput {
                    title: "diff".to_string(),
                    description: String::new(),
                    kind: "diff".to_string(),
                    source_format: "json".to_string(),
                    source_content: "{}".to_string(),
                    plan_id: None,
                    preview_asset: None,
                    authoring_mode: None,
                },
            )
        })
        .expect_err("diff 不允许人工创建");
    assert!(matches!(err, task_dock_lib::error::AppError::Validation(_)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mcp_tool_registry_exposes_generic_visual_creation() {
    // 工具定义是公开的；这里只验证 schema 存在与数量，执行路径由库内测试覆盖。
    let defs = task_dock_lib::collab::mcp_tools::definitions_for_registry();
    let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
    assert_eq!(names.len(), 27);
    assert!(names.contains(&"taskdock_collab_create_visualization"));
    let tool = defs
        .iter()
        .find(|d| d.name == "taskdock_collab_create_visualization")
        .expect("工具存在");
    assert!(tool.write);
    let required = tool.input_schema["required"]
        .as_array()
        .expect("required");
    let required: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
    assert!(required.contains(&"project_id"));
    assert!(required.contains(&"kind"));
    assert!(required.contains(&"source_content"));
}

#[test]
fn concurrent_visual_updates_conflict_instead_of_overwriting() {
    let db = Arc::new(setup());
    let ui = Actor::ui();
    let doc = db
        .with_transaction(|conn| {
            Core::new(conn).create_visual(
                &ui,
                PROJECT,
                &graph_input(
                    "并发",
                    serde_json::json!({
                        "nodes":[{"id":"a","label":"开始","kind":"start","x":10,"y":10}],
                        "edges":[],
                        "layout":{"direction":"TB"}
                    }),
                ),
            )
        })
        .expect("创建");

    let db_a = db.clone();
    let db_b = db.clone();
    let doc_a = doc.clone();
    let doc_b = doc.clone();
    let ui_a = ui.clone();
    let ui_b = ui.clone();
    let a = std::thread::spawn(move || {
        db_a.with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui_a,
                &doc_a.id,
                doc_a.revision,
                &VisualPatch {
                    title: Some("A".to_string()),
                    ..Default::default()
                },
                "A",
            )
        })
    });
    let b = std::thread::spawn(move || {
        db_b.with_transaction(|conn| {
            Core::new(conn).update_visual(
                &ui_b,
                &doc_b.id,
                doc_b.revision,
                &VisualPatch {
                    title: Some("B".to_string()),
                    ..Default::default()
                },
                "B",
            )
        })
    });
    let ra = a.join().expect("A 线程");
    let rb = b.join().expect("B 线程");
    let ok = [&ra, &rb].iter().filter(|r| r.is_ok()).count();
    let conflict = [&ra, &rb]
        .iter()
        .filter(|r| matches!(r, Err(task_dock_lib::error::AppError::Conflict(_))))
        .count();
    assert_eq!(ok, 1, "必须恰好一个成功");
    assert_eq!(conflict, 1, "后写者必须得到 CONFLICT");
    let current = db
        .with_conn(|conn| Core::new(conn).get_visual(&ui, &doc.id))
        .expect("读取");
    assert_eq!(current.version, 2, "冲突不得生成额外版本");
}
