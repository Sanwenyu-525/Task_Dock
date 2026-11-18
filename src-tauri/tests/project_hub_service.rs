//! 项目中枢创建/读模型集成测试：真实 SQLite、事务、幂等与任务关联。

use task_dock_lib::db::Db;
use task_dock_lib::project_hub::service::{
    create_project, get_snapshot, list_projects, CreateCapabilityInput, CreateGoalInput,
    CreatePhaseInput, CreateProjectInput, CreateTaskInput,
};

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
