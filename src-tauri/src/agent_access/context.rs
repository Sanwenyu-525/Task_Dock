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

/// token 预算执行结果。
#[derive(Clone, Debug)]
pub struct ContextBudget {
    pub total: u32,
    pub used: u32,
    pub truncated: bool,
    pub kept_items: u32,
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
    // 中文按「约 2 字符 / token」粗估；只用于预算控制，不做精确计费。
    ((text.chars().count() as u32) / 2).max(1)
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

/// Agent 是否可访问某项目：任一读能力在全局或该项目上有授权。
fn can_access_project(db: &Db, principal: &Principal, project_id: &str) -> AppResult<bool> {
    let Some(row_id) = agent_row_id(principal) else {
        return Ok(true);
    };
    db.with_read(|conn| {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND (resource_id = '' OR resource_id = ?2)
               AND capability IN ('projects.read','tasks.read','plans.read','knowledge.read',
                                  'decisions.read','handoffs.read','context.read')",
            rusqlite::params![row_id, project_id],
            |r| r.get(0),
        )?;
        Ok(exists > 0)
    })
}

fn resolve_context_scope(
    db: &Db,
    principal: &Principal,
    req: &ContextRequest,
) -> AppResult<ContextScope> {
    let mut scope = ContextScope::default();
    let explicit_project = req
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    scope.task_id = req.task_id.clone().unwrap_or_default();

    scope.project_id = match explicit_project {
        Some(project_id) => {
            let kind = db.with_read(|conn| perms::project_exists(conn, &project_id))?;
            if kind.is_none() {
                return Err(AppError::NotFound(format!("项目不存在: {project_id}")));
            }
            if !can_access_project(db, principal, &project_id)? {
                return Err(AppError::Forbidden(format!(
                    "Agent 无权访问项目 {project_id}"
                )));
            }
            project_id
        }
        None => {
            // 任务所属项目优先于“当前进行中项目”，避免跨项目拼装上下文。
            let from_task = if scope.task_id.is_empty() {
                None
            } else {
                db.with_read(|conn| perms::task_project(conn, &scope.task_id))?
            };
            match from_task {
                Some(project_id) => {
                    if !can_access_project(db, principal, &project_id)? {
                        return Err(AppError::Forbidden(format!(
                            "Agent 无权访问任务所属项目 {project_id}"
                        )));
                    }
                    project_id
                }
                None => resolve_default_project(db, principal)?,
            }
        }
    };
    scope.project_name = project_name(db, &scope.project_id)?;

    // 目标：显式任务 > 自然语言 > 项目中进行中的功能 > 默认文案
    scope.objective = req.task.clone().unwrap_or_default();
    if !scope.task_id.is_empty() {
        // 只有具备任务读能力时才解析；否则不回显任务标题（避免越权探测）。
        if kind_globally_or_project_authorized(
            db,
            principal,
            Capability::TasksRead,
            &scope.project_id,
        )? {
            let task = service::fetch_task(db, principal, &scope.task_id)?;
            scope.objective = format!("{}（{}，状态 {}）", task.title, task.id, task.status);
            scope.objective_task = Some(task);
        } else {
            scope.objective = format!("任务 {}（当前身份无权读取任务详情）", scope.task_id);
        }
    }
    if scope.objective.trim().is_empty() && !scope.project_id.is_empty() {
        let features = list_features_impl(db, scope.project_id.clone()).unwrap_or_default();
        if let Some(feature) = features.iter().find(|f| f.status == "in_progress") {
            scope.objective = format!("推进功能：{}", feature.title);
        }
    }
    if scope.objective.trim().is_empty() {
        scope.objective = "了解当前项目状态并准备下一步工作".into();
    }
    scope.keywords = keywords(&format!(
        "{} {}",
        scope.objective,
        req.task.clone().unwrap_or_default()
    ));
    Ok(scope)
}

/// 默认项目只从 Agent 可访问的项目中选择；不允许“未授权 → 回退全局”。
fn resolve_default_project(db: &Db, principal: &Principal) -> AppResult<String> {
    let projects = crate::commands::planning::list_projects_impl(db, Some(false))?;
    let candidates: Vec<_> = projects
        .iter()
        .filter(|p| p.status == "in_progress")
        .chain(projects.iter())
        .collect();
    for project in candidates {
        if can_access_project(db, principal, &project.id)? {
            return Ok(project.id.clone());
        }
    }
    Ok(String::new())
}

/// 能力是否可用：全局授权，或（有项目范围时）该项目上的授权。
fn kind_globally_or_project_authorized(
    db: &Db,
    principal: &Principal,
    capability: Capability,
    project_id: &str,
) -> AppResult<bool> {
    let Some(row_id) = agent_row_id(principal) else {
        return Ok(true);
    };
    db.with_read(|conn| {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mcp_agent_capabilities
             WHERE agent_row_id = ?1 AND capability = ?2
               AND (resource_id = '' OR (resource_id = ?3 AND ?3 <> ''))",
            rusqlite::params![row_id, capability.as_str(), project_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    })
}

/// 2) 授权资源类型：显式请求未授权 → 明确报错；默认请求 → 只返回已授权部分。
fn resolve_authorized_kinds(
    db: &Db,
    principal: &Principal,
    req: &ContextRequest,
    scope: &ContextScope,
) -> AppResult<AuthorizedContextKinds> {
    perms::require(db, principal, Capability::ContextRead, "")?;
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
        let allowed =
            kind_globally_or_project_authorized(db, principal, capability, &scope.project_id)?;
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
    _principal: &Principal,
    scope: &ContextScope,
    items: &mut Vec<ContextItem>,
) -> AppResult<()> {
    let mut filter = TaskFilter {
        status: Some("all".into()),
        limit: Some(200),
        ..Default::default()
    };
    if let Some(first) = scope.keywords.first() {
        filter.search = Some(first.clone());
    } else {
        filter.status = Some("pending".into());
    }
    let mut tasks = list_tasks_inner(db, filter)?;
    if let Some(existing) = &scope.objective_task {
        if !tasks.iter().any(|t| t.id == existing.id) {
            tasks.push(existing.clone());
        }
    }
    // 项目范围：只保留与该项目弱关联的任务，避免默认检索混入无关任务。
    let linked = task_ids_for_project(db, &scope.project_id);
    if !scope.project_id.is_empty() {
        tasks.retain(|task| {
            linked.contains(&task.id)
                || scope
                    .objective_task
                    .as_ref()
                    .map(|t| t.id == task.id)
                    .unwrap_or(false)
        });
    }
    for task in tasks.into_iter().take(24) {
        let mut relevance = 10 + recency_score(&task.updated_at);
        for k in &scope.keywords {
            relevance += score_title(&task.title, k) + score_text(&task.description, k);
        }
        if task.status == "pending" {
            relevance += 10;
        }
        if scope
            .objective_task
            .as_ref()
            .map(|t| t.id == task.id)
            .unwrap_or(false)
        {
            relevance += 40;
        }
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
    let query = scope.keywords.join(" ");
    // 关键词检索接口要求全局 KnowledgeRead；项目级授权只走项目知识库列表。
    let can_search = kind_globally_or_project_authorized(
        db,
        principal,
        Capability::KnowledgeRead,
        "",
    )?;
    if can_search && !query.is_empty() {
        let (hits, _) = service::search_knowledge(db, principal, &query, &[], 8, 0)?;
        for hit in hits {
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
    if !scope.project_id.is_empty() {
        let docs = knowledge_docs_for_project(db, &scope.project_id)?;
        for (id, title, updated_at) in docs {
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

fn knowledge_docs_for_project(
    db: &Db,
    project_id: &str,
) -> AppResult<Vec<(String, String, String)>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT d.id, d.title, d.updated_at FROM knowledge_documents d
             JOIN knowledge_bases b ON b.id = d.kb_id
             WHERE b.project_id = ?1 ORDER BY d.updated_at DESC LIMIT 8",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
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
    let (decisions, _) = store::list_decisions(
        db,
        if scope.project_id.is_empty() {
            None
        } else {
            Some(&scope.project_id)
        },
        None,
        20,
        0,
    )?;
    let mut list = decisions;
    // 只有“全局上下文”才补充无项目决策；有项目时不跨项目拼装。
    if list.is_empty() && scope.project_id.is_empty() {
        let (global, _) = store::list_decisions(db, Some(""), None, 5, 0)?;
        list.extend(global);
    }
    for decision in list {
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
    let (handoffs, _) = store::list_handoffs(
        db,
        None,
        if scope.project_id.is_empty() {
            None
        } else {
            Some(&scope.project_id)
        },
        20,
        0,
    )?;
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

fn deduplicate_context_candidates(items: &mut Vec<ContextItem>) {
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert((item.kind.clone(), item.source_id.clone())));
}

/// 4) 预算：显式覆盖任务/规划/决策/知识/交接/近期变更/约束/下一步/Markdown 骨架。
fn apply_context_budget(items: &mut Vec<ContextItem>, total: u32) -> ContextBudget {
    let mut used: u32 = 400; // Markdown 固定骨架
    let mut kept = Vec::new();
    let mut truncated = false;
    for item in items.drain(..) {
        let cost = estimate_tokens(&item.title) + estimate_tokens(&item.summary) + 20;
        if used + cost > total {
            truncated = true;
            continue;
        }
        used += cost;
        kept.push(item);
    }
    let kept_items = kept.len() as u32;
    *items = kept;
    ContextBudget {
        total,
        used,
        truncated,
        kept_items,
    }
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

/// 近期变更：通过既有业务关联查找资源，而不是 `resource_id = project_id`。
fn retrieve_recent_changes(
    db: &Db,
    scope: &ContextScope,
    authorized: &AuthorizedContextKinds,
    budget: &mut ContextBudget,
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

    let linked_tasks = task_ids_for_project(db, &scope.project_id);
    let knowledge_ids: HashSet<String> = if scope.project_id.is_empty() {
        HashSet::new()
    } else {
        knowledge_docs_for_project(db, &scope.project_id)?
            .into_iter()
            .map(|(id, _, _)| id)
            .collect()
    };
    let decision_ids: HashSet<String> = if scope.project_id.is_empty() {
        HashSet::new()
    } else {
        db.with_read(|conn| {
            let mut stmt =
                conn.prepare("SELECT id FROM agent_decisions WHERE project_id = ?1")?;
            let rows = stmt.query_map(rusqlite::params![scope.project_id], |r| {
                r.get::<_, String>(0)
            })?;
            let mut out = HashSet::new();
            for row in rows {
                out.insert(row?);
            }
            Ok(out)
        })?
    };
    let handoff_ids: HashSet<String> = if scope.project_id.is_empty() {
        HashSet::new()
    } else {
        db.with_read(|conn| {
            let mut stmt =
                conn.prepare("SELECT id FROM agent_handoffs WHERE project_id = ?1")?;
            let rows = stmt.query_map(rusqlite::params![scope.project_id], |r| {
                r.get::<_, String>(0)
            })?;
            let mut out = HashSet::new();
            for row in rows {
                out.insert(row?);
            }
            Ok(out)
        })?
    };
    let plan_ids: HashSet<String> = if scope.project_id.is_empty() {
        HashSet::new()
    } else {
        let mut set = HashSet::new();
        set.insert(scope.project_id.clone());
        for feature in list_features_impl(db, scope.project_id.clone()).unwrap_or_default() {
            set.insert(feature.id);
        }
        set
    };

    let related = |kind: &str, id: &str| -> bool {
        if scope.project_id.is_empty() {
            return true;
        }
        match kind {
            "task" => linked_tasks.contains(id),
            "knowledge" => knowledge_ids.contains(id),
            "decision" => decision_ids.contains(id),
            "handoff" | "report" => handoff_ids.contains(id),
            "plan" | "feature" | "project" => plan_ids.contains(id),
            _ => false,
        }
    };
    let kind_authorized = |kind: &str| -> bool {
        match kind {
            "task" => authorized.task,
            "knowledge" => authorized.knowledge,
            "decision" => authorized.decision,
            "handoff" | "report" => authorized.handoff,
            "plan" | "feature" | "project" => authorized.plan,
            _ => false,
        }
    };

    let mut out = Vec::new();
    for (kind, id, revision, updated_at, updated_by, source) in rows {
        if !kind_authorized(&kind) || !related(&kind, &id) {
            continue;
        }
        let mut item = ContextItem {
            kind: kind.clone(),
            source_id: id.clone(),
            title: format!("{kind} {id} → r{revision}"),
            summary: format!("由 {updated_by} 经 {source} 更新"),
            updated_at,
            relevance: 0,
            access: link_for(&kind, &id),
            project_id: scope.project_id.clone(),
            status: "changed".into(),
        };
        let cost = estimate_tokens(&item.title) + estimate_tokens(&item.summary) + 20;
        if budget.used + cost > budget.total {
            budget.truncated = true;
            break;
        }
        budget.used += cost;
        item.summary.push_str(" · 近期变更");
        out.push(item);
        if out.len() >= take {
            break;
        }
    }
    Ok(out)
}

// ── 5) 装配 ──────────────────────────────────────────────────────

pub fn build(db: &Db, principal: &Principal, req: ContextRequest) -> AppResult<AgentContext> {
    let budget_total = req
        .budget_tokens
        .unwrap_or(DEFAULT_BUDGET)
        .clamp(1000, MAX_BUDGET);
    let scope = resolve_context_scope(db, principal, &req)?;
    let authorized = resolve_authorized_kinds(db, principal, &req, &scope)?;

    let mut items = collect_context_candidates(db, principal, &scope, &authorized)?;
    items = filter_context_by_permission(items, &authorized);
    deduplicate_context_candidates(&mut items);
    rank_context_candidates(&mut items);
    let mut budget = apply_context_budget(&mut items, budget_total);
    let recent_changes = retrieve_recent_changes(db, &scope, &authorized, &mut budget, 10)?;

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
    for text in constraints.iter().chain(next_steps.iter()) {
        budget.used = budget.used.saturating_add(estimate_tokens(text) + 4);
    }
    if budget.used > budget.total {
        budget.truncated = true;
        budget.used = budget.total;
    }

    let mut ctx = AgentContext {
        project_id: scope.project_id.clone(),
        project_name: scope.project_name.clone(),
        objective: scope.objective.clone(),
        scope: json!({
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
        }),
        items,
        constraints,
        next_steps,
        recent_changes,
        budget_tokens: budget.total,
        estimated_tokens: budget.used,
        truncated: budget.truncated,
        kept_items: budget.kept_items,
        markdown: String::new(),
    };
    ctx.markdown = render_markdown(&ctx);
    let access = store::ContextAccess {
        principal,
        purpose: req.task.as_deref().unwrap_or("context.get"),
        project_id: &ctx.project_id,
        task_id: &scope.task_id,
        format: req.format.as_deref().unwrap_or("markdown"),
        budget_tokens: budget.total,
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
    out.push_str(&format!(
        "_预算 {} tokens，估算使用 {} tokens，条目 {} 条{}。_\n",
        ctx.budget_tokens,
        ctx.estimated_tokens,
        ctx.kept_items,
        if ctx.truncated { "，已按预算截断" } else { "" }
    ));
    out
}

/// 便于 REST/MCP 直接拿 JSON（`markdown` 字段保留，方便同一响应两种用途）。
pub fn to_json(ctx: &AgentContext) -> AppResult<Value> {
    Ok(serde_json::to_value(ctx)?)
}

/// 近期活动上下文（`get_recent_context`）。
pub fn recent(db: &Db, principal: &Principal, limit: u32) -> AppResult<Vec<ContextItem>> {
    perms::require_any_read(db, principal)?;
    let (events, _) = handoff_activity(db, principal, limit)?;
    Ok(events)
}

fn handoff_activity(
    db: &Db,
    _principal: &Principal,
    limit: u32,
) -> AppResult<(Vec<ContextItem>, super::Page)> {
    let (records, page) = store::list_activity(
        db,
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
        let mut items: Vec<ContextItem> = (0..50)
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
        let budget = apply_context_budget(&mut items, 1000);
        assert!(budget.truncated);
        assert!(budget.used <= 1000);
        assert!(items.len() < 50);
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
