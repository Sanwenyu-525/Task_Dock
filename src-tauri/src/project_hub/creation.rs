//! 统一项目创建服务（Project Creation Service）。
//!
//! 这是 UI（快速/高级）、CLI、MCP、REST **唯一**的项目创建实现：
//! 参数清洗 → 幂等判定 → 目录初始化 → 单事务写入项目根与初始计划 → 目录出清/补偿。
//!
//! 边界与不变量：
//! - 项目根 = `workspace_projects`，初始计划 = `planning_projects`（`workspace_project_id` + `is_active=1`）；
//! - 项目根与初始计划、阶段、里程碑、功能、任务、目标、能力需求必须在**同一事务**内落库，
//!   不允许「有项目无计划」或「有计划无项目」；
//! - 幂等优先于任何副作用：命中 `clientRequestId` 即返回既有结果，不建目录、不跑恢复；
//! - 文件系统没有事务：`create_new` 先写恢复日志（pending）再建目录（created）再进事务，
//!   事务失败只回滚**本次创建的空目录**；恢复日志按操作身份（opId）定位，不按路径批量清理；
//! - 幂等摘要必须覆盖所有影响持久化结果的字段；新增字段用 `requestDigestV2` 追加，
//!   旧事件只有 `requestDigest`，重放时两者任一命中都视为同一请求。
//!
//! 禁止：在入口层重复实现创建 SQL；把「目录不存在」当成「创建新目录」；默认执行 `git init`。

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::service::{
    clean_create, clean_enum, clean_root_path, clean_text, insert_project_root_tx,
    load_plan_summary, load_summary, path_key, request_digest, same_path, CleanCreate,
    CreateCapabilityInput, CreateFeatureInput, CreateGoalInput, CreatePhaseInput,
    CreateProjectInput, CreateProjectRootInput, CreateTaskInput, ProjectPlanSummary,
    ProjectSummary, MAX_DESCRIPTION, MAX_NAME,
};

/// 计划执行状态的合法取值（与 `commands::planning::PROJECT_STATUSES` 一致）。
const PLAN_STATUSES: &[&str] = &["planning", "in_progress", "paused", "completed"];

// ── 请求 / 结果 ─────────────────────────────────────────────────────

/// 工作目录模式。三者语义互斥，不允许用「路径不存在」推断「新建」。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryMode {
    /// 只创建项目元数据，不落任何目录。
    MetadataOnly,
    /// 关联已有目录：允许离线（移动硬盘/网络盘），不允许是文件。
    AttachExisting,
    /// 创建新目录：父目录必须存在、目标必须不存在。
    CreateNew,
}

impl DirectoryMode {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw.trim() {
            "" | "metadata_only" | "metadata" => Self::MetadataOnly,
            "attach_existing" | "attach" | "existing" => Self::AttachExisting,
            "create_new" | "create" => Self::CreateNew,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::MetadataOnly => "metadata_only",
            Self::AttachExisting => "attach_existing",
            Self::CreateNew => "create_new",
        }
    }

    /// 未显式指定时的默认值：有路径按「关联已有目录」，否则只建元数据。
    ///
    /// 这是既有产品的兼容行为（工作台允许先建项目、目录稍后补），**不是**「新建目录」。
    pub fn default_for(root_path: &str) -> Self {
        if root_path.trim().is_empty() {
            Self::MetadataOnly
        } else {
            Self::AttachExisting
        }
    }
}

/// 创建成功后给创建者授予的范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAccessPolicy {
    /// 不自动授权（人类 UI 走既有授权界面）。
    None,
    /// 只授予刚创建的项目根。
    CreatorProject,
    /// 项目根 + 该计划 ID（兼容按计划 ID 判定的旧调用）。
    CreatorProjectAndPlan,
}

impl AgentAccessPolicy {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw.trim() {
            "" | "none" => Self::None,
            "creator_project" => Self::CreatorProject,
            "creator_project_and_plan" => Self::CreatorProjectAndPlan,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::CreatorProject => "creator_project",
            Self::CreatorProjectAndPlan => "creator_project_and_plan",
        }
    }
}

/// 初始计划草案：与项目根同事务落库。
#[derive(Clone, Debug, Default)]
pub struct InitialPlanDraft {
    pub goals: Vec<CreateGoalInput>,
    pub phases: Vec<CreatePhaseInput>,
    pub features: Vec<CreateFeatureInput>,
    pub tasks: Vec<CreateTaskInput>,
    pub capabilities: Vec<CreateCapabilityInput>,
}

impl InitialPlanDraft {
    pub fn is_empty(&self) -> bool {
        self.goals.is_empty()
            && self.phases.is_empty()
            && self.features.is_empty()
            && self.tasks.is_empty()
            && self.capabilities.is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct CreateProjectRequest {
    pub client_request_id: String,
    pub name: String,
    pub kind: String,
    pub description: String,
    pub goal: String,
    pub target_date: Option<String>,
    pub template_id: Option<String>,
    pub root_path: Option<String>,
    pub directory_mode: DirectoryMode,
    pub dev_project_id: Option<String>,
    /// 工作空间备注（None = 与描述一致；两者都是项目根字段）。
    pub note: Option<String>,
    /// 计划容器名称（None = 与项目同名）。
    pub plan_name: Option<String>,
    pub plan_description: Option<String>,
    pub plan_status: Option<String>,
    pub draft: InitialPlanDraft,
    pub agent_access_policy: AgentAccessPolicy,
}

impl CreateProjectRequest {
    /// 由项目中枢/规划入口的既有请求构造（阶段/功能/任务/能力来自草案）。
    pub fn from_hub_input(input: CreateProjectInput, mode: DirectoryMode) -> Self {
        Self {
            client_request_id: input.client_request_id.unwrap_or_default(),
            name: input.name,
            kind: input.kind,
            description: input.description,
            goal: input.goal,
            target_date: input.target_date,
            template_id: input.template_id,
            root_path: input.root_path,
            directory_mode: mode,
            dev_project_id: None,
            note: None,
            plan_name: None,
            plan_description: None,
            plan_status: Some("planning".into()),
            draft: InitialPlanDraft {
                goals: input.goals,
                phases: input.phases,
                features: input.features,
                tasks: input.tasks,
                capabilities: input.capabilities,
            },
            agent_access_policy: AgentAccessPolicy::None,
        }
    }
}

/// 创建工作空间视图（项目执行面）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkspaceView {
    pub project_id: String,
    pub root_path: String,
    /// 目录当前是否存在（离线只是事实，不是错误）。
    pub root_exists: bool,
    pub dev_project_id: Option<String>,
    pub provisioning_status: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateResult {
    /// false = 幂等重放，返回既有结果。
    pub created: bool,
    pub project: ProjectSummary,
    pub active_plan: ProjectPlanSummary,
    pub workspace: ProjectWorkspaceView,
    pub provisioning_status: String,
}

// ── 规范化 ──────────────────────────────────────────────────────────

/// 清洗后的创建请求：摘要必须基于清洗后的值。
struct Prepared {
    clean: CleanCreate,
    note: Option<String>,
    plan_name: Option<String>,
    plan_description: Option<String>,
    plan_status: String,
    mode: DirectoryMode,
    dev_project_id: Option<String>,
    policy: AgentAccessPolicy,
    digest_v1: String,
    digest_v2: String,
}

fn normalize_dev_project_id(conn: &Connection, raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM dev_projects WHERE id = ?1",
            params![value],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Validation("关联的开发项目不存在".into()));
    }
    Ok(Some(value.to_string()))
}

fn digest_v2(prepared: &Prepared, clean: &CleanCreate) -> String {
    let canonical = serde_json::json!({
        "v": 2,
        "name": clean.name,
        "kind": clean.kind,
        "description": clean.description,
        "goal": clean.goal,
        "targetDate": clean.target_date,
        "rootPath": clean.root_path,
        "directoryMode": prepared.mode.as_str(),
        "devProjectId": prepared.dev_project_id,
        "templateId": clean.template_id,
        "note": prepared.note,
        "planName": prepared.plan_name,
        "planDescription": prepared.plan_description,
        "planStatus": prepared.plan_status,
        "agentAccessPolicy": prepared.policy.as_str(),
        "goals": clean.goals,
        "phases": clean.phases.iter().map(|phase| serde_json::json!({
            "name": phase.name,
            "description": phase.description,
            "targetDate": phase.target_date,
            "startDate": phase.start_date,
            "milestones": phase.milestones,
        })).collect::<Vec<_>>(),
        "features": clean.features.iter().map(|feature| serde_json::json!({
            "title": feature.title,
            "acceptance": feature.acceptance,
            "priority": feature.priority,
            "phaseIndex": feature.phase_index,
        })).collect::<Vec<_>>(),
        "tasks": clean.tasks.iter().map(|task| serde_json::json!({
            "title": task.title,
            "description": task.description,
            "dueAt": task.due_at,
            "priority": task.priority,
            "phaseIndex": task.phase_index,
        })).collect::<Vec<_>>(),
        "capabilities": clean.capabilities.iter().map(|capability| serde_json::json!({
            "name": capability.name,
            "category": capability.category,
            "necessity": capability.necessity,
            "targetLevel": capability.target_level,
            "impact": capability.impact,
            "alternative": capability.alternative,
            "phaseIndex": capability.phase_index,
        })).collect::<Vec<_>>(),
    });
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 纯函数：清洗 + 摘要。不碰数据库、不碰文件系统。
fn prepare(conn: &Connection, request: CreateProjectRequest) -> AppResult<Prepared> {
    let hub_input = CreateProjectInput {
        name: request.name,
        kind: request.kind,
        description: request.description,
        goal: request.goal,
        target_date: request.target_date,
        root_path: request.root_path,
        template_id: request.template_id,
        client_request_id: Some(request.client_request_id),
        goals: request.draft.goals,
        phases: request.draft.phases,
        features: request.draft.features,
        tasks: request.draft.tasks,
        capabilities: request.draft.capabilities,
    };
    let clean = clean_create(&hub_input)?;
    let plan_name = match request.plan_name.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => Some(clean_text(value, "计划名称", MAX_NAME, false)?),
        _ => None,
    };
    let plan_description = match request.plan_description.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            Some(clean_text(value, "计划描述", MAX_DESCRIPTION, true)?)
        }
        _ => None,
    };
    let plan_status = clean_enum(
        request.plan_status.as_deref().unwrap_or("planning"),
        "计划状态",
        PLAN_STATUSES,
    )?;
    let note = match request.note.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            Some(clean_text(value, "项目备注", MAX_DESCRIPTION, true)?)
        }
        _ => None,
    };
    let dev_project_id = normalize_dev_project_id(conn, request.dev_project_id.as_deref())?;
    let mode = request.directory_mode;
    // 模式与路径必须自洽：metadata_only 不接受路径（避免静默丢弃），
    // attach/create 必须有路径。
    match mode {
        DirectoryMode::MetadataOnly if !clean.root_path.is_empty() => {
            return Err(AppError::Validation(
                "directoryMode=metadata_only 不接受工作目录；请改为 attach_existing 或 create_new"
                    .into(),
            ))
        }
        DirectoryMode::MetadataOnly => {}
        DirectoryMode::AttachExisting | DirectoryMode::CreateNew if clean.root_path.is_empty() => {
            return Err(AppError::Validation(format!(
                "directoryMode={} 需要提供工作目录",
                mode.as_str()
            )))
        }
        _ => {}
    }
    let mut prepared = Prepared {
        digest_v1: request_digest(&clean),
        clean,
        note,
        plan_name,
        plan_description,
        plan_status,
        mode,
        dev_project_id,
        policy: request.agent_access_policy,
        digest_v2: String::new(),
    };
    prepared.digest_v2 = digest_v2(&prepared, &prepared.clean.clone());
    Ok(prepared)
}

// ── 目录初始化与恢复 ────────────────────────────────────────────────
//
// 文件系统没有事务，所以「建目录 → 数据库提交」之间必须可恢复：
//   1. 先落恢复日志（pending），再建目录，建好后把条目改成 created；
//   2. 条目携带**操作身份**（opId）与拥有者（pid + 租约），恢复只处理「确定已放弃」的操作；
//   3. 恢复只删「空目录 + 没有任何项目引用 + 目录确实由本次操作创建」的目标，绝不 remove_dir_all；
//   4. 恢复写回前重新读取日志，避免覆盖并发创建追加的新条目。

/// 恢复日志的存储键（`application_settings`，随备份往返）。
const JOURNAL_KEY: &str = "project_provisioning_journal";
/// 条目状态：已声明、目录尚未建立（此时崩溃无需清理目录）。
const JOURNAL_PENDING: &str = "pending";
/// 条目状态：目录已建立、数据库事务结果未知（此时崩溃需要核对并清理空目录）。
const JOURNAL_CREATED: &str = "created";
/// 目录操作租约（毫秒）：只对其他进程生效。本进程在途操作由 `ACTIVE_OPS` 精确判定，
/// 不依赖时间；租约只用于「另一个进程已崩溃、无法自证」的场景。
const JOURNAL_LEASE_MS: i64 = 5 * 60 * 1000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    /// 操作身份（一次 `create_new` 一个）。旧版本条目没有该字段（空串）。
    #[serde(default)]
    op_id: String,
    path: String,
    /// `pending` / `created`；旧版本条目没有该字段（空串，按「可能已建目录」处理）。
    #[serde(default)]
    state: String,
    /// 拥有者进程 PID。
    #[serde(default)]
    pid: u32,
    /// 租约到期（epoch 毫秒）。
    #[serde(default)]
    lease_until_ms: i64,
    /// 发起创建的请求 ID（只用于诊断/关联，不参与幂等判定）。
    #[serde(default)]
    client_request_id: String,
    #[serde(rename = "createdAt", default)]
    created_at: String,
}

impl JournalEntry {
    fn is_legacy(&self) -> bool {
        self.op_id.is_empty()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 本进程在途的目录操作集合（Drop 自动摘除，panic 也能释放）。
fn active_ops() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

struct ActiveOp(String);

impl std::fmt::Debug for ActiveOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ActiveOp").field(&self.0).finish()
    }
}

impl ActiveOp {
    fn begin(op_id: &str) -> Self {
        active_ops()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(op_id.to_string());
        Self(op_id.to_string())
    }
}

impl Drop for ActiveOp {
    fn drop(&mut self) {
        active_ops()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.0);
    }
}

fn op_in_flight(op_id: &str) -> bool {
    !op_id.is_empty()
        && active_ops()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(op_id)
}

#[derive(Debug)]
struct DirectoryPlan {
    path: String,
    created: bool,
    status: &'static str,
    /// 本次目录操作身份；恢复日志按它定位（空 = 本模式不写日志）。
    op_id: String,
    /// 保持「在途」标记存活到事务结束/补偿完成。
    _active: Option<ActiveOp>,
}

impl DirectoryPlan {
    fn none() -> Self {
        Self {
            path: String::new(),
            created: false,
            status: "metadata_only",
            op_id: String::new(),
            _active: None,
        }
    }
}

fn journal_read(conn: &Connection) -> AppResult<Vec<JournalEntry>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM application_settings WHERE key = ?1",
            params![JOURNAL_KEY],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(Vec::new()) };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Vec<JournalEntry>>(&raw) {
        Ok(entries) => Ok(entries),
        Err(error) => {
            // 损坏的日志不能当作「没有日志」：否则后续写入会覆盖唯一的恢复线索。
            tracing::error!("项目目录恢复日志解析失败（保留原文，需人工核对）: {error}");
            Err(AppError::Unavailable(
                "项目目录恢复日志损坏，已阻止目录初始化（请检查应用设置）".into(),
            ))
        }
    }
}

fn journal_write(conn: &Connection, entries: &[JournalEntry]) -> AppResult<()> {
    if entries.is_empty() {
        conn.execute(
            "DELETE FROM application_settings WHERE key = ?1",
            params![JOURNAL_KEY],
        )?;
        return Ok(());
    }
    let value = serde_json::to_string(entries)?;
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![JOURNAL_KEY, value, now_iso()],
    )?;
    Ok(())
}

/// 追加条目：读-改-写在同一个 IMMEDIATE 事务里，多线程创建不会互相覆盖。
fn journal_add(db: &Db, entry: &JournalEntry) -> AppResult<()> {
    db.with_transaction(|conn| {
        let mut entries = journal_read(conn)?;
        entries.push(entry.clone());
        journal_write(conn, &entries)
    })
}

fn journal_set_state(db: &Db, op_id: &str, state: &str) -> AppResult<()> {
    db.with_transaction(|conn| {
        let mut entries = journal_read(conn)?;
        let mut changed = false;
        for entry in entries.iter_mut() {
            if entry.op_id == op_id && entry.state != state {
                entry.state = state.to_string();
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        journal_write(conn, &entries)
    })
}

/// 只按操作身份移除：绝不按路径批量删除，避免误删同一路径上其他操作的条目。
fn journal_remove_op(db: &Db, op_id: &str) -> AppResult<()> {
    if op_id.is_empty() {
        return Ok(());
    }
    db.with_transaction(|conn| {
        let mut entries = journal_read(conn)?;
        let before = entries.len();
        entries.retain(|entry| entry.op_id != op_id);
        if entries.len() == before {
            return Ok(());
        }
        journal_write(conn, &entries)
    })
}

/// 恢复日志条目的定位键（旧版条目没有 opId，用「路径 + 创建时间」定位）。
#[derive(Clone, Debug)]
enum JournalKey {
    Op(String),
    Legacy { path: String, created_at: String },
}

impl JournalKey {
    fn of(entry: &JournalEntry) -> Self {
        if entry.is_legacy() {
            Self::Legacy {
                path: path_key(&entry.path),
                created_at: entry.created_at.clone(),
            }
        } else {
            Self::Op(entry.op_id.clone())
        }
    }

    fn matches(&self, entry: &JournalEntry) -> bool {
        match self {
            Self::Op(op_id) => !entry.op_id.is_empty() && entry.op_id == *op_id,
            Self::Legacy { path, created_at } => {
                entry.is_legacy()
                    && path_key(&entry.path) == *path
                    && entry.created_at == *created_at
            }
        }
    }
}

/// 出清已处置的条目。
///
/// 关键点：在事务内**重新读取**当前日志再过滤。恢复过程可能耗时（磁盘 IO），
/// 期间其他创建操作会追加条目；用最初读到的快照整表覆盖会丢别人的日志（旧实现的缺陷）。
fn journal_prune(db: &Db, disposed: &[JournalKey]) -> AppResult<()> {
    if disposed.is_empty() {
        return Ok(());
    }
    db.with_transaction(|conn| {
        let entries = journal_read(conn)?;
        let kept: Vec<JournalEntry> = entries
            .into_iter()
            .filter(|entry| !disposed.iter().any(|key| key.matches(entry)))
            .collect();
        journal_write(conn, &kept)
    })
}

/// 目录是否被任何项目引用（归一化后按**相等**比较，不做前缀归属判断）。
fn path_referenced(conn: &Connection, path: &str) -> AppResult<bool> {
    let mut stmt =
        conn.prepare("SELECT root_path FROM workspace_projects WHERE TRIM(root_path) <> ''")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        if same_path(&row?, path) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 目录是否为空；读不到时返回 `None`（调用方必须按「非空」处理，绝不当作可删）。
fn dir_is_empty(path: &str) -> Option<bool> {
    match std::fs::read_dir(path) {
        Ok(mut iter) => Some(iter.next().is_none()),
        Err(error) => {
            tracing::warn!("读取目录失败，按非空处理（不删除）: {path} {error}");
            None
        }
    }
}

/// 清理「本次创建且仍为空、且没有被任何项目引用」的目录。
///
/// 绝不 `remove_dir_all`：非空目录一律保留（宁可留下空目录，也不删用户数据）。
fn cleanup_created_dir(db: &Db, path: &str) {
    match dir_is_empty(path) {
        Some(true) => {}
        Some(false) => {
            tracing::warn!("目录非空，保留不删: {path}");
            return;
        }
        None => return,
    }
    match db.with_read(|conn| path_referenced(conn, path)) {
        Ok(true) => {
            tracing::warn!("目录已被项目引用，保留不删: {path}");
            return;
        }
        Ok(false) => {}
        Err(error) => {
            tracing::warn!("检查目录引用失败，保留不删: {path} {error}");
            return;
        }
    }
    match std::fs::remove_dir(path) {
        Ok(()) => tracing::info!("已清理本次创建的空目录: {path}"),
        Err(error) => tracing::warn!("清理空目录失败（保留）: {path} {error}"),
    }
}

/// `attach_existing` 的只读校验：允许离线（移动硬盘/网络盘），拒绝文件与不可访问。
///
/// `create_with_conn` 与 [`prepare_directory`] 共用，保证「关联已有目录」只有一套语义。
fn inspect_attached_dir(path: &str) -> AppResult<&'static str> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Ok("attached"),
        Ok(_) => Err(AppError::Validation("工作目录不是文件夹".into())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok("attached_offline"),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            Err(AppError::Validation("没有权限访问工作目录".into()))
        }
        Err(_) => Err(AppError::Validation(
            "无法访问工作目录（网络盘可能已断开）".into(),
        )),
    }
}

/// 目录准备。只有 `create_new` 产生文件系统写入，顺序固定为：
/// 父目录校验 → 目标不存在 → 写恢复日志（pending）→ `create_dir` → 状态置 created → 建后校验。
fn prepare_directory(
    db: &Db,
    mode: DirectoryMode,
    raw_path: &str,
    client_request_id: &str,
) -> AppResult<DirectoryPlan> {
    let path = clean_root_path(Some(raw_path.to_string()))?;
    match mode {
        DirectoryMode::MetadataOnly => Ok(DirectoryPlan::none()),
        DirectoryMode::AttachExisting => {
            let status = inspect_attached_dir(&path)?;
            Ok(DirectoryPlan {
                path,
                created: false,
                status,
                op_id: String::new(),
                _active: None,
            })
        }
        DirectoryMode::CreateNew => create_new_directory(db, &path, client_request_id),
    }
}

fn create_new_directory(
    db: &Db,
    path: &str,
    client_request_id: &str,
) -> AppResult<DirectoryPlan> {
    let target = Path::new(path);
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::Validation("工作目录缺少父目录".into()))?;
    match std::fs::metadata(parent) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(AppError::Validation("父路径不是文件夹".into())),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(AppError::Validation("父目录不存在".into()));
        }
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(AppError::Validation("没有权限访问父目录".into()));
        }
        Err(_) => {
            return Err(AppError::Validation(
                "无法访问父目录（网络盘可能已断开）".into(),
            ));
        }
    }
    // 目标必须不存在：目录、文件、符号链接/junction 一律拒绝，避免把「新建」做成「覆盖」。
    match std::fs::symlink_metadata(target) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Ok(meta) => {
            let kind = if meta.file_type().is_symlink() {
                "符号链接"
            } else if meta.is_dir() {
                "目录"
            } else {
                "文件"
            };
            return Err(AppError::Conflict(format!(
                "目标路径已存在{kind}：{path}；如需复用请选择「关联已有目录」"
            )));
        }
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(AppError::Validation("没有权限检查目标路径".into()));
        }
        Err(_) => {
            return Err(AppError::Validation(
                "无法检查目标路径（网络盘可能已断开）".into(),
            ));
        }
    }

    // 记录建目录前的真实父目录，建目录后核对，防止父目录在窗口期被替换成符号链接/junction。
    let canonical_parent = std::fs::canonicalize(parent).ok();
    let op_id = uuid::Uuid::new_v4().to_string();
    let active = ActiveOp::begin(&op_id);
    let entry = JournalEntry {
        op_id: op_id.clone(),
        path: path.to_string(),
        state: JOURNAL_PENDING.to_string(),
        pid: std::process::id(),
        lease_until_ms: now_ms() + JOURNAL_LEASE_MS,
        client_request_id: client_request_id.to_string(),
        created_at: now_iso(),
    };
    // 日志必须先落库再建目录：否则「建目录后崩溃」没有任何线索。
    if let Err(error) = journal_add(db, &entry) {
        tracing::error!("写入项目目录恢复日志失败，已阻止创建目录: {error}");
        return Err(error);
    }

    if let Err(error) = std::fs::create_dir(target) {
        let _ = journal_remove_op(db, &op_id);
        return Err(match error.kind() {
            ErrorKind::AlreadyExists => AppError::Conflict(format!(
                "目标目录已存在：{path}；如需复用请选择「关联已有目录」"
            )),
            ErrorKind::PermissionDenied => AppError::Validation("没有权限创建目录".into()),
            ErrorKind::NotFound => AppError::Validation("父目录不存在".into()),
            _ => AppError::Validation(format!("创建目录失败：{error}")),
        });
    }

    if let Err(error) = journal_set_state(db, &op_id, JOURNAL_CREATED) {
        // 状态没写成功不影响安全性：条目仍在，恢复会按「可能已建目录」核对。
        tracing::warn!("更新项目目录恢复日志状态失败（条目仍可清理）: {error}");
    }

    let parent_unchanged = match (&canonical_parent, std::fs::canonicalize(target)) {
        (Some(expected), Ok(actual)) => actual.parent() == Some(expected.as_path()),
        // 无法核实（权限/网络异常）时按失败处理：不能把项目指向无法确认的位置。
        _ => false,
    };
    if !target.is_dir() || !parent_unchanged {
        tracing::error!("项目目录创建后校验失败（父目录可能被替换）: {path}");
        cleanup_created_dir(db, path);
        let _ = journal_remove_op(db, &op_id);
        return Err(AppError::Validation(
            "创建目录后校验失败（父目录可能在创建期间被替换）".into(),
        ));
    }

    Ok(DirectoryPlan {
        path: path.to_string(),
        created: true,
        status: "created",
        op_id,
        _active: Some(active),
    })
}

/// 事务成功后出清恢复日志。
fn finish_directory(db: &Db, plan: &DirectoryPlan) {
    if plan.op_id.is_empty() {
        return;
    }
    if let Err(error) = journal_remove_op(db, &plan.op_id) {
        tracing::error!("出清项目目录恢复日志失败（下次恢复会按日志核对）: {error}");
    }
}

/// 事务失败后的补偿：只删除本次创建的空目录，然后出清本条日志。
fn rollback_directory(db: &Db, plan: &DirectoryPlan) {
    if plan.created {
        cleanup_created_dir(db, &plan.path);
    }
    finish_directory(db, plan);
}

/// 清理「建目录后崩溃」留下的孤儿目录。
///
/// 判定顺序（任一不满足就保留，宁可留下空目录也不删用户数据）：
/// 1. 本进程在途操作 → 跳过（这是旧实现「恢复线程清掉创建线程日志」的根因）；
/// 2. 其他进程且租约未到期 → 跳过；
/// 3. 目录不存在 → 丢弃条目（无需清理）；目录不可访问 → 保留条目；
/// 4. 已被任一项目引用 → 只出清日志，绝不删除目录；
/// 5. 目录非空 → 保留目录、丢弃条目；
/// 6. 空目录且无引用 → `remove_dir`（失败则保留条目，下次重试）。
///
/// 返回实际清理的目录数量。
pub fn recover_pending(db: &Db) -> AppResult<u32> {
    let entries = db.with_read(journal_read)?;
    if entries.is_empty() {
        return Ok(0);
    }
    let now = now_ms();
    let mut disposed: Vec<JournalKey> = Vec::new();
    let mut kept = 0usize;
    let mut removed = 0u32;
    for entry in entries {
        if entry.path.trim().is_empty() {
            disposed.push(JournalKey::of(&entry));
            continue;
        }
        if op_in_flight(&entry.op_id) {
            tracing::debug!("跳过本进程在途目录操作: {}", entry.path);
            kept += 1;
            continue;
        }
        if entry.pid != std::process::id() && entry.lease_until_ms > now {
            kept += 1;
            continue;
        }
        let target = Path::new(&entry.path);
        match std::fs::symlink_metadata(target) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                // pending 条目对应的目录从没建出来（或已被用户删除）：无需清理。
                disposed.push(JournalKey::of(&entry));
                continue;
            }
            Err(error) => {
                tracing::warn!("恢复检查目录失败（保留条目）: {} {error}", entry.path);
                kept += 1;
                continue;
            }
        }
        match db.with_read(|conn| path_referenced(conn, &entry.path)) {
            Ok(true) => {
                // 事务已提交，只是日志没来得及出清。
                disposed.push(JournalKey::of(&entry));
                continue;
            }
            Ok(false) => {}
            Err(error) => {
                tracing::warn!("恢复检查目录引用失败（保留条目）: {} {error}", entry.path);
                kept += 1;
                continue;
            }
        }
        match dir_is_empty(&entry.path) {
            Some(true) => {}
            Some(false) => {
                // 有内容：可能是用户后来放进去的文件，永不删除，也不再反复核对。
                tracing::info!("恢复跳过非空目录（保留目录，出清日志）: {}", entry.path);
                disposed.push(JournalKey::of(&entry));
                continue;
            }
            None => {
                kept += 1;
                continue;
            }
        }
        match std::fs::remove_dir(target) {
            Ok(()) => {
                tracing::info!("恢复清理孤儿空目录: {}", entry.path);
                removed += 1;
                disposed.push(JournalKey::of(&entry));
            }
            Err(error) => {
                tracing::warn!("恢复清理空目录失败（保留条目）: {} {error}", entry.path);
                kept += 1;
            }
        }
    }
    journal_prune(db, &disposed)?;
    if removed > 0 || kept > 0 {
        tracing::info!("项目目录恢复完成：清理 {removed} 个空目录，保留 {kept} 条待核对日志");
    }
    Ok(removed)
}

// ── 事务内写入 ──────────────────────────────────────────────────────

/// 初始计划内容（阶段/里程碑/功能/任务/目标/能力需求）的唯一写入实现。
///
/// 调用方必须已处于事务中，且 `project_id` / `plan_id` 已存在。
fn insert_initial_plan_tx(
    conn: &Connection,
    project_id: &str,
    plan_id: &str,
    kind: &str,
    template_id: &str,
    draft: &CleanCreate,
    now: &str,
) -> AppResult<()> {
    for (index, (title, note)) in draft.goals.iter().enumerate() {
        conn.execute(
            "INSERT INTO project_goals
             (id, project_id, parent_id, title, note, kind, metric, target_value, unit,
              status, sort_order, source, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, 'goal', '', NULL, '', 'active', ?5, 'user', ?6, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                project_id,
                title,
                note,
                index as i64,
                now
            ],
        )?;
    }

    let mut phase_ids = Vec::new();
    for (index, phase) in draft.phases.iter().enumerate() {
        let phase_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO planning_milestones
             (id, project_id, name, description, target_date, sort_order, created_at, updated_at,
              kind, start_date, phase_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'phase', ?8, NULL)",
            params![
                phase_id,
                plan_id,
                phase.name,
                phase.description,
                phase.target_date,
                index as i64,
                now,
                phase.start_date
            ],
        )?;
        for (m_index, (title, detail, date)) in phase.milestones.iter().enumerate() {
            conn.execute(
                "INSERT INTO planning_milestones
                 (id, project_id, name, description, target_date, sort_order, created_at,
                  updated_at, kind, start_date, phase_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'milestone', NULL, ?8)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    plan_id,
                    title,
                    detail,
                    date,
                    m_index as i64,
                    now,
                    phase_id
                ],
            )?;
        }
        phase_ids.push(phase_id);
    }

    // 功能草案：与项目同事务落库，milestone_id 指向所属阶段（阶段复用里程碑表）。
    let mut feature_sort = std::collections::HashMap::<usize, i64>::new();
    for feature in draft.features.iter() {
        let milestone_id = feature
            .phase_index
            .and_then(|index| phase_ids.get(index))
            .cloned()
            .unwrap_or_default();
        let sort_order = match feature.phase_index {
            Some(index) => {
                let slot = feature_sort.entry(index).or_insert(0);
                let current = *slot;
                *slot += 1;
                current
            }
            None => 0,
        };
        conn.execute(
            "INSERT INTO planning_features
             (id, project_id, title, description, status, priority, milestone_id, target_date,
              sort_order, created_at, updated_at, completed_at, acceptance_criteria)
             VALUES (?1, ?2, ?3, '', 'planned', ?4, ?5, NULL, ?6, ?7, ?7, NULL, ?8)",
            params![
                uuid::Uuid::new_v4().to_string(),
                plan_id,
                feature.title,
                feature.priority,
                milestone_id,
                sort_order,
                now,
                feature.acceptance
            ],
        )?;
    }

    for (index, capability) in draft.capabilities.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO project_capabilities
             (id, name, category, description, mastery, mastery_note, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', 'unknown', '', ?4, ?4)",
            params![
                uuid::Uuid::new_v4().to_string(),
                capability.name,
                capability.category,
                now
            ],
        )?;
        let capability_id: String = conn.query_row(
            "SELECT id FROM project_capabilities WHERE name = ?1 AND category = ?2",
            params![capability.name, capability.category],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO project_capability_requirements
             (id, project_id, capability_id, phase_id, necessity, target_level,
              assessment_level, status, impact, alternative, source, sort_order,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'open', ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                uuid::Uuid::new_v4().to_string(),
                project_id,
                capability_id,
                capability
                    .phase_index
                    .and_then(|index| phase_ids.get(index))
                    .cloned(),
                capability.necessity,
                capability.target_level,
                capability.impact,
                capability.alternative,
                if template_id.is_empty() {
                    "user"
                } else {
                    "template"
                },
                index as i64,
                now
            ],
        )?;
    }

    for task in draft.tasks.iter() {
        let phase_id = task
            .phase_index
            .and_then(|index| phase_ids.get(index))
            .cloned()
            .unwrap_or_default();
        let task_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO tasks
             (id, title, description, priority, status, category, tags, due_at,
              remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at,
              completed_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, '[]', ?6, NULL, 0, NULL, ?7, ?7, NULL)",
            params![task_id, task.title, task.description, task.priority, kind, task.due_at, now],
        )?;
        conn.execute(
            "INSERT INTO task_plan_links
             (id, task_id, project_id, phase_id, milestone_id, created_at)
             VALUES (?1, ?2, ?3, ?4, '', ?5)",
            params![uuid::Uuid::new_v4().to_string(), task_id, project_id, phase_id, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO workspace_task_links (project_id, task_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![project_id, task_id, now],
        )?;
    }

    Ok(())
}

/// 幂等查询结果。
enum Replay {
    Fresh,
    Hit(ProjectCreateResult),
}

fn check_replay(conn: &Connection, prepared: &Prepared) -> AppResult<Replay> {
    if prepared.clean.client_request_id.is_empty() {
        return Ok(Replay::Fresh);
    }
    let existing: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT project_id,
                    json_extract(payload_json, '$.requestDigestV2'),
                    json_extract(payload_json, '$.requestDigest')
             FROM project_events
             WHERE kind = 'project_created'
               AND json_extract(payload_json, '$.clientRequestId') = ?1
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![prepared.clean.client_request_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((project_id, stored_v2, stored_v1)) = existing else {
        return Ok(Replay::Fresh);
    };
    let same = match (stored_v2.as_deref(), stored_v1.as_deref()) {
        // 新事件：只比较 V2（V2 覆盖 V1 全部字段）。
        (Some(v2), _) => v2 == prepared.digest_v2,
        // 旧事件没有 V2：按旧摘要判定；连旧摘要都没有时按「同一请求」兼容。
        (None, Some(v1)) => v1 == prepared.digest_v1,
        (None, None) => true,
    };
    if !same {
        return Err(AppError::Conflict(
            "同一请求 ID 已用于参数不同的项目创建；请使用新的请求 ID 重试".into(),
        ));
    }
    Ok(Replay::Hit(load_result(conn, &project_id, false)?))
}

fn load_result(
    conn: &Connection,
    project_id: &str,
    created: bool,
) -> AppResult<ProjectCreateResult> {
    let project = load_summary(conn, project_id)?;
    let plan_id = project
        .active_plan_id
        .clone()
        .ok_or_else(|| AppError::Validation("项目缺少 active 计划".into()))?;
    let active_plan = load_plan_summary(conn, &plan_id)?;
    let root_path = conn
        .query_row(
            "SELECT root_path, dev_project_id FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    let provisioned: Option<String> = conn
        .query_row(
            "SELECT json_extract(payload_json, '$.provisioningStatus')
             FROM project_events WHERE kind = 'project_created' AND project_id = ?1
             ORDER BY created_at DESC LIMIT 1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?;
    let root_exists = !root_path.0.trim().is_empty() && Path::new(&root_path.0).is_dir();
    let provisioning_status = provisioned.unwrap_or_else(|| {
        if root_path.0.trim().is_empty() {
            "metadata_only".into()
        } else {
            "attached".into()
        }
    });
    Ok(ProjectCreateResult {
        created,
        project,
        active_plan,
        workspace: ProjectWorkspaceView {
            project_id: project_id.to_string(),
            root_path: root_path.0,
            root_exists,
            dev_project_id: root_path.1,
            provisioning_status: provisioning_status.clone(),
        },
        provisioning_status,
    })
}

/// 事务内创建（调用方已处于事务中）。
///
/// MCP / CLI 等在既有写事务里调用本函数；目录只允许 `metadata_only` / `attach_existing`
/// （这两种不产生文件系统写入），`create_new` 必须走上层的 [`create`]。
pub fn create_in_conn(
    conn: &Connection,
    prepared: &Prepared,
    directory: &DirectoryPlan,
) -> AppResult<ProjectCreateResult> {
    if let Replay::Hit(result) = check_replay(conn, prepared)? {
        return Ok(result);
    }
    let now = now_iso();
    let (project_id, plan_id) = insert_project_root_tx(
        conn,
        &CreateProjectRootInput {
            name: prepared.clean.name.clone(),
            kind: prepared.clean.kind.clone(),
            description: prepared.clean.description.clone(),
            goal: prepared.clean.goal.clone(),
            target_date: prepared.clean.target_date.clone(),
            root_path: Some(directory.path.clone()),
            dev_project_id: prepared.dev_project_id.clone(),
            note: Some(
                prepared
                    .note
                    .clone()
                    .unwrap_or_else(|| prepared.clean.description.clone()),
            ),
            template_id: Some(prepared.clean.template_id.clone()),
            plan_name: prepared.plan_name.clone(),
            plan_description: prepared.plan_description.clone(),
            plan_status: Some(prepared.plan_status.clone()),
            plan_sort_order: None,
        },
    )?;
    insert_initial_plan_tx(
        conn,
        &project_id,
        &plan_id,
        &prepared.clean.kind,
        &prepared.clean.template_id,
        &prepared.clean,
        &now,
    )?;
    conn.execute(
        "INSERT INTO project_events
         (id, project_id, kind, actor, summary, payload_json, created_at)
         VALUES (?1, ?2, 'project_created', ?3, ?4, ?5, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            project_id,
            if prepared.policy == AgentAccessPolicy::None {
                "user"
            } else {
                "agent"
            },
            format!("创建项目「{}」", prepared.clean.name),
            serde_json::json!({
                "clientRequestId": prepared.clean.client_request_id,
                "requestDigest": prepared.digest_v1,
                "requestDigestV2": prepared.digest_v2,
                "templateId": prepared.clean.template_id,
                "kind": prepared.clean.kind,
                "planId": plan_id,
                "directoryMode": prepared.mode.as_str(),
                "provisioningStatus": directory.status,
                "agentAccessPolicy": prepared.policy.as_str(),
            })
            .to_string(),
            now
        ],
    )?;
    load_result(conn, &project_id, true)
}

// ── 对外入口 ────────────────────────────────────────────────────────

/// 统一创建入口：幂等判定在最前，目录准备在外，数据写入在单事务内，失败补偿目录。
///
/// 顺序不可调整：
/// - 幂等必须先于目录初始化（`create_new` 的第二次相同请求不能因为「目录已存在」变成 Conflict）；
/// - 恢复扫描放在**创建收尾**而不是创建之前：创建前扫描会把用户刚选来关联的空目录当成
///   「上次崩溃的孤儿」删掉（项目随即变成 `attached_offline`）。收尾时本次目录已被项目引用，
///   在途操作由 `ACTIVE_OPS` 保护，扫描只可能命中真正无人认领的旧目录。
pub fn create(db: &Db, request: CreateProjectRequest) -> AppResult<ProjectCreateResult> {
    let prepared = db.with_read(|conn| prepare(conn, request))?;
    // 1. 幂等优先：命中即返回既有结果，不建目录、不跑恢复（重放不能有副作用）。
    if let Replay::Hit(result) = db.with_read(|conn| check_replay(conn, &prepared))? {
        return Ok(result);
    }
    // 2. 目录准备：只有 create_new 会写文件系统。
    let directory = match prepare_directory(
        db,
        prepared.mode,
        &prepared.clean.root_path,
        &prepared.clean.client_request_id,
    ) {
        Ok(plan) => plan,
        // 目标已存在 + 是同一个请求：可能是并发/超时重试的另一个请求刚完成。
        Err(error @ AppError::Conflict(_)) if prepared.mode == DirectoryMode::CreateNew => {
            if let Replay::Hit(result) = db.with_read(|conn| check_replay(conn, &prepared))? {
                return Ok(result);
            }
            sweep_pending(db);
            return Err(error);
        }
        Err(error) => {
            sweep_pending(db);
            return Err(error);
        }
    };
    // 3. 单事务写入；事务内还会再做一次幂等判定（并发下以数据库为准）。
    let outcome = db.with_transaction(|conn| create_in_conn(conn, &prepared, &directory));
    match outcome {
        Ok(result) => {
            finish_directory(db, &directory);
            sweep_pending(db);
            Ok(result)
        }
        Err(error) => {
            rollback_directory(db, &directory);
            sweep_pending(db);
            Err(error)
        }
    }
}

/// 恢复上次崩溃遗留的孤儿目录（best effort：失败只记录，绝不影响本次创建结果）。
fn sweep_pending(db: &Db) {
    match recover_pending(db) {
        Ok(0) => {}
        Ok(removed) => tracing::info!("清理 {removed} 个遗留的空目录"),
        Err(error) => tracing::warn!("目录恢复失败（不影响本次创建）: {error}"),
    }
}

/// 供「已在事务里」的调用方使用：`create_new` 会被拒绝（文件系统不能进事务）。
pub fn create_with_conn(
    conn: &Connection,
    request: CreateProjectRequest,
) -> AppResult<ProjectCreateResult> {
    let prepared = prepare(conn, request)?;
    // 重放不校验目录现状：目录已被移动/删除/改成文件时，重试仍应拿回原结果而不是新错误。
    if let Replay::Hit(result) = check_replay(conn, &prepared)? {
        return Ok(result);
    }
    if prepared.mode == DirectoryMode::CreateNew {
        return Err(AppError::Validation(
            "create_new 需要走统一创建入口（文件系统初始化不能与数据库事务混用）".into(),
        ));
    }
    // 目录只做只读校验；attach_existing / metadata_only 不产生文件系统写入。
    let (path, status) = match prepared.mode {
        DirectoryMode::MetadataOnly => (String::new(), "metadata_only"),
        _ => {
            let path = clean_root_path(Some(prepared.clean.root_path.clone()))?;
            let status = inspect_attached_dir(&path)?;
            (path, status)
        }
    };
    let plan = DirectoryPlan {
        path,
        created: false,
        status,
        op_id: String::new(),
        _active: None,
    };
    create_in_conn(conn, &prepared, &plan)
}

/// 暴露给入口层的策略读取（结果里也带，便于日志/审计）。
pub fn policy_of(request: &CreateProjectRequest) -> AgentAccessPolicy {
    request.agent_access_policy
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "taskdock-creation-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
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
            draft: InitialPlanDraft::default(),
            agent_access_policy: AgentAccessPolicy::None,
        }
    }

    /// 构造一条「本进程已放弃」的恢复日志（pid = 本进程、不在 ACTIVE_OPS、无租约）。
    fn test_entry(path: &str, state: &str) -> JournalEntry {
        JournalEntry {
            op_id: uuid::Uuid::new_v4().to_string(),
            path: path.to_string(),
            state: state.to_string(),
            pid: std::process::id(),
            lease_until_ms: 0,
            client_request_id: String::new(),
            created_at: now_iso(),
        }
    }

    fn journal(db: &Db) -> Vec<JournalEntry> {
        db.with_read(journal_read).unwrap()
    }

    #[test]
    fn creates_project_root_and_active_plan_in_one_transaction() {
        let db = Db::open_in_memory().unwrap();
        let created = create(&db, request("统一项目", "req-1")).unwrap();
        assert!(created.created);
        assert_ne!(created.project.id, created.active_plan.id);
        assert_eq!(
            created.project.active_plan_id.as_deref(),
            Some(created.active_plan.id.as_str())
        );
        assert_eq!(created.active_plan.project_id, created.project.id);
        assert!(created.active_plan.is_active);
        assert_eq!(created.provisioning_status, "metadata_only");
        // 计划容器归属项目根，且只有一个 active
        let (plans, active) = db
            .with_read(|conn| {
                let total: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM planning_projects WHERE workspace_project_id = ?1",
                    params![created.project.id],
                    |r| r.get(0),
                )?;
                let active: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM planning_projects
                     WHERE workspace_project_id = ?1 AND is_active = 1",
                    params![created.project.id],
                    |r| r.get(0),
                )?;
                Ok((total, active))
            })
            .unwrap();
        assert_eq!((plans, active), (1, 1));
    }

    #[test]
    fn idempotent_replay_returns_existing_without_duplicates() {
        let db = Db::open_in_memory().unwrap();
        let first = create(&db, request("幂等项目", "req-same")).unwrap();
        let second = create(&db, request("幂等项目", "req-same")).unwrap();
        assert!(!second.created);
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(first.active_plan.id, second.active_plan.id);
        let count: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM workspace_projects", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn same_request_id_with_different_params_conflicts() {
        let db = Db::open_in_memory().unwrap();
        create(&db, request("项目 A", "req-conflict")).unwrap();
        let error = create(&db, request("项目 B", "req-conflict")).unwrap_err();
        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
    }

    #[test]
    fn metadata_only_rejects_root_path() {
        let db = Db::open_in_memory().unwrap();
        let mut input = request("元数据项目", "req-meta");
        input.root_path = Some("C:\\tmp".into());
        let error = create(&db, input).unwrap_err();
        assert!(matches!(error, AppError::Validation(_)), "{error:?}");
    }

    #[test]
    fn attach_existing_allows_offline_path_but_rejects_file() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("attach");
        let missing = dir.join("not-created");
        let mut offline = request("离线项目", "req-offline");
        offline.root_path = Some(missing.to_string_lossy().to_string());
        offline.directory_mode = DirectoryMode::AttachExisting;
        let created = create(&db, offline).unwrap();
        assert_eq!(created.provisioning_status, "attached_offline");
        assert!(!created.workspace.root_exists);

        let file = dir.join("note.txt");
        std::fs::write(&file, b"x").unwrap();
        let mut by_file = request("文件项目", "req-file");
        by_file.root_path = Some(file.to_string_lossy().to_string());
        by_file.directory_mode = DirectoryMode::AttachExisting;
        assert!(create(&db, by_file).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_new_creates_directory_and_rejects_existing() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("create-new");
        let target = parent.join("project");
        let mut input = request("新目录项目", "req-create-new");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        let created = create(&db, input).unwrap();
        assert_eq!(created.provisioning_status, "created");
        assert!(target.is_dir());
        assert!(created.workspace.root_exists);
        // 已存在目录不能再次 create_new
        let mut again = request("重复目录", "req-create-new-2");
        again.root_path = Some(target.to_string_lossy().to_string());
        again.directory_mode = DirectoryMode::CreateNew;
        assert!(matches!(
            create(&db, again).unwrap_err(),
            AppError::Conflict(_)
        ));
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn failed_transaction_rolls_back_only_new_empty_directory() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("rollback");
        let target = parent.join("boom");
        // 注入故障：删掉初始计划要写的表，使事务在目录创建后失败。
        db.with_transaction(|conn| {
            conn.execute_batch("DROP TABLE planning_milestones")?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let mut input = request("回滚项目", "req-rollback");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        input.draft.phases = vec![CreatePhaseInput {
            name: "阶段".into(),
            description: String::new(),
            target_date: None,
            start_date: None,
            milestones: vec![],
        }];
        assert!(create(&db, input).is_err());
        assert!(!target.exists(), "失败后必须移除本次创建的空目录");
        assert!(journal(&db).is_empty(), "失败补偿后必须出清本操作的日志");
        let projects: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM workspace_projects", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(projects, 0);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn recover_pending_removes_only_unreferenced_empty_directory() {
        let db = Db::open_in_memory().unwrap();
        let orphan = temp_dir("orphan").join("empty");
        std::fs::create_dir_all(&orphan).unwrap();
        journal_add(
            &db,
            &test_entry(orphan.to_string_lossy().as_ref(), JOURNAL_CREATED),
        )
        .unwrap();
        assert_eq!(recover_pending(&db).unwrap(), 1);
        assert!(!orphan.exists());

        // 有项目引用的目录只出清日志，不删除。
        let kept = temp_dir("kept");
        let mut input = request("引用项目", "req-kept");
        input.root_path = Some(kept.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::AttachExisting;
        let created = create(&db, input).unwrap();
        assert!(created.workspace.root_exists);
        // 模拟「事务已提交，但进程在出清日志前崩溃」。
        journal_add(
            &db,
            &test_entry(kept.to_string_lossy().as_ref(), JOURNAL_CREATED),
        )
        .unwrap();
        assert_eq!(recover_pending(&db).unwrap(), 0);
        assert!(kept.is_dir());
        assert!(journal(&db).is_empty(), "已引用目录只出清日志");
        let _ = std::fs::remove_dir_all(&kept);
    }

    #[test]
    fn plan_id_resolves_to_project_root() {
        let db = Db::open_in_memory().unwrap();
        let created = create(&db, request("解析项目", "req-resolve")).unwrap();
        let resolved = db
            .with_read(|conn| {
                Ok(super::super::service::resolve_project_ref(
                    conn,
                    &created.active_plan.id,
                )?)
            })
            .unwrap()
            .expect("计划 ID 必须能反解析");
        assert_eq!(
            resolved,
            super::super::service::ProjectRef::Plan {
                plan_id: created.active_plan.id.clone(),
                project_id: created.project.id.clone(),
            }
        );
    }

    // ── 幂等：重放不得有副作用 ──────────────────────────────────────

    #[test]
    fn attach_existing_keeps_directory_that_has_stale_journal_entry() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("attach-stale-journal");
        // 模拟：该目录曾被一次失败的 create_new 创建（日志还在），用户随后选择「关联已有目录」。
        journal_add(
            &db,
            &test_entry(dir.to_string_lossy().as_ref(), JOURNAL_CREATED),
        )
        .unwrap();
        let mut input = request("关联已存在目录", "req-attach-stale");
        input.root_path = Some(dir.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::AttachExisting;
        let created = create(&db, input).unwrap();
        // 恢复扫描必须在事务提交之后：否则会把用户刚选的空目录当孤儿删掉。
        assert_eq!(created.provisioning_status, "attached");
        assert!(created.workspace.root_exists);
        assert!(dir.is_dir(), "用户选择关联的目录不得被恢复删除");
        assert!(journal(&db).is_empty(), "已处置条目必须出清");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_new_replay_returns_existing_project_without_directory_conflict() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("replay-create-new");
        let target = parent.join("project");
        let mut input = request("新目录重放", "req-replay-create-new");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        let first = create(&db, input.clone()).unwrap();
        assert!(first.created);
        // 旧实现：第二次相同请求因为「目录已存在」在幂等查询之前返回 Conflict。
        let second = create(&db, input).unwrap();
        assert!(!second.created, "同一请求必须命中幂等");
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(first.active_plan.id, second.active_plan.id);
        assert!(target.is_dir(), "重放不能删除已提交项目的目录");
        assert!(journal(&db).is_empty(), "重放不应留下恢复日志");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn attach_existing_replay_ignores_current_directory_state() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("replay-attach");
        let target = dir.join("ws");
        std::fs::create_dir_all(&target).unwrap();
        let mut input = request("关联重放", "req-replay-attach");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::AttachExisting;
        let first = create(&db, input.clone()).unwrap();
        assert_eq!(first.provisioning_status, "attached");
        // 目录后来离线/被改名：重试仍然拿到原结果，而不是「工作目录不是文件夹」。
        std::fs::remove_dir(&target).unwrap();
        let second = create(&db, input).unwrap();
        assert!(!second.created);
        assert_eq!(second.project.id, first.project.id);
        assert!(!second.workspace.root_exists, "root_exists 反映当前事实");
        assert!(journal(&db).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadata_only_replay_has_no_side_effects() {
        let db = Db::open_in_memory().unwrap();
        let first = create(&db, request("元数据重放", "req-meta-replay")).unwrap();
        let second = create(&db, request("元数据重放", "req-meta-replay")).unwrap();
        assert!(!second.created);
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(second.provisioning_status, "metadata_only");
        assert!(journal(&db).is_empty());
        let plans: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM planning_projects", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(plans, 1, "重放不得重复写初始计划");
    }

    #[test]
    fn retry_after_lost_response_recovers_result_and_keeps_directory() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("retry-lost");
        let target = parent.join("proj");
        let mut input = request("丢响应项目", "req-lost-response");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        let first = create(&db, input.clone()).unwrap();
        // 模拟「事务已提交，但进程在出清日志前崩溃」。
        journal_add(
            &db,
            &test_entry(target.to_string_lossy().as_ref(), JOURNAL_CREATED),
        )
        .unwrap();
        let retried = create(&db, input).unwrap();
        assert!(!retried.created);
        assert_eq!(retried.project.id, first.project.id);
        assert!(target.is_dir(), "已提交项目的目录不能被恢复删除");
        assert_eq!(recover_pending(&db).unwrap(), 0);
        assert!(target.is_dir());
        assert!(journal(&db).is_empty(), "已提交项目只出清日志");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn legacy_event_without_digest_v2_still_replays() {
        let db = Db::open_in_memory().unwrap();
        let first = create(&db, request("旧事件项目", "req-legacy")).unwrap();
        // 人工降级事件：去掉 requestDigestV2，模拟旧版本写入的 project_created。
        let payload: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT payload_json FROM project_events
                     WHERE kind = 'project_created' AND project_id = ?1",
                    params![first.project.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        value.as_object_mut().unwrap().remove("requestDigestV2");
        db.with_transaction(|conn| {
            conn.execute(
                "UPDATE project_events SET payload_json = ?1
                 WHERE kind = 'project_created' AND project_id = ?2",
                params![value.to_string(), first.project.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        // 旧摘要命中 → 同一请求。
        let replay = create(&db, request("旧事件项目", "req-legacy")).unwrap();
        assert!(!replay.created);
        assert_eq!(replay.project.id, first.project.id);
        // 参数变化后旧摘要不同 → 必须冲突，不能因为「没有 V2」就一律放行。
        let conflict = create(&db, request("改过的名字", "req-legacy")).unwrap_err();
        assert!(matches!(conflict, AppError::Conflict(_)), "{conflict:?}");
    }

    #[test]
    fn replay_does_not_switch_back_active_plan() {
        let db = Db::open_in_memory().unwrap();
        let first = create(&db, request("多计划项目", "req-plan-switch")).unwrap();
        let second_plan = crate::project_hub::service::create_project_plan(
            &db,
            crate::project_hub::service::CreatePlanInput {
                project_id: first.project.id.clone(),
                // 计划名跟随项目名，不支持单独命名（与 create_project_plan 的约束一致）。
                name: None,
                description: Some("第二方案".into()),
                target_date: None,
                status: Some("planning".into()),
                template_id: None,
                make_active: false,
            },
        )
        .unwrap();
        crate::project_hub::service::activate_plan(&db, &second_plan).unwrap();
        let replay = create(&db, request("多计划项目", "req-plan-switch")).unwrap();
        assert!(!replay.created);
        assert_eq!(
            replay.active_plan.id, second_plan,
            "重放只能读取当前 active 计划，不能切回创建时的计划"
        );
        let stored: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
                    params![first.project.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(stored, second_plan);
    }

    // ── 并发 ────────────────────────────────────────────────────────

    #[test]
    fn concurrent_same_request_id_creates_exactly_one_project() {
        let db = std::sync::Arc::new(Db::open_in_memory().unwrap());
        let input = request("并发项目", "req-concurrent");
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let db = db.clone();
                let input = input.clone();
                std::thread::spawn(move || {
                    create(&db, input)
                        .map(|result| (result.created, result.project.id))
                        .map_err(|error| error.to_string())
                })
            })
            .collect();
        let results: Vec<Result<(bool, String), String>> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        let winners = results
            .iter()
            .filter(|result| matches!(result, Ok((created, _)) if *created))
            .count();
        assert_eq!(winners, 1, "同一请求 ID 只能有一个创建者: {results:?}");
        let ids: HashSet<String> = results
            .iter()
            .filter_map(|result| result.as_ref().ok().map(|(_, id)| id.clone()))
            .collect();
        assert_eq!(ids.len(), 1, "两个响应必须指向同一个项目: {results:?}");
        let count: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM workspace_projects", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn concurrent_create_new_never_duplicates_project_or_directory() {
        let db = std::sync::Arc::new(Db::open_in_memory().unwrap());
        let parent = temp_dir("concurrent-create-new");
        let target = parent.join("proj");
        let mut input = request("并发新目录", "req-concurrent-create-new");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let db = db.clone();
                let input = input.clone();
                std::thread::spawn(move || {
                    create(&db, input)
                        .map(|result| (result.created, result.project.id))
                        .map_err(|error| error.to_string())
                })
            })
            .collect();
        let results: Vec<Result<(bool, String), String>> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        // 目录只有一个赢家：另一个要么幂等命中，要么明确 Conflict；绝不出现两条项目记录。
        assert!(
            results.iter().any(|result| result.is_ok()),
            "至少有一个请求成功: {results:?}"
        );
        let count: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM workspace_projects", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(count, 1, "并发不得创建两条项目记录: {results:?}");
        assert!(target.is_dir(), "赢家的目录必须保留");
        assert!(journal(&db).is_empty(), "输家不得留下恢复日志");
        let _ = std::fs::remove_dir_all(&parent);
    }

    // ── 恢复日志：并发协调与故障注入 ────────────────────────────────

    #[test]
    fn recover_pending_skips_operation_still_in_flight() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("journal-race");
        let target = parent.join("proj");
        let op_id = uuid::Uuid::new_v4().to_string();
        // 时刻 1：创建线程已写日志（pending），尚未建目录。
        let active = ActiveOp::begin(&op_id);
        journal_add(
            &db,
            &JournalEntry {
                op_id: op_id.clone(),
                path: target.to_string_lossy().to_string(),
                state: JOURNAL_PENDING.to_string(),
                pid: std::process::id(),
                lease_until_ms: now_ms() + JOURNAL_LEASE_MS,
                client_request_id: "req-race".into(),
                created_at: now_iso(),
            },
        )
        .unwrap();
        // 时刻 2：恢复线程运行。旧实现会把这条日志当成「目录不存在」清掉，
        // 于是时刻 3 崩溃后目录再也没人认领。
        assert_eq!(recover_pending(&db).unwrap(), 0);
        assert_eq!(journal(&db).len(), 1, "在途操作的日志不能被清理");
        // 时刻 3：创建线程建目录后崩溃。
        std::fs::create_dir(&target).unwrap();
        drop(active);
        // 重启后的恢复：这次可以安全回收。
        assert_eq!(recover_pending(&db).unwrap(), 1);
        assert!(!target.exists());
        assert!(journal(&db).is_empty());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn journal_prune_keeps_entries_added_during_recovery() {
        let db = Db::open_in_memory().unwrap();
        let stale = test_entry("D:\\work\\a", JOURNAL_CREATED);
        journal_add(&db, &stale).unwrap();
        // 恢复开始时读到的快照。
        let snapshot = journal(&db);
        let disposed = vec![JournalKey::of(&snapshot[0])];
        // 恢复做磁盘核对期间，另一个创建操作追加了条目。
        let fresh = test_entry("D:\\work\\b", JOURNAL_PENDING);
        journal_add(&db, &fresh).unwrap();
        journal_prune(&db, &disposed).unwrap();
        let left = journal(&db);
        assert_eq!(left.len(), 1, "并发新增的条目不能被旧快照覆盖");
        assert_eq!(left[0].op_id, fresh.op_id);
    }

    #[test]
    fn journal_entries_are_removed_by_operation_identity() {
        let db = Db::open_in_memory().unwrap();
        let first = test_entry("D:\\work\\same", JOURNAL_CREATED);
        let second = test_entry("D:\\work\\other", JOURNAL_CREATED);
        journal_add(&db, &first).unwrap();
        journal_add(&db, &second).unwrap();
        assert_eq!(journal(&db).len(), 2);
        journal_remove_op(&db, &first.op_id).unwrap();
        let left = journal(&db);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].op_id, second.op_id, "不同操作的条目互不覆盖");
    }

    #[test]
    fn recover_drops_pending_entry_whose_directory_never_existed() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("pending-missing");
        let never = parent.join("never-created");
        journal_add(
            &db,
            &test_entry(never.to_string_lossy().as_ref(), JOURNAL_PENDING),
        )
        .unwrap();
        assert_eq!(recover_pending(&db).unwrap(), 0);
        assert!(!never.exists(), "恢复不得创建目录");
        assert!(journal(&db).is_empty(), "无目录可清理时只丢弃条目");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn recover_never_deletes_non_empty_directory() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("recover-nonempty");
        std::fs::write(dir.join("user.txt"), b"data").unwrap();
        journal_add(
            &db,
            &test_entry(dir.to_string_lossy().as_ref(), JOURNAL_CREATED),
        )
        .unwrap();
        assert_eq!(recover_pending(&db).unwrap(), 0);
        assert!(dir.join("user.txt").exists(), "非空目录永不删除");
        assert!(journal(&db).is_empty(), "非空目录不再反复核对");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_respects_other_process_lease() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("lease");
        let target = parent.join("proj");
        std::fs::create_dir(&target).unwrap();
        // 另一个进程刚写下的条目：租约内不得回收。
        let mut foreign = test_entry(target.to_string_lossy().as_ref(), JOURNAL_CREATED);
        foreign.pid = std::process::id().wrapping_add(1);
        foreign.lease_until_ms = now_ms() + JOURNAL_LEASE_MS;
        journal_add(&db, &foreign).unwrap();
        assert_eq!(recover_pending(&db).unwrap(), 0, "其他进程租约内不回收");
        assert!(target.is_dir());
        assert_eq!(journal(&db).len(), 1);
        // 租约到期：可以安全回收。
        let mut expired = foreign.clone();
        expired.lease_until_ms = now_ms() - 1;
        db.with_transaction(|conn| journal_write(conn, &[expired]))
            .unwrap();
        assert_eq!(recover_pending(&db).unwrap(), 1);
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn corrupt_journal_blocks_create_new_instead_of_losing_recovery_trail() {
        let db = Db::open_in_memory().unwrap();
        db.with_transaction(|conn| {
            conn.execute(
                "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![JOURNAL_KEY, "{not-json", now_iso()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let parent = temp_dir("corrupt-journal");
        let target = parent.join("proj");
        let mut input = request("损坏日志", "req-corrupt");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        let error = create(&db, input).unwrap_err();
        assert!(matches!(error, AppError::Unavailable(_)), "{error:?}");
        assert!(!target.exists(), "日志不可写时不能建目录");
        let _ = std::fs::remove_dir_all(&parent);
    }

    // ── 路径安全 ────────────────────────────────────────────────────

    #[test]
    fn path_policy_rejects_unc_relative_and_verbatim_paths() {
        let db = Db::open_in_memory().unwrap();
        for (index, raw) in [
            r"\\server\share\proj",
            r"\\?\C:\proj",
            r"relative\dir",
            r"C:proj",
        ]
        .iter()
        .enumerate()
        {
            let mut input = request("路径项目", &format!("req-path-{index}"));
            input.root_path = Some(raw.to_string());
            input.directory_mode = DirectoryMode::AttachExisting;
            let error = create(&db, input).unwrap_err();
            assert!(
                matches!(error, AppError::Validation(_)),
                "{raw} 应被拒绝，实际: {error:?}"
            );
        }
    }

    #[test]
    fn path_comparison_normalizes_case_and_separators() {
        #[cfg(windows)]
        {
            assert!(same_path(r"D:\Work\Proj", r"d:/work/proj/"));
            assert!(same_path(r"D:\Work\Proj", r"D:\Work\Proj\"));
            assert!(!same_path(r"D:\Work", r"D:\Work2"));
            assert!(!same_path(r"D:\Work\Proj", r"D:\Work\Proj2"));
        }
        // 空路径永远不等于任何路径（避免「未设置目录」误判为同一位置）。
        assert!(!same_path("", r"D:\Work"));
        assert!(same_path("/var/work", "/var/work"));
    }

    #[test]
    fn attach_existing_never_creates_directory() {
        let db = Db::open_in_memory().unwrap();
        let dir = temp_dir("attach-no-create");
        let missing = dir.join("absent");
        let mut input = request("离线关联", "req-attach-no-create");
        input.root_path = Some(missing.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::AttachExisting;
        let created = create(&db, input).unwrap();
        assert_eq!(created.provisioning_status, "attached_offline");
        assert!(!missing.exists(), "attach_existing 不得创建目录");
        assert!(journal(&db).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_new_writes_project_plan_and_task_graph_with_clean_foreign_keys() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("integrity");
        let target = parent.join("proj");
        let mut input = request("完整性项目", "req-integrity");
        input.root_path = Some(target.to_string_lossy().to_string());
        input.directory_mode = DirectoryMode::CreateNew;
        input.draft.phases = vec![CreatePhaseInput {
            name: "阶段一".into(),
            description: String::new(),
            target_date: None,
            start_date: None,
            milestones: vec![],
        }];
        input.draft.features = vec![CreateFeatureInput {
            title: "功能一".into(),
            acceptance: "验收".into(),
            priority: None,
            phase_index: Some(0),
        }];
        input.draft.tasks = vec![CreateTaskInput {
            title: "任务一".into(),
            description: String::new(),
            phase_index: Some(0),
            due_at: None,
            priority: None,
        }];
        let created = create(&db, input).unwrap();

        let (fk_violations, task_project, task_phase, feature_phase, active) = db
            .with_read(|conn| {
                let fk: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_foreign_key_check",
                    [],
                    |r| r.get(0),
                )?;
                let task_project: String = conn.query_row(
                    "SELECT project_id FROM task_plan_links WHERE task_id =
                       (SELECT id FROM tasks WHERE title = '任务一')",
                    [],
                    |r| r.get(0),
                )?;
                let task_phase: String = conn.query_row(
                    "SELECT phase_id FROM task_plan_links WHERE task_id =
                       (SELECT id FROM tasks WHERE title = '任务一')",
                    [],
                    |r| r.get(0),
                )?;
                let feature_phase: String = conn.query_row(
                    "SELECT milestone_id FROM planning_features WHERE title = '功能一'",
                    [],
                    |r| r.get(0),
                )?;
                let active: String = conn.query_row(
                    "SELECT active_plan_id FROM workspace_projects WHERE id = ?1",
                    params![created.project.id],
                    |r| r.get(0),
                )?;
                Ok((fk, task_project, task_phase, feature_phase, active))
            })
            .unwrap();
        assert_eq!(fk_violations, 0, "创建后不得有外键违规");
        assert_eq!(task_project, created.project.id, "任务归属项目根");
        assert!(!task_phase.is_empty(), "任务必须归属阶段");
        assert_eq!(feature_phase, task_phase, "功能与任务指向同一阶段");
        assert_eq!(active, created.active_plan.id, "active_plan_id 指向初始计划");
        assert!(target.is_dir());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn create_new_rejects_file_target_and_missing_parent() {
        let db = Db::open_in_memory().unwrap();
        let parent = temp_dir("create-new-guards");
        let file = parent.join("note.txt");
        std::fs::write(&file, b"x").unwrap();
        let mut by_file = request("文件目标", "req-create-new-file");
        by_file.root_path = Some(file.to_string_lossy().to_string());
        by_file.directory_mode = DirectoryMode::CreateNew;
        assert!(matches!(
            create(&db, by_file).unwrap_err(),
            AppError::Conflict(_)
        ));
        assert_eq!(std::fs::read(&file).unwrap(), b"x", "原有文件不得被改动");

        let mut missing_parent = request("缺失父目录", "req-create-new-parent");
        missing_parent.root_path = Some(
            parent
                .join("nope")
                .join("proj")
                .to_string_lossy()
                .to_string(),
        );
        missing_parent.directory_mode = DirectoryMode::CreateNew;
        let error = create(&db, missing_parent).unwrap_err();
        assert!(matches!(error, AppError::Validation(_)), "{error:?}");
        assert!(journal(&db).is_empty());
        let _ = std::fs::remove_dir_all(&parent);
    }
}
