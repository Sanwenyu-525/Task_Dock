//! 安全审计查询与显式清理命令（多源统一查询适配层，契约见
//! `tmp/acceptance/logging-phase2/interfaces.md` §3.1）。
//!
//! 只读投影 + 用户显式清理：查询不返回也不修改业务数据；清理只按显式调用执行，
//! 不在启动时静默运行。未接入/不可读来源通过 `sources[]` 覆盖状态显式返回，
//! 不吞成空列表。
//!
//! **接线待办（主智能体执行，本文件自身不触碰 lib.rs / commands/mod.rs）**：
//! 1. `commands/mod.rs`：`pub mod security_audit;`（已存在）
//! 2. `lib.rs`：`pub mod security_audit;`（已存在）
//! 3. `lib.rs` `generate_handler!` 注册：
//!    `commands::security_audit::security_audit_query,`
//!    `commands::security_audit::security_audit_prune,`（已注册；查询命令签名已从
//!    散参数改为单一 `filter` 对象，注册项无需改动）

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::secure_vault::VaultState;
use crate::security_audit::{
    prune, unified_query, AuditFilterArgs, AuditSources, PruneReport, TauriVaultSource,
    UnifiedAuditPage, VaultAuditReader, DEFAULT_DETAIL_DAYS, DEFAULT_METADATA_DAYS,
};

/// 分页查询安全审计事件（多源合并，新 → 旧）。
///
/// 单一 `filter` 对象（camelCase，全部可选）：`source` / `category` / `eventType` /
/// `result` / `device` / `from` / `to`（RFC3339 时间边界）/ `limit`（1..=100，
/// 默认 50）/ `offset`。未接入或不可读来源在返回的 `sources[]` 中标注状态。
#[tauri::command]
pub fn security_audit_query(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    filter: AuditFilterArgs,
) -> AppResult<UnifiedAuditPage> {
    // 保险箱 State 由主进程 manage；未 manage（结构不可达）时按未接线处理，不报错。
    let vault = app
        .try_state::<Arc<VaultState>>()
        .map(|state| TauriVaultSource::new(state.inner().clone()));
    let sources = AuditSources {
        vault: vault.as_ref().map(|v| v as &dyn VaultAuditReader),
        // Personal Hub 运行在独立进程，主进程尚无 ph_audit_log 只读入口（见 adapter 注释）。
        hub: None,
    };
    unified_query(db.inner(), &filter, &sources)
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
