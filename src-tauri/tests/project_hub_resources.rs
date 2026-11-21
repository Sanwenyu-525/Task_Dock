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
use task_dock_lib::project_hub::service::{
    create_project, CreateCapabilityInput, CreateProjectInput,
};

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
            phase_index: None,
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

/// 两个项目引用**同一个全局 capability_id**（能力库按 name+category 唯一）：
/// 资源绑定必须按项目隔离，不能因为共享能力字典就互相看到私有资源。
fn input_sharing_capability(request_id: &str, capability: &str) -> CreateProjectInput {
    CreateProjectInput {
        name: format!("项目-{request_id}"),
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
        capabilities: vec![CreateCapabilityInput {
            name: capability.into(),
            category: "human".into(),
            necessity: "required".into(),
            target_level: "basic".into(),
            impact: String::new(),
            alternative: String::new(),
            phase_index: None,
        }],
    }
}

fn seed_knowledge_with_scope(
    db: &Db,
    id: &str,
    name: &str,
    project_id: Option<&str>,
    workspace_id: Option<&str>,
) {
    let now = "2026-11-21T00:00:00Z";
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO knowledge_bases
               (id, name, kind, project_id, workspace_id, created_at, updated_at)
             VALUES (?1, ?2, 'project', ?3, ?4, ?5, ?5)",
            rusqlite::params![id, name, project_id, workspace_id, now],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn same_capability_across_projects_keeps_private_resources_isolated() {
    let db = memdb();
    let capability = "跨项目共享能力";
    let project_a = create_project(&db, input_sharing_capability("share-a", capability)).unwrap();
    let project_b = create_project(&db, input_sharing_capability("share-b", capability)).unwrap();
    let a_id = project_a.project.id.clone();
    let b_id = project_b.project.id.clone();
    let capability_a = project_a.capabilities[0].capability_id.clone();
    let capability_b = project_b.capabilities[0].capability_id.clone();
    assert_eq!(
        capability_a, capability_b,
        "测试前提：两个项目必须复用同一个全局 capability_id"
    );

    seed_knowledge_with_scope(&db, "kb-a", "A 的私有知识库", Some(&a_id), None);
    seed_knowledge_with_scope(&db, "kb-b", "B 的私有知识库", Some(&b_id), None);
    seed_knowledge_with_scope(&db, "kb-global", "全局知识库", None, None);

    let link_a = resources::link(
        &db,
        &a_id,
        ResourceLinkInput {
            capability_id: capability_a.clone(),
            resource_kind: "knowledge".into(),
            resource_id: "kb-a".into(),
        },
    )
    .unwrap();
    assert_eq!(link_a.scope, "project");
    assert_eq!(link_a.project_id, a_id);

    let link_b = resources::link(
        &db,
        &b_id,
        ResourceLinkInput {
            capability_id: capability_b.clone(),
            resource_kind: "knowledge".into(),
            resource_id: "kb-b".into(),
        },
    )
    .unwrap();

    // B 只看到自己的私有绑定，A 的私有知识库不出现在候选或关联里。
    let b_candidates = resources::candidates(&db, &b_id, Some("knowledge"), None).unwrap();
    let b_candidate_ids: Vec<String> = b_candidates.iter().map(|item| item.id.clone()).collect();
    assert!(!b_candidate_ids.contains(&"kb-a".to_string()));
    assert!(b_candidate_ids.contains(&"kb-b".to_string()));
    let b_links = resources::links(&db, &b_id).unwrap();
    assert_eq!(b_links.len(), 1);
    assert_eq!(b_links[0].id, link_b.id);

    // B 不能解除、也不能校验 A 的私有绑定。
    let unlink_err = resources::unlink(&db, &b_id, &link_a.id).unwrap_err();
    assert!(matches!(unlink_err, AppError::Forbidden(_)), "{unlink_err:?}");
    let validate_err = resources::validate(&db, &b_id, &link_a.id).unwrap_err();
    assert!(matches!(validate_err, AppError::Forbidden(_)), "{validate_err:?}");

    // A 仍可正常查询、校验、解除。
    let a_links = resources::links(&db, &a_id).unwrap();
    assert_eq!(a_links.len(), 1);
    assert_eq!(a_links[0].id, link_a.id);
    let checked = resources::validate(&db, &a_id, &link_a.id).unwrap();
    assert_eq!(checked.availability, "available");
    resources::unlink(&db, &a_id, &link_a.id).unwrap();
    assert!(resources::links(&db, &a_id).unwrap().is_empty());
    // B 的绑定不受 A 解除影响。
    assert_eq!(resources::links(&db, &b_id).unwrap().len(), 1);

    // 两个项目绑定不同资源互不影响：A 重新绑定 kb-a，B 仍只有 kb-b。
    resources::link(
        &db,
        &a_id,
        ResourceLinkInput {
            capability_id: capability_a.clone(),
            resource_kind: "knowledge".into(),
            resource_id: "kb-a".into(),
        },
    )
    .unwrap();
    let a_again = resources::links(&db, &a_id).unwrap();
    let b_again = resources::links(&db, &b_id).unwrap();
    assert_eq!(a_again.len(), 1);
    assert_eq!(b_again.len(), 1);
    assert_ne!(a_again[0].id, b_again[0].id);

    // 全局资源共享必须显式：A 绑定后 B 可见、可校验，但 B 不能解除。
    let global_link = resources::link(
        &db,
        &a_id,
        ResourceLinkInput {
            capability_id: capability_a,
            resource_kind: "knowledge".into(),
            resource_id: "kb-global".into(),
        },
    )
    .unwrap();
    assert_eq!(global_link.scope, "global");
    let shared = resources::link(
        &db,
        &b_id,
        ResourceLinkInput {
            capability_id: capability_b,
            resource_kind: "knowledge".into(),
            resource_id: "kb-global".into(),
        },
    )
    .unwrap();
    assert_eq!(shared.id, global_link.id, "全局共享关联跨项目只有一条");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM capability_resource_links WHERE scope = 'global'"
        ),
        1
    );
    let b_with_shared = resources::links(&db, &b_id).unwrap();
    assert!(
        b_with_shared.iter().any(|link| link.id == global_link.id),
        "显式共享的全局资源对 B 可见"
    );
    assert!(resources::validate(&db, &b_id, &global_link.id).is_ok());
    let shared_unlink = resources::unlink(&db, &b_id, &global_link.id).unwrap_err();
    assert!(matches!(shared_unlink, AppError::Forbidden(_)));
}
