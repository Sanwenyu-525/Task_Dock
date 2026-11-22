//! Agent 共享工作空间的协议契约测试（v81）。
//!
//! 覆盖：文件导入权限边界、冲突契约、Context 分权、Handoff 身份、REST/CLI 契约。
//! 所有测试使用内存库与临时目录，不触碰真实用户数据。

use std::fs;
use std::path::PathBuf;

use crate::db::Db;
use crate::error::AppError;
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions::{self as mcp_perm, Capability};

use super::permissions::{self as perms, FileImportDecision, ImportIdentity, ImportMode};
use super::service;
use super::sync;
use super::{handoff, workspace, Identity, Principal, Source};

/// 测试夹具：内存库 + 临时工作空间目录。
struct Fixture {
    db: Db,
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "taskdock-agent-access-{name}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

impl Fixture {
    fn new(name: &str) -> Self {
        let db = Db::open_in_memory().expect("内存库");
        let root = temp_root(name);
        let row = workspace::init(&db, Some(root.to_str().unwrap()), Some("测试工作空间"))
            .expect("初始化工作空间");
        // 目录结构与标记文件已由 init 写入。
        assert!(PathBuf::from(&row.root_path).join(super::WORKSPACE_MARKER).exists());
        Self { db, root }
    }

    fn inbox(&self) -> PathBuf {
        self.root.join("inbox")
    }

    /// 写入一个导入文件并返回相对路径。
    fn write_import(&self, name: &str, content: &str) -> String {
        let inbox = self.inbox();
        fs::create_dir_all(&inbox).expect("inbox 目录");
        let path = inbox.join(name);
        fs::write(&path, content).expect("写入导入文件");
        format!("inbox/{name}")
    }

    fn scan(&self) -> sync::ScanReport {
        let row = workspace::active(&self.db).expect("工作空间").expect("已初始化");
        sync::scan(&self.db, &Principal::local(Source::Ui), &row).expect("扫描")
    }

    fn task_count(&self) -> i64 {
        self.db.with_read(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?)
        })
        .unwrap_or(0)
    }

    fn policy(&self, rel_dir: &str, mode: ImportMode, caps: &[&str], project: &str) {
        let row = workspace::active(&self.db).unwrap().unwrap();
        perms::upsert_import_authorization(
            &self.db,
            &row.id,
            rel_dir,
            mode,
            None,
            &caps.iter().map(|c| c.to_string()).collect::<Vec<_>>(),
            project,
        )
        .expect("写入导入策略");
    }
}

/// 注册一个已认证 Agent（scope=project_rw），返回 (row_id, agent_id)。
fn make_agent(db: &Db, agent_id: &str) -> (String, String) {
    let created = mcp_auth::create_agent(db, agent_id, agent_id).expect("创建 Agent");
    mcp_auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
    (created.info.id, created.info.agent_id)
}

fn grant(db: &Db, row_id: &str, capability: &str, resource: &str) {
    mcp_perm::grant(db, row_id, capability, resource).expect("授权");
}

/// 授予项目根授权（v92 统一授权第三层：`mcp_agent_grants`，外键指向项目根）。
fn grant_project(db: &Db, row_id: &str, project: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
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

fn agent_principal(row_id: &str, agent_id: &str) -> Principal {
    Principal::agent(row_id.to_string(), agent_id.to_string(), Source::Mcp)
}

// ── P0：文件导入权限边界 ─────────────────────────────────────────

#[test]
fn unauthorized_file_cannot_create_task() {
    let fx = Fixture::new("p0-unauthorized");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"外部任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "未授权文件不得导入");
    assert_eq!(report.pending_review, 1, "应进入待审核队列");
    assert_eq!(fx.task_count(), 0, "未授权文件不得写业务表");
}

#[test]
fn unauthorized_import_keeps_file_and_records_reason() {
    let fx = Fixture::new("p0-audit");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"外部任务"}}"#,
    );
    fx.scan();
    assert!(fx.inbox().join("a.json").exists(), "未授权文件应保留在 Inbox");
    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].reason.is_empty(), "必须给出拒绝/待批原因");
}

#[test]
fn trusted_policy_allows_matching_capability() {
    let fx = Fixture::new("p0-trusted");
    fx.policy("inbox", ImportMode::Trusted, &["tasks.write"], "");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"可信任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "授权目录应导入：{report:?}");
    assert_eq!(fx.task_count(), 1);
}

#[test]
fn tasks_write_policy_cannot_write_decision() {
    let fx = Fixture::new("p0-taskwrite");
    fx.policy("inbox", ImportMode::Trusted, &["tasks.write"], "");
    fx.write_import(
        "d.json",
        r#"{"schema":"taskdock.import/1","kind":"decision.create","payload":{"title":"越权决策","decision":"x"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "TasksWrite 不得代表 DecisionsWrite");
    assert_eq!(report.failed, 1);
}

#[test]
fn knowledge_write_policy_cannot_write_task() {
    let fx = Fixture::new("p0-knowwrite");
    fx.policy("inbox", ImportMode::Trusted, &["knowledge.write"], "");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"越权任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0);
    assert_eq!(fx.task_count(), 0);
}

#[test]
fn project_scope_blocks_other_project() {
    let fx = Fixture::new("p0-project");
    fx.policy("inbox", ImportMode::Trusted, &["tasks.write"], "proj-a");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"proj-b","payload":{"title":"跨项目任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "项目 A 的授权不能改项目 B");
    assert_eq!(fx.task_count(), 0);
}

#[test]
fn revoked_agent_cannot_import_after_revoke() {
    let fx = Fixture::new("p0-revoke");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-revoked");
    grant(&fx.db, &row_id, "tasks.write", "");
    let row = workspace::active(&fx.db).unwrap().unwrap();
    perms::upsert_import_authorization(
        &fx.db,
        &row.id,
        "inbox",
        ImportMode::Trusted,
        Some(&row_id),
        &["tasks.write".to_string()],
        "",
    )
    .expect("绑定策略");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"撤销前"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "撤销前应可导入：{report:?}");

    mcp_auth::revoke_agent(&fx.db, &row_id).expect("撤销 Agent");
    fx.write_import(
        "b.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"撤销后"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "禁用 Agent 后导入必须失败");
    assert_eq!(fx.task_count(), 1, "撤销后不得再写业务表");
    let _ = agent_id;
}

#[test]
fn failed_import_does_not_touch_business_tables() {
    let fx = Fixture::new("p0-failed");
    fx.policy("inbox", ImportMode::Trusted, &["tasks.write"], "");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":""}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0);
    assert_eq!(report.failed, 1);
    assert_eq!(fx.task_count(), 0);
    let events = super::store::list_sync_events(&fx.db, &workspace::active(&fx.db).unwrap().unwrap().id, 10)
        .expect("同步事件");
    assert!(
        events.iter().any(|e| e.status == "failed"),
        "失败必须留下可追溯记录"
    );
}

#[test]
fn human_approval_applies_pending_import() {
    let fx = Fixture::new("p0-approve");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"待批准任务"}}"#,
    );
    fx.scan();
    assert_eq!(fx.task_count(), 0);
    let requests = sync::list_import_requests(&fx.db, Some("pending")).unwrap();
    let message = sync::approve_import(&fx.db, &Principal::local(Source::Ui), &requests[0].id, "人工确认")
        .expect("批准导入");
    assert!(message.contains("创建任务"), "{message}");
    assert_eq!(fx.task_count(), 1, "批准后应写入业务表");
}

#[test]
fn repeated_scan_does_not_duplicate_task() {
    let fx = Fixture::new("p0-idempotent");
    fx.policy("inbox", ImportMode::Trusted, &["tasks.write"], "");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"幂等任务"}}"#,
    );
    let first = fx.scan();
    assert_eq!(first.imported, 1);
    // 同一路径同内容再放一份（模拟重新投递）。
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"幂等任务"}}"#,
    );
    let second = fx.scan();
    assert_eq!(second.imported, 0, "重复扫描不得重复写入：{second:?}");
    assert_eq!(fx.task_count(), 1);
}

#[test]
fn file_import_identity_is_not_local_human() {
    let db = Db::open_in_memory().unwrap();
    let principal = Principal::file_import("claimed-agent");
    assert_eq!(principal.identity, Identity::FileImport);
    assert!(!principal.is_trusted_local());
    assert!(!principal.label().is_empty());
    let err = super::permissions::require(&db, &principal, Capability::TasksWrite, "").unwrap_err();
    assert_eq!(super::error_code(&err), "FORBIDDEN");
}

#[test]
fn claimed_agent_cannot_impersonate_bound_agent() {
    let fx = Fixture::new("p0-impersonate");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-bound");
    grant(&fx.db, &row_id, "tasks.write", "");
    let row = workspace::active(&fx.db).unwrap().unwrap();
    perms::upsert_import_authorization(
        &fx.db,
        &row.id,
        "inbox",
        ImportMode::Trusted,
        Some(&row_id),
        &["tasks.write".to_string()],
        "",
    )
    .unwrap();
    let decision = perms::authorize_file_import(
        &fx.db,
        &row.id,
        "inbox/a.json",
        &ImportIdentity::ClaimedAgent("someone-else".into()),
        Capability::TasksWrite,
        "",
    )
    .expect("判定");
    match decision {
        FileImportDecision::Rejected { reason, .. } => {
            assert!(reason.contains("someone-else"), "{reason}");
        }
        other => panic!("未验证身份不得冒充其他 Agent：{other:?}"),
    }
    let _ = agent_id;
}

// ── P1：冲突契约 ────────────────────────────────────────────────

#[test]
fn conflict_resolution_rejects_unknown_value() {
    let fx = Fixture::new("p1-resolution");
    let err = sync::resolve_conflict(&fx.db, &Principal::local(Source::Ui), "missing", "keep_local")
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
}

#[test]
fn conflict_capability_follows_resource_type() {
    assert_eq!(
        sync::capability_for_conflict("task.update").unwrap(),
        Capability::TasksWrite
    );
    assert_eq!(
        sync::capability_for_conflict("knowledge.create").unwrap(),
        Capability::KnowledgeWrite
    );
    assert!(sync::capability_for_conflict("mystery.create").is_err());
}

// ── P1：Handoff 身份 ────────────────────────────────────────────

#[test]
fn only_target_agent_can_accept_or_complete_handoff() {
    let fx = Fixture::new("p1-handoff");
    let (_a_row, a_id) = make_agent(&fx.db, "agent-handoff-a");
    let (b_row, b_id) = make_agent(&fx.db, "agent-handoff-b");
    let (_c_row, c_id) = make_agent(&fx.db, "agent-handoff-c");
    for row in [&_a_row, &b_row, &_c_row] {
        grant(&fx.db, row, "handoffs.write", "");
        grant(&fx.db, row, "handoffs.read", "");
    }
    let created = handoff::create_handoff(
        &fx.db,
        &agent_principal(&_a_row, &a_id),
        super::store::HandoffInput {
            to_agent_id: b_id.clone(),
            summary: "交接内容".into(),
            task_id: None,
            project_id: None,
            project_kind: None,
            completed_items: Vec::new(),
            pending_items: Vec::new(),
            decisions: Vec::new(),
            files_changed: Vec::new(),
            risks: Vec::new(),
            next_steps: Vec::new(),
        },
    )
    .expect("创建交接");
    let id = created.handoff.id.clone();
    let revision = created.handoff.revision;

    let outsider = agent_principal(&_c_row, &c_id);
    assert!(
        handoff::accept_handoff(&fx.db, &outsider, &id, revision).is_err(),
        "无关 Agent 不能接收"
    );
    assert!(
        handoff::reject_handoff(&fx.db, &outsider, &id, revision, "不关我事").is_err(),
        "无关 Agent 不能拒绝"
    );
    assert!(
        handoff::complete_handoff(&fx.db, &outsider, &id, revision).is_err(),
        "无关 Agent 不能完成"
    );

    let target = agent_principal(&b_row, &b_id);
    let accepted = handoff::accept_handoff(&fx.db, &target, &id, revision).expect("目标可接收");
    assert_eq!(accepted.status, "accepted");
    let completed =
        handoff::complete_handoff(&fx.db, &target, &id, accepted.revision).expect("目标可完成");
    assert_eq!(completed.status, "completed");
    // 已完成的交接不能重复完成。
    assert!(
        handoff::complete_handoff(&fx.db, &target, &id, completed.revision).is_err(),
        "已完成交接不能重复完成"
    );
}

#[test]
fn stale_revision_is_rejected() {
    let fx = Fixture::new("p1-revision");
    let (_a_row, a_id) = make_agent(&fx.db, "agent-rev-a");
    let (b_row, b_id) = make_agent(&fx.db, "agent-rev-b");
    grant(&fx.db, &_a_row, "handoffs.write", "");
    grant(&fx.db, &b_row, "handoffs.write", "");
    let created = handoff::create_handoff(
        &fx.db,
        &agent_principal(&_a_row, &a_id),
        super::store::HandoffInput {
            to_agent_id: b_id.clone(),
            summary: "版本冲突".into(),
            task_id: None,
            project_id: None,
            project_kind: None,
            completed_items: Vec::new(),
            pending_items: Vec::new(),
            decisions: Vec::new(),
            files_changed: Vec::new(),
            risks: Vec::new(),
            next_steps: Vec::new(),
        },
    )
    .unwrap();
    let err = handoff::accept_handoff(
        &fx.db,
        &agent_principal(&b_row, &b_id),
        &created.handoff.id,
        created.handoff.revision + 5,
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
}

// ── P1：Context 分权 ────────────────────────────────────────────

#[test]
fn context_returns_partial_results_for_partial_permissions() {
    let fx = Fixture::new("p1-context");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-context");
    grant(&fx.db, &row_id, "context.read", "");
    grant(&fx.db, &row_id, "tasks.read", "");
    let ctx = super::context::build(
        &fx.db,
        &agent_principal(&row_id, &agent_id),
        super::context::ContextRequest::default(),
    )
    .expect("上下文装配");
    assert!(
        ctx.items.iter().all(|item| item.kind != "knowledge"),
        "没有 KnowledgeRead 就不应返回知识"
    );
    let authorized = ctx.scope.get("authorized_kinds").cloned().unwrap_or(serde_json::json!({}));
    assert_eq!(authorized.get("knowledge").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(authorized.get("task").and_then(|v| v.as_bool()), Some(true));
}

#[test]
fn context_explicit_unauthorized_kind_is_rejected() {
    let fx = Fixture::new("p1-context-denied");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-context-denied");
    grant(&fx.db, &row_id, "context.read", "");
    grant(&fx.db, &row_id, "tasks.read", "");
    let err = super::context::build(
        &fx.db,
        &agent_principal(&row_id, &agent_id),
        super::context::ContextRequest {
            kinds: vec!["knowledge".into()],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(super::error_code(&err), "FORBIDDEN", "{err:?}");
}

#[test]
fn context_requires_context_read() {
    let fx = Fixture::new("p1-context-entry");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-no-context");
    grant(&fx.db, &row_id, "tasks.read", "");
    let err = super::context::build(
        &fx.db,
        &agent_principal(&row_id, &agent_id),
        super::context::ContextRequest::default(),
    )
    .unwrap_err();
    assert_eq!(super::error_code(&err), "FORBIDDEN");
}

// ── P1：REST / CLI 契约 ─────────────────────────────────────────

#[test]
fn cli_help_matches_command_registry() {
    super::cli::check_cli_documentation_contract(super::cli::USAGE)
        .expect("帮助文本必须覆盖命令注册表");
    assert!(!super::cli::describe_cli_commands().is_empty());
}

#[test]
fn service_rejects_write_for_readonly_agent() {
    let fx = Fixture::new("p1-readonly");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-readonly");
    mcp_auth::set_agent_scope(&fx.db, &row_id, "readonly").unwrap();
    grant(&fx.db, &row_id, "tasks.read", "");
    let err = service::create_task(
        &fx.db,
        &agent_principal(&row_id, &agent_id),
        service::TaskCreateInput {
            title: "只读 Agent 不能建任务".into(),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(super::error_code(&err), "FORBIDDEN");
}

// ── P0：读取入口统一授权（v82）────────────────────────────────────

/// 只持有 `tasks.read` 的 Agent 不得读取决策：返回 FORBIDDEN，不是空列表。
#[test]
fn agent_without_decisions_read_cannot_list_or_get_decision() {
    let db = Db::open_in_memory().expect("内存库");
    let decision = super::store::create_decision(
        &db,
        &Principal::local(Source::Ui),
        super::store::DecisionInput {
            title: "仅本机可见的决策".into(),
            project_id: None,
            project_kind: None,
            context: String::new(),
            decision: "记录一条决策".into(),
            consequences: String::new(),
            alternatives: String::new(),
            tags: Vec::new(),
            status: None,
        },
    )
    .expect("创建决策");

    let (row_id, agent_id) = make_agent(&db, "agent-tasks-only");
    grant(&db, &row_id, "tasks.read", "");
    let principal = agent_principal(&row_id, &agent_id);

    let list_err = service::list_decisions_authorized(&db, &principal, None, None, 50, 0)
        .expect_err("无 decisions.read 不得列出决策");
    assert!(matches!(list_err, AppError::Agent(_)), "{list_err:?}");
    assert_eq!(super::error_code(&list_err), "FORBIDDEN");

    let get_err = service::get_decision_authorized(&db, &principal, &decision.id)
        .expect_err("无 decisions.read 不得读取决策详情");
    assert!(matches!(get_err, AppError::Agent(_)), "{get_err:?}");
    assert_eq!(super::error_code(&get_err), "FORBIDDEN");
}

/// 只授权知识库 KB-A 的 Agent：索引中不得出现 KB-B 的库与文档，读 KB-B 文档被拒绝。
#[test]
fn knowledge_index_and_document_follow_authorized_base_only() {
    let db = Db::open_in_memory().expect("内存库");
    let base_a = crate::capability::knowledge::create_base_impl(
        &db,
        crate::capability::knowledge::KnowledgeBaseInput {
            name: "KB-A".into(),
            description: String::new(),
            kind: "personal".into(),
            project_id: None,
            workspace_id: None,
        },
    )
    .expect("创建 KB-A");
    let base_b = crate::capability::knowledge::create_base_impl(
        &db,
        crate::capability::knowledge::KnowledgeBaseInput {
            name: "KB-B".into(),
            description: String::new(),
            kind: "personal".into(),
            project_id: None,
            workspace_id: None,
        },
    )
    .expect("创建 KB-B");
    let (_, doc_a) = crate::capability::knowledge::create_text_impl(
        &db,
        &base_a.id,
        "A 文档",
        "KB-A 的正文",
    )
    .expect("写入 A 文档");
    let (_, doc_b) = crate::capability::knowledge::create_text_impl(
        &db,
        &base_b.id,
        "B 文档",
        "KB-B 的正文",
    )
    .expect("写入 B 文档");
    let doc_a = doc_a.expect("A 文档 id");
    let doc_b = doc_b.expect("B 文档 id");

    let (row_id, agent_id) = make_agent(&db, "agent-kb-a");
    grant(&db, &row_id, "knowledge.read", &base_a.id);
    let principal = agent_principal(&row_id, &agent_id);

    let index = service::knowledge_index_authorized(&db, &principal).expect("知识索引");
    let base_ids: Vec<String> = index["bases"]
        .as_array()
        .expect("bases 数组")
        .iter()
        .filter_map(|b| b["id"].as_str().map(str::to_string))
        .collect();
    let doc_ids: Vec<String> = index["documents"]
        .as_array()
        .expect("documents 数组")
        .iter()
        .filter_map(|d| d["id"].as_str().map(str::to_string))
        .collect();
    assert!(base_ids.contains(&base_a.id), "授权库必须出现：{base_ids:?}");
    assert!(!base_ids.contains(&base_b.id), "未授权库不得出现：{base_ids:?}");
    assert!(doc_ids.contains(&doc_a), "授权库文档必须出现：{doc_ids:?}");
    assert!(!doc_ids.contains(&doc_b), "未授权库文档不得出现：{doc_ids:?}");

    assert!(
        service::get_knowledge(&db, &principal, &doc_a).is_ok(),
        "授权库文档应可读取"
    );
    let err = service::get_knowledge(&db, &principal, &doc_b)
        .expect_err("未授权库文档必须被拒绝");
    assert!(matches!(err, AppError::Agent(_)), "{err:?}");
    assert_eq!(super::error_code(&err), "FORBIDDEN");
}

/// 只有 `context.read` 不是资源读能力：决策列表与活动列表都必须 FORBIDDEN。
#[test]
fn context_read_alone_cannot_list_decisions_or_activity() {
    let db = Db::open_in_memory().expect("内存库");
    let (row_id, agent_id) = make_agent(&db, "agent-context-only");
    grant(&db, &row_id, "context.read", "");
    let principal = agent_principal(&row_id, &agent_id);

    let decisions_err = service::list_decisions_authorized(&db, &principal, None, None, 50, 0)
        .expect_err("context.read 不能列出决策");
    assert!(matches!(decisions_err, AppError::Agent(_)), "{decisions_err:?}");
    assert_eq!(super::error_code(&decisions_err), "FORBIDDEN");

    let activity_err = service::list_activity_authorized(
        &db,
        &principal,
        &super::store::ActivityQuery {
            agent_id: None,
            interface: None,
            since: None,
            limit: 50,
            offset: 0,
        },
    )
    .expect_err("context.read 不能列出活动");
    assert!(matches!(activity_err, AppError::Agent(_)), "{activity_err:?}");
    assert_eq!(super::error_code(&activity_err), "FORBIDDEN");
}

/// 项目 A 授权看不到项目 B 的活动（服务端 SQL 过滤，不是前端过滤）。
#[test]
fn project_scope_hides_other_project_activity() {
    let db = Db::open_in_memory().expect("内存库");
    let project_a = crate::commands::planning::create_project_impl(
        &db,
        crate::commands::planning::ProjectInput {
            name: "项目 A".into(),
            description: String::new(),
            status: None,
            target_date: None,
        },
    )
    .expect("创建项目 A");
    let project_b = crate::commands::planning::create_project_impl(
        &db,
        crate::commands::planning::ProjectInput {
            name: "项目 B".into(),
            description: String::new(),
            status: None,
            target_date: None,
        },
    )
    .expect("创建项目 B");

    let local = Principal::local(Source::Ui);
    // 活动归属与授权都在项目根域上（v92 统一项目身份）：先解析项目根再落库与授权。
    let root_a = db
        .with_read(|conn| perms::resolve_project_root(conn, &project_a.id))
        .expect("解析项目 A 根")
        .expect("项目 A 必须有项目根");
    let root_b = db
        .with_read(|conn| perms::resolve_project_root(conn, &project_b.id))
        .expect("解析项目 B 根")
        .expect("项目 B 必须有项目根");
    for (project_id, detail) in [
        (root_a.as_str(), "项目 A 的活动"),
        (root_b.as_str(), "项目 B 的活动"),
    ] {
        super::store::log_activity(
            &db,
            &super::store::ActivityEntry {
                principal: &local,
                action: "task.create",
                resource_kind: "task",
                resource_id: "",
                project_id,
                request_id: "",
                success: true,
                error_code: "",
                detail,
                revision: None,
                duration_ms: 0,
            },
        );
    }

    let (row_id, agent_id) = make_agent(&db, "agent-project-a");
    grant(&db, &row_id, "projects.read", &root_a);
    // v92 统一授权第三层：project_rw 的项目型读取还要求项目根授权。
    grant_project(&db, &row_id, &root_a);
    let principal = agent_principal(&row_id, &agent_id);

    let (items, _) = service::list_activity_authorized(
        &db,
        &principal,
        &super::store::ActivityQuery {
            agent_id: None,
            interface: None,
            since: None,
            limit: 50,
            offset: 0,
        },
    )
    .expect("项目 A 授权可读活动");
    assert!(!items.is_empty(), "应能看到项目 A 自己的活动");
    assert!(
        items.iter().all(|item| item.project_id == root_a),
        "只应包含项目 A 的活动：{:?}",
        items.iter().map(|i| &i.project_id).collect::<Vec<_>>()
    );
    assert!(
        items.iter().all(|item| item.project_id != root_b),
        "不得出现项目 B 的活动"
    );
}

/// Token 撤销后，下一次授权查询立即 FORBIDDEN（每次请求重读身份，不缓存）。
#[test]
fn revoked_agent_token_is_denied_immediately() {
    let db = Db::open_in_memory().expect("内存库");
    // v92 统一授权：project_rw 主体按「能力 + 项目根授权」读取，
    // 决策挂在项目根下，Agent 持有该项目的能力与授权。
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO workspace_projects
               (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
             VALUES ('proj-revoke', '撤销测试项目', 'general', 'active', '', NULL, '', ?1, ?1)",
            rusqlite::params![now],
        )?;
        Ok(())
    })
    .expect("创建项目根");
    super::store::create_decision(
        &db,
        &Principal::local(Source::Ui),
        super::store::DecisionInput {
            title: "撤销前可读".into(),
            project_id: Some("proj-revoke".into()),
            project_kind: None,
            context: String::new(),
            decision: "x".into(),
            consequences: String::new(),
            alternatives: String::new(),
            tags: Vec::new(),
            status: None,
        },
    )
    .expect("创建决策");
    let (row_id, agent_id) = make_agent(&db, "agent-revoke-read");
    grant(&db, &row_id, "decisions.read", "proj-revoke");
    grant_project(&db, &row_id, "proj-revoke");
    let principal = agent_principal(&row_id, &agent_id);
    assert!(
        service::list_decisions_authorized(&db, &principal, None, None, 50, 0).is_ok(),
        "撤销前应可读决策"
    );

    mcp_auth::revoke_agent(&db, &row_id).expect("撤销 Agent");
    let err = service::list_decisions_authorized(&db, &principal, None, None, 50, 0)
        .expect_err("撤销后必须立即拒绝");
    assert!(matches!(err, AppError::Agent(_)), "{err:?}");
    assert_eq!(super::error_code(&err), "FORBIDDEN");
}

/// 本机 CLI 主体仍可读取（现有策略：本机人类身份不受 Agent 授权限制）。
#[test]
fn local_cli_principal_can_still_read_decisions() {
    let db = Db::open_in_memory().expect("内存库");
    let created = super::store::create_decision(
        &db,
        &Principal::local(Source::Ui),
        super::store::DecisionInput {
            title: "本机可见".into(),
            project_id: None,
            project_kind: None,
            context: String::new(),
            decision: "本机 CLI 应可读取".into(),
            consequences: String::new(),
            alternatives: String::new(),
            tags: Vec::new(),
            status: None,
        },
    )
    .expect("创建决策");
    let principal = Principal::local(Source::Cli);
    let (items, page) = service::list_decisions_authorized(&db, &principal, None, None, 50, 0)
        .expect("本机 CLI 可读决策");
    assert!(
        items.iter().any(|d| d.id == created.id),
        "本机 CLI 应看到刚创建的决策"
    );
    assert!(page.total >= 1, "分页 total 必须反映真实行数");
}

