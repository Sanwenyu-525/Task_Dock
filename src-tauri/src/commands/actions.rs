//! 行动中心命令层：聚合读取、批量确认、跳回 Agent 会话。

use std::sync::Arc;

use tauri::State;

use crate::actions::{self, ActionFeed, ActionFilter};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::navigation::NavigationResult;

#[tauri::command]
pub fn actions_feed(db: State<'_, Arc<Db>>, filter: Option<ActionFilter>) -> AppResult<ActionFeed> {
    actions::feed(&db, &filter.unwrap_or_default())
}

#[tauri::command]
pub fn actions_ack(db: State<'_, Arc<Db>>, event_ids: Vec<String>) -> AppResult<usize> {
    actions::ack(&db, &event_ids)
}

#[tauri::command]
pub fn actions_unack(db: State<'_, Arc<Db>>, event_ids: Vec<String>) -> AppResult<usize> {
    actions::unack(&db, &event_ids)
}

/// 跳回 Agent 会话：复用既有 resume_session（能力不足时如实降级），
/// 并把结果写入导航流水供「应用管理」回看。
#[tauri::command]
pub fn actions_open_session(
    db: State<'_, Arc<Db>>,
    source_id: String,
    session_id: String,
) -> AppResult<NavigationResult> {
    crate::agents::validate_session_id(&session_id)?;
    let r = crate::navigation::agent_navigation::resume_session(&db, &source_id, &session_id);
    crate::navigation::target_resolver::write_log(
        &db,
        &r,
        &format!("{}:{}", source_id, session_id),
    );
    if r.success {
        Ok(r)
    } else {
        Err(AppError::Agent(
            r.reason.unwrap_or_else(|| "跳转失败".into()),
        ))
    }
}
