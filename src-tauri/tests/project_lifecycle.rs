//! 项目根与服务收敛集成测试（真实 SQLite）。
//!
//! 覆盖：
//! - 项目根唯一：规划/工作空间/项目中枢三个入口都产生 workspace_projects + 合法计划；
//! - 旧命令兼容：planning_* 只改计划，不误删/误归档项目根；
//! - 生命周期：单 active 计划、active_plan_id 一致、最后计划保护、删除项目保留任务/共享资源；
//! - 并发：重复请求幂等、不同请求同名项目互不串数据、乐观并发冲突、删除后更新返回 NotFound。

use std::sync::Arc;

use task_dock_lib::commands::planning::{
    archive_project_impl, create_project_impl, create_project_tx, delete_project_impl,
    list_projects_impl, update_plan_impl, update_plan_tx, update_project_root_impl,
    PlanPatch, ProjectInput,
};
use task_dock_lib::commands::project_workspace::{
    workspace_project_delete_impl, workspace_project_list_impl, workspace_project_save_impl,
    workspace_project_set_status_impl, workspace_set_active_project_impl,
};
use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;
use task_dock_lib::project_hub::service::{
    activate_plan, archive_plan, create_project, create_project_plan, delete_plan, delete_project,
    get_project, get_snapshot, list_projects, validate_project_integrity, CreateCapabilityInput, CreateFeatureInput,
    CreateGoalInput, CreatePhaseInput, CreatePlanInput, CreateProjectInput, CreateProjectRootInput,
    CreateTaskInput, ProjectRootPatch as RootPatch, ProjectSummary,
};

fn memdb() -> Db {
    Db::open_in_memory().unwrap()
}

fn proj_input(name: &str) -> ProjectInput {
    ProjectInput {
        name: name.into(),
        description: String::new(),
        status: None,
        target_date: None,
    }
}

/// 计划聚合补丁（只含计划自身字段）。
fn plan_patch(status: Option<&str>, expected: i64) -> PlanPatch {
    PlanPatch {
        execution_status: status.map(str::to_string),
        sort_order: None,
        expected_plan_revision: Some(expected),
    }
}

fn count(db: &Db, sql: &str) -> i64 {
    db.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
        .unwrap()
}

fn text(db: &Db, sql: &str) -> String {
    db.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).map_err(AppError::from))
        .unwrap()
}

fn root_input(name: &str) -> CreateProjectRootInput {
    CreateProjectRootInput {
        name: name.into(),
        kind: "general".into(),
        description: "描述".into(),
        goal: "目标".into(),
        target_date: Some("2027-01-31".into()),
        root_path: None,
        dev_project_id: None,
        note: None,
        template_id: None,
        plan_name: None,
        plan_description: None,
        plan_status: None,
        plan_sort_order: None,
    }
}

fn rich_input(request_id: &str) -> CreateProjectInput {
    CreateProjectInput {
        name: "生命周期项目".into(),
        kind: "novel".into(),
        description: "三十万字".into(),
        goal: "完成初稿".into(),
        target_date: Some("2027-03-31".into()),
        root_path: None,
        template_id: Some("novel".into()),
        client_request_id: Some(request_id.into()),
        goals: vec![CreateGoalInput {
            title: "完成初稿".into(),
            note: String::new(),
        }],
        phases: vec![CreatePhaseInput {
            name: "世界观".into(),
            description: String::new(),
            target_date: None,
            start_date: None,
            milestones: vec![],
        }],
        features: vec![CreateFeatureInput {
            title: "搭建世界观框架".into(),
            acceptance: "能列出主要设定".into(),
            priority: Some("P0".into()),
            phase_index: Some(0),
        }],
        tasks: vec![CreateTaskInput {
            title: "写世界观大纲".into(),
            description: String::new(),
            phase_index: Some(0),
            due_at: None,
            priority: Some(1),
        }],
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

// ── 项目根 ──────────────────────────────────────────────────────────

#[test]
fn planning_create_project_creates_root_and_legal_plan() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("规划入口项目")).unwrap();

    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    assert!(!project_id.is_empty(), "计划必须挂到项目根");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 1);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM planning_projects
             WHERE workspace_project_id IS NULL OR workspace_project_id = ''"
        ),
        0,
        "不得产生孤立计划"
    );
    let (name, pointer): (String, String) = db
        .with_conn(|c| {
            c.query_row(
                "SELECT name, active_plan_id FROM workspace_projects WHERE id = ?1",
                rusqlite::params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    assert_eq!(name, "规划入口项目");
    assert_eq!(pointer, plan.id, "项目 active_plan_id 必须指向初始计划");
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects WHERE id = '{}' AND is_active = 1",
                plan.id
            )
        ),
        1
    );
}

#[test]
fn project_hub_create_project_has_root_and_active_plan() {
    let db = memdb();
    let snapshot = create_project(&db, rich_input("root-1")).unwrap();
    let report = validate_project_integrity(&db, &snapshot.project.id).unwrap();
    assert!(report.ok, "新建项目必须通过完整性校验: {:?}", report.blocking);
    assert_eq!(report.plan_count, 1);
    assert_eq!(report.active_plan_count, 1);
    assert!(snapshot.plan_id.is_some(), "新建项目必须返回 active 计划 ID");
}

#[test]
fn duplicate_client_request_id_does_not_duplicate_project_or_plan() {
    let db = memdb();
    let first = create_project(&db, rich_input("dup-1")).unwrap();
    let again = create_project(&db, rich_input("dup-1")).unwrap();
    assert_eq!(first.project.id, again.project.id);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 1);
}

#[test]
fn project_update_only_changes_requested_fields() {
    let db = memdb();
    let summary = create_project_root(&db, root_input("原名"));
    let summary = summary.unwrap();

    let updated = task_dock_lib::project_hub::service::update_project(
        &db,
        &summary.id,
        RootPatch {
            name: Some("新名".into()),
            expected_project_revision: Some(summary.revision),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(updated.name, "新名");
    assert_eq!(updated.description, "描述", "未提交字段不得被覆盖");
    assert_eq!(updated.goal, "目标");
    assert_eq!(updated.target_date.as_deref(), Some("2027-01-31"));
    assert_eq!(updated.status, "active");

    let cleared = task_dock_lib::project_hub::service::update_project(
        &db,
        &summary.id,
        RootPatch {
            target_date: Some(None),
            expected_project_revision: Some(updated.revision),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(cleared.target_date.is_none(), "target_date 三态清空必须生效");

    let archived = task_dock_lib::project_hub::service::archive_project(&db, &summary.id, true).unwrap();
    assert_eq!(archived.status, "archived");
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects
                 WHERE workspace_project_id = '{}' AND status = 'planning' AND archived = 0",
                summary.id
            )
        ),
        1,
        "项目归档不得改写计划执行状态"
    );
}

fn create_project_root(
    db: &Db,
    input: CreateProjectRootInput,
) -> task_dock_lib::error::AppResult<task_dock_lib::project_hub::service::ProjectSummary> {
    task_dock_lib::project_hub::service::create_project_root(db, input)
}

// ── 旧命令兼容 ──────────────────────────────────────────────────────

#[test]
fn planning_update_splits_project_fields_and_plan_status() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("旧名")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );

    // 名称/描述/目标日期 → 项目根（同步计划镜像，不推进计划 revision）
    let root_outcome = update_project_root_impl(
        &db,
        plan.id.clone(),
        RootPatch {
            name: Some("改名".into()),
            description: Some("新描述".into()),
            target_date: Some(Some("2026-12-01".into())),
            expected_project_revision: plan.project_revision,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(root_outcome.project.name, "改名");
    assert_eq!(root_outcome.plan.name, "改名");
    assert_eq!(root_outcome.plan.description, "新描述");
    assert_eq!(root_outcome.plan.target_date.as_deref(), Some("2026-12-01"));
    assert_eq!(root_outcome.plan.revision, plan.revision, "根写不得推进计划 revision");

    // 执行状态 → 计划（不碰项目根）
    let updated = update_plan_impl(&db, plan.id.clone(), plan_patch(Some("in_progress"), plan.revision)).unwrap();
    assert_eq!(updated.name, "改名");
    assert_eq!(updated.description, "新描述");
    assert_eq!(updated.status, "in_progress");
    assert_eq!(updated.target_date.as_deref(), Some("2026-12-01"));

    let (root_name, root_desc, root_target, root_status): (String, String, Option<String>, String) =
        db.with_conn(|c| {
            c.query_row(
                "SELECT name, description, target_date, status FROM workspace_projects WHERE id = ?1",
                rusqlite::params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    assert_eq!(root_name, "改名", "项目根名称必须同步");
    assert_eq!(root_desc, "新描述");
    assert_eq!(root_target.as_deref(), Some("2026-12-01"));
    assert_eq!(root_status, "active", "计划状态变化不得改写项目生命周期");
}

#[test]
fn planning_archive_project_does_not_archive_project_root() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("归档计划")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    // 归档当前计划需要合法继任者：先建一个未归档计划。
    let successor = create_second_plan(&db, &project_id, "继任计划");

    let archived = archive_project_impl(&db, plan.id.clone(), true).unwrap();
    assert!(archived.archived);
    assert_eq!(
        text(
            &db,
            &format!("SELECT status FROM workspace_projects WHERE id = '{project_id}'")
        ),
        "active",
        "planning_archive_project 不得归档项目根"
    );
    assert_eq!(
        text(
            &db,
            &format!("SELECT active_plan_id FROM workspace_projects WHERE id = '{project_id}'")
        ),
        successor,
        "归档当前计划后必须切换到未归档继任者"
    );

    // 反向：项目归档也不改写计划状态
    workspace_project_set_status_impl(&db, &project_id, "archived".into()).unwrap();
    assert_eq!(
        text(
            &db,
            &format!(
                "SELECT status FROM planning_projects WHERE id = '{}'",
                plan.id
            )
        ),
        "planning"
    );
}

/// 建一个同项目、非 active 的计划容器。
///
/// v87 名称契约：计划名称跟随项目名称，不支持独立命名；`_label` 只用于调用点可读性。
fn create_second_plan(db: &Db, project_id: &str, _label: &str) -> String {
    create_project_plan(
        db,
        CreatePlanInput {
            project_id: project_id.to_string(),
            name: None,
            description: None,
            target_date: None,
            status: None,
            template_id: None,
            make_active: false,
        },
    )
    .unwrap()
}

#[test]
fn archive_active_plan_switches_to_unarchived_successor() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("归档切换")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    let successor = create_second_plan(&db, &project_id, "第二计划");

    archive_plan(&db, &plan.id, true).unwrap();

    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects WHERE id = '{}' AND archived = 1",
                plan.id
            )
        ),
        1,
        "当前计划必须被归档"
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects
                 WHERE workspace_project_id = '{project_id}' AND is_active = 1"
            )
        ),
        1,
        "同一项目只能有一个 active 计划"
    );
    assert_eq!(
        text(
            &db,
            &format!("SELECT active_plan_id FROM workspace_projects WHERE id = '{project_id}'")
        ),
        successor
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects
                 WHERE workspace_project_id = '{project_id}' AND is_active = 1 AND archived = 1"
            )
        ),
        0,
        "active 计划不得处于 archived 状态"
    );
    let report = validate_project_integrity(&db, &project_id).unwrap();
    assert!(report.ok, "归档切换后完整性必须通过: {:?}", report.blocking);
}

#[test]
fn archive_last_active_plan_without_successor_is_rejected() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("没有继任者")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );

    let error = archive_plan(&db, &plan.id, true).unwrap_err();
    assert!(
        error.to_string().contains("继任"),
        "归档当前计划必须要求合法继任者: {error}"
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects WHERE id = '{}' AND archived = 1",
                plan.id
            )
        ),
        0,
        "被拒绝的归档不得落库"
    );
    let report = validate_project_integrity(&db, &project_id).unwrap();
    assert!(report.ok, "拒绝归档后项目仍必须自洽: {:?}", report.blocking);
}

#[test]
fn activating_archived_plan_is_rejected() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("激活归档")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    let successor = create_second_plan(&db, &project_id, "第二计划");
    archive_plan(&db, &plan.id, true).unwrap();

    let error = activate_plan(&db, &plan.id).unwrap_err();
    assert!(
        error.to_string().contains("归档"),
        "归档计划不得直接激活: {error}"
    );
    assert_eq!(
        text(
            &db,
            &format!("SELECT active_plan_id FROM workspace_projects WHERE id = '{project_id}'")
        ),
        successor
    );

    // 显式恢复后可以激活
    archive_plan(&db, &plan.id, false).unwrap();
    activate_plan(&db, &plan.id).unwrap();
    assert_eq!(
        text(
            &db,
            &format!("SELECT active_plan_id FROM workspace_projects WHERE id = '{project_id}'")
        ),
        plan.id
    );
}

#[test]
fn integrity_detects_archived_active_plan() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("脏数据")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    // 直接制造脏数据：active 计划同时处于 archived。
    db.with_conn(|c| {
        c.execute(
            "UPDATE planning_projects SET archived = 1 WHERE id = ?1",
            rusqlite::params![plan.id],
        )?;
        Ok(())
    })
    .unwrap();

    let report = validate_project_integrity(&db, &project_id).unwrap();
    assert!(!report.ok, "完整性校验必须发现 archived active 计划");
    assert!(
        report
            .blocking
            .iter()
            .any(|item| item.contains("archived")),
        "阻塞原因必须指出 archived 状态: {:?}",
        report.blocking
    );
}

#[test]
fn delete_active_plan_promotes_only_unarchived_successor() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("删除当前计划")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    let successor = create_second_plan(&db, &project_id, "第二计划");
    let archived_plan = create_second_plan(&db, &project_id, "已归档计划");
    archive_plan(&db, &archived_plan, true).unwrap();

    // 制造「当前计划 + 唯一未归档继任者已归档」：把当前计划切到 plan.id，
    // 并让已归档计划成为唯一候选（successor 也归档）。
    activate_plan(&db, &successor).unwrap();
    archive_plan(&db, &successor, true).unwrap();
    archive_plan(&db, &plan.id, false).unwrap();
    db.with_conn(|c| {
        c.execute(
            "UPDATE planning_projects SET is_active = 0 WHERE id = ?1",
            rusqlite::params![successor],
        )?;
        c.execute(
            "UPDATE planning_projects SET is_active = 1 WHERE id = ?1",
            rusqlite::params![plan.id],
        )?;
        c.execute(
            "UPDATE workspace_projects SET active_plan_id = ?1 WHERE id = ?2",
            rusqlite::params![plan.id, project_id],
        )?;
        Ok(())
    })
    .unwrap();

    let error = delete_plan(&db, &plan.id).unwrap_err();
    assert!(
        error.to_string().contains("继任"),
        "没有未归档继任者时必须拒绝删除: {error}"
    );
    assert_eq!(
        count(
            &db,
            &format!("SELECT COUNT(*) FROM planning_projects WHERE id = '{}'", plan.id)
        ),
        1,
        "被拒绝的删除不得落库"
    );
}

#[test]
fn planning_delete_project_never_deletes_project_root() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("保留项目根")).unwrap();
    let err = delete_project_impl(&db, plan.id.clone()).unwrap_err();
    assert!(err.to_string().contains("最后一个计划"), "必须拒绝删除最后一个计划: {err}");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 1);
}

#[test]
fn mcp_write_path_keeps_working() {
    let db = memdb();
    // MCP 工具直接拿事务连接调用计划写内核；签名与返回结构不得变化。
    let plan = db
        .with_conn(|conn| create_project_tx(conn, proj_input("MCP 项目")))
        .unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 1);

    // 项目根字段（含镜像同步）：根 revision 递增，计划 revision 不变。
    let root_outcome = update_project_root_impl(
        &db,
        plan.id.clone(),
        RootPatch {
            name: Some("MCP 改名".into()),
            expected_project_revision: plan.project_revision,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(root_outcome.project.name, "MCP 改名");
    assert_eq!(root_outcome.plan.revision, plan.revision);

    // 计划执行状态：走事务内内核，只推进计划 revision。
    let updated = db
        .with_transaction(|conn| update_plan_tx(conn, &plan.id, plan_patch(Some("in_progress"), plan.revision)))
        .unwrap();
    assert_eq!(updated.name, "MCP 改名");
    assert_eq!(updated.status, "in_progress");
    assert_eq!(
        text(
            &db,
            &format!(
                "SELECT name FROM workspace_projects WHERE id = (
                   SELECT workspace_project_id FROM planning_projects WHERE id = '{}'
                 )",
                plan.id
            )
        ),
        "MCP 改名"
    );
}

// ── 生命周期 ────────────────────────────────────────────────────────

#[test]
fn activate_plan_switches_flags_and_pointer_atomically() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("计划切换")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    let second = create_project_plan(
        &db,
        CreatePlanInput {
            project_id: project_id.clone(),
            name: None,
            description: None,
            target_date: None,
            status: Some("in_progress".into()),
            template_id: None,
            make_active: false,
        },
    )
    .unwrap();

    activate_plan(&db, &second).unwrap();
    assert_eq!(
        text(
            &db,
            &format!("SELECT active_plan_id FROM workspace_projects WHERE id = '{project_id}'")
        ),
        second
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects
                 WHERE workspace_project_id = '{project_id}' AND is_active = 1"
            )
        ),
        1,
        "同一项目只能有一个 active 计划"
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects WHERE id = '{}' AND is_active = 0",
                plan.id
            )
        ),
        1
    );
}

#[test]
fn delete_plan_promotes_successor_and_leaves_no_dangling_pointer() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("删除计划")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    let second = create_project_plan(
        &db,
        CreatePlanInput {
            project_id: project_id.clone(),
            name: None,
            description: None,
            target_date: None,
            status: None,
            template_id: None,
            make_active: false,
        },
    )
    .unwrap();
    // 计划内容（功能/步骤/历史）必须随计划删除级联清除
    db.with_conn(|c| {
        let now = "2026-11-20T00:00:00Z";
        c.execute(
            "INSERT INTO planning_features (id, project_id, title, created_at, updated_at)
             VALUES ('f-1', ?1, '功能', ?2, ?2)",
            rusqlite::params![plan.id, now],
        )?;
        c.execute(
            "INSERT INTO planning_feature_steps (id, feature_id, title, created_at, updated_at)
             VALUES ('s-1', 'f-1', '步骤', ?1, ?1)",
            rusqlite::params![now],
        )?;
        c.execute(
            "INSERT INTO planning_activity (id, project_id, feature_id, kind, created_at)
             VALUES ('a-1', ?1, 'f-1', 'note', ?2)",
            rusqlite::params![plan.id, now],
        )?;
        Ok(())
    })
    .unwrap();

    delete_plan(&db, &plan.id).unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_features"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_feature_steps"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_activity"), 0);
    assert_eq!(
        text(
            &db,
            &format!("SELECT active_plan_id FROM workspace_projects WHERE id = '{project_id}'")
        ),
        second,
        "删除 active 计划后必须选继任并更新指针"
    );
    let dangling = count(
        &db,
        &format!(
            "SELECT COUNT(*) FROM workspace_projects p
             WHERE p.id = '{project_id}'
               AND NOT EXISTS (
                 SELECT 1 FROM planning_projects l
                 WHERE l.id = p.active_plan_id AND l.workspace_project_id = p.id AND l.is_active = 1
               )"
        ),
    );
    assert_eq!(dangling, 0);
    let report = validate_project_integrity(&db, &project_id).unwrap();
    assert!(report.ok, "删除计划后完整性必须通过: {:?}", report.blocking);
}

#[test]
fn delete_project_keeps_tasks_and_shared_resources() {
    let db = memdb();
    let snapshot = create_project(&db, rich_input("删除项目")).unwrap();
    let project_id = snapshot.project.id.clone();
    let now = "2026-11-20T00:00:00Z";
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO knowledge_bases (id, name, kind, project_id, created_at, updated_at)
             VALUES ('kb-1', '项目资料', 'project', ?1, ?2, ?2)",
            rusqlite::params![project_id, now],
        )?;
        c.execute(
            "INSERT INTO capability_skills
             (id, name, source_kind, source_path, project_id, last_seen_at, created_at, updated_at)
             VALUES ('sk-1', '写作', 'imported', 'C:\\skills\\writing', ?1, ?2, ?2, ?2)",
            rusqlite::params![project_id, now],
        )?;
        Ok(())
    })
    .unwrap();
    workspace_set_active_project_impl(&db, Some(project_id.clone())).unwrap();

    let outcome = delete_project(&db, &project_id).unwrap();
    assert_eq!(outcome.deleted_plans, 1);
    assert_eq!(outcome.unlinked_tasks, 1);
    assert_eq!(outcome.released_knowledge, 1);
    assert_eq!(outcome.released_skills, 1);

    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM tasks"), 1, "全局任务不得删除");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM task_plan_links"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_task_links"), 0);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM project_capabilities"),
        1,
        "共享能力库不得删除"
    );
    assert_eq!(count(&db, "SELECT COUNT(*) FROM knowledge_bases"), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM capability_skills"), 1);
    let kb_project: Option<String> = db
        .with_conn(|c| {
            c.query_row("SELECT project_id FROM knowledge_bases WHERE id = 'kb-1'", [], |r| {
                r.get(0)
            })
            .map_err(AppError::from)
        })
        .unwrap();
    assert!(kb_project.is_none(), "共享资源只解除关联");
    let skill_project: Option<String> = db
        .with_conn(|c| {
            c.query_row("SELECT project_id FROM capability_skills WHERE id = 'sk-1'", [], |r| {
                r.get(0)
            })
            .map_err(AppError::from)
        })
        .unwrap();
    assert!(skill_project.is_none());
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM application_settings WHERE key = 'workspace_active_project'"),
        0,
        "删除项目必须清除活跃项目键"
    );
}

#[test]
fn workspace_project_save_creates_plan_and_keeps_environment_fields() {
    let db = memdb();
    let root = std::env::temp_dir().to_string_lossy().to_string();
    let saved = workspace_project_save_impl(
        &db,
        None,
        "工作空间项目".into(),
        "development".into(),
        Some(root.clone()),
        None,
        Some("备注".into()),
    )
    .unwrap();
    assert_eq!(saved.root_path, root);
    assert_eq!(saved.note, "备注");
    let report = validate_project_integrity(&db, &saved.id).unwrap();
    assert!(report.ok, "工作空间新建必须同时有合法计划: {:?}", report.blocking);
    assert_eq!(report.plan_count, 1);

    let updated = workspace_project_save_impl(
        &db,
        Some(saved.id.clone()),
        "改名工作空间".into(),
        "game".into(),
        Some(root.clone()),
        None,
        Some("新备注".into()),
    )
    .unwrap();
    assert_eq!(updated.name, "改名工作空间");
    assert_eq!(updated.kind, "game");
    assert_eq!(updated.note, "新备注");
    assert_eq!(
        text(
            &db,
            &format!(
                "SELECT name FROM planning_projects WHERE workspace_project_id = '{}'",
                saved.id
            )
        ),
        "改名工作空间",
        "计划名称必须跟随项目根"
    );
}

#[test]
fn legacy_workspace_project_without_plan_is_repaired_on_edit() {
    let db = memdb();
    let now = "2026-11-20T00:00:00Z";
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO workspace_projects
             (id, name, kind, status, root_path, note, created_at, updated_at)
             VALUES ('legacy-1', '旧项目', 'general', 'active', '', '', ?1, ?1)",
            rusqlite::params![now],
        )?;
        Ok(())
    })
    .unwrap();
    let before = validate_project_integrity(&db, "legacy-1").unwrap();
    assert!(!before.ok, "旧项目缺少计划必须被完整性校验发现");

    workspace_project_save_impl(
        &db,
        Some("legacy-1".into()),
        "旧项目".into(),
        "general".into(),
        None,
        None,
        None,
    )
    .unwrap();
    let after = validate_project_integrity(&db, "legacy-1").unwrap();
    assert!(after.ok, "编辑后必须补建合法计划: {:?}", after.blocking);
}

// ── 并发 ────────────────────────────────────────────────────────────

#[test]
fn concurrent_same_request_creates_one_project() {
    let db = Arc::new(memdb());
    let mut handles = Vec::new();
    for _ in 0..4 {
        let db = Arc::clone(&db);
        handles.push(std::thread::spawn(move || {
            create_project(db.as_ref(), rich_input("same-req")).map(|s| s.project.id)
        }));
    }
    let ids: Vec<String> = handles
        .into_iter()
        .map(|h| h.join().unwrap().unwrap())
        .collect();
    assert!(ids.iter().all(|id| id == &ids[0]), "同一请求必须幂等");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 1);
}

#[test]
fn concurrent_distinct_requests_with_same_name_stay_isolated() {
    let db = Arc::new(memdb());
    let mut handles = Vec::new();
    for i in 0..4 {
        let db = Arc::clone(&db);
        handles.push(std::thread::spawn(move || {
            create_project(db.as_ref(), rich_input(&format!("req-{i}"))).map(|s| s.project.id)
        }));
    }
    let ids: Vec<String> = handles
        .into_iter()
        .map(|h| h.join().unwrap().unwrap())
        .collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 4);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 4);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM planning_projects WHERE is_active = 1"
        ),
        4,
        "每个项目各有一个 active 计划"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM planning_projects l
             JOIN workspace_projects p ON p.id = l.workspace_project_id
             WHERE p.active_plan_id <> l.id"
        ),
        0,
        "计划不得串到其他项目"
    );
}

#[test]
fn concurrent_update_uses_optimistic_revision() {
    let db = Arc::new(memdb());
    let plan = create_project_impl(db.as_ref(), proj_input("并发更新")).unwrap();
    // 项目根并发：两个线程拿同一个根 revision 改名，只能成功一次。
    let revision = plan.project_revision.expect("新计划必带根 revision");

    let mut handles = Vec::new();
    for _ in 0..2 {
        let db = Arc::clone(&db);
        let id = plan.id.clone();
        handles.push(std::thread::spawn(move || {
            update_project_root_impl(
                db.as_ref(),
                id,
                RootPatch {
                    name: Some("并发改名".into()),
                    expected_project_revision: Some(revision),
                    ..Default::default()
                },
            )
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let ok = results.iter().filter(|r| r.is_ok()).count();
    let conflicts = results.iter().filter(|r| r.is_err()).count();
    assert_eq!(ok, 1, "同一 revision 只能成功一次");
    assert_eq!(conflicts, 1, "迟到更新必须返回冲突而不是静默覆盖");
}

#[test]
fn delete_then_update_returns_not_found_and_leaves_no_half_data() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("删除后更新")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    delete_project(&db, &project_id).unwrap();
    let err = update_project_root_impl(
        &db,
        plan.id.clone(),
        RootPatch {
            name: Some("迟到更新".into()),
            expected_project_revision: plan.project_revision,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("不存在"), "删除后更新必须失败: {err}");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 0);

    // 反向：先更新后删除，也不留半套数据
    let snapshot = create_project(&db, rich_input("先更新后删除")).unwrap();
    task_dock_lib::project_hub::service::update_project(
        &db,
        &snapshot.project.id,
        RootPatch {
            name: Some("更新后删除".into()),
            expected_project_revision: Some(snapshot.project.revision),
            ..Default::default()
        },
    )
    .unwrap();
    delete_project(&db, &snapshot.project.id).unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_projects"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM planning_projects"), 0);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM project_goals"),
        0,
        "项目域子数据必须随项目删除"
    );
}

#[test]
fn list_projects_and_workspace_list_stay_consistent() {
    let db = memdb();
    let plan = create_project_impl(&db, proj_input("共享身份")).unwrap();
    let project_id = text(
        &db,
        &format!(
            "SELECT workspace_project_id FROM planning_projects WHERE id = '{}'",
            plan.id
        ),
    );
    let hub = list_projects(&db).unwrap();
    assert_eq!(hub.len(), 1);
    assert_eq!(hub[0].id, project_id);
    let workspace = workspace_project_list_impl(&db, None).unwrap();
    assert_eq!(workspace.len(), 1);
    assert_eq!(workspace[0].id, project_id);
    assert_eq!(list_projects_impl(&db, None).unwrap().len(), 1);
    let fetched = get_project(&db, &project_id).unwrap();
    assert_eq!(fetched.active_plan_id.as_deref(), Some(plan.id.as_str()));
    workspace_project_delete_impl(&db, &project_id).unwrap();
    assert!(list_projects(&db).unwrap().is_empty());
}

// ── 多计划弱引用（v87）──────────────────────────────────────────────

const NOW: &str = "2026-11-21T00:00:00Z";

fn insert_phase(db: &Db, plan_id: &str, id: &str, name: &str) -> String {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO planning_milestones
               (id, project_id, name, description, target_date, sort_order, created_at,
                updated_at, kind, start_date, phase_id)
             VALUES (?1, ?2, ?3, '', NULL, 0, ?4, ?4, 'phase', NULL, NULL)",
            rusqlite::params![id, plan_id, name, NOW],
        )?;
        Ok(())
    })
    .unwrap();
    id.to_string()
}

fn insert_task_in_phase(db: &Db, project_id: &str, task_id: &str, phase_id: &str) {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO tasks
               (id, title, description, priority, status, category, tags, advance_minutes,
                created_at, updated_at)
             VALUES (?1, ?1, '', 1, 'pending', '', '[]', 0, ?2, ?2)",
            rusqlite::params![task_id, NOW],
        )?;
        c.execute(
            "INSERT INTO workspace_task_links (project_id, task_id, created_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![project_id, task_id, NOW],
        )?;
        c.execute(
            "INSERT INTO task_plan_links (id, task_id, project_id, phase_id, milestone_id, created_at)
             VALUES (?1, ?2, ?3, ?4, '', ?5)",
            rusqlite::params![format!("tpl-{task_id}"), task_id, project_id, phase_id, NOW],
        )?;
        Ok(())
    })
    .unwrap();
}

fn insert_deliverable(db: &Db, project_id: &str, id: &str, phase_id: &str) {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO project_deliverables
               (id, project_id, phase_id, title, kind, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?1, 'document', 'planned', ?4, ?4)",
            rusqlite::params![id, project_id, phase_id, NOW],
        )?;
        Ok(())
    })
    .unwrap();
}

fn insert_dependency(db: &Db, project_id: &str, id: &str, phase: &str, depends_on: &str) {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO plan_dependencies (id, project_id, phase_id, depends_on_phase_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, project_id, phase, depends_on, NOW],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn deleting_plan_cleans_weak_references_and_keeps_business_entities() {
    let db = memdb();
    let snapshot = create_project(&db, rich_input("plan-refs-1")).unwrap();
    let project_id = snapshot.project.id.clone();
    let plan_a = snapshot.plan_id.clone().expect("初始计划");
    let phase_a1 = snapshot.phases[0].id.clone();

    // A 的关联数据：阶段依赖 + 交付物 + 能力阶段归属。
    insert_phase(&db, &plan_a, "phase-a2", "阶段 A2");
    insert_dependency(&db, &project_id, "dep-a", "phase-a2", &phase_a1);
    insert_deliverable(&db, &project_id, "del-a", &phase_a1);
    db.with_conn(|c| {
        c.execute(
            "UPDATE project_capability_requirements SET phase_id = ?2 WHERE project_id = ?1",
            rusqlite::params![project_id, phase_a1],
        )?;
        // 历史版本：计划 A 的快照，删除计划后必须保留。
        c.execute(
            "INSERT INTO plan_versions
               (id, project_id, plan_id, version_no, snapshot_json, source, created_at)
             VALUES ('ver-a', ?1, ?2, 1, '{}', 'manual', ?3)",
            rusqlite::params![project_id, plan_a, NOW],
        )?;
        Ok(())
    })
    .unwrap();

    // 新建计划 B 并激活，在 B 上创建自己的阶段/任务/交付物。
    let plan_b = create_project_plan(
        &db,
        CreatePlanInput {
            project_id: project_id.clone(),
            name: None,
            description: None,
            target_date: None,
            status: None,
            template_id: None,
            make_active: true,
        },
    )
    .unwrap();
    let phase_b1 = insert_phase(&db, &plan_b, "phase-b1", "阶段 B1");
    insert_task_in_phase(&db, &project_id, "task-b1", &phase_b1);
    insert_deliverable(&db, &project_id, "del-b", &phase_b1);

    // 删除 A（当前 active 是 B，删除非 active 计划）。
    delete_plan(&db, &plan_a).unwrap();

    // 弱引用清理：A 的阶段依赖、阶段归属全部清空；任务/交付物/项目根保留。
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM plan_dependencies WHERE project_id = 'x' OR id = 'dep-a'"),
        0,
        "计划依赖必须随计划删除"
    );
    let capability_phase: Option<String> = db
        .with_conn(|c| {
            c.query_row(
                "SELECT phase_id FROM project_capability_requirements WHERE project_id = ?1",
                rusqlite::params![project_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    assert!(capability_phase.is_none(), "能力需求保留实体但阶段归属清空");
    let deliverable_phase: Option<String> = db
        .with_conn(|c| {
            c.query_row(
                "SELECT phase_id FROM project_deliverables WHERE id = 'del-a'",
                [],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    assert!(
        deliverable_phase.is_none(),
        "交付物保留实体但阶段归属清空，不得静默删除"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM project_deliverables WHERE id = 'del-a'"),
        1
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM tasks WHERE id = 'task-b1'"),
        1,
        "任务实体必须保留"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM workspace_projects"),
        1,
        "项目根必须保留"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM plan_versions WHERE id = 'ver-a'"),
        1,
        "计划历史版本必须保留"
    );

    // B 的快照只返回 B 自己的阶段关联。
    let b_snapshot = get_snapshot(&db, &project_id).unwrap();
    assert_eq!(b_snapshot.plan_id.as_deref(), Some(plan_b.as_str()));
    assert_eq!(b_snapshot.phases.len(), 1);
    assert_eq!(b_snapshot.phases[0].id, phase_b1);
    let b_task = b_snapshot
        .tasks
        .iter()
        .find(|task| task.id == "task-b1")
        .expect("B 的任务必须可见");
    assert_eq!(b_task.phase_id.as_deref(), Some(phase_b1.as_str()));
    // 旧计划遗留任务仍在项目里，但没有阶段归属。
    let legacy = b_snapshot
        .tasks
        .iter()
        .find(|task| task.title == "写世界观大纲")
        .expect("A 的任务作为项目级实体保留");
    assert!(legacy.phase_id.is_none(), "旧阶段不得串到 B");

    // 完整性：无 blocking，且只剩「历史版本属于已删除计划」这类 warning。
    let report = validate_project_integrity(&db, &project_id).unwrap();
    assert!(report.ok, "完整性不得有阻塞项: {:?}", report.blocking);
    assert!(
        report.warnings.iter().any(|w| w.contains("计划版本")),
        "计划版本保留必须显式作为 warning: {:?}",
        report.warnings
    );
}

#[test]
fn deleting_active_plan_switches_to_successor_and_cleans_task_links() {
    let db = memdb();
    let snapshot = create_project(&db, rich_input("plan-refs-2")).unwrap();
    let project_id = snapshot.project.id.clone();
    let plan_a = snapshot.plan_id.clone().expect("初始计划");
    let phase_a1 = snapshot.phases[0].id.clone();

    let plan_b = create_project_plan(
        &db,
        CreatePlanInput {
            project_id: project_id.clone(),
            name: None,
            description: None,
            target_date: None,
            status: None,
            template_id: None,
            make_active: false,
        },
    )
    .unwrap();
    let _phase_b1 = insert_phase(&db, &plan_b, "phase-b2", "阶段 B2");

    // A 仍是 active：删除 A 必须切换到 B 并更新项目指针。
    delete_plan(&db, &plan_a).unwrap();
    let pointer: Option<String> = db
        .with_conn(|c| {
            c.query_row(
                "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
                rusqlite::params![project_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    assert_eq!(pointer.as_deref(), Some(plan_b.as_str()));

    // A 阶段的计划级任务关联清空，但任务实体与项目级关联保留。
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM task_plan_links WHERE project_id = '{project_id}' AND phase_id = '{phase_a1}'"
            )
        ),
        0
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM tasks WHERE title = '写世界观大纲'"),
        1
    );
    assert_eq!(
        count(
            &db,
            &format!("SELECT COUNT(*) FROM workspace_task_links WHERE project_id = '{project_id}'")
        ),
        1
    );

    // B 阶段不受影响。
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM planning_milestones WHERE id = 'phase-b2'"),
        1
    );
}

#[test]
fn plan_name_must_mirror_project_name() {
    let db = memdb();
    let snapshot = create_project(&db, rich_input("plan-name-1")).unwrap();
    let project_id = snapshot.project.id.clone();

    // 与项目名一致：允许（旧调用方显式传镜像值时不报错）。
    let mirrored = create_project_plan(
        &db,
        CreatePlanInput {
            project_id: project_id.clone(),
            name: Some(snapshot.project.name.clone()),
            description: None,
            target_date: None,
            status: None,
            template_id: None,
            make_active: false,
        },
    )
    .unwrap();
    let stored: String = text(
        &db,
        &format!("SELECT name FROM planning_projects WHERE id = '{mirrored}'"),
    );
    assert_eq!(stored, snapshot.project.name);

    // 独立命名：拒绝，避免项目重命名时互相矛盾。
    let error = create_project_plan(
        &db,
        CreatePlanInput {
            project_id: project_id.clone(),
            name: Some("独立命名的计划".into()),
            description: None,
            target_date: None,
            status: None,
            template_id: None,
            make_active: false,
        },
    )
    .unwrap_err();
    assert!(matches!(error, AppError::Validation(_)), "{error:?}");

    // 项目重命名同步到全部计划名称（唯一事实来源）。
    task_dock_lib::project_hub::service::update_project(
        &db,
        &project_id,
        RootPatch {
            name: Some("改名后的项目".into()),
            expected_project_revision: Some(snapshot.project.revision),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM planning_projects
                  WHERE workspace_project_id = '{project_id}' AND name = '改名后的项目'"
            )
        ),
        2,
        "项目重命名必须同步全部计划名称"
    );
}
