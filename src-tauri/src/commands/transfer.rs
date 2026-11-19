//! 工作篮 / 上下文 / 实体关联的 IPC 命令。
//!
//! 命令只做参数校验与状态注入，业务全部在 `transfer::{store, execute, links, context}`，
//! 不在此重复文件操作或数据库逻辑。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::transfer::context::TransferContext;
use crate::transfer::links::{EntityLink, LinkInput, RelatedEntity};
use crate::transfer::{
    batches, context, execute, links, store, BatchUndoResult, TargetValidation, TransferAddReport,
    TransferBatch, TransferCounts, TransferFilter, TransferItem, TransferItemInput,
    TransferItemPatch, TransferOptions, TransferPage, TransferPreview, TransferRemoveReport,
    TransferTarget,
};

fn ids_or_err(ids: Vec<String>) -> AppResult<Vec<String>> {
    let cleaned: Vec<String> = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Err(crate::error::AppError::Validation("没有选择条目".into()));
    }
    Ok(cleaned)
}

fn clipboard_root(app: &AppHandle) -> PathBuf {
    use tauri::Manager;
    app.try_state::<Arc<crate::clipboard::ClipboardRuntime>>()
        .map(|state| state.inner().root.clone())
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
pub fn transfer_add(db: State<'_, Arc<Db>>, items: Vec<TransferItemInput>) -> AppResult<TransferAddReport> {
    store::add_items(&db, items)
}

#[tauri::command]
pub fn transfer_list(db: State<'_, Arc<Db>>, filter: Option<TransferFilter>) -> AppResult<TransferPage> {
    store::list(&db, &filter.unwrap_or_default())
}

#[tauri::command]
pub fn transfer_get(db: State<'_, Arc<Db>>, item_id: String) -> AppResult<TransferItem> {
    store::get(&db, &item_id)
}

#[tauri::command]
pub fn transfer_update(
    db: State<'_, Arc<Db>>,
    item_id: String,
    patch: TransferItemPatch,
) -> AppResult<TransferItem> {
    store::update(&db, &item_id, &patch)
}

#[tauri::command]
pub fn transfer_remove(db: State<'_, Arc<Db>>, ids: Vec<String>) -> AppResult<TransferRemoveReport> {
    let ids = ids_or_err(ids)?;
    Ok(TransferRemoveReport {
        removed: store::remove(&db, &ids)?,
    })
}

#[tauri::command]
pub fn transfer_reorder(db: State<'_, Arc<Db>>, ids: Vec<String>) -> AppResult<()> {
    let ids = ids_or_err(ids)?;
    store::reorder(&db, &ids)
}

#[tauri::command]
pub fn transfer_pin(db: State<'_, Arc<Db>>, item_id: String, pinned: bool) -> AppResult<TransferItem> {
    store::pin(&db, &item_id, pinned)
}

#[tauri::command]
pub fn transfer_clear_temporary(db: State<'_, Arc<Db>>) -> AppResult<usize> {
    store::clear_temporary(&db)
}

#[tauri::command]
pub fn transfer_counts(db: State<'_, Arc<Db>>) -> AppResult<TransferCounts> {
    store::counts(&db)
}

#[tauri::command]
pub fn transfer_validate_target(target: TransferTarget) -> AppResult<TargetValidation> {
    Ok(execute::validate_target(&target))
}

#[tauri::command]
pub fn transfer_preview(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    ids: Vec<String>,
    target: TransferTarget,
    options: Option<TransferOptions>,
) -> AppResult<TransferPreview> {
    let ids = ids_or_err(ids)?;
    let root = clipboard_root(&app);
    execute::preview(
        &db,
        &root,
        &ids,
        &target,
        &options.unwrap_or_default(),
    )
}

#[tauri::command]
pub fn transfer_execute(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    ids: Vec<String>,
    target: TransferTarget,
    options: Option<TransferOptions>,
    operation_id: Option<String>,
) -> AppResult<TransferBatch> {
    let _ = &db;
    let ids = ids_or_err(ids)?;
    execute::start(
        &app,
        &ids,
        &target,
        &options.unwrap_or_default(),
        operation_id,
    )
}

#[tauri::command]
pub fn transfer_batch(app: AppHandle, batch_id: String) -> AppResult<TransferBatch> {
    execute::refresh(&app, &batch_id)
}

#[tauri::command]
pub fn transfer_batches(db: State<'_, Arc<Db>>, limit: Option<usize>) -> AppResult<Vec<TransferBatch>> {
    batches::list(&db, limit.unwrap_or(20))
}

#[tauri::command]
pub fn transfer_retry(
    app: AppHandle,
    batch_id: String,
    options: Option<TransferOptions>,
) -> AppResult<TransferBatch> {
    execute::retry(&app, &batch_id, &options.unwrap_or_default())
}

#[tauri::command]
pub fn transfer_undo(app: AppHandle, batch_id: String) -> AppResult<BatchUndoResult> {
    execute::undo(&app, &batch_id)
}

#[tauri::command]
pub fn transfer_context_get(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<context::ContextState>>,
) -> AppResult<TransferContext> {
    Ok(state.get(window.label()))
}

#[tauri::command]
pub fn transfer_context_update(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<context::ContextState>>,
    patch: TransferContext,
) -> AppResult<TransferContext> {
    let next = state.update(window.label(), patch);
    context::publish(&app, &next);
    Ok(next)
}

#[tauri::command]
pub fn transfer_context_clear(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<context::ContextState>>,
) -> AppResult<TransferContext> {
    let next = state.clear(window.label());
    context::publish(&app, &next);
    Ok(next)
}

#[tauri::command]
pub fn entity_link_create(db: State<'_, Arc<Db>>, input: LinkInput) -> AppResult<EntityLink> {
    links::create_link(&db, &input)
}

#[tauri::command]
pub fn entity_link_batch(
    db: State<'_, Arc<Db>>,
    inputs: Vec<LinkInput>,
) -> AppResult<serde_json::Value> {
    let (created, failed) = links::batch_create(&db, inputs)?;
    Ok(serde_json::json!({
        "created": created,
        "failed": failed.into_iter().map(|(target, message)| serde_json::json!({
            "target": target,
            "message": message,
        })).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub fn entity_link_remove(db: State<'_, Arc<Db>>, link_id: String) -> AppResult<bool> {
    links::remove_link(&db, &link_id)
}

#[tauri::command]
pub fn entity_link_unlink(
    db: State<'_, Arc<Db>>,
    source_type: String,
    source_id: String,
    target_type: String,
    target_id: String,
    relation: Option<String>,
) -> AppResult<usize> {
    links::unlink(
        &db,
        &source_type,
        &source_id,
        &target_type,
        &target_id,
        relation.as_deref(),
    )
}

#[tauri::command]
pub fn entity_link_related(
    db: State<'_, Arc<Db>>,
    entity_type: String,
    entity_id: String,
) -> AppResult<Vec<RelatedEntity>> {
    links::related(&db, &entity_type, &entity_id)
}
