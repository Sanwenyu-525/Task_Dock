//! v78 项目中枢迁移集成测试。
//!
//! 库内测试二进制在当前 Windows 环境存在加载器启动问题（0xc0000139），
//! 因此迁移测试放在独立集成测试目标，避免被库测试 harness 阻断。

use rusqlite::Connection;
use task_dock_lib::db::{apply_migrations, migrations_for_test};

fn conn_at_v77() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    let migrations = migrations_for_test();
    let idx78 = migrations.iter().position(|(v, _)| *v == 78).unwrap();
    apply_migrations(&conn, 0, &migrations[..idx78]).unwrap();
    conn
}

fn seed_plan(conn: &Connection, id: &str, name: &str, status: &str) {
    conn.execute(
        "INSERT INTO planning_projects
         (id, name, description, target_date, archived, status, created_at, updated_at, revision)
         VALUES (?1, ?2, 'desc', '2026-12-31', 0, ?3,
                 '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z', 1)",
        rusqlite::params![id, name, status],
    )
    .unwrap();
}

#[test]
fn v78_backfills_plan_into_workspace_root_and_collab() {
    let conn = conn_at_v77();
    seed_plan(&conn, "p1", "项目一", "planning");
    conn.execute(
        "INSERT INTO planning_milestones
         (id, project_id, name, target_date, sort_order, created_at, updated_at)
         VALUES ('m1', 'p1', '里程碑', NULL, 0,
                 '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO collab_issues
         (id, project_id, kind, title, priority, created_at, updated_at)
         VALUES ('i1', 'p1', 'bug', '问题', 'P2',
                 '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')",
        [],
    )
    .unwrap();

    apply_migrations(&conn, 77, migrations_for_test()).unwrap();

    let (link, active): (String, i64) = conn
        .query_row(
            "SELECT workspace_project_id, is_active FROM planning_projects WHERE id='p1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(link, "p1");
    assert_eq!(active, 1);

    let (root_id, plan_id, target): (String, String, String) = conn
        .query_row(
            "SELECT id, active_plan_id, target_date FROM workspace_projects WHERE id='p1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(root_id, "p1");
    assert_eq!(plan_id, "p1");
    assert_eq!(target, "2026-12-31");

    let collab_root: String = conn
        .query_row(
            "SELECT workspace_project_id FROM collab_issues WHERE id='i1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(collab_root, "p1");

    let phase_kind: String = conn
        .query_row("SELECT kind FROM planning_milestones WHERE id='m1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(phase_kind, "milestone");
}

#[test]
fn v78_uses_plan_prefix_on_project_id_collision() {
    let conn = conn_at_v77();
    seed_plan(&conn, "same-id", "计划", "planning");
    conn.execute(
        "INSERT INTO workspace_projects
         (id, name, kind, status, root_path, note, created_at, updated_at)
         VALUES ('same-id', '既有项目', 'general', 'active', '', '',
                 '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')",
        [],
    )
    .unwrap();

    apply_migrations(&conn, 77, migrations_for_test()).unwrap();

    let link: String = conn
        .query_row(
            "SELECT workspace_project_id FROM planning_projects WHERE id='same-id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(link, "plan-same-id");
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workspace_projects WHERE id='plan-same-id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
}

#[test]
fn v78_enforces_single_active_plan_per_project() {
    let conn = conn_at_v77();
    apply_migrations(&conn, 77, migrations_for_test()).unwrap();

    let insert = |id: &str| {
        conn.execute(
            "INSERT INTO planning_projects
             (id, name, workspace_project_id, is_active, created_at, updated_at)
             VALUES (?1, '计划', 'proj', 1,
                     '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')",
            [id],
        )
    };
    insert("p3").unwrap();
    assert!(insert("p4").is_err(), "同一项目只能有一个 active 计划");
}

#[test]
fn v78_new_tables_use_workspace_root_and_cascade() {
    let conn = conn_at_v77();
    seed_plan(&conn, "p1", "项目", "planning");
    apply_migrations(&conn, 77, migrations_for_test()).unwrap();

    conn.execute(
        "INSERT INTO project_goals
         (id, project_id, title, created_at, updated_at)
         VALUES ('g1', 'p1', '目标', 'now', 'now')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO project_capabilities
         (id, name, category, created_at, updated_at)
         VALUES ('c1', '写作', 'human', 'now', 'now')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO project_capability_requirements
         (id, project_id, capability_id, created_at, updated_at)
         VALUES ('r1', 'p1', 'c1', 'now', 'now')",
        [],
    )
    .unwrap();

    conn.execute("DELETE FROM workspace_projects WHERE id='p1'", [])
        .unwrap();
    let goals: i64 = conn
        .query_row("SELECT COUNT(*) FROM project_goals", [], |r| r.get(0))
        .unwrap();
    let reqs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project_capability_requirements",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let caps: i64 = conn
        .query_row("SELECT COUNT(*) FROM project_capabilities", [], |r| r.get(0))
        .unwrap();
    assert_eq!(goals, 0);
    assert_eq!(reqs, 0);
    assert_eq!(caps, 1);
}
