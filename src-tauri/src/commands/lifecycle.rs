//! 功能生命周期命令：只读批量快照。
//!
//! 写入仍然走 `update_settings`（单一事实源）；这里不提供第二套暂停命令，
//! 避免出现「生命周期接口写一套状态、设置页写另一套状态」的分叉。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::lifecycle::{snapshot, ModuleRuntimeStatus};

/// 一次查询全部模块的实际运行状态。
///
/// 调用方只在资源管理「功能运行」分区可见或操作完成后调用；本命令不注册
/// 轮询、不缓存、不持有全局锁，单次执行只读取设置与各运行时线程探针。
#[tauri::command]
pub fn lifecycle_status(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<ModuleRuntimeStatus>> {
    Ok(snapshot(&app, &db))
}
