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

use rusqlite::{Connection, OptionalExtension};
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

/// 读取 Agent 登记的 `agent_id`（撤销后仍可读，用于比对「文件自称」的身份）。
///
/// 查不到（Agent 被删除）时返回空串：调用方据此判定「自称无法与登记值对应」。
fn bound_agent_id(conn: &Connection, agent_row_id: &str) -> AppResult<String> {
    Ok(conn
        .query_row(
            "SELECT agent_id FROM mcp_agents WHERE id = ?1",
            rusqlite::params![agent_row_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default())
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
            // 文件导入主体（`import` 授权上下文非空）的能力范围**只能**来自授权上下文：
            // 调用方传入的 `resource_id` 在导入链路上可能是文件自称的项目 ID 或任务 ID，
            // 那是「文件自称」，不能作为授权依据。
            // 项目型能力（决策 / 交接）用授权上下文里的项目 ID 比对；
            // 资源型能力（任务 / 知识库）留空，交给业务层用真实资源 ID 再校验。
            let scope_resource = match principal.import.as_ref() {
                Some(grant) if capability_scoped_by_project(capability) => grant.project_id.trim(),
                Some(_) => "",
                None => resource_id,
            };
            require_agent(db, row_id, capability, scope_resource)
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
        // 统一授权第三层（v92）：项目型能力还要求该项目根上有显式授权（mcp_agent_grants）。
        // capability 描述「会什么」，grant 描述「能动哪个项目」；缺一不可。
        // 计划 ID 入参先解析到项目根；readonly 是用户显式选择的全局只读，不逐项目要 grant
        // （与 MCP 读路径一致）。授权按项目根判定，不能跨项目继承。
        if capability_scoped_by_project(capability) && !resource_id.is_empty() && scope != McpScope::ReadOnly {
            let root = crate::project_hub::service::resolve_project_root(conn, resource_id)?
                .ok_or_else(|| forbidden(format!("项目不存在: {resource_id}")))?;
            if !crate::mcp::auth::has_project_grant(conn, row_id, &root)? {
                return Err(forbidden(format!(
                    "未授权项目: {root}（请在 Task Dock「设置 → MCP 接入」中授予该项目）"
                )));
            }
        }
        Ok(())
    })
}

/// 该能力是否以**项目**为资源范围。
///
/// 与 `mcp::permissions::resource_exists` 的资源语义保持一致：
/// `tasks.*` → 任务 ID；`knowledge.*` → 知识库 ID；
/// `decisions.*` / `handoffs.*` / `projects.*` / `plans.*` → 项目 ID。
///
/// 文件导入的授权判定必须知道这一点：项目型能力要拿**项目 ID** 去比对，
/// 资源型能力要拿**资源 ID** 去比对，绝不能拿文件自称的项目 ID 去比对。
fn capability_scoped_by_project(capability: Capability) -> bool {
    matches!(
        capability,
        Capability::ProjectsRead
            | Capability::ProjectsWrite
            | Capability::PlansRead
            | Capability::DecisionsRead
            | Capability::DecisionsWrite
            | Capability::HandoffsRead
            | Capability::HandoffsWrite
    )
}

/// 文件导入场景下的 Agent 授权复核：**不绑定某个资源 ID**。
///
/// 与 [`require_agent`] 的差别在于资源范围：
/// - 文件导入的授权阶段还拿不到「这次要写哪个任务 / 哪个知识库」，
///   资源级校验由业务层用**真实资源 ID** 再做一次（`service::*_guarded`）；
/// - 授权阶段只回答三件事：Agent 还在吗、scope 能不能写、有没有这类写能力。
///
/// 因此这里**不能**把文件自称的 `project_id` / 任务 ID 当作能力范围：
/// 那是「文件自称」，不是授权依据（v81 的绕过点）。
fn require_agent_for_import(db: &Db, row_id: &str, capability: Capability) -> AppResult<()> {
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
        let holds: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND capability = ?2",
            rusqlite::params![row_id, capability.as_str()],
            |r| r.get(0),
        )?;
        if holds == 0 {
            return Err(forbidden(format!("缺少能力 {}", capability.as_str())));
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
        // 能力范围与 `require` 的导入分支保持一致：项目型能力用授权上下文里的项目 ID，
        // 资源型能力用调用方给的真实资源 ID；**绝不用文件自称的项目 ID**。
        let scope_resource = if capability_scoped_by_project(capability) {
            grant.project_id.trim()
        } else {
            resource_id
        };
        require_agent(db, agent_row_id, capability, scope_resource)?;
        db.with_read(|conn| {
            if is_revoked(conn, agent_row_id)? {
                return Err(forbidden("导入授权绑定的 Agent 已被撤销"));
            }
            Ok(())
        })?;
    }
    // 资源归属**不能**用 `resource_id` 猜：它可能是任务 ID、项目 ID 或空串（创建类）。
    // 归属判定统一由 `check_import_resource_scope` 在持有文档时完成（`sync::import_document`），
    // 这里只做「身份 + 能力集合 + 绑定 Agent」校验，不再保存任何按 ID 猜测的放行分支。
    Ok(())
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

/// 把「项目 ID 或计划 ID」统一解析为项目根 ID。
///
/// 授权、操作记录、上下文装配一律使用项目根；计划 ID 只作为入参兼容。
/// 旧 `project_exists`（返回 project/plan 字符串）已废弃：持久化不再存类型字符串，
/// 存在性判定用 `resolve_project_root(...).is_some()`。
pub fn resolve_project_root(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    crate::project_hub::service::resolve_project_root(conn, id)
}

/// 解析并校验项目根授权（MCP 工具层与统一 `require` 共用的 grant 判定）。
///
/// 输入可以是项目根 ID 或计划 ID（入参兼容）；返回解析出的项目根。
/// readonly 主体不做逐项目 grant 校验（全局只读模式）。
pub fn ensure_project_grant(
    conn: &Connection,
    row_id: &str,
    project_or_plan_id: &str,
    scope: McpScope,
) -> AppResult<String> {
    let root = crate::project_hub::service::resolve_project_root(conn, project_or_plan_id)?
        .ok_or_else(|| forbidden(format!("项目不存在: {project_or_plan_id}")))?;
    if scope != McpScope::ReadOnly
        && !crate::mcp::auth::has_project_grant(conn, row_id, &root)?
    {
        return Err(forbidden(format!(
            "未授权项目: {root}（请在 Task Dock「设置 → MCP 接入」中授予该项目）"
        )));
    }
    Ok(root)
}

/// 创建成功后的自动授权：**只覆盖刚创建的项目根**。
///
/// 绝不写全局授权（`resource_id=''` 是禁止项），也**不再写计划 ID**：
/// `mcp_agent_grants.project_id` 的外键在 v91 已指向 `workspace_projects(id)`，
/// 计划级授权既过不了外键，也会让「计划授权跨项目生效」重新出现。
/// 旧调用方传计划 ID 时由 [`resolve_project_root`] 在判定前解析，不需要重复授权。
pub fn grant_created_project(db: &Db, agent_row_id: &str, project_id: &str) -> AppResult<()> {
    db.with_transaction(|conn| grant_created_project_in_conn(conn, agent_row_id, project_id))
}

/// 事务内版本：MCP/CLI 已持有写事务时调用，避免嵌套事务与写锁自锁。
pub fn grant_created_project_in_conn(
    conn: &Connection,
    agent_row_id: &str,
    project_id: &str,
) -> AppResult<()> {
    if project_id.trim().is_empty() {
        return Err(AppError::Validation("自动授权缺少项目 ID".into()));
    }
    conn.execute(
        "INSERT OR IGNORE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            agent_row_id,
            project_id,
            crate::agents::now_iso()
        ],
    )?;
    Ok(())
}

/// 统一错误：被拒绝时携带的能力名，便于客户端提示「去 UI 授权」。
pub fn denial(capability: Capability) -> AppError {
    forbidden(format!(
        "权限不足：需要 {}。请在 Task Dock「能力中心 → Agent 接入」中授权。",
        capability.as_str()
    ))
}

/// 授予「资源可见性」的读取能力。
///
/// **不包含 `ContextRead`**：能进入上下文装配不等于能读取任何具体资源，
/// 更不等于能读项目元数据。`SkillsRead` 只支持全局授权，单独处理。
pub const RESOURCE_READ_CAPABILITIES: &[Capability] = &[
    Capability::ProjectsRead,
    Capability::TasksRead,
    Capability::PlansRead,
    Capability::KnowledgeRead,
    Capability::DecisionsRead,
    Capability::HandoffsRead,
];

/// 单项读取能力的资源范围。
#[derive(Clone, Debug, Default)]
pub struct CapScope {
    /// 全局授权（`resource_id=''`）。
    pub global: bool,
    /// 非空资源 ID（项目 / 任务 / 知识库）。
    pub ids: std::collections::HashSet<String>,
}

impl CapScope {
    pub fn unrestricted() -> Self {
        Self {
            global: true,
            ids: Default::default(),
        }
    }

    pub fn allows(&self, id: &str) -> bool {
        self.global || (!id.is_empty() && self.ids.contains(id))
    }

    pub fn is_empty(&self) -> bool {
        !self.global && self.ids.is_empty()
    }
}

/// 读取授权范围（按能力分开）。所有「列表/活动/索引」类查询都必须先取它，
/// 再做服务端过滤；**禁止**把一种资源的能力范围套到另一种资源上。
#[derive(Clone, Debug, Default)]
pub struct AuthorizedReads {
    pub projects: CapScope,
    pub tasks: CapScope,
    pub plans: CapScope,
    pub knowledge: CapScope,
    pub decisions: CapScope,
    pub handoffs: CapScope,
}

impl AuthorizedReads {
    pub fn allows_project(&self, project_id: &str) -> bool {
        self.projects.allows(project_id)
    }

    pub fn is_empty(&self) -> bool {
        self.projects.is_empty()
            && self.tasks.is_empty()
            && self.plans.is_empty()
            && self.knowledge.is_empty()
            && self.decisions.is_empty()
            && self.handoffs.is_empty()
    }

    /// 全部读能力都是全局授权（本机身份或全量 Agent）。
    pub fn all_global(&self) -> bool {
        self.projects.global
            && self.tasks.global
            && self.plans.global
            && self.knowledge.global
            && self.decisions.global
            && self.handoffs.global
    }
}

/// 当前主体的读取授权范围（每次请求重读，撤销即时生效）。
pub fn authorized_reads(db: &Db, principal: &Principal) -> AppResult<AuthorizedReads> {
    match principal.identity {
        Identity::LocalHuman | Identity::SystemInternal => Ok(AuthorizedReads {
            projects: CapScope::unrestricted(),
            tasks: CapScope::unrestricted(),
            plans: CapScope::unrestricted(),
            knowledge: CapScope::unrestricted(),
            decisions: CapScope::unrestricted(),
            handoffs: CapScope::unrestricted(),
        }),
        Identity::FileImport => {
            // 文件导入不是读取通道：只有授权里显式带读能力时才给出最小范围。
            let Some(grant) = principal.import.as_ref() else {
                return Ok(AuthorizedReads::default());
            };
            if !grant.capabilities.iter().any(|cap| !cap.is_write()) {
                return Ok(AuthorizedReads::default());
            }
            let scope = if grant.project_id.trim().is_empty() {
                CapScope::unrestricted()
            } else {
                CapScope {
                    global: false,
                    ids: std::iter::once(grant.project_id.trim().to_string()).collect(),
                }
            };
            Ok(AuthorizedReads {
                projects: scope.clone(),
                tasks: scope.clone(),
                plans: scope.clone(),
                knowledge: scope.clone(),
                decisions: scope.clone(),
                handoffs: scope,
            })
        }
        Identity::RegisteredAgent => {
            let row_id = principal
                .agent_row_id
                .as_deref()
                .ok_or_else(|| forbidden("缺少 Agent 身份"))?;
            db.with_read(|conn| {
                let scope = scope_of(conn, row_id)?;
                if scope == McpScope::Disabled {
                    return Err(forbidden("Agent 已被禁用或撤销"));
                }
                if !scope.can_read() {
                    return Err(forbidden(format!(
                        "scope={} 不允许读取",
                        scope.as_str()
                    )));
                }
                let mut out = AuthorizedReads::default();
                let mut stmt = conn.prepare(
                    "SELECT capability, resource_id FROM mcp_agent_capabilities
                     WHERE agent_row_id = ?1",
                )?;
                let rows = stmt.query_map(rusqlite::params![row_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                for row in rows {
                    let (raw_cap, resource_id) = row?;
                    let Some(cap) = Capability::parse(&raw_cap) else {
                        continue;
                    };
                    if cap.is_write() || !RESOURCE_READ_CAPABILITIES.contains(&cap) {
                        continue;
                    }
                    let resource_id = resource_id.trim().to_string();
                    let slot = match cap {
                        Capability::ProjectsRead => &mut out.projects,
                        Capability::TasksRead => &mut out.tasks,
                        Capability::PlansRead => &mut out.plans,
                        Capability::KnowledgeRead => &mut out.knowledge,
                        Capability::DecisionsRead => &mut out.decisions,
                        Capability::HandoffsRead => &mut out.handoffs,
                        _ => continue,
                    };
                    if resource_id.is_empty() {
                        slot.global = true;
                    } else {
                        slot.ids.insert(resource_id);
                    }
                }
                // 统一授权（v92）：project_rw 的项目型读取还要求项目根授权（mcp_agent_grants）。
                // 与 `require` 的 grant 层同一规则；readonly 是用户显式选择的全局只读，不受影响。
                if scope == McpScope::ProjectRw {
                    let granted = granted_project_roots(conn, row_id)?;
                    for slot in [&mut out.projects, &mut out.plans, &mut out.decisions, &mut out.handoffs] {
                        if slot.global {
                            slot.global = false;
                            slot.ids = granted.clone();
                        } else {
                            slot.ids.retain(|id| granted.contains(id));
                        }
                    }
                }
                Ok(out)
            })
        }
    }
}

/// 该 Agent 已授权的项目根集合（`mcp_agent_grants`，v91 起外键指向项目根）。
pub fn granted_project_roots(conn: &Connection, row_id: &str) -> AppResult<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT project_id FROM mcp_agent_grants WHERE agent_row_id = ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![row_id], |r| r.get::<_, String>(0))?;
    let mut ids = std::collections::HashSet::new();
    for row in rows {
        ids.insert(row?);
    }
    Ok(ids)
}

/// 是否可读取项目元数据（名称/目标/规划）。**只认 `projects.read`**。
pub fn can_read_project_metadata(db: &Db, principal: &Principal, project_id: &str) -> AppResult<bool> {
    if project_id.trim().is_empty() {
        return Ok(false);
    }
    match principal.identity {
        Identity::LocalHuman | Identity::SystemInternal => Ok(true),
        _ => match require(db, principal, Capability::ProjectsRead, project_id) {
            Ok(()) => Ok(true),
            Err(AppError::Agent(_)) | Err(AppError::Forbidden(_)) => Ok(false),
            Err(err) => Err(err),
        },
    }
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

/// 文件声明的项目（`envelope.project_id` / `payload.project_id`）。
///
/// **只用于一致性校验与审计，不得用于授权判定**——命名即约束。
/// 与 `sync::declared_project` 同义；这里保留一份是因为权限层要在
/// 「声明 vs 真实归属」的一致性检查里独立使用它（不能依赖调用方透传）。
fn declared_project_of(doc: &super::sync::ParsedDocument) -> String {
    if let Some(pid) = doc
        .envelope
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return pid.to_string();
    }
    doc.envelope
        .payload
        .get("project_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// 载荷点名的知识库的真实项目归属（`knowledge_bases.project_id`）。
///
/// 「载荷指向的资源已属其它项目」是项目授权的经典绕过口：
/// 授权项目 A、文件声明 A、但 `kb_id` 指向 B 的知识库 → 正文会落进 B。
fn kb_owner_project(db: &Db, doc: &super::sync::ParsedDocument) -> AppResult<Option<String>> {
    let kb_id = doc
        .envelope
        .payload
        .get("kb_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if kb_id.is_empty() {
        return Ok(None);
    }
    db.with_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT project_id FROM knowledge_bases WHERE id = ?1",
                rusqlite::params![kb_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    })
}

/// 资源范围校验（v82）：**唯一**的导入归属判定入口，返回校验后的真实归属项目。
///
/// 规则（不存在 fail-open 分支）：
/// - 全局授权（`grant = None` 或 `project_id` 为空）只表示「不限项目」，不再做项目相等比较；
///   但归属仍必须能算出来——更新类必须来自数据库真实归属，创建类才允许用文件声明；
/// - 项目授权要求数据库推导出的真实归属等于授权项目，**推导不出即 `forbidden`**；
/// - 文件自带的 `project_id` 只做一致性校验，绝不作为归属来源；
/// - 资源 ID 不再被当作项目 ID（v81 的 `Some(resource_id.to_string())` 已删除）。
///
/// v82 复核补强（Agent A）：
/// 1. **归属项目必须真实存在**：项目被删除后，「文件声明的项目」若还指向它，
///    写入会留下一条指向幽灵项目的记录。这里一律 `forbidden`（fail-closed）。
/// 2. **声明 vs 真实归属必须一致**：载荷点名的资源（`kb_id`）已属其它项目时，
///    即使授权是全局的也必须拒绝——否则「全局授权 + 借壳 kb_id」能跨项目写正文。
pub fn check_import_resource_scope(
    db: &Db,
    grant: Option<&ImportGrant>,
    kind: &str,
    doc: &super::sync::ParsedDocument,
) -> AppResult<String> {
    let effective = super::sync::effective_import_project(db, grant, kind, doc)?;
    // 无导入授权上下文（本机 / 内部主体）：不受文件导入的项目授权约束。
    let Some(_grant) = grant else {
        return Ok(effective);
    };
    // 1) 归属项目必须真实存在（fail-closed：推导不出 / 项目已删除 → 拒绝）。
    //    计划 ID 入参可解析到项目根即视为存在。
    let target = effective.trim();
    if !target.is_empty() {
        let exists = db.with_read(|conn| {
            Ok(resolve_project_root(conn, target)?.is_some())
        })?;
        if !exists {
            return Err(forbidden(format!(
                "导入目标项目 {target} 不存在（项目已删除或从未存在）"
            )));
        }
    }
    // 2) 声明只是一致性校验：声明的项目与载荷目标的真实归属不一致 → 拒绝。
    let declared = declared_project_of(doc);
    if !declared.trim().is_empty() && kind.starts_with("knowledge") {
        if let Some(real) = kb_owner_project(db, doc)? {
            if !real.trim().is_empty() && real.trim() != declared.trim() {
                return Err(forbidden(format!(
                    "文件声明的 project_id={declared} 与知识库真实归属 {real} 不一致"
                )));
            }
        }
    }
    Ok(effective)
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
            // 绑定 Agent：文件自称的身份必须与**绑定 Agent 的真实 agent_id** 一致，
            // 否则视为冒充。文件自称永远不是认证凭据：这里比的是「自称」与
            // 「库内登记值」，最终授权仍以该 Agent 的真实授权为准。
            let bound = match (&auth.agent_row_id, identity) {
                (Some(row_id), ImportIdentity::BoundAgent { row_id: claimed, .. })
                    if row_id == claimed => Some(row_id.clone()),
                (Some(_), ImportIdentity::BoundAgent { agent_id, .. }) => {
                    return Ok(FileImportDecision::Rejected {
                        reason: format!(
                            "该目录绑定的是另一个 Agent，文件不得声明 agent_id={agent_id}"
                        ),
                        authorization_id: auth.id,
                    });
                }
                (Some(row_id), ImportIdentity::ClaimedAgent(claimed)) => {
                    let real = db.with_read(|conn| bound_agent_id(conn, row_id))?;
                    if !claimed.trim().is_empty() && claimed.trim() != real.trim() {
                        return Ok(FileImportDecision::Rejected {
                            reason: format!(
                                "该目录绑定的是另一个 Agent，文件不得声明 agent_id={claimed}"
                            ),
                            authorization_id: auth.id,
                        });
                    }
                    Some(row_id.clone())
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
            // 授权限定的项目必须真实存在（fail-closed）：项目被删除后，
            // 目录授权不得继续放行「写进幽灵项目」的导入。
            let scope_project = auth.project_id.trim();
            if !scope_project.is_empty() {
                let exists =
                    db.with_read(|conn| Ok(resolve_project_root(conn, scope_project)?.is_some()))?;
                if !exists {
                    return Ok(FileImportDecision::Rejected {
                        reason: format!("导入授权限定的项目 {scope_project} 不存在"),
                        authorization_id: auth.id,
                    });
                }
            }
            // 文件声明的项目同样必须真实存在：声明只是「一致性校验」的输入，
            // 指向不存在的项目意味着这次导入会留下一条悬空归属。
            let declared = project_id.trim();
            if !declared.is_empty() {
                let exists =
                    db.with_read(|conn| Ok(resolve_project_root(conn, declared)?.is_some()))?;
                if !exists {
                    return Ok(FileImportDecision::Rejected {
                        reason: format!("文件声明的项目 {declared} 不存在"),
                        authorization_id: auth.id,
                    });
                }
            }
            // 此处只有「文件声明」可用：声明非空且与授权项目不一致 → 直接拒绝；
            // 空声明不算越权，真实归属由 `sync::effective_import_project` 在写入前判定
            // （用声明当归属正是 v81 的绕过点）。
            // 拒绝必须表达为 `Rejected`（fail-closed 但只影响这一个文件），
            // 不能把错误抛给整个扫描。
            if !declared.is_empty() {
                if let Err(err) = check_import_project_scope(&grant, declared) {
                    return Ok(FileImportDecision::Rejected {
                        reason: err.user_message(),
                        authorization_id: grant.authorization_id.clone(),
                    });
                }
            }
            let principal = if let Some(row_id) = bound {
                let agent_id = db.with_read(|conn| {
                    conn.query_row(
                        "SELECT agent_id FROM mcp_agents WHERE id = ?1 AND revoked_at IS NULL",
                        rusqlite::params![row_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(AppError::from)
                })?;
                // 绑定的 Agent 被撤销/删除 → 明确拒绝本次导入（fail-closed），
                // 而不是让整个扫描因一行查询失败而中断。
                let Some(agent_id) = agent_id else {
                    return Ok(FileImportDecision::Rejected {
                        reason: "导入授权绑定的 Agent 已不存在或已被撤销".into(),
                        authorization_id: auth.id,
                    });
                };
                let mut principal = Principal::agent(row_id, agent_id, super::Source::File);
                principal.import = Some(grant);
                principal
            } else {
                Principal::file_import_granted(grant, identity.claimed_agent_id())
            };
            // 绑定 Agent 或受限目录都必须在返回前做一次真实能力校验，避免“授权存在但能力没落库”。
            // 权限不足 → 只拒绝这一条文件；数据库/IO 等异常仍然向上抛。
            //
            // 能力范围**不能**用文件声明的项目 ID：那是「文件自称」，
            // 不是授权依据。绑定 Agent 走「任意资源范围持有该能力 + scope 可写」的复核，
            // 资源级（哪个任务 / 哪个知识库）由业务层用真实资源 ID 再校验一次；
            // 未绑定 Agent 时目录策略的能力集合就是授权上限。
            let capability_check = match principal.identity {
                Identity::RegisteredAgent => {
                    let row_id = principal.agent_row_id.clone().unwrap_or_default();
                    require_agent_for_import(db, &row_id, capability)
                }
                _ => require(db, &principal, capability, ""),
            };
            match capability_check {
                Ok(()) => Ok(FileImportDecision::Allowed(principal)),
                Err(err @ (AppError::Agent(_) | AppError::Forbidden(_))) => {
                    Ok(FileImportDecision::Rejected {
                        reason: err.user_message(),
                        authorization_id: auth.id,
                    })
                }
                Err(other) => Err(other),
            }
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
