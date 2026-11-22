//! v82 回归测试：Context Engine 三处缺陷。
//!
//! - P2-4：资源级权限粒度（每类资源用各自的读取能力；项目授权不得代替任务授权）。
//! - P2-3：近期变更归属（按真实业务关联，而不是「资源 ID == 项目 ID」）。
//! - P2-5：Token 预算覆盖完整输出（骨架先占额度，条目与近期变更共享剩余额度）。
//!
//! 全部使用**隔离的内存数据库**，不触碰用户真实数据。

use crate::db::Db;
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions::{self as mcp_perm};

use super::context::{self, ContextRequest};
use super::handoff;
use super::service;
use super::store;
use super::{error_code, Principal, Source};

/// 测试夹具：内存库 + 造数据的最小工具集。
struct Fixture {
    db: Db,
}

impl Fixture {
    fn new() -> Self {
        Self {
            db: Db::open_in_memory().expect("内存库"),
        }
    }

    /// 注册一个 Agent（scope=project_rw，可读可写），返回 (行 ID, agent_id)。
    fn agent(&self, agent_id: &str) -> (String, String) {
        let created = mcp_auth::create_agent(&self.db, agent_id, agent_id).expect("创建 Agent");
        mcp_auth::set_agent_scope(&self.db, &created.info.id, "project_rw").expect("设置 scope");
        (created.info.id, created.info.agent_id)
    }

    /// 通过既有授权接口授予能力（会校验资源真实存在）。
    fn grant(&self, row_id: &str, capability: &str, resource: &str) {
        mcp_perm::grant(&self.db, row_id, capability, resource).expect("授权");
    }

    /// 授予项目根授权（v92 统一授权第三层：`mcp_agent_grants`，外键指向项目根）。
    /// project_rw 的项目型读取范围 = 能力范围 ∩ 已授权项目根。
    fn grant_project(&self, row_id: &str, project: &str) {
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO mcp_agent_grants
                       (id, agent_row_id, project_id, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        row_id,
                        project,
                        crate::agents::now_iso()
                    ],
                )?;
                Ok(())
            })
            .expect("授予项目授权");
    }

    /// 直接写入能力行：用于「项目级任务授权」这种既有接口不接受的组合。
    fn grant_raw(&self, row_id: &str, capability: &str, resource: &str) {
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO mcp_agent_capabilities
                       (id, agent_row_id, capability, resource_id, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        row_id,
                        capability,
                        resource,
                        crate::agents::now_iso()
                    ],
                )?;
                Ok(())
            })
            .expect("写入授权");
    }

    /// 建一个真实存在的项目工作空间项目（关联任务与知识库的前提）。
    fn project(&self, id: &str) {
        let now = crate::agents::now_iso();
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspace_projects
                       (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                     VALUES (?1, ?1, 'general', 'active', '', NULL, '', ?2, ?2)",
                    rusqlite::params![id, now],
                )?;
                Ok(())
            })
            .expect("创建项目");
    }

    /// 建规划项目（可给独立显示名），用于测试规划元数据的可见性。
    fn planning_project(&self, id: &str, name: &str, status: &str) {
        let now = crate::agents::now_iso();
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO planning_projects
                       (id, name, description, status, archived, target_date, sort_order,
                        created_at, updated_at)
                     VALUES (?1, ?2, '', ?3, 0, NULL, 0, ?4, ?4)",
                    rusqlite::params![id, name, status, now],
                )?;
                Ok(())
            })
            .expect("创建规划项目");
    }

    /// 建规划功能。
    fn feature(&self, project: &str, title: &str, status: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = crate::agents::now_iso();
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO planning_features
                       (id, project_id, title, description, status, priority, milestone_id,
                        target_date, sort_order, created_at, updated_at, completed_at)
                     VALUES (?1, ?2, ?3, '', ?4, 'P1', NULL, NULL, 0, ?5, ?5, NULL)",
                    rusqlite::params![id, project, title, status, now],
                )?;
                Ok(())
            })
            .expect("创建规划功能");
        id
    }

    /// 建任务（可选挂到项目下），返回任务 ID。
    fn task(&self, title: &str, description: &str, project: Option<&str>) -> String {
        let task = service::create_task(
            &self.db,
            &Principal::local(Source::Ui),
            service::TaskCreateInput {
                title: title.into(),
                description: description.into(),
                ..Default::default()
            },
        )
        .expect("创建任务");
        if let Some(project_id) = project {
            crate::commands::project_workspace::workspace_task_link_add_impl(
                &self.db,
                project_id,
                &task.id,
            )
            .expect("关联任务");
        }
        task.id
    }

    /// 建决策（会同时产生一条 `decision` 版本记录）。
    fn decision(&self, project: &str, title: &str, status: &str) -> String {
        let decision = store::create_decision(
            &self.db,
            &Principal::local(Source::Ui),
            store::DecisionInput {
                title: title.into(),
                project_id: Some(project.into()),
                project_kind: Some("workspace".into()),
                context: String::new(),
                decision: "采用方案 A".into(),
                consequences: String::new(),
                alternatives: String::new(),
                tags: Vec::new(),
                status: Some(status.into()),
            },
        )
        .expect("创建决策");
        decision.id
    }

    /// 建交接（目标 Agent 必须是真实注册过的 Agent）。
    fn handoff(&self, project: &str) -> String {
        let (_row, target_id) = self.agent(&format!("ctx-target-{}", uuid::Uuid::new_v4()));
        let created = handoff::create_handoff(
            &self.db,
            &Principal::local(Source::Ui),
            store::HandoffInput {
                to_agent_id: target_id,
                summary: "交接上下文".into(),
                task_id: None,
                project_id: Some(project.into()),
                project_kind: Some("workspace".into()),
                completed_items: Vec::new(),
                pending_items: Vec::new(),
                decisions: Vec::new(),
                files_changed: Vec::new(),
                risks: Vec::new(),
                next_steps: Vec::new(),
            },
        )
        .expect("创建交接");
        created.handoff.id
    }

    /// 建工作报告：**故意不填 project_id**，归属必须经 handoff 关联推导。
    fn report(&self, handoff_id: &str) -> String {
        let created = handoff::create_report(
            &self.db,
            &Principal::local(Source::Ui),
            store::ReportInput {
                summary: "本轮完成上下文归属修复".into(),
                result: Some("completed".into()),
                handoff_id: Some(handoff_id.into()),
                project_id: None,
                task_id: None,
                completed_items: vec!["归属判定".into()],
                pending_items: Vec::new(),
                files_changed: Vec::new(),
                evidence: Vec::new(),
                risks: Vec::new(),
            },
        )
        .expect("创建报告");
        created.report.id
    }

    /// 写一条资源版本记录（`agent_resource_revisions`）。
    fn revision(&self, kind: &str, id: &str) {
        self.db
            .with_conn(|conn| {
                store::bump_revision(
                    conn,
                    kind,
                    id,
                    &Principal::local(Source::Ui),
                    &crate::agents::now_iso(),
                    "",
                )
            })
            .expect("写入版本");
    }

    /// 建项目知识库 + 已索引文档 + 分块，返回 (知识库 ID, 文档 ID)。
    fn knowledge_doc(&self, project: &str, title: &str, content: &str) -> (String, String) {
        let kb_id = uuid::Uuid::new_v4().to_string();
        let doc_id = uuid::Uuid::new_v4().to_string();
        let now = crate::agents::now_iso();
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO knowledge_bases
                       (id, name, description, kind, project_id, workspace_id, favorite,
                        created_at, updated_at)
                     VALUES (?1, ?2, '', 'project', ?3, NULL, 0, ?4, ?4)",
                    rusqlite::params![kb_id, format!("{project}-知识库"), project, now],
                )?;
                conn.execute(
                    "INSERT INTO knowledge_documents
                       (id, kb_id, title, source_kind, source_mode, source_path, managed_rel_path,
                        mime, size_bytes, content, content_hash, status, error, chunk_count,
                        indexed_at, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'text', 'imported', NULL, NULL, 'text/plain', ?4, ?5,
                             '', 'indexed', '', 1, ?6, ?6, ?6)",
                    rusqlite::params![doc_id, kb_id, title, content.len() as i64, content, now],
                )?;
                conn.execute(
                    "INSERT INTO knowledge_chunks (doc_id, kb_id, ordinal, start_offset, content)
                     VALUES (?1, ?2, 0, 0, ?3)",
                    rusqlite::params![doc_id, kb_id, content],
                )?;
                Ok(())
            })
            .expect("创建知识文档");
        (kb_id, doc_id)
    }
}

fn agent_principal(row_id: &str, agent_id: &str) -> Principal {
    Principal::agent(row_id.to_string(), agent_id.to_string(), Source::Mcp)
}

fn build(fx: &Fixture, row_id: &str, agent_id: &str, req: ContextRequest) -> context::AgentContext {
    context::build(&fx.db, &agent_principal(row_id, agent_id), req).expect("装配上下文")
}

// ── P2-4：资源级权限粒度 ──────────────────────────────────────────

/// 1) 没有某资源权限时，默认上下文**不返回**该资源（但整体仍可用）。
#[test]
fn default_context_omits_resources_without_capability() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-4-default");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    let task_id = fx.task("修复导入边界", "", Some("proj-a"));
    fx.decision("proj-a", "导入边界决策", "accepted");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.items.iter().any(|i| i.kind == "task" && i.source_id == task_id),
        "持有 TasksRead 就必须返回任务"
    );
    assert!(
        ctx.items.iter().all(|i| i.kind != "decision"),
        "没有 DecisionsRead 不得返回决策"
    );
    assert!(
        ctx.items.iter().all(|i| i.kind != "knowledge"),
        "没有 KnowledgeRead 不得返回知识"
    );
    assert!(
        ctx.items.iter().all(|i| i.kind != "handoff"),
        "没有 HandoffsRead 不得返回交接"
    );
    let authorized = ctx.scope.get("authorized_kinds").cloned().unwrap();
    assert_eq!(authorized.get("task").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(authorized.get("decision").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        authorized.get("knowledge").and_then(|v| v.as_bool()),
        Some(false)
    );
}

/// 2) 显式请求无权访问的资源 → FORBIDDEN（不是静默返回空）。
#[test]
fn explicit_unauthorized_kind_is_forbidden() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-4-forbidden");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");

    let err = context::build(
        &fx.db,
        &agent_principal(&row_id, &agent_id),
        ContextRequest {
            kinds: vec!["knowledge".into()],
            ..Default::default()
        },
    )
    .expect_err("显式请求无权资源必须失败");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
}

/// 3) 任务权限缺失时，**不会**因为「项目授权」而拿到任务。
#[test]
fn project_capability_does_not_grant_tasks() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-4-project");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    // 只有项目级「规划读取」授权：不得代表 TasksRead。
    fx.grant(&row_id, "plans.read", "proj-a");
    fx.grant_project(&row_id, "proj-a");
    let task_id = fx.task("不该被看到的任务", "", Some("proj-a"));

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.items.iter().all(|i| i.source_id != task_id),
        "项目级其它授权不得代替 TasksRead"
    );
    assert!(ctx.items.iter().all(|i| i.kind != "task"));
    let authorized = ctx.scope.get("authorized_kinds").cloned().unwrap();
    assert_eq!(authorized.get("task").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(authorized.get("plan").and_then(|v| v.as_bool()), Some(true));
}

/// 3b) `ContextRead` 也不能代替具体资源的读取权限，更不能作为项目访问依据。
#[test]
fn context_read_alone_does_not_unlock_resources() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-4-entry-only");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    fx.planning_project("proj-a", "保密项目名称", "in_progress");
    let task_id = fx.task("入口能力不得解锁任务", "", Some("proj-a"));

    let err = context::build(
        &fx.db,
        &agent_principal(&row_id, &agent_id),
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    )
    .expect_err("只持 ContextRead 时显式请求项目必须被拒绝");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert!(
        !format!("{err:?}").contains("保密项目名称"),
        "拒绝信息不得泄露项目名称"
    );
    let _ = task_id;
}

#[test]
fn exact_task_grant_builds_linked_context_without_project_metadata_or_peers() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-exact-linked");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    fx.project("proj-b");
    fx.planning_project("proj-a", "保密项目名称", "in_progress");
    let feature = fx.feature("proj-a", "保密规划目标", "in_progress");
    let task = fx.task("发布目标任务", "可以读取的详情", Some("proj-a"));
    let peer = fx.task("发布同项目保密任务", "", Some("proj-a"));
    fx.revision("task", &task);
    fx.revision("task", &peer);
    fx.grant(&row_id, "tasks.read", &task);
    let principal = agent_principal(&row_id, &agent_id);

    for project in [None, Some("proj-a".into())] {
        let ctx = context::build(
            &fx.db,
            &principal,
            ContextRequest {
                task_id: Some(task.clone()),
                project_id: project,
                kinds: vec!["task".into()],
                ..Default::default()
            },
        )
        .expect("单任务授权可装配目标任务上下文");
        assert_eq!(ctx.project_id, "proj-a");
        assert!(ctx.project_name.is_empty());
        assert!(ctx.objective.contains("发布目标任务"));
        assert_eq!(ctx.items.len(), 1);
        assert_eq!(ctx.items[0].source_id, task);
        assert!(ctx.items[0].summary.contains("可以读取的详情"));
        assert!(ctx.recent_changes.iter().any(|i| i.source_id == task));
        assert!(ctx.recent_changes.iter().all(|i| i.source_id == task));
        let json = context::to_json(&ctx).unwrap().to_string();
        assert!(!json.contains("保密") && !json.contains(&feature) && !json.contains(&peer));
        assert!(!ctx.markdown.contains("保密"));
    }

    let wrong_project = context::build(
        &fx.db,
        &principal,
        ContextRequest {
            task_id: Some(task.clone()),
            project_id: Some("proj-b".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error_code(&wrong_project), "VALIDATION");

    // 即使有项目读取权限，也不能用项目授权代替同项目其它任务的读取授权。
    fx.grant(&row_id, "projects.read", "proj-a");
    let denied = context::build(
        &fx.db,
        &principal,
        ContextRequest {
            task_id: Some(peer),
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error_code(&denied), "FORBIDDEN");

    mcp_perm::revoke(&fx.db, &row_id, "tasks.read", &task).unwrap();
    let revoked = context::build(
        &fx.db,
        &principal,
        ContextRequest {
            task_id: Some(task),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error_code(&revoked), "FORBIDDEN");
}

#[test]
fn exact_unlinked_task_keeps_its_details_beyond_the_candidate_limit() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-exact-unlinked");
    fx.grant(&row_id, "context.read", "");
    // v92 统一授权：grant 的资源键是项目根，先建根再挂计划。
    fx.project("default-project");
    fx.planning_project("default-project", "默认活动项目", "in_progress");
    fx.grant(&row_id, "projects.read", "default-project");
    let task = fx.task("独立任务", "独立任务详细内容", None);
    fx.grant(&row_id, "tasks.read", &task);
    fx.db
        .with_conn(|conn| {
            conn.execute(
                "WITH RECURSIVE n(i) AS (
                    SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200
                 )
                 INSERT INTO tasks (id, title, due_at, created_at, updated_at)
                 SELECT 'filler-' || i, '独立任务干扰项', '2025-01-01T00:00:00Z',
                        '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z' FROM n",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            task_id: Some(task.clone()),
            kinds: vec!["task".into()],
            ..Default::default()
        },
    );
    assert!(ctx.project_id.is_empty());
    assert_eq!(ctx.items.len(), 1);
    assert_eq!(ctx.items[0].source_id, task);
    assert!(ctx.items[0].summary.contains("独立任务详细内容"));
    assert!(!ctx.markdown.contains("默认活动项目"));
    assert!(!ctx.markdown.contains("干扰项"));
}

/// 4) 项目隔离：只返回本项目资源。
#[test]
fn context_only_returns_resources_of_requested_project() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-4-isolation");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.grant(&row_id, "decisions.read", "");
    fx.project("proj-a");
    fx.project("proj-b");
    let task_a = fx.task("A 项目的任务", "", Some("proj-a"));
    let task_b = fx.task("B 项目的任务", "", Some("proj-b"));
    fx.decision("proj-a", "A 项目的决策", "accepted");
    fx.decision("proj-b", "B 项目的决策", "accepted");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(ctx.items.iter().any(|i| i.source_id == task_a));
    assert!(
        ctx.items.iter().all(|i| i.source_id != task_b),
        "不得返回其它项目的任务"
    );
    assert!(
        ctx.items.iter().all(|i| !i.title.contains("B 项目")),
        "不得返回其它项目的决策"
    );
    assert!(ctx.items.iter().any(|i| i.title.contains("A 项目的决策")));
}

// ── P2-3：近期变更归属 ────────────────────────────────────────────

/// 5) Recent Changes 正确返回本项目近期变更。
#[test]
fn recent_changes_include_current_project_changes() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-3-include");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    let task_id = fx.task("本项目近期变更", "", Some("proj-a"));
    fx.revision("task", &task_id);

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.recent_changes
            .iter()
            .any(|i| i.kind == "task" && i.source_id == task_id),
        "本项目的任务变更必须出现在近期变更里：{:?}",
        ctx.recent_changes
    );
}

/// 6) Recent Changes 排除其它项目变更。
#[test]
fn recent_changes_exclude_other_project_changes() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-3-other");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    fx.project("proj-b");
    let task_b = fx.task("别的项目的任务", "", Some("proj-b"));
    fx.revision("task", &task_b);

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.recent_changes.iter().all(|i| i.source_id != task_b),
        "不得返回其它项目的变更：{:?}",
        ctx.recent_changes
    );
}

/// 7) Recent Changes 排除无权限资源。
#[test]
fn recent_changes_exclude_unauthorized_resources() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-3-unauthorized");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    // 刻意不给 decisions.read / handoffs.read。
    fx.project("proj-a");
    let task_id = fx.task("有权限的任务", "", Some("proj-a"));
    fx.revision("task", &task_id);
    let decision_id = fx.decision("proj-a", "无权限的决策", "accepted");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.recent_changes
            .iter()
            .any(|i| i.kind == "task" && i.source_id == task_id),
        "有权限的变更必须保留"
    );
    assert!(
        ctx.recent_changes.iter().all(|i| i.source_id != decision_id),
        "没有 DecisionsRead 不得返回决策变更：{:?}",
        ctx.recent_changes
    );
    assert!(ctx.recent_changes.iter().all(|i| i.kind != "decision"));
}

/// 8) Recent Changes 不再用「资源 ID == 项目 ID」判断归属。
#[test]
fn recent_changes_use_real_task_project_link() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-3-link");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    let task_id = fx.task("真实关联的任务", "", Some("proj-a"));
    fx.revision("task", &task_id);
    // 伪造一条「资源 ID 恰好等于项目 ID」的 task 版本记录：
    // v81 的字符串相等判定会把它当成项目资源，这里必须排除。
    fx.revision("task", "proj-a");

    assert_ne!(task_id, "proj-a", "任务 ID 与项目 ID 天然不同");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.recent_changes
            .iter()
            .any(|i| i.source_id == task_id),
        "按真实关联（workspace_task_links）判定后，任务变更必须出现"
    );
    assert!(
        ctx.recent_changes.iter().all(|i| i.source_id != "proj-a"),
        "任务 ID 不等于项目 ID，不得按字符串相等放行：{:?}",
        ctx.recent_changes
    );
}

/// 9) 报告（report）在 Recent Changes 里的归属正确（经 handoff 关联）。
#[test]
fn recent_changes_resolve_report_ownership_through_handoff() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-p2-3-report");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "handoffs.read", "");
    fx.project("proj-a");
    // v92 统一授权第三层：project_rw 的项目型读取范围收敛到已授权项目根。
    fx.grant_project(&row_id, "proj-a");
    let handoff_id = fx.handoff("proj-a");
    let report_id = fx.report(&handoff_id);
    // 报告自身不声明项目，项目由所属交接推导后落库；归属判定不能拿 handoff ID 当报告 ID。
    let report_project: String = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT project_id FROM agent_work_reports WHERE id = ?1",
                rusqlite::params![report_id],
                |r| r.get::<_, String>(0),
            )?)
        })
        .expect("读取报告");
    assert_eq!(report_project, "proj-a", "报告项目由交接推导");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.recent_changes
            .iter()
            .any(|i| i.kind == "report" && i.source_id == report_id),
        "报告必须按其交接的项目归属返回：{:?}",
        ctx.recent_changes
    );
    assert_ne!(
        report_id, handoff_id,
        "报告与交接是两种 ID，不能互相顶替"
    );
}

// ── 检索、去重 ────────────────────────────────────────────────────

/// 10) 中文关键词检索命中（且不会把无关中文任务也带进来）。
#[test]
fn chinese_keywords_match_chinese_content() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-cjk");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    let hit = fx.task("修复中文检索的边界", "中文检索需要双字切片", Some("proj-a"));
    let miss = fx.task("编写英文说明文档", "nothing to see here", Some("proj-a"));

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            task: Some("中文检索".into()),
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    let keywords = ctx
        .scope
        .get("keywords")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(
        keywords.iter().any(|k| k.as_str() == Some("中文")),
        "中文查询必须切成双字关键词：{keywords:?}"
    );
    assert!(
        ctx.items.iter().any(|i| i.source_id == hit),
        "中文查询必须命中中文内容：{:?}",
        ctx.items.iter().map(|i| &i.title).collect::<Vec<_>>()
    );
    assert!(
        ctx.items.iter().all(|i| i.source_id != miss),
        "不相关的中文任务不得被带进来"
    );
}

/// 11) 去重：同一资源不重复出现（跨来源、跨 kind）。
#[test]
fn duplicate_resources_are_deduplicated() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-dedup");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "knowledge.read", "");
    fx.project("proj-a");
    let (_kb_id, doc_id) = fx.knowledge_doc("proj-a", "导入边界说明", "导入边界的处理方式");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            task: Some("导入".into()),
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    let doc_count = ctx
        .items
        .iter()
        .filter(|i| i.kind == "knowledge" && i.source_id == doc_id)
        .count();
    assert_eq!(
        doc_count, 1,
        "同一份知识文档（检索 + 项目列表）只能出现一次：{:?}",
        ctx.items
    );
    let mut ids: Vec<&str> = ctx.items.iter().map(|i| i.source_id.as_str()).collect();
    ids.sort_unstable();
    let total = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), total, "条目集合内不得出现重复资源");
}

// ── P2-5：Token 预算 ──────────────────────────────────────────────

/// 12) 超预算时 truncated=true 且 estimated_tokens 不超过上限。
#[test]
fn budget_truncates_and_stays_within_limit() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-budget");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    for i in 0..30 {
        fx.task(
            &format!("任务 {i} {}", "很长的任务描述".repeat(12)),
            &"很长的任务描述".repeat(12),
            Some("proj-a"),
        );
    }

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            budget_tokens: Some(1000),
            ..Default::default()
        },
    );

    assert!(ctx.truncated, "装不下必须标记截断");
    assert!(
        ctx.estimated_tokens <= ctx.budget_tokens,
        "估算消耗不得超过预算：{} > {}",
        ctx.estimated_tokens,
        ctx.budget_tokens
    );
    assert!(ctx.estimated_tokens > 0);
    assert!(ctx.kept_items < 30, "超预算时必须裁掉一部分条目");
}

/// 12b) 近期变更不得绕过预算（它和其它条目共享同一份额度）。
#[test]
fn recent_changes_share_the_same_budget() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-budget-recent");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.project("proj-a");
    for i in 0..12 {
        let id = fx.task(
            &format!("任务 {i} {}", "填充内容".repeat(20)),
            &"填充内容".repeat(20),
            Some("proj-a"),
        );
        fx.revision("task", &id);
    }

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            budget_tokens: Some(1000),
            ..Default::default()
        },
    );

    assert!(ctx.truncated);
    assert!(
        ctx.estimated_tokens <= ctx.budget_tokens,
        "近期变更不得把结果撑出预算：{} > {}",
        ctx.estimated_tokens,
        ctx.budget_tokens
    );
    // 条目与近期变更合计仍受同一个额度约束。
    let listed = ctx.items.len() + ctx.recent_changes.len();
    assert!(listed > 0, "预算再小也不该把结果清空");
}

/// 13) Markdown 与 JSON 条目一致。
#[test]
fn markdown_and_json_describe_same_items() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-consistency");
    fx.grant(&row_id, "context.read", "");
    fx.grant(&row_id, "tasks.read", "");
    fx.grant(&row_id, "decisions.read", "");
    fx.project("proj-a");
    let task_id = fx.task("一致性检查任务", "内容", Some("proj-a"));
    fx.decision("proj-a", "一致性决策", "accepted");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            task: Some("一致性".into()),
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );
    let json = context::to_json(&ctx).expect("JSON");
    let json_items = json
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        json_items.len(),
        ctx.items.len(),
        "JSON 与结构体必须描述同一批条目"
    );
    assert_eq!(
        ctx.markdown.matches("来源 `").count(),
        ctx.items.len(),
        "Markdown 必须逐条渲染同一批条目"
    );
    for item in &ctx.items {
        assert!(
            ctx.markdown.contains(&item.source_id),
            "条目必须出现在 Markdown 里：{}",
            item.source_id
        );
        assert!(
            json_items.iter().any(|v| v.get("source_id").and_then(|s| s.as_str())
                == Some(item.source_id.as_str())),
            "条目必须出现在 JSON 里：{}",
            item.source_id
        );
    }
    assert!(ctx.items.iter().any(|i| i.source_id == task_id));
}

/// 14) 空结果：estimated_tokens 合理、不编造内容。
#[test]
fn empty_context_reports_bounded_estimate_without_fabrication() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-empty");
    fx.grant(&row_id, "context.read", "");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest::default(),
    );

    assert!(ctx.items.is_empty(), "没有任何授权资源时不得返回条目");
    assert!(ctx.recent_changes.is_empty(), "空上下文不得编造近期变更");
    assert!(
        ctx.estimated_tokens > 0 && ctx.estimated_tokens <= ctx.budget_tokens,
        "空结果的估算必须是有限且在预算内的：{}",
        ctx.estimated_tokens
    );
    assert!(
        !ctx.markdown.contains("来源 `"),
        "空结果不得编造条目：{}",
        ctx.markdown
    );
    assert!(!ctx.markdown.contains("## Relevant Tasks"));
    assert!(
        ctx.markdown.contains("## Constraints"),
        "固定约束仍然应当给出：{}",
        ctx.markdown
    );
}

// ── v82：ContextRead 不得作为项目访问依据 ─────────────────────────

/// 15) 只持 `ContextRead` 且未显式指定项目：不得默认选中任何项目，也不泄露名称。
#[test]
fn context_read_only_default_context_selects_no_project() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-v82-entry-default");
    fx.grant(&row_id, "context.read", "");
    fx.planning_project("proj-secret", "保密项目名称", "in_progress");
    fx.feature("proj-secret", "保密功能", "in_progress");

    let ctx = build(&fx, &row_id, &agent_id, ContextRequest::default());

    assert!(ctx.project_id.is_empty(), "入口能力不得默认选中项目");
    assert!(ctx.project_name.is_empty(), "入口能力不得拿到项目名称");
    assert!(ctx.items.is_empty(), "入口能力不得返回任何条目");
    assert!(ctx.recent_changes.is_empty());
    assert!(!ctx.markdown.contains("保密项目名称"));
    assert!(!ctx.markdown.contains("保密功能"));
    let json = context::to_json(&ctx).expect("JSON").to_string();
    assert!(!json.contains("保密项目名称"), "JSON 不得泄露项目名称");
    assert!(!json.contains("保密功能"), "JSON 不得泄露规划目标");
}

/// 16) 只持 `tasks.read`（项目 A）：可含 A 的任务，但无项目名称、无规划目标、无项目 B。
#[test]
fn tasks_read_only_context_hides_project_metadata_and_plans() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-v82-tasks-only");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    fx.planning_project("proj-a", "保密项目名称", "in_progress");
    let feature_id = fx.feature("proj-a", "保密功能", "in_progress");
    fx.project("proj-b");
    let task_a = fx.task("A 项目的任务", "", Some("proj-a"));
    let task_b = fx.task("B 项目的任务", "", Some("proj-b"));
    // 既有授权接口只接受真实任务 ID；项目级任务授权直接写能力行。
    fx.grant_raw(&row_id, "tasks.read", "proj-a");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.items
            .iter()
            .any(|i| i.kind == "task" && i.source_id == task_a),
        "有任务读授权的项目必须能返回任务：{:?}",
        ctx.items
    );
    assert!(
        ctx.items.iter().all(|i| i.source_id != task_b),
        "不得返回其它项目的任务"
    );
    assert!(ctx.project_name.is_empty(), "没有 projects.read 不得拿到项目名称");
    assert!(
        !ctx.objective.contains("推进功能") && !ctx.objective.contains("保密功能"),
        "没有 plans.read 不得把规划功能当 objective：{}",
        ctx.objective
    );
    assert!(ctx.items.iter().all(|i| i.source_id != feature_id));
    assert!(!ctx.markdown.contains("保密项目名称"));
    assert!(!ctx.markdown.contains("保密功能"));
    let json = context::to_json(&ctx).expect("JSON").to_string();
    assert!(!json.contains("保密项目名称"));
    assert!(!json.contains("保密功能"));
}

/// 17) 正向对照：`projects.read` + `plans.read` 才显示项目名称与规划目标。
#[test]
fn plans_and_projects_read_reveal_plan_metadata() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-v82-plan-visible");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    fx.planning_project("proj-a", "保密项目名称", "in_progress");
    fx.feature("proj-a", "保密功能", "in_progress");
    fx.grant(&row_id, "projects.read", "proj-a");
    fx.grant(&row_id, "plans.read", "proj-a");
    fx.grant_project(&row_id, "proj-a");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert_eq!(ctx.project_name, "保密项目名称");
    assert!(
        ctx.objective.contains("保密功能"),
        "有 plans.read 时规划功能应成为 objective：{}",
        ctx.objective
    );
    assert!(ctx.markdown.contains("保密项目名称"));
}

/// 18) 近期活动按授权项目过滤：项目 B 的活动不得出现在项目 A 视角里。
#[test]
fn recent_activity_is_scoped_to_authorized_projects() {
    fn activity(fx: &Fixture, principal: &Principal, project: &str, task: &str) {
        store::log_activity(
            &fx.db,
            &store::ActivityEntry {
                principal,
                action: "task.update",
                resource_kind: "task",
                resource_id: task,
                project_id: project,
                request_id: "",
                success: true,
                error_code: "",
                detail: "更新任务",
                revision: None,
                duration_ms: 0,
            },
        );
    }

    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-v82-activity-scope");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    fx.project("proj-b");
    let task_a = fx.task("A 的任务", "", Some("proj-a"));
    let task_b = fx.task("B 的任务", "", Some("proj-b"));
    fx.grant_raw(&row_id, "tasks.read", "proj-a");
    let local = Principal::local(Source::Ui);
    activity(&fx, &local, "proj-a", &task_a);
    activity(&fx, &local, "proj-b", &task_b);

    let items = context::recent(&fx.db, &agent_principal(&row_id, &agent_id), 50)
        .expect("近期活动");

    assert!(
        items.iter().any(|i| i.project_id == "proj-a"),
        "授权项目的活动必须可见：{items:?}"
    );
    assert!(
        items.iter().all(|i| i.project_id != "proj-b"),
        "其它项目的活动不得泄露：{items:?}"
    );
}

/// 19) 没有任何资源读能力时，近期活动返回 FORBIDDEN（不是静默空列表）。
#[test]
fn recent_requires_resource_read_capability() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-v82-activity-forbidden");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");

    let err = context::recent(&fx.db, &agent_principal(&row_id, &agent_id), 20)
        .expect_err("没有资源读能力时近期活动必须拒绝");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
}

/// 20) 报告不会被当作决策：上下文 kinds 与状态保持各自语义。
#[test]
fn report_is_not_rendered_as_decision() {
    let fx = Fixture::new();
    let (row_id, agent_id) = fx.agent("ctx-v82-report-kind");
    fx.grant(&row_id, "context.read", "");
    fx.project("proj-a");
    let handoff_id = fx.handoff("proj-a");
    let report_id = fx.report(&handoff_id);
    let decision_id = fx.decision("proj-a", "真实决策", "accepted");
    fx.grant(&row_id, "handoffs.read", "proj-a");
    fx.grant(&row_id, "decisions.read", "proj-a");
    fx.grant_project(&row_id, "proj-a");

    let ctx = build(
        &fx,
        &row_id,
        &agent_id,
        ContextRequest {
            project_id: Some("proj-a".into()),
            ..Default::default()
        },
    );

    assert!(
        ctx.items
            .iter()
            .any(|i| i.kind == "decision" && i.source_id == decision_id),
        "真实决策必须按 decision 出现：{:?}",
        ctx.items
    );
    assert!(
        ctx.items.iter().all(|i| i.source_id != report_id),
        "报告不得作为决策条目出现：{:?}",
        ctx.items
    );
    assert!(
        ctx.recent_changes
            .iter()
            .all(|i| !(i.kind == "decision" && i.source_id == report_id)),
        "报告不得以 decision 状态出现在近期变更：{:?}",
        ctx.recent_changes
    );
    if let Some(report) = ctx.recent_changes.iter().find(|i| i.source_id == report_id) {
        assert_eq!(report.kind, "report", "报告条目必须保持 report 类型");
    }
    assert_ne!(report_id, handoff_id, "报告与交接是两种 ID");
}
