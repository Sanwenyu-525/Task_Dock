//! Agent 操作生命周期（v86）：统一「谁正在改什么」。
//!
//! 定位：
//! - 本模块只记录**过程状态**（running → committed/failed/conflict/interrupted），
//!   不替代 `agent_activity_logs`（那仍是追加式审计历史，只增不改）。
//! - 业务写入仍由既有 `service::*` 完成；本模块不复制任何业务 SQL。
//! - 完成状态必须由真实提交结果驱动：业务事务回滚时**绝不**写 committed；
//!   无法确定的（进程退出、租约过期）一律收敛为 `interrupted`，由前端如实展示。
//!
//! 四个入口的接入点：
//! ```text
//! CLI  ── 独立进程：写命令开始/结束各一次；前端靠 SQLite 游标增量同步
//! MCP  ── bridge 进程内：操作完成与业务写入、审计同一事务提交
//! REST ── 请求认证后开始；幂等重放不创建新操作；超时/断开按真实提交结果收敛
//! File ── 受控导入：数据库提交与文件归档分开记录，归档失败不改写为业务失败
//! ```
//!
//! 事件（`agent-operation-changed`）只传元数据，**不作为事实来源**：
//! 前端以数据库为真源，事件用于低延迟更新，丢失后由游标同步补齐。

use std::sync::{Arc, OnceLock, RwLock};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{error_code, Page, Principal};

/// 操作事件名（camelCase 载荷，与前端 `bridge.ts` 契约一致）。
pub const OPERATION_EVENT: &str = "agent-operation-changed";

/// 租约时长（秒）。执行方需在到期前心跳续租，否则视为中断。
pub const LEASE_SECS: i64 = 90;

/// 单次活动查询上限。
pub const MAX_ACTIVE_LIMIT: u32 = 50;
/// 单次历史查询上限。
pub const MAX_LIST_LIMIT: u32 = 200;
/// 单次游标同步上限。
pub const MAX_SYNC_LIMIT: u32 = 100;
/// 终态记录保留天数（活动审计仍按既有策略保留）。
pub const RETENTION_DAYS: i64 = 30;
/// 单次清理最多处理的行数。
const MAX_SWEEP: usize = 200;

// ── 状态与阶段 ───────────────────────────────────────────────────

/// 操作状态。**取值域固定为五个**，不随功能增加新状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    Running,
    Committed,
    Failed,
    Conflict,
    Interrupted,
}

impl OperationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Committed => "committed",
            Self::Failed => "failed",
            Self::Conflict => "conflict",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "running" => Self::Running,
            "committed" => Self::Committed,
            "failed" => Self::Failed,
            "conflict" => Self::Conflict,
            "interrupted" => Self::Interrupted,
            _ => return None,
        })
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// 可验证的执行阶段。**没有百分比**：阶段由入口在真实节点推进，
/// 不能用来伪造进度。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationPhase {
    /// 已受理、尚未开始写业务数据。
    Started,
    /// 正在写业务数据（已进入业务事务）。
    Writing,
    /// 业务已提交、正在收尾（归档、事件、响应）。
    Finalizing,
    /// 操作已结束（终态）。
    Done,
}

impl OperationPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Writing => "writing",
            Self::Finalizing => "finalizing",
            Self::Done => "done",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "started" => Self::Started,
            "writing" => Self::Writing,
            "finalizing" => Self::Finalizing,
            "done" => Self::Done,
            _ => return None,
        })
    }
}

// ── 数据模型 ─────────────────────────────────────────────────────

/// 对外契约：camelCase，只含元数据（无正文、无凭据、无绝对路径）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOperation {
    pub id: String,
    pub agent_id: String,
    pub actor_kind: String,
    pub interface: String,
    pub action: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub project_id: String,
    pub status: OperationStatus,
    pub phase: OperationPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    pub request_id: String,
    pub started_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<String>,
    pub error_code: String,
    pub detail: String,
}

/// 开始一次操作所需的元数据。
#[derive(Clone, Debug, Default)]
pub struct OperationInput<'a> {
    /// 稳定动作名，如 `task.update` / `feature.create`。
    pub action: &'a str,
    /// 资源类型；新建时尚无 ID，但类型已知。
    pub resource_kind: &'a str,
    /// 资源 ID；新建时为空，提交后再绑定。
    pub resource_id: &'a str,
    pub project_id: &'a str,
    pub request_id: &'a str,
    pub detail: &'a str,
}

impl<'a> OperationInput<'a> {
    pub fn new(action: &'a str, resource_kind: &'a str) -> Self {
        Self {
            action,
            resource_kind,
            ..Default::default()
        }
    }

    pub fn resource(mut self, kind: &'a str, id: &'a str) -> Self {
        self.resource_kind = kind;
        self.resource_id = id;
        self
    }

    pub fn project(mut self, project_id: &'a str) -> Self {
        self.project_id = project_id;
        self
    }

    pub fn request(mut self, request_id: &'a str) -> Self {
        self.request_id = request_id;
        self
    }

    pub fn detail(mut self, detail: &'a str) -> Self {
        self.detail = detail;
        self
    }
}

/// 目标变更：用于「新建时尚无 ID」「提交后绑定真实 ID」。
#[derive(Clone, Debug, Default)]
pub struct OperationTarget {
    pub resource_kind: Option<String>,
    pub resource_id: Option<String>,
    pub project_id: Option<String>,
}

impl OperationTarget {
    pub fn resource(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            resource_kind: Some(kind.into()),
            resource_id: Some(id.into()),
            project_id: None,
        }
    }

    pub fn project(project_id: impl Into<String>) -> Self {
        Self {
            project_id: Some(project_id.into()),
            ..Default::default()
        }
    }
}

/// 完成一次操作的真实结果（全部来自业务提交后的数据）。
#[derive(Clone, Debug, Default)]
pub struct OperationResult {
    pub resource_kind: Option<String>,
    pub resource_id: Option<String>,
    pub project_id: Option<String>,
    pub revision: Option<i64>,
    pub detail: Option<String>,
}

impl OperationResult {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn resource(mut self, kind: impl Into<String>, id: impl Into<String>) -> Self {
        self.resource_kind = Some(kind.into());
        self.resource_id = Some(id.into());
        self
    }

    pub fn project(mut self, project_id: impl Into<String>) -> Self {
        self.project_id = Some(project_id.into());
        self
    }

    pub fn revision(mut self, revision: Option<i64>) -> Self {
        self.revision = revision;
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// 从业务返回值（含 `id` / `revision`）提取真实资源指针。
    pub fn from_value(kind: &str, value: &serde_json::Value) -> Self {
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let revision = value.get("revision").and_then(|v| v.as_i64());
        Self {
            resource_kind: Some(kind.to_string()),
            resource_id: if id.is_empty() { None } else { Some(id) },
            project_id: None,
            revision,
            detail: None,
        }
    }
}

/// 活动查询过滤。
#[derive(Clone, Debug, Default)]
pub struct ActiveFilter {
    pub project_id: Option<String>,
    pub resource_kind: Option<String>,
    pub resource_id: Option<String>,
    pub limit: u32,
}

/// 历史查询（分页 + 筛选）。
#[derive(Clone, Debug, Default)]
pub struct OperationQuery {
    pub agent_id: Option<String>,
    pub resource_kind: Option<String>,
    pub status: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

/// 游标：`(updated_at, id)` 复合键，保证同一时间戳下不跳行、不重复。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationCursor {
    pub updated_at: String,
    pub id: String,
}

/// 增量同步结果：前端只保存一个游标，不重复读取历史。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSync {
    pub operations: Vec<AgentOperation>,
    pub cursor: Option<OperationCursor>,
    pub active_count: u32,
    pub has_more: bool,
}

// ── 事件发射（进程内）────────────────────────────────────────────
//
// CLI 是独立进程，拿不到 Tauri 事件；它只写数据库，前端用游标同步补齐。
// 进程内的 MCP / REST / 文件导入经此回调即时推送，事件丢失不影响事实。

pub type OperationEmitter = Arc<dyn Fn(AgentOperation) + Send + Sync>;

static EMITTER: OnceLock<RwLock<Option<OperationEmitter>>> = OnceLock::new();

fn emitter_slot() -> &'static RwLock<Option<OperationEmitter>> {
    EMITTER.get_or_init(|| RwLock::new(None))
}

pub fn set_emitter(emitter: OperationEmitter) {
    if let Ok(mut slot) = emitter_slot().write() {
        *slot = Some(emitter);
    }
}

pub fn clear_emitter() {
    if let Ok(mut slot) = emitter_slot().write() {
        *slot = None;
    }
}

/// 主进程启动时注册 Tauri 发射器（只注册一次）。
pub fn init_event_emitter(app: &tauri::AppHandle) {
    let app = app.clone();
    set_emitter(Arc::new(move |operation: AgentOperation| {
        let _ = tauri::Emitter::emit(&app, OPERATION_EVENT, &operation);
    }));
}

/// 推送一次操作状态。**best-effort**：事件失败绝不影响已提交的业务。
pub fn notify(operation: &AgentOperation) {
    let emitter = emitter_slot().read().ok().and_then(|slot| slot.clone());
    if let Some(emitter) = emitter {
        // 发射器内部已忽略错误；这里再包一层，防御第三方实现 panic 影响业务线程。
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emitter(operation.clone())))
            .is_err()
        {
            tracing::warn!(operation_id = %operation.id, "Agent 操作事件发射器异常，已忽略");
        }
    }
}

// ── 生命周期写入 ─────────────────────────────────────────────────

fn new_operation(principal: &Principal, input: &OperationInput<'_>) -> AgentOperation {
    let now = chrono::Utc::now();
    let started_at = now.to_rfc3339();
    AgentOperation {
        id: uuid::Uuid::new_v4().to_string(),
        agent_id: principal.label(),
        actor_kind: match principal.actor_kind {
            super::ActorKind::Human => "local".to_string(),
            super::ActorKind::Agent => "agent".to_string(),
            super::ActorKind::System => "system".to_string(),
        },
        interface: principal.source.as_str().to_string(),
        action: input.action.to_string(),
        resource_kind: input.resource_kind.to_string(),
        resource_id: input.resource_id.to_string(),
        project_id: input.project_id.to_string(),
        status: OperationStatus::Running,
        phase: OperationPhase::Started,
        revision: None,
        request_id: input.request_id.to_string(),
        started_at: started_at.clone(),
        updated_at: started_at,
        finished_at: None,
        lease_expires_at: Some(lease_deadline(now)),
        error_code: String::new(),
        detail: sanitize_detail(input.detail),
    }
}

fn lease_deadline(now: chrono::DateTime<chrono::Utc>) -> String {
    (now + chrono::Duration::seconds(LEASE_SECS)).to_rfc3339()
}

fn insert(conn: &Connection, operation: &AgentOperation) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_operations
           (id, agent_row_id, agent_id, actor_kind, interface, action, resource_kind,
            resource_id, project_id, status, phase, revision, request_id, error_code, detail,
            started_at, updated_at, finished_at, lease_expires_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        rusqlite::params![
            operation.id,
            // agent_row_id 只作弱引用：Agent 被删除后仍保留 agent_id 快照用于追溯。
            None::<String>,
            operation.agent_id,
            operation.actor_kind,
            operation.interface,
            operation.action,
            operation.resource_kind,
            operation.resource_id,
            operation.project_id,
            operation.status.as_str(),
            operation.phase.as_str(),
            operation.revision,
            operation.request_id,
            operation.error_code,
            operation.detail,
            operation.started_at,
            operation.updated_at,
            operation.finished_at,
            operation.lease_expires_at,
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// 开始一次操作。返回完整记录（含唯一 ID）。
pub fn start(
    db: &Db,
    principal: &Principal,
    input: &OperationInput<'_>,
) -> AppResult<AgentOperation> {
    let operation = new_operation(principal, input);
    // agent_row_id：单独写入，避免把「身份行」混进通用列参数后漏传。
    db.with_conn(|conn| {
        insert(conn, &operation)?;
        if let Some(row_id) = principal.agent_row_id.as_deref() {
            conn.execute(
                "UPDATE agent_operations SET agent_row_id = ?2 WHERE id = ?1",
                rusqlite::params![operation.id, row_id],
            )
            .map_err(AppError::from)?;
        }
        Ok(())
    })?;
    notify(&operation);
    Ok(operation)
}

/// 开始操作，失败只告警不阻断业务（操作可视化不得成为写入的单点故障）。
pub fn try_start(
    db: &Db,
    principal: &Principal,
    input: &OperationInput<'_>,
) -> Option<AgentOperation> {
    match start(db, principal, input) {
        Ok(operation) => Some(operation),
        Err(err) => {
            tracing::warn!("Agent 操作记录创建失败（不影响业务写入）: {}", err.user_message());
            None
        }
    }
}

/// 更新资源目标（新建时先关联项目，提交后再绑定真实 ID）。
pub fn update_target(
    db: &Db,
    operation_id: &str,
    target: &OperationTarget,
) -> AppResult<Option<AgentOperation>> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    let now = chrono::Utc::now();
    let updated_at = now.to_rfc3339();
    let lease = lease_deadline(now);
    let changed = db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_operations
                SET resource_kind = COALESCE(?2, resource_kind),
                    resource_id   = COALESCE(?3, resource_id),
                    project_id    = COALESCE(?4, project_id),
                    updated_at = ?5,
                    lease_expires_at = ?6
              WHERE id = ?1 AND status = 'running'",
            rusqlite::params![
                operation_id,
                target.resource_kind,
                target.resource_id,
                target.project_id,
                updated_at,
                lease,
            ],
        )
        .map_err(AppError::from)
    })?;
    if changed == 0 {
        return Ok(None);
    }
    let operation = get(db, operation_id)?;
    if let Some(op) = &operation {
        notify(op);
    }
    Ok(operation)
}

/// 推进可验证阶段（同时续租）。
pub fn update_phase(
    db: &Db,
    operation_id: &str,
    phase: OperationPhase,
) -> AppResult<Option<AgentOperation>> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    let now = chrono::Utc::now();
    let updated_at = now.to_rfc3339();
    let lease = lease_deadline(now);
    let changed = db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_operations
                SET phase = ?2, updated_at = ?3, lease_expires_at = ?4
              WHERE id = ?1 AND status = 'running'",
            rusqlite::params![operation_id, phase.as_str(), updated_at, lease],
        )
        .map_err(AppError::from)
    })?;
    if changed == 0 {
        return Ok(None);
    }
    let operation = get(db, operation_id)?;
    if let Some(op) = &operation {
        notify(op);
    }
    Ok(operation)
}

/// 心跳：只续租，不改阶段。
pub fn heartbeat(db: &Db, operation_id: &str) -> bool {
    if operation_id.is_empty() {
        return false;
    }
    let now = chrono::Utc::now();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_operations SET updated_at = ?2, lease_expires_at = ?3
              WHERE id = ?1 AND status = 'running'",
            rusqlite::params![operation_id, now.to_rfc3339(), lease_deadline(now)],
        )
        .map_err(AppError::from)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// **在业务写事务内**把操作置为 committed，并写入真实资源 ID / revision / 完成时间。
///
/// 与业务数据同事务提交：业务回滚时本更新一并回滚，绝不会出现「业务失败但显示成功」。
/// 允许从 `interrupted` 恢复为 committed：业务确实提交了，租约误判不能改写事实。
pub fn complete_tx(
    conn: &Connection,
    operation_id: &str,
    result: &OperationResult,
) -> AppResult<Option<AgentOperation>> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    let now = crate::agents::now_iso();
    let changed = conn
        .execute(
            "UPDATE agent_operations
                SET status = 'committed',
                    phase = 'done',
                    resource_kind = COALESCE(NULLIF(?2, ''), resource_kind),
                    resource_id   = COALESCE(NULLIF(?3, ''), resource_id),
                    project_id    = COALESCE(NULLIF(?4, ''), project_id),
                    revision      = COALESCE(?5, revision),
                    detail        = COALESCE(NULLIF(?6, ''), detail),
                    error_code    = '',
                    finished_at   = ?7,
                    updated_at    = ?7,
                    lease_expires_at = NULL
              WHERE id = ?1 AND status IN ('running','interrupted')",
            rusqlite::params![
                operation_id,
                result.resource_kind.clone().unwrap_or_default(),
                result.resource_id.clone().unwrap_or_default(),
                result.project_id.clone().unwrap_or_default(),
                result.revision,
                result.detail.clone().map(|d| sanitize_detail(&d)).unwrap_or_default(),
                now,
            ],
        )
        .map_err(AppError::from)?;
    if changed == 0 {
        return Ok(None);
    }
    read_operation(conn, operation_id)
}

/// 事务外完成（CLI / REST / 文件导入：业务已单独提交）。
///
/// 业务提交成功但本更新失败时保持 running，租约到期后收敛为 interrupted；
/// 绝不反过来伪造 committed。
pub fn complete(
    db: &Db,
    operation_id: &str,
    result: &OperationResult,
) -> AppResult<Option<AgentOperation>> {
    let operation = db.with_conn(|conn| complete_tx(conn, operation_id, result))?;
    if let Some(op) = &operation {
        notify(op);
    }
    Ok(operation)
}

/// 业务失败/回滚后收敛状态：`Conflict` → conflict，其余 → failed。
pub fn fail(
    db: &Db,
    operation_id: &str,
    error: &AppError,
) -> AppResult<Option<AgentOperation>> {
    let status = if matches!(error, AppError::Conflict(_)) {
        OperationStatus::Conflict
    } else {
        OperationStatus::Failed
    };
    fail_with(
        db,
        operation_id,
        status,
        error_code(error),
        &error.user_message(),
    )
}

/// 以明确的错误码收敛为终态（例如人工拒绝：status=failed + error_code=REJECTED）。
///
/// 只允许终态：调用方不能用它把已 committed 的操作改回失败。
pub fn fail_with(
    db: &Db,
    operation_id: &str,
    status: OperationStatus,
    code: &str,
    detail: &str,
) -> AppResult<Option<AgentOperation>> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    if !status.is_terminal() || status == OperationStatus::Committed {
        return Err(AppError::Validation(
            "fail_with 只接受 failed/conflict/interrupted".into(),
        ));
    }
    let now = crate::agents::now_iso();
    let detail = sanitize_detail(detail);
    let changed = db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_operations
                SET status = ?2, phase = 'done', error_code = ?3, detail = ?4,
                    finished_at = ?5, updated_at = ?5, lease_expires_at = NULL
              WHERE id = ?1 AND status IN ('running','interrupted')",
            rusqlite::params![operation_id, status.as_str(), code, detail, now],
        )
        .map_err(AppError::from)
    })?;
    if changed == 0 {
        return Ok(None);
    }
    let operation = get(db, operation_id)?;
    if let Some(op) = &operation {
        notify(op);
    }
    Ok(operation)
}

/// 找出租约过期且从未正常结束的操作，标记为 interrupted。
///
/// 只处理 `running` 且租约确实过期的行：仍在执行的长任务只要按约定续租就不会被误判。
pub fn interrupt_stale(db: &Db) -> AppResult<u32> {
    let now = crate::agents::now_iso();
    let ids: Vec<String> = db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM agent_operations
                  WHERE status = 'running'
                    AND lease_expires_at IS NOT NULL
                    AND lease_expires_at < ?1
                  ORDER BY updated_at ASC
                  LIMIT ?2",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![now, MAX_SWEEP as i64], |r| r.get::<_, String>(0))
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })?;
    let mut affected = 0u32;
    for id in ids {
        let changed = db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_operations
                    SET status = 'interrupted', phase = 'done', error_code = 'INTERRUPTED',
                        detail = CASE WHEN detail = '' THEN '租约过期，未收到完成结果' ELSE detail END,
                        finished_at = ?2, updated_at = ?2, lease_expires_at = NULL
                  WHERE id = ?1 AND status = 'running'",
                rusqlite::params![id, now],
            )
            .map_err(AppError::from)
        })?;
        if changed > 0 {
            affected += 1;
            if let Ok(Some(op)) = get(db, &id) {
                notify(&op);
            }
        }
    }
    Ok(affected)
}

/// 清理超过保留期的终态记录（running 永不清理）。
pub fn prune(db: &Db, retention_days: i64) -> AppResult<u32> {
    let days = retention_days.clamp(1, 365);
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    let deleted = db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM agent_operations
              WHERE status <> 'running' AND updated_at < ?1",
            rusqlite::params![cutoff],
        )
        .map_err(AppError::from)
    })?;
    Ok(deleted as u32)
}

// ── 查询 ─────────────────────────────────────────────────────────

fn read_operation(conn: &Connection, id: &str) -> AppResult<Option<AgentOperation>> {
    conn.query_row(
        &format!("{SELECT_COLUMNS} WHERE id = ?1"),
        rusqlite::params![id],
        map_row,
    )
    .optional()
    .map_err(AppError::from)
}

const SELECT_COLUMNS: &str = "SELECT id, agent_id, actor_kind, interface, action, resource_kind,
        resource_id, project_id, status, phase, revision, request_id, error_code, detail,
        started_at, updated_at, finished_at, lease_expires_at
   FROM agent_operations";

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOperation> {
    let status_raw: String = row.get(8)?;
    let phase_raw: String = row.get(9)?;
    Ok(AgentOperation {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        actor_kind: row.get(2)?,
        interface: row.get(3)?,
        action: row.get(4)?,
        resource_kind: row.get(5)?,
        resource_id: row.get(6)?,
        project_id: row.get(7)?,
        status: OperationStatus::parse(&status_raw).unwrap_or(OperationStatus::Interrupted),
        phase: OperationPhase::parse(&phase_raw).unwrap_or(OperationPhase::Done),
        revision: row.get(10)?,
        request_id: row.get(11)?,
        error_code: row.get(12)?,
        detail: row.get(13)?,
        started_at: row.get(14)?,
        updated_at: row.get(15)?,
        finished_at: row.get(16)?,
        lease_expires_at: row.get(17)?,
    })
}

pub fn get(db: &Db, operation_id: &str) -> AppResult<Option<AgentOperation>> {
    db.with_read(|conn| read_operation(conn, operation_id))
}

/// 当前运行中的操作（按更新时间倒序，数量受限）。
pub fn active(db: &Db, filter: &ActiveFilter) -> AppResult<Vec<AgentOperation>> {
    let limit = if filter.limit == 0 {
        20
    } else {
        filter.limit.min(MAX_ACTIVE_LIMIT)
    };
    db.with_read(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "{SELECT_COLUMNS}
                  WHERE status = 'running'
                    AND (?1 IS NULL OR project_id = ?1)
                    AND (?2 IS NULL OR resource_kind = ?2)
                    AND (?3 IS NULL OR resource_id = ?3)
                  ORDER BY updated_at DESC, id DESC
                  LIMIT ?4"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    filter.project_id,
                    filter.resource_kind,
                    filter.resource_id,
                    limit as i64
                ],
                map_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn active_count(db: &Db) -> AppResult<u32> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM agent_operations WHERE status = 'running'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n.max(0) as u32)
        .map_err(AppError::from)
    })
}

/// 历史分页（按 Agent / 资源类型 / 状态 / 时间范围筛选）。
pub fn list(db: &Db, query: &OperationQuery) -> AppResult<(Vec<AgentOperation>, Page)> {
    let limit = if query.limit == 0 {
        50
    } else {
        query.limit.min(MAX_LIST_LIMIT)
    };
    let status = query.status.clone().filter(|s| OperationStatus::parse(s).is_some());
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_operations
                  WHERE (?1 IS NULL OR agent_id = ?1)
                    AND (?2 IS NULL OR resource_kind = ?2)
                    AND (?3 IS NULL OR status = ?3)
                    AND (?4 IS NULL OR started_at >= ?4)
                    AND (?5 IS NULL OR started_at <= ?5)",
                rusqlite::params![
                    query.agent_id,
                    query.resource_kind,
                    status,
                    query.since,
                    query.until
                ],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(&format!(
                "{SELECT_COLUMNS}
                  WHERE (?1 IS NULL OR agent_id = ?1)
                    AND (?2 IS NULL OR resource_kind = ?2)
                    AND (?3 IS NULL OR status = ?3)
                    AND (?4 IS NULL OR started_at >= ?4)
                    AND (?5 IS NULL OR started_at <= ?5)
                  ORDER BY started_at DESC, id DESC
                  LIMIT ?6 OFFSET ?7"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    query.agent_id,
                    query.resource_kind,
                    status,
                    query.since,
                    query.until,
                    limit as i64,
                    query.offset as i64
                ],
                map_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, query.offset, total.max(0) as u32)))
    })
}

/// 游标增量同步：只返回游标之后的变更，供跨进程（独立 CLI）与事件丢失恢复使用。
pub fn sync_since(
    db: &Db,
    cursor: Option<&OperationCursor>,
    limit: u32,
) -> AppResult<OperationSync> {
    let limit = if limit == 0 {
        50
    } else {
        limit.min(MAX_SYNC_LIMIT)
    };
    let (after_at, after_id) = match cursor {
        Some(c) => (c.updated_at.clone(), c.id.clone()),
        None => (String::new(), String::new()),
    };
    let bootstrap = cursor.is_none();
    let operations = db.with_read(|conn| {
        // 启动/首次同步只读「最近的 N 条」，避免从历史第一行开始拉；
        // 有游标后严格按 (updated_at, id) keyset 递增，不重复也不跳行。
        let sql = if bootstrap {
            format!(
                "{SELECT_COLUMNS}
                  ORDER BY updated_at DESC, id DESC
                  LIMIT ?1"
            )
        } else {
            format!(
                "{SELECT_COLUMNS}
                  WHERE (updated_at > ?1 OR (updated_at = ?1 AND id > ?2))
                  ORDER BY updated_at ASC, id ASC
                  LIMIT ?3"
            )
        };
        let mut stmt = conn.prepare(&sql).map_err(AppError::from)?;
        let mut out = Vec::new();
        if bootstrap {
            let rows = stmt
                .query_map(rusqlite::params![limit as i64], map_row)
                .map_err(AppError::from)?;
            for row in rows {
                out.push(row.map_err(AppError::from)?);
            }
            // 统一按时间正序返回，前端合并逻辑只有一条路径。
            out.reverse();
        } else {
            let rows = stmt
                .query_map(rusqlite::params![after_at, after_id, limit as i64], map_row)
                .map_err(AppError::from)?;
            for row in rows {
                out.push(row.map_err(AppError::from)?);
            }
        }
        Ok(out)
    })?;
    let has_more = !bootstrap && operations.len() as u32 >= limit;
    let next = operations.last().map(|op| OperationCursor {
        updated_at: op.updated_at.clone(),
        id: op.id.clone(),
    });
    let active_count = active_count(db)?;
    Ok(OperationSync {
        operations,
        // 没有新行时保留调用方游标，避免回退到起点造成重复全量读取。
        cursor: next.or_else(|| cursor.cloned()),
        active_count,
        has_more,
    })
}

// ── 脱敏 ─────────────────────────────────────────────────────────

const SECRET_MARKERS: &[&str] = &[
    "token=",
    "token:",
    "password=",
    "passwd=",
    "secret=",
    "api_key=",
    "apikey=",
    "authorization:",
];

/// 操作详情只保留可复核摘要：截断、去换行、替换明显的凭据片段。
pub fn sanitize_detail(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    let mut redact_next = false;
    for word in raw.split_whitespace() {
        if redact_next {
            parts.push("***".to_string());
            redact_next = false;
            continue;
        }
        let lower = word.to_lowercase();
        if SECRET_MARKERS.iter().any(|m| lower.starts_with(m)) {
            parts.push(format!("{}=***", word.split(['=', ':']).next().unwrap_or("secret")));
            continue;
        }
        if lower == "bearer" {
            parts.push(word.to_string());
            redact_next = true;
            continue;
        }
        parts.push(word.to_string());
    }
    let joined = parts.join(" ");
    let trimmed: String = joined.chars().take(500).collect();
    if joined.chars().count() > 500 {
        format!("{trimmed}…")
    } else {
        trimmed
    }
}

/// MCP 工具名 → 资源类型（用于在业务结果返回前就能展示「正在改什么」）。
pub fn resource_kind_for_tool(tool: &str) -> &'static str {
    let name = tool.to_ascii_lowercase();
    if name.contains("knowledge") {
        return "knowledge";
    }
    if name.contains("note") {
        return "note";
    }
    if name.contains("milestone") {
        return "milestone";
    }
    if name.contains("step") {
        return "step";
    }
    if name.contains("feature") {
        return "feature";
    }
    if name.contains("project") {
        return "project";
    }
    if name.contains("task") {
        return "task";
    }
    if name.contains("skill") {
        return "skill";
    }
    ""
}

/// REST 路径 → (action, resource_kind)。未识别的写路径返回 None（不创建操作）。
pub fn describe_rest_write(method: &str, path: &str) -> Option<(&'static str, &'static str)> {
    let rest = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if rest.len() < 3 || rest[0] != "api" || rest[1] != "v1" {
        return None;
    }
    let tail = &rest[2..];
    let collection = tail.first().copied().unwrap_or("");
    let sub_action = tail.get(2).copied().unwrap_or("");
    let action = match (method, collection) {
        // `/tasks/:id/complete` 是完成语义，不能记成创建。
        ("POST", "tasks") if sub_action == "complete" => ("task.complete", "task"),
        ("POST", "tasks") => ("task.create", "task"),
        ("PATCH", "tasks") => ("task.update", "task"),
        ("DELETE", "tasks") => ("task.delete", "task"),
        ("POST", "features") => ("feature.create", "feature"),
        ("PATCH", "features") => ("feature.update", "feature"),
        ("DELETE", "features") => ("feature.delete", "feature"),
        ("POST", "milestones") => ("milestone.create", "milestone"),
        ("PATCH", "milestones") => ("milestone.update", "milestone"),
        ("POST", "notes") => ("note.create", "note"),
        ("PATCH", "notes") => ("note.update", "note"),
        ("POST", "knowledge") => ("knowledge.create", "knowledge"),
        ("PATCH", "knowledge") => ("knowledge.update", "knowledge"),
        ("POST", "decisions") => ("decision.create", "decision"),
        ("POST", "handoffs") => ("handoff.create", "handoff"),
        ("POST", "reports") => ("report.create", "report"),
        ("POST", "imports") => ("import.decide", "import"),
        ("POST", "sync") => ("sync.run", "sync"),
        _ => return None,
    };
    Some(action)
}

/// REST 写请求的资源 ID（路径末段为 ID 时使用；集合端点为空）。
pub fn rest_target_id(path: &str) -> String {
    let rest = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if rest.len() < 4 || rest[0] != "api" || rest[1] != "v1" {
        return String::new();
    }
    let id = rest[rest.len() - 1];
    // 子动作（complete/approve）不是资源 ID。
    if matches!(id, "complete" | "approve" | "reject" | "run" | "scan" | "export") {
        return String::new();
    }
    if rest.len() >= 5 {
        return String::new();
    }
    id.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::{ActorKind, Identity, Source};
    use std::sync::{Arc, Mutex};

    fn principal() -> Principal {
        Principal {
            identity: Identity::RegisteredAgent,
            agent_row_id: None,
            agent_id: "codex".to_string(),
            actor_kind: ActorKind::Agent,
            source: Source::Mcp,
            session_key: "test-session".to_string(),
            read_only: false,
            import: None,
        }
    }

    fn input(action: &str, kind: &str) -> OperationInput<'static> {
        OperationInput {
            action: Box::leak(action.to_string().into_boxed_str()),
            resource_kind: Box::leak(kind.to_string().into_boxed_str()),
            resource_id: "",
            project_id: "",
            request_id: "",
            detail: "",
        }
    }

    #[test]
    fn start_creates_running_operation_with_lease() {
        let db = Db::open_in_memory().unwrap();
        let op = start(&db, &principal(), &input("task.create", "task")).unwrap();
        assert_eq!(op.status, OperationStatus::Running);
        assert_eq!(op.phase, OperationPhase::Started);
        assert_eq!(op.interface, "mcp");
        assert_eq!(op.actor_kind, "agent");
        assert!(op.lease_expires_at.is_some());
        let loaded = get(&db, &op.id).unwrap().unwrap();
        assert_eq!(loaded.id, op.id);
    }

    #[test]
    fn complete_tx_binds_real_target_and_revision() {
        let db = Db::open_in_memory().unwrap();
        let op = start(&db, &principal(), &input("feature.create", "feature")).unwrap();
        let done = db
            .with_transaction(|conn| {
                complete_tx(
                    conn,
                    &op.id,
                    &OperationResult::new()
                        .resource("feature", "feat-1")
                        .revision(Some(3))
                        .detail("created"),
                )
            })
            .unwrap()
            .expect("操作应存在");
        assert_eq!(done.status, OperationStatus::Committed);
        assert_eq!(done.phase, OperationPhase::Done);
        assert_eq!(done.resource_id, "feat-1");
        assert_eq!(done.revision, Some(3));
        assert!(done.finished_at.is_some());
        assert!(done.lease_expires_at.is_none());
    }

    #[test]
    fn rolled_back_transaction_keeps_operation_running() {
        let db = Db::open_in_memory().unwrap();
        let op = start(&db, &principal(), &input("task.update", "task")).unwrap();
        let result: AppResult<()> = db.with_transaction(|conn| {
            complete_tx(conn, &op.id, &OperationResult::new().resource("task", "t1"))?;
            // 模拟业务写入失败：整个事务回滚，操作状态也不得提交。
            Err(AppError::Validation("业务校验失败".into()))
        });
        assert!(result.is_err());
        let loaded = get(&db, &op.id).unwrap().unwrap();
        assert_eq!(loaded.status, OperationStatus::Running);
        assert_eq!(loaded.resource_id, "");
    }

    #[test]
    fn conflict_error_maps_to_conflict_status() {
        let db = Db::open_in_memory().unwrap();
        let op = start(&db, &principal(), &input("task.update", "task")).unwrap();
        let failed = fail(&db, &op.id, &AppError::Conflict("版本冲突".into()))
            .unwrap()
            .unwrap();
        assert_eq!(failed.status, OperationStatus::Conflict);
        assert_eq!(failed.error_code, "CONFLICT");
        assert!(failed.finished_at.is_some());
    }

    #[test]
    fn stale_lease_marks_interrupted_but_fresh_stays_running() {
        let db = Db::open_in_memory().unwrap();
        let stale = start(&db, &principal(), &input("task.update", "task")).unwrap();
        let fresh = start(&db, &principal(), &input("task.update", "task")).unwrap();
        let past = (chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_operations SET lease_expires_at = ?2 WHERE id = ?1",
                rusqlite::params![stale.id, past],
            )
            .map_err(AppError::from)
        })
        .unwrap();
        let affected = interrupt_stale(&db).unwrap();
        assert_eq!(affected, 1);
        assert_eq!(
            get(&db, &stale.id).unwrap().unwrap().status,
            OperationStatus::Interrupted
        );
        assert_eq!(
            get(&db, &fresh.id).unwrap().unwrap().status,
            OperationStatus::Running
        );
    }

    #[test]
    fn heartbeat_extends_lease_before_expiry() {
        let db = Db::open_in_memory().unwrap();
        let op = start(&db, &principal(), &input("import.scan", "import")).unwrap();
        let past = (chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_operations SET lease_expires_at = ?2 WHERE id = ?1",
                rusqlite::params![op.id, past],
            )
            .map_err(AppError::from)
        })
        .unwrap();
        assert!(heartbeat(&db, &op.id));
        assert_eq!(interrupt_stale(&db).unwrap(), 0);
    }

    #[test]
    fn terminal_operation_is_not_reopened() {
        let db = Db::open_in_memory().unwrap();
        let op = start(&db, &principal(), &input("task.create", "task")).unwrap();
        fail(&db, &op.id, &AppError::Validation("参数错误".into())).unwrap();
        // 迟到的 completed 不得把 failed 改写为成功。
        let late = complete(&db, &op.id, &OperationResult::new().resource("task", "t1")).unwrap();
        assert!(late.is_none());
        assert_eq!(
            get(&db, &op.id).unwrap().unwrap().status,
            OperationStatus::Failed
        );
    }

    #[test]
    fn active_and_history_queries_are_filtered() {
        let db = Db::open_in_memory().unwrap();
        let a = start(&db, &principal(), &input("task.create", "task")).unwrap();
        let b = start(&db, &principal(), &input("note.update", "note")).unwrap();
        complete(
            &db,
            &b.id,
            &OperationResult::new().resource("note", "n1"),
        )
        .unwrap();
        let active = active(&db, &ActiveFilter::default()).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, a.id);
        let (history, page) = list(
            &db,
            &OperationQuery {
                resource_kind: Some("note".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(page.total, 1);
    }

    #[test]
    fn same_resource_supports_multiple_agents() {
        let db = Db::open_in_memory().unwrap();
        let a = start(&db, &principal(), &input("task.update", "task")).unwrap();
        let mut other = principal();
        other.agent_id = "claude".into();
        let b = start(&db, &other, &input("task.update", "task")).unwrap();
        update_target(&db, &a.id, &OperationTarget::resource("task", "t-9")).unwrap();
        update_target(&db, &b.id, &OperationTarget::resource("task", "t-9")).unwrap();
        let ops = active(
            &db,
            &ActiveFilter {
                resource_kind: Some("task".into()),
                resource_id: Some("t-9".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ops.len(), 2);
        assert_ne!(ops[0].agent_id, ops[1].agent_id);
    }

    #[test]
    fn cursor_sync_returns_each_change_once() {
        let db = Db::open_in_memory().unwrap();
        let first = start(&db, &principal(), &input("task.create", "task")).unwrap();
        let sync1 = sync_since(&db, None, 10).unwrap();
        assert_eq!(sync1.operations.len(), 1);
        let cursor = sync1.cursor.clone().unwrap();
        let second = start(&db, &principal(), &input("note.create", "note")).unwrap();
        let sync2 = sync_since(&db, Some(&cursor), 10).unwrap();
        assert_eq!(sync2.operations.len(), 1);
        assert_eq!(sync2.operations[0].id, second.id);
        let sync3 = sync_since(&db, sync2.cursor.as_ref(), 10).unwrap();
        assert!(sync3.operations.is_empty());
        assert_eq!(sync3.cursor.as_ref().unwrap().id, second.id);
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn prune_keeps_running_and_recent_terminal() {
        let db = Db::open_in_memory().unwrap();
        let running = start(&db, &principal(), &input("task.update", "task")).unwrap();
        let done = start(&db, &principal(), &input("task.update", "task")).unwrap();
        complete(&db, &done.id, &OperationResult::new()).unwrap();
        let old = (chrono::Utc::now() - chrono::Duration::days(60)).to_rfc3339();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_operations SET updated_at = ?2 WHERE id = ?1",
                rusqlite::params![done.id, old],
            )
            .map_err(AppError::from)
        })
        .unwrap();
        assert_eq!(prune(&db, RETENTION_DAYS).unwrap(), 1);
        assert!(get(&db, &done.id).unwrap().is_none());
        assert!(get(&db, &running.id).unwrap().is_some());
    }

    #[test]
    fn emission_happens_for_transitions_and_can_be_filtered_by_action() {
        let db = Db::open_in_memory().unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        set_emitter(Arc::new(move |op: AgentOperation| {
            sink.lock().unwrap().push(format!("{}|{}", op.action, op.status.as_str()));
        }));
        let mut input = input("test.emit.transition", "task");
        input.request_id = "req-emit";
        let op = start(&db, &principal(), &input).unwrap();
        complete(&db, &op.id, &OperationResult::new().resource("task", "t1")).unwrap();
        clear_emitter();
        let events: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.starts_with("test.emit.transition|"))
            .cloned()
            .collect();
        assert!(events.contains(&"test.emit.transition|running".to_string()));
        assert!(events.contains(&"test.emit.transition|committed".to_string()));
    }

    #[test]
    fn four_interfaces_share_the_same_operation_contract() {
        // 跨入口契约：字段集合、状态/阶段取值、camelCase 必须一致。
        let mut keys: Option<Vec<String>> = None;
        for source in [Source::Cli, Source::Mcp, Source::Rest, Source::File] {
            let db = Db::open_in_memory().unwrap();
            let mut who = principal();
            who.source = source;
            let op = start(&db, &who, &input("task.update", "task")).unwrap();
            let done = complete(
                &db,
                &op.id,
                &OperationResult::new().resource("task", "t-1").revision(Some(2)),
            )
            .unwrap()
            .unwrap();
            let value = serde_json::to_value(&done).unwrap();
            let mut field_names: Vec<String> = value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            field_names.sort();
            match &keys {
                None => keys = Some(field_names),
                Some(expected) => assert_eq!(&field_names, expected, "入口 {source:?} 契约不一致"),
            }
            assert_eq!(done.interface, source.as_str());
            assert_eq!(value["status"], "committed");
            assert_eq!(value["phase"], "done");
            assert_eq!(value["resourceId"], "t-1");
            assert_eq!(value["revision"], 2);
        }
    }

    #[test]
    fn rejected_import_is_recorded_as_failed_not_committed() {
        let db = Db::open_in_memory().unwrap();
        let mut who = principal();
        who.source = Source::File;
        let op = start(&db, &who, &input("import.reject", "task")).unwrap();
        let failed = fail_with(
            &db,
            &op.id,
            OperationStatus::Failed,
            "REJECTED",
            "人工拒绝：内容不符合规范",
        )
        .unwrap()
        .unwrap();
        assert_eq!(failed.status, OperationStatus::Failed);
        assert_eq!(failed.error_code, "REJECTED");
        // 已拒绝的操作不得再被迟到的 committed 覆盖。
        assert!(complete(
            &db,
            &op.id,
            &OperationResult::new().resource("task", "t-1")
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn detail_is_sanitized() {
        let sanitized = sanitize_detail("token=abc123 Bearer tdm_secret 正常说明");
        assert!(!sanitized.contains("abc123"));
        assert!(!sanitized.contains("tdm_secret"));
        assert!(sanitized.contains("正常说明"));
        assert!(sanitize_detail(&"x".repeat(600)).chars().count() <= 501);
    }

    #[test]
    fn rest_write_paths_map_to_stable_actions() {
        assert_eq!(
            describe_rest_write("POST", "/api/v1/tasks"),
            Some(("task.create", "task"))
        );
        assert_eq!(
            describe_rest_write("PATCH", "/api/v1/tasks/t1"),
            Some(("task.update", "task"))
        );
        assert_eq!(describe_rest_write("GET", "/api/v1/tasks"), None);
        assert_eq!(rest_target_id("/api/v1/tasks/t1"), "t1");
        assert_eq!(rest_target_id("/api/v1/tasks/t1/complete"), "");
    }
}
