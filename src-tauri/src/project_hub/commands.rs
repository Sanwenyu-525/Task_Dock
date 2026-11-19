//! 项目中枢 IPC 命令面（v78）。
//!
//! 前端只通过这些命令读写项目事实；准备度/进度公式留在已测试的 TS 领域层。
//! 读写都可能等待 SQLite 写锁，必须离开 UI 主线程执行：同步命令会阻塞主线程，
//! 一旦另一个后台任务持有写连接并等待主线程，应用会直接进入 `Responding=False`。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::service::{self, CreateProjectInput, ProjectHubSnapshot, ProjectSummary};

fn background_error(context: &str, error: tauri::Error) -> AppError {
    AppError::Unavailable(format!("{context}: {error}"))
}

#[tauri::command]
pub async fn project_hub_list_projects(
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<ProjectSummary>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::list_projects(db.as_ref()))
        .await
        .map_err(|error| background_error("项目列表查询失败", error))?
}

#[tauri::command]
pub async fn project_hub_get_project(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ProjectHubSnapshot> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::get_snapshot(db.as_ref(), &project_id))
        .await
        .map_err(|error| background_error("项目读取失败", error))?
}

#[tauri::command]
pub async fn project_hub_create_project(
    db: State<'_, Arc<Db>>,
    input: CreateProjectInput,
) -> AppResult<ProjectHubSnapshot> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service::create_project(db.as_ref(), input))
        .await
        .map_err(|error| background_error("项目创建失败", error))?
}
