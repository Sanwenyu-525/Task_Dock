//! 重复文件删除命令（薄命令层）。
//!
//! 真正的校验与删除在 [`crate::file_workspace::duplicates`]，调度在
//! [`crate::fsops::start_delete_duplicates`]：这里只做参数转交，不实现业务逻辑。
//!
//! 契约变化（相对 v0.x 的同步返回）：本命令现在返回 `JobSnapshot`，
//! 逐项结果由 `fs_job_report(jobId)` 读取、取消由 `fs_job_cancel(jobId)` 传播，
//! 与复制/移动/删除等任务完全一致（不再有第二套进度与取消通道）。

use tauri::AppHandle;

use crate::error::AppResult;
use crate::file_workspace::duplicates::DuplicateDeleteGroup;
use crate::fsops::{self, JobSnapshot};

/// 删除已在 SHA-256 上确认的重复文件。每个组至少保留 `keepPath`；
/// 服务端重新哈希并复核文件身份后才进入回收站，任何无法验证的文件只跳过并报告。
#[tauri::command]
pub fn fs_delete_verified_duplicates(
    app: AppHandle,
    groups: Vec<DuplicateDeleteGroup>,
    operation_id: Option<String>,
) -> AppResult<JobSnapshot> {
    fsops::start_delete_duplicates(&app, groups, operation_id)
}
