//! 安全审计查询与显式清理命令（`security_audit_log`，迁移 v82）。
//!
//! 只读投影 + 用户显式清理：查询不返回也不修改业务数据；清理只按显式调用执行，
//! 不在启动时静默运行。表内不含配对码/token/密钥/指纹值等敏感内容
//! （subject 为库内 UUID 或最小化网段），字段全集返回。
//!
//! **接线待办（主智能体执行，本文件自身不触碰 lib.rs / commands/mod.rs）**：
//! 1. `commands/mod.rs`：`pub mod security_audit;`
//! 2. `lib.rs`：`pub mod security_audit;`（crate 根模块声明）
//! 3. `lib.rs` `generate_handler!` 注册：
//!    `commands::security_audit::security_audit_query,`
//!    `commands::security_audit::security_audit_prune,`

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::security_audit::{
    list_page, prune, AuditFilter, AuditPage, PruneReport, DEFAULT_DETAIL_DAYS,
    DEFAULT_METADATA_DAYS,
};

/// 分页查询安全审计事件（新 → 旧）。
///
/// 参数（camelCase，全部可选）：`category` / `eventType` / `from` / `to`
/// （RFC3339 时间边界）/ `limit`（1..=100，默认 50）/ `offset`。
#[tauri::command]
pub fn security_audit_query(
    db: State<'_, Arc<Db>>,
    category: Option<String>,
    event_type: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<AuditPage> {
    let filter = AuditFilter {
        category,
        event_type,
        from,
        to,
        limit,
        offset,
    };
    list_page(&db, filter)
}

/// 显式清理安全审计（两段式：先清明细、再删行）。
///
/// `metadataDays` 默认 90、`detailDays` 默认 30；`detailDays` 不得大于
/// `metadataDays`。启动路径**不得**调用本命令。
#[tauri::command]
pub fn security_audit_prune(
    db: State<'_, Arc<Db>>,
    metadata_days: Option<i64>,
    detail_days: Option<i64>,
) -> AppResult<PruneReport> {
    prune(
        &db,
        metadata_days.unwrap_or(DEFAULT_METADATA_DAYS),
        detail_days.unwrap_or(DEFAULT_DETAIL_DAYS),
    )
}
