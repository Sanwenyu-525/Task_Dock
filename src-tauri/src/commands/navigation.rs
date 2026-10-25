//! 导航命令层：软件扫描、目标管理、任务关联、统一跳转、Agent 能力与窗口枚举。
//!
//! 重操作（扫描 / 跳转等待窗口）放 spawn_blocking，不阻塞 IPC 线程。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::navigation;
use crate::navigation::router::{self, NavigateOptions};

// ── 软件发现 ────────────────────────────────────────────────

#[tauri::command]
pub async fn nav_scan_apps(
    force: Option<bool>,
) -> AppResult<navigation::app_discovery::AppScanResult> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(navigation::app_discovery::scan_installed_apps(force))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("扫描任务失败: {}", e)))?
}

/// 当前顶层窗口列表（窗口选择器用；绕过缓存取最新）。
#[tauri::command]
pub fn nav_list_windows() -> Vec<navigation::window_manager::WindowInfo> {
    navigation::window_manager::top_windows_force()
}

// ── 目标管理 ────────────────────────────────────────────────

#[tauri::command]
pub fn nav_list_targets(
    db: State<'_, Arc<Db>>,
    include_hidden: Option<bool>,
) -> AppResult<Vec<navigation::target_resolver::NavTargetRow>> {
    navigation::target_resolver::list_targets(&db, include_hidden.unwrap_or(false))
}

#[tauri::command]
pub fn nav_save_target(
    db: State<'_, Arc<Db>>,
    input: navigation::target_resolver::TargetInput,
) -> AppResult<navigation::target_resolver::NavTargetRow> {
    navigation::target_resolver::save_target(&db, &input)
}

#[tauri::command]
pub fn nav_update_target(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: navigation::target_resolver::TargetPatch,
) -> AppResult<()> {
    navigation::target_resolver::update_target(&db, &id, &patch)
}

#[tauri::command]
pub fn nav_delete_target(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    navigation::target_resolver::delete_target(&db, &id)
}

#[tauri::command]
pub fn nav_recent_logs(
    db: State<'_, Arc<Db>>,
    limit: Option<i64>,
) -> AppResult<Vec<navigation::target_resolver::NavLogRow>> {
    navigation::target_resolver::recent_logs(&db, limit.unwrap_or(50))
}

#[tauri::command]
pub fn nav_prune_logs(db: State<'_, Arc<Db>>, keep: Option<i64>) -> AppResult<usize> {
    navigation::target_resolver::prune_logs(&db, keep.unwrap_or(200))
}

// ── 任务关联 ────────────────────────────────────────────────

#[tauri::command]
pub fn nav_link_task(
    db: State<'_, Arc<Db>>,
    task_id: String,
    target_id: String,
    is_default: Option<bool>,
    launch_behavior: Option<String>,
) -> AppResult<String> {
    navigation::target_resolver::link_task(
        &db,
        &task_id,
        &target_id,
        is_default.unwrap_or(false),
        launch_behavior.as_deref().unwrap_or("default"),
    )
}

#[tauri::command]
pub fn nav_unlink_task(db: State<'_, Arc<Db>>, link_id: String) -> AppResult<()> {
    navigation::target_resolver::unlink_task(&db, &link_id)
}

#[tauri::command]
pub fn nav_update_task_link(
    db: State<'_, Arc<Db>>,
    link_id: String,
    display_order: Option<i64>,
    is_default: Option<bool>,
    launch_behavior: Option<String>,
) -> AppResult<()> {
    navigation::target_resolver::update_task_link(
        &db,
        &link_id,
        display_order,
        is_default,
        launch_behavior.as_deref(),
    )
}

#[tauri::command]
pub fn nav_task_targets(
    db: State<'_, Arc<Db>>,
    task_id: String,
) -> AppResult<Vec<navigation::target_resolver::TaskNavLinkRow>> {
    navigation::target_resolver::task_targets(&db, &task_id)
}

/// 全部任务关联（任务卡批量渲染；含各目标实时运行状态）。
#[tauri::command]
pub fn nav_all_task_links(
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<navigation::target_resolver::TaskNavLinkRow>> {
    navigation::target_resolver::all_task_links(&db)
}

// ── 统一跳转 ────────────────────────────────────────────────

#[tauri::command]
pub async fn nav_navigate(
    db: State<'_, Arc<Db>>,
    app: AppHandle,
    target_id: String,
    options: Option<NavigateOptions>,
) -> AppResult<navigation::NavigationResult> {
    let db = db.inner().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(router::navigate(&db, &app, &target_id, &options))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("导航任务失败: {}", e)))?
}

// ── Agent 导航 ──────────────────────────────────────────────

#[tauri::command]
pub fn nav_agent_capabilities(
    source_id: String,
) -> navigation::agent_navigation::AgentNavCapabilities {
    navigation::agent_navigation::capabilities(&source_id)
}

/// Agent 树按钮动作：open_app | focus_window。
#[tauri::command]
pub async fn nav_agent_action(
    db: State<'_, Arc<Db>>,
    source_id: String,
    action: String,
) -> AppResult<navigation::NavigationResult> {
    let settings = crate::db::Settings::load(&db).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(match action.as_str() {
            "open_app" => navigation::agent_navigation::launch_agent(&source_id),
            "focus_window" => {
                navigation::agent_navigation::focus_agent(&source_id, settings.nav_allow_launch)
            }
            other => navigation::NavigationResult::failure(
                &source_id,
                other,
                format!("未知 Agent 动作: {}", other),
            ),
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("Agent 动作失败: {}", e)))?
}

/// 为 Agent 打开工作区目录（IDE 类；目录必须存在）。
#[tauri::command]
pub async fn nav_agent_open_workspace(
    source_id: String,
    dir: String,
) -> AppResult<navigation::NavigationResult> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(navigation::agent_navigation::open_workspace(&source_id, &dir))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("工作区打开失败: {}", e)))?
}
