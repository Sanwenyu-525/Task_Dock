//! 领域权限策略（架构文档 §6）：项目类型 / 状态 / 资源归属 / 权限校验。
//!
//! 判定顺序（与文档 §6.2 一致）：
//!   身份有效 → scope → 能力 → 项目根 grant → 项目 kind → 项目状态 → 资源归属 → 执行
//!
//! 全部在业务写事务内用同一个 `Connection` 完成，避免嵌套事务 / 自锁。
//! 权限规则复用 `permissions::require_in_conn`，不建立第二套权限系统。

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::registry::DomainKind;
use crate::agent_access::{permissions, Principal};

/// 跨项目资源统一返回的错误：不泄露其他项目资源是否存在（架构文档 §6.4）。
pub fn resource_access_error() -> AppError {
    AppError::Forbidden("资源不可访问".into())
}

/// 领域项目门禁：解析真实项目 kind 与 status，校验是否匹配期望领域。
///
/// - `write=true` 要求 status=active；读取允许 archived（文档 §6.2）。
/// - 未知 kind / 类型不匹配 / 项目不存在一律拒绝，不回退 general。
/// - 只接受 canonical `workspace_projects.id`；调用方若传 planId，
///   由 `project_hub::service::resolve_project_root` 在上层解析后再传入。
pub fn ensure_domain(
    conn: &Connection,
    project_id: &str,
    expected: DomainKind,
    write: bool,
) -> AppResult<()> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, status FROM workspace_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(AppError::from)?;

    let (kind, status) = row.ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    let actual = DomainKind::parse(&kind).ok_or_else(|| {
        AppError::Validation(format!("未知项目类型 {kind}，领域入口不接受该类型"))
    })?;
    if actual != expected {
        return Err(AppError::Validation(format!(
            "项目类型不匹配：期望 {}，实际 {kind}",
            expected.as_str()
        )));
    }
    if write && status != "active" {
        return Err(AppError::Forbidden("项目已归档，领域写入只读".into()));
    }
    Ok(())
}

/// 领域写操作统一门禁：权限 + 项目 kind / 状态 在事务内一起校验。
///
/// `resource_project_id` 是**从数据库真实资源反查得到**的项目归属，
/// 不是请求里声称的 projectId；调用方必须先取真实归属再调用本函数比对。
pub fn ensure_domain_write(
    conn: &Connection,
    principal: &Principal,
    project_id: &str,
    expected: DomainKind,
    capability: Capability,
    resource_project_id: Option<&str>,
) -> AppResult<()> {
    // 身份 / scope / 能力 / 项目授权（项目型能力按项目根判定）
    permissions::require_in_conn(conn, principal, capability, project_id)?;
    // 项目 kind / 状态
    ensure_domain(conn, project_id, expected, true)?;
    // 跨项目资源隔离：真实归属必须与授权项目一致
    if let Some(owner) = resource_project_id {
        if owner != project_id {
            return Err(resource_access_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db_with_project(kind: &str, status: &str) -> Db {
        let db = Db::open_in_memory().expect("内存库");
        // Db::open_in_memory 已跑完全部迁移，workspace_projects 直接可用。
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects
                   (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                 VALUES ('p1', '测试项目', ?1, ?2, '', NULL, '', '2026-01-01', '2026-01-01')",
                rusqlite::params![kind, status],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        db
    }

    #[test]
    fn ensure_domain_accepts_matching_kind_and_active_status() {
        let db = db_with_project("novel", "active");
        db.with_conn(|conn| ensure_domain(conn, "p1", DomainKind::Novel, true)).unwrap();
    }

    #[test]
    fn ensure_domain_rejects_wrong_kind_without_fallback() {
        let db = db_with_project("general", "active");
        let err = db
            .with_conn(|conn| ensure_domain(conn, "p1", DomainKind::Novel, true))
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn ensure_domain_reads_archived_but_write_rejected() {
        let db = db_with_project("ai_comic", "archived");
        db.with_conn(|conn| ensure_domain(conn, "p1", DomainKind::Comic, false)).unwrap();
        let err = db
            .with_conn(|conn| ensure_domain(conn, "p1", DomainKind::Comic, true))
            .unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[test]
    fn cross_project_resource_returns_unified_error() {
        // 归属校验是纯比较，直接断言错误类型与文案不泄露资源存在性。
        let err = resource_access_error();
        assert!(matches!(err, AppError::Forbidden(_)));
        assert_eq!(err.to_string().contains("存在"), false);
    }
}
