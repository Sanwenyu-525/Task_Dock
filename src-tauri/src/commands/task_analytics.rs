//! 任务统计与趋势分析命令层。
//!
//! 只做参数收敛与转发：统计口径、时间分桶与查询全部在 `crate::task_analytics`。
//! 前端通过 `tasks.stats-trends` 统计子视图调用，打开时按需查询，不做轮询。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::task_analytics::TaskAnalytics;

/// 读取任务统计。`range`：day（默认）/ week / month。
#[tauri::command]
pub fn task_analytics(db: State<'_, Arc<Db>>, range: Option<String>) -> AppResult<TaskAnalytics> {
    crate::task_analytics::report(&db, range.as_deref())
}
