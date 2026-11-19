//! Agent 访问层的统一授权判定。
//!
//! 与 `mcp::permissions` 的关系：能力枚举与「能力 × 资源」存储只有一份，本模块只做
//! **身份 + scope + 能力 + 导入授权** 的组合判定，供 CLI / MCP / REST / 文件四个入口共用。
//!
//! 判定顺序固定：身份 → scope → 能力 →（项目授权由既有 `mcp_agent_grants` 负责）。
//! 任何一层不满足都明确拒绝，绝不降级为只读执行。
//!
//! 关键约束（v81）：`Source::File` **不是**身份。文件导入默认没有任何写权限，
//! 只有显式授权（目录策略或本机人工单次批准）才允许落库；未授权的文件只进入待审核队列。

use rusqlite::Connection;
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::auth::McpScope;
use crate::mcp::permissions::{self as mcp_perm, Capability};

use super::{forbidden, validation, Identity, ImportGrant, Principal};

/// 读取当前身份在库内的 scope（每次请求重读，撤销即时生效）。
fn scope_of(conn: &Connection, agent_row_id: &str) -> AppResult<McpScope> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT scope FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
            rusqlite::params![agent_row_id],
            |r| r.get(0),
        )
        .ok();
    Ok(raw
        .as_deref()
        .and_then(McpScope::parse)
        .unwrap_or(McpScope::Disabled))
}

fn is_revoked(conn: &Connection, agent_row_id: &str) -> AppResult<bool> {
    let active: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
            rusqlite::params![agent_row_id],
            |r| r.get(0),
        )
        .ok();
    Ok(active.is_none())
}

/// 要求能力（`resource_id` 为空表示全局；否则为该资源/项目 ID）。
pub fn require(
    db: &Db,
    principal: &Principal,
    capability: Capability,
    resource_id: &str,
) -> AppResult<()> {
    if principal.read_only && capability.is_write() {
        return Err(forbidden("当前为只读模式（TASKDOCK_CLI_READONLY=1）"));
    }
    match principal.identity {
        // 仅显式可信本机 / 内部系统身份可执行内部特权操作。
        Identity::LocalHuman | Identity::SystemInternal => Ok(()),
        Identity::RegisteredAgent => {
            let row_id = principal
                .agent_row_id
                .as_deref()
                .ok_or_else(|| forbidden("缺少 Agent 身份"))?;
            require_agent(db, row_id, capability, resource_id)
        }
        Identity::FileImport => require_file_import(db, principal, capability, resource_id),
    }
}

fn require_agent(
    db: &Db,
    row_id: &str,
    capability: Capability,
    resource_id: &str,
) -> AppResult<()> {
    db.with_read(|conn| {
        let scope = scope_of(conn, row_id)?;
        if scope == McpScope::Disabled {
            return Err(forbidden("Agent 已被禁用或撤销"));
        }
        if capability.is_write() {
            if !scope.can_write() {
                return Err(forbidden(format!(
                    "scope={} 不允许写操作（需要 project_rw）",
                    scope.as_str()
                )));
            }
        } else if !scope.can_read() {
            return Err(forbidden(format!(
                "scope={} 不允许读取（需要 readonly 或 project_rw）",
                scope.as_str()
            )));
        }
        if !mcp_perm::has(conn, row_id, capability, resource_id)? {
            return Err(forbidden(format!(
                "缺少能力 {}（resource_id={}）",
                capability.as_str(),
                if resource_id.is_empty() {
                    "global"
                } else {
                    resource_id
                }
            )));
        }
        Ok(())
    })
}

/// 文件导入：必须同时满足「显式授权上下文」与「授权内声明的范围」。
/// 未授权（`import=None`）一律拒绝，不因来源是文件而放行。
fn require_file_import(
    db: &Db,
    principal: &Principal,
    capability: Capability,
    resource_id: &str,
) -> AppResult<()> {
    let Some(grant) = principal.import.as_ref() else {
        return Err(forbidden(
            "文件导入未获授权：请在「能力中心 → Agent 接入 → 文件同步」中授权该目录，或对本次导入人工批准",
        ));
    };
    if !grant.capabilities.contains(&capability) {
        return Err(forbidden(format!(
            "导入授权 {} 不包含能力 {}",
            grant.authorization_id,
            capability.as_str()
        )));
    }
    if let Some(agent_row_id) = grant.agent_row_id.as_deref() {
        // 授权绑定到某个已注册 Agent 时，该 Agent 的真实授权仍是最终依据。
        require_agent(db, agent_row_id, capability, resource_id)?;
        db.with_read(|conn| {
            if is_revoked(conn, agent_row_id)? {
                return Err(forbidden("导入授权绑定的 Agent 已被撤销"));
            }
            Ok(())
        })?;
    }
    db.with_read(|conn| check_import_resource_scope(conn, grant, capability, resource_id))
}

/// 至少持有一个读能力（用于 status/manifest/活动等聚合端点）。
pub fn require_any_read(db: &Db, principal: &Principal) -> AppResult<()> {
    match principal.identity {
        Identity::LocalHuman | Identity::SystemInternal => Ok(()),
        Identity::FileImport => {
            let Some(grant) = principal.import.as_ref() else {
                return Err(forbidden("文件导入未获授权"));
            };
            if grant.capabilities.iter().any(|cap| !cap.is_write()) {
                return Ok(());
            }
            Err(forbidden("导入授权不含任何读取能力"))
        }
        Identity::RegisteredAgent => {
            let row_id = principal
                .agent_row_id
                .as_deref()
                .ok_or_else(|| forbidden("缺少 Agent 身份"))?;
            db.with_read(|conn| {
                let scope = scope_of(conn, row_id)?;
                if !scope.can_read() {
                    return Err(forbidden(format!("scope={} 不允许读取", scope.as_str())));
                }
                for cap in [
                    Capability::ProjectsRead,
                    Capability::TasksRead,
                    Capability::PlansRead,
                    Capability::KnowledgeRead,
                    Capability::DecisionsRead,
                    Capability::ContextRead,
                    Capability::HandoffsRead,
                    Capability::SkillsRead,
                    Capability::NotesRead,
                    Capability::WorkflowsRead,
                ] {
                    if mcp_perm::has_global(conn, row_id, cap)? {
                        return Ok(());
                    }
                }
                Err(forbidden("没有任何读能力"))
            })
        }
    }
}

/// 按任务 ID 解析其所属项目（用于资源级授权与上下文）。
pub fn task_project(conn: &Connection, task_id: &str) -> AppResult<Option<String>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT project_id FROM workspace_task_links WHERE task_id = ?1 LIMIT 1",
            rusqlite::params![task_id],
            |r| r.get(0),
        )
        .ok();
    Ok(row)
}

/// 项目是否存在于两个既有项目体系之一。
pub fn project_exists(conn: &Connection, project_id: &str) -> AppResult<Option<&'static str>> {
    let planning: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM planning_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .ok();
    if planning.is_some() {
        return Ok(Some("planning"));
    }
    let workspace: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM workspace_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .ok();
    Ok(workspace.map(|_| "workspace"))
}

/// 统一错误：被拒绝时携带的能力名，便于客户端提示「去 UI 授权」。
pub fn denial(capability: Capability) -> AppError {
    forbidden(format!(
        "权限不足：需要 {}。请在 Task Dock「能力中心 → Agent 接入」中授权。",
        capability.as_str()
    ))
}

// ── 文件导入授权（v81）────────────────────────────────────────────

/// 导入请求的来源身份。**不是**认证凭据：`ClaimedAgent` 只表示文件自称是谁，
/// 未绑定授权时不会被当作该 Agent。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportIdentity {
    /// 文件未声明身份。
    Unknown,
    /// 文件声明了 agent_id，但无法在本机之外验证。
    ClaimedAgent(String),
    /// 由目录授权绑定的已注册 Agent。
    BoundAgent {
        row_id: String,
        agent_id: String,
    },
}

impl ImportIdentity {
    pub fn claimed_agent_id(&self) -> &str {
        match self {
            ImportIdentity::Unknown => "",
            ImportIdentity::ClaimedAgent(id) => id,
            ImportIdentity::BoundAgent { agent_id, .. } => agent_id,
        }
    }
}

/// 目录策略模式。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ImportMode {
    /// 直接拒绝（目录被显式关闭）。
    Off,
    /// 只登记待审核请求，不写业务表（默认）。
    Review,
    /// 显式可信写入；仍受能力集合与项目范围限制。
    Trusted,
}

impl ImportMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ImportMode::Off => "off",
            ImportMode::Review => "review",
            ImportMode::Trusted => "trusted",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "off" => ImportMode::Off,
            "review" => ImportMode::Review,
            "trusted" => ImportMode::Trusted,
            _ => return None,
        })
    }
}

/// 一条目录授权策略（`agent_import_policies` 的一行）。
#[derive(Clone, Debug, Serialize)]
pub struct ImportAuthorization {
    pub id: String,
    pub workspace_row_id: String,
    /// 相对工作空间根目录的子目录；空串表示整个工作空间。
    pub rel_dir: String,
    pub mode: ImportMode,
    pub agent_row_id: Option<String>,
    pub capabilities: Vec<String>,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 解析后的策略（含实际命中的目录）。
#[derive(Clone, Debug)]
pub struct ImportPolicy {
    pub authorization: ImportAuthorization,
    pub capabilities: Vec<Capability>,
}

/// 单次文件导入的判定结果。三种结果互斥且都必须可审计。
#[derive(Clone, Debug)]
pub enum FileImportDecision {
    /// 允许执行，携带受限主体。
    Allowed(Principal),
    /// 需要人工批准；不写业务表。
    NeedsReview { reason: String, authorization_id: String },
    /// 明确拒绝；不写业务表。
    Rejected { reason: String, authorization_id: String },
}

impl FileImportDecision {
    pub fn reason(&self) -> &str {
        match self {
            FileImportDecision::Allowed(_) => "",
            FileImportDecision::NeedsReview { reason, .. }
            | FileImportDecision::Rejected { reason, .. } => reason,
        }
    }
}

/// 导入类型 → 真实写能力。禁止用 TasksWrite 代表所有写权限。
pub fn resolve_import_capability(kind: &str) -> Option<Capability> {
    Some(match kind {
        "task.create" | "task.update" | "task.complete" => Capability::TasksWrite,
        "knowledge.create" => Capability::KnowledgeWrite,
        "decision.create" => Capability::DecisionsWrite,
        "handoff.create" | "report.create" => Capability::HandoffsWrite,
        _ => return None,
    })
}

/// 目录策略匹配：空 `rel_dir` 匹配全部；否则按路径前缀（仅按分隔符边界）。
fn dir_matches(policy_dir: &str, rel_path: &str) -> bool {
    let dir = policy_dir.trim().trim_matches('/').replace('\\', "/");
    if dir.is_empty() {
        return true;
    }
    let path = rel_path.replace('\\', "/");
    path == dir || path.starts_with(&format!("{dir}/"))
}

/// 列出工作空间的导入授权（供 UI 展示；不过滤 mode）。
pub fn list_import_authorizations(
    db: &Db,
    workspace_row_id: &str,
) -> AppResult<Vec<ImportAuthorization>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_row_id, rel_dir, mode, agent_row_id, capabilities,
                    project_id, created_at, updated_at
             FROM agent_import_policies WHERE workspace_row_id = ?1
             ORDER BY rel_dir ASC, created_at ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![workspace_row_id], |r| {
            let mode: String = r.get(3)?;
            Ok(ImportAuthorization {
                id: r.get(0)?,
                workspace_row_id: r.get(1)?,
                rel_dir: r.get(2)?,
                mode: ImportMode::parse(&mode).unwrap_or(ImportMode::Review),
                agent_row_id: r.get(4)?,
                capabilities: serde_json::from_str::<Vec<String>>(&r.get::<_, String>(5)?)
                    .unwrap_or_default(),
                project_id: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// 写一条目录策略（插入或按 `(workspace, rel_dir)` 覆盖）。仅本机用户可调用。
pub fn upsert_import_authorization(
    db: &Db,
    workspace_row_id: &str,
    rel_dir: &str,
    mode: ImportMode,
    agent_row_id: Option<&str>,
    capabilities: &[String],
    project_id: &str,
) -> AppResult<ImportAuthorization> {
    let normalized: Vec<String> = capabilities
        .iter()
        .filter_map(|raw| Capability::parse(raw).map(|cap| cap.as_str().to_string()))
        .collect();
    if mode == ImportMode::Trusted && normalized.is_empty() {
        return Err(validation(
            "可信写入至少需要一项能力（如 tasks.write），不能授予空权限",
        ));
    }
    if normalized.iter().any(|cap| {
        Capability::parse(cap)
            .map(|cap| !cap.is_write())
            .unwrap_or(true)
    }) {
        return Err(validation(
            "导入授权只接受写能力（文件导入不承担读取入口职责）",
        ));
    }
    if let Some(agent) = agent_row_id {
        db.with_read(|conn| {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
                rusqlite::params![agent],
                |r| r.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound("绑定的 Agent 不存在或已撤销".into()));
            }
            Ok(())
        })?;
    }
    let now = crate::agents::now_iso();
    let rel_dir = rel_dir.trim().trim_matches('/').replace('\\', "/");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO agent_import_policies
               (id, workspace_row_id, rel_dir, mode, agent_row_id, capabilities, project_id,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(workspace_row_id, rel_dir) DO UPDATE SET
               mode = excluded.mode,
               agent_row_id = excluded.agent_row_id,
               capabilities = excluded.capabilities,
               project_id = excluded.project_id,
               updated_at = excluded.updated_at",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                workspace_row_id,
                rel_dir,
                mode.as_str(),
                agent_row_id,
                serde_json::to_string(&normalized)?,
                project_id.trim(),
                now,
            ],
        )?;
        Ok(())
    })?;
    list_import_authorizations(db, workspace_row_id)?
        .into_iter()
        .find(|item| item.rel_dir == rel_dir)
        .ok_or_else(|| AppError::Unavailable("导入策略写入后不可读".into()))
}

pub fn remove_import_authorization(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM agent_import_policies WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok(())
    })
}

/// 读取对某条导入路径生效的策略：最长前缀优先，其次显式目录优先于全局。
fn policy_for(
    db: &Db,
    workspace_row_id: &str,
    rel_path: &str,
) -> AppResult<Option<ImportPolicy>> {
    let all = list_import_authorizations(db, workspace_row_id)?;
    let mut best: Option<ImportAuthorization> = None;
    for item in all {
        if !dir_matches(&item.rel_dir, rel_path) {
            continue;
        }
        let better = match &best {
            None => true,
            Some(current) => item.rel_dir.len() > current.rel_dir.len(),
        };
        if better {
            best = Some(item);
        }
    }
    Ok(best.map(|authorization| {
        let capabilities = authorization
            .capabilities
            .iter()
            .filter_map(|item| Capability::parse(item))
            .collect();
        ImportPolicy {
            authorization,
            capabilities,
        }
    }))
}

/// 项目范围校验：策略限定项目时，目标项目必须一致且非空。
pub fn check_import_project_scope(grant: &ImportGrant, project_id: &str) -> AppResult<()> {
    if grant.project_id.trim().is_empty() {
        return Ok(());
    }
    if project_id.trim().is_empty() {
        return Err(forbidden(format!(
            "该导入授权限定项目 {}，文件必须声明 project_id",
            grant.project_id
        )));
    }
    if project_id != grant.project_id {
        return Err(forbidden(format!(
            "导入授权仅允许项目 {}（目标 {}）",
            grant.project_id, project_id
        )));
    }
    Ok(())
}

/// 资源范围校验：拿不到目标项目时不做“越权放行”，由后续业务层给出 NotFound。
pub fn check_import_resource_scope(
    conn: &Connection,
    grant: &ImportGrant,
    capability: Capability,
    resource_id: &str,
) -> AppResult<()> {
    if grant.project_id.trim().is_empty() || resource_id.trim().is_empty() {
        return Ok(());
    }
    let target_project = match capability {
        Capability::TasksRead | Capability::TasksWrite => task_project(conn, resource_id)?,
        _ => Some(resource_id.to_string()),
    };
    if let Some(project) = target_project {
        if project != grant.project_id {
            return Err(forbidden(format!(
                "导入授权仅允许项目 {}（目标资源属于 {}）",
                grant.project_id, project
            )));
        }
    }
    Ok(())
}

/// 统一入口：判定一次文件导入能否执行。
///
/// - 无策略 → 待审核（默认安全）；
/// - `off` → 拒绝；
/// - `review` → 待审核；
/// - `trusted` → 能力与项目范围通过后返回受限主体；绑定 Agent 时以其真实授权为准。
pub fn authorize_file_import(
    db: &Db,
    workspace_row_id: &str,
    rel_path: &str,
    identity: &ImportIdentity,
    capability: Capability,
    project_id: &str,
) -> AppResult<FileImportDecision> {
    let policy = policy_for(db, workspace_row_id, rel_path)?;
    let Some(policy) = policy else {
        return Ok(FileImportDecision::NeedsReview {
            reason: "该目录未授权自动写入，导入请求等待人工批准".into(),
            authorization_id: String::new(),
        });
    };
    let auth = policy.authorization;
    match auth.mode {
        ImportMode::Off => Ok(FileImportDecision::Rejected {
            reason: "该目录已关闭文件导入".into(),
            authorization_id: auth.id,
        }),
        ImportMode::Review => Ok(FileImportDecision::NeedsReview {
            reason: "该目录为待审核模式，导入请求等待人工批准".into(),
            authorization_id: auth.id,
        }),
        ImportMode::Trusted => {
            if !policy.capabilities.contains(&capability) {
                return Ok(FileImportDecision::Rejected {
                    reason: format!(
                        "目录授权不包含 {}（仅 {}）",
                        capability.as_str(),
                        policy
                            .capabilities
                            .iter()
                            .map(|cap| cap.as_str())
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                    authorization_id: auth.id,
                });
            }
            // 绑定 Agent：文件自称的身份必须一致，否则视为冒充。
            let bound = match (&auth.agent_row_id, identity) {
                (Some(row_id), ImportIdentity::BoundAgent { row_id: claimed, .. })
                    if row_id == claimed => Some(row_id.clone()),
                (Some(_), ImportIdentity::ClaimedAgent(claimed)) => {
                    return Ok(FileImportDecision::Rejected {
                        reason: format!(
                            "该目录绑定的是另一个 Agent，文件不得声明 agent_id={claimed}"
                        ),
                        authorization_id: auth.id,
                    });
                }
                (Some(row_id), _) => Some(row_id.clone()),
                (None, _) => None,
            };
            let grant = ImportGrant {
                authorization_id: auth.id.clone(),
                capabilities: policy.capabilities.clone(),
                project_id: auth.project_id.clone(),
                agent_row_id: bound.clone(),
                approved_by: "policy".into(),
            };
            check_import_project_scope(&grant, project_id)?;
            let principal = if let Some(row_id) = bound {
                let agent_id = db.with_read(|conn| {
                    conn.query_row(
                        "SELECT agent_id FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
                        rusqlite::params![row_id],
                        |r| r.get::<_, String>(0),
                    )
                    .map_err(AppError::from)
                })?;
                let mut principal = Principal::agent(row_id, agent_id, super::Source::File);
                principal.import = Some(grant);
                principal
            } else {
                Principal::file_import_granted(grant, identity.claimed_agent_id())
            };
            // 绑定 Agent 或受限目录都必须在返回前做一次真实能力校验，避免“授权存在但能力没落库”。
            require(db, &principal, capability, project_id)?;
            Ok(FileImportDecision::Allowed(principal))
        }
    }
}

/// 人工批准单次导入：构造一次性授权主体（写能力仅限本次操作）。
pub fn manual_import_grant(capability: Capability, project_id: &str, approved_by: &str) -> ImportGrant {
    ImportGrant {
        authorization_id: "manual-approval".into(),
        capabilities: vec![capability],
        project_id: project_id.to_string(),
        agent_row_id: None,
        approved_by: approved_by.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_import_capability_maps_each_kind() {
        assert_eq!(
            resolve_import_capability("task.create"),
            Some(Capability::TasksWrite)
        );
        assert_eq!(
            resolve_import_capability("knowledge.create"),
            Some(Capability::KnowledgeWrite)
        );
        assert_eq!(
            resolve_import_capability("decision.create"),
            Some(Capability::DecisionsWrite)
        );
        assert_eq!(
            resolve_import_capability("handoff.create"),
            Some(Capability::HandoffsWrite)
        );
        assert_eq!(
            resolve_import_capability("report.create"),
            Some(Capability::HandoffsWrite)
        );
        assert_eq!(resolve_import_capability("unknown.create"), None);
    }

    #[test]
    fn dir_matches_only_on_path_boundary() {
        assert!(dir_matches("", "inbox/a.json"));
        assert!(dir_matches("inbox", "inbox/a.json"));
        assert!(!dir_matches("inbox", "inbox2/a.json"));
        assert!(!dir_matches("inbox", "tasks/inbox/a.json"));
    }

    #[test]
    fn claim_scope_rejects_other_project() {
        let grant = manual_import_grant(Capability::TasksWrite, "proj-a", "tester");
        assert!(check_import_project_scope(&grant, "proj-a").is_ok());
        assert!(check_import_project_scope(&grant, "proj-b").is_err());
        assert!(check_import_project_scope(&grant, "").is_err());
    }

    #[test]
    fn unverified_file_import_has_no_implicit_permission() {
        let db = Db::open_in_memory().unwrap();
        let principal = Principal::file_import("");
        let err = require(&db, &principal, Capability::TasksWrite, "").unwrap_err();
        assert_eq!(crate::agent_access::error_code(&err), "FORBIDDEN");
    }

    #[test]
    fn identity_is_not_derived_from_source() {
        let file = Principal::local(super::super::Source::File);
        assert_eq!(file.identity, Identity::LocalHuman);
        assert!(!file.is_file_import());
        assert!(file.is_trusted_local());
    }
}
