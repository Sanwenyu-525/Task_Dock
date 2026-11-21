//! 项目中枢创建/读模型集成测试：真实 SQLite、事务、幂等与任务关联。

use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;
use task_dock_lib::project_hub::service::{
    create_project, get_snapshot, list_projects, validate_project_integrity, CreateCapabilityInput,
    CreateFeatureInput, CreateGoalInput, CreatePhaseInput, CreateProjectInput, CreateTaskInput,
};

fn count(db: &Db, sql: &str) -> i64 {
    db.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
        .unwrap()
}

fn input(request_id: &str) -> CreateProjectInput {
    CreateProjectInput {
        name: "科幻小说计划".into(),
        kind: "novel".into(),
        description: "三十万字".into(),
        goal: "完成第一部长篇".into(),
        target_date: Some("2027-03-31".into()),
        root_path: None,
        template_id: Some("novel".into()),
        client_request_id: Some(request_id.into()),
        goals: vec![CreateGoalInput {
            title: "完成初稿".into(),
            note: String::new(),
        }],
        phases: vec![
            CreatePhaseInput {
                name: "世界观".into(),
                description: String::new(),
                target_date: None,
                start_date: None,
                milestones: vec![],
            },
            CreatePhaseInput {
                name: "第一卷".into(),
                description: String::new(),
                target_date: None,
                start_date: None,
                milestones: vec![],
            },
        ],
        features: vec![
            CreateFeatureInput {
                title: "搭建世界观框架".into(),
                acceptance: "能列出主要设定".into(),
                priority: Some("P0".into()),
                phase_index: Some(0),
            },
            CreateFeatureInput {
                title: "写第一卷大纲".into(),
                acceptance: String::new(),
                priority: Some("P1".into()),
                phase_index: Some(1),
            },
        ],
        tasks: vec![
            CreateTaskInput {
                title: "写世界观大纲".into(),
                description: String::new(),
                phase_index: Some(0),
                due_at: None,
                priority: Some(1),
            },
            CreateTaskInput {
                title: "写第一章".into(),
                description: String::new(),
                phase_index: Some(1),
                due_at: None,
                priority: Some(2),
            },
        ],
        capabilities: vec![CreateCapabilityInput {
            name: "长篇结构设计".into(),
            category: "human".into(),
            necessity: "required".into(),
            target_level: "proficient".into(),
            impact: "影响完稿".into(),
            alternative: String::new(),
            phase_index: None,
        }],
    }
}

#[test]
fn create_project_persists_root_plan_phases_tasks_and_capability() {
    let db = Db::open_in_memory().unwrap();
    let snapshot = create_project(&db, input("req-1")).unwrap();

    assert_eq!(snapshot.project.name, "科幻小说计划");
    assert_eq!(snapshot.project.kind, "novel");
    assert_eq!(snapshot.project.phase_count, 2);
    assert_eq!(snapshot.project.task_count, 2);
    assert_eq!(snapshot.project.capability_count, 1);
    assert!(snapshot.plan_id.is_some());
    assert_eq!(snapshot.phases.len(), 2);
    assert_eq!(snapshot.tasks.len(), 2);
    assert_eq!(snapshot.capabilities.len(), 1);
    assert_eq!(snapshot.goals.len(), 1);

    let first_task = &snapshot.tasks[0];
    assert!(first_task.phase_id.is_some(), "任务必须关联阶段");

    let project_id = snapshot.project.id.clone();
    let again = create_project(&db, input("req-1")).unwrap();
    assert_eq!(again.project.id, project_id, "同一 clientRequestId 必须幂等");
    assert_eq!(again.project.task_count, 2, "重复调用不得新增任务");

    let listed = list_projects(&db).unwrap();
    assert_eq!(listed.len(), 1);
    let fetched = get_snapshot(&db, &project_id).unwrap();
    assert_eq!(fetched.project.id, project_id);
}

#[test]
fn create_project_rejects_empty_name_and_relative_root() {
    let db = Db::open_in_memory().unwrap();
    let mut bad = input("req-2");
    bad.name = "  ".into();
    assert!(create_project(&db, bad).is_err());

    let mut bad = input("req-3");
    bad.root_path = Some("relative/path".into());
    assert!(create_project(&db, bad).is_err());
}

#[test]
fn create_project_persists_features_with_phase_link_in_same_transaction() {
    let db = Db::open_in_memory().unwrap();
    let snapshot = create_project(&db, input("req-features")).unwrap();

    assert_eq!(snapshot.features.len(), 2, "功能草案必须真实落库");
    let first = &snapshot.features[0];
    assert_eq!(first.title, "搭建世界观框架");
    assert_eq!(first.priority, "P0");
    assert_eq!(first.acceptance_criteria, "能列出主要设定");
    assert_eq!(first.status, "planned");
    assert!(first.milestone_id.is_some(), "功能必须关联所属阶段");

    // 功能挂在正确的阶段上（第一个阶段 = 世界观）
    let phase_id = snapshot.phases[0].id.clone();
    assert_eq!(first.milestone_id.as_deref(), Some(phase_id.as_str()));
    assert_eq!(snapshot.phases[0].feature_count, 1);
    assert_eq!(snapshot.phases[0].completed_feature_count, 0);
    assert_eq!(snapshot.phases[1].feature_count, 1);

    let project_id = snapshot.project.id.clone();
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM planning_features"),
        2,
        "功能行必须写入 planning_features"
    );
    let report = validate_project_integrity(&db, &project_id).unwrap();
    assert!(report.ok, "功能落库后完整性必须通过: {:?}", report.blocking);
}

#[test]
fn same_request_id_with_different_parameters_returns_conflict() {
    let db = Db::open_in_memory().unwrap();
    let first = create_project(&db, input("req-conflict")).unwrap();

    let mut changed = input("req-conflict");
    changed.name = "另一本小说".into();
    let error = create_project(&db, changed).unwrap_err();
    assert!(
        error.to_string().contains("冲突") || error.to_string().contains("操作冲突"),
        "同一请求 ID 携带不同参数必须冲突: {error}"
    );

    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM workspace_projects"),
        1,
        "冲突不得创建第二个项目"
    );
    let listed = list_projects(&db).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, first.project.id);
}

#[test]
fn feature_referencing_missing_phase_is_rejected() {
    let db = Db::open_in_memory().unwrap();
    let mut bad = input("req-bad-phase");
    bad.features[0].phase_index = Some(9);
    let error = create_project(&db, bad).unwrap_err();
    assert!(error.to_string().contains("阶段"), "必须拒绝越界阶段: {error}");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM workspace_projects"),
        0,
        "校验失败不得留下半套数据"
    );
}

#[test]
fn create_two_projects_are_independent_and_listed() {
    let db = Db::open_in_memory().unwrap();
    let first = create_project(&db, input("req-first")).unwrap();
    let second = create_project(&db, input("req-second")).unwrap();
    assert_ne!(first.project.id, second.project.id);
    assert_eq!(list_projects(&db).unwrap().len(), 2);
    assert_eq!(get_snapshot(&db, &second.project.id).unwrap().project.task_count, 2);
}

#[test]
fn file_database_supports_repeated_create_and_reads() {
    let path = std::env::temp_dir().join(format!("task-dock-project-hub-{}.db", uuid::Uuid::new_v4()));
    let db = Db::open(&path).unwrap();
    let first = create_project(&db, input("req-file-first")).unwrap();
    assert_eq!(list_projects(&db).unwrap().len(), 1);
    let loaded = get_snapshot(&db, &first.project.id).unwrap();
    assert_eq!(loaded.project.phase_count, 2);

    let second = create_project(&db, input("req-file-second")).unwrap();
    assert_ne!(first.project.id, second.project.id);
    assert_eq!(list_projects(&db).unwrap().len(), 2);
    assert_eq!(get_snapshot(&db, &second.project.id).unwrap().project.task_count, 2);

    drop(db);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn capability_phase_and_unassigned_task_persist_as_null_not_sentinel() {
    let db = Db::open_in_memory().unwrap();
    let mut payload = input("req-phase-owner");
    payload.phases = vec![
        CreatePhaseInput {
            name: "阶段一".into(),
            description: String::new(),
            target_date: None,
            start_date: None,
            milestones: vec![],
        },
        CreatePhaseInput {
            name: "阶段二".into(),
            description: String::new(),
            target_date: None,
            start_date: None,
            milestones: vec![],
        },
    ];
    payload.features = vec![];
    payload.tasks = vec![CreateTaskInput {
        title: "未分阶段任务".into(),
        description: String::new(),
        phase_index: None,
        due_at: None,
        priority: Some(2),
    }];
    payload.capabilities = vec![
        CreateCapabilityInput {
            name: "阶段能力".into(),
            category: "human".into(),
            necessity: "required".into(),
            target_level: "basic".into(),
            impact: String::new(),
            alternative: String::new(),
            phase_index: Some(1),
        },
        CreateCapabilityInput {
            name: "全局能力".into(),
            category: "tool".into(),
            necessity: "optional".into(),
            target_level: "basic".into(),
            impact: String::new(),
            alternative: String::new(),
            phase_index: None,
        },
    ];
    let snapshot = create_project(&db, payload).unwrap();
    let second_phase = snapshot.phases[1].id.clone();

    let phased = snapshot
        .capabilities
        .iter()
        .find(|item| item.name == "阶段能力")
        .expect("能力需求必须落库");
    assert_eq!(
        phased.phase_id.as_deref(),
        Some(second_phase.as_str()),
        "能力需求必须保存真实阶段归属"
    );
    let global = snapshot
        .capabilities
        .iter()
        .find(|item| item.name == "全局能力")
        .expect("能力需求必须落库");
    assert!(global.phase_id.is_none(), "未分配阶段必须是 NULL，不能是哨兵值");

    let task = snapshot
        .tasks
        .iter()
        .find(|item| item.title == "未分阶段任务")
        .expect("任务必须落库");
    assert!(task.phase_id.is_none(), "未分阶段任务不得挂到任意阶段");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM task_plan_links WHERE phase_id = '' AND milestone_id = ''"
        ),
        1,
        "未分阶段任务仍要保留项目级关联"
    );
}
