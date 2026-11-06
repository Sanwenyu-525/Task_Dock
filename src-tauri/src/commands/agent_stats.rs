//! Agent 工作时间统计命令（只读聚合，不修改任何 Agent 运行状态）。
//!
//! 注册位置（由集成会话合并，本任务不直接改共享文件）：
//! - `src-tauri/src/lib.rs`：`mod agent_stats;`（模块声明）
//! - `src-tauri/src/commands/mod.rs`：`pub mod agent_stats;`
//! - `src-tauri/src/lib.rs` 的 `generate_handler!`：`commands::agent_stats::agent_work_time_stats`
//!
//! 单次查询最多回放 15 万条事件（`agent_stats::MAX_EVENTS`），属于秒级数据库读。
//! Tauri 的同步命令在主线程执行，会阻塞窗口消息循环，因此与 `agent_snapshot` 之外的
//! 重查询一致：搬到 `spawn_blocking`，前端仍是普通 promise，签名不变。

use std::sync::Arc;

use chrono::Utc;
use tauri::State;

use crate::agent_stats::{compute, WorkTimeStats, WorkTimeStatsQuery};
use crate::db::Db;
use crate::error::{AppError, AppResult};

#[tauri::command]
pub async fn agent_work_time_stats(
    db: State<'_, Arc<Db>>,
    query: WorkTimeStatsQuery,
) -> AppResult<WorkTimeStats> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.with_read(|conn| compute(conn, &query, Utc::now()))
    })
    .await
    .map_err(|e| AppError::Agent(format!("工作时间统计任务失败: {e}")))?
}
