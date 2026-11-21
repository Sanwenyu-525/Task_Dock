//! 统一项目身份与创建服务（集成测试）。
//!
//! 为什么用集成测试而不是 lib 单测：本轮验证时 `cargo test --lib` 的测试二进制在
//! 本机加载阶段失败（`0xC0000139`，与工作树内其他会话的在途改动有关），
//! 集成测试只链接 lib 的 rlib，可以独立跑通并留下可复现证据。
//!
//! 覆盖：项目根/初始计划同事务、计划→项目反解析、多计划 active 切换、
//! 幂等重放与摘要冲突、三种目录模式、创建失败补偿、孤儿目录恢复、Agent 项目身份。

use task_dock_lib::db::Db;
use task_dock_lib::project_hub::creation::{
    create, AgentAccessPolicy, CreateProjectRequest, DirectoryMode, InitialPlanDraft,
};
use task_dock_lib::project_hub::service::{resolve_project_ref, ProjectRef};

fn request(name: &str, request_id: &str) -> CreateProjectRequest {
    CreateProjectRequest {
        client_request_id: request_id.into(),
        name: name.into(),
        kind: "general".into(),
        description: "描述".into(),
        goal: "目标".into(),
        target_date: None,
        template_id: None,
        root_path: None,
        directory_mode: DirectoryMode::MetadataOnly,
        dev_project_id: None,
        note: None,
        plan_name: None,
        plan_description: None,
        plan_status: None,
        draft: InitialPlanDraft::default(),
        agent_access_policy: AgentAccessPolicy::None,
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "taskdock-it-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    dir
}

#[test]
fn creates_project_root_and_active_plan_together() {
    let db = Db::open_in_memory().unwrap();
    let created = create(&db, request("统一项目", "it-1")).unwrap();
    assert!(created.created);
    assert_ne!(created.project.id, created.active_plan.id);
    assert_eq!(
        created.project.active_plan_id.as_deref(),
        Some(created.active_plan.id.as_str())
    );
    assert_eq!(created.active_plan.project_id, created.project.id);
    assert_eq!(created.provisioning_status, "metadata_only");
}

#[test]
fn plan_id_resolves_back_to_project_root() {
    let db = Db::open_in_memory().unwrap();
    let created = create(&db, request("解析项目", "it-2")).unwrap();
    let resolved = db
        .with_read(|conn| resolve_project_ref(conn, &created.active_plan.id))
        .unwrap()
        .expect("计划 ID 必须能反解析到项目根");
    assert_eq!(
        resolved,
        ProjectRef::Plan {
            plan_id: created.active_plan.id.clone(),
            project_id: created.project.id.clone(),
        }
    );
}

#[test]
fn second_plan_does_not_steal_active_until_activated() {
    let db = Db::open_in_memory().unwrap();
    let created = create(&db, request("多计划项目", "it-3")).unwrap();
    let second = task_dock_lib::project_hub::service::create_project_plan(
        &db,
        task_dock_lib::project_hub::service::CreatePlanInput {
            project_id: created.project.id.clone(),
            name: None,
            description: None,
            target_date: None,
            status: Some("planning".into()),
            template_id: None,
            make_active: false,
        },
    )
    .unwrap();
    let active_after_create: Option<String> = db
        .with_read(|conn| {
            conn.query_row(
                "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
                [&created.project.id],
                |r| r.get(0),
            )
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(
        active_after_create.as_deref(),
        Some(created.active_plan.id.as_str())
    );

    let project_id = task_dock_lib::project_hub::service::activate_plan(&db, &second).unwrap();
    assert_eq!(project_id, created.project.id);
    let active_after_switch: Option<String> = db
        .with_read(|conn| {
            conn.query_row(
                "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
                [&created.project.id],
                |r| r.get(0),
            )
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(active_after_switch.as_deref(), Some(second.as_str()));
}

#[test]
fn idempotent_replay_and_digest_conflict() {
    let db = Db::open_in_memory().unwrap();
    let first = create(&db, request("幂等项目", "it-same")).unwrap();
    let second = create(&db, request("幂等项目", "it-same")).unwrap();
    assert!(!second.created, "同参重放必须返回既有结果");
    assert_eq!(first.project.id, second.project.id);

    let error = create(&db, request("另一个名字", "it-same")).unwrap_err();
    assert!(
        matches!(error, task_dock_lib::error::AppError::Conflict(_)),
        "同请求 ID 不同参数必须冲突：{error:?}"
    );
}

#[test]
fn metadata_only_rejects_root_path() {
    let db = Db::open_in_memory().unwrap();
    let mut input = request("元数据项目", "it-meta");
    input.root_path = Some("C:\\tmp".into());
    let error = create(&db, input).unwrap_err();
    assert!(matches!(
        error,
        task_dock_lib::error::AppError::Validation(_)
    ));
}

#[test]
fn attach_existing_allows_offline_but_rejects_file() {
    let db = Db::open_in_memory().unwrap();
    let dir = temp_dir("attach");
    let missing = dir.join("not-created");
    let mut offline = request("离线项目", "it-offline");
    offline.root_path = Some(missing.to_string_lossy().to_string());
    offline.directory_mode = DirectoryMode::AttachExisting;
    let created = create(&db, offline).unwrap();
    assert_eq!(created.provisioning_status, "attached_offline");
    assert!(!created.workspace.root_exists);

    let file = dir.join("note.txt");
    std::fs::write(&file, b"x").unwrap();
    let mut by_file = request("文件项目", "it-file");
    by_file.root_path = Some(file.to_string_lossy().to_string());
    by_file.directory_mode = DirectoryMode::AttachExisting;
    assert!(create(&db, by_file).is_err(), "文件不能当工作目录");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn create_new_makes_directory_and_rejects_existing_target() {
    let db = Db::open_in_memory().unwrap();
    let parent = temp_dir("create-new");
    let target = parent.join("project");
    let mut input = request("新目录项目", "it-create-new");
    input.root_path = Some(target.to_string_lossy().to_string());
    input.directory_mode = DirectoryMode::CreateNew;
    let created = create(&db, input).unwrap();
    assert_eq!(created.provisioning_status, "created");
    assert!(target.is_dir());

    let mut again = request("重复目录", "it-create-new-2");
    again.root_path = Some(target.to_string_lossy().to_string());
    again.directory_mode = DirectoryMode::CreateNew;
    assert!(matches!(
        create(&db, again).unwrap_err(),
        task_dock_lib::error::AppError::Conflict(_)
    ));
    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn failed_transaction_removes_only_new_empty_directory() {
    let db = Db::open_in_memory().unwrap();
    let parent = temp_dir("rollback");
    let target = parent.join("boom");
    // 注入故障：初始计划要写的表被删除，事务在目录创建之后失败。
    db.with_transaction(|conn| {
        conn.execute_batch("DROP TABLE planning_milestones")?;
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .unwrap();

    let mut input = request("回滚项目", "it-rollback");
    input.root_path = Some(target.to_string_lossy().to_string());
    input.directory_mode = DirectoryMode::CreateNew;
    input.draft.phases = vec![task_dock_lib::project_hub::service::CreatePhaseInput {
        name: "阶段".into(),
        description: String::new(),
        target_date: None,
        start_date: None,
        milestones: vec![],
    }];
    assert!(create(&db, input).is_err());
    assert!(!target.exists(), "失败后必须移除本次创建的空目录");

    let projects: i64 = db
        .with_read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM workspace_projects", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(projects, 0, "事务失败不得留下项目根");
    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn agent_capability_check_uses_project_root() {
    // 迁移必须带上 projects.create / projects.write，否则 Agent 无法被显式授权。
    let db = Db::open_in_memory().unwrap();
    db.with_read(|conn| {
        let sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_agent_capabilities'",
            [],
            |r| r.get(0),
        )?;
        for capability in ["projects.create", "projects.write"] {
            assert!(
                sql.contains(capability),
                "能力表 CHECK 缺少 {capability}：{sql}"
            );
        }
        Ok(())
    })
    .unwrap();
}

// ── Agent 身份与授权 ────────────────────────────────────────────────

fn seed_agent(db: &Db, agent_row_id: &str, agent_id: &str, capabilities: &[(&str, &str)]) {
    let now = "2026-11-21T00:00:00Z";
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO mcp_agents (id, agent_id, display_name, token_hash, scope, created_at, updated_at)
             VALUES (?1, ?2, '', 'hash', 'readonly', ?3, ?3)",
            [agent_row_id, agent_id, now],
        )?;
        for (capability, resource_id) in capabilities {
            conn.execute(
                "INSERT INTO mcp_agent_capabilities
                 (id, agent_row_id, capability, resource_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    format!("{agent_row_id}-{capability}-{resource_id}"),
                    agent_row_id,
                    capability,
                    resource_id,
                    now
                ],
            )?;
        }
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .unwrap();
}

#[test]
fn grants_are_stored_on_project_root_and_survive_plan_ids() {
    let db = Db::open_in_memory().unwrap();
    let created = create(&db, request("授权项目", "it-grant")).unwrap();
    seed_agent(&db, "agent-row-1", "claude", &[]);
    task_dock_lib::agent_access::permissions::grant_created_project(
        &db,
        "agent-row-1",
        &created.project.id,
    )
    .unwrap();
    let grants: Vec<String> = db
        .with_read(|conn| {
            let mut stmt =
                conn.prepare("SELECT project_id FROM mcp_agent_grants ORDER BY project_id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .unwrap();
    assert_eq!(grants, vec![created.project.id.clone()], "授权只能挂项目根");
    // 外键必须指向项目根：删除项目时授权跟着清理。
    db.with_transaction(|conn| {
        conn.execute("DELETE FROM workspace_projects WHERE id = ?1", [&created.project.id])?;
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .unwrap();
    let remaining: i64 = db
        .with_read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM mcp_agent_grants", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(remaining, 0, "项目删除后授权必须级联清理");
}

#[test]
fn agent_lists_one_row_per_project_and_plan_id_maps_to_root() {
    let db = Db::open_in_memory().unwrap();
    let a = create(&db, request("项目 A", "it-list-a")).unwrap();
    let b = create(&db, request("项目 B", "it-list-b")).unwrap();
    seed_agent(
        &db,
        "agent-row-2",
        "codex",
        &[("projects.read", ""), ("plans.read", "")],
    );
    let principal = task_dock_lib::agent_access::Principal::agent(
        "agent-row-2".into(),
        "codex".into(),
        task_dock_lib::agent_access::Source::Cli,
    );
    let (projects, page) = task_dock_lib::agent_access::service::list_projects(
        &db, &principal, None, None, 50, 0,
    )
    .unwrap();
    assert_eq!(page.total, 2, "同一项目不得返回两行");
    assert_eq!(projects.len(), 2);
    assert!(projects.iter().any(|p| p.id == a.project.id));
    assert!(projects.iter().any(|p| p.id == b.project.id));

    // 用计划 ID 取详情：返回的 projectId 必须是项目根，planId 是计划。
    let detail = task_dock_lib::agent_access::service::get_project(
        &db,
        &principal,
        &a.active_plan.id,
    )
    .unwrap();
    assert_eq!(detail.project_id, a.project.id);
    assert_eq!(detail.plan_id.as_deref(), Some(a.active_plan.id.as_str()));
    assert_eq!(
        detail.active_plan_id.as_deref(),
        Some(a.active_plan.id.as_str())
    );
    assert_eq!(detail.plans.len(), 1);
}

#[test]
fn cross_project_read_is_denied_even_with_plan_grants() {
    let db = Db::open_in_memory().unwrap();
    let a = create(&db, request("项目 A2", "it-scope-a")).unwrap();
    let b = create(&db, request("项目 B2", "it-scope-b")).unwrap();
    // 只授予 A 的项目读取（项目级作用域），B 完全不可见。
    seed_agent(
        &db,
        "agent-row-3",
        "cursor",
        &[("projects.read", &a.project.id)],
    );
    let principal = task_dock_lib::agent_access::Principal::agent(
        "agent-row-3".into(),
        "cursor".into(),
        task_dock_lib::agent_access::Source::Rest,
    );
    assert!(
        task_dock_lib::agent_access::service::get_project(&db, &principal, &a.project.id).is_ok()
    );
    let denied =
        task_dock_lib::agent_access::service::get_project(&db, &principal, &b.project.id).unwrap_err();
    assert!(
        matches!(
            denied,
            task_dock_lib::error::AppError::Forbidden(_) | task_dock_lib::error::AppError::Agent(_)
        ),
        "跨项目读取必须被拒绝：{denied:?}"
    );
    // 拿 B 的计划 ID 也不能绕过项目归属。
    let denied_by_plan =
        task_dock_lib::agent_access::service::get_project(&db, &principal, &b.active_plan.id)
            .unwrap_err();
    assert!(matches!(
        denied_by_plan,
        task_dock_lib::error::AppError::Forbidden(_) | task_dock_lib::error::AppError::Agent(_)
    ));
}

// ── 第二轮：稳定性回归（幂等顺序 / 恢复并发 / 路径安全） ──────────────

fn request_with_dir(
    name: &str,
    request_id: &str,
    path: &std::path::Path,
    mode: DirectoryMode,
) -> CreateProjectRequest {
    let mut input = request(name, request_id);
    input.root_path = Some(path.to_string_lossy().to_string());
    input.directory_mode = mode;
    input
}

fn project_count(db: &Db) -> i64 {
    db.with_read(|conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM workspace_projects", [], |r| r.get(0))?)
    })
    .unwrap()
}

#[test]
fn create_new_replay_is_idempotent_and_keeps_directory() {
    let db = Db::open_in_memory().unwrap();
    let parent = temp_dir("replay-create-new");
    let target = parent.join("proj");
    let input = request_with_dir("新目录重放", "it-replay-create-new", &target, DirectoryMode::CreateNew);
    let first = create(&db, input.clone()).unwrap();
    assert!(first.created);
    // 回归：旧实现走完目录初始化才判幂等，第二次相同请求会因目录已存在返回 Conflict。
    let second = create(&db, input).unwrap();
    assert!(!second.created);
    assert_eq!(second.project.id, first.project.id);
    assert_eq!(second.active_plan.id, first.active_plan.id);
    assert!(target.is_dir(), "重放不得删除已提交项目的目录");
    assert_eq!(project_count(&db), 1);
    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn create_new_replay_with_changed_parameters_conflicts() {
    let db = Db::open_in_memory().unwrap();
    let parent = temp_dir("replay-conflict");
    let target = parent.join("proj");
    let input = request_with_dir("原项目", "it-replay-conflict", &target, DirectoryMode::CreateNew);
    create(&db, input).unwrap();
    let changed = request_with_dir("改名项目", "it-replay-conflict", &target, DirectoryMode::CreateNew);
    let error = create(&db, changed).unwrap_err();
    assert!(
        matches!(error, task_dock_lib::error::AppError::Conflict(_)),
        "同一请求 ID 换参数必须冲突：{error:?}"
    );
    assert_eq!(project_count(&db), 1);
    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn attach_replay_survives_offline_directory() {
    let db = Db::open_in_memory().unwrap();
    let dir = temp_dir("replay-attach");
    let target = dir.join("ws");
    std::fs::create_dir_all(&target).unwrap();
    let input = request_with_dir("关联重放", "it-replay-attach", &target, DirectoryMode::AttachExisting);
    let first = create(&db, input.clone()).unwrap();
    assert_eq!(first.provisioning_status, "attached");
    std::fs::remove_dir(&target).unwrap();
    let second = create(&db, input).unwrap();
    assert!(!second.created);
    assert_eq!(second.project.id, first.project.id);
    assert!(!second.workspace.root_exists);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_same_request_id_creates_one_project() {
    let db = std::sync::Arc::new(Db::open_in_memory().unwrap());
    let input = request("并发项目", "it-concurrent");
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let db = db.clone();
            let input = input.clone();
            std::thread::spawn(move || {
                create(&db, input)
                    .map(|r| (r.created, r.project.id))
                    .map_err(|e| e.to_string())
            })
        })
        .collect();
    let results: Vec<Result<(bool, String), String>> =
        handles.into_iter().map(|h| h.join().unwrap()).collect();
    let winners = results
        .iter()
        .filter(|r| matches!(r, Ok((created, _)) if *created))
        .count();
    assert_eq!(winners, 1, "同一请求 ID 只能有一个创建者：{results:?}");
    let ids: std::collections::HashSet<String> = results
        .iter()
        .filter_map(|r| r.as_ref().ok().map(|(_, id)| id.clone()))
        .collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(project_count(&db), 1);
}

#[test]
fn unc_relative_and_verbatim_paths_are_rejected() {
    let db = Db::open_in_memory().unwrap();
    for (index, raw) in [r"\\server\share\proj", r"\\?\C:/proj", r"relative\dir", r"C:proj"]
        .iter()
        .enumerate()
    {
        let mut input = request("路径项目", &format!("it-path-{index}"));
        input.root_path = Some((*raw).to_string());
        input.directory_mode = DirectoryMode::AttachExisting;
        let error = create(&db, input).unwrap_err();
        assert!(
            matches!(error, task_dock_lib::error::AppError::Validation(_)),
            "{raw} 应被拒绝：{error:?}"
        );
    }
}

#[test]
fn recover_pending_cleans_orphan_but_keeps_referenced_directory() {
    use task_dock_lib::project_hub::creation::recover_pending;

    let db = Db::open_in_memory().unwrap();
    let orphan = temp_dir("it-orphan").join("empty");
    std::fs::create_dir(&orphan).unwrap();
    let kept = temp_dir("it-kept");

    // 先建项目并引用 kept：恢复只能清日志，不能删已被引用的目录。
    let input = request_with_dir("引用项目", "it-kept", &kept, DirectoryMode::AttachExisting);
    create(&db, input).unwrap();

    // 再写入恢复日志（模拟「建目录后崩溃」留下的条目）。
    let journal = serde_json::json!([
        {
            "opId": "op-orphan",
            "path": orphan.to_string_lossy(),
            "state": "created",
            "pid": std::process::id(),
            "leaseUntilMs": 0,
            "clientRequestId": "it-orphan",
            "createdAt": "2026-11-21T20:00:00+08:00"
        },
        {
            "opId": "op-kept",
            "path": kept.to_string_lossy(),
            "state": "created",
            "pid": std::process::id(),
            "leaseUntilMs": 0,
            "clientRequestId": "it-kept",
            "createdAt": "2026-11-21T20:00:00+08:00"
        }
    ])
    .to_string();
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                "project_provisioning_journal",
                journal,
                "2026-11-21T20:00:00+08:00"
            ],
        )?;
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .unwrap();

    let removed = recover_pending(&db).unwrap();
    assert_eq!(removed, 1, "只清理孤儿空目录");
    assert!(!orphan.exists(), "孤儿空目录应被清理");
    assert!(kept.is_dir(), "被项目引用的目录不得删除");
    let left: Option<String> = db
        .with_read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM application_settings WHERE key = ?1",
                    rusqlite::params!["project_provisioning_journal"],
                    |r| r.get(0),
                )
                .ok())
        })
        .unwrap();
    assert!(left.is_none(), "已处置条目必须出清：{left:?}");
    let _ = std::fs::remove_dir_all(kept.parent().unwrap_or(&kept));
}
