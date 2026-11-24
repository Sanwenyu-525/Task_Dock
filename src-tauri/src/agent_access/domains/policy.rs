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

pub(crate) fn authorize_write_replay(
    conn: &Connection,
    principal: &Principal,
    project: &str,
    op: &super::registry::DomainOperationDef,
    input: &serde_json::Value,
) -> AppResult<()> {
    let root = resolve_authorized_project(conn, principal, project, op.domain, true)?;
    if op.id == "development.task_link.create" {
        let task = input["task_id"].as_str().unwrap_or("").trim();
        super::development::require_project_task(conn, principal, &root, task)?;
    }
    Ok(())
}

/// 跨项目资源统一返回的错误：不泄露其他项目资源是否存在（架构文档 §6.4）。
pub fn resource_access_error() -> AppError {
    AppError::Forbidden("资源不可访问".into())
}

/// 领域统一分页窗口：默认 50，最大 200；offset 负数归零。
pub fn page_window(limit: Option<i64>, offset: Option<i64>) -> (u32, u32) {
    let limit = limit.unwrap_or(50).clamp(1, 200) as u32;
    let offset = offset.unwrap_or(0).clamp(0, i64::from(u32::MAX)) as u32;
    (limit, offset)
}

/// 项目级领域门禁的**唯一入口**：项目读取/写入授权 → 领域类型/状态。
///
/// 顺序固定为「解析项目根 → 身份/scope/能力/项目 grant → 项目 kind/status」，
/// 未授权主体在类型检查之前就被拒绝，无法用错误信息推断项目类型。
///
/// 入参可以是项目根或计划 ID；返回 canonical 项目根，供后续资源归属校验使用。
pub fn resolve_authorized_project(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    expected: DomainKind,
    write: bool,
) -> AppResult<String> {
    let raw = project_ref.trim();
    if raw.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let root = permissions::resolve_project_root(conn, raw)?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    let capability = if write {
        Capability::ProjectsWrite
    } else {
        Capability::ProjectsRead
    };
    permissions::require_in_conn(conn, principal, capability, &root)?;
    ensure_domain(conn, &root, expected, write)?;
    Ok(root)
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
