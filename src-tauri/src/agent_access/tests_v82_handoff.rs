//! v82 回归测试：Agent 交接状态机与工作报告的授权边界。
//!
//! 覆盖：
//! - 交接状态迁移只能由目标 Agent / 创建方按规则完成，无关 Agent 与越权方被拒；
//! - `revision` 条件更新：错误 `base_revision` 返回 CONFLICT 且不推进版本，
//!   同一版本的两个请求只有一个成功；
//! - `list_reports` / `get_report` 按 `AuthorizedReads.handoffs` 的项目范围
//!   **先过滤再分页**，项目级授权看不到其它项目；
//! - 撤销后的 Agent、文件导入主体都不能迁移交接状态；
//! - 报告必须挂在真实交接上（无 `handoff_id` 被拒）、项目归属由交接推导、
//!   追加式写入，且 `result` 永远不会是决策状态；
//! - 分页 `total` 只计本项目报告。
//!
//! 全部使用**隔离的内存数据库**，不触碰用户真实数据。

use crate::db::Db;
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions::{self as mcp_perm, Capability};

use super::store;
use super::{error_code, handoff, Identity, ImportGrant, Principal, Source};

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

    /// 建一个真实存在的项目工作空间项目（项目级授权与交接归属的前提）。
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

    fn agent_principal(&self, row_id: &str, agent_id: &str) -> Principal {
        Principal::agent(row_id.to_string(), agent_id.to_string(), Source::Mcp)
    }

    /// 建交接（目标 Agent 必须是真实注册过的 Agent）。
    fn handoff(&self, project: &str, from: &Principal, to_agent: &str) -> handoff::HandoffCreated {
        handoff::create_handoff(
            &self.db,
            from,
            store::HandoffInput {
                to_agent_id: to_agent.to_string(),
                summary: "交接摘要".into(),
                task_id: None,
                project_id: Some(project.to_string()),
                project_kind: Some("workspace".into()),
                completed_items: Vec::new(),
                pending_items: Vec::new(),
                decisions: Vec::new(),
                files_changed: Vec::new(),
                risks: Vec::new(),
                next_steps: Vec::new(),
            },
        )
        .expect("创建交接")
    }

    /// 以给定主体提交一条工作报告，返回报告 ID。
    fn report(&self, principal: &Principal, handoff_id: &str, summary: &str) -> String {
        handoff::create_report(&self.db, principal, report_input(None, Some(handoff_id), summary))
            .expect("提交报告")
            .report
            .id
    }

    /// 查库：某交接上的报告条数（验证追加式写入，而不是只看返回值）。
    fn report_count(&self, handoff_id: &str) -> i64 {
        self.db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM agent_work_reports WHERE handoff_id = ?1",
                    rusqlite::params![handoff_id],
                    |r| r.get(0),
                )?)
            })
            .expect("查询报告条数")
    }

    /// 查库：交接的真实状态与 revision（验证失败操作不推进版本）。
    fn handoff_state(&self, id: &str) -> (String, i64) {
        self.db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT status, revision FROM agent_handoffs WHERE id = ?1",
                    rusqlite::params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .expect("查询交接状态")
    }

    /// 查库：交接上的全部报告结果。
    fn report_results(&self, handoff_id: &str) -> Vec<String> {
        self.db
            .with_read(|conn| {
                let mut stmt =
                    conn.prepare("SELECT result FROM agent_work_reports WHERE handoff_id = ?1")?;
                let rows = stmt.query_map(rusqlite::params![handoff_id], |r| {
                    r.get::<_, String>(0)
                })?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row?);
                }
                Ok(out)
            })
            .expect("查询报告结果")
    }
}

fn report_input(
    project: Option<&str>,
    handoff_id: Option<&str>,
    summary: &str,
) -> store::ReportInput {
    store::ReportInput {
        summary: summary.into(),
        result: Some("completed".into()),
        handoff_id: handoff_id.map(str::to_string),
        project_id: project.map(str::to_string),
        task_id: None,
        completed_items: Vec::new(),
        pending_items: Vec::new(),
        files_changed: Vec::new(),
        evidence: Vec::new(),
        risks: Vec::new(),
    }
}

// ── 状态机与身份 ─────────────────────────────────────────────────

/// 只有目标 Agent 能接收/完成；发起方不能替目标完成，无关 Agent 被拒。
#[test]
fn only_target_agent_can_transition_handoff() {
    let fx = Fixture::new();
    fx.project("proj-ho");
    let (a_row, a_id) = fx.agent("ho-agent-a");
    let (b_row, b_id) = fx.agent("ho-agent-b");
    let (c_row, c_id) = fx.agent("ho-agent-c");
    for row in [&a_row, &b_row, &c_row] {
        fx.grant(row, "handoffs.write", "proj-ho");
        fx.grant(row, "handoffs.read", "proj-ho");
    }
    let created = fx.handoff("proj-ho", &fx.agent_principal(&a_row, &a_id), &b_id);
    let id = created.handoff.id.clone();
    let rev = created.handoff.revision;

    // 发起方不能替目标完成。
    let err = handoff::complete_handoff(&fx.db, &fx.agent_principal(&a_row, &a_id), &id, rev)
        .expect_err("发起方不能完成");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    // 无关 Agent 不能接收。
    let err = handoff::accept_handoff(&fx.db, &fx.agent_principal(&c_row, &c_id), &id, rev)
        .expect_err("无关 Agent 不能接收");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    // 越权操作没有改动库内状态与版本。
    assert_eq!(fx.handoff_state(&id), ("pending".to_string(), rev));

    let target = fx.agent_principal(&b_row, &b_id);
    let accepted = handoff::accept_handoff(&fx.db, &target, &id, rev).expect("目标可接收");
    assert_eq!(accepted.status, "accepted");
    let completed =
        handoff::complete_handoff(&fx.db, &target, &id, accepted.revision).expect("目标可完成");
    assert_eq!(completed.status, "completed");
    assert_eq!(
        fx.handoff_state(&id),
        ("completed".to_string(), completed.revision)
    );
}

/// 错误 base_revision → CONFLICT 且状态/版本不变；同一 revision 的两个请求只有一个成功。
#[test]
fn stale_revision_conflicts_and_keeps_state() {
    let fx = Fixture::new();
    fx.project("proj-rev");
    let (b_row, b_id) = fx.agent("ho-rev-target");
    fx.grant(&b_row, "handoffs.write", "proj-rev");
    let created = fx.handoff("proj-rev", &Principal::local(Source::Ui), &b_id);
    let id = created.handoff.id.clone();
    let rev = created.handoff.revision;
    let target = fx.agent_principal(&b_row, &b_id);

    let err = handoff::accept_handoff(&fx.db, &target, &id, rev + 10).expect_err("版本必须匹配");
    assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
    assert_eq!(
        fx.handoff_state(&id),
        ("pending".to_string(), rev),
        "失败操作不得推进 revision"
    );

    let first = handoff::accept_handoff(&fx.db, &target, &id, rev).expect("第一个请求成功");
    let err = handoff::accept_handoff(&fx.db, &target, &id, rev).expect_err("第二个请求必须冲突");
    assert_eq!(error_code(&err), "CONFLICT", "{err:?}");
    assert_eq!(
        fx.handoff_state(&id),
        ("accepted".to_string(), first.revision)
    );
}

/// 撤销后的 Agent 不能迁移状态；文件导入主体不能改交接状态。
#[test]
fn revoked_agent_and_file_import_cannot_transition() {
    let fx = Fixture::new();
    fx.project("proj-id");
    let (b_row, b_id) = fx.agent("ho-id-b");
    fx.grant(&b_row, "handoffs.write", "proj-id");
    let created = fx.handoff("proj-id", &Principal::local(Source::Ui), &b_id);
    let id = created.handoff.id.clone();
    let rev = created.handoff.revision;

    mcp_auth::revoke_agent(&fx.db, &b_row).expect("撤销 Agent");
    let err = handoff::accept_handoff(&fx.db, &fx.agent_principal(&b_row, &b_id), &id, rev)
        .expect_err("撤销后不得迁移");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(fx.handoff_state(&id), ("pending".to_string(), rev));

    let grant = ImportGrant {
        authorization_id: "manual-test".into(),
        capabilities: vec![Capability::HandoffsWrite],
        project_id: "proj-id".into(),
        agent_row_id: None,
        approved_by: "tester".into(),
    };
    let import = Principal::file_import_granted(grant, "");
    assert_eq!(import.identity, Identity::FileImport);
    let err = handoff::accept_handoff(&fx.db, &import, &id, rev)
        .expect_err("文件导入不能改交接状态");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    assert_eq!(fx.handoff_state(&id), ("pending".to_string(), rev));
}

// ── 项目范围 ─────────────────────────────────────────────────────

/// 项目 A 的 Agent 列/取报告都看不到项目 B；B 的报告 get 被 FORBIDDEN。
#[test]
fn project_scoped_agent_cannot_read_other_project_reports() {
    let fx = Fixture::new();
    fx.project("proj-a");
    fx.project("proj-b");
    let (_t_row, t_id) = fx.agent("ho-scope-target");
    let (r_row, r_id) = fx.agent("ho-scope-reader");
    fx.grant(&r_row, "handoffs.read", "proj-a");
    let local = Principal::local(Source::Ui);
    let ha = fx.handoff("proj-a", &local, &t_id);
    let hb = fx.handoff("proj-b", &local, &t_id);
    let report_a = fx.report(&local, &ha.handoff.id, "A 的报告");
    let report_b = fx.report(&local, &hb.handoff.id, "B 的报告");

    let reader = fx.agent_principal(&r_row, &r_id);
    let (items, page) =
        handoff::list_reports(&fx.db, &reader, None, None, 50, 0).expect("项目 A 可以列");
    assert_eq!(page.total, 1, "只应看到本项目报告");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, report_a);
    assert!(items.iter().all(|report| report.project_id == "proj-a"));

    let err = handoff::get_report(&fx.db, &reader, &report_b).expect_err("不得读其它项目报告");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    let err = handoff::list_reports(&fx.db, &reader, None, Some(&hb.handoff.id), 50, 0)
        .expect_err("不得按其它项目交接列报告");
    assert_eq!(error_code(&err), "FORBIDDEN", "{err:?}");
    // 项目 A 的报告仍可正常读取。
    assert!(handoff::get_report(&fx.db, &reader, &report_a).is_ok());
}

/// 分页：先按项目过滤再分页，`total` 只计本项目，且不混入其它项目。
#[test]
fn report_pagination_filters_before_paging() {
    let fx = Fixture::new();
    fx.project("proj-page-a");
    fx.project("proj-page-b");
    let (_t_row, t_id) = fx.agent("ho-page-target");
    let local = Principal::local(Source::Ui);
    let ha = fx.handoff("proj-page-a", &local, &t_id);
    let hb = fx.handoff("proj-page-b", &local, &t_id);
    for i in 0..3 {
        fx.report(&local, &ha.handoff.id, &format!("A-{i}"));
    }
    fx.report(&local, &hb.handoff.id, "B-0");

    let (r_row, r_id) = fx.agent("ho-page-reader");
    fx.grant(&r_row, "handoffs.read", "proj-page-a");
    let reader = fx.agent_principal(&r_row, &r_id);

    let (first, page0) =
        handoff::list_reports(&fx.db, &reader, None, None, 2, 0).expect("第一页");
    assert_eq!(page0.total, 3, "total 只计本项目：{page0:?}");
    assert_eq!(first.len(), 2);
    assert!(first.iter().all(|report| report.project_id == "proj-page-a"));

    let (second, page1) =
        handoff::list_reports(&fx.db, &reader, None, None, 2, 2).expect("第二页");
    assert_eq!(page1.total, 3, "total 只计本项目：{page1:?}");
    assert_eq!(second.len(), 1);
    assert!(second.iter().all(|report| report.project_id == "proj-page-a"));
    assert!(
        first.iter().all(|a| second.iter().all(|b| a.id != b.id)),
        "两页不应重复"
    );
}

// ── 工作报告语义 ─────────────────────────────────────────────────

/// 报告必须关联真实交接；声明项目不一致被拒；项目归属由交接推导。
#[test]
fn report_requires_real_handoff_and_derives_project() {
    let fx = Fixture::new();
    fx.project("proj-r");
    let (_t_row, t_id) = fx.agent("ho-report-target");
    let created = fx.handoff("proj-r", &Principal::local(Source::Ui), &t_id);
    let local = Principal::local(Source::Ui);

    let err = handoff::create_report(&fx.db, &local, report_input(None, None, "无交接"))
        .expect_err("无 handoff_id 必须被拒");
    assert_eq!(error_code(&err), "VALIDATION", "{err:?}");

    let err = handoff::create_report(
        &fx.db,
        &local,
        report_input(Some("proj-other"), Some(&created.handoff.id), "错项目"),
    )
    .expect_err("声明项目与交接不一致必须被拒");
    assert_eq!(error_code(&err), "VALIDATION", "{err:?}");

    let err = handoff::create_report(
        &fx.db,
        &local,
        report_input(None, Some("no-such-handoff"), "假交接"),
    )
    .expect_err("不存在的交接必须被拒");
    assert_eq!(error_code(&err), "NOT_FOUND", "{err:?}");

    let out = handoff::create_report(
        &fx.db,
        &local,
        report_input(None, Some(&created.handoff.id), "正常报告"),
    )
    .expect("可提交报告");
    assert_eq!(out.report.project_id, "proj-r", "报告项目由交接推导");
    assert_eq!(
        out.report.handoff_id.as_deref(),
        Some(created.handoff.id.as_str())
    );
    // 查库确认落库归属，而不只看返回值。
    let db_project: String = fx
        .db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT project_id FROM agent_work_reports WHERE id = ?1",
                rusqlite::params![out.report.id],
                |r| r.get(0),
            )?)
        })
        .expect("查询报告项目");
    assert_eq!(db_project, "proj-r");
}

/// 报告是追加式记录，且 `result` 只可能是工作结果，不会出现决策状态。
#[test]
fn report_is_append_only_and_never_decision_status() {
    let fx = Fixture::new();
    fx.project("proj-append");
    let (_t_row, t_id) = fx.agent("ho-append-target");
    let created = fx.handoff("proj-append", &Principal::local(Source::Ui), &t_id);
    let local = Principal::local(Source::Ui);

    let first = handoff::create_report(
        &fx.db,
        &local,
        report_input(None, Some(&created.handoff.id), "第一次报告"),
    )
    .expect("第一次");
    let second = handoff::create_report(
        &fx.db,
        &local,
        report_input(None, Some(&created.handoff.id), "第二次报告"),
    )
    .expect("第二次");
    assert_ne!(first.report.id, second.report.id, "重复提交产生新记录");
    assert_eq!(
        fx.report_count(&created.handoff.id),
        2,
        "追加式：不覆盖既有报告"
    );

    let results = fx.report_results(&created.handoff.id);
    assert_eq!(results.len(), 2);
    for result in &results {
        assert!(
            matches!(result.as_str(), "completed" | "partial" | "blocked" | "failed"),
            "report.result 只能是工作结果: {result}"
        );
        assert!(
            !matches!(
                result.as_str(),
                "proposed" | "accepted" | "superseded" | "rejected"
            ),
            "report.result 不得出现决策状态: {result}"
        );
    }

    let mut decision_like = report_input(None, Some(&created.handoff.id), "决策态");
    decision_like.result = Some("accepted".into());
    let err = handoff::create_report(&fx.db, &local, decision_like)
        .expect_err("result 不能是决策状态");
    assert_eq!(error_code(&err), "VALIDATION", "{err:?}");
    assert_eq!(fx.report_count(&created.handoff.id), 2, "被拒报告不得落库");
}
