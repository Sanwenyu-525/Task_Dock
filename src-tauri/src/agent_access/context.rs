//! Context Engine：按「当前任务」组织相关上下文，而不是让 Agent 遍历整个工作空间。
//!
//! 阶段一检索策略（可解释、无外部依赖）：
//! 显式范围 + 标题匹配 + 正文关键词 + 状态 + 时间新鲜度 + 多命中 + 决策/交接状态加权；
//! 不使用向量库，不引入外部索引；每条结果都带来源 ID、类型、更新时间、相关性与访问方式。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::capability::skills;
use crate::commands::planning::{list_features_impl, load_project_tx};
use crate::commands::tasks::{list_tasks_inner, TaskFilter};
use crate::db::Task;
use crate::db::Db;
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
    /// 需要的资源类型：task/knowledge/decision/handoff/skill
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
    pub markdown: String,
}

fn estimate_tokens(text: &str) -> u32 {
    // 中文按「约 2 字符 / token」粗估；只用于预算控制，不做精确计费。
    ((text.chars().count() as u32) / 2).max(1)
}

fn keywords(input: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "的", "了", "和", "与", "在", "是", "我", "你", "他", "请", "帮", "查看", "读取", "获取",
        "一下", "相关", "任务", "项目", "计划", "context", "the", "and", "for", "with",
    ];
    let mut out: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s.chars().count() >= 2 && !STOP.contains(&s.as_str()))
        .collect();
    out.sort();
    out.dedup();
    out.truncate(8);
    out
}

fn score_text(text: &str, keyword: &str) -> i64 {
    let lower = text.to_lowercase();
    if lower.contains(keyword) {
        12
    } else {
        0
    }
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

fn resolve_current_project(db: &Db) -> AppResult<Option<String>> {
    let projects = crate::commands::planning::list_projects_impl(db, Some(false))?;
    Ok(projects
        .iter()
        .find(|p| p.status == "in_progress")
        .or_else(|| projects.first())
        .map(|p| p.id.clone()))
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

fn wanted(req: &ContextRequest, kind: &str) -> bool {
    req.kinds.is_empty() || req.kinds.iter().any(|k| k == kind)
}

fn link_for(kind: &str, id: &str) -> String {
    match kind {
        "task" => format!("taskdock task get {id}"),
        "knowledge" => format!("taskdock knowledge get {id}"),
        "decision" => format!("taskdock decision get {id}"),
        "handoff" => format!("taskdock agent handoff get {id}"),
        "plan" => format!("taskdock plan get {id}"),
        "skill" => format!("taskdock info --json（skills 资源见 manifest）"),
        _ => String::new(),
    }
}

pub fn build(db: &Db, principal: &Principal, req: ContextRequest) -> AppResult<AgentContext> {
    perms::require_any_read(db, principal)?;
    let budget = req
        .budget_tokens
        .unwrap_or(DEFAULT_BUDGET)
        .clamp(1000, MAX_BUDGET);
    let task_id = req.task_id.clone().unwrap_or_default();

    // 1) 范围解析：显式项目 > 任务所属项目 > 当前进行中的规划项目
    let mut project_id = req
        .project_id
        .clone()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if project_id.is_none() && !task_id.is_empty() {
        project_id = db.with_read(|conn| perms::task_project(conn, &task_id))?;
    }
    if project_id.is_none() {
        project_id = resolve_current_project(db)?;
    }
    let project_id = project_id.unwrap_or_default();
    if !project_id.is_empty() {
        let kind = db.with_read(|conn| perms::project_exists(conn, &project_id))?;
        if kind.is_none() {
            return Err(AppError::NotFound(format!("项目不存在: {project_id}")));
        }
    }

    // 2) 目标
    let mut objective = req.task.clone().unwrap_or_default();
    let mut objective_task: Option<Task> = None;
    if !task_id.is_empty() {
        let task = service::fetch_task(db, principal, &task_id)?;
        objective = format!("{}（{}，状态 {}）", task.title, task.id, task.status);
        objective_task = Some(task);
    }
    if objective.trim().is_empty() {
        if !project_id.is_empty() {
            let features = list_features_impl(db, project_id.clone())?;
            if let Some(feature) = features.iter().find(|f| f.status == "in_progress") {
                objective = format!("推进功能：{}", feature.title);
            }
        }
    }
    if objective.trim().is_empty() {
        objective = "了解当前项目状态并准备下一步工作".into();
    }
    let kw = keywords(&format!("{objective} {}", req.task.clone().unwrap_or_default()));

    // 3) 规划
    let mut items: Vec<ContextItem> = Vec::new();
    if wanted(&req, "plan") && !project_id.is_empty() {
        if let Ok(project) = db.with_read(|conn| load_project_tx(conn, &project_id)) {
            let features = list_features_impl(db, project_id.clone()).unwrap_or_default();
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
            for k in &kw {
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
                for k in &kw {
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
                    project_id: project_id.clone(),
                    status: feature.status.clone(),
                });
            }
        }
    }

    // 4) 任务
    if wanted(&req, "task") {
        perms::require(db, principal, Capability::TasksRead, "")?;
        let mut filter = TaskFilter {
            status: Some("all".into()),
            limit: Some(100),
            ..Default::default()
        };
        if !kw.is_empty() {
            filter.search = Some(kw[0].clone());
        } else {
            filter.status = Some("pending".into());
        }
        let mut tasks = list_tasks_inner(db, filter)?;
        if let Some(existing) = &objective_task {
            if !tasks.iter().any(|t| t.id == existing.id) {
                tasks.push(existing.clone());
            }
        }
        // 项目关联任务：通过既有 workspace_task_links 建立弱关联，不复制任务内容。
        if !project_id.is_empty() {
            let linked = crate::commands::project_workspace::workspace_task_link_list_impl(
                db, &project_id,
            )
            .unwrap_or_default();
            for link in linked {
                if !tasks.iter().any(|t| t.id == link.task_id) {
                    if let Ok(task) = service::fetch_task(db, principal, &link.task_id) {
                        tasks.push(task);
                    }
                }
            }
        }
        for task in tasks.into_iter().take(20) {
            let mut relevance = 10 + recency_score(&task.updated_at);
            for k in &kw {
                relevance += score_title(&task.title, k) + score_text(&task.description, k) / 1;
            }
            if task.status == "pending" {
                relevance += 10;
            }
            if Some(&task.id) == objective_task.as_ref().map(|t| &t.id) {
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
                project_id: project_id.clone(),
                status: task.status.clone(),
            });
        }
    }

    // 5) 知识
    if wanted(&req, "knowledge") {
        perms::require(db, principal, Capability::KnowledgeRead, "")?;
        let query = kw.join(" ");
        if !query.is_empty() {
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
                    project_id: project_id.clone(),
                    status: "indexed".into(),
                });
            }
        }
        if !project_id.is_empty() {
            let docs = db.with_read(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT d.id, d.title, d.updated_at FROM knowledge_documents d
                         JOIN knowledge_bases b ON b.id = d.kb_id
                         WHERE b.project_id = ?1 ORDER BY d.updated_at DESC LIMIT 8",
                    )
                    .map_err(AppError::from)?;
                let rows = stmt
                    .query_map(rusqlite::params![project_id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(AppError::from)?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(AppError::from)?);
                }
                Ok::<_, AppError>(out)
            })?;
            for (id, title, updated_at) in docs {
                items.push(ContextItem {
                    kind: "knowledge".into(),
                    source_id: id.clone(),
                    title,
                    summary: "项目知识库文档（只读摘要）".into(),
                    updated_at: updated_at.clone(),
                    relevance: 18 + recency_score(&updated_at),
                    access: link_for("knowledge", &id),
                    project_id: project_id.clone(),
                    status: "indexed".into(),
                });
            }
        }
    }

    // 6) 决策
    if wanted(&req, "decision") {
        perms::require(db, principal, Capability::DecisionsRead, "")?;
        let (decisions, _) = store::list_decisions(
            db,
            if project_id.is_empty() { None } else { Some(&project_id) },
            None,
            20,
            0,
        )?;
        let mut list = decisions;
        if list.is_empty() {
            let (global, _) = store::list_decisions(db, Some(""), None, 5, 0)?;
            list.extend(global);
        }
        for decision in list {
            let mut relevance = 8 + recency_score(&decision.updated_at);
            for k in &kw {
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
    }

    // 7) Skill
    if wanted(&req, "skill") {
        perms::require(db, principal, Capability::SkillsRead, "")?;
        let query = kw.first().map(String::as_str);
        let found = skills::list_impl(db, query, None, None, None)?;
        for skill in found.into_iter().filter(|s| s.enabled && !s.missing).take(5) {
            let mut relevance = 6;
            for k in &kw {
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
                project_id: project_id.clone(),
                status: if skill.enabled { "enabled" } else { "disabled" }.into(),
            });
        }
    }

    // 8) 其他 Agent 正在进行的工作（交接）
    if wanted(&req, "handoff") {
        perms::require(db, principal, Capability::HandoffsRead, "")?;
        let (handoffs, _) = store::list_handoffs(
            db,
            None,
            if project_id.is_empty() {
                None
            } else {
                Some(&project_id)
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
    }

    // 9) 去重 + 排序
    items.sort_by(|a, b| {
        b.relevance
            .cmp(&a.relevance)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.source_id.cmp(&b.source_id))
    });
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert((item.kind.clone(), item.source_id.clone())));

    // 10) 评测预算（粗略 token）
    let mut used: u32 = 400; // 固定骨架开销
    let mut kept: Vec<ContextItem> = Vec::new();
    for item in items {
        let cost = estimate_tokens(&item.title) + estimate_tokens(&item.summary) + 20;
        if used + cost > budget {
            continue;
        }
        used += cost;
        kept.push(item);
    }

    // 11) 近期变更（独立小节，不占主预算）
    let recent_changes = recent_changes(db, &project_id)?;

    // 12) 约束与下一步
    let mut constraints = vec![
        "外部写入必须携带 base_revision，版本不一致返回冲突而不是覆盖。".to_string(),
        "不得直接修改 SQLite 数据库文件；所有写入经统一服务层。".to_string(),
        "不得把推测内容当作已确认事实写入知识或决策。".to_string(),
        "删除能力未开放；批量操作需要额外授权。".to_string(),
    ];
    let mut next_steps: Vec<String> = Vec::new();
    let status = if project_id.is_empty() {
        None
    } else {
        service::project_status(db, principal, &project_id).ok()
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

    let project_name = project_name(db, &project_id)?;
    let mut ctx = AgentContext {
        project_id: project_id.clone(),
        project_name,
        objective,
        scope: json!({
            "project_id": if project_id.is_empty() { Value::Null } else { json!(project_id) },
            "task_id": if task_id.is_empty() { Value::Null } else { json!(task_id) },
            "keywords": kw,
            "kinds": req.kinds,
            "agent_id": req.agent_id,
            "session_id": req.session_id,
        }),
        items: kept,
        constraints,
        next_steps,
        recent_changes,
        budget_tokens: budget,
        estimated_tokens: used,
        markdown: String::new(),
    };
    ctx.markdown = render_markdown(&ctx);
    let access = store::ContextAccess {
        principal,
        purpose: req.task.as_deref().unwrap_or("context.get"),
        project_id: &ctx.project_id,
        task_id: &task_id,
        format: req.format.as_deref().unwrap_or("markdown"),
        budget_tokens: budget,
        item_count: ctx.items.len() as u32,
        estimated_tokens: ctx.estimated_tokens,
        request_id: "",
    };
    let _ = db.with_conn(|conn| store::record_context_access(conn, &access));
    Ok(ctx)
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

fn recent_changes(db: &Db, project_id: &str) -> AppResult<Vec<ContextItem>> {
    let rows = db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT resource_kind, resource_id, revision, updated_at, updated_by, source
                 FROM agent_resource_revisions
                 WHERE (?1 = '' OR resource_id = ?1)
                 ORDER BY updated_at DESC LIMIT 10",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![project_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok::<_, AppError>(out)
    })?;
    Ok(rows
        .into_iter()
        .map(|(kind, id, revision, updated_at, updated_by, source)| ContextItem {
            kind: kind.clone(),
            source_id: id.clone(),
            title: format!("{kind} {id} → r{revision}"),
            summary: format!("由 {updated_by} 经 {source} 更新"),
            updated_at,
            relevance: 0,
            access: link_for(&kind, &id),
            project_id: project_id.to_string(),
            status: "changed".into(),
        })
        .collect())
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
        "_预算 {} tokens，估算使用 {} tokens，条目 {} 条。_\n",
        ctx.budget_tokens,
        ctx.estimated_tokens,
        ctx.items.len()
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

