//! 项目上下文读取：给外部 Agent 一个“按需、分页、可过滤”的入口，避免一次性灌入全部数据。

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, Actor, Capability};
use super::model::{
    page_args, ContextCounts, ContextTask, Issue, IssueFilter, Page, Plan, ProjectContext,
    VisualDocument,
};
use super::{issue, plan, visual};

pub const CONTEXT_SECTIONS: &[&str] = &[
    "overview",
    "architecture",
    "knowledge",
    "issues",
    "bugs",
    "plans",
    "tasks",
    "visuals",
];

pub fn get_project_context(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    include: &[String],
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<ProjectContext> {
    actor.require(Capability::ContextRead)?;
    assert_project_scope(conn, actor, project_id)?;

    let sections: Vec<String> = if include.is_empty() {
        vec![
            "overview".to_string(),
            "issues".to_string(),
            "plans".to_string(),
            "tasks".to_string(),
        ]
    } else {
        let mut out = Vec::new();
        for item in include {
            let v = super::util::validate_enum(item, CONTEXT_SECTIONS, "上下文分区")?;
            if !out.contains(&v) {
                out.push(v);
            }
        }
        out
    };
    let (page, size, _) = page_args(page, page_size);
    let size = size.min(50);

    let (name, description, status, target_date): (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT name, description, status, target_date FROM planning_projects
             WHERE id=?1 AND archived=0",
            rusqlite::params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| AppError::NotFound("项目不存在或已归档".to_string()))?;

    let counts = counts(conn, project_id)?;

    let mut ctx = ProjectContext {
        project_id: project_id.to_string(),
        name,
        description,
        status,
        target_date,
        counts,
        architecture: None,
        knowledge: None,
        issues: None,
        plans: None,
        tasks: None,
        visuals: None,
    };

    for section in &sections {
        match section.as_str() {
            "overview" => {}
            "architecture" => {
                ctx.architecture = Some(
                    "TaskDock 桌面端：Tauri 2 + Rust（src-tauri）+ React 19 + TypeScript + Vite + Zustand，SQLite 为事实源；\
协作中心 collab 的服务层同时被 IPC 与 MCP 复用，可视化引擎前后端分离（结构化 Schema + 白名单渲染）。"
                        .to_string(),
                );
            }
            "knowledge" => {
                ctx.knowledge = Some(knowledge(conn, project_id, size as usize)?);
            }
            "issues" => {
                let filter = IssueFilter {
                    page: Some(page),
                    page_size: Some(size),
                    ..Default::default()
                };
                ctx.issues = Some(issue::list_issues(conn, actor, project_id, &filter)?);
            }
            "bugs" => {
                let filter = IssueFilter {
                    kind: Some("bug".to_string()),
                    page: Some(page),
                    page_size: Some(size),
                    ..Default::default()
                };
                ctx.issues = Some(issue::list_issues(conn, actor, project_id, &filter)?);
            }
            "plans" => {
                ctx.plans = Some(plan::list_plans(
                    conn,
                    actor,
                    project_id,
                    None,
                    Some(page),
                    Some(size),
                )?);
            }
            "tasks" => {
                ctx.tasks = Some(context_tasks(conn, project_id, page, size)?);
            }
            "visuals" => {
                ctx.visuals = Some(visual::list_documents(
                    conn,
                    actor,
                    project_id,
                    None,
                    Some(page),
                    Some(size),
                )?);
            }
            _ => {}
        }
    }
    Ok(ctx)
}

pub fn get_project_overview(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
) -> AppResult<ProjectContext> {
    get_project_context(
        conn,
        actor,
        project_id,
        &["overview".to_string()],
        Some(1),
        Some(1),
    )
}

pub fn get_project_plans(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    status: Option<&str>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<Plan>> {
    plan::list_plans(conn, actor, project_id, status, page, page_size)
}

pub fn get_project_tasks(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<ContextTask>> {
    actor.require(Capability::ContextRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let (page, size, _) = page_args(page, page_size);
    context_tasks(conn, project_id, page, size.min(50))
}

pub fn get_project_issues(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    filter: &IssueFilter,
) -> AppResult<Page<Issue>> {
    issue::list_issues(conn, actor, project_id, filter)
}

pub fn get_project_knowledge(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    query: Option<&str>,
    limit: Option<i64>,
) -> AppResult<Vec<String>> {
    actor.require(Capability::ContextRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let limit = limit.unwrap_or(20).clamp(1, 50) as usize;
    let mut items = knowledge(conn, project_id, 100)?;
    if let Some(q) = query {
        let q = q.trim().to_lowercase();
        if !q.is_empty() {
            items.retain(|item| item.to_lowercase().contains(&q));
        }
    }
    items.truncate(limit);
    Ok(items)
}

fn counts(conn: &Connection, project_id: &str) -> AppResult<ContextCounts> {
    let count = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> AppResult<i64> {
        Ok(conn.query_row(sql, params, |r| r.get(0))?)
    };
    let issues = count(
        "SELECT COUNT(*) FROM collab_issues WHERE project_id=?1 AND kind<>'bug'",
        &[&project_id],
    )?;
    let bugs = count(
        "SELECT COUNT(*) FROM collab_issues WHERE project_id=?1 AND kind='bug'",
        &[&project_id],
    )?;
    let plans = count(
        "SELECT COUNT(*) FROM collab_plans WHERE project_id=?1",
        &[&project_id],
    )?;
    let visuals = count(
        "SELECT COUNT(*) FROM collab_visual_docs WHERE project_id=?1",
        &[&project_id],
    )?;
    let evidence = count(
        "SELECT COUNT(*) FROM collab_evidence WHERE project_id=?1",
        &[&project_id],
    )?;
    let tasks = count(
        "SELECT COUNT(DISTINCT l.target_id) FROM collab_plan_links l
         JOIN collab_plans p ON p.id=l.plan_id
         WHERE p.project_id=?1 AND l.target_kind='task'",
        &[&project_id],
    )?;
    Ok(ContextCounts {
        issues,
        bugs,
        plans,
        visuals,
        evidence,
        tasks,
    })
}

fn context_tasks(
    conn: &Connection,
    project_id: &str,
    page: i64,
    size: i64,
) -> AppResult<Page<ContextTask>> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT l.target_id) FROM collab_plan_links l
         JOIN collab_plans p ON p.id=l.plan_id
         WHERE p.project_id=?1 AND l.target_kind='task'
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=l.target_id)",
        rusqlite::params![project_id],
        |r| r.get(0),
    )?;
    let offset = (page - 1).saturating_mul(size);
    let mut stmt = conn.prepare(
        "SELECT DISTINCT t.id, t.title, t.status, t.priority, t.due_at
         FROM collab_plan_links l
         JOIN collab_plans p ON p.id=l.plan_id
         JOIN tasks t ON t.id=l.target_id
         WHERE p.project_id=?1 AND l.target_kind='task'
         ORDER BY t.priority, t.due_at IS NULL, t.due_at
         LIMIT ?2 OFFSET ?3",
    )?;
    let items = stmt
        .query_map(rusqlite::params![project_id, size, offset], |r| {
            Ok(ContextTask {
                id: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                priority: r.get(3)?,
                due_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Page::new(items, total, page, size))
}

fn knowledge(conn: &Connection, project_id: &str, limit: usize) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT title, description, status FROM planning_features
         WHERE project_id=?1 ORDER BY sort_order, created_at LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_id, limit as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (title, description, status) = row?;
        if description.trim().is_empty() {
            out.push(format!("[{status}] {title}"));
        } else {
            out.push(format!("[{status}] {title}：{}", description.trim()));
        }
    }
    let mut stmt = conn.prepare(
        "SELECT title, summary FROM collab_plans WHERE project_id=?1
         AND status IN ('approved','developing','accepting','completed')
         ORDER BY updated_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_id, limit as i64], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (title, summary) = row?;
        out.push(format!("[方案] {title}：{summary}"));
    }
    out.truncate(limit);
    Ok(out)
}

#[allow(dead_code)]
fn unused_visual_type() -> Option<VisualDocument> {
    None
}
