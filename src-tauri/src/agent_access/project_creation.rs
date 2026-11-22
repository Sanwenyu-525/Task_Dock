//! Agent 创建项目的统一用例（CreateProjectForAgentUseCase）。
//!
//! CLI / MCP / REST 三个入口的「Agent 创建项目」收敛到同一实现，单事务内完成：
//! 身份 → scope → 能力 → 创建（统一创建服务）→ 创建者自动授权（项目根）。
//!
//! 边界：
//! - 归属主体以 use case 参数（`agent_row_id`）为准，调用方传入的 `request.principal`
//!   一律不信任（强制改写为 `RequestPrincipal::agent(agent_row_id)`）；
//! - Agent 不能创建新目录（`create_new` 是文件系统副作用，必须由人类在 UI 确认）；
//! - 自动授权只覆盖刚创建的项目根（`CreatorProject` 语义），绝不扩大为全局权限；
//! - 人类 UI 路径（`project_hub::creation::create` 等）不走本模块，行为不变。

use rusqlite::{Connection, OptionalExtension};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::auth::McpScope;
use crate::mcp::permissions::{self as mcp_perm, Capability};
use crate::project_hub::creation::{
    create_with_conn, CreateProjectRequest, DirectoryMode, ProjectCreateResult, RequestPrincipal,
};

use super::{forbidden, permissions};

/// 事务内：Agent 以自身身份创建项目（授权判定、创建、自动授权同事务原子完成）。
///
/// 调用方必须已处于事务中（MCP 写工具）；目录只允许 `metadata_only` / `attach_existing`。
pub fn create_for_agent_in_conn(
    conn: &Connection,
    agent_row_id: &str,
    request: CreateProjectRequest,
) -> AppResult<ProjectCreateResult> {
    let agent_row_id = agent_row_id.trim();
    if agent_row_id.is_empty() {
        return Err(AppError::Validation("Agent 创建缺少主体行 ID".into()));
    }
    // 归属主体只认 use case 参数：调用方传什么（甚至伪造他人身份）都不信任。
    let request = CreateProjectRequest {
        principal: RequestPrincipal::agent(agent_row_id),
        ..request
    };
    // 目录创建是文件系统副作用，只能由人类在 UI 明确发起。
    if request.directory_mode == DirectoryMode::CreateNew {
        return Err(forbidden(
            "Agent 不能创建新目录（create_new）；目录初始化必须由人类在 UI 中完成",
        ));
    }
    // scope（每次请求重读，撤销即时生效；行不存在/已撤销 → disabled）。
    let raw: Option<String> = conn
        .query_row(
            "SELECT scope FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
            rusqlite::params![agent_row_id],
            |r| r.get(0),
        )
        .ok();
    let scope = raw
        .as_deref()
        .and_then(McpScope::parse)
        .unwrap_or(McpScope::Disabled);
    if scope != McpScope::ProjectRw {
        return Err(forbidden(format!(
            "scope={} 不允许创建项目（需要 project_rw）",
            scope.as_str()
        )));
    }
    // 创建是独立能力：project_rw 只代表「可写」，不代表「可新建项目」。
    if !mcp_perm::has_global(conn, agent_row_id, Capability::ProjectsCreate)? {
        return Err(permissions::denial(Capability::ProjectsCreate));
    }
    // 统一创建服务：项目根 + 初始计划同事务；幂等归属由 principal 决定。
    let created = create_with_conn(conn, request)?;
    // 自动授权只作用于刚创建的项目根，绝不扩大为全局权限。
    permissions::grant_created_project_in_conn(conn, agent_row_id, &created.project.id)?;
    Ok(created)
}

/// 事务包装：持有 `&Db` 的入口（CLI / REST）调用。
pub fn create_for_agent(
    db: &Db,
    agent_row_id: &str,
    request: CreateProjectRequest,
) -> AppResult<ProjectCreateResult> {
    db.with_transaction(|conn| create_for_agent_in_conn(conn, agent_row_id, request))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(db: &Db, suffix: &str, scope: &str, capabilities: &[&str]) -> String {
        let created =
            crate::mcp::auth::create_agent(db, &format!("usecase-{suffix}"), "用例测试 Agent")
                .expect("创建 Agent");
        crate::mcp::auth::set_agent_scope(db, &created.info.id, scope).expect("设置 scope");
        for capability in capabilities {
            crate::mcp::permissions::grant(db, &created.info.id, capability, "").expect("授予能力");
        }
        created.info.id
    }

    fn request(name: &str, client_request_id: &str) -> CreateProjectRequest {
        CreateProjectRequest {
            client_request_id: client_request_id.into(),
            name: name.into(),
            kind: "general".into(),
            description: "描述".into(),
            goal: String::new(),
            target_date: None,
            template_id: None,
            root_path: None,
            directory_mode: DirectoryMode::MetadataOnly,
            dev_project_id: None,
            note: None,
            plan_name: None,
            plan_description: None,
            plan_status: None,
            draft: Default::default(),
            agent_access_policy: crate::project_hub::creation::AgentAccessPolicy::CreatorProject,
            // 故意伪造的主体：use case 必须以 agent_row_id 参数覆盖它。
            principal: RequestPrincipal::local_human(),
        }
    }

    #[test]
    fn missing_row_id_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let error = create_for_agent(&db, "  ", request("无主体", "req-1")).unwrap_err();
        assert!(matches!(error, AppError::Validation(_)), "{error:?}");
    }

    #[test]
    fn create_new_is_rejected_for_agents() {
        let db = Db::open_in_memory().unwrap();
        let row_id = agent(&db, "create-new", "project_rw", &["projects.create"]);
        let target = std::env::temp_dir()
            .join(format!("td-usecase-{}", uuid::Uuid::new_v4().simple()))
            .join("never");
        let mut input = request("新目录", "req-create-new");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        let error = create_for_agent(&db, &row_id, input).unwrap_err();
        assert!(matches!(error, AppError::Agent(_)), "{error:?}");
        assert!(error.user_message().contains("create_new"), "{error:?}");
        assert!(!target.exists(), "拒绝后不得创建目录");
    }

    #[test]
    fn scope_other_than_project_rw_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let row_id = agent(&db, "ro", "readonly", &["projects.create"]);
        let error = create_for_agent(&db, &row_id, request("只读", "req-ro")).unwrap_err();
        assert!(matches!(error, AppError::Agent(_)), "{error:?}");
        assert!(error.user_message().contains("project_rw"), "{error:?}");
        // 撤销后立即失效（行按 revoked_at 过滤 → disabled）。
        crate::mcp::auth::revoke_agent(&db, &row_id).unwrap();
        let error = create_for_agent(&db, &row_id, request("已撤销", "req-revoked")).unwrap_err();
        assert!(matches!(error, AppError::Agent(_)), "{error:?}");
    }

    #[test]
    fn missing_projects_create_capability_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        // scope=project_rw 但未授予 projects.create。
        let row_id = agent(&db, "nocap", "project_rw", &[]);
        let error = create_for_agent(&db, &row_id, request("无能力", "req-nocap")).unwrap_err();
        assert!(matches!(error, AppError::Agent(_)), "{error:?}");
        assert!(error.user_message().contains("projects.create"), "{error:?}");
    }

    #[test]
    fn success_creates_project_and_grants_only_root() {
        let db = Db::open_in_memory().unwrap();
        let row_id = agent(&db, "ok", "project_rw", &["projects.create"]);
        let created = create_for_agent(&db, &row_id, request("用例项目", "req-ok")).unwrap();
        assert!(created.created);
        assert_ne!(created.project.id, created.active_plan.id);
        let root_id = created.project.id.clone();
        // 自动授权只落项目根（CreatorProject 语义），无计划级授权。
        let grants: Vec<String> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT project_id FROM mcp_agent_grants WHERE agent_row_id = ?1",
                )?;
                let rows = stmt.query_map(rusqlite::params![row_id], |r| r.get(0))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(grants, vec![root_id], "只授予项目根");
        // 事件 actor 是真实主体。
        let (actor, principal_id): (String, String) = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT actor, json_extract(payload_json, '$.principal.principalId')
                     FROM project_events WHERE kind = 'project_created' AND project_id = ?1",
                    rusqlite::params![created.project.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();
        assert_eq!(actor, "agent");
        assert_eq!(principal_id, row_id);
    }

    #[test]
    fn principal_is_forced_from_parameter_not_caller() {
        let db = Db::open_in_memory().unwrap();
        let row_id = agent(&db, "force", "project_rw", &["projects.create"]);
        // in_conn 版本在既有事务中调用（与 MCP 写工具一致）。
        let created = db
            .with_transaction(|conn| {
                // 调用方传入伪造的 local_human 主体（见 request()），
                // 归属必须以 agent_row_id 参数为准。
                create_for_agent_in_conn(conn, &row_id, request("强制归属", "req-force"))
            })
            .unwrap();
        let (kind, principal_id): (String, String) = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT json_extract(payload_json, '$.principal.principalKind'),
                            json_extract(payload_json, '$.principal.principalId')
                     FROM project_events WHERE kind = 'project_created' AND project_id = ?1",
                    rusqlite::params![created.project.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();
        assert_eq!(kind, "registered_agent");
        assert_eq!(principal_id, row_id, "归属必须来自 use case 参数");
        // 幂等归属行同样落在真实主体上。
        let scoped: Option<String> = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT principal_id FROM project_create_requests
                     WHERE principal_kind = 'registered_agent' AND client_request_id = 'req-force'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(scoped.as_deref(), Some(row_id.as_str()));
    }

    /// 项目删除必须级联清理创建者授权与幂等归属行（v91/v92 外键 ON DELETE CASCADE）：
    /// 否则删除后残留 grant 指向不存在项目、同请求 ID 重试撞 UNIQUE。
    #[test]
    fn delete_project_cleans_grants_and_idempotency_rows() {
        let db = Db::open_in_memory().unwrap();
        let row_id = agent(&db, "cleanup", "project_rw", &["projects.create"]);
        let created = create_for_agent(&db, &row_id, request("待删除", "req-cleanup")).unwrap();
        let root = created.project.id.clone();
        let counts = |db: &Db, root: &str| -> (i64, i64) {
            db.with_read(|conn| {
                let grants: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM mcp_agent_grants WHERE project_id = ?1",
                    rusqlite::params![root],
                    |r| r.get(0),
                )?;
                let idem: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM project_create_requests WHERE project_id = ?1",
                    rusqlite::params![root],
                    |r| r.get(0),
                )?;
                Ok((grants, idem))
            })
            .unwrap()
        };
        assert_eq!(counts(&db, &root), (1, 1), "删除前 grant 与归属行各一条");
        crate::project_hub::service::delete_project(&db, &root).unwrap();
        assert_eq!(counts(&db, &root), (0, 0), "项目删除必须级联清理授权与幂等归属");
    }
}
