//! 领域资源版本服务（架构文档 §7）：基于现有 `agent_resource_revisions`，
//! 不新建五套版本表；`resource_kind` 使用 namespaced 资源类型（如 `novel.chapter`）。
//!
//! 与现有 `store::bump_revision` 的区别（文档 §7.3 明确要求修正）：
//! 现有函数按**存储计数器** +1，未考虑 UI 直接改业务行后计数器的有效值；
//! 本模块提供 `bump_revision_from`：从本次事务校验通过的 **effective revision**
//! 递增，并在同一事务内完成「版本校验 → 业务写入（调用方）→ 版本推进」。
//! 两个 Agent 并发写同一资源时，expectedRevision 校验保证只有一个能提交。

use rusqlite::Connection;
use serde::Serialize;

use crate::agent_access::store::{effective_revision, read_revision};
use crate::error::{AppError, AppResult};
use crate::agent_access::Principal;

/// 读侧返回的版本快照（架构文档 §7.2 契约）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSnapshot {
    pub revision: i64,
    pub updated_at: String,
}

/// 读取领域资源的有效版本快照。
///
/// `business_updated_at` 是业务表当前行的 `updated_at`：UI 直接改过业务行时，
/// 计数器未动但业务时间变化，`effective_revision` 会 +1，使 Agent 能发现变化。
/// 没有版本记录时返回 revision=0（稳定基线），updated_at 取业务时间。
pub fn read_revision_snapshot(
    conn: &Connection,
    resource_kind: &str,
    resource_id: &str,
    business_updated_at: &str,
) -> AppResult<RevisionSnapshot> {
    let (counter, counter_at, _hash) = read_revision(conn, resource_kind, resource_id)?;
    Ok(RevisionSnapshot {
        revision: effective_revision(counter, &counter_at, business_updated_at),
        updated_at: if counter_at.is_empty() {
            business_updated_at.to_string()
        } else {
            counter_at
        },
    })
}

/// 首次读取时建立稳定版本基线（文档 §7.3 第 1 点）。
///
/// 只在完全没有版本记录时插入 revision=0 的基线行；已有记录是 no-op。
/// 必须在写事务内调用（与业务写入同事务），调用方负责事务边界。
pub fn ensure_baseline(
    conn: &Connection,
    resource_kind: &str,
    resource_id: &str,
    principal: &Principal,
    business_updated_at: &str,
) -> AppResult<()> {
    let (counter, counter_at, _) = read_revision(conn, resource_kind, resource_id)?;
    if counter == 0 && counter_at.is_empty() {
        conn.execute(
            "INSERT OR IGNORE INTO agent_resource_revisions
               (id, resource_kind, resource_id, revision, updated_at, updated_by, actor_kind, source, content_hash)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, '')",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                resource_kind,
                resource_id,
                business_updated_at,
                principal.label(),
                principal.actor_kind.as_str(),
                principal.source.as_str(),
            ],
        )
        .map_err(AppError::from)?;
    }
    Ok(())
}

/// 从 effective revision 推进版本（文档 §7.3 核心修正）。
///
/// 参数：
/// - `expected_revision`：客户端从快照读到的版本；`None` 表示不校验（仅内部系统写入）。
/// - `business_at_before`：写入**前**业务行的 `updated_at`，用于重算 effective 与并发检测。
/// - `new_updated_at`：本次写入后的业务时间，作为新的计数器基准时间。
///
/// 流程：读取计数器 → 重算 effective → 校验 expected → 写入 revision=effective+1。
/// 调用方必须把本函数放在业务写操作的同一事务内；事务失败整体回滚。
pub fn bump_revision_from(
    conn: &Connection,
    resource_kind: &str,
    resource_id: &str,
    expected_revision: Option<i64>,
    principal: &Principal,
    business_at_before: &str,
    new_updated_at: &str,
    content_hash: &str,
) -> AppResult<i64> {
    let (counter, counter_at, _) = read_revision(conn, resource_kind, resource_id)?;
    let effective = effective_revision(counter, &counter_at, business_at_before);
    if let Some(expected) = expected_revision {
        if expected != effective {
            return Err(AppError::Conflict(format!(
                "版本冲突：期望 {expected}，当前 {effective}（资源 {resource_kind}/{resource_id}）"
            )));
        }
    }
    let next = effective.saturating_add(1);
    conn.execute(
        "INSERT INTO agent_resource_revisions
           (id, resource_kind, resource_id, revision, updated_at, updated_by, actor_kind, source, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(resource_kind, resource_id) DO UPDATE SET
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           actor_kind = excluded.actor_kind,
           source = excluded.source,
           content_hash = excluded.content_hash",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            resource_kind,
            resource_id,
            next,
            new_updated_at,
            principal.label(),
            principal.actor_kind.as_str(),
            principal.source.as_str(),
            content_hash,
        ],
    )
    .map_err(AppError::from)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::Source;
    use crate::db::Db;

    fn local() -> Principal {
        Principal::local(Source::Cli)
    }

    fn setup(db: &Db) {
        // Db::open_in_memory 已建好 agent_resource_revisions，清空即可保证测试隔离。
        db.with_conn(|conn| {
            conn.execute_batch("DELETE FROM agent_resource_revisions;")
                .unwrap();
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn first_read_returns_stable_zero_baseline() {
        let db = Db::open_in_memory().unwrap();
        setup(&db);
        let snap = db
            .with_conn(|conn| {
                read_revision_snapshot(conn, "novel.chapter", "ch-1", "2026-01-01T00:00:00Z")
            })
            .unwrap();
        assert_eq!(snap.revision, 0);
        assert_eq!(snap.updated_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn bump_from_effective_increments_and_accepts_expected() {
        let db = Db::open_in_memory().unwrap();
        setup(&db);
        let p = local();
        let next = db
            .with_conn(|conn| {
                bump_revision_from(
                    conn,
                    "novel.chapter",
                    "ch-1",
                    Some(0),
                    &p,
                    "2026-01-01T00:00:00Z",
                    "2026-01-02T00:00:00Z",
                    "hash1",
                )
            })
            .unwrap();
        assert_eq!(next, 1);
        let snap = db
            .with_conn(|conn| read_revision_snapshot(conn, "novel.chapter", "ch-1", "2026-01-02T00:00:00Z"))
            .unwrap();
        assert_eq!(snap.revision, 1);
    }

    #[test]
    fn stale_expected_revision_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        setup(&db);
        let p = local();
        db.with_conn(|conn| {
            bump_revision_from(
                conn,
                "novel.chapter",
                "ch-1",
                Some(0),
                &p,
                "2026-01-01T00:00:00Z",
                "2026-01-02T00:00:00Z",
                "",
            )
        })
        .unwrap();
        // 第二个 Agent 仍拿旧版本 0 提交 → 冲突
        let err = db
            .with_conn(|conn| {
                bump_revision_from(
                    conn,
                    "novel.chapter",
                    "ch-1",
                    Some(0),
                    &p,
                    "2026-01-02T00:00:00Z",
                    "2026-01-03T00:00:00Z",
                    "",
                )
            })
            .unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
    }

    #[test]
    fn ui_external_edit_reflected_in_effective_revision() {
        let db = Db::open_in_memory().unwrap();
        setup(&db);
        let p = local();
        db.with_conn(|conn| {
            bump_revision_from(
                conn,
                "novel.chapter",
                "ch-1",
                Some(0),
                &p,
                "2026-01-01T00:00:00Z",
                "2026-01-01T01:00:00Z",
                "",
            )
        })
        .unwrap();
        // UI 直接改了业务行：业务时间变了但计数器没动 → 有效版本 +1
        let snap = db
            .with_conn(|conn| read_revision_snapshot(conn, "novel.chapter", "ch-1", "2026-01-05T00:00:00Z"))
            .unwrap();
        assert_eq!(snap.revision, 2);
    }

    #[test]
    fn baseline_is_noop_when_revision_exists() {
        let db = Db::open_in_memory().unwrap();
        setup(&db);
        let p = local();
        db.with_conn(|conn| {
            bump_revision_from(
                conn,
                "novel.chapter",
                "ch-1",
                Some(0),
                &p,
                "2026-01-01T00:00:00Z",
                "2026-01-02T00:00:00Z",
                "",
            )
        })
        .unwrap();
        db.with_conn(|conn| ensure_baseline(conn, "novel.chapter", "ch-1", &p, "2026-03-01T00:00:00Z"))
            .unwrap();
        let snap = db
            .with_conn(|conn| read_revision_snapshot(conn, "novel.chapter", "ch-1", "2026-01-02T00:00:00Z"))
            .unwrap();
        assert_eq!(snap.revision, 1, "已有版本记录时 baseline 不得重置版本");
    }
}
