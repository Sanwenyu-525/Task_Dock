//! 统一任务上下文：把任务 ↔ Agent ↔ 导航目标 ↔ 剪贴板素材 ↔ 现场快照 ↔ 动作
//! 聚合成一个只读视图，供任务卡「上下文」面板使用。
//!
//! 所有数据都来自既有表，本模块不写库；各模块仍可独立启停，
//! 任一子查询缺失（例如未启用剪贴板）只返回空列表，不影响其他部分。

use std::sync::Arc;

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::actions::{self, ActionFilter, ActionItem};
use crate::clipboard::store::ClipboardTaskLink;
use crate::db::{Db, Task};
use crate::error::AppResult;
use crate::navigation::target_resolver::TaskNavLinkRow;
use crate::workspace::{self, SnapshotSummary};

const CONTEXT_ACTION_LIMIT: usize = 8;

#[derive(Debug, Clone, Serialize)]
pub struct ContextAgent {
    pub link_id: Option<String>,
    pub source_id: String,
    pub source_name: String,
    pub session_external_id: String,
    pub title: String,
    /// 会话最后已知状态；找不到会话时为 unknown（不猜测）
    pub state: String,
    pub last_seen_at: Option<String>,
    /// user | auto | nav（nav = 仅通过导航目标关联）
    pub origin: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskContext {
    pub task: Task,
    pub agents: Vec<ContextAgent>,
    pub navigation: Vec<TaskNavLinkRow>,
    pub clipboard: Vec<ClipboardTaskLink>,
    pub snapshots: Vec<SnapshotSummary>,
    pub actions: Vec<ActionItem>,
}

fn load_agents(db: &Db, task_id: &str) -> AppResult<Vec<ContextAgent>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.id, l.source_id, COALESCE(s.display_name, l.source_id), l.session_external_id,
                    COALESCE(ss.title, ''), COALESCE(ss.status, 'unknown'), ss.last_seen_at, l.origin
             FROM task_agent_links l
             LEFT JOIN agent_sources s ON s.id = l.source_id
             LEFT JOIN agent_sessions ss
               ON ss.source_id = l.source_id AND ss.external_id = l.session_external_id
             WHERE l.task_id = ?1
             UNION ALL
             SELECT '', n.agent_source_id, COALESCE(s.display_name, n.agent_source_id), n.agent_session_id,
                    COALESCE(ss.title, ''), COALESCE(ss.status, 'unknown'), ss.last_seen_at, 'nav'
             FROM task_navigation_targets nl
             JOIN navigation_targets n ON n.id = nl.target_id
             LEFT JOIN agent_sources s ON s.id = n.agent_source_id
             LEFT JOIN agent_sessions ss
               ON ss.source_id = n.agent_source_id AND ss.external_id = n.agent_session_id
             WHERE nl.task_id = ?1 AND n.target_type = 'agent_session'",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(ContextAgent {
                link_id: {
                    let id: String = r.get(0)?;
                    if id.is_empty() { None } else { Some(id) }
                },
                source_id: r.get(1)?,
                source_name: r.get(2)?,
                session_external_id: r.get(3)?,
                title: r.get(4)?,
                state: r.get(5)?,
                last_seen_at: r.get(6)?,
                origin: r.get(7)?,
            })
        })?;
        let mut out: Vec<ContextAgent> = Vec::new();
        for row in rows {
            let agent = row?;
            // 同一会话可能同时有手工关联与导航关联：保留手工关联（可被用户解除）
            let dup = out.iter().position(|a| {
                a.source_id == agent.source_id
                    && a.session_external_id == agent.session_external_id
            });
            match dup {
                Some(i) if out[i].link_id.is_none() && agent.link_id.is_some() => out[i] = agent,
                Some(_) => {}
                None => out.push(agent),
            }
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn task_context(db: State<'_, Arc<Db>>, task_id: String) -> AppResult<TaskContext> {
    let task = crate::commands::tasks::get_task(&db, &task_id)?;
    let agents = load_agents(&db, &task_id)?;
    let navigation = crate::navigation::target_resolver::task_targets(&db, &task_id)?;
    let clipboard = crate::clipboard::store::task_links(&db, &task_id)?;
    let snapshots = workspace::list_snapshots(&db, Some(&task_id))?;
    let actions = actions::feed(
        &db,
        &ActionFilter {
            task_id: Some(task_id),
            include_acked: false,
            limit: Some(CONTEXT_ACTION_LIMIT),
            ..Default::default()
        },
    )?
    .items;
    Ok(TaskContext {
        task,
        agents,
        navigation,
        clipboard,
        snapshots,
        actions,
    })
}
