//! v82 回归测试：文件导入权限边界（P1-1）、导入幂等与并发租约（P1-2）、
//! 请求状态重置（P2-1）、租约 fencing 与人工批准一致性（v82 收口）。
//!
//! 全部使用内存库 / 临时文件库 + 临时目录，不触碰真实数据。夹具刻意在本文件内复制一份，
//! 避免改动 v81 的 `tests.rs`（他人文件）。

use std::fs;
use std::path::PathBuf;
use std::sync::Barrier;

use crate::db::Db;
use crate::error::AppError;
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions::{self as mcp_perm, Capability};

use super::permissions::{self as perms, ImportMode};
use super::service;
use super::sync;
use super::{error_code, store, workspace, Principal, Source};

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
        "taskdock-v82-import-{name}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 文件库夹具：**两个独立的 `Db` 句柄**指向同一个 SQLite 文件。
///
/// 这是「真并发」的前提：同一个 `Db` 的写连接是互斥的，
/// 顺序调用冒充不了并发；必须让两个连接真正同时争抢同一条租约行。
struct FileDbFixture {
    dir: PathBuf,
    path: PathBuf,
    workspace_root: PathBuf,
}

impl FileDbFixture {
    fn new(name: &str) -> Self {
        let dir = temp_root(name);
        let path = dir.join("taskdock.db");
        let workspace_root = dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("工作空间目录");
        Self {
            dir,
            path,
            workspace_root,
        }
    }

    /// 打开一个**独立连接**（各自持有自己的写连接）。
    fn open(&self) -> Db {
        Db::open(&self.path).expect("打开文件库")
    }
}

impl Drop for FileDbFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    fn new(name: &str) -> Self {
        let db = Db::open_in_memory().expect("内存库");
        let root = temp_root(name);
        let row = workspace::init(&db, Some(root.to_str().unwrap()), Some("测试工作空间"))
            .expect("初始化工作空间");
        assert!(PathBuf::from(&row.root_path)
            .join(super::WORKSPACE_MARKER)
            .exists());
        Self { db, root }
    }

    fn inbox(&self) -> PathBuf {
        self.root.join("inbox")
    }

    fn write_import(&self, name: &str, content: &str) -> String {
        let inbox = self.inbox();
        fs::create_dir_all(&inbox).expect("inbox 目录");
        fs::write(inbox.join(name), content).expect("写入导入文件");
        format!("inbox/{name}")
    }

    fn scan(&self) -> sync::ScanReport {
        let row = workspace::active(&self.db)
            .expect("工作空间")
            .expect("已初始化");
        sync::scan(&self.db, &Principal::local(Source::Ui), &row).expect("扫描")
    }

    fn workspace_row_id(&self) -> String {
        workspace::active(&self.db).unwrap().unwrap().id
    }

    fn task_count(&self) -> i64 {
        self.db
            .with_read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?))
            .unwrap_or(0)
    }

    fn decision_count(&self) -> i64 {
        self.db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM agent_decisions", [], |r| {
                    r.get(0)
                })?)
            })
            .unwrap_or(0)
    }

    fn knowledge_count(&self) -> i64 {
        self.db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM knowledge_documents", [], |r| {
                    r.get(0)
                })?)
            })
            .unwrap_or(0)
    }

    /// 导入租约行数（当前工作空间）。
    fn lease_count(&self) -> i64 {
        let row_id = self.workspace_row_id();
        self.db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM agent_import_claims WHERE workspace_row_id = ?1",
                    rusqlite::params![row_id],
                    |r| r.get(0),
                )?)
            })
            .unwrap_or(0)
    }

    /// (status, owner, attempt) —— 租约行现状。
    fn lease_state(&self, claim_key: &str) -> Option<(String, String, i64)> {
        let row_id = self.workspace_row_id();
        self.db
            .with_read(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT status, owner, attempt FROM agent_import_claims
                         WHERE workspace_row_id = ?1 AND claim_key = ?2",
                        rusqlite::params![row_id, claim_key],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .ok())
            })
            .unwrap_or(None)
    }

    fn policy(&self, rel_dir: &str, mode: ImportMode, caps: &[&str], project: &str) {
        let row_id = self.workspace_row_id();
        perms::upsert_import_authorization(
            &self.db,
            &row_id,
            rel_dir,
            mode,
            None,
            &caps.iter().map(|c| c.to_string()).collect::<Vec<_>>(),
            project,
        )
        .expect("写入导入策略");
    }

    /// 绑定到某个已注册 Agent 的目录策略。
    fn policy_bound(
        &self,
        rel_dir: &str,
        mode: ImportMode,
        caps: &[&str],
        project: &str,
        agent_row_id: &str,
    ) {
        let row_id = self.workspace_row_id();
        perms::upsert_import_authorization(
            &self.db,
            &row_id,
            rel_dir,
            mode,
            Some(agent_row_id),
            &caps.iter().map(|c| c.to_string()).collect::<Vec<_>>(),
            project,
        )
        .expect("写入导入策略");
    }

    /// 建一个真实存在的项目工作空间项目（关联任务的前提）。
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

    /// 建一个知识库（可归属到某个项目）。
    fn kb(&self, id: &str, project: Option<&str>) {
        let now = crate::agents::now_iso();
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO knowledge_bases
                       (id, name, description, kind, project_id, favorite, created_at, updated_at)
                     VALUES (?1, ?1, '', 'project', ?2, 0, ?3, ?3)",
                    rusqlite::params![id, project, now],
                )?;
                Ok(())
            })
            .expect("创建知识库");
    }

    /// 本机直接建任务（不经过导入），并可选择挂到某个项目下。
    fn task(&self, title: &str, project: Option<&str>) -> String {
        let task = service::create_task(
            &self.db,
            &Principal::local(Source::Ui),
            service::TaskCreateInput {
                title: title.into(),
                ..Default::default()
            },
        )
        .expect("创建任务");
        if let Some(project_id) = project {
            crate::commands::project_workspace::workspace_task_link_add_impl(
                &self.db, project_id, &task.id,
            )
            .expect("关联任务");
        }
        task.id
    }

    fn task_title(&self, id: &str) -> String {
        self.db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT title FROM tasks WHERE id = ?1",
                    rusqlite::params![id],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .expect("读取任务")
    }

    fn linked_projects(&self, task_id: &str) -> Vec<String> {
        self.db
            .with_read(|conn| {
                let mut stmt =
                    conn.prepare("SELECT project_id FROM workspace_task_links WHERE task_id = ?1")?;
                let rows = stmt.query_map(rusqlite::params![task_id], |r| r.get::<_, String>(0))?;
                let mut out = Vec::new();
                for item in rows {
                    out.push(item?);
                }
                Ok(out)
            })
            .unwrap_or_default()
    }

    /// (status, attempt, detail_json, decided_hash)
    fn request_state(&self, rel_path: &str) -> (String, i64, String, String) {
        let row_id = self.workspace_row_id();
        self.db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT status, attempt, detail_json, decided_hash
                     FROM agent_import_requests WHERE workspace_row_id = ?1 AND rel_path = ?2",
                    rusqlite::params![row_id, rel_path],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    },
                )?)
            })
            .expect("读取导入请求")
    }
}

fn make_agent(db: &Db, agent_id: &str) -> (String, String) {
    let created = mcp_auth::create_agent(db, agent_id, agent_id).expect("创建 Agent");
    mcp_auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
    (created.info.id, created.info.agent_id)
}

fn grant_capability(db: &Db, row_id: &str, capability: &str) {
    mcp_perm::grant(db, row_id, capability, "").expect("授权");
}

/// 用「项目 A 的人工授权」直接驱动一次导入，返回结果（便于断言错误码）。
fn import_with_manual_grant(
    fx: &Fixture,
    raw: &str,
    path_name: &str,
    project_id: &str,
) -> Result<String, crate::error::AppError> {
    let path = fx.inbox().join(path_name);
    let doc = sync::parse_external_document(raw, &path).expect("解析文档");
    let capability = perms::resolve_import_capability(&doc.envelope.kind).expect("能力映射");
    let grant = perms::manual_import_grant(capability, project_id, "tester");
    let principal = Principal::file_import_granted(grant, "");
    sync::import_document(&fx.db, &principal, &doc)
}

const PROJECT_SCOPED_CAPS: &[&str] = &["tasks.write"];

/// 认领一条租约并返回其句柄（测试用快捷方式）。
fn acquire_lease(db: &Db, ws: &str, key: &str, owner: &str, lease_secs: i64) -> store::ImportLease {
    match store::claim_import_lease(
        db,
        ws,
        key,
        "inbox/a.json",
        "task.create",
        "hash-for-test",
        "file-import",
        owner,
        lease_secs,
    )
    .expect("认领租约")
    {
        store::LeaseClaim::Acquired(lease) => lease,
        other => panic!("应取得租约: {other:?}"),
    }
}

// ── P1-1：权限边界 ───────────────────────────────────────────────

/// 1) 项目 A 的授权不能更新项目 B 的任务。
#[test]
fn project_policy_cannot_update_task_in_other_project() {
    let fx = Fixture::new("p1-other-project");
    fx.project("proj-a");
    fx.project("proj-b");
    let task_id = fx.task("B 的任务", Some("proj-b"));
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");

    let raw = format!(
        "---\nkind: task.update\ntaskdock_id: {task_id}\nbase_revision: 1\ntitle: 被改写\n---\n正文\n"
    );
    fx.write_import("a.md", &raw);
    let report = fx.scan();
    assert_eq!(report.imported, 0, "跨项目更新必须失败：{report:?}");
    assert_eq!(fx.task_title(&task_id), "B 的任务", "任务内容不得变化");

    // 直接驱动 import_document 断言错误码是 FORBIDDEN（而不是业务层的其他错误）。
    let err = import_with_manual_grant(&fx, &raw, "b.md", "proj-a").unwrap_err();
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
}

/// 2) P1-1 核心回归：伪造 `project_id=A` 不能更新「无项目归属」的任务。
#[test]
fn forged_project_id_cannot_update_unowned_task() {
    let fx = Fixture::new("p1-forged");
    fx.project("proj-a");
    let task_id = fx.task("无归属任务", None);
    assert!(fx.linked_projects(&task_id).is_empty());

    let raw = format!(
        "---\nkind: task.update\ntaskdock_id: {task_id}\nproject_id: proj-a\nbase_revision: 1\ntitle: 越权改写\n---\n正文\n"
    );
    fx.write_import("a.md", &raw);

    let err = import_with_manual_grant(&fx, &raw, "a.md", "proj-a").unwrap_err();
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(
        fx.task_title(&task_id),
        "无归属任务",
        "归属不可知时不得写入"
    );

    // 走完整扫描也一样：不允许因为文件自称 proj-a 就更新无归属任务。
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");
    let report = fx.scan();
    assert_eq!(report.imported, 0, "{report:?}");
    assert_eq!(fx.task_title(&task_id), "无归属任务");
}

/// 3) 文件缺 `project_id` 时，项目级授权创建的任务必须绑到授权项目。
#[test]
fn project_scoped_create_links_task_to_authorized_project() {
    let fx = Fixture::new("p1-link");
    fx.project("proj-a");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"项目任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");

    let task_id: String = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row("SELECT id FROM tasks LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })?)
        })
        .unwrap();
    assert_eq!(
        fx.linked_projects(&task_id),
        vec!["proj-a".to_string()],
        "授权项目创建的任务必须挂到授权项目"
    );
}

/// v92 统一项目身份：文件导入按项目根落库——任务关联
/// （workspace_task_links）指向项目根，决策归属项目根且 project_kind='project'。
#[test]
fn import_writes_project_root_for_task_and_decision() {
    let fx = Fixture::new("v92-root-import");
    fx.project("proj-root");
    fx.policy(
        "inbox",
        ImportMode::Trusted,
        &["tasks.write", "decisions.write"],
        "proj-root",
    );
    fx.write_import(
        "a-task.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"proj-root","payload":{"title":"根项目任务"}}"#,
    );
    fx.write_import(
        "b-decision.json",
        r#"{"schema":"taskdock.import/1","kind":"decision.create","project_id":"proj-root","payload":{"title":"根项目决策","decision":"采用方案 A"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 2, "两份文件都应导入：{report:?}");

    // 任务落库且 workspace_task_links 指向项目根。
    let links: Vec<String> = fx
        .db
        .with_read(|conn| {
            let mut stmt =
                conn.prepare("SELECT task_id FROM workspace_task_links WHERE project_id = ?1")?;
            let rows = stmt.query_map(rusqlite::params!["proj-root"], |r| {
                r.get::<_, String>(0)
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .expect("读取任务关联");
    assert_eq!(links.len(), 1, "任务必须关联到项目根：{links:?}");

    // 决策落库归属项目根，project_kind 收敛为 'project'（新数据不再写 planning/workspace）。
    let (project_id, kind): (String, String) = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT project_id, project_kind FROM agent_decisions
                 ORDER BY created_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("读取决策归属");
    assert_eq!(project_id, "proj-root", "决策归属必须是项目根");
    assert_eq!(kind, "project", "新决策的 project_kind 必须是 'project'");
}

/// 跨项目拒绝：授权限项目 P1 的导入授权写入 P2 → FORBIDDEN，业务表零写入。
#[test]
fn project_scoped_import_cannot_write_other_project() {
    let fx = Fixture::new("v92-cross-import");
    fx.project("proj-p1");
    fx.project("proj-p2");

    let task_raw = r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"proj-p2","payload":{"title":"越权任务"}}"#;
    let err = import_with_manual_grant(&fx, task_raw, "task.json", "proj-p1").unwrap_err();
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(fx.task_count(), 0, "越权任务不得落库");

    let decision_raw = r#"{"schema":"taskdock.import/1","kind":"decision.create","project_id":"proj-p2","payload":{"title":"越权决策","decision":"x"}}"#;
    let err = import_with_manual_grant(&fx, decision_raw, "decision.json", "proj-p1").unwrap_err();
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(fx.decision_count(), 0, "越权决策不得落库");
}

/// 4) 全局授权（`project_id=""`）正常创建，且不强行绑定项目。
#[test]
fn global_grant_creates_task_without_project() {
    let fx = Fixture::new("p1-global");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"全局任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");
    assert_eq!(fx.task_count(), 1);
    let task_id: String = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row("SELECT id FROM tasks LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })?)
        })
        .unwrap();
    assert!(fx.linked_projects(&task_id).is_empty(), "全局授权不猜项目");
}

/// 5) 项目级授权 + 文件声明一致 → 创建成功并绑定项目。
#[test]
fn project_scoped_create_succeeds_when_declared_matches() {
    let fx = Fixture::new("p1-match");
    fx.project("proj-a");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"proj-a","payload":{"title":"一致任务"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");
    let task_id: String = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row("SELECT id FROM tasks LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })?)
        })
        .unwrap();
    assert_eq!(fx.linked_projects(&task_id), vec!["proj-a".to_string()]);
}

/// 6) Agent 被撤销后导入立即失效（能力来源仍每次重读）。
#[test]
fn revoked_agent_cannot_import_after_revoke() {
    let fx = Fixture::new("p1-revoke");
    let (row_id, _agent_id) = make_agent(&fx.db, "agent-revoked");
    grant_capability(&fx.db, &row_id, "tasks.write");
    perms::upsert_import_authorization(
        &fx.db,
        &fx.workspace_row_id(),
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
    assert_eq!(fx.scan().imported, 1);
    assert_eq!(fx.task_count(), 1);

    mcp_auth::revoke_agent(&fx.db, &row_id).expect("撤销 Agent");
    fx.write_import(
        "b.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"撤销后"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "撤销后不得再导入：{report:?}");
    assert_eq!(fx.task_count(), 1, "撤销后不得再写业务表");
}

// ── P1-2：幂等与并发 ─────────────────────────────────────────────

/// 7) 他人持有未过期租约时，scan 不归档、不写业务表。
#[test]
fn in_progress_lease_keeps_file_in_inbox_and_writes_nothing() {
    let fx = Fixture::new("p1-2-inflight");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    let raw =
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"并发任务"}}"#;
    let rel = fx.write_import("a.json", raw);

    let hash = sync::sha256(raw);
    let key = sync::claim_key(&rel, "task.create", &hash, "file-import");
    let claimed = store::claim_import_lease(
        &fx.db,
        &fx.workspace_row_id(),
        &key,
        &rel,
        "task.create",
        &hash,
        "file-import",
        "other-worker",
        300,
    )
    .expect("抢占租约");
    assert!(matches!(claimed, store::LeaseClaim::Acquired(_)));

    let report = fx.scan();
    assert_eq!(report.imported, 0, "{report:?}");
    assert_eq!(report.skipped, 1, "应记为 skipped：{report:?}");
    assert_eq!(fx.task_count(), 0, "进行中不得写业务表");
    assert!(
        fx.inbox().join("a.json").exists(),
        "他人执行中禁止归档（归档会让执行者读不到文件）"
    );
    assert!(
        report.messages.iter().any(|m| m.contains("other-worker")),
        "reason 必须写清 holder：{report:?}"
    );
}

/// 8) 同一文件重复扫描只产生一份业务数据。
#[test]
fn repeated_scan_produces_single_task() {
    let fx = Fixture::new("p1-2-repeat");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    let raw =
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"幂等任务"}}"#;
    fx.write_import("a.json", raw);
    assert_eq!(fx.scan().imported, 1);

    // 模拟重新投递同一内容（路径相同、内容相同）。
    fx.write_import("a.json", raw);
    let second = fx.scan();
    assert_eq!(second.imported, 0, "重复扫描不得重复写入：{second:?}");
    assert_eq!(second.skipped, 1);
    assert_eq!(fx.task_count(), 1);
}

/// 9) 内容变化 → 请求回到 pending、attempt 递增、旧结论进 history。
#[test]
fn changed_content_resets_request_to_pending_with_history() {
    let fx = Fixture::new("p2-1-reset");
    // 无策略 → 待审核，不写业务表。
    let rel = fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"第一版"}}"#,
    );
    fx.scan();
    let (status, attempt, _, _) = fx.request_state(&rel);
    assert_eq!(status, "pending");
    assert_eq!(attempt, 0);

    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);
    sync::approve_import(
        &fx.db,
        &Principal::local(Source::Ui),
        &requests[0].id,
        "确认",
    )
    .expect("人工批准");
    let (status, _, _, decided_hash) = fx.request_state(&rel);
    assert_eq!(status, "imported");
    assert!(!decided_hash.is_empty(), "批准成功必须记录 decided_hash");

    // 同路径写入不同内容 → 必须重新进入待审核，且保留旧结论。
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"第二版"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0);
    assert_eq!(report.pending_review, 1, "{report:?}");

    let (status, attempt, detail, decided_hash) = fx.request_state(&rel);
    assert_eq!(status, "pending", "内容变化必须回到 pending");
    assert_eq!(attempt, 1, "attempt 必须递增");
    assert!(decided_hash.is_empty(), "重新待审时旧 hash 必须清空");
    let detail: serde_json::Value = serde_json::from_str(&detail).expect("detail_json");
    let history = detail
        .get("history")
        .and_then(|v| v.as_array())
        .expect("history 数组");
    assert_eq!(history.len(), 1, "旧结论必须保留：{detail}");
    assert_eq!(
        history[0].get("status").and_then(|v| v.as_str()),
        Some("imported")
    );
}

/// 10) 他人持租约时 approve 返回 CONFLICT，且请求状态不变。
#[test]
fn approve_import_returns_conflict_while_lease_held() {
    let fx = Fixture::new("p1-2-approve");
    let rel = fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"待批准"}}"#,
    );
    fx.scan();
    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);

    let hash = requests[0].content_hash.clone();
    let key = sync::claim_key(&rel, "task.create", &hash, "file-import");
    let claimed = store::claim_import_lease(
        &fx.db,
        &fx.workspace_row_id(),
        &key,
        &rel,
        "task.create",
        &hash,
        "file-import",
        "other-worker",
        300,
    )
    .expect("抢占租约");
    assert!(matches!(claimed, store::LeaseClaim::Acquired(_)));

    let err = sync::approve_import(
        &fx.db,
        &Principal::local(Source::Ui),
        &requests[0].id,
        "确认",
    )
    .unwrap_err();
    assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
    let (status, _, _, _) = fx.request_state(&rel);
    assert_eq!(status, "pending", "进行中不得把请求改成 imported");
    assert_eq!(fx.task_count(), 0);
}

// 保持 `Capability` 在编译期被引用（能力映射是边界的一部分）。
#[test]
fn import_kind_maps_to_write_capability() {
    assert_eq!(
        perms::resolve_import_capability("task.create"),
        Some(Capability::TasksWrite)
    );
    assert_eq!(
        perms::resolve_import_capability("handoff.create"),
        Some(Capability::HandoffsWrite)
    );
}

// ── v82 收口：权限与项目归属（Agent A）─────────────────────────

/// 11) 合法项目导入成功：项目级授权 + 声明一致 → 写入并绑定授权项目。
#[test]
fn authorized_project_import_succeeds() {
    let fx = Fixture::new("a2-legal-project");
    fx.project("proj-a");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"proj-a","payload":{"title":"合法导入"}}"#,
    );

    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");
    assert_eq!(report.failed, 0, "{report:?}");
    assert_eq!(fx.task_count(), 1);

    let task_id: String = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row("SELECT id FROM tasks LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })?)
        })
        .unwrap();
    assert_eq!(
        fx.linked_projects(&task_id),
        vec!["proj-a".to_string()],
        "合法导入必须绑定到授权项目"
    );
}

/// 12) 项目 ID 伪造：文件声明别的项目 → 拒绝，且业务表零写入。
#[test]
fn forged_project_id_is_rejected() {
    let fx = Fixture::new("a2-forged-project");
    fx.project("proj-a");
    fx.project("proj-b");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");
    // 文件自称 proj-b，授权只允许 proj-a。
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"proj-b","payload":{"title":"伪造归属"}}"#,
    );

    let report = fx.scan();
    assert_eq!(report.imported, 0, "伪造项目必须被拒绝：{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.task_count(), 0, "伪造项目不得写业务表");
    assert!(
        report.messages.iter().any(|m| m.contains("proj-a")),
        "拒绝原因必须写明授权项目：{report:?}"
    );
}

/// 13) 空 project_id 不能绕过项目授权：
///     - 更新类：真实归属不是授权项目 → 拒绝（空声明不构成豁免）；
///     - 创建类：落到授权项目（空声明不构成越权）。
#[test]
fn empty_project_id_cannot_bypass_project_scope() {
    let fx = Fixture::new("a2-empty-project");
    fx.project("proj-a");
    fx.project("proj-b");
    let foreign = fx.task("B 的任务", Some("proj-b"));
    let owned = fx.task("A 的任务", Some("proj-a"));
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");

    // 文件**不声明** project_id，目标是 proj-b 的任务 → 必须拒绝。
    let raw = format!(
        "---\nkind: task.update\ntaskdock_id: {foreign}\nbase_revision: 1\ntitle: 越权改写\n---\n正文\n"
    );
    fx.write_import("a.md", &raw);
    let report = fx.scan();
    assert_eq!(report.imported, 0, "空声明不得绕过项目授权：{report:?}");
    assert_eq!(fx.task_title(&foreign), "B 的任务", "B 的任务不得被改写");

    // 文件不声明 project_id，目标是 proj-a 的任务 → 允许（真实归属在授权范围内）。
    let raw_ok = format!(
        "---\nkind: task.update\ntaskdock_id: {owned}\nbase_revision: 1\ntitle: 合法改写\n---\n正文\n"
    );
    fx.write_import("b.md", &raw_ok);
    let report = fx.scan();
    assert_eq!(report.imported, 1, "真实归属在授权项目内应放行：{report:?}");
    assert_eq!(fx.task_title(&owned), "合法改写");
}

/// 14) 跨项目更新被拒绝：授权项目 A，目标任务是项目 B 的资源。
#[test]
fn cross_project_update_is_rejected() {
    let fx = Fixture::new("a2-cross-project");
    fx.project("proj-a");
    fx.project("proj-b");
    let task_id = fx.task("B 的任务", Some("proj-b"));
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "proj-a");

    let raw = format!(
        "---\nkind: task.update\ntaskdock_id: {task_id}\nbase_revision: 1\ntitle: 被改写\n---\n正文\n"
    );
    fx.write_import("a.md", &raw);

    let report = fx.scan();
    assert_eq!(report.imported, 0, "{report:?}");
    assert_eq!(fx.task_title(&task_id), "B 的任务", "跨项目更新不得落库");
    assert_eq!(fx.task_count(), 1, "不得新建任务");
}

/// 15) Agent 身份伪造被拒绝；自称与绑定 Agent 一致时才放行。
#[test]
fn claimed_agent_identity_must_match_bound_agent() {
    let fx = Fixture::new("a2-agent-identity");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-bound");
    grant_capability(&fx.db, &row_id, "tasks.write");
    fx.policy_bound("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "", &row_id);

    // 文件自称另一个 Agent → 冒充，拒绝。
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","agent_id":"someone-else","payload":{"title":"冒充"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "冒充身份必须被拒绝：{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.task_count(), 0);
    assert!(
        report.messages.iter().any(|m| m.contains("someone-else")),
        "拒绝原因必须写明自称身份：{report:?}"
    );

    // 文件自称绑定 Agent 的真实 agent_id → 放行（身份经库内登记值复核）。
    fx.write_import(
        "b.json",
        &format!(
            r#"{{"schema":"taskdock.import/1","kind":"task.create","agent_id":"{agent_id}","payload":{{"title":"正版"}}}}"#
        ),
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");
    assert_eq!(fx.task_count(), 1);
}

/// 16) 绑定的 Agent 被撤销后，即使文件自称正确身份也必须拒绝。
#[test]
fn revoked_bound_agent_is_rejected_even_with_matching_identity() {
    let fx = Fixture::new("a2-revoked-identity");
    let (row_id, agent_id) = make_agent(&fx.db, "agent-bound-revoked");
    grant_capability(&fx.db, &row_id, "tasks.write");
    fx.policy_bound("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "", &row_id);

    mcp_auth::revoke_agent(&fx.db, &row_id).expect("撤销 Agent");

    fx.write_import(
        "a.json",
        &format!(
            r#"{{"schema":"taskdock.import/1","kind":"task.create","agent_id":"{agent_id}","payload":{{"title":"撤销后"}}}}"#
        ),
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "撤销后必须拒绝：{report:?}");
    assert_eq!(fx.task_count(), 0, "撤销后不得写业务表");
}

/// 17) 无授权能力时被拒绝：
///     - 目录授权不含该 kind 对应的写能力；
///     - 绑定的 Agent 根本没有这项能力。
#[test]
fn missing_capability_is_rejected() {
    let fx = Fixture::new("a2-no-capability");
    // 目录只给了 tasks.write → 决策写入必须被拒。
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    fx.write_import(
        "d.json",
        r#"{"schema":"taskdock.import/1","kind":"decision.create","payload":{"title":"越权决策","decision":"x"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "缺少 decisions.write 必须被拒：{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.decision_count(), 0, "不得写决策表");

    // 绑定 Agent 只有读能力 → 写能力缺失，必须被拒。
    let fx2 = Fixture::new("a2-agent-no-capability");
    let (row_id, _agent_id) = make_agent(&fx2.db, "agent-readonly-cap");
    grant_capability(&fx2.db, &row_id, "tasks.read");
    fx2.policy_bound("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "", &row_id);
    fx2.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"无能力"}}"#,
    );
    let report = fx2.scan();
    assert_eq!(report.imported, 0, "Agent 没有 tasks.write 必须被拒：{report:?}");
    assert_eq!(fx2.task_count(), 0);
}

/// 18) 项目不存在时被拒绝：授权项目与文件声明的项目都必须真实存在。
#[test]
fn nonexistent_project_is_rejected() {
    let fx = Fixture::new("a2-ghost-project");
    // 授权指向一个不存在的项目 → 不得放行。
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "ghost-project");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"ghost-project","payload":{"title":"幽灵"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "授权项目不存在必须被拒：{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.task_count(), 0, "不得写业务表");

    // 全局授权 + 文件声明了不存在的项目 → 同样不得放行。
    let fx2 = Fixture::new("a2-ghost-declared");
    fx2.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    fx2.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","project_id":"ghost-project","payload":{"title":"幽灵2"}}"#,
    );
    let report = fx2.scan();
    assert_eq!(report.imported, 0, "声明了不存在的项目必须被拒：{report:?}");
    assert_eq!(fx2.task_count(), 0);
}

/// 19) 项目归属不一致被拒绝：文件声明 proj-a，载荷点名的知识库却属于 proj-b。
#[test]
fn declared_project_inconsistent_with_resource_owner_is_rejected() {
    let fx = Fixture::new("a2-owner-mismatch");
    fx.project("proj-a");
    fx.project("proj-b");
    fx.kb("kb-a", Some("proj-a"));
    fx.kb("kb-b", Some("proj-b"));
    fx.policy("inbox", ImportMode::Trusted, &["knowledge.write"], "");

    // 声明 proj-a，实际写进 proj-b 的知识库 → 借壳，必须拒绝。
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"knowledge.create","project_id":"proj-a","payload":{"title":"借壳","content":"正文","kb_id":"kb-b"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 0, "归属不一致必须被拒：{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.knowledge_count(), 0, "不得写入其它项目的知识库");

    // 声明与知识库归属一致 → 放行。
    fx.write_import(
        "b.json",
        r#"{"schema":"taskdock.import/1","kind":"knowledge.create","project_id":"proj-a","payload":{"title":"正常","content":"正文","kb_id":"kb-a"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");
    assert_eq!(fx.knowledge_count(), 1);
}

// ── v82 收口：租约并发与 fencing（Agent A）──────────────────────

/// 20) **真并发**：两个独立数据库连接同时认领同一个 claim_key → 只有一个成功。
///
/// 并发保证：
/// - 两个 `Db::open()` 打开同一个 SQLite 文件，各自持有**独立的写连接**；
/// - 两个 OS 线程用 `Barrier` 同步起跑，同时执行同一条认领语句；
/// - 认领是单条 `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`，
///   SQLite 保证其原子性 → 只能有一行被更新成功。
#[test]
fn concurrent_claims_on_two_connections_have_exactly_one_winner() {
    let fixture = FileDbFixture::new("a2-lease-race");
    let db_a = fixture.open();
    let db_b = fixture.open();
    let row = workspace::init(
        &db_a,
        Some(fixture.workspace_root.to_str().unwrap()),
        Some("并发工作空间"),
    )
    .expect("初始化工作空间");
    let ws = row.id.clone();

    let barrier = std::sync::Arc::new(Barrier::new(2));
    let ws_a = ws.clone();
    let ws_b = ws.clone();
    let bar_a = barrier.clone();
    let bar_b = barrier.clone();

    let handle_a = std::thread::spawn(move || {
        bar_a.wait();
        store::claim_import_lease(
            &db_a, &ws_a, "race-key", "inbox/a.json", "task.create", "same-hash", "file-import",
            "owner-a", 300,
        )
    });
    let handle_b = std::thread::spawn(move || {
        bar_b.wait();
        store::claim_import_lease(
            &db_b, &ws_b, "race-key", "inbox/a.json", "task.create", "same-hash", "file-import",
            "owner-b", 300,
        )
    });

    let claim_a = handle_a.join().expect("线程 A 结束").expect("线程 A 认领");
    let claim_b = handle_b.join().expect("线程 B 结束").expect("线程 B 认领");

    let winners = [&claim_a, &claim_b]
        .iter()
        .filter(|claim| matches!(claim, store::LeaseClaim::Acquired(_)))
        .count();
    assert_eq!(winners, 1, "同一个 claim_key 只能有一个 owner：{claim_a:?} / {claim_b:?}");

    let loser = [&claim_a, &claim_b]
        .into_iter()
        .find_map(|claim| match claim {
            store::LeaseClaim::InProgress { owner, until } => {
                Some((owner.clone(), until.clone()))
            }
            _ => None,
        })
        .expect("失败方必须给出「进行中」结论");
    assert!(
        loser.0 == "owner-a" || loser.0 == "owner-b",
        "进行中结论必须写明持有者：{loser:?}"
    );

    // 库内也只能有一行租约，且 attempt 为 1。
    let db_check = fixture.open();
    let rows: i64 = db_check
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM agent_import_claims WHERE workspace_row_id = ?1 AND claim_key = ?2",
                rusqlite::params![ws, "race-key"],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(rows, 1, "同一 claim_key 只能有一行租约");
}

/// 21) 同一租约只有一个 owner：他人认领得到「进行中」，且持有关系唯一。
#[test]
fn lease_has_exactly_one_owner() {
    let fx = Fixture::new("a2-single-owner");
    let ws = fx.workspace_row_id();
    let lease = acquire_lease(&fx.db, &ws, "single-key", "owner-a", 300);

    assert!(
        store::holds_import_lease(&fx.db, &ws, "single-key", "owner-a").unwrap(),
        "持有者必须持有租约"
    );
    assert!(
        !store::holds_import_lease(&fx.db, &ws, "single-key", "owner-b").unwrap(),
        "非持有者不得被认为持有租约"
    );

    let second = store::claim_import_lease(
        &fx.db,
        &ws,
        "single-key",
        "inbox/a.json",
        "task.create",
        "hash-for-test",
        "file-import",
        "owner-b",
        300,
    )
    .expect("第二次认领");
    match second {
        store::LeaseClaim::InProgress { owner, .. } => {
            assert_eq!(owner, "owner-a", "冲突方必须看到真正的持有者")
        }
        other => panic!("第二个 owner 不得取得租约: {other:?}"),
    }

    let (status, owner, attempt) = fx.lease_state("single-key").expect("租约行存在");
    assert_eq!(status, "inflight");
    assert_eq!(owner, "owner-a");
    assert_eq!(attempt, lease.attempt as i64);
}

/// 22) 租约过期后可被重新认领，`attempt` 递增（fencing token 单调）。
#[test]
fn expired_lease_can_be_reclaimed_with_incremented_attempt() {
    let fx = Fixture::new("a2-reclaim");
    let ws = fx.workspace_row_id();
    // lease_secs = 0 → 认领瞬间即过期。
    let first = acquire_lease(&fx.db, &ws, "expire-key", "owner-a", 0);
    assert_eq!(first.attempt, 1);
    assert!(
        !store::holds_import_lease(&fx.db, &ws, "expire-key", "owner-a").unwrap(),
        "过期租约不再被持有"
    );

    let second = acquire_lease(&fx.db, &ws, "expire-key", "owner-b", 300);
    assert_eq!(second.attempt, first.attempt + 1, "抢占必须递增 attempt");
    assert_eq!(second.owner, "owner-b");
    assert!(
        store::holds_import_lease(&fx.db, &ws, "expire-key", "owner-b").unwrap(),
        "新 owner 持有租约"
    );
}

/// 23) **旧 owner 恢复后写入被 fencing 拒绝**：事务整体回滚，业务表零写入。
#[test]
fn stale_owner_write_is_fenced_and_writes_nothing() {
    let fx = Fixture::new("a2-fence-write");
    let ws = fx.workspace_row_id();
    let stale = acquire_lease(&fx.db, &ws, "fence-key", "owner-a", 0);
    let fresh = acquire_lease(&fx.db, &ws, "fence-key", "owner-b", 300);
    assert_eq!(fresh.attempt, stale.attempt + 1);

    // 旧 owner 恢复后继续写：守卫的 owner + attempt 校验必须失败。
    let guard = store::ImportLeaseGuard::new(&ws, "fence-key", "owner-a", stale.attempt);
    let err = store::with_import_lease_transaction(&fx.db, &guard, |conn| {
        conn.execute(
            "INSERT INTO agent_decisions
               (id, title, created_at, updated_at) VALUES ('d-fenced', '被 fencing 的决策', 't', 't')",
            [],
        )?;
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
    assert_eq!(fx.decision_count(), 0, "fencing 拒绝后业务表必须零写入");

    // 新 owner 可以正常写入（同一份数据不会因为旧执行者而重复）。
    let guard = store::ImportLeaseGuard::new(&ws, "fence-key", "owner-b", fresh.attempt);
    store::with_import_lease_transaction(&fx.db, &guard, |conn| {
        conn.execute(
            "INSERT INTO agent_decisions
               (id, title, created_at, updated_at) VALUES ('d-fresh', '新 owner 的决策', 't', 't')",
            [],
        )?;
        Ok(())
    })
    .expect("新 owner 写入应成功");
    assert_eq!(fx.decision_count(), 1, "只有新 owner 的写入生效");
}

/// 24) 旧 owner 不得 finish 新 owner 的租约。
#[test]
fn stale_owner_cannot_finish_new_owner_lease() {
    let fx = Fixture::new("a2-stale-finish");
    let ws = fx.workspace_row_id();
    acquire_lease(&fx.db, &ws, "finish-key", "owner-a", 0);
    acquire_lease(&fx.db, &ws, "finish-key", "owner-b", 300);

    assert!(
        !store::finish_import_lease(&fx.db, &ws, "finish-key", "owner-a"),
        "旧 owner 不得完成新 owner 的租约"
    );
    let (status, owner, _) = fx.lease_state("finish-key").expect("租约行仍在");
    assert_eq!(status, "inflight", "租约不得被旧 owner 置为 ok");
    assert_eq!(owner, "owner-b", "租约仍归新 owner");
    assert!(store::holds_import_lease(&fx.db, &ws, "finish-key", "owner-b").unwrap());
}

/// 25) 旧 owner 不得 release 新 owner 的租约。
#[test]
fn stale_owner_release_does_not_affect_new_owner() {
    let fx = Fixture::new("a2-stale-release");
    let ws = fx.workspace_row_id();
    acquire_lease(&fx.db, &ws, "release-key", "owner-a", 0);
    acquire_lease(&fx.db, &ws, "release-key", "owner-b", 300);

    assert!(
        !store::release_import_lease(&fx.db, &ws, "release-key", "owner-a"),
        "旧 owner 不得删除新 owner 的租约"
    );
    assert!(
        store::holds_import_lease(&fx.db, &ws, "release-key", "owner-b").unwrap(),
        "新 owner 的租约必须仍在"
    );
    assert_eq!(fx.lease_count(), 1, "租约行不得被旧 owner 删除");
}

/// 26) 新 owner 完成后再次扫描不重复导入（租约置 ok 后进入 AlreadyImported）。
#[test]
fn completed_import_is_not_repeated_by_next_scan() {
    let fx = Fixture::new("a2-no-repeat");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    let raw =
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"只写一次"}}"#;
    let rel = fx.write_import("a.json", raw);
    let hash = sync::sha256(raw);
    let key = sync::claim_key(&rel, "task.create", &hash, "file-import");

    assert_eq!(fx.scan().imported, 1);
    assert_eq!(fx.task_count(), 1);
    let (status, _, _) = fx.lease_state(&key).expect("租约行存在");
    assert_eq!(status, "ok", "成功导入必须把租约置 ok（与业务数据同事务）");

    // 再次认领 → 明确给出「已导入」，而不是让人再写一遍。
    let again = store::claim_import_lease(
        &fx.db,
        &fx.workspace_row_id(),
        &key,
        &rel,
        "task.create",
        &hash,
        "file-import",
        "owner-new",
        300,
    )
    .expect("再次认领");
    assert!(
        matches!(again, store::LeaseClaim::AlreadyImported { .. }),
        "已完成的租约不得被再次认领: {again:?}"
    );

    // 再扫一轮：只跳过，不重写。
    fx.write_import("a.json", raw);
    let report = fx.scan();
    assert_eq!(report.imported, 0, "{report:?}");
    assert_eq!(report.skipped, 1, "{report:?}");
    assert_eq!(fx.task_count(), 1, "不得重复写入业务表");
}

/// 27) 业务写入成功但文件归档失败 → 不得重复写入。
///
/// 复现方式：用真实导入路径（`import_document_guarded`）完成业务写入，
/// 租约在同一事务内置 ok；随后**不归档**（模拟归档失败 / 进程崩溃），
/// 文件仍留在 inbox。下一轮扫描必须识别「已导入」并跳过。
#[test]
fn business_write_ok_but_archive_failed_does_not_duplicate() {
    let fx = Fixture::new("a2-archive-fail");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    let raw =
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"归档失败"}}"#;
    let rel = fx.write_import("a.json", raw);
    let hash = sync::sha256(raw);
    let key = sync::claim_key(&rel, "task.create", &hash, "file-import");
    let ws = fx.workspace_row_id();

    let lease = acquire_lease(&fx.db, &ws, &key, "crashed-worker", 300);
    let guard = store::ImportLeaseGuard::new(&ws, &key, "crashed-worker", lease.attempt);
    let doc = sync::parse_external_document(raw, &fx.inbox().join("a.json")).expect("解析文档");
    let grant = perms::manual_import_grant(Capability::TasksWrite, "", "tester");
    let principal = Principal::file_import_granted(grant, "");
    sync::import_document_guarded(&fx.db, &principal, &doc, &guard).expect("业务写入应成功");

    assert_eq!(fx.task_count(), 1);
    assert!(
        fx.inbox().join("a.json").exists(),
        "模拟归档失败：文件仍在 inbox"
    );

    let report = fx.scan();
    assert_eq!(report.imported, 0, "归档失败后不得重复写入：{report:?}");
    assert_eq!(report.skipped, 1, "{report:?}");
    assert_eq!(fx.task_count(), 1, "业务表只有一份数据");
}

/// 28) 扫描期失败 → 租约被释放，可安全重试（不得卡在 inflight）。
#[test]
fn failed_scan_releases_lease_and_allows_retry() {
    let fx = Fixture::new("a2-retry-after-fail");
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    // 标题超长 → 业务层校验失败（写入前失败）。
    let long = "x".repeat(300);
    fx.write_import(
        "a.json",
        &format!(
            r#"{{"schema":"taskdock.import/1","kind":"task.create","payload":{{"title":"{long}"}}}}"#
        ),
    );

    let report = fx.scan();
    assert_eq!(report.imported, 0, "{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.task_count(), 0, "失败不得留半条数据");
    assert_eq!(fx.lease_count(), 0, "失败必须释放租约（行被删除，不得卡 inflight）");

    // 重试同一份文件：租约可以重新认领（而不是被上一次的残留挡住）。
    let report = fx.scan();
    assert_eq!(report.imported, 0, "同样的坏文件仍然失败：{report:?}");
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(fx.lease_count(), 0, "重试后租约同样被释放");
}

/// 29) 事务内写入异常 → 整体回滚、零写入，租约仍可重试。
#[test]
fn transaction_failure_rolls_back_and_keeps_lease_retryable() {
    let fx = Fixture::new("a2-tx-rollback");
    let ws = fx.workspace_row_id();
    let lease = acquire_lease(&fx.db, &ws, "tx-key", "owner-x", 300);
    let guard = store::ImportLeaseGuard::new(&ws, "tx-key", "owner-x", lease.attempt);

    // 业务写入到一半抛错 → 事务回滚。
    let err = store::with_import_lease_transaction(&fx.db, &guard, |conn| {
        conn.execute(
            "INSERT INTO agent_decisions
               (id, title, created_at, updated_at) VALUES ('d-rollback', '半条数据', 't', 't')",
            [],
        )?;
        Err::<(), AppError>(AppError::Db(rusqlite::Error::InvalidQuery))
    })
    .unwrap_err();
    assert_eq!(error_code(&err), "DATABASE", "{err:?}");
    assert_eq!(fx.decision_count(), 0, "回滚后必须零写入");

    // 租约没有被置 ok → 可以用同一把守卫安全重试。
    let (status, owner, _) = fx.lease_state("tx-key").expect("租约行仍在");
    assert_eq!(status, "inflight", "失败不得把租约置 ok");
    assert_eq!(owner, "owner-x");
    assert!(store::holds_import_lease(&fx.db, &ws, "tx-key", "owner-x").unwrap());

    store::with_import_lease_transaction(&fx.db, &guard, |conn| {
        conn.execute(
            "INSERT INTO agent_decisions
               (id, title, created_at, updated_at) VALUES ('d-retry', '重试成功', 't', 't')",
            [],
        )?;
        Ok(())
    })
    .expect("重试应成功");
    assert_eq!(fx.decision_count(), 1);
    let (status, _, _) = fx.lease_state("tx-key").expect("租约行仍在");
    assert_eq!(status, "ok", "重试成功后租约置 ok");
}

/// 30) 进程中途退出后的租约恢复：过期租约可被回收，随后同一文件可重新导入。
#[test]
fn reclaim_expired_import_leases_recovers_after_crash() {
    let fx = Fixture::new("a2-crash-recovery");
    let ws = fx.workspace_row_id();
    // 模拟进程崩溃：留下一条未完成且已过期的租约。
    fx.db
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_import_claims
                   (id, workspace_row_id, claim_key, rel_path, kind, content_hash, actor,
                    status, owner, claimed_at, expires_at, attempt, created_at, updated_at)
                 VALUES ('c-crash', ?1, 'crash-key', 'inbox/a.json', 'task.create', 'h',
                         'file-import', 'inflight', 'dead-owner', '2020-01-01T00:00:00Z',
                         '2020-01-01T00:05:00Z', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
                rusqlite::params![ws],
            )?;
            Ok(())
        })
        .expect("写入崩溃残留租约");

    let removed = store::reclaim_expired_import_leases(&fx.db).expect("回收过期租约");
    assert_eq!(removed, 1, "过期租约应被回收");
    assert_eq!(fx.lease_count(), 0, "回收后不得残留 inflight 行");

    // 回收后同一份文件可以重新导入（不再被死者的租约挡住）。
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"崩溃后恢复"}}"#,
    );
    let report = fx.scan();
    assert_eq!(report.imported, 1, "{report:?}");
    assert_eq!(fx.task_count(), 1);
}

// ── v82 收口：人工批准与自动扫描一致（Agent A）──────────────────

/// 31) 人工批准与自动扫描共用同一租约：同一份内容只导入一次。
#[test]
fn manual_approval_and_scan_share_the_same_lease() {
    let fx = Fixture::new("a2-approve-scan");
    let raw =
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"批准一次"}}"#;
    let rel = fx.write_import("a.json", raw);

    // 无策略 → 待审核（不写业务表）。
    let report = fx.scan();
    assert_eq!(report.imported, 0, "{report:?}");
    assert_eq!(report.pending_review, 1, "{report:?}");
    assert_eq!(fx.task_count(), 0);

    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);
    let message = sync::approve_import(
        &fx.db,
        &Principal::local(Source::Ui),
        &requests[0].id,
        "确认",
    )
    .expect("人工批准");
    assert!(message.contains("创建任务"), "{message}");
    assert_eq!(fx.task_count(), 1);

    // 批准用的是与扫描完全相同的 claim_key（actor 固定为 file-import）：
    // 同一份内容再扫一轮只能是「已导入 → 跳过」。
    let hash = sync::sha256(raw);
    let key = sync::claim_key(&rel, "task.create", &hash, "file-import");
    let (status, _, _) = fx.lease_state(&key).expect("租约行存在");
    assert_eq!(status, "ok", "人工批准同样把租约置 ok");

    // 批准后把**同一内容**重新投递到 Inbox：再次扫描只能命中「已导入」租约，
    // 既不重复写业务表，也不会被误判为新请求。
    fx.policy("inbox", ImportMode::Trusted, PROJECT_SCOPED_CAPS, "");
    fx.write_import("a.json", raw);
    let report = fx.scan();
    assert_eq!(report.imported, 0, "批准后不得再导入一次：{report:?}");
    assert_eq!(report.skipped, 1, "{report:?}");
    assert_eq!(fx.task_count(), 1, "业务表只有一份数据");
}

/// 32) 审批与扫描竞争：租约被占时，审批得到明确的「进行中」冲突结论，
///     请求状态保持 pending，且不写业务表。
#[test]
fn approval_racing_with_scan_yields_explicit_conflict() {
    let fx = Fixture::new("a2-approve-race");
    let rel = fx.write_import(
        "a.json",
        r#"{"schema":"taskdock.import/1","kind":"task.create","payload":{"title":"竞争"}}"#,
    );
    fx.scan();
    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);

    // 扫描执行者先抢到租约。
    let hash = requests[0].content_hash.clone();
    let key = sync::claim_key(&rel, "task.create", &hash, "file-import");
    let ws = fx.workspace_row_id();
    let lease = acquire_lease(&fx.db, &ws, &key, "scan-worker", 300);
    assert!(lease.attempt >= 1);

    let err = sync::approve_import(
        &fx.db,
        &Principal::local(Source::Ui),
        &requests[0].id,
        "确认",
    )
    .unwrap_err();
    assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
    assert!(
        err.user_message().contains("scan-worker"),
        "冲突结论必须写明占用者：{err:?}"
    );
    let (status, _, _, _) = fx.request_state(&rel);
    assert_eq!(status, "pending", "冲突时请求状态不得改变");
    assert_eq!(fx.task_count(), 0, "冲突时不得写业务表");
}

/// 33) 人工批准不能成为绕过项目范围的后门：批准同样按**真实归属**判定。
#[test]
fn manual_approval_cannot_bypass_project_scope() {
    let fx = Fixture::new("a2-approve-scope");
    fx.project("proj-a");
    fx.project("proj-b");
    let task_id = fx.task("B 的任务", Some("proj-b"));
    // 无策略 → 待审核。
    let raw = format!(
        "---\nkind: task.update\ntaskdock_id: {task_id}\nproject_id: proj-a\nbase_revision: 1\ntitle: 批准越权\n---\n正文\n"
    );
    let rel = fx.write_import("a.md", &raw);
    fx.scan();
    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);

    // 人工批准同样必须走真实归属校验：B 的任务不能被「批准」成 proj-a 的写入。
    let err = sync::approve_import(
        &fx.db,
        &Principal::local(Source::Ui),
        &requests[0].id,
        "确认",
    )
    .unwrap_err();
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(fx.task_title(&task_id), "B 的任务", "任务不得被改写");
    let (status, _, _, _) = fx.request_state(&rel);
    assert_eq!(status, "failed", "被拒绝的批准不得记为 imported");
}

/// 34) 人工批准对「归属推导不出」的资源同样拒绝（fail-closed）。
#[test]
fn manual_approval_rejects_resource_without_derivable_owner() {
    let fx = Fixture::new("a2-approve-unowned");
    // 没有项目归属的任务：真实归属推导不出 → 批准也不得放行。
    let task_id = fx.task("无归属任务", None);
    let raw = format!(
        "---\nkind: task.update\ntaskdock_id: {task_id}\nbase_revision: 1\ntitle: 无归属改写\n---\n正文\n"
    );
    fx.write_import("a.md", &raw);
    fx.scan();
    let requests = sync::list_import_requests(&fx.db, Some("pending")).expect("待审核列表");
    assert_eq!(requests.len(), 1);

    let err = sync::approve_import(
        &fx.db,
        &Principal::local(Source::Ui),
        &requests[0].id,
        "确认",
    )
    .unwrap_err();
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(fx.task_title(&task_id), "无归属任务");
}
