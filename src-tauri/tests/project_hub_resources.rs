//! 项目资源（能力 ↔ 资源）集成测试：真实 SQLite。
//!
//! 覆盖：
//! - 真实资源查询：只返回项目作用域内的知识库 / Skill / MCP；
//! - 绑定幂等：重复绑定返回既有链接，不复制资源本体；
//! - 作用域校验：其他项目的私有资源不得绑定；
//! - 解除关联只删链接，不删资源本体；
//! - 可用性校验写入真实探测结果与校验时间。

use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;
use task_dock_lib::project_hub::resources::{self, ResourceLinkInput};
use task_dock_lib::project_hub::service::{create_project, CreateProjectInput};

fn memdb() -> Db {
    Db::open_in_memory().unwrap()
}

fn input(request_id: &str) -> CreateProjectInput {
    CreateProjectInput {
        name: "资源项目".into(),
        kind: "general".into(),
        description: String::new(),
        goal: "目标".into(),
        target_date: None,
        root_path: None,
        template_id: None,
        client_request_id: Some(request_id.into()),
        goals: vec![],
        phases: vec![],
        features: vec![],
        tasks: vec![],
        capabilities: vec![task_dock_lib::project_hub::service::CreateCapabilityInput {
            name: "长篇结构设计".into(),
            category: "human".into(),
            necessity: "required".into(),
            target_level: "basic".into(),
            impact: String::new(),
            alternative: String::new(),
        }],
    }
}

fn count(db: &Db, sql: &str) -> i64 {
    db.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
        .unwrap()
}

fn seed_knowledge(db: &Db, id: &str, name: &str, project_id: Option<&str>) {
    let now = "2026-11-21T00:00:00Z";
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO knowledge_bases (id, name, kind, project_id, created_at, updated_at)
             VALUES (?1, ?2, 'project', ?3, ?4, ?4)",
            rusqlite::params![id, name, project_id, now],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn candidates_only_list_resources_visible_to_project() {
    let db = memdb();
    let snapshot = create_project(&db, input("res-1")).unwrap();
    let project_id = snapshot.project.id.clone();
    let other = create_project(&db, input("res-1-other")).unwrap();
    let other_id = other.project.id.clone();
    seed_knowledge(&db, "kb-global", "全局资料", None);
    seed_knowledge(&db, "kb-own", "项目资料", Some(&project_id));
    seed_knowledge(&db, "kb-other", "别人的资料", Some(&other_id));

    let candidates = resources::candidates(&db, &project_id, Some("knowledge"), None).unwrap();
    let ids: Vec<String> = candidates.iter().map(|item| item.id.clone()).collect();
    assert!(ids.contains(&"kb-global".to_string()), "全局知识库应可见");
    assert!(ids.contains(&"kb-own".to_string()), "本项目知识库应可见");
    assert!(
        !ids.contains(&"kb-other".to_string()),
        "其他项目的私有知识库不得可见: {ids:?}"
    );
}

#[test]
fn link_resource_is_idempotent_and_keeps_resource_body() {
    let db = memdb();
    let snapshot = create_project(&db, input("res-2")).unwrap();
    let project_id = snapshot.project.id.clone();
    let capability_id = snapshot.capabilities[0].capability_id.clone();
    seed_knowledge(&db, "kb-1", "项目资料", Some(&project_id));

    let payload = ResourceLinkInput {
        capability_id: capability_id.clone(),
        resource_kind: "knowledge".into(),
        resource_id: "kb-1".into(),
    };
    let first = resources::link(&db, &project_id, payload.clone()).unwrap();
    assert_eq!(first.resource_id, "kb-1");
    assert_eq!(first.availability, "available");

    let again = resources::link(&db, &project_id, payload).unwrap();
    assert_eq!(again.id, first.id, "重复绑定必须幂等");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM capability_resource_links"),
        1,
        "不得产生重复链接"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM knowledge_bases WHERE id = 'kb-1'"),
        1,
        "资源本体不得被复制或删除"
    );

    let links = resources::links(&db, &project_id).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].capability_name, "长篇结构设计");
}

#[test]
fn link_resource_rejects_out_of_scope_resource_and_foreign_capability() {
    let db = memdb();
    let snapshot = create_project(&db, input("res-3")).unwrap();
    let project_id = snapshot.project.id.clone();
    let capability_id = snapshot.capabilities[0].capability_id.clone();
    let other = create_project(&db, input("res-3-other")).unwrap();
    let other_id = other.project.id.clone();
    seed_knowledge(&db, "kb-other", "别人的资料", Some(&other_id));

    let error = resources::link(
        &db,
        &project_id,
        ResourceLinkInput {
            capability_id: capability_id.clone(),
            resource_kind: "knowledge".into(),
            resource_id: "kb-other".into(),
        },
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("作用域"),
        "跨项目资源必须被拒绝: {error}"
    );

    let error = resources::link(
        &db,
        &project_id,
        ResourceLinkInput {
            capability_id: "not-mine".into(),
            resource_kind: "knowledge".into(),
            resource_id: "kb-other".into(),
        },
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("权限"),
        "不属于本项目的能力必须被拒绝: {error}"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM capability_resource_links"),
        0,
        "被拒绝的绑定不得落库"
    );
}

#[test]
fn unlink_only_removes_association() {
    let db = memdb();
    let snapshot = create_project(&db, input("res-4")).unwrap();
    let project_id = snapshot.project.id.clone();
    let capability_id = snapshot.capabilities[0].capability_id.clone();
    seed_knowledge(&db, "kb-1", "项目资料", Some(&project_id));

    let link = resources::link(
        &db,
        &project_id,
        ResourceLinkInput {
            capability_id,
            resource_kind: "knowledge".into(),
            resource_id: "kb-1".into(),
        },
    )
    .unwrap();
    resources::unlink(&db, &project_id, &link.id).unwrap();

    assert_eq!(count(&db, "SELECT COUNT(*) FROM capability_resource_links"), 0);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM knowledge_bases WHERE id = 'kb-1'"),
        1,
        "解除关联不得删除资源本体"
    );
}

#[test]
fn validate_resource_writes_real_probe_result() {
    let db = memdb();
    let snapshot = create_project(&db, input("res-5")).unwrap();
    let project_id = snapshot.project.id.clone();
    let capability_id = snapshot.capabilities[0].capability_id.clone();
    seed_knowledge(&db, "kb-1", "项目资料", Some(&project_id));

    let link = resources::link(
        &db,
        &project_id,
        ResourceLinkInput {
            capability_id,
            resource_kind: "knowledge".into(),
            resource_id: "kb-1".into(),
        },
    )
    .unwrap();
    assert!(link.last_checked_at.is_some());

    // 资源被移除后重新校验 → 不可用
    db.with_conn(|c| {
        c.execute("DELETE FROM knowledge_bases WHERE id = 'kb-1'", [])?;
        Ok(())
    })
    .unwrap();
    let checked = resources::validate(&db, &project_id, &link.id).unwrap();
    assert_eq!(checked.availability, "unavailable");
    assert!(checked.last_checked_at.is_some());
}
