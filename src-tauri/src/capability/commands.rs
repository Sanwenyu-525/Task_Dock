//! 能力中心 Tauri 命令：参数归一 + 状态注入，业务校验在 `*_impl` 内完成。
//!
//! 长任务（文件扫描/索引重建/MCP 连接与调用）一律 `spawn_blocking`，不阻塞主线程；
//! 返回值全部 camelCase（由各结构体的 serde 属性保证）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::context::{
    self, ContextBundle, ContextConfig, ContextInput, ContextProfile,
};
use super::external_mcp::{
    self, ExternalMcpServer, McpCallPage, McpCallReport, McpConnectionReport, McpServerInput,
};
use super::knowledge::{
    self, DeleteDocReport, DeleteKbReport, DocumentPage, ImportReport, KnowledgeBacklink,
    KnowledgeBase, KnowledgeBaseDetail, KnowledgeBaseInput, KnowledgeBasePatch, KnowledgeDocument,
    KnowledgeDocumentDetail, KnowledgeLink, KnowledgeSearchPage, KnowledgeStats, RebuildReport,
};
use super::recipes::{
    self, Recipe, RecipeInput, RecipeRun, RecipeRunPage, RecipeSummary,
};
use super::skills::{self, SkillDetail, SkillScanReport, SkillSummary};

fn data_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Validation(format!("无法解析应用数据目录: {e}")))
}

async fn blocking<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| AppError::Agent(format!("后台任务失败: {e}")))?
}

// ── 知识库 ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn capability_knowledge_stats(db: State<'_, Arc<Db>>) -> AppResult<KnowledgeStats> {
    knowledge::stats_impl(&db)
}

#[tauri::command]
pub fn capability_kb_list(
    db: State<'_, Arc<Db>>,
    query: Option<String>,
    kind: Option<String>,
    scope: Option<String>,
    project_id: Option<String>,
) -> AppResult<Vec<KnowledgeBase>> {
    // scope 缺省 = all（兼容旧调用与全局管理列表）；项目视图必须显式传 projectId。
    knowledge::list_bases_scoped_impl(
        &db,
        query.as_deref(),
        kind.as_deref(),
        scope.as_deref(),
        project_id.as_deref(),
    )
}

#[tauri::command]
pub fn capability_kb_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<KnowledgeBaseDetail> {
    knowledge::get_base_impl(&db, &id)
}

#[tauri::command]
pub fn capability_kb_create(
    db: State<'_, Arc<Db>>,
    input: KnowledgeBaseInput,
) -> AppResult<KnowledgeBase> {
    knowledge::create_base_impl(&db, input)
}

#[tauri::command]
pub fn capability_kb_update(
    db: State<'_, Arc<Db>>,
    id: String,
    input: KnowledgeBasePatch,
) -> AppResult<KnowledgeBase> {
    knowledge::update_base_impl(&db, &id, input)
}

#[tauri::command]
pub async fn capability_kb_delete(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<DeleteKbReport> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || knowledge::delete_base_impl(&db, &dir, &id)).await
}

#[tauri::command]
pub fn capability_kb_set_favorite(
    db: State<'_, Arc<Db>>,
    id: String,
    favorite: bool,
) -> AppResult<KnowledgeBase> {
    knowledge::set_favorite_impl(&db, &id, favorite)
}

#[tauri::command]
pub fn capability_document_list(
    db: State<'_, Arc<Db>>,
    kb_id: String,
    query: Option<String>,
    status: Option<String>,
    source_kind: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<DocumentPage> {
    knowledge::list_documents_impl(
        &db,
        &kb_id,
        query.as_deref(),
        status.as_deref(),
        source_kind.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(50),
    )
}

#[tauri::command]
pub fn capability_document_get(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<KnowledgeDocumentDetail> {
    knowledge::get_document_impl(&db, &id)
}

#[tauri::command]
pub async fn capability_document_import_file(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    kb_id: String,
    path: String,
    mode: String,
    title: Option<String>,
) -> AppResult<ImportReport> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || {
        let (report, _) =
            knowledge::import_file_impl(&db, &dir, &kb_id, &path, &mode, title.as_deref())?;
        Ok(report)
    })
    .await
}

#[tauri::command]
pub async fn capability_document_import_folder(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    kb_id: String,
    path: String,
    mode: String,
) -> AppResult<ImportReport> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || knowledge::import_folder_impl(&db, &dir, &kb_id, &path, &mode)).await
}

#[tauri::command]
pub fn capability_document_import_note(
    db: State<'_, Arc<Db>>,
    kb_id: String,
    note_id: String,
) -> AppResult<ImportReport> {
    let (report, _) = knowledge::import_note_impl(&db, &kb_id, &note_id)?;
    Ok(report)
}

#[tauri::command]
pub fn capability_document_import_capture(
    db: State<'_, Arc<Db>>,
    kb_id: String,
    capture_id: String,
) -> AppResult<ImportReport> {
    let (report, _) = knowledge::import_capture_impl(&db, &kb_id, &capture_id)?;
    Ok(report)
}

#[tauri::command]
pub fn capability_document_create_text(
    db: State<'_, Arc<Db>>,
    kb_id: String,
    title: String,
    content: String,
) -> AppResult<ImportReport> {
    let (report, _) = knowledge::create_text_impl(&db, &kb_id, &title, &content)?;
    Ok(report)
}

#[tauri::command]
pub async fn capability_document_reindex(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<KnowledgeDocument> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || knowledge::reindex_document_impl(&db, &dir, &id)).await
}

#[tauri::command]
pub async fn capability_kb_rebuild(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    kb_id: String,
) -> AppResult<RebuildReport> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || knowledge::rebuild_kb_impl(&db, &dir, &kb_id)).await
}

#[tauri::command]
pub async fn capability_document_delete(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<DeleteDocReport> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || knowledge::delete_document_impl(&db, &dir, &id)).await
}

#[tauri::command]
pub fn capability_knowledge_search(
    db: State<'_, Arc<Db>>,
    query: String,
    kb_ids: Option<Vec<String>>,
    source_kind: Option<String>,
    project_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<KnowledgeSearchPage> {
    knowledge::search_impl(
        &db,
        &query,
        &kb_ids.unwrap_or_default(),
        source_kind.as_deref(),
        project_id.as_deref(),
        limit.unwrap_or(20),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
pub fn capability_knowledge_link_add(
    db: State<'_, Arc<Db>>,
    doc_id: String,
    target_kind: String,
    target_id: String,
    label: Option<String>,
) -> AppResult<Vec<KnowledgeLink>> {
    knowledge::add_link_impl(
        &db,
        &doc_id,
        &target_kind,
        &target_id,
        label.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub fn capability_knowledge_link_remove(
    db: State<'_, Arc<Db>>,
    doc_id: String,
    link_id: String,
) -> AppResult<Vec<KnowledgeLink>> {
    knowledge::remove_link_impl(&db, &doc_id, &link_id)
}

#[tauri::command]
pub fn capability_knowledge_links(
    db: State<'_, Arc<Db>>,
    doc_id: String,
) -> AppResult<Vec<KnowledgeLink>> {
    knowledge::list_links_impl(&db, &doc_id)
}

#[tauri::command]
pub fn capability_knowledge_backlinks(
    db: State<'_, Arc<Db>>,
    target_kind: String,
    target_id: String,
) -> AppResult<Vec<KnowledgeBacklink>> {
    knowledge::backlinks_impl(&db, &target_kind, &target_id)
}

// ── Skill ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn capability_skill_scan(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    extra_roots: Option<Vec<String>>,
) -> AppResult<SkillScanReport> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    let roots = extra_roots.unwrap_or_default();
    blocking(move || skills::scan_impl(&db, &dir, &roots)).await
}

#[tauri::command]
pub fn capability_skill_list(
    db: State<'_, Arc<Db>>,
    query: Option<String>,
    scope: Option<String>,
    risk: Option<String>,
    project_id: Option<String>,
) -> AppResult<Vec<SkillSummary>> {
    skills::list_impl(
        &db,
        query.as_deref(),
        scope.as_deref(),
        risk.as_deref(),
        project_id.as_deref(),
    )
}

#[tauri::command]
pub fn capability_skill_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<SkillDetail> {
    skills::get_impl(&db, &id)
}

#[tauri::command]
pub fn capability_skill_set_enabled(
    db: State<'_, Arc<Db>>,
    id: String,
    enabled: bool,
) -> AppResult<SkillSummary> {
    skills::set_enabled_impl(&db, &id, enabled)
}

#[tauri::command]
pub fn capability_skill_set_scope(
    db: State<'_, Arc<Db>>,
    id: String,
    scope: String,
    project_id: Option<String>,
    workspace_id: Option<String>,
    agent_id: Option<String>,
) -> AppResult<SkillSummary> {
    skills::set_scope_impl(
        &db,
        &id,
        &scope,
        project_id.as_deref(),
        workspace_id.as_deref(),
        agent_id.as_deref(),
    )
}

#[tauri::command]
pub async fn capability_skill_import(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    source_path: String,
    scope: Option<String>,
    project_id: Option<String>,
    workspace_id: Option<String>,
    agent_id: Option<String>,
) -> AppResult<SkillDetail> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || {
        skills::import_impl(
            &db,
            &dir,
            &source_path,
            scope.as_deref(),
            project_id.as_deref(),
            workspace_id.as_deref(),
            agent_id.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn capability_skill_save_content(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
    content: String,
) -> AppResult<SkillSummary> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || skills::save_content_impl(&db, &dir, &id, &content)).await
}

#[tauri::command]
pub async fn capability_skill_delete(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<bool> {
    let db = db.inner().clone();
    let dir = data_dir(&app)?;
    blocking(move || skills::delete_impl(&db, &dir, &id)).await
}

// ── 外部 MCP ──────────────────────────────────────────────────────

#[tauri::command]
pub fn capability_mcp_servers_list(
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<ExternalMcpServer>> {
    external_mcp::list_servers_impl(&db)
}

#[tauri::command]
pub fn capability_mcp_server_save(
    db: State<'_, Arc<Db>>,
    input: McpServerInput,
) -> AppResult<ExternalMcpServer> {
    external_mcp::save_server_impl(&db, input)
}

#[tauri::command]
pub fn capability_mcp_server_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<bool> {
    external_mcp::delete_server_impl(&db, &id)
}

#[tauri::command]
pub fn capability_mcp_server_set_enabled(
    db: State<'_, Arc<Db>>,
    id: String,
    enabled: bool,
) -> AppResult<ExternalMcpServer> {
    external_mcp::set_enabled_impl(&db, &id, enabled)
}

#[tauri::command]
pub fn capability_mcp_server_set_allow_high_risk(
    db: State<'_, Arc<Db>>,
    id: String,
    allow: bool,
) -> AppResult<ExternalMcpServer> {
    external_mcp::set_allow_high_risk_impl(&db, &id, allow)
}

#[tauri::command]
pub async fn capability_mcp_server_test(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<McpConnectionReport> {
    let db = db.inner().clone();
    blocking(move || external_mcp::test_server_impl(&db, &id)).await
}

#[tauri::command]
pub async fn capability_mcp_server_call(
    db: State<'_, Arc<Db>>,
    id: String,
    tool_name: String,
    args_json: String,
    confirmed: bool,
) -> AppResult<McpCallReport> {
    let db = db.inner().clone();
    blocking(move || {
        external_mcp::call_tool_impl(&db, &id, &tool_name, &args_json, confirmed)
    })
    .await
}

#[tauri::command]
pub fn capability_mcp_calls(
    db: State<'_, Arc<Db>>,
    server_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<McpCallPage> {
    external_mcp::list_calls_impl(
        &db,
        server_id.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(50),
    )
}

// ── 上下文 ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn capability_context_list(
    db: State<'_, Arc<Db>>,
    project_id: Option<String>,
) -> AppResult<Vec<ContextProfile>> {
    context::list_impl(&db, project_id.as_deref())
}

#[tauri::command]
pub fn capability_context_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<ContextProfile> {
    context::get_impl(&db, &id)
}

#[tauri::command]
pub fn capability_context_save(
    db: State<'_, Arc<Db>>,
    input: ContextInput,
) -> AppResult<ContextProfile> {
    context::save_impl(&db, input)
}

#[tauri::command]
pub fn capability_context_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<bool> {
    context::delete_impl(&db, &id)
}

#[tauri::command]
pub fn capability_context_duplicate(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<ContextProfile> {
    context::duplicate_impl(&db, &id)
}

#[tauri::command]
pub fn capability_context_assemble(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    config: Option<ContextConfig>,
    query: Option<String>,
    max_chars: Option<usize>,
) -> AppResult<ContextBundle> {
    context::assemble_impl(&db, id.as_deref(), config, query.as_deref(), max_chars)
}

// ── 配方 ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn capability_recipe_list(db: State<'_, Arc<Db>>) -> AppResult<Vec<RecipeSummary>> {
    recipes::list_impl(&db)
}

#[tauri::command]
pub fn capability_recipe_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<Recipe> {
    recipes::get_impl(&db, &id)
}

#[tauri::command]
pub fn capability_recipe_save(
    db: State<'_, Arc<Db>>,
    input: RecipeInput,
) -> AppResult<Recipe> {
    recipes::save_impl(&db, input)
}

#[tauri::command]
pub fn capability_recipe_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<bool> {
    recipes::delete_impl(&db, &id)
}

#[tauri::command]
pub fn capability_recipe_duplicate(db: State<'_, Arc<Db>>, id: String) -> AppResult<Recipe> {
    recipes::duplicate_impl(&db, &id)
}

#[tauri::command]
pub fn capability_recipe_export(
    db: State<'_, Arc<Db>>,
    id: String,
    include_secret_args: Option<bool>,
) -> AppResult<String> {
    recipes::export_impl(&db, &id, include_secret_args.unwrap_or(false))
}

#[tauri::command]
pub fn capability_recipe_import(db: State<'_, Arc<Db>>, json: String) -> AppResult<Recipe> {
    recipes::import_impl(&db, &json)
}

#[tauri::command]
pub async fn capability_recipe_run(
    db: State<'_, Arc<Db>>,
    id: String,
    confirmed: bool,
) -> AppResult<RecipeRun> {
    let db = db.inner().clone();
    blocking(move || recipes::run_impl(&db, &id, confirmed)).await
}

#[tauri::command]
pub fn capability_recipe_runs(
    db: State<'_, Arc<Db>>,
    recipe_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<RecipeRunPage> {
    recipes::list_runs_impl(
        &db,
        recipe_id.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(50),
    )
}

#[tauri::command]
pub fn capability_recipe_run_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<RecipeRun> {
    recipes::get_run_impl(&db, &id)
}
