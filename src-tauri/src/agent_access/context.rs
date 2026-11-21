//! Context Engine：按「当前任务」组织相关上下文，而不是让 Agent 遍历整个工作空间。
//!
//! 检索策略（可解释、无外部依赖）：
//! 显式范围 + 标题匹配 + 正文关键词 + 状态 + 时间新鲜度 + 多命中 + 决策/交接状态加权；
//! 不使用向量库，不引入外部索引；每条结果都带来源 ID、类型、更新时间、相关性与访问方式。
//!
//! 授权模型（v81 修正）：
//! 1) `ContextRead` 是**装配入口**的必要条件；
//! 2) 每种资源再按自己的读能力过滤：没有 `TasksRead` 就不返回任务，而不是整次失败；
//! 3) 显式请求未授权资源 → 明确的权限错误（不静默返回空）；
//! 4) 默认上下文允许“部分结果”，但绝不跨项目/跨权限回退到全局数据。
//!
//! v82 修正（资源粒度 / 归属 / 预算三处缺陷）：
//! 1) **资源粒度**：每类资源用**各自的**读取能力判定（`TasksRead` / `PlansRead` /
//!    `KnowledgeRead` / `DecisionsRead` / `SkillsRead` / `HandoffsRead`）；
//!    任务级授权必须落在「该项目下的任务集合」内，`ContextRead` 不能代替任何资源能力；
//! 2) **归属**：近期变更按真实业务关联（`workspace_task_links` / `knowledge_bases` /
//!    `agent_decisions` / `agent_handoffs` / `agent_work_reports`）判定归属，
//!    绝不再用「资源 ID == 项目 ID」的字符串相等；
//! 3) **预算**：固定骨架（项目 / 目标 / 约束 / 下一步 / 元数据）先占额度，
//!    条目与近期变更只能用剩余额度；Markdown 与 JSON 共用同一份裁剪结果。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::capability::skills;
use crate::commands::planning::{list_features_impl, load_project_tx};
use crate::commands::tasks::{list_tasks_inner, TaskFilter};
use crate::db::Db;
use crate::db::Task;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::permissions as perms;
use super::service;
use super::store;
use super::Principal;

pub const DEFAULT_BUDGET: u32 = 6000;
pub const MAX_BUDGET: u32 = 24000;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ContextRequest {
    /// 自然语言任务描述
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub budget_tokens: Option<u32>,
    /// 需要的资源类型：task/knowledge/decision/handoff/skill/plan
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContextItem {
    pub kind: String,
    pub source_id: String,
    pub title: String,
    pub summary: String,
    pub updated_at: String,
    pub relevance: i64,
    /// 原始资源访问方式（CLI / MCP / REST 三选一，均可）
    pub access: String,
    pub project_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AgentContext {
    pub project_id: String,
    pub project_name: String,
    pub objective: String,
    pub scope: Value,
    pub items: Vec<ContextItem>,
    pub constraints: Vec<String>,
    pub next_steps: Vec<String>,
    pub recent_changes: Vec<ContextItem>,
    pub budget_tokens: u32,
    pub estimated_tokens: u32,
    pub truncated: bool,
    pub kept_items: u32,
    /// 预算提示（例如固定骨架本身就超限）。为空表示没有需要提示的事。
    pub budget_note: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub markdown: String,
}

/// 一次装配的解析结果：项目/任务范围 + 目标描述。
#[derive(Clone, Debug, Default)]
pub struct ContextScope {
    pub project_id: String,
    pub project_name: String,
    pub task_id: String,
    pub objective: String,
    pub objective_task: Option<Task>,
    pub keywords: Vec<String>,
}

/// 本次请求实际可用的资源类型（按能力与项目范围过滤后的结果）。
#[derive(Clone, Debug, Default)]
pub struct AuthorizedContextKinds {
    pub plan: bool,
    pub task: bool,
    pub knowledge: bool,
    pub decision: bool,
    pub skill: bool,
    pub handoff: bool,
}

impl AuthorizedContextKinds {
    pub fn any(&self) -> bool {
        self.plan || self.task || self.knowledge || self.decision || self.skill || self.handoff
    }

    pub fn allows(&self, kind: &str) -> bool {
        match kind {
            "plan" => self.plan,
            "task" => self.task,
            "knowledge" => self.knowledge,
            "decision" => self.decision,
            "skill" => self.skill,
            "handoff" => self.handoff,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContextFormat {
    Both,
    Markdown,
    CompactJson,
}

impl ContextFormat {
    fn parse(format: Option<&str>) -> AppResult<Self> {
        match format.unwrap_or("json") {
            "json" => Ok(Self::Both),
            "markdown" => Ok(Self::Markdown),
            "compact_json" => Ok(Self::CompactJson),
            _ => Err(AppError::Validation(
                "format 必须是 json、markdown 或 compact_json".into(),
            )),
        }
    }
}

fn canonical_kind(raw: &str) -> Option<&'static str> {
    Some(match raw {
        "plan" | "plans" => "plan",
        "task" | "tasks" => "task",
        "knowledge" => "knowledge",
        "decision" | "decisions" => "decision",
        "skill" | "skills" => "skill",
        "handoff" | "handoffs" => "handoff",
        _ => return None,
    })
}

fn capability_of_kind(kind: &str) -> Capability {
    match kind {
        "plan" => Capability::PlansRead,
        "task" => Capability::TasksRead,
        "knowledge" => Capability::KnowledgeRead,
        "decision" => Capability::DecisionsRead,
        "skill" => Capability::SkillsRead,
        _ => Capability::HandoffsRead,
    }
}

fn estimate_tokens(text: &str) -> u32 {
    // 按字符类型估算，区分 JSON 标点、ID 数字和中文。模型分词表各异，
    // 此值只用于控制本地输出预算。
    text.chars()
        .map(|ch| {
            if !ch.is_ascii() {
                10
            } else if ch.is_ascii_alphabetic() {
                3
            } else if ch.is_ascii_digit() {
                4
            } else if ch.is_ascii_whitespace() {
                2
            } else {
                7
            }
        })
        .sum::<u32>()
        .div_ceil(10)
}

/// 关键词：英文按词，中文按 2 字 shingle。
///
/// 只按空白切分会让整句中文变成一个「词」，`contains` 几乎永远不命中；
/// 双字切片在无分词器的前提下能覆盖大部分中文检索场景。
fn keywords(input: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "的", "了", "和", "与", "在", "是", "我", "你", "他", "请", "帮", "查看", "读取", "获取",
        "一下", "相关", "任务", "项目", "计划", "context", "the", "and", "for", "with",
    ];
    let mut out: Vec<String> = Vec::new();
    for token in input.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        let token = token.trim().to_lowercase();
        if token.is_empty() {
            continue;
        }
        let chars: Vec<char> = token.chars().collect();
        let cjk = chars.iter().filter(|c| is_cjk(**c)).count();
        if cjk * 2 >= chars.len() && chars.len() > 2 {
            // 中文长串：生成双字 shingle，并保留完整串用于精确加权。
            for pair in chars.windows(2) {
                let gram: String = pair.iter().collect();
                if !STOP.contains(&gram.as_str()) {
                    out.push(gram);
                }
            }
        } else if chars.len() >= 2 && !STOP.contains(&token.as_str()) {
            out.push(token);
        }
    }
    out.sort();
    out.dedup();
    out.truncate(12);
    out
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn score_text(text: &str, keyword: &str) -> i64 {
    let lower = text.to_lowercase();
    if keyword.is_empty() {
        return 0;
    }
    lower.matches(keyword).count().min(3) as i64 * 4
}

fn score_title(title: &str, keyword: &str) -> i64 {
    let lower = title.to_lowercase();
    if lower == keyword {
        40
    } else if lower.starts_with(keyword) {
        32
    } else if lower.contains(keyword) {
        25
    } else {
        0
    }
}

fn recency_score(updated_at: &str) -> i64 {
    // 7 天内 +8，30 天内 +4，更早 0。字符串为 RFC3339（UTC）。
    let now = chrono::Utc::now();
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(updated_at) else {
        return 0;
    };
    let days = (now - at.with_timezone(&chrono::Utc)).num_days();
    if days <= 7 {
        8
    } else if days <= 30 {
        4
    } else {
        0
    }
}

fn project_name(db: &Db, id: &str) -> AppResult<String> {
    if id.is_empty() {
        return Ok(String::new());
    }
    db.with_read(|conn| {
        let planning: Option<String> = conn
            .query_row(
                "SELECT name FROM planning_projects WHERE id=?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .ok();
        if let Some(name) = planning {
            return Ok(name);
        }
        let workspace: Option<String> = conn
            .query_row(
                "SELECT name FROM workspace_projects WHERE id=?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .ok();
        Ok(workspace.unwrap_or_default())
    })
}

fn link_for(kind: &str, id: &str) -> String {
    match kind {
        "task" => format!("taskdock task get {id}"),
        "knowledge" => format!("taskdock knowledge get {id}"),
        "decision" => format!("taskdock decision get {id}"),
        "handoff" => format!("taskdock agent handoff get {id}"),
        "plan" => format!("taskdock plan get {id}"),
        "skill" => "taskdock info --json（skills 资源见 manifest）".into(),
        _ => String::new(),
    }
}

// ── 1) 范围解析 ──────────────────────────────────────────────────

fn agent_row_id(principal: &Principal) -> Option<&str> {
    if principal.is_agent() {
        principal.agent_row_id.as_deref()
    } else {
        None
    }
}

/// 项目能否进入上下文：必须由**资源读能力**（projects/tasks/plans/knowledge/
/// decisions/handoffs）的授权范围覆盖该项目。
///
/// `ContextRead` 只是「能否装配上下文」的入口能力，**不是**项目访问依据：
/// 只持入口能力的 Agent 既不能通过显式项目参数进入项目，也不会在无项目参数时
/// 被默认分配到任何项目（否则会泄露项目名称与目标）。
fn project_read_scope_covers(reads: &perms::AuthorizedReads, project_id: &str) -> bool {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return false;
    }
    reads.projects.allows(project_id)
        || reads.tasks.allows(project_id)
        || reads.plans.allows(project_id)
        || reads.knowledge.allows(project_id)
        || reads.decisions.allows(project_id)
        || reads.handoffs.allows(project_id)
}

fn resolve_context_scope(
    db: &Db,
    principal: &Principal,
    req: &ContextRequest,
) -> AppResult<ContextScope> {
    let mut scope = ContextScope::default();
    // 一次请求只读一次授权范围：项目进入资格、项目元数据、规划目标共用同一份判定。
    let reads = perms::authorized_reads(db, principal)?;
    let explicit_project = req
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    scope.task_id = req.task_id.as_deref().unwrap_or_default().trim().to_string();
    let task_projects: Vec<String> = if scope.task_id.is_empty() {
        Vec::new()
    } else {
        db.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT project_id FROM workspace_task_links WHERE task_id = ?1
                 ORDER BY created_at DESC, project_id ASC",
            )?;
            let rows = stmt.query_map([&scope.task_id], |row| row.get(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })?
    };
    let exact_task_read = reads.tasks.allows(&scope.task_id);

    scope.project_id = match explicit_project {
        Some(project_id) => {
            let task_linked = task_projects.contains(&project_id);
            if !scope.task_id.is_empty() {
                if !(exact_task_read || task_linked && reads.tasks.allows(&project_id)) {
                    return Err(perms::denial(Capability::TasksRead));
                }
                if !task_linked {
                    return Err(AppError::Validation("任务未关联到指定项目".into()));
                }
            }
            let kind = db.with_read(|conn| perms::project_exists(conn, &project_id))?;
            if kind.is_none() {
                return Err(AppError::NotFound(format!("项目不存在: {project_id}")));
            }
            if !(task_linked && exact_task_read) && !project_read_scope_covers(&reads, &project_id) {
                return Err(AppError::Forbidden(format!(
                    "Agent 无权访问项目 {project_id}"
                )));
            }
            project_id
        }
        None if scope.task_id.is_empty() => resolve_default_project(db, &reads)?,
        None => match task_projects
            .into_iter()
            .find(|project| exact_task_read || reads.tasks.allows(project))
        {
            Some(project) => project,
            None if exact_task_read => String::new(),
            None => return Err(perms::denial(Capability::TasksRead)),
        }
    };
    // 项目元数据（名称）**只认 `projects.read`**：其它资源读能力可以进入项目上下文，
    // 但拿不到项目名称/目标；没有元数据授权时保持空串，绝不回退到全局信息。
    scope.project_name = if perms::can_read_project_metadata(db, principal, &scope.project_id)? {
        project_name(db, &scope.project_id)?
    } else {
        String::new()
    };

    // 目标：显式任务 > 自然语言 > 项目中进行中的功能 > 默认文案
    scope.objective = req.task.clone().unwrap_or_default();
    let mut objective_is_explicit = !scope.objective.trim().is_empty();
    if !scope.task_id.is_empty() {
        let task = crate::commands::tasks::get_task(db, &scope.task_id)?;
        scope.objective = format!("{}（{}，状态 {}）", task.title, task.id, task.status);
        scope.objective_task = Some(task);
        objective_is_explicit = true;
    }
    // 规划目标/功能属于 `plans.read` 的元数据：没有覆盖该项目的规划读取权限时
    // 不作为 objective 来源。
    if scope.objective.trim().is_empty()
        && !scope.project_id.is_empty()
        && reads.plans.allows(&scope.project_id)
    {
        let features = list_features_impl(db, scope.project_id.clone()).unwrap_or_default();
        if let Some(feature) = features.iter().find(|f| f.status == "in_progress") {
            scope.objective = format!("推进功能：{}", feature.title);
            objective_is_explicit = true;
        }
    }
    if scope.objective.trim().is_empty() {
        scope.objective = "了解当前项目状态并准备下一步工作".into();
    }
    // 关键词只来自**真实诉求**（自然语言描述 / 当前任务标题 / 在推进的功能）。
    // 默认套话不参与检索，否则会把「无诉求」的上下文过滤成空结果。
    scope.keywords = if objective_is_explicit {
        keywords(&scope.objective)
    } else {
        Vec::new()
    };
    Ok(scope)
}

/// 默认项目只从「有资源读授权的项目」中选择；只持 `ContextRead` 时返回空项目，
/// 不允许“入口能力全局 → 回退到第一个项目”。
fn resolve_default_project(db: &Db, reads: &perms::AuthorizedReads) -> AppResult<String> {
    let projects = crate::commands::planning::list_projects_impl(db, Some(false))?;
    let candidates: Vec<_> = projects
        .iter()
        .filter(|p| p.status == "in_progress")
        .chain(projects.iter())
        .collect();
    for project in candidates {
        if project_read_scope_covers(reads, &project.id) {
            return Ok(project.id.clone());
        }
    }
    Ok(String::new())
}

/// 该 Agent 持有的某项能力的全部 `resource_id`（空串代表全局授权）。
///
/// 只查**这一项能力**：入口能力（`ContextRead`）永远不会出现在结果里，
/// 因此「能装配上下文」永远不等于「能读任务 / 决策 / 知识」。
fn granted_resources(
    db: &Db,
    principal: &Principal,
    capability: Capability,
) -> AppResult<Vec<String>> {
    let Some(row_id) = agent_row_id(principal) else {
        // 本机用户 / 内部系统：按全局可用处理。
        return Ok(vec![String::new()]);
    };
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT resource_id FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND capability = ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![row_id, capability.as_str()], |r| {
            r.get::<_, String>(0)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// 某类资源在当前项目范围内是否可读。
///
/// 每类资源的 `resource_id` 语义不同，必须**分别**判定：
/// - `task`：全局授权 / 项目 ID / 该项目下任一任务 ID；
/// - `knowledge`：全局授权 / 项目 ID / 该项目下任一知识库 ID；
/// - `plan` / `decision` / `handoff`：全局授权或项目 ID；
/// - `skill`：只支持全局授权（`Capability::SkillsRead` 是 global_only）。
///
/// 三条硬约束：
/// 1. 无项目时，除经过单任务授权的显式目标外，只接受全局授权；
/// 2. `ContextRead` 不参与判定（入口能力 ≠ 资源读取能力）；
/// 3. 任务级授权必须落在「该项目下的任务集合」内，不能拿别的项目的任务凑数。
fn kind_authorized(
    db: &Db,
    principal: &Principal,
    kind: &str,
    scope: &ContextScope,
) -> AppResult<bool> {
    let capability = capability_of_kind(kind);
    let resources = granted_resources(db, principal, capability)?;
    if resources.iter().any(|r| r.trim().is_empty()) {
        return Ok(true);
    }
    let project_id = scope.project_id.trim();
    if project_id.is_empty() {
        return Ok(kind == "task" && scope.objective_task.is_some());
    }
    if resources.iter().any(|r| r == project_id) {
        return Ok(true);
    }
    match kind {
        "task" => {
            let task_ids = task_ids_for_project(db, project_id);
            Ok(resources.iter().any(|r| task_ids.contains(r)))
        }
        "knowledge" => {
            let kb_ids = knowledge_base_ids_for_project(db, project_id)?;
            Ok(resources.iter().any(|r| kb_ids.contains(r)))
        }
        _ => Ok(false),
    }
}

/// 任务级授权范围：`None` = 全局授权（项目内任务都可见）；`Some(set)` = 只允许这些任务。
///
/// 授权粒度落到具体任务：只有「全局授权」或「精确任务授权」才可能拿到任务，
/// 「项目级授权」等价于该项目下全部任务（仍然只限该项目）。
fn authorized_task_ids(
    db: &Db,
    principal: &Principal,
    scope: &ContextScope,
) -> AppResult<Option<HashSet<String>>> {
    let resources = granted_resources(db, principal, Capability::TasksRead)?;
    if resources.iter().any(|r| r.trim().is_empty()) {
        return Ok(None);
    }
    let project_id = scope.project_id.trim();
    if project_id.is_empty() {
        return Ok(Some(
            scope.objective_task.iter().map(|task| task.id.clone()).collect(),
        ));
    }
    let project_tasks = task_ids_for_project(db, project_id);
    let mut allowed = HashSet::new();
    for resource in resources {
        if resource == project_id {
            allowed.extend(project_tasks.iter().cloned());
        } else if project_tasks.contains(&resource) {
            allowed.insert(resource);
        }
    }
    Ok(Some(allowed))
}

/// 知识库级授权范围：`None` = 全局授权；`Some(set)` = 只允许这些知识库。
fn authorized_knowledge_base_ids(
    db: &Db,
    principal: &Principal,
    scope: &ContextScope,
) -> AppResult<Option<HashSet<String>>> {
    let resources = granted_resources(db, principal, Capability::KnowledgeRead)?;
    if resources.iter().any(|r| r.trim().is_empty()) {
        return Ok(None);
    }
    let project_id = scope.project_id.trim();
    if project_id.is_empty() {
        return Ok(Some(HashSet::new()));
    }
    let project_kbs = knowledge_base_ids_for_project(db, project_id)?;
    let mut allowed = HashSet::new();
    for resource in resources {
        if resource == project_id {
            allowed.extend(project_kbs.iter().cloned());
        } else if project_kbs.contains(&resource) {
            allowed.insert(resource);
        }
    }
    Ok(Some(allowed))
}

/// 2) 授权资源类型：显式请求未授权 → 明确报错；默认请求 → 只返回已授权部分。
fn resolve_authorized_kinds(
    db: &Db,
    principal: &Principal,
    req: &ContextRequest,
    scope: &ContextScope,
) -> AppResult<AuthorizedContextKinds> {
    let all = [
        "plan", "task", "knowledge", "decision", "skill", "handoff",
    ];
    let requested: Vec<&str> = if req.kinds.is_empty() {
        all.to_vec()
    } else {
        let mut out = Vec::new();
        for raw in &req.kinds {
            let kind = canonical_kind(raw)
                .ok_or_else(|| AppError::Validation(format!("未知上下文类型: {raw}")))?;
            if !out.contains(&kind) {
                out.push(kind);
            }
        }
        out
    };
    let mut authorized = AuthorizedContextKinds::default();
    for kind in requested {
        let capability = capability_of_kind(kind);
        // 每类资源用**各自**的读取能力判定：项目级授权不得代替其它资源的读取权限。
        let allowed = kind_authorized(db, principal, kind, scope)?;
        if !allowed && !req.kinds.is_empty() {
            return Err(perms::denial(capability));
        }
        match kind {
            "plan" => authorized.plan = allowed,
            "task" => authorized.task = allowed,
            "knowledge" => authorized.knowledge = allowed,
            "decision" => authorized.decision = allowed,
            "skill" => authorized.skill = allowed,
            "handoff" => authorized.handoff = allowed,
            _ => {}
        }
    }
    Ok(authorized)
}

// ── 3) 候选收集 ──────────────────────────────────────────────────

fn task_ids_for_project(db: &Db, project_id: &str) -> HashSet<String> {
    if project_id.is_empty() {
        return HashSet::new();
    }
    crate::commands::project_workspace::workspace_task_link_list_impl(db, project_id)
        .unwrap_or_default()
        .into_iter()
        .map(|link| link.task_id)
        .collect()
}

fn collect_plan(
    db: &Db,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    if scope.project_id.is_empty() {
        return Ok(());
    }
    let Ok(project) = db.with_read(|conn| load_project_tx(conn, &scope.project_id)) else {
        return Ok(());
    };
    let features = list_features_impl(db, scope.project_id.clone()).unwrap_or_default();
    let mut summary = format!(
        "{}：{} 个功能，{} 个进行中",
        project.name,
        features.len(),
        features.iter().filter(|f| f.status == "in_progress").count()
    );
    if let Some(target) = &project.target_date {
        summary.push_str(&format!("，目标日期 {target}"));
    }
    let mut relevance = 40;
    for k in &scope.keywords {
        relevance += score_title(&project.name, k);
    }
    items.push(ContextItem {
        kind: "plan".into(),
        source_id: project.id.clone(),
        title: project.name.clone(),
        summary,
        updated_at: project.updated_at.clone(),
        relevance,
        access: link_for("plan", &project.id),
        project_id: project.id.clone(),
        status: project.status.clone(),
    });
    for feature in features.iter().filter(|f| f.status != "completed").take(8) {
        let mut relevance = 10 + recency_score(&feature.updated_at);
        for k in &scope.keywords {
            relevance += score_title(&feature.title, k);
        }
        items.push(ContextItem {
            kind: "plan".into(),
            source_id: feature.id.clone(),
            title: feature.title.clone(),
            summary: format!(
                "功能状态 {}，优先级 {}，{}/{} 步骤完成",
                feature.status, feature.priority, feature.step_done, feature.step_total
            ),
            updated_at: feature.updated_at.clone(),
            relevance,
            access: "taskdock plan get --json".into(),
            project_id: scope.project_id.clone(),
            status: feature.status.clone(),
        });
    }
    Ok(())
}

fn collect_tasks(
    db: &Db,
    principal: &Principal,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    // 授权范围先算清楚：全局授权才允许看到项目内全部任务，
    // 任务级授权只允许被点名的那些任务。
    let allowed = authorized_task_ids(db, principal, scope)?;
    let filter = TaskFilter {
        status: Some("all".into()),
        limit: Some(200),
        ..Default::default()
    };
    let tasks = list_tasks_inner(db, filter)?;
    let linked = task_ids_for_project(db, &scope.project_id);
    let objective_id = scope.objective_task.as_ref().map(|t| t.id.clone());
    let mut candidates: Vec<(Task, i64)> = Vec::new();
    // 显式目标已单独读取，不受全局候选列表的 200 条上限影响。
    let tasks = tasks
        .into_iter()
        .filter(|task| objective_id.as_deref() != Some(task.id.as_str()));
    for task in scope.objective_task.iter().cloned().chain(tasks) {
        let is_objective = objective_id.as_deref() == Some(task.id.as_str());
        // 项目隔离：只保留与该项目弱关联的任务（当前任务除外）。
        if !scope.project_id.is_empty() && !linked.contains(&task.id) && !is_objective {
            continue;
        }
        // 授权收窄：任务级授权只放行被点名的任务。
        if let Some(set) = &allowed {
            if !set.contains(&task.id) {
                continue;
            }
        }
        // 关键词命中：中文按双字切片打分（`keywords()` 已切好），避免单个
        // SQL LIKE 关键词漏召回；没有诉求时退回「未完成任务」这一稳定视图。
        let mut keyword_hit = 0i64;
        for k in &scope.keywords {
            keyword_hit += score_title(&task.title, k) + score_text(&task.description, k);
        }
        if !is_objective {
            if scope.keywords.is_empty() {
                if task.status != "pending" {
                    continue;
                }
            } else if keyword_hit == 0 {
                continue;
            }
        }
        let mut relevance = 10 + recency_score(&task.updated_at) + keyword_hit;
        if task.status == "pending" {
            relevance += 10;
        }
        if is_objective {
            relevance += 40;
        }
        candidates.push((task, relevance));
    }
    candidates.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(b.0.updated_at.cmp(&a.0.updated_at))
            .then(a.0.id.cmp(&b.0.id))
    });
    for (task, relevance) in candidates.into_iter().take(24) {
        items.push(ContextItem {
            kind: "task".into(),
            source_id: task.id.clone(),
            title: task.title.clone(),
            summary: describe_task(&task),
            updated_at: task.updated_at.clone(),
            relevance,
            access: link_for("task", &task.id),
            project_id: scope.project_id.clone(),
            status: task.status.clone(),
        });
    }
    Ok(())
}

fn collect_knowledge(
    db: &Db,
    principal: &Principal,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    let allowed_kbs = authorized_knowledge_base_ids(db, principal, scope)?;
    // 关键词检索接口要求全局 KnowledgeRead；项目级授权只走项目知识库列表。
    let can_search = granted_resources(db, principal, Capability::KnowledgeRead)?
        .iter()
        .any(|r| r.trim().is_empty());
    if can_search && !scope.keywords.is_empty() {
        let kb_projects = knowledge_base_projects(db)?;
        // 逐个关键词检索：中文按双字切片切开后拼成一句话是匹配不到正文的，
        // 必须一个一个试（重复命中由后面的去重统一处理）。
        for keyword in scope.keywords.iter().take(4) {
            let (hits, _) = service::search_knowledge(db, principal, keyword, &[], 8, 0)?;
            for hit in hits {
                // 项目隔离：检索可能命中其它项目的知识库，必须按知识库真实归属过滤。
                if !scope.project_id.is_empty()
                    && kb_projects.get(&hit.kb_id).map(|p| p.as_str())
                        != Some(scope.project_id.as_str())
                {
                    continue;
                }
                if let Some(set) = &allowed_kbs {
                    if !set.contains(&hit.kb_id) {
                        continue;
                    }
                }
                items.push(ContextItem {
                    kind: "knowledge".into(),
                    source_id: hit.doc_id.clone(),
                    title: hit.title.clone(),
                    summary: hit.snippet.clone(),
                    updated_at: hit.updated_at.clone(),
                    relevance: 30 - hit.rank as i64 * 5 + recency_score(&hit.updated_at),
                    access: link_for("knowledge", &hit.doc_id),
                    project_id: scope.project_id.clone(),
                    status: "indexed".into(),
                });
            }
        }
    }
    if !scope.project_id.is_empty() {
        for (id, kb_id, title, updated_at) in knowledge_docs_for_project(db, &scope.project_id)? {
            if let Some(set) = &allowed_kbs {
                if !set.contains(&kb_id) {
                    continue;
                }
            }
            items.push(ContextItem {
                kind: "knowledge".into(),
                source_id: id.clone(),
                title,
                summary: "项目知识库文档（只读摘要）".into(),
                updated_at: updated_at.clone(),
                relevance: 18 + recency_score(&updated_at),
                access: link_for("knowledge", &id),
                project_id: scope.project_id.clone(),
                status: "indexed".into(),
            });
        }
    }
    Ok(())
}

/// 知识库 ID → 归属项目（`knowledge_bases.project_id`）。
fn knowledge_base_projects(db: &Db) -> AppResult<HashMap<String, String>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT id, COALESCE(project_id, '') FROM knowledge_bases")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = HashMap::new();
        for row in rows {
            let (id, project_id) = row?;
            out.insert(id, project_id);
        }
        Ok(out)
    })
}

/// 项目下的知识库 ID 集合。
fn knowledge_base_ids_for_project(db: &Db, project_id: &str) -> AppResult<HashSet<String>> {
    if project_id.is_empty() {
        return Ok(HashSet::new());
    }
    db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM knowledge_bases WHERE project_id = ?1")?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| r.get::<_, String>(0))?;
        let mut out = HashSet::new();
        for row in rows {
            out.insert(row?);
        }
        Ok(out)
    })
}

/// 项目知识库下的文档（含知识库 ID，便于按授权范围二次过滤）。
fn knowledge_docs_for_project(
    db: &Db,
    project_id: &str,
) -> AppResult<Vec<(String, String, String, String)>> {
    if project_id.is_empty() {
        return Ok(Vec::new());
    }
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT d.id, d.kb_id, d.title, d.updated_at FROM knowledge_documents d
             JOIN knowledge_bases b ON b.id = d.kb_id
             WHERE b.project_id = ?1 ORDER BY d.updated_at DESC LIMIT 8",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

fn collect_decisions(
    db: &Db,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    // 项目隔离：只取本项目的决策；无项目时只取「无项目归属」的全局决策，
    // 绝不从其它项目回退到全局数据。
    let (decisions, _) = store::list_decisions(db, Some(scope.project_id.as_str()), None, 20, 0)?;
    for decision in decisions {
        let mut relevance = 8 + recency_score(&decision.updated_at);
        for k in &scope.keywords {
            relevance += score_title(&decision.title, k) + score_text(&decision.decision, k);
        }
        if decision.status == "accepted" {
            relevance += 6;
        }
        items.push(ContextItem {
            kind: "decision".into(),
            source_id: decision.id.clone(),
            title: decision.title.clone(),
            summary: format!("[{}] {}", decision.status, decision.decision),
            updated_at: decision.updated_at.clone(),
            relevance,
            access: link_for("decision", &decision.id),
            project_id: decision.project_id.clone(),
            status: decision.status.clone(),
        });
    }
    Ok(())
}

fn collect_skills(
    db: &Db,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    let query = scope.keywords.first().map(String::as_str);
    let found = skills::list_impl(db, query, None, None, None)?;
    for skill in found.into_iter().filter(|s| s.enabled && !s.missing).take(5) {
        let mut relevance = 6;
        for k in &scope.keywords {
            relevance += score_title(&skill.name, k) + score_text(&skill.description, k);
        }
        items.push(ContextItem {
            kind: "skill".into(),
            source_id: skill.id.clone(),
            title: skill.name.clone(),
            summary: skill.description.clone(),
            updated_at: skill.updated_at.clone(),
            relevance,
            access: link_for("skill", &skill.id),
            project_id: scope.project_id.clone(),
            status: if skill.enabled { "enabled" } else { "disabled" }.into(),
        });
    }
    Ok(())
}

fn collect_handoffs(
    db: &Db,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    // 项目隔离：只取本项目的交接（无项目时只取无项目归属的交接）。
    let (handoffs, _) = store::list_handoffs(db, None, Some(scope.project_id.as_str()), 20, 0)?;
    for handoff in handoffs {
        if !matches!(handoff.status.as_str(), "pending" | "accepted") {
            continue;
        }
        let relevance = 8 + if handoff.status == "pending" { 8 } else { 0 };
        items.push(ContextItem {
            kind: "handoff".into(),
            source_id: handoff.id.clone(),
            title: format!(
                "{} → {}（{}）",
                handoff.from_agent_id, handoff.to_agent_id, handoff.status
            ),
            summary: handoff.summary.clone(),
            updated_at: handoff.updated_at.clone(),
            relevance,
            access: link_for("handoff", &handoff.id),
            project_id: handoff.project_id.clone(),
            status: handoff.status.clone(),
        });
    }
    Ok(())
}

fn collect_context_candidates(
    db: &Db,
    principal: &Principal,
    scope: &ContextScope,
    authorized: &AuthorizedContextKinds,
) -> AppResult<Vec<ContextItem>> {
    let mut items = Vec::new();
    if authorized.plan {
        collect_plan(db, scope, &mut items)?;
    }
    if authorized.task {
        collect_tasks(db, principal, scope, &mut items)?;
    }
    if authorized.knowledge {
        collect_knowledge(db, principal, scope, &mut items)?;
    }
    if authorized.decision {
        collect_decisions(db, scope, &mut items)?;
    }
    if authorized.skill {
        collect_skills(db, scope, &mut items)?;
    }
    if authorized.handoff {
        collect_handoffs(db, scope, &mut items)?;
    }
    Ok(items)
}

/// 权限兜底：即使某个 collector 忘了过滤，也不会把未授权类型带出去。
fn filter_context_by_permission(
    items: Vec<ContextItem>,
    authorized: &AuthorizedContextKinds,
) -> Vec<ContextItem> {
    items
        .into_iter()
        .filter(|item| authorized.allows(&item.kind))
        .collect()
}

fn rank_context_candidates(items: &mut [ContextItem]) {
    items.sort_by(|a, b| {
        b.relevance
            .cmp(&a.relevance)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.source_id.cmp(&b.source_id))
    });
}

/// 去重：同一资源（`source_id`）在结果里**最多出现一次**，跨 kind 也不重复。
///
/// 同一份资源可能同时来自检索与项目列表（例如知识文档），也可能被不同收集器
/// 以不同 kind 收集；只要 `source_id` 相同就只保留一条（调用前先按相关性排序，
/// 因此留下的是相关性最高的那条）。
fn deduplicate_context_candidates(items: &mut Vec<ContextItem>) {
    let mut seen: HashSet<String> = HashSet::new();
    items.retain(|item| seen.insert(item.source_id.clone()));
}

/// 估算最终表示，双份输出中的重复内容也占预算。为传输信封留余量。
fn output_cost(ctx: &mut AgentContext, format: ContextFormat) -> AppResult<u32> {
    if format != ContextFormat::CompactJson {
        ctx.markdown = render_markdown(ctx);
    }
    let cost = match format {
        ContextFormat::Both => estimate_tokens(&serde_json::to_string_pretty(ctx)?),
        ContextFormat::Markdown => estimate_tokens(&ctx.markdown),
        ContextFormat::CompactJson => estimate_tokens(&serde_json::to_string(ctx)?),
    };
    Ok(cost + 64)
}

/// 按重要程度分组（组内按相关性降序；**组序即保留优先级**）。
///
/// 保留优先级：项目目标（骨架） → 约束（骨架） → 已确认决策 → 当前任务 / 项目概览
/// → 近期变更 → 其余条目。预算不足时从最低档开始丢。
fn partition_by_priority(
    items: Vec<ContextItem>,
    scope: &ContextScope,
    recent: Vec<ContextItem>,
) -> Vec<Vec<ContextItem>> {
    let mut decisions: Vec<ContextItem> = Vec::new();
    let mut focus: Vec<ContextItem> = Vec::new();
    let mut rest: Vec<ContextItem> = Vec::new();
    for item in items {
        let is_current_task = !scope.task_id.is_empty() && item.source_id == scope.task_id;
        let is_plan_summary = !scope.project_id.is_empty()
            && item.kind == "plan"
            && item.source_id == scope.project_id;
        if item.kind == "decision" && item.status == "accepted" {
            decisions.push(item);
        } else if is_current_task || is_plan_summary {
            focus.push(item);
        } else {
            rest.push(item);
        }
    }
    vec![decisions, focus, recent, rest]
}

/// 固定内容先占预算，再按优先级填充有上限的候选。装不下时保留当前前缀。
fn fit_context(
    ctx: &mut AgentContext,
    format: ContextFormat,
    groups: Vec<Vec<ContextItem>>,
) -> AppResult<()> {
    // 估算时预留截断提示和预算数字的空间。
    ctx.estimated_tokens = ctx.budget_tokens;
    ctx.truncated = true;
    let mut cost = output_cost(ctx, format)?;
    if cost > ctx.budget_tokens {
        return Err(AppError::Validation(
            "上下文固定内容超出预算，请提高预算或缩小请求范围".into(),
        ));
    }
    let mut truncated = false;
    'groups: for (index, group) in groups.into_iter().enumerate() {
        for item in group {
            let target = if index == 2 { &mut ctx.recent_changes } else { &mut ctx.items };
            target.push(item);
            ctx.kept_items = ctx.items.len() as u32;
            let next = output_cost(ctx, format)?;
            if next > ctx.budget_tokens {
                let target = if index == 2 { &mut ctx.recent_changes } else { &mut ctx.items };
                target.pop();
                ctx.kept_items = ctx.items.len() as u32;
                truncated = true;
                break 'groups;
            }
            cost = next;
        }
    }
    ctx.estimated_tokens = cost;
    ctx.truncated = truncated;
    if format != ContextFormat::CompactJson {
        ctx.markdown = render_markdown(ctx);
    }
    Ok(())
}

fn describe_task(task: &Task) -> String {
    let mut parts = Vec::new();
    if !task.description.trim().is_empty() {
        parts.push(task.description.trim().replace('\n', " "));
    }
    parts.push(format!("优先级 {}", task.priority));
    if let Some(due) = &task.due_at {
        parts.push(format!("截止 {due}"));
    }
    if !task.category.is_empty() {
        parts.push(format!("分类 {}", task.category));
    }
    parts.join(" · ")
}

/// 资源归属索引：把 revision 里的资源 ID 映射到**真实业务归属项目**。
///
/// 绝不拿「资源 ID == 项目 ID」这种字符串相等当归属：任务 ID 永远不会等于项目 ID。
#[derive(Default)]
struct ResourceOwners {
    /// 任务 → 项目集合（一个任务可挂多个项目）。
    tasks: HashMap<String, HashSet<String>>,
    /// 知识文档 → 项目（经 `knowledge_documents.kb_id` → `knowledge_bases.project_id`）。
    knowledge: HashMap<String, String>,
    /// 决策 → 项目（`agent_decisions.project_id`）。
    decisions: HashMap<String, String>,
    /// 交接 → 项目（`agent_handoffs.project_id`）。
    handoffs: HashMap<String, String>,
    /// 报告 → 项目（`agent_work_reports.project_id`，缺失时回退到所属交接的项目）。
    reports: HashMap<String, String>,
    /// 规划功能 → 项目（`planning_features.project_id`）。
    features: HashMap<String, String>,
}

impl ResourceOwners {
    /// 资源归属的项目集合（空串已剔除；空集合表示「无项目归属」）。
    fn projects_of(&self, kind: &str, id: &str) -> Vec<String> {
        let raw: Vec<String> = match kind {
            "task" => self
                .tasks
                .get(id)
                .map(|set| set.iter().cloned().collect())
                .unwrap_or_default(),
            "knowledge" => self.knowledge.get(id).cloned().into_iter().collect(),
            "decision" => self.decisions.get(id).cloned().into_iter().collect(),
            "handoff" => self.handoffs.get(id).cloned().into_iter().collect(),
            "report" => self.reports.get(id).cloned().into_iter().collect(),
            "feature" => self.features.get(id).cloned().into_iter().collect(),
            // 规划项目自身：资源 ID 就是项目 ID（这是唯一合法的「相等」场景）。
            "plan" | "project" => vec![id.to_string()],
            _ => Vec::new(),
        };
        raw.into_iter()
            .filter(|p| !p.trim().is_empty())
            .collect::<Vec<String>>()
    }
}

/// 读取真实业务关联索引。
fn load_resource_owners(db: &Db) -> AppResult<ResourceOwners> {
    db.with_read(|conn| {
        let mut owners = ResourceOwners::default();

        let mut stmt = conn.prepare("SELECT task_id, project_id FROM workspace_task_links")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (task_id, project_id) = row?;
            owners.tasks.entry(task_id).or_default().insert(project_id);
        }

        let mut stmt = conn.prepare(
            "SELECT d.id, COALESCE(b.project_id, '') FROM knowledge_documents d
             JOIN knowledge_bases b ON b.id = d.kb_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (doc_id, project_id) = row?;
            owners.knowledge.insert(doc_id, project_id);
        }

        let mut stmt = conn.prepare("SELECT id, project_id FROM agent_decisions")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, project_id) = row?;
            owners.decisions.insert(id, project_id);
        }

        let mut stmt = conn.prepare("SELECT id, project_id FROM agent_handoffs")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, project_id) = row?;
            owners.handoffs.insert(id, project_id);
        }

        // 报告：优先用自身项目；没有就回退到所属交接的项目（报告与交接是两种 ID）。
        let mut stmt = conn.prepare(
            "SELECT r.id, COALESCE(NULLIF(r.project_id, ''), COALESCE(h.project_id, ''))
             FROM agent_work_reports r
             LEFT JOIN agent_handoffs h ON h.id = r.handoff_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, project_id) = row?;
            owners.reports.insert(id, project_id);
        }

        let mut stmt = conn.prepare("SELECT id, project_id FROM planning_features")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, project_id) = row?;
            owners.features.insert(id, project_id);
        }

        Ok(owners)
    })
}

/// revision 资源类型 → 需要的读取能力（与 `AuthorizedContextKinds` 对齐）。
fn recent_kind_authorized(kind: &str, authorized: &AuthorizedContextKinds) -> bool {
    match kind {
        "task" => authorized.task,
        "knowledge" => authorized.knowledge,
        "decision" => authorized.decision,
        "handoff" | "report" => authorized.handoff,
        "plan" | "feature" | "project" => authorized.plan,
        "skill" => authorized.skill,
        // 未知资源类型一律拒绝（fail-closed），不做「猜一种归属」的事。
        _ => false,
    }
}

/// 近期变更候选：按真实业务关联判定归属，并受资源权限约束。
///
/// 归属规则：
/// - 任务 → `workspace_task_links`；
/// - 知识 → `knowledge_documents.kb_id` → `knowledge_bases.project_id`；
/// - 决策 → `agent_decisions.project_id`；
/// - 交接 → `agent_handoffs.project_id`；
/// - 报告 → `agent_work_reports.project_id`，缺失时取所属交接的项目。
///
/// 项目隔离：有项目时只返回本项目的变更；无项目时只返回「无项目归属」的变更，
/// 绝不跨项目拼装。
fn collect_recent_changes(
    db: &Db,
    principal: &Principal,
    scope: &ContextScope,
    authorized: &AuthorizedContextKinds,
    take: usize,
) -> AppResult<Vec<ContextItem>> {
    let rows: Vec<(String, String, i64, String, String, String)> = db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT resource_kind, resource_id, revision, updated_at, updated_by, source
             FROM agent_resource_revisions
             ORDER BY updated_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })?;

    let owners = load_resource_owners(db)?;
    let allowed_tasks = authorized_task_ids(db, principal, scope)?;
    let mut out: Vec<ContextItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (kind, id, revision, updated_at, updated_by, source) in rows {
        if !recent_kind_authorized(&kind, authorized) {
            continue;
        }
        let owner_projects = owners.projects_of(&kind, &id);
        if scope.project_id.is_empty() {
            // 无项目上下文：只返回无项目归属的变更。
            if !owner_projects.is_empty() {
                continue;
            }
        } else if !owner_projects.iter().any(|p| p == &scope.project_id) {
            continue;
        }
        if kind == "task" {
            if let Some(set) = &allowed_tasks {
                if !set.contains(&id) {
                    continue;
                }
            }
        }
        if !seen.insert(format!("{kind}:{id}")) {
            continue;
        }
        out.push(ContextItem {
            kind: kind.clone(),
            source_id: id.clone(),
            title: format!("{kind} {id} → r{revision}"),
            summary: format!("由 {updated_by} 经 {source} 更新 · 近期变更"),
            updated_at,
            relevance: 0,
            access: link_for(&kind, &id),
            project_id: scope.project_id.clone(),
            status: "changed".into(),
        });
        if out.len() >= take {
            break;
        }
    }
    Ok(out)
}

// ── 5) 装配 ──────────────────────────────────────────────────────

/// 装配结果里的 `scope` 元数据（JSON 与 Markdown 共用同一份）。
fn scope_value(
    scope: &ContextScope,
    req: &ContextRequest,
    authorized: &AuthorizedContextKinds,
) -> Value {
    json!({
        "project_id": if scope.project_id.is_empty() { Value::Null } else { json!(scope.project_id) },
        "task_id": if scope.task_id.is_empty() { Value::Null } else { json!(scope.task_id) },
        "keywords": scope.keywords,
        "kinds": req.kinds,
        "authorized_kinds": {
            "plan": authorized.plan,
            "task": authorized.task,
            "knowledge": authorized.knowledge,
            "decision": authorized.decision,
            "skill": authorized.skill,
            "handoff": authorized.handoff,
        },
        "agent_id": req.agent_id,
        "session_id": req.session_id,
    })
}

pub fn build(db: &Db, principal: &Principal, req: ContextRequest) -> AppResult<AgentContext> {
    perms::require(db, principal, Capability::ContextRead, "")?;
    let format = ContextFormat::parse(req.format.as_deref())?;
    let budget_total = req
        .budget_tokens
        .unwrap_or(DEFAULT_BUDGET)
        .clamp(1000, MAX_BUDGET);
    let scope = resolve_context_scope(db, principal, &req)?;
    let authorized = resolve_authorized_kinds(db, principal, &req, &scope)?;

    let mut items = collect_context_candidates(db, principal, &scope, &authorized)?;
    items = filter_context_by_permission(items, &authorized);
    // 先排序再去重：同一资源重复出现时保留相关性最高的那条。
    rank_context_candidates(&mut items);
    deduplicate_context_candidates(&mut items);

    // 约束与下一步属于「固定骨架」：它们必须先占预算，不能在预算之外追加。
    let mut constraints = vec![
        "外部写入必须携带 base_revision，版本不一致返回冲突而不是覆盖。".to_string(),
        "不得直接修改 SQLite 数据库文件；所有写入经统一服务层。".to_string(),
        "不得把推测内容当作已确认事实写入知识或决策。".to_string(),
        "删除能力未开放；批量操作需要额外授权。".to_string(),
    ];
    let mut next_steps: Vec<String> = Vec::new();
    let status = if scope.project_id.is_empty() {
        None
    } else {
        service::project_status(db, principal, &scope.project_id).ok()
    };
    if let Some(status) = &status {
        next_steps = status.next_steps.clone();
        if status.status == "blocked" {
            constraints.push("项目状态为 blocked，先解除阻塞再推进。".into());
        }
    }
    if next_steps.is_empty() {
        next_steps.push("读取当前计划中未完成功能，选择最小可交付步骤。".into());
    }

    // 近期变更：受权限与项目归属约束的**候选**，最终是否保留由预算决定。
    let recent_candidates = collect_recent_changes(db, principal, &scope, &authorized, 10)?;

    let mut ctx = AgentContext {
        project_id: scope.project_id.clone(),
        project_name: scope.project_name.clone(),
        objective: scope.objective.clone(),
        scope: scope_value(&scope, &req, &authorized),
        items: Vec::new(),
        constraints,
        next_steps,
        recent_changes: Vec::new(),
        budget_tokens: budget_total,
        estimated_tokens: 0,
        truncated: false,
        kept_items: 0,
        budget_note: String::new(),
        markdown: String::new(),
    };
    let groups = partition_by_priority(items, &scope, recent_candidates);
    fit_context(&mut ctx, format, groups)?;
    let access = store::ContextAccess {
        principal,
        purpose: req.task.as_deref().unwrap_or("context.get"),
        project_id: &ctx.project_id,
        task_id: &scope.task_id,
        format: req.format.as_deref().unwrap_or("json"),
        budget_tokens: budget_total,
        item_count: ctx.items.len() as u32,
        estimated_tokens: ctx.estimated_tokens,
        request_id: "",
    };
    let _ = db.with_conn(|conn| store::record_context_access(conn, &access));
    Ok(ctx)
}

/// Markdown 结构固定：Agent 可直接当工作简报读取，无需自己拼装。
pub fn render_markdown(ctx: &AgentContext) -> String {
    let mut out = String::new();
    out.push_str("# TaskDock Agent Context\n\n");
    out.push_str("## Project\n\n");
    if ctx.project_id.is_empty() {
        out.push_str("未指定项目（全局上下文）。\n\n");
    } else if ctx.project_name.trim().is_empty() {
        // 无项目元数据读取权限：只给 ID，不显示名称。
        out.push_str(&format!("- `{}`\n\n", ctx.project_id));
    } else {
        out.push_str(&format!(
            "- {} (`{}`)\n\n",
            ctx.project_name, ctx.project_id
        ));
    }
    out.push_str("## Current Objective\n\n");
    out.push_str(&format!("{}\n\n", ctx.objective));
    for (section, kind) in [
        ("Relevant Tasks", "task"),
        ("Current Plan", "plan"),
        ("Decisions", "decision"),
        ("Knowledge", "knowledge"),
        ("Skills", "skill"),
        ("Active Work", "handoff"),
    ] {
        let items: Vec<&ContextItem> = ctx.items.iter().filter(|i| i.kind == kind).collect();
        if items.is_empty() {
            continue;
        }
        out.push_str(&format!("## {section}\n\n"));
        for item in items {
            out.push_str(&format!(
                "- **{}** — {} （来源 `{}`，更新 {}，相关性 {}，访问：{}）\n",
                item.title, item.summary, item.source_id, item.updated_at, item.relevance, item.access
            ));
        }
        out.push('\n');
    }
    if !ctx.constraints.is_empty() {
        out.push_str("## Constraints\n\n");
        for c in &ctx.constraints {
            out.push_str(&format!("- {c}\n"));
        }
        out.push('\n');
    }
    if !ctx.recent_changes.is_empty() {
        out.push_str("## Recent Changes\n\n");
        for item in &ctx.recent_changes {
            out.push_str(&format!(
                "- {} — {}（{}）\n",
                item.title, item.summary, item.updated_at
            ));
        }
        out.push('\n');
    }
    if !ctx.next_steps.is_empty() {
        out.push_str("## Suggested Next Steps\n\n");
        for step in &ctx.next_steps {
            out.push_str(&format!("- {step}\n"));
        }
        out.push('\n');
    }
    if !ctx.budget_note.is_empty() {
        out.push_str(&format!("> 预算提示：{}\n\n", ctx.budget_note));
    }
    out.push_str(&format!(
        "_预算 {} tokens，估算使用 {} tokens，条目 {} 条{}。_\n",
        ctx.budget_tokens,
        ctx.estimated_tokens,
        ctx.kept_items,
        if ctx.truncated { "，已按预算截断" } else { "" }
    ));
    out
}

/// 序列化上下文。紧凑 JSON 模式不生成 Markdown，因此也不带该字段。
pub fn to_json(ctx: &AgentContext) -> AppResult<Value> {
    Ok(serde_json::to_value(ctx)?)
}

pub fn response(ctx: &AgentContext, format: Option<&str>) -> AppResult<Value> {
    if format == Some("markdown") {
        Ok(json!({ "markdown": ctx.markdown }))
    } else {
        to_json(ctx)
    }
}

/// 近期活动上下文 (`get_recent_context`)。
///
/// 活动记录是跨项目的元数据：必须经 `service::list_activity_authorized` 在服务端
/// 按授权范围过滤；没有可读资源时返回 FORBIDDEN，而不是静默返回空列表。
pub fn recent(db: &Db, principal: &Principal, limit: u32) -> AppResult<Vec<ContextItem>> {
    perms::require_any_read(db, principal)?;
    let (events, _) = handoff_activity(db, principal, limit)?;
    Ok(events)
}

fn handoff_activity(
    db: &Db,
    principal: &Principal,
    limit: u32,
) -> AppResult<(Vec<ContextItem>, super::Page)> {
    let (records, page) = service::list_activity_authorized(
        db,
        principal,
        &store::ActivityQuery {
            agent_id: None,
            interface: None,
            since: None,
            limit,
            offset: 0,
        },
    )?;
    let items = records
        .into_iter()
        .map(|r| ContextItem {
            kind: "activity".into(),
            source_id: r.id.clone(),
            title: format!("{} {}", r.action, r.resource_kind),
            summary: format!(
                "{}（{}，{}，{}）",
                r.detail,
                r.agent_id,
                r.interface,
                if r.success { "成功" } else { r.error_code.as_str() }
            ),
            updated_at: r.created_at,
            relevance: 0,
            access: "taskdock status --json".into(),
            project_id: r.project_id,
            status: if r.success { "ok".into() } else { "failed".into() },
        })
        .collect();
    Ok((items, page))
}

/// 供测试与诊断使用：把内部关键词/评分暴露为纯函数结果。
pub fn debug_keywords(input: &str) -> Vec<String> {
    keywords(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_keywords_use_bigrams() {
        let words = debug_keywords("修复文件导入权限边界");
        assert!(words.iter().any(|w| w == "文件"), "缺少双字切片: {words:?}");
        assert!(words.iter().any(|w| w == "导入"));
        assert!(!words.iter().any(|w| w == "修复文件导入权限边界"));
    }

    #[test]
    fn english_keywords_split_on_space() {
        let words = debug_keywords("agent handoff permission");
        assert!(words.contains(&"agent".to_string()));
        assert!(words.contains(&"handoff".to_string()));
    }

    #[test]
    fn budget_marks_truncated_when_items_exceed_limit() {
        let items: Vec<ContextItem> = (0..50)
            .map(|i| ContextItem {
                kind: "task".into(),
                source_id: format!("t{i}"),
                title: "标题".repeat(20),
                summary: "摘要".repeat(50),
                updated_at: "2026-01-01T00:00:00Z".into(),
                relevance: 10,
                access: String::new(),
                project_id: String::new(),
                status: "pending".into(),
            })
            .collect();
        let mut ctx = budget_fixture();
        ctx.budget_tokens = 1000;
        fit_context(&mut ctx, ContextFormat::Both, vec![items]).unwrap();
        assert!(ctx.truncated);
        assert!(ctx.estimated_tokens <= 1000);
        assert!(ctx.items.len() < 50);
    }

    fn budget_fixture() -> AgentContext {
        AgentContext {
            project_id: "p1".into(),
            project_name: "项目一".into(),
            objective: "修复导入边界".into(),
            scope: json!({"keywords": ["导入"]}),
            items: Vec::new(),
            constraints: vec!["约束一：不得直接改库。".into(), "约束二：必须带版本。".into()],
            next_steps: vec!["下一步：补测试。".into()],
            recent_changes: Vec::new(),
            budget_tokens: 6000,
            estimated_tokens: 0,
            truncated: false,
            kept_items: 0,
            budget_note: String::new(),
            markdown: String::new(),
        }
    }

    #[test]
    fn output_budget_counts_duplicate_formats_and_skips_markdown_in_compact_json() {
        let mut both = budget_fixture();
        let mut compact = both.clone();
        fit_context(&mut both, ContextFormat::Both, vec![]).unwrap();
        fit_context(&mut compact, ContextFormat::CompactJson, vec![]).unwrap();
        assert!(both.markdown.contains("修复导入边界"));
        assert!(to_json(&compact).unwrap().get("markdown").is_none());
        assert_eq!(to_json(&compact).unwrap()["objective"], "修复导入边界");
        assert!(both.estimated_tokens > compact.estimated_tokens);

        compact.budget_tokens = 1000;
        compact.next_steps.push("固定步骤".repeat(500));
        assert!(matches!(
            fit_context(&mut compact, ContextFormat::CompactJson, vec![]),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn permission_filter_drops_unauthorized_kinds() {
        let items = vec![ContextItem {
            kind: "knowledge".into(),
            source_id: "k1".into(),
            title: "t".into(),
            summary: "s".into(),
            updated_at: String::new(),
            relevance: 1,
            access: String::new(),
            project_id: String::new(),
            status: String::new(),
        }];
        let authorized = AuthorizedContextKinds {
            task: true,
            ..Default::default()
        };
        assert!(filter_context_by_permission(items, &authorized).is_empty());
    }
}
