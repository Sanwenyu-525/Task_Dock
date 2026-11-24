//! Phase 1 领域架构验收：Manifest 授权、MCP 写事务、revision、分页与数据最小化。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::db::Db;
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions as mcp_perm;
use crate::mcp::tools::{run_tool_call, ToolCtx};

use super::domains::{comic, manifest, novel, registry};
use super::{Principal, Source};

fn memdb() -> Arc<Db> {
    Arc::new(Db::open_in_memory().unwrap())
}

fn seed_project(db: &Db, kind: &str, status: &str, root: &str) -> String {
    // 生产项目 ID 是 UUID；测试 ID 也不能把 kind 编进去，否则「错误信息泄露类型」
    // 的断言会被测试自身制造的字面量污染。
    let id = format!("p-{}", uuid::Uuid::new_v4());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO workspace_projects
               (id,name,kind,status,root_path,dev_project_id,note,created_at,updated_at)
             VALUES (?1,'领域测试项目',?2,?3,?4,NULL,'','2026-01-01','2026-01-01')",
            rusqlite::params![id, kind, status, root],
        )?;
        Ok(())
    })
    .unwrap();
    id
}

fn seed_chapter(db: &Db, project: &str, id: &str, content: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO novel_volumes
               (id, project_id, title, sort_order, created_at, updated_at)
             VALUES ('v1', ?1, '第一卷', 0, '2026-01-01', '2026-01-01')",
            [project],
        )
        .ok();
        conn.execute(
            "INSERT INTO novel_chapters
               (id, project_id, volume_id, title, content, word_count, sort_order, created_at, updated_at)
             VALUES (?1, ?2, 'v1', '第01章', ?3, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![id, project, content],
        )?;
        Ok(())
    })
    .unwrap();
}

fn seed_shot(db: &Db, project: &str, id: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO comic_episodes
               (id, project_id, episode_no, title, synopsis, script, status, progress,
                character_ids_json, sort_order, created_at, updated_at)
             VALUES ('ep1', ?1, 1, '第1集', '梗概', 'SECRET SCRIPT', 'draft', 0, '[]', 0,
                '2026-01-01','2026-01-01')",
            [project],
        )?;
        conn.execute(
            "INSERT INTO comic_shots
               (id, project_id, episode_id, shot_no, description, character_ids_json,
                scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                asset_refs_json, note, sort_order, created_at, updated_at)
             VALUES (?1, ?2, 'ep1', 1, '镜头', '[]', NULL, '', '', '', 0, 'todo',
                '[]', '', 0, '2026-01-01', '2026-01-01')",
            rusqlite::params![id, project],
        )?;
        Ok(())
    })
    .unwrap();
}

fn seed_media(db: &Db, project: &str, media: &str, path: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO comic_media_versions
               (id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                version_label, status, review_note, source, created_at, updated_at)
             VALUES (?1, ?2, 'shot1', NULL, NULL, ?3, 'image', 'v1', 'candidate', '',
                'imported', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![media, project, path],
        )?;
        Ok(())
    })
    .unwrap();
}

/// 创建真实 RegisteredAgent；`caps` 为全局能力，`projects` 为显式项目授权。
fn agent(
    db: &Db,
    suffix: &str,
    scope: &str,
    caps: &[&str],
    projects: &[&str],
) -> (Principal, String) {
    let created = mcp_auth::create_agent(db, &format!("domain-{suffix}"), "领域测试 Agent")
        .expect("创建 Agent");
    mcp_auth::set_agent_scope(db, &created.info.id, scope).expect("设置 scope");
    for cap in caps {
        mcp_perm::grant(db, &created.info.id, cap, "").expect("授予能力");
    }
    for project in projects {
        mcp_auth::grant_project(db, &created.info.id, project).expect("授予项目");
    }
    let principal = Principal::agent(
        created.info.id.clone(),
        created.info.agent_id.clone(),
        Source::Mcp,
    );
    (principal, created.token)
}

fn agent_row(db: &Db, token: &str) -> crate::mcp::auth::McpAgentRow {
    db.with_conn(|conn| mcp_auth::find_agent_by_token(conn, token))
        .unwrap()
        .unwrap()
}

fn collector() -> crate::mcp::ChangeEmitter {
    Arc::new(|_| {})
}

fn call_mcp(ctx: &ToolCtx, name: &str, args: Value) -> Value {
    run_tool_call(ctx, name, &args).unwrap_or_else(|e| panic!("{name} RPC 失败: {e:?}"))
}

fn mcp_ok(ctx: &ToolCtx, name: &str, args: Value) -> Value {
    let result = call_mcp(ctx, name, args);
    assert_eq!(result["isError"], false, "{name}: {result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn mcp_err(ctx: &ToolCtx, name: &str, args: Value) -> Value {
    let result = call_mcp(ctx, name, args);
    assert_eq!(result["isError"], true, "{name}: {result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn operations_of(db: &Db, action: &str) -> Vec<(String, String, String, String, Option<i64>)> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT resource_kind, resource_id, project_id, status, revision
             FROM agent_operations WHERE action = ?1 ORDER BY started_at, id",
        )?;
        let rows = stmt.query_map([action], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get::<_, Option<i64>>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
    .unwrap()
}

// ── Manifest 授权 ────────────────────────────────────────────────

#[test]
fn manifest_requires_project_grant_for_project_rw_agent() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    let (p, _) = agent(&db, "no-grant", "project_rw", &["projects.read"], &[]);
    let err = manifest::build_for_principal(&db, &p, &project).unwrap_err();
    assert!(err.to_string().contains("未授权"), "{err}");
    assert!(!err.to_string().contains("novel"), "错误不得暴露项目类型");
}

#[test]
fn manifest_rejects_other_project_grant() {
    let db = memdb();
    let mine = seed_project(&db, "novel", "active", "");
    let other = seed_project(&db, "novel", "active", "");
    let (p, _) = agent(
        &db,
        "other-grant",
        "project_rw",
        &["projects.read"],
        &[&other],
    );
    assert!(manifest::build_for_principal(&db, &p, &mine).is_err());
    assert!(manifest::build_for_principal(&db, &p, &other).is_ok());
}

#[test]
fn readonly_and_disabled_revoked_scope_rules_hold_for_manifest() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");

    let (readonly, _) = agent(&db, "readonly", "readonly", &["projects.read"], &[]);
    assert!(
        manifest::build_for_principal(&db, &readonly, &project).is_ok(),
        "readonly 是全局只读，不应要求逐项目 grant"
    );

    let (disabled, _) = agent(&db, "disabled", "disabled", &["projects.read"], &[&project]);
    assert!(manifest::build_for_principal(&db, &disabled, &project).is_err());

    let (revoked, _) = agent(&db, "revoked", "project_rw", &["projects.read"], &[&project]);
    mcp_auth::revoke_agent(&db, revoked.agent_row_id.as_deref().unwrap()).unwrap();
    assert!(manifest::build_for_principal(&db, &revoked, &project).is_err());
}

#[test]
fn manifest_does_not_leak_kind_before_project_authorization() {
    let db = memdb();
    // 未授权 Agent 看两个不同 kind 的项目，错误必须一致（Forbidden），不能出现类型校验错误。
    let novel = seed_project(&db, "novel", "active", "");
    let comic = seed_project(&db, "ai_comic", "active", "");
    let (p, _) = agent(&db, "no-leak", "project_rw", &["projects.read"], &[]);
    let a = manifest::build_for_principal(&db, &p, &novel).unwrap_err();
    let b = manifest::build_for_principal(&db, &p, &comic).unwrap_err();
    assert!(
        !a.to_string().contains("novel"),
        "未授权错误不得暴露 novel 类型: {a}"
    );
    assert!(
        !b.to_string().contains("ai_comic") && !b.to_string().contains("comic"),
        "未授权错误不得暴露 comic 类型: {b}"
    );
}

#[test]
fn manifest_maps_five_kinds_and_separates_comic_kind_from_domain() {
    let db = memdb();
    let p = Principal::local(Source::Cli);
    for (kind, domain) in [
        ("novel", "novel"),
        ("ai_comic", "comic"),
        ("game", "game"),
        ("general", "general"),
        ("development", "development"),
    ] {
        let project = seed_project(&db, kind, "active", "");
        let m = manifest::build_for_principal(&db, &p, &project).unwrap();
        let value = serde_json::to_value(&m).unwrap();
        assert_eq!(value["project"]["kind"], kind);
        assert_eq!(value["domain"], domain);
        if domain == "comic" {
            assert_eq!(value["project"]["kind"], "ai_comic");
        }
        let operations = value["operations"].as_array().unwrap();
        assert!(!operations.is_empty(), "{kind} 有实际开放的操作");
        assert!(operations.iter().all(|op| op["id"].as_str().unwrap().split('.').next() == Some(domain)));
    }
}

#[test]
fn manifest_operations_match_the_owning_domain_only() {
    let db = memdb();
    let p = Principal::local(Source::Cli);
    let novel_project = seed_project(&db, "novel", "active", "");
    let comic_project = seed_project(&db, "ai_comic", "active", "");
    let novel_manifest = manifest::build_for_principal(&db, &p, &novel_project).unwrap();
    assert!(novel_manifest.operations.iter().all(|o| o.id.starts_with("novel.")));
    let comic_manifest = manifest::build_for_principal(&db, &p, &comic_project).unwrap();
    assert!(comic_manifest.operations.iter().all(|o| o.id.starts_with("comic.")));
    let ids: Vec<&str> = registry::all_operations().iter().map(|o| o.id).collect();
    for op in novel_manifest.operations.iter().chain(comic_manifest.operations.iter()) {
        assert!(ids.contains(&op.id.as_str()), "Manifest 含未注册操作 {}", op.id);
    }
}

#[test]
fn novel_and_comic_reference_reads_do_not_reenter_the_database_lock() {
    let db = memdb();
    let novel_project = seed_project(&db, "novel", "active", "");
    let comic_project = seed_project(&db, "ai_comic", "active", "");
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let principal = Principal::local(Source::Cli);
        novel::list_characters(&db, &principal, &novel_project, None, None, None).unwrap();
        novel::list_worldview(&db, &principal, &novel_project, None, None, None, None).unwrap();
        novel::list_refs(&db, &principal, &novel_project, None, None, None, None).unwrap();
        comic::list_characters(&db, &principal, &comic_project, None, None).unwrap();
        comic::list_scenes(&db, &principal, &comic_project, None, None).unwrap();
        sender.send(()).unwrap();
    });
    receiver.recv_timeout(Duration::from_secs(10)).expect("领域读取不能嵌套获取同一数据库锁");
    worker.join().unwrap();
}

// ── MCP 写事务：死锁、幂等、Operation、失败回滚 ────────────────────

#[test]
fn mcp_domain_write_does_not_deadlock_with_outer_transaction() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "初始正文");
    let (_, token) = agent(
        &db,
        "deadlock",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let (tx, rx) = std::sync::mpsc::channel();
    let db_for_thread = db.clone();
    let project_for_thread = project.clone();
    std::thread::spawn(move || {
        let row = agent_row(&db_for_thread, &token);
        let ctx = ToolCtx {
            db: db_for_thread,
            agent: row,
            emit: collector(),
        };
        let result = call_mcp(
            &ctx,
            "taskdock_novel_update_chapter_content",
            json!({
                "project_id": project_for_thread,
                "chapter_id": "ch1",
                "content": "MCP 写入正文",
                "expected_revision": 0,
                "requestId": "mcp-write-1",
            }),
        );
        let _ = tx.send(result);
    });
    let result = rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| {
        panic!("MCP 领域写操作 15 秒未返回：判定为事务自锁死锁")
    });
    assert_eq!(result["isError"], false, "{result}");

    let stored: String = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT content FROM novel_chapters WHERE id='ch1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(stored, "MCP 写入正文");
}

#[test]
fn mcp_write_has_one_operation_with_true_resource_and_project() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "初始正文");
    let (_, token) = agent(
        &db,
        "one-op",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let value = mcp_ok(
        &ctx,
        "taskdock_novel_update_chapter_content",
        json!({
            "project_id": project,
            "chapter_id": "ch1",
            "content": "新正文",
            "expected_revision": 0,
            "requestId": "mcp-one-op",
        }),
    );
    assert_eq!(value["revision"], 1);
    assert_eq!(value["summary"]["revision"], 1);

    let ops = operations_of(&db, "taskdock_novel_update_chapter_content");
    assert_eq!(ops.len(), 1, "一次外部写请求只能有一条 Operation");
    let (kind, id, project_id, status, revision) = &ops[0];
    assert_eq!(kind, "novel.chapter");
    assert_eq!(id, "ch1", "resource_id 不得是动作名");
    assert_eq!(project_id, &project, "project_id 必须是项目根");
    assert_eq!(status, "committed");
    assert_eq!(revision, &Some(1));
}

#[test]
fn mcp_same_request_id_replays_without_second_operation_or_write() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "初始正文");
    let (_, token) = agent(
        &db,
        "mcp-replay",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let args = json!({
        "project_id": project,
        "chapter_id": "ch1",
        "content": "只写一次",
        "expected_revision": 0,
        "requestId": "mcp-replay-1",
    });
    let first = mcp_ok(&ctx, "taskdock_novel_update_chapter_content", args.clone());
    let replay = mcp_ok(&ctx, "taskdock_novel_update_chapter_content", args);
    assert_eq!(first, replay);
    assert_eq!(operations_of(&db, "taskdock_novel_update_chapter_content").len(), 1);
    let stored: String = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT content FROM novel_chapters WHERE id='ch1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(stored, "只写一次");
    let revision: i64 = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT revision FROM agent_resource_revisions
                 WHERE resource_kind='novel.chapter' AND resource_id='ch1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(revision, 1, "重放不得推进 revision");
}

#[test]
fn mcp_stale_revision_fails_without_partial_write() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "旧正文");
    let (_, token) = agent(
        &db,
        "stale",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    mcp_ok(
        &ctx,
        "taskdock_novel_update_chapter_content",
        json!({
            "project_id": project,
            "chapter_id": "ch1",
            "content": "新正文",
            "expected_revision": 0,
            "requestId": "stale-1",
        }),
    );
    let err = mcp_err(
        &ctx,
        "taskdock_novel_update_chapter_content",
        json!({
            "project_id": project,
            "chapter_id": "ch1",
            "content": "旧客户端覆盖",
            "expected_revision": 0,
            "requestId": "stale-2",
        }),
    );
    assert!(err["message"].as_str().unwrap().contains("版本冲突"), "{err}");
    let stored: String = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT content FROM novel_chapters WHERE id='ch1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(stored, "新正文", "失败事务不能留下部分写入");
    let ops = operations_of(&db, "taskdock_novel_update_chapter_content");
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[1].3, "conflict", "冲突必须真实落库为 conflict");
}

#[test]
fn two_agents_concurrent_same_revision_only_one_commits() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "初始");
    let (_, token_a) = agent(
        &db,
        "concurrent-a",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let (_, token_b) = agent(
        &db,
        "concurrent-b",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for (suffix, token, content) in [
        ("a", token_a, "并发 A"),
        ("b", token_b, "并发 B"),
    ] {
        let ctx = ToolCtx {
            db: db.clone(),
            agent: agent_row(&db, &token),
            emit: collector(),
        };
        let barrier = barrier.clone();
        let project = project.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            call_mcp(
                &ctx,
                "taskdock_novel_update_chapter_content",
                json!({
                    "project_id": project,
                    "chapter_id": "ch1",
                    "content": content,
                    "expected_revision": 0,
                    "requestId": format!("concurrent-{suffix}"),
                }),
            )
        }));
    }
    let r1 = handles.remove(0).join().unwrap();
    let r2 = handles.remove(0).join().unwrap();
    let e1 = r1["isError"].as_bool().unwrap();
    let e2 = r2["isError"].as_bool().unwrap();
    assert_ne!(e1, e2, "同一 revision 只能有一个并发写提交: {r1} / {r2}");
    let failed = if e1 { &r1 } else { &r2 };
    assert!(
        failed["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("版本冲突"),
        "{failed}"
    );
    let stored: String = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT content FROM novel_chapters WHERE id='ch1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(matches!(stored.as_str(), "并发 A" | "并发 B"), "{stored}");
    let ops = operations_of(&db, "taskdock_novel_update_chapter_content");
    assert_eq!(ops.len(), 2, "两个并发请求各一条 Operation");
    assert_eq!(
        ops.iter().filter(|op| op.3 == "committed").count(),
        1,
        "{ops:?}"
    );
    assert_eq!(
        ops.iter().filter(|op| op.3 == "conflict").count(),
        1,
        "{ops:?}"
    );
}

// ── Agent revision / 数据最小化 / 分页 ───────────────────────────

#[test]
fn agent_reads_ui_writes_and_agent_writes_revisions() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "初始");
    let (_, token) = agent(
        &db,
        "revision",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let before = mcp_ok(
        &ctx,
        "taskdock_novel_get_chapter",
        json!({"project_id": project, "chapter_id": "ch1"}),
    );
    assert_eq!(before["revision"], 0);
    assert!(before.get("content").is_none(), "元信息不得重复返回正文");

    // 先由 Agent 建立基线，之后 UI 直接改业务行才能被 effective revision 识别。
    mcp_ok(
        &ctx,
        "taskdock_novel_update_chapter_content",
        json!({
            "project_id": project,
            "chapter_id": "ch1",
            "content": "Agent 基线",
            "expected_revision": 0,
            "requestId": "rev-baseline",
        }),
    );

    // UI 直接改业务行（外部修改）
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE novel_chapters SET content='UI 新正文', updated_at='2026-03-01T00:00:00Z'
             WHERE id='ch1'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let after_ui = mcp_ok(
        &ctx,
        "taskdock_novel_get_chapter",
        json!({"project_id": project, "chapter_id": "ch1"}),
    );
    assert_eq!(after_ui["revision"], 2, "UI 外部修改必须被有效 revision 识别");
    assert_eq!(after_ui["updatedAt"], "2026-03-01T00:00:00Z");

    let written = mcp_ok(
        &ctx,
        "taskdock_novel_update_chapter_content",
        json!({
            "project_id": project,
            "chapter_id": "ch1",
            "content": "Agent 写入",
            "expected_revision": 2,
            "requestId": "rev-write",
        }),
    );
    assert_eq!(written["revision"], 3);

    let content = mcp_ok(
        &ctx,
        "taskdock_novel_get_chapter_content",
        json!({"project_id": project, "chapter_id": "ch1"}),
    );
    assert_eq!(content["content"], "Agent 写入");
    assert_eq!(content["revision"], 3);
}

#[test]
fn ui_command_write_advances_revision_without_agent_baseline() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    seed_chapter(&db, &project, "ch1", "初始");
    // UI 命令层写入（真实入口）：应同步建立并推进 revision，而不是留下无基线 0。
    crate::commands::project_workspace::novel_chapter_save_content_impl(
        &db,
        "ch1",
        "UI 第一次写入".into(),
    )
    .unwrap();
    let (_, token) = agent(
        &db,
        "ui-revision",
        "project_rw",
        &["projects.read"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let first = mcp_ok(
        &ctx,
        "taskdock_novel_get_chapter",
        json!({"project_id": project, "chapter_id": "ch1"}),
    );
    assert_eq!(first["revision"], 1, "UI 首次写入必须建立 revision=1");
    assert!(!first["updatedAt"].as_str().unwrap_or("").is_empty());

    crate::commands::project_workspace::novel_chapter_save_content_impl(
        &db,
        "ch1",
        "UI 第二次写入".into(),
    )
    .unwrap();
    let second = mcp_ok(
        &ctx,
        "taskdock_novel_get_chapter",
        json!({"project_id": project, "chapter_id": "ch1"}),
    );
    assert_eq!(second["revision"], 2, "UI 再次写入必须继续推进 revision");
}

#[test]
fn comic_ui_save_advances_revision_and_agent_reads_it() {
    let db = memdb();
    let project = seed_project(&db, "ai_comic", "active", "");
    seed_shot(&db, &project, "shot1");
    seed_media(&db, &project, "m1", "shot.png");
    crate::commands::comic_workspace::comic_media_save_impl(
        &db,
        "m1",
        Some("UI 版本".into()),
        Some("candidate".into()),
        Some("UI 意见".into()),
    )
    .unwrap();
    let (_, token) = agent(
        &db,
        "comic-ui-revision",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let first = mcp_ok(
        &ctx,
        "taskdock_comic_get_media_version",
        json!({"project_id": project, "media_id": "m1"}),
    );
    assert_eq!(first["revision"], 1, "Comic UI 写入必须建立 revision=1");
    crate::commands::comic_workspace::comic_media_save_impl(
        &db,
        "m1",
        Some("UI 版本 2".into()),
        Some("rejected".into()),
        Some("UI 意见 2".into()),
    )
    .unwrap();
    let second = mcp_ok(
        &ctx,
        "taskdock_comic_get_media_version",
        json!({"project_id": project, "media_id": "m1"}),
    );
    assert_eq!(second["revision"], 2, "Comic UI 再次写入必须推进 revision");
    assert_eq!(second["status"], "rejected");
}

#[test]
fn comic_episode_list_hides_script_and_media_list_hides_absolute_paths() {
    let db = memdb();
    let root = std::env::temp_dir().join(format!("taskdock-mcp-path-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("assets")).unwrap();
    let inside = root.join("assets").join("shot.png");
    std::fs::write(&inside, b"x").unwrap();
    let project = seed_project(&db, "ai_comic", "active", root.to_string_lossy().as_ref());
    seed_shot(&db, &project, "shot1");
    seed_media(&db, &project, "m1", inside.to_string_lossy().as_ref());
    let (_, token) = agent(
        &db,
        "minimal",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let episodes = mcp_ok(
        &ctx,
        "taskdock_comic_list_episodes",
        json!({"project_id": project}),
    );
    let text = episodes.to_string();
    assert!(!text.contains("SECRET SCRIPT"), "剧集列表不得返回完整剧本");
    assert_eq!(episodes["page"]["total"], 1);

    let media = mcp_ok(
        &ctx,
        "taskdock_comic_list_media_versions",
        json!({"project_id": project}),
    );
    let text = media.to_string();
    assert!(!text.contains(root.to_string_lossy().as_ref()), "不得输出本机绝对目录");
    assert_eq!(media["items"][0]["file"]["relativePath"], "assets/shot.png");
    assert_eq!(media["items"][0]["file"]["fileType"], "png");
    assert_eq!(media["items"][0]["revision"], 0);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn mcp_lists_apply_default_and_capped_pagination() {
    let db = memdb();
    let project = seed_project(&db, "novel", "active", "");
    db.with_conn(|conn| {
        for i in 0..60 {
            conn.execute(
                "INSERT INTO novel_chapters
                   (id, project_id, volume_id, title, content, word_count, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, '', 0, ?4, '2026-01-01', '2026-01-01')",
                rusqlite::params![format!("ch-{i:02}"), project, format!("第{i:02}章"), i],
            )?;
        }
        Ok(())
    })
    .unwrap();
    let (_, token) = agent(
        &db,
        "page",
        "project_rw",
        &["projects.read"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let page1 = mcp_ok(
        &ctx,
        "taskdock_novel_list_chapters",
        json!({"project_id": project}),
    );
    assert_eq!(page1["items"].as_array().unwrap().len(), 50);
    assert_eq!(page1["page"]["total"], 60);
    assert_eq!(page1["page"]["has_more"], true);
    assert_eq!(page1["page"]["next_offset"], 50);
    let page2 = mcp_ok(
        &ctx,
        "taskdock_novel_list_chapters",
        json!({"project_id": project, "limit": 50, "offset": 50}),
    );
    assert_eq!(page2["items"].as_array().unwrap().len(), 10);
    assert_eq!(page2["page"]["has_more"], false);
}

#[test]
fn mcp_comic_update_rejects_oversized_metadata_and_adopted_bypass() {
    let db = memdb();
    let project = seed_project(&db, "ai_comic", "active", "");
    seed_shot(&db, &project, "shot1");
    seed_media(&db, &project, "m1", "");
    let (_, token) = agent(
        &db,
        "comic-validate",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let label_241 = "a".repeat(241);
    let err = mcp_err(
        &ctx,
        "taskdock_comic_save_media_version",
        json!({
            "project_id": project,
            "media_id": "m1",
            "version_label": label_241,
            "expected_revision": 0,
            "requestId": "too-long",
        }),
    );
    assert!(err["message"].as_str().unwrap().contains("240"), "{err}");

    let err = mcp_err(
        &ctx,
        "taskdock_comic_save_media_version",
        json!({
            "project_id": project,
            "media_id": "m1",
            "version_label": "v2",
            "status": "adopted",
            "expected_revision": 0,
            "requestId": "adopted-bypass",
        }),
    );
    assert!(err["message"].as_str().unwrap().contains("candidate"), "{err}");

    let ok = mcp_ok(
        &ctx,
        "taskdock_comic_save_media_version",
        json!({
            "project_id": project,
            "media_id": "m1",
            "version_label": "v2",
            "status": "candidate",
            "review_note": "候选",
            "expected_revision": 0,
            "requestId": "candidate-ok",
        }),
    );
    assert_eq!(ok["media"]["status"], "candidate");
    assert_eq!(ok["revision"], 1);
}

#[test]
fn mcp_comic_adopt_advances_old_and_new_versions() {
    let db = memdb();
    let project = seed_project(&db, "ai_comic", "active", "");
    seed_shot(&db, &project, "shot1");
    seed_media(&db, &project, "m1", "");
    seed_media(&db, &project, "m2", "");
    let (_, token) = agent(
        &db,
        "adopt",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    mcp_ok(
        &ctx,
        "taskdock_comic_adopt_media_version",
        json!({"project_id": project, "media_id": "m1", "expected_revision": 0, "requestId": "adopt-1"}),
    );
    let m2 = mcp_ok(
        &ctx,
        "taskdock_comic_adopt_media_version",
        json!({"project_id": project, "media_id": "m2", "expected_revision": 0, "requestId": "adopt-2"}),
    );
    assert_eq!(m2["media"]["status"], "adopted");
    assert_eq!(m2["revision"], 1);
    let list = mcp_ok(
        &ctx,
        "taskdock_comic_list_media_versions",
        json!({"project_id": project, "shot_id": "shot1"}),
    );
    let items = list["items"].as_array().unwrap();
    let m1 = items.iter().find(|m| m["id"] == "m1").unwrap();
    assert_eq!(m1["status"], "candidate");
    assert_eq!(m1["revision"], 2, "被替换版本 revision 也必须推进（adopt 1 → 被替换 2）");
    assert_eq!(items.iter().filter(|m| m["status"] == "adopted").count(), 1);
}

// ── 五领域续作：真实 MCP、loopback REST 与 CLI 参数映射 ─────────────

struct DomainRestFixture {
    port: u16,
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl DomainRestFixture {
    fn start(db: &Arc<Db>) -> Self {
        // 与既有 REST 生命周期测试使用同一把锁，避免进程级 runtime 互相覆盖。
        let serial = super::tests_v82_rest::serial();
        let _ = super::rest::stop();
        Self {
            port: super::tests_v82_rest::start_rest(db),
            _serial: serial,
        }
    }

    fn post(&self, path: &str, token: &str, input: &Value, key: &str) -> (u16, Value) {
        let body = serde_json::to_vec(input).unwrap();
        let (status, _, text) =
            super::tests_v82_rest::post(self.port, path, token, &body, Some(key));
        (status, serde_json::from_str(&text).unwrap())
    }

    fn get(&self, path: &str, token: &str) -> (u16, Value) {
        let (status, _, text) = super::tests_v82_rest::get(self.port, path, Some(token), &[]);
        (status, serde_json::from_str(&text).unwrap())
    }
}

impl Drop for DomainRestFixture {
    fn drop(&mut self) {
        let _ = super::rest::stop();
    }
}

fn mcp_permission_denied(ctx: &ToolCtx, tool: &str, args: Value) {
    match run_tool_call(ctx, tool, &args) {
        Err(err) => assert_eq!(err.code, crate::mcp::protocol::ERR_FORBIDDEN, "{err:?}"),
        Ok(value) => {
            assert_eq!(value["isError"], true, "{value}");
            let error: Value =
                serde_json::from_str(value["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(error["error"], "PERMISSION_DENIED", "{error}");
        }
    }
}

/// CLI 的业务映射与实际外层 OperationGuard；不启动另一个 CLI 进程。
#[allow(clippy::too_many_arguments)]
fn cli_domain_value(
    db: &Db,
    principal: &Principal,
    group: &str,
    sub: &str,
    args: Vec<String>,
    request_id: &str,
    write: Option<&str>,
) -> crate::error::AppResult<Value> {
    let mut cli_principal = principal.clone();
    cli_principal.source = Source::Cli;
    let mut args = args;
    let operation = write.map(|id| {
        let def = registry::find_operation(id).unwrap();
        let project = args
            .windows(2)
            .find(|pair| pair[0] == "--project-id")
            .map(|pair| pair[1].as_str())
            .unwrap_or("");
        super::operations::try_start(
            db,
            &cli_principal,
            &super::operations::OperationInput {
                action: def.id,
                resource_kind: def.resource_kind,
                resource_id: "",
                project_id: project,
                request_id,
                detail: "",
            },
        )
        .expect("CLI 写入创建唯一操作")
    });
    let guard = super::operations::OperationGuard::new(
        operation
            .as_ref()
            .map(|op| op.id.clone())
            .unwrap_or_default(),
    );
    let result = super::domain_cli::execute(
        db,
        &cli_principal,
        group,
        sub,
        &mut args,
        request_id,
        None,
        None,
        &guard,
    );
    match result {
        Ok((value, _page)) => {
            assert!(args.is_empty(), "CLI 参数必须全部消费: {args:?}");
            if let Some(operation) = operation {
                let def = registry::find_operation(write.unwrap()).unwrap();
                super::operations::complete(
                    db,
                    &operation.id,
                    &super::operations::OperationResult::from_value(def.resource_kind, &value),
                )?;
            }
            Ok(value)
        }
        Err(err) => {
            if let Some(operation) = operation {
                super::operations::fail(db, &operation.id, &err)?;
            }
            Err(err)
        }
    }
}

#[test]
fn general_three_transports_share_revision_and_deny_revoked_idempotent_replay() {
    let db = memdb();
    let project = seed_project(&db, "general", "active", "");
    let (principal, token) = agent(
        &db,
        "general-transports",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let rest = DomainRestFixture::start(&db);
    let (status, openapi) = rest.get("/api/v1/openapi.json", &token);
    assert_eq!(status, 200, "{openapi}");
    let methods = &openapi["data"]["paths"]["/api/v1/projects/{id}/general/milestones"];
    assert!(
        methods.get("get").is_some(),
        "同路径 GET 不得被 POST 覆盖: {methods}"
    );
    assert!(
        methods.get("post").is_some(),
        "同路径 POST 必须存在: {methods}"
    );
    let mcp_args = json!({
        "project_id": project, "requestId": "general-mcp-create",
        "input": {"title": "MCP 创建", "note": "三入口同一资源"},
    });
    let created = mcp_ok(&ctx, "taskdock_general_save_milestone", mcp_args.clone());
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["revision"], 1);
    assert_eq!(
        operations_of(&db, "taskdock_general_save_milestone").len(),
        1
    );

    let cli_input = json!({"id": id, "title": "CLI 更新", "expected_revision": 1});
    let cli_args = vec![
        "save".into(),
        "--project-id".into(),
        project.clone(),
        "--payload".into(),
        cli_input.to_string(),
    ];
    let cli = cli_domain_value(
        &db,
        &principal,
        "general",
        "milestone",
        cli_args.clone(),
        "general-cli-update",
        Some("general.milestone.save"),
    )
    .unwrap();
    assert_eq!(cli["id"], id);
    assert_eq!(cli["revision"], 2);
    assert_eq!(cli["note"], "三入口同一资源");

    let path = format!("/api/v1/projects/{project}/general/milestones");
    let rest_input = json!({"id": id, "title": "REST 更新", "expected_revision": 2});
    let (status, saved) = rest.post(&path, &token, &rest_input, "general-rest-update");
    assert_eq!(status, 201, "{saved}");
    assert_eq!(saved["data"]["revision"], 3);
    let (status, replay) = rest.post(&path, &token, &rest_input, "general-rest-update");
    assert_eq!(status, 201, "{replay}");
    assert_eq!(replay["data"], saved["data"]);

    let read = mcp_ok(
        &ctx,
        "taskdock_general_list_milestones",
        json!({"project_id": project}),
    );
    assert_eq!(read["items"][0]["title"], "REST 更新");
    assert_eq!(read["items"][0]["revision"], 3);
    let cli_read = cli_domain_value(
        &db,
        &principal,
        "general",
        "milestone",
        vec!["list".into(), "--project-id".into(), project.clone()],
        "general-cli-read",
        None,
    )
    .unwrap();
    assert_eq!(cli_read[0]["revision"], 3);
    let (status, read) = rest.get(&path, &token);
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["data"][0]["revision"], 3);
    let total: i64 = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM general_milestones WHERE project_id=?1",
                [&project],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(total, 1, "更新与重放都不能生成第二个里程碑");

    mcp_auth::revoke_project(&db, principal.agent_row_id.as_deref().unwrap(), &project).unwrap();
    mcp_permission_denied(&ctx, "taskdock_general_save_milestone", mcp_args);
    let denied = cli_domain_value(
        &db,
        &principal,
        "general",
        "milestone",
        cli_args,
        "general-cli-update",
        Some("general.milestone.save"),
    )
    .unwrap_err();
    assert_eq!(super::error_code(&denied), "FORBIDDEN");
    let (status, denied) = rest.post(&path, &token, &rest_input, "general-rest-update");
    assert_eq!(status, 403, "撤权后同 Key 不能返回缓存成功: {denied}");
}

#[test]
fn game_registration_round_trips_across_transports_without_promoting_verification() {
    let db = memdb();
    let project = seed_project(&db, "game", "active", "");
    let (principal, token) = agent(
        &db,
        "game-transports",
        "project_rw",
        &["projects.read", "projects.write"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let rest = DomainRestFixture::start(&db);
    let build = mcp_ok(
        &ctx,
        "taskdock_game_create_build",
        json!({
            "project_id": project, "requestId": "game-build-register",
            "input": {"target": "Windows", "status": "success", "log_summary": "Agent 登记成功"},
        }),
    );
    assert_eq!(build["verificationStatus"], "unverified");
    assert_eq!(build["source"], "imported");
    assert_eq!(build["revision"], 1);
    assert_eq!(operations_of(&db, "taskdock_game_create_build").len(), 1);

    let path = format!("/api/v1/projects/{project}/game/tests");
    let input = json!({"build_id": build["id"], "title": "登记回归", "result": "passed"});
    let (status, test) = rest.post(&path, &token, &input, "game-test-register");
    assert_eq!(status, 201, "{test}");
    assert_eq!(test["data"]["verificationStatus"], "unverified");
    assert_eq!(test["data"]["buildId"], build["id"]);
    assert_eq!(test["data"]["revision"], 1);
    let (status, replay) = rest.post(&path, &token, &input, "game-test-register");
    assert_eq!(status, 201, "{replay}");
    assert_eq!(replay["data"], test["data"]);
    assert_eq!(operations_of(&db, "game.test.create").len(), 1);

    for sub in ["build", "test"] {
        let rows = cli_domain_value(
            &db,
            &principal,
            "game",
            sub,
            vec!["list".into(), "--project-id".into(), project.clone()],
            "game-cli-list",
            None,
        )
        .unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["verificationStatus"], "unverified");
    }
    let denied = mcp_err(
        &ctx,
        "taskdock_game_create_build",
        json!({
            "project_id": project, "requestId": "game-no-self-verify",
            "input": {"target": "Windows", "status": "success", "verification_status": "verified"},
        }),
    );
    assert!(denied.get("error").is_some(), "{denied}");
    let read = mcp_ok(
        &ctx,
        "taskdock_game_list_tests",
        json!({"project_id": project}),
    );
    assert_eq!(read["items"][0]["verificationStatus"], "unverified");
}

#[test]
fn development_transports_reject_other_task_evidence_and_read_back_real_links() {
    let db = memdb();
    let project = seed_project(&db, "development", "active", "");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO dws_workspace_probes
             (id, project_id, probed_at, git_status, branch, main_repo_path)
             VALUES ('probe-1', ?1, '2026-11-24', 'dirty', 'main', 'D:/private/repo')",
            [&project],
        )?;
        for task in ["dev-task-a", "dev-task-b"] {
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at)
                 VALUES (?1, ?1, '2026-11-24', '2026-11-24')",
                [task],
            )?;
            conn.execute(
                "INSERT INTO workspace_task_links (project_id, task_id, created_at)
                 VALUES (?1, ?2, '2026-11-24')",
                rusqlite::params![project, task],
            )?;
            conn.execute(
                "INSERT INTO dev_handoff_packs
                 (id, task_id, title, version, content_md, created_at)
                 VALUES (?1, ?2, '真实交接', 1, '不得出现在证据摘要中的正文', '2026-11-24')",
                rusqlite::params![format!("pack-{task}"), task],
            )?;
            conn.execute(
                "INSERT INTO dev_acceptance_records
                 (id, subject_kind, subject_id, verdict, summary, evidence, created_at)
                 VALUES (?1, 'task', ?2, 'pass', '人工验收', '[]', '2026-11-24')",
                rusqlite::params![format!("accept-{task}"), task],
            )?;
        }
        Ok(())
    })
    .unwrap();
    let (principal, token) = agent(
        &db,
        "development-transports",
        "project_rw",
        &["projects.read", "projects.write", "tasks.read"],
        &[&project],
    );
    let ctx = ToolCtx {
        db: db.clone(),
        agent: agent_row(&db, &token),
        emit: collector(),
    };
    let rest = DomainRestFixture::start(&db);
    let snapshot = mcp_ok(
        &ctx,
        "taskdock_development_get_git_snapshot",
        json!({"project_id": project}),
    );
    assert_eq!(snapshot["status"], "dirty");
    assert_eq!(snapshot["branch"], "main");
    assert!(!snapshot.to_string().contains("D:/private/repo"));
    let path = format!("/api/v1/projects/{project}/development/task-links");
    let wrong_pack = json!({"task_id": "dev-task-a", "handoff_pack_id": "pack-dev-task-b"});
    let (status, denied) = rest.post(&path, &token, &wrong_pack, "dev-wrong-pack");
    assert_eq!(status, 403, "{denied}");
    mcp_permission_denied(
        &ctx,
        "taskdock_development_create_task_link",
        json!({
            "project_id": project, "requestId": "dev-wrong-acceptance",
            "input": {"task_id": "dev-task-a", "acceptance_record_id": "accept-dev-task-b"},
        }),
    );

    let link = mcp_ok(
        &ctx,
        "taskdock_development_create_task_link",
        json!({
            "project_id": project, "requestId": "dev-link-real-evidence",
            "input": {"task_id": "dev-task-a", "handoff_pack_id": "pack-dev-task-a",
                "acceptance_record_id": "accept-dev-task-a", "note": "只关联已有证据"},
        }),
    );
    assert_eq!(link["taskId"], "dev-task-a");
    let read = cli_domain_value(
        &db,
        &principal,
        "development",
        "task-evidence",
        vec![
            "list".into(),
            "--project-id".into(),
            project.clone(),
            "--task-id".into(),
            "dev-task-a".into(),
        ],
        "dev-cli-evidence",
        None,
    )
    .unwrap();
    let rows = read.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row["linked"] == true));
    assert!(rows
        .iter()
        .any(|row| row["kind"] == "acceptance" && row["verdict"] == "pass"));
    assert!(!read.to_string().contains("不得出现在证据摘要中的正文"));
    assert!(!read.to_string().contains("dev-task-b"));
    let read_path =
        format!("/api/v1/projects/{project}/development/task-evidence?task_id=dev-task-a");
    let (status, read) = rest.get(&read_path, &token);
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["data"].as_array().unwrap().len(), 2);
    assert!(read["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["linked"] == true));
    let count: i64 = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM dws_task_links WHERE project_id=?1",
                [&project],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(count, 1, "拒绝的跨任务关联不得落库");
}
