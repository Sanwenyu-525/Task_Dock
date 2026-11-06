//! store 层测试：CRUD、步骤校验、整表替换事务、运行记录、历史保留与异常退出恢复。

use super::*;
use crate::db::Db;
use crate::error::AppError;

fn temp_db(tag: &str) -> Db {
    let dir = std::env::temp_dir().join(format!("td-wf-store-{}-{}", tag, uuid::Uuid::new_v4()));
    Db::open(&dir.join("t.db")).expect("打开测试库失败")
}

/// 直接注入导航目标（绕过 save_target 的 exe 存在性校验，保持测试封闭）。
fn seed_target(db: &Db, id: &str, target_type: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO navigation_targets (id, display_name, target_type, app_key, created_at, updated_at)
             VALUES (?1, ?1, ?2, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            [id, target_type],
        )
        .map_err(AppError::from)
    })
    .unwrap();
}

fn seed_snapshot(db: &Db, id: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO workspace_snapshots (id, name, created_at, updated_at)
             VALUES (?1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            [id],
        )
        .map_err(AppError::from)
    })
    .unwrap();
}

fn step_input(step_type: &str, params_json: &str) -> StepInput {
    StepInput {
        id: uuid::Uuid::new_v4().to_string(),
        step_type: step_type.into(),
        params: serde_json::from_str(params_json).unwrap(),
        enabled: true,
        on_error: "stop".into(),
    }
}

fn wf_input(name: &str, steps: Vec<StepInput>) -> WorkflowInput {
    WorkflowInput {
        name: name.into(),
        description: String::new(),
        steps,
    }
}

fn scene_input(
    name: &str,
    linked_workflow_id: Option<String>,
) -> crate::commands::scenario::ScenarioSaveInput {
    crate::commands::scenario::ScenarioSaveInput {
        id: None,
        name: name.into(),
        icon: None,
        apps: vec![],
        urls: vec![],
        folders: vec![],
        shelf_item_ids: vec![],
        linked_workflow_id,
        snapshot_id: None,
    }
}

#[test]
fn create_get_list_and_update() {
    let db = temp_db("crud");
    seed_target(&db, "tgt-app", "application");
    let wf = create_workflow(
        &db,
        wf_input(
            "开发工作流",
            vec![step_input("open_app", r#"{"target_id":"tgt-app"}"#)],
        ),
    )
    .unwrap();
    assert_eq!(wf.name, "开发工作流");
    assert!(wf.enabled);
    assert_eq!(wf.step_count, 1);

    let (got, steps) = get_workflow(&db, &wf.id).unwrap();
    assert_eq!(got.id, wf.id);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].step_type, "open_app");
    assert_eq!(steps[0].params.target_id, "tgt-app");
    assert_eq!(steps[0].display_order, 0);

    let updated = update_workflow(
        &db,
        &wf.id,
        Some("改名".into()),
        Some("描述".into()),
        Some(false),
    )
    .unwrap();
    assert_eq!(updated.name, "改名");
    assert!(!updated.enabled);
    assert!(updated.last_run_at.is_none());
}

#[test]
fn create_rejects_invalid_name_and_steps() {
    let db = temp_db("invalid");
    assert!(create_workflow(&db, wf_input("  ", vec![])).is_err());
    assert!(create_workflow(&db, wf_input(&"x".repeat(61), vec![])).is_err());
    // 未知步骤类型
    let err = create_workflow(&db, wf_input("w", vec![step_input("shell", r#"{}"#)])).unwrap_err();
    assert!(err.to_string().contains("未知步骤类型"), "{}", err);
    // 目标不存在
    let err = create_workflow(
        &db,
        wf_input("w", vec![step_input("open_app", r#"{"target_id":"nope"}"#)]),
    )
    .unwrap_err();
    assert!(err.to_string().contains("导航目标不存在"), "{}", err);
}

#[test]
fn step_type_requires_matching_target_type() {
    let db = temp_db("target-type");
    seed_target(&db, "tgt-url", "url");
    seed_target(&db, "tgt-app", "application");
    // open_url 引用 application 目标 → 拒绝
    let err = create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input("open_url", r#"{"target_id":"tgt-app"}"#)],
        ),
    )
    .unwrap_err();
    assert!(err.to_string().contains("类型"), "{}", err);
    // open_path 接受 file 与 directory
    seed_target(&db, "tgt-file", "file");
    seed_target(&db, "tgt-dir", "directory");
    create_workflow(
        &db,
        wf_input(
            "w",
            vec![
                step_input("open_path", r#"{"target_id":"tgt-file"}"#),
                step_input("open_path", r#"{"target_id":"tgt-dir"}"#),
            ],
        ),
    )
    .unwrap();
}

#[test]
fn create_task_step_validation() {
    let db = temp_db("task-step");
    // 标题必填
    let err = create_workflow(
        &db,
        wf_input("w", vec![step_input("create_task", r#"{"title":"  "}"#)]),
    )
    .unwrap_err();
    assert!(err.to_string().contains("标题"), "{}", err);
    // 提醒时间格式
    let err = create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input(
                "create_task",
                r#"{"title":"t","remind_at":"not-a-date"}"#,
            )],
        ),
    )
    .unwrap_err();
    assert!(err.to_string().contains("提醒时间"), "{}", err);
    // 优先级范围
    let err = create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input("create_task", r#"{"title":"t","priority":9}"#)],
        ),
    )
    .unwrap_err();
    assert!(err.to_string().contains("优先级"), "{}", err);
    // 合法创建
    create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input(
                "create_task",
                r#"{"title":"写周报","priority":1,"remind_at":"2026-11-05T09:00:00Z","advance_minutes":10}"#,
            )],
        ),
    )
    .unwrap();
}

#[test]
fn enter_scene_requires_an_existing_scene() {
    let db = temp_db("scene");
    let err = create_workflow(
        &db,
        wf_input("w", vec![step_input("enter_scene", r#"{"scene_id":"s1"}"#)]),
    )
    .unwrap_err();
    assert!(err.to_string().contains("场景不存在"), "实际: {err}");
}

#[test]
fn enter_scene_accepts_existing_scene_and_keeps_its_real_id() {
    let db = temp_db("scene-real");
    let scene_id = crate::commands::scenario::save(&db, &scene_input("编辑场景", None)).unwrap();
    let wf = create_workflow(
        &db,
        wf_input(
            "进入场景",
            vec![step_input(
                "enter_scene",
                &format!(r#"{{"scene_id":"{scene_id}"}}"#),
            )],
        ),
    )
    .unwrap();
    let (_, steps) = get_workflow(&db, &wf.id).unwrap();
    assert_eq!(steps[0].params.scene_id, scene_id);
}

#[test]
fn scene_workflow_direct_and_indirect_cycles_are_rejected() {
    let db = temp_db("scene-cycle");
    let first = create_workflow(&db, wf_input("第一条", vec![])).unwrap();
    let scene =
        crate::commands::scenario::save(&db, &scene_input("关联第一条", Some(first.id.clone())))
            .unwrap();
    let direct = replace_steps(
        &db,
        &first.id,
        vec![step_input(
            "enter_scene",
            &format!(r#"{{"scene_id":"{scene}"}}"#),
        )],
    )
    .unwrap_err();
    assert!(
        direct.to_string().contains("循环引用"),
        "直接循环: {direct}"
    );

    let second = create_workflow(&db, wf_input("第二条", vec![])).unwrap();
    let first_scene =
        crate::commands::scenario::save(&db, &scene_input("第一层", Some(second.id.clone())))
            .unwrap();
    let second_scene =
        crate::commands::scenario::save(&db, &scene_input("第二层", Some(first.id.clone())))
            .unwrap();
    replace_steps(
        &db,
        &first.id,
        vec![step_input(
            "enter_scene",
            &format!(r#"{{"scene_id":"{first_scene}"}}"#),
        )],
    )
    .unwrap();
    let indirect = replace_steps(
        &db,
        &second.id,
        vec![step_input(
            "enter_scene",
            &format!(r#"{{"scene_id":"{second_scene}"}}"#),
        )],
    )
    .unwrap_err();
    assert!(
        indirect.to_string().contains("循环引用"),
        "间接循环: {indirect}"
    );
}

fn enter_scene_step(scene_id: &str) -> StepInput {
    step_input("enter_scene", &format!(r#"{{"scene_id":"{scene_id}"}}"#))
}

/// 嵌套层数口径（与 `workflows/mod.rs` 的 `validate_scene_flow_graph` 一致）：
/// 一层 = 一条「场景 → 场景关联工作流」边；工作流步骤「进入场景」不计层。
/// 该口径保证任一入口（直接进入场景 / 直接运行工作流）展开后都不超过三层关联工作流。
///
/// 这里同时锁住三条边界：
/// - 三层链允许；
/// - 以工作流为入口不额外计层（wf→scene 不算一层）；
/// - 第四条关联工作流边在保存场景时被拒绝。
#[test]
fn scene_workflow_nesting_is_bounded() {
    let db = temp_db("scene-depth");
    let wf = (0..5)
        .map(|i| create_workflow(&db, wf_input(&format!("层级 {i}"), vec![])).unwrap())
        .collect::<Vec<_>>();
    // 链：s1 → wf2 → s2 → wf3 → s3 → wf4
    let s3 = crate::commands::scenario::save(&db, &scene_input("层级 3", Some(wf[4].id.clone())))
        .unwrap();
    let s2 = crate::commands::scenario::save(&db, &scene_input("层级 2", Some(wf[3].id.clone())))
        .unwrap();
    let s1 = crate::commands::scenario::save(&db, &scene_input("层级 1", Some(wf[2].id.clone())))
        .unwrap();
    // s2 深度 2：s2→wf3→s3→wf4
    replace_steps(&db, &wf[3].id, vec![enter_scene_step(&s3)]).unwrap();
    // s1 深度 3：s1→wf2→s2→wf3→s3→wf4（三层边界允许）
    replace_steps(&db, &wf[2].id, vec![enter_scene_step(&s2)]).unwrap();
    // 工作流进入场景不计层：wf1 进入 s1 后仍是三层
    replace_steps(&db, &wf[1].id, vec![enter_scene_step(&s1)]).unwrap();

    // 第四条「场景 → 关联工作流」边：s0 → wf1 必须被拒绝（保存场景时校验）
    let over = crate::commands::scenario::save(&db, &scene_input("层级 0", Some(wf[1].id.clone())))
        .unwrap_err();
    assert!(
        over.to_string().contains("最大深度"),
        "第四层应被拒绝: {over}"
    );
}

/// 同一张图从另一侧闭合第四层时，保存工作流步骤也必须拒绝：
/// 先建 s0 → wf1（此时 wf1 无步骤，深度合法），再给 wf1 加「进入 s1」，
/// 等价于 s0→wf1→s1→wf2→s2→wf3→s3→wf4 四层，必须拒绝且不能落库。
#[test]
fn scene_workflow_depth_rejects_whichever_edge_closes_fourth_layer() {
    let db = temp_db("scene-depth-step-side");
    let wf = (0..5)
        .map(|i| create_workflow(&db, wf_input(&format!("侧向 {i}"), vec![])).unwrap())
        .collect::<Vec<_>>();
    let s3 = crate::commands::scenario::save(&db, &scene_input("侧向 3", Some(wf[4].id.clone())))
        .unwrap();
    let s2 = crate::commands::scenario::save(&db, &scene_input("侧向 2", Some(wf[3].id.clone())))
        .unwrap();
    let s1 = crate::commands::scenario::save(&db, &scene_input("侧向 1", Some(wf[2].id.clone())))
        .unwrap();
    replace_steps(&db, &wf[3].id, vec![enter_scene_step(&s3)]).unwrap();
    replace_steps(&db, &wf[2].id, vec![enter_scene_step(&s2)]).unwrap();
    // s0 → wf1 先落库（wf1 还没有步骤，一层，合法）
    let s0 = crate::commands::scenario::save(&db, &scene_input("侧向 0", Some(wf[1].id.clone())))
        .unwrap();

    let over = replace_steps(&db, &wf[1].id, vec![enter_scene_step(&s1)]).unwrap_err();
    assert!(
        over.to_string().contains("最大深度"),
        "工作流步骤侧闭合第四层应被拒绝: {over}"
    );
    // 失败不得留下步骤：wf1 仍为空
    assert!(list_steps(&db, &wf[1].id).unwrap().is_empty());

    // 删除最深场景后链变短，同一操作应恢复允许（无错误残留）
    crate::commands::scenario::delete(&db, &s3).unwrap();
    replace_steps(&db, &wf[1].id, vec![enter_scene_step(&s1)]).unwrap();
    assert_eq!(list_steps(&db, &wf[1].id).unwrap().len(), 1);
    // s0 仍在，且未因上一次失败被改写
    let after = crate::commands::scenario::get(&db, &s0).unwrap();
    assert_eq!(after.summary.linked_workflow_id.as_deref(), Some(wf[1].id.as_str()));
}

/// 运行前校验与保存校验共用同一函数：对历史/外部写入的超深图（绕过保存校验直插），
/// 引擎侧 `validate_scene_graph_for_workflow` 也必须拒绝，不能只在保存路径上拦。
#[test]
fn scene_workflow_depth_guard_also_covers_run_time_validation() {
    let db = temp_db("scene-depth-runtime");
    let wf = (0..5)
        .map(|i| create_workflow(&db, wf_input(&format!("运行 {i}"), vec![])).unwrap())
        .collect::<Vec<_>>();
    let s3 = crate::commands::scenario::save(&db, &scene_input("运行 3", Some(wf[4].id.clone())))
        .unwrap();
    let s2 = crate::commands::scenario::save(&db, &scene_input("运行 2", Some(wf[3].id.clone())))
        .unwrap();
    let s1 = crate::commands::scenario::save(&db, &scene_input("运行 1", Some(wf[2].id.clone())))
        .unwrap();
    replace_steps(&db, &wf[3].id, vec![enter_scene_step(&s3)]).unwrap();
    replace_steps(&db, &wf[2].id, vec![enter_scene_step(&s2)]).unwrap();
    replace_steps(&db, &wf[1].id, vec![enter_scene_step(&s1)]).unwrap();

    // 绕过保存校验直插历史四层边（模拟旧数据/外部写入）
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO scenarios (id, name, icon, apps_json, urls_json, folders_json,
                 linked_workflow_id, snapshot_id, created_at, updated_at)
             VALUES ('legacy-over-deep', '历史四层', NULL, '[]', '[]', '[]', ?1, NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [&wf[1].id],
        )
        .map_err(AppError::from)
    })
    .unwrap();

    // 运行前校验（engine 直接调用同一函数）必须拒绝
    let run_time = crate::workflows::validate_scene_graph_for_workflow(&db, &wf[1].id, &[s1.clone()])
        .unwrap_err();
    assert!(
        run_time.to_string().contains("最大深度"),
        "运行前校验应拒绝历史超深图: {run_time}"
    );
    // 保存侧同样拒绝
    let save_side =
        crate::commands::scenario::save(&db, &scene_input("再叠一层", Some(wf[1].id.clone())))
            .unwrap_err();
    assert!(save_side.to_string().contains("最大深度"));
}

/// 多入口共享子图：两个入口场景指向同一工作流，深度按各自路径独立计算，
/// 不得因为共享节点被重复累加或被误判为循环。
#[test]
fn scene_workflow_shared_subgraph_allows_multiple_entries() {
    let db = temp_db("scene-depth-shared");
    let hub = create_workflow(&db, wf_input("共享工作流", vec![])).unwrap();
    let tail = create_workflow(&db, wf_input("共享下游", vec![])).unwrap();
    let shared_scene =
        crate::commands::scenario::save(&db, &scene_input("共享场景", Some(tail.id.clone())))
            .unwrap();
    replace_steps(&db, &hub.id, vec![enter_scene_step(&shared_scene)]).unwrap();
    // 两个入口场景都指向 hub：入口 1 → hub → 共享场景 → tail = 2 层
    let entry_a =
        crate::commands::scenario::save(&db, &scene_input("入口 A", Some(hub.id.clone()))).unwrap();
    let entry_b =
        crate::commands::scenario::save(&db, &scene_input("入口 B", Some(hub.id.clone()))).unwrap();
    assert_ne!(entry_a, entry_b);
    // 两个入口的深度各自独立为 2，互不影响；再读回仍是两条独立场景
    for id in [&entry_a, &entry_b] {
        let detail = crate::commands::scenario::get(&db, id).unwrap();
        assert_eq!(detail.summary.linked_workflow_id.as_deref(), Some(hub.id.as_str()));
    }
    let listed = crate::commands::scenario::list(&db).unwrap();
    assert!(listed.len() >= 3, "共享子图不应合并入口场景");
}

#[test]
fn restore_workspace_requires_existing_snapshot() {
    let db = temp_db("restore-step");
    let err = create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input(
                "restore_workspace",
                r#"{"snapshot_id":"snap-x"}"#,
            )],
        ),
    )
    .unwrap_err();
    assert!(err.to_string().contains("快照不存在"), "{}", err);
    seed_snapshot(&db, "snap-1");
    create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input(
                "restore_workspace",
                r#"{"snapshot_id":"snap-1"}"#,
            )],
        ),
    )
    .unwrap();
}

#[test]
fn steps_over_limit_rejected() {
    let db = temp_db("limit");
    let steps: Vec<StepInput> = (0..51)
        .map(|i| step_input("create_task", &format!(r#"{{"title":"t{}"}}"#, i)))
        .collect();
    let err = create_workflow(&db, wf_input("w", steps)).unwrap_err();
    assert!(err.to_string().contains("上限"), "{}", err);
}

#[test]
fn replace_steps_is_atomic_and_reorders() {
    let db = temp_db("replace");
    let wf = create_workflow(&db, wf_input("w", vec![])).unwrap();
    // 先插入三步
    let s1 = step_input("create_task", r#"{"title":"a"}"#);
    let s2 = step_input("create_task", r#"{"title":"b"}"#);
    let s3 = step_input("create_task", r#"{"title":"c"}"#);
    replace_steps(&db, &wf.id, vec![s1.clone(), s2.clone(), s3.clone()]).unwrap();
    let steps = list_steps(&db, &wf.id).unwrap();
    assert_eq!(steps.len(), 3);
    let keep_id = steps[0].id.clone();

    // 删除第二步、倒序、保留第一步 ID：一次事务完成增删排序
    replace_steps(
        &db,
        &wf.id,
        vec![
            StepInput {
                id: keep_id.clone(),
                ..step_input("create_task", r#"{"title":"a2"}"#)
            },
            step_input("create_task", r#"{"title":"new"}"#),
        ],
    )
    .unwrap();
    let steps = list_steps(&db, &wf.id).unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].id, keep_id, "保留步骤的 ID 应稳定");
    assert_eq!(steps[0].params.title, "a2");
    assert_eq!(steps[0].display_order, 0);

    // 非法输入整体回滚：旧编排原样保留
    let before = list_steps(&db, &wf.id).unwrap();
    let err = replace_steps(
        &db,
        &wf.id,
        vec![
            step_input("create_task", r#"{"title":"ok"}"#),
            step_input("shell", r#"{}"#),
        ],
    )
    .unwrap_err();
    assert!(err.to_string().contains("未知步骤类型"));
    let after = list_steps(&db, &wf.id).unwrap();
    assert_eq!(
        before.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        after.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        "失败事务不得改动既有编排"
    );

    // 重复 ID 拒绝
    let dup_id = "dup-step-id".to_string();
    let mut a = step_input("create_task", r#"{"title":"x"}"#);
    a.id = dup_id.clone();
    let mut b = step_input("create_task", r#"{"title":"y"}"#);
    b.id = dup_id.clone();
    let err = replace_steps(&db, &wf.id, vec![a, b]).unwrap_err();
    assert!(err.to_string().contains("重复"), "{}", err);
}

#[test]
fn replace_steps_and_update_is_single_transaction() {
    let db = temp_db("save-atomic");
    let wf = create_workflow(
        &db,
        wf_input(
            "旧名称",
            vec![step_input("create_task", r#"{"title":"a"}"#)],
        ),
    )
    .unwrap();
    let before = list_steps(&db, &wf.id).unwrap();

    // 名称校验失败：步骤与名称都不得改动（编辑器分两步保存时曾出现步骤已落库）
    let err = replace_steps_and_update(
        &db,
        &wf.id,
        "   ".into(),
        "新描述".into(),
        vec![step_input("create_task", r#"{"title":"b"}"#)],
    )
    .unwrap_err();
    assert!(err.to_string().contains("不能为空"), "{}", err);
    let after = list_steps(&db, &wf.id).unwrap();
    assert_eq!(
        before.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        after.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        "名称失败时既有步骤必须原样保留"
    );
    assert_eq!(get_workflow(&db, &wf.id).unwrap().0.description, "");

    // 步骤校验失败：新名称也不得提前写入
    let err = replace_steps_and_update(
        &db,
        &wf.id,
        "新名称".into(),
        "新描述".into(),
        vec![step_input("shell", r#"{}"#)],
    )
    .unwrap_err();
    assert!(err.to_string().contains("未知步骤类型"), "{}", err);
    assert_eq!(get_workflow(&db, &wf.id).unwrap().0.name, "旧名称");

    // 成功路径：名称、描述、步骤一次提交
    let saved = replace_steps_and_update(
        &db,
        &wf.id,
        "新名称".into(),
        "新描述".into(),
        vec![step_input("create_task", r#"{"title":"b"}"#)],
    )
    .unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].params.title, "b");
    let (row, _) = get_workflow(&db, &wf.id).unwrap();
    assert_eq!(row.name, "新名称");
    assert_eq!(row.description, "新描述");
}

#[test]
fn duplicate_copies_definition_not_history() {
    let db = temp_db("dup");
    seed_target(&db, "tgt-url", "url");
    let wf = create_workflow(
        &db,
        wf_input(
            "原始",
            vec![step_input("open_url", r#"{"target_id":"tgt-url"}"#)],
        ),
    )
    .unwrap();
    let run = create_run(&db, &wf.id, "原始", &list_steps(&db, &wf.id).unwrap()).unwrap();
    finish_run(&db, &run.run_id, "completed", None).unwrap();

    let copy = duplicate_workflow(&db, &wf.id).unwrap();
    assert_ne!(copy.id, wf.id);
    assert!(copy.name.contains("副本"));
    assert_eq!(copy.step_count, 1);
    // 副本不继承运行历史与 last_run_at
    assert!(copy.last_run_at.is_none());
    assert_eq!(list_runs(&db, &copy.id, 10, 0).unwrap().total, 0);
}

#[test]
fn reorder_updates_sort_order_and_validates() {
    let db = temp_db("reorder");
    let a = create_workflow(&db, wf_input("A", vec![])).unwrap();
    let b = create_workflow(&db, wf_input("B", vec![])).unwrap();
    let c = create_workflow(&db, wf_input("C", vec![])).unwrap();
    reorder_workflows(&db, &[c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();
    let list = list_workflows(&db).unwrap();
    let expected = vec![c.id.clone(), a.id.clone(), b.id.clone()];
    assert_eq!(
        list.iter().map(|w| w.id.clone()).collect::<Vec<_>>(),
        expected
    );
    // 数量不符 / 不存在的 id / 重复 id → 拒绝
    assert!(reorder_workflows(&db, &[a.id.clone()]).is_err());
    assert!(reorder_workflows(&db, &[a.id.clone(), "nope".into(), b.id.clone()]).is_err());
    assert!(reorder_workflows(&db, &[a.id.clone(), a.id.clone(), b.id.clone()]).is_err());
}

#[test]
fn delete_workflow_cascades_definition_only_side() {
    let db = temp_db("delete");
    seed_target(&db, "tgt-app", "application");
    let wf = create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input("open_app", r#"{"target_id":"tgt-app"}"#)],
        ),
    )
    .unwrap();
    let steps = list_steps(&db, &wf.id).unwrap();
    let run = create_run(&db, &wf.id, "w", &steps).unwrap();
    delete_workflow(&db, &wf.id).unwrap();
    assert!(get_workflow(&db, &wf.id).is_err());
    // 运行记录随定义级联清理
    assert!(get_run(&db, &run.run_id).is_err());
    // 目标（navigation_targets）不属于工作流，不得被误删
    let targets: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM navigation_targets WHERE id = 'tgt-app'",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    assert_eq!(targets, 1, "删除工作流不得级联删除导航目标");
}

#[test]
fn run_records_lifecycle_pagination_and_prune() {
    let db = temp_db("runs");
    seed_target(&db, "tgt-url", "url");
    let wf = create_workflow(
        &db,
        wf_input(
            "w",
            vec![step_input("open_url", r#"{"target_id":"tgt-url"}"#)],
        ),
    )
    .unwrap();
    let steps = list_steps(&db, &wf.id).unwrap();

    // 三次运行
    let mut run_ids = Vec::new();
    for _ in 0..3 {
        let r = create_run(&db, &wf.id, "w", &steps).unwrap();
        run_ids.push(r.run_id.clone());
        finish_run(&db, &r.run_id, "completed", None).unwrap();
    }
    let wf_row = get_workflow(&db, &wf.id).unwrap().0;
    assert!(wf_row.last_run_at.is_some(), "运行应更新 last_run_at");

    // 最近一次运行
    let last = last_run(&db, &wf.id).unwrap().unwrap();
    assert_eq!(last.run.id, run_ids[2]);

    // 分页
    let page0 = list_runs(&db, &wf.id, 2, 0).unwrap();
    assert_eq!(page0.total, 3);
    assert_eq!(page0.items.len(), 2);
    assert_eq!(page0.items[0].id, run_ids[2], "新→旧");
    let page1 = list_runs(&db, &wf.id, 2, 2).unwrap();
    assert_eq!(page1.items.len(), 1);

    // 回执更新
    let detail = get_run(&db, &run_ids[0]).unwrap();
    let sid = &detail.steps[0].step_id;
    update_run_step(
        &db,
        &run_ids[0],
        sid,
        &RunStepUpdate {
            status: Some("succeeded".into()),
            detail: Some("完成".into()),
            result: Some(r#"{"summary":"完成"}"#.into()),
            started_at: Some(now_iso()),
            finished_at: Some(now_iso()),
            operation_id: Some("op-1".into()),
        },
    )
    .unwrap();
    let detail = get_run(&db, &run_ids[0]).unwrap();
    assert_eq!(detail.steps[0].status, "succeeded");
    assert_eq!(detail.steps[0].operation_id, "op-1");

    // 保留策略：只删运行记录，不删定义与步骤；同毫秒创建的运行按 rowid 决汰
    prune_runs(&db, &wf.id, 2).unwrap();
    let page = list_runs(&db, &wf.id, 10, 0).unwrap();
    assert_eq!(page.total, 2);
    assert!(get_workflow(&db, &wf.id).is_ok());
    assert_eq!(list_steps(&db, &wf.id).unwrap().len(), 1);
    assert!(get_run(&db, &run_ids[0]).is_err(), "最旧的运行应被淘汰");
    assert!(get_run(&db, &run_ids[1]).is_ok());
    assert!(get_run(&db, &run_ids[2]).is_ok());
}

#[test]
fn recover_stale_runs_marks_interrupted_without_replay() {
    let db = temp_db("recover");
    seed_target(&db, "tgt-app", "application");
    let wf = create_workflow(
        &db,
        wf_input(
            "w",
            vec![
                step_input("create_task", r#"{"title":"a"}"#),
                step_input("open_app", r#"{"target_id":"tgt-app"}"#),
                step_input("create_task", r#"{"title":"b"}"#),
            ],
        ),
    )
    .unwrap();
    let steps = list_steps(&db, &wf.id).unwrap();
    let run = create_run(&db, &wf.id, "w", &steps).unwrap();
    // 模拟异常退出时的中间态：第 1 步已成功，第 2 步 running，第 3 步 pending
    update_run_step(
        &db,
        &run.run_id,
        &steps[0].id,
        &RunStepUpdate {
            status: Some("succeeded".into()),
            detail: Some("完成".into()),
            result: None,
            started_at: Some(now_iso()),
            finished_at: Some(now_iso()),
            operation_id: Some("op-1".into()),
        },
    )
    .unwrap();
    update_run_step(
        &db,
        &run.run_id,
        &steps[1].id,
        &RunStepUpdate {
            status: Some("running".into()),
            detail: None,
            result: None,
            started_at: Some(now_iso()),
            finished_at: None,
            operation_id: Some("op-2".into()),
        },
    )
    .unwrap();

    let n = recover_stale_runs(&db).unwrap();
    assert_eq!(n, 1);
    let detail = get_run(&db, &run.run_id).unwrap();
    assert_eq!(detail.run.status, "interrupted", "运行应标为 interrupted");
    assert!(detail.run.finished_at.is_some());
    assert_eq!(detail.steps[0].status, "succeeded", "已完成的步骤保持原状");
    assert_eq!(detail.steps[1].status, "failed", "running 步骤标为 failed");
    assert!(
        detail.steps[1].detail.contains("结果未知"),
        "必须如实提示副作用结果未知: {}",
        detail.steps[1].detail
    );
    assert_eq!(
        detail.steps[2].status, "cancelled",
        "pending 步骤标为 cancelled"
    );

    // 幂等：再次恢复是空操作，且不会覆盖已标记的状态
    let n2 = recover_stale_runs(&db).unwrap();
    assert_eq!(n2, 0);
    let detail2 = get_run(&db, &run.run_id).unwrap();
    assert_eq!(detail2.run.status, "interrupted");

    // paused 遗留运行同样被恢复
    let run2 = create_run(&db, &wf.id, "w", &steps).unwrap();
    update_run(
        &db,
        &run2.run_id,
        &RunProgress {
            status: Some("paused".into()),
            current_step_index: None,
            completed_steps: None,
            error: None,
        },
    )
    .unwrap();
    let n3 = recover_stale_runs(&db).unwrap();
    assert_eq!(n3, 1);
    assert_eq!(
        get_run(&db, &run2.run_id).unwrap().run.status,
        "interrupted"
    );
}

#[test]
fn run_steps_pending_cancel_on_stop() {
    let db = temp_db("cancel-pending");
    seed_target(&db, "tgt-url", "url");
    let wf = create_workflow(
        &db,
        wf_input(
            "w",
            vec![
                step_input("open_url", r#"{"target_id":"tgt-url"}"#),
                step_input("open_url", r#"{"target_id":"tgt-url"}"#),
            ],
        ),
    )
    .unwrap();
    let steps = list_steps(&db, &wf.id).unwrap();
    let run = create_run(&db, &wf.id, "w", &steps).unwrap();
    let n = cancel_pending_steps(&db, &run.run_id).unwrap();
    assert_eq!(n, 2);
    let detail = get_run(&db, &run.run_id).unwrap();
    assert!(detail
        .steps
        .iter()
        .all(|s| s.status == "cancelled" && s.finished_at.is_some()));
}
