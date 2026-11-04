//! 全局搜索命令：薄壳。实际查询与排序在 `crate::global_search`。
//!
//! async + spawn_blocking：搜索走 SQLite 读连接池，绝不阻塞 Tauri 主线程；
//! 持有的只是 `Arc<Db>` 克隆，不长期占用连接。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::global_search::{run_search, GlobalSearchResponse};

/// 统一只读搜索。
/// - `query`：关键词（后端 trim/截断，空串返回空结果）；
/// - `categories`：可选分类过滤（`tasks|clipboard|capture|shelf|apps|agents|workspace|planning`），
///   缺省/空数组 = 全部分类；非法值返回 Validation 错误；
/// - `limit_per_category`：每类返回上限，缺省 6、上限 20。
#[tauri::command]
pub async fn global_search(
    db: State<'_, Arc<Db>>,
    query: String,
    categories: Option<Vec<String>>,
    limit_per_category: Option<u32>,
) -> AppResult<GlobalSearchResponse> {
    let db = db.inner().clone();
    let cats = categories.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        run_search(&db, &query, &cats, limit_per_category.unwrap_or(0))
    })
    .await
    .map_err(|e| crate::error::AppError::Agent(format!("搜索任务失败: {}", e)))?
}
