//! 回收站与统一文件操作的命令层。
//!
//! 命令只做参数校验与状态转交；索引、扫描、Shell 操作都在
//! `recycle::` / `fsops::` 核心层，便于单元测试与非 Windows 编译。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::diagnostics::trace;
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

/// 解析前端传入的可选 `trace_id`（与 shelf/agents 命令同一契约）：
/// - `None`（旧调用方不传）→ `None`，事件不挂链路，行为与旧版完全一致；
/// - 合法 16 位小写 hex → 沿用；
/// - 非法（大写/超长/非 hex/空）→ 丢弃并重新生成一个新链路 ID，不报错、不透传。
///
/// **只用于诊断事件关联，绝不参与任何认证/授权判断。**
fn resolve_external_trace(raw: &Option<String>) -> Option<String> {
    match raw.as_deref().and_then(trace::validate_external_id) {
        Some(valid) => Some(valid),
        None => match raw {
            Some(_) => Some(trace::new_trace_id()),
            None => None,
        },
    }
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
    let started = std::time::Instant::now();
    let result = service.page(&query);
    match &result {
        Ok(_) => crate::diagnostics::metrics::record_duration_async("recycle", "list", started),
        Err(e) => crate::diagnostics::metrics::record_failure("recycle", "list", e),
    }
    result
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
/// `trace_id` 为可选诊断链路标识：合法沿用、非法丢弃并重新生成、None 不挂链路；
/// 只用于诊断事件关联，**不参与认证/授权**。
#[tauri::command]
pub fn fs_copy_job_start(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
    trace_id: Option<String>,
) -> AppResult<JobSnapshot> {
    let trace = resolve_external_trace(&trace_id);
    fsops::start_copy_traced(
        &app,
        paths,
        target_dir,
        conflict.unwrap_or_else(|| "rename".into()),
        operation_id,
        trace,
    )
}

/// 移动任务：批量移动到目标目录，进度/结果走统一任务事件。`trace_id` 语义同复制。
#[tauri::command]
pub fn fs_move_job_start(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    conflict: Option<String>,
    operation_id: Option<String>,
    trace_id: Option<String>,
) -> AppResult<JobSnapshot> {
    let trace = resolve_external_trace(&trace_id);
    fsops::start_move_traced(
        &app,
        paths,
        target_dir,
        conflict.unwrap_or_else(|| "rename".into()),
        operation_id,
        trace,
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
/// 逐项校验与占用声明都在任务内完成：无效/已消失/受保护的条目各自产生失败结果。
#[tauri::command]
pub fn recycle_restore(
    app: AppHandle,
    ids: Vec<String>,
    conflict: String,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    let policy = parse_restore_conflict(&conflict)?;
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

#[cfg(test)]
mod trace_wiring_tests {
    use super::*;
    use crate::diagnostics::trace;

    #[test]
    fn valid_trace_is_adopted() {
        let valid = "0123456789abcdef";
        assert_eq!(
            resolve_external_trace(&Some(valid.to_string())).as_deref(),
            Some(valid)
        );
    }

    #[test]
    fn invalid_trace_is_dropped_and_regenerated() {
        let cases = [
            "0123456789ABCDEF", // 大写非法
            "not-a-trace!!",   // 非 hex
            "0123456789abcde", // 长度不足
            "",                // 空串
        ];
        for bad in cases {
            let resolved = resolve_external_trace(&Some(bad.to_string()))
                .expect("非法 trace 应被替换为新生成的链路 ID");
            assert_ne!(resolved, bad);
            assert!(
                trace::validate_external_id(&resolved).is_some(),
                "重新生成的 ID 必须合法: {resolved}"
            );
        }
        // 超长同样丢弃并重新生成。
        let overlong = "x".repeat(64);
        let resolved = resolve_external_trace(&Some(overlong)).expect("超长 trace 应被替换");
        assert!(trace::validate_external_id(&resolved).is_some());
    }

    #[test]
    fn none_trace_keeps_no_context() {
        // 旧调用方不传：保持无链路上下文，行为与旧版一致。
        assert!(resolve_external_trace(&None).is_none());
    }

    #[test]
    fn event_builder_attaches_trace_to_event() {
        let trace_id = trace::new_trace_id();
        let event = crate::diagnostics::event(
            crate::diagnostics::DiagLevel::Info,
            "file",
            "fs_copy_job_start",
            "success",
        )
        .trace(&trace_id)
        .build();
        assert_eq!(event.trace_id.as_deref(), Some(trace_id.as_str()));
    }
}
