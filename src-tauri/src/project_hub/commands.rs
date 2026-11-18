//! 项目中枢 IPC 命令面（v78）。
//!
//! 前端只通过这些命令读写项目事实；准备度/进度公式留在已测试的 TS 领域层。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::AppResult;

use super::service::{self, CreateProjectInput, ProjectHubSnapshot, ProjectSummary};

#[tauri::command]
pub fn project_hub_list_projects(db: State<'_, Arc<Db>>) -> AppResult<Vec<ProjectSummary>> {
    service::list_projects(db.inner().as_ref())
}

#[tauri::command]
pub fn project_hub_get_project(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ProjectHubSnapshot> {
    service::get_snapshot(db.inner().as_ref(), &project_id)
}

#[tauri::command]
pub fn project_hub_create_project(
    db: State<'_, Arc<Db>>,
    input: CreateProjectInput,
) -> AppResult<ProjectHubSnapshot> {
    service::create_project(db.inner().as_ref(), input)
}
