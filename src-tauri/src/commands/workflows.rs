//! 一键工作流命令层：定义 CRUD、步骤编排、运行控制与运行历史查询。
//!
//! 控制类命令（run / pause / resume / cancel）只做槽位读写与标志置位，
//! 绝不在 IPC 线程内等待引擎或执行窗口操作；执行细节见 `crate::workflows::engine`。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::workflows::{engine, store, WorkflowRunDetail, WorkflowRunPage, WorkflowRow, WorkflowStepRow};

use super::format_local;

// ── 定义 CRUD ───────────────────────────────────────────────

#[tauri::command]
pub fn workflow_list(db: State<'_, Arc<Db>>) -> AppResult<Vec<WorkflowRow>> {
    store::list_workflows(&db)
}

#[tauri::command]
pub fn workflow_get(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<WorkflowDetail> {
    let (wf, steps) = store::get_workflow(&db, &id)?;
    Ok(WorkflowDetail { workflow: wf, steps })
}

/// 工作流详情（定义 + 有序步骤）。
#[derive(Debug, serde::Serialize)]
pub struct WorkflowDetail {
    #[serde(flatten)]
    pub workflow: WorkflowRow,
    pub steps: Vec<WorkflowStepRow>,
}

#[tauri::command]
pub fn workflow_create(
    db: State<'_, Arc<Db>>,
    input: crate::workflows::WorkflowInput,
) -> AppResult<WorkflowDetail> {
    let wf = store::create_workflow(&db, input)?;
    let steps = store::list_steps(&db, &wf.id)?;
    Ok(WorkflowDetail { workflow: wf, steps })
}

#[tauri::command]
pub fn workflow_update(
    db: State<'_, Arc<Db>>,
    id: String,
    patch: WorkflowPatch,
) -> AppResult<WorkflowDetail> {
    let wf = store::update_workflow(&db, &id, patch.name, patch.description, patch.enabled)?;
    let steps = store::list_steps(&db, &id)?;
    Ok(WorkflowDetail { workflow: wf, steps })
}

/// 工作流元信息补丁（字段缺省 = 不修改）。
#[derive(Debug, Default, serde::Deserialize)]
pub struct WorkflowPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
}

#[tauri::command]
pub fn workflow_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<()> {
    store::delete_workflow(&db, &id)
}

#[tauri::command]
pub fn workflow_duplicate(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<WorkflowDetail> {
    let wf = store::duplicate_workflow(&db, &id)?;
    let steps = store::list_steps(&db, &wf.id)?;
    Ok(WorkflowDetail { workflow: wf, steps })
}

#[tauri::command]
pub fn workflow_reorder(
    db: State<'_, Arc<Db>>,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    store::reorder_workflows(&db, &ordered_ids)
}

/// 编辑保存：元信息 + 步骤编排单事务写入，避免「步骤成功、元信息失败」的半保存。
#[tauri::command]
pub fn workflow_save(
    db: State<'_, Arc<Db>>,
    id: String,
    name: String,
    description: String,
    steps: Vec<crate::workflows::StepInput>,
) -> AppResult<WorkflowDetail> {
    let rows = store::replace_steps_and_update(&db, &id, name, description, steps)?;
    let (wf, _) = store::get_workflow(&db, &id)?;
    Ok(WorkflowDetail { workflow: wf, steps: rows })
}

/// 整表替换步骤编排（原子事务；步骤 ID 由前端生成以保持编辑稳定性）。
#[tauri::command]
pub fn workflow_replace_steps(
    db: State<'_, Arc<Db>>,
    id: String,
    steps: Vec<crate::workflows::StepInput>,
) -> AppResult<WorkflowDetail> {
    let rows = store::replace_steps(&db, &id, steps)?;
    let (wf, _) = store::get_workflow(&db, &id)?;
    Ok(WorkflowDetail { workflow: wf, steps: rows })
}

// ── 运行控制 ────────────────────────────────────────────────

/// 启动运行。同一时刻全局只允许一个工作流（重复请求返回可读冲突错误）。
#[tauri::command]
pub async fn workflow_run(
    db: State<'_, Arc<Db>>,
    app: AppHandle,
    id: String,
) -> AppResult<WorkflowRunDetail> {
    let db = db.inner().clone();
    let run_id = engine::start_run(db.clone(), app, &id)?;
    store::get_run(&db, &run_id)
}

#[tauri::command]
pub fn workflow_pause(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkflowRunDetail> {
    engine::pause_run(&id)?;
    current_active_run(&db, &id)
}

#[tauri::command]
pub fn workflow_resume(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkflowRunDetail> {
    engine::resume_run(&id)?;
    current_active_run(&db, &id)
}

#[tauri::command]
pub fn workflow_cancel(db: State<'_, Arc<Db>>, id: String) -> AppResult<WorkflowRunDetail> {
    engine::cancel_run(&id)?;
    current_active_run(&db, &id)
}

/// 读取该工作流当前活动运行（无则 NotFound）。
fn current_active_run(
    db: &Arc<Db>,
    workflow_id: &str,
) -> AppResult<WorkflowRunDetail> {
    let view = engine::active_run()
        .filter(|r| r.workflow_id == workflow_id)
        .ok_or_else(|| AppError::NotFound("该工作流当前没有正在执行的运行".into()))?;
    store::get_run(db, &view.run_id)
}

/// 当前是否有工作流在运行（UI 顶栏 / 卡片态使用）。
#[tauri::command]
pub fn workflow_active() -> Option<engine::ActiveRunView> {
    engine::active_run()
}

// ── 运行历史 ────────────────────────────────────────────────

#[tauri::command]
pub fn workflow_run_detail(
    db: State<'_, Arc<Db>>,
    run_id: String,
) -> AppResult<WorkflowRunDetail> {
    store::get_run(&db, &run_id)
}

#[tauri::command]
pub fn workflow_last_run(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<Option<WorkflowRunDetail>> {
    store::last_run(&db, &id)
}

/// 运行历史分页（limit 收敛到 1..=100，offset ≥ 0）。
#[tauri::command]
pub fn workflow_list_runs(
    db: State<'_, Arc<Db>>,
    id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<WorkflowRunPage> {
    store::list_runs(&db, &id, limit.unwrap_or(20), offset.unwrap_or(0))
}

/// 最近一次运行的摘要行（卡片展示用；时间为本地可读格式）。
#[derive(Debug, serde::Serialize)]
pub struct WorkflowLastRunSummary {
    pub run_id: String,
    pub status: String,
    pub total_steps: i64,
    pub completed_steps: i64,
    pub error: Option<String>,
    pub started_at: String,
    pub started_at_local: String,
    pub finished_at: Option<String>,
}

#[tauri::command]
pub fn workflow_last_run_summary(
    db: State<'_, Arc<Db>>,
    id: String,
) -> AppResult<Option<WorkflowLastRunSummary>> {
    let detail = store::last_run(&db, &id)?;
    Ok(detail.map(|d| WorkflowLastRunSummary {
        run_id: d.run.id,
        status: d.run.status,
        total_steps: d.run.total_steps,
        completed_steps: d.run.completed_steps,
        error: d.run.error,
        started_at_local: format_local(&d.run.started_at),
        started_at: d.run.started_at,
        finished_at: d.run.finished_at,
    }))
}

// ── 启动恢复（lib.rs setup 调用）────────────────────────────

/// 应用启动时把遗留的 running/paused 运行标记为 interrupted（绝不自动重放副作用）。
pub fn recover_on_startup(db: &Arc<Db>) {
    match store::recover_stale_runs(db) {
        Ok(0) => {}
        Ok(n) => tracing::info!("已将 {} 条上次未结束的工作流运行标记为 interrupted", n),
        Err(e) => tracing::error!("工作流运行恢复失败（保留原状，需人工检查）: {}", e),
    }
}
