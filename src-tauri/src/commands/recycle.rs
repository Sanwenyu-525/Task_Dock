//! 回收站与统一文件操作的命令层。
//!
//! 命令只做参数校验与状态转交；索引、扫描、Shell 操作都在
//! `recycle::` / `fsops::` 核心层，便于单元测试与非 Windows 编译。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::fsops::{self, JobRegistry, JobSnapshot};
use crate::recycle::index::{RecyclePage, RecycleQuery, RecycleStats};
use crate::recycle::ops::parse_restore_conflict;
use crate::recycle::{RecycleService, SyncStatus};

fn protected_dirs(app: &AppHandle) -> Vec<PathBuf> {
    std::env::var_os("TASK_DOCK_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .into_iter()
        .collect()
}

/// 统计：纯索引口径，毫秒级。
#[tauri::command]
pub fn recycle_stats(service: State<'_, Arc<RecycleService>>) -> AppResult<RecycleStats> {
    service.stats()
}

/// 分页列表（搜索/筛选/排序全部在 SQL 完成）。
#[tauri::command]
pub fn recycle_list(
    service: State<'_, Arc<RecycleService>>,
    query: RecycleQuery,
) -> AppResult<RecyclePage> {
    service.page(&query)
}

/// 启动后台增量同步；`force=false` 时按 8 秒节流（视图轮询使用）。
#[tauri::command]
pub fn recycle_sync(
    app: AppHandle,
    service: State<'_, Arc<RecycleService>>,
    force: bool,
) -> SyncStatus {
    service.start_sync(&app, force)
}

#[tauri::command]
pub fn recycle_sync_status(service: State<'_, Arc<RecycleService>>) -> SyncStatus {
    service.sync_status()
}

#[tauri::command]
pub fn recycle_sync_cancel(service: State<'_, Arc<RecycleService>>) {
    service.cancel_sync();
}

/// 批量删除（普通文件路径）：默认进回收站，`permanent=true` 永久删除。
/// 复用文件工作区成熟的删除语义（重解析点、盘符根保护、逐条报告）。
#[tauri::command]
pub fn fs_delete_job_start(
    app: AppHandle,
    paths: Vec<String>,
    permanent: bool,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    if paths.len() > 200_000 {
        return Err(AppError::Validation("单次最多 20 万项".into()));
    }
    let protected = protected_dirs(&app);
    for raw in &paths {
        let path = crate::file_workspace::validate_abs_path(raw)?;
        crate::file_workspace::ensure_not_protected(&path, &protected)?;
        if crate::recycle::volume::is_under_recycle_bin(&path) {
            return Err(AppError::Validation(
                "回收站内部路径不能作为普通文件删除；请使用回收站操作".into(),
            ));
        }
    }
    fsops::start_delete(&app, paths, permanent, protected, operation_id)
}

#[tauri::command]
pub fn fs_job_status(registry: State<'_, Arc<JobRegistry>>, job_id: String) -> AppResult<JobSnapshot> {
    registry
        .get(&job_id)
        .map(|handle| handle.snapshot())
        .ok_or_else(|| AppError::NotFound("任务不存在或已过期".into()))
}

/// 复制/移动/批量重命名的逐项完整结果。未执行时为 null，任务过期则报 NotFound。
#[tauri::command]
pub fn fs_job_report(
    registry: State<'_, Arc<JobRegistry>>,
    job_id: String,
) -> AppResult<Option<crate::file_workspace::FsOpReport>> {
    let handle = registry.get(&job_id)
        .ok_or_else(|| AppError::NotFound("任务不存在或已过期".into()))?;
    Ok(handle.report())
}

#[tauri::command]
pub fn fs_batch_rename_job_start(
    app: AppHandle,
    items: Vec<crate::file_workspace::BatchRenameItem>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    fsops::start_rename(&app, items, operation_id)
}

/// 将文件工作区选中的现有文件或目录作为仅复制的 Windows OLE 数据源。
#[tauri::command]
pub async fn fs_drag_out(app: AppHandle, paths: Vec<String>) -> AppResult<()> {
    if paths.is_empty() || paths.len() > 500 {
        return Err(AppError::Validation("拖出需要选择 1 至 500 项".into()));
    }
    let protected = protected_dirs(&app);
    let paths = tauri::async_runtime::spawn_blocking(move || {
        paths.iter().map(|raw| {
            let path = crate::file_workspace::validate_abs_path(raw)?;
            crate::file_workspace::ensure_not_protected(&path, &protected)?;
            if path.parent().is_none() || crate::recycle::volume::is_under_recycle_bin(&path) {
                return Err(AppError::Validation("不支持拖出卷根目录或回收站内容".into()));
            }
            std::fs::metadata(&path)?;
            Ok(path)
        }).collect::<AppResult<Vec<_>>>()
    }).await.map_err(|e| AppError::Unavailable(format!("校验拖出路径失败: {e}")))??;
    crate::shelf::drag_out::drag_on_main_thread(&app, paths, false).await?;
    Ok(())
}

/// 复制任务：批量复制到目标目录，进度/结果走统一任务事件。
#[tauri::command]
pub fn fs_copy_job_start(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    fsops::start_copy(
        &app,
        paths,
        target_dir,
        conflict.unwrap_or_else(|| "rename".into()),
        operation_id,
    )
}

/// 移动任务：批量移动到目标目录，进度/结果走统一任务事件。
#[tauri::command]
pub fn fs_move_job_start(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    fsops::start_move(
        &app,
        paths,
        target_dir,
        conflict.unwrap_or_else(|| "rename".into()),
        operation_id,
    )
}

#[tauri::command]
pub fn fs_job_cancel(registry: State<'_, Arc<JobRegistry>>, job_id: String) -> AppResult<bool> {
    let handle = registry
        .get(&job_id)
        .ok_or_else(|| AppError::NotFound("任务不存在或已过期".into()))?;
    // 返回是否真的生效：已终态或执行期不可安全取消时返回 false，UI 不得显示假取消。
    Ok(handle.cancel())
}

#[tauri::command]
pub fn fs_jobs(registry: State<'_, Arc<JobRegistry>>) -> Vec<JobSnapshot> {
    registry.snapshots()
}

/// 从回收站恢复。`conflict`: skip（默认，不覆盖）/ rename（自动加序号）。
#[tauri::command]
pub fn recycle_restore(
    app: AppHandle,
    service: State<'_, Arc<RecycleService>>,
    ids: Vec<String>,
    conflict: String,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    let policy = parse_restore_conflict(&conflict)?;
    let protected = protected_dirs(&app);
    // 恢复到应用数据目录属于危险写入：直接拒绝（用户可在资源管理器中手动恢复）。
    for item in service
        .db()
        .with_read(|conn| crate::recycle::index::resolve(conn, &ids))?
    {
        let target = crate::file_workspace::validate_abs_path(&item.original_path)?;
        crate::file_workspace::ensure_not_protected(&target, &protected)?;
    }
    fsops::start_restore(&app, ids, policy, operation_id)
}

/// 从回收站永久删除选中项目。
#[tauri::command]
pub fn recycle_purge(
    app: AppHandle,
    ids: Vec<String>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    fsops::start_purge(&app, ids, operation_id)
}

/// 清空回收站（全部卷或指定卷）。永久删除，调用方必须先完成二次确认。
#[tauri::command]
pub fn recycle_empty(
    app: AppHandle,
    volumes: Option<Vec<String>>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    fsops::start_empty(&app, fsops::EmptyRequest { volumes }, operation_id)
}
