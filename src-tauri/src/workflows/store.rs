//! 工作流持久化：定义 / 步骤 / 运行记录（事务保证，运行历史有保留上限）。
//!
//! 约定：
//! - 时间一律 UTC ISO8601 字符串（与全库一致）；
//! - 步骤保存为「整表替换」事务：删除旧步骤 → 插入新步骤，中途失败整体回滚，
//!   不会出现半新半旧的编排；
//! - 删除工作流在同一事务内显式清空步骤与运行记录（外键 CASCADE 兜底）；
//! - 运行历史保留上限 [`RUN_HISTORY_KEEP`]，清理只删运行记录，绝不碰工作流定义。

use rusqlite::{params, OptionalExtension};
use std::sync::Arc;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{
    check_workflow_description, check_workflow_name, validate_step, OnError, StepInput, StepParams,
    StepType, WorkflowInput, WorkflowRunDetail, WorkflowRunPage, WorkflowRunRow, WorkflowRunStepRow,
    WorkflowRow, WorkflowStepRow,
};

/// 每个工作流的运行历史保留条数（超出时按 started_at 淘汰最旧记录）。
pub const RUN_HISTORY_KEEP: i64 = 50;
/// 单个工作流的步骤数量上限（防失控编排；事件负载与 UI 都按此界）。
pub const MAX_STEPS: usize = 50;

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ── 行映射 ──────────────────────────────────────────────────

fn row_to_workflow(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRow> {
    Ok(WorkflowRow {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        enabled: r.get::<_, i64>(3)? != 0,
        sort_order: r.get(4)?,
        step_count: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        last_run_at: r.get(8)?,
    })
}

const WORKFLOW_COLS: &str = "w.id, w.name, w.description, w.enabled, w.sort_order, \
     (SELECT COUNT(*) FROM workflow_steps s WHERE s.workflow_id = w.id), \
     w.created_at, w.updated_at, w.last_run_at";

fn row_to_step(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowStepRow> {
    let params_json: String = r.get(3)?;
    Ok(WorkflowStepRow {
        id: r.get(0)?,
        workflow_id: r.get(1)?,
        step_type: r.get(2)?,
        params: serde_json::from_str(&params_json).unwrap_or_default(),
        display_order: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        on_error: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

const STEP_COLS: &str =
    "id, workflow_id, step_type, params, display_order, enabled, on_error, created_at, updated_at";

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRunRow> {
    Ok(WorkflowRunRow {
        id: r.get(0)?,
        workflow_id: r.get(1)?,
        workflow_name: r.get(2)?,
        status: r.get(3)?,
        current_step_index: r.get(4)?,
        total_steps: r.get(5)?,
        completed_steps: r.get(6)?,
        started_at: r.get(7)?,
        finished_at: r.get(8)?,
        error: r.get(9)?,
    })
}

const RUN_COLS: &str = "id, workflow_id, workflow_name, status, current_step_index, \
     total_steps, completed_steps, started_at, finished_at, error";

fn row_to_run_step(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRunStepRow> {
    Ok(WorkflowRunStepRow {
        id: r.get(0)?,
        run_id: r.get(1)?,
        step_id: r.get(2)?,
        step_type: r.get(3)?,
        display_order: r.get(4)?,
        status: r.get(5)?,
        detail: r.get(6)?,
        result: r.get(7)?,
        started_at: r.get(8)?,
        finished_at: r.get(9)?,
        operation_id: r.get(10)?,
    })
}

const RUN_STEP_COLS: &str = "id, run_id, step_id, step_type, display_order, status, detail, \
     result, started_at, finished_at, operation_id";

// ── 工作流 CRUD ─────────────────────────────────────────────

pub fn list_workflows(db: &Db) -> AppResult<Vec<WorkflowRow>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {WORKFLOW_COLS} FROM workflows w ORDER BY w.sort_order, w.created_at"
        ))?;
        let rows = stmt
            .query_map([], row_to_workflow)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn get_workflow(db: &Db, id: &str) -> AppResult<(WorkflowRow, Vec<WorkflowStepRow>)> {
    let wf = db
        .with_read(|conn| {
            conn.query_row(
                &format!("SELECT {WORKFLOW_COLS} FROM workflows w WHERE w.id = ?1"),
                [id],
                row_to_workflow,
            )
            .optional()
            .map_err(AppError::from)
        })?
        .ok_or_else(|| AppError::NotFound(format!("工作流不存在: {}", id)))?;
    let steps = list_steps(db, id)?;
    Ok((wf, steps))
}

pub fn list_steps(db: &Db, workflow_id: &str) -> AppResult<Vec<WorkflowStepRow>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {STEP_COLS} FROM workflow_steps WHERE workflow_id = ?1 \
             ORDER BY display_order, created_at"
        ))?;
        let rows = stmt
            .query_map([workflow_id], row_to_step)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

fn next_sort_order(tx: &rusqlite::Connection) -> AppResult<i64> {
    tx.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workflows",
        [],
        |r| r.get(0),
    )
    .map_err(AppError::from)
}

/// 规范化并校验步骤输入列表（引用存在性 + 顺序唯一性）。
fn normalize_step_inputs(db: &Db, inputs: &[StepInput]) -> AppResult<Vec<(String, StepInput)>> {
    if inputs.len() > MAX_STEPS {
        return Err(AppError::Validation(format!(
            "步骤数量超过上限（最多 {} 步）",
            MAX_STEPS
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(inputs.len());
    for input in inputs {
        input.validate(db)?;
        let id = if input.id.trim().is_empty() {
            new_id()
        } else {
            input.id.trim().to_string()
        };
        if !seen.insert(id.clone()) {
            return Err(AppError::Validation(format!("步骤 ID 重复: {}", id)));
        }
        out.push((id, input.clone()));
    }
    Ok(out)
}

fn insert_steps_tx(
    tx: &rusqlite::Connection,
    workflow_id: &str,
    normalized: &[(String, StepInput)],
) -> AppResult<()> {
    let now = now_iso();
    for (order, (id, input)) in normalized.iter().enumerate() {
        let params_json = serde_json::to_string(&input.params)?;
        tx.execute(
            &format!(
                "INSERT INTO workflow_steps ({STEP_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)"
            ),
            params![
                id,
                workflow_id,
                input.step_type,
                params_json,
                order as i64,
                input.enabled as i64,
                input.on_error,
                now,
            ],
        )
        .map_err(AppError::from)?;
    }
    Ok(())
}

pub fn create_workflow(db: &Db, input: WorkflowInput) -> AppResult<WorkflowRow> {
    let name = check_workflow_name(&input.name)?;
    let description = check_workflow_description(&input.description)?;
    let normalized = normalize_step_inputs(db, &input.steps)?;
    let id = new_id();
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let sort_order = next_sort_order(&tx)?;
        tx.execute(
            "INSERT INTO workflows (id, name, description, enabled, sort_order, created_at, updated_at, last_run_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5, NULL)",
            params![id, name, description, sort_order, now],
        )
        .map_err(AppError::from)?;
        insert_steps_tx(&tx, &id, &normalized)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    let (wf, _) = get_workflow(db, &id)?;
    Ok(wf)
}

/// 工作流元信息补丁（名称 / 描述 / 启停）。步骤走 [`replace_steps`]。
pub fn update_workflow(
    db: &Db,
    id: &str,
    name: Option<String>,
    description: Option<String>,
    enabled: Option<bool>,
) -> AppResult<WorkflowRow> {
    let name = name.map(|n| check_workflow_name(&n)).transpose()?;
    let description = description
        .map(|d| check_workflow_description(&d))
        .transpose()?;
    let now = now_iso();
    let changed = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let exists: i64 = tx
            .query_row("SELECT COUNT(*) FROM workflows WHERE id = ?1", [id], |r| r.get(0))
            .map_err(AppError::from)?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("工作流不存在: {}", id)));
        }
        let mut n = 0;
        if let Some(v) = &name {
            n += tx
                .execute(
                    "UPDATE workflows SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![v, now, id],
                )
                .map_err(AppError::from)?;
        }
        if let Some(v) = &description {
            n += tx
                .execute(
                    "UPDATE workflows SET description = ?1, updated_at = ?2 WHERE id = ?3",
                    params![v, now, id],
                )
                .map_err(AppError::from)?;
        }
        if let Some(v) = enabled {
            n += tx
                .execute(
                    "UPDATE workflows SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                    params![v as i64, now, id],
                )
                .map_err(AppError::from)?;
        }
        tx.commit().map_err(AppError::from)?;
        Ok(n)
    })?;
    if changed == 0 {
        return Err(AppError::Validation("没有需要更新的字段".into()));
    }
    let (wf, _) = get_workflow(db, id)?;
    Ok(wf)
}

pub fn delete_workflow(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let n = tx
            .execute("DELETE FROM workflows WHERE id = ?1", [id])
            .map_err(AppError::from)?;
        // 步骤 / 运行 / 回执经 ON DELETE CASCADE 级联清理；显式删除不依赖编译期 pragma。
        tx.execute(
            "DELETE FROM workflow_steps WHERE workflow_id = ?1",
            [id],
        )
        .map_err(AppError::from)?;
        tx.execute("DELETE FROM workflow_runs WHERE workflow_id = ?1", [id])
            .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        if n == 0 {
            return Err(AppError::NotFound(format!("工作流不存在: {}", id)));
        }
        Ok(())
    })
}

pub fn duplicate_workflow(db: &Db, id: &str) -> AppResult<WorkflowRow> {
    let (wf, steps) = get_workflow(db, id)?;
    let new_id_v = new_id();
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let sort_order = next_sort_order(&tx)?;
        tx.execute(
            "INSERT INTO workflows (id, name, description, enabled, sort_order, created_at, updated_at, last_run_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL)",
            params![
                new_id_v,
                format!("{}（副本）", wf.name),
                wf.description,
                wf.enabled as i64,
                sort_order,
                now,
            ],
        )
        .map_err(AppError::from)?;
        let normalized: Vec<(String, StepInput)> = steps
            .iter()
            .map(|s| {
                (
                    new_id(),
                    StepInput {
                        id: String::new(),
                        step_type: s.step_type.clone(),
                        params: s.params.clone(),
                        enabled: s.enabled,
                        on_error: s.on_error.clone(),
                    },
                )
            })
            .collect();
        insert_steps_tx(&tx, &new_id_v, &normalized)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    let (wf, _) = get_workflow(db, &new_id_v)?;
    Ok(wf)
}

/// 调整工作流顺序：按传入 id 顺序重排 sort_order（缺失 id 视为非法）。
pub fn reorder_workflows(db: &Db, ordered_ids: &[String]) -> AppResult<()> {
    if ordered_ids.is_empty() {
        return Err(AppError::Validation("顺序列表不能为空".into()));
    }
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let total: i64 = tx
            .query_row("SELECT COUNT(*) FROM workflows", [], |r| r.get(0))
            .map_err(AppError::from)?;
        if ordered_ids.len() as i64 != total {
            return Err(AppError::Validation(format!(
                "顺序列表必须包含全部工作流（期望 {} 个，收到 {} 个）",
                total,
                ordered_ids.len()
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for (idx, wf_id) in ordered_ids.iter().enumerate() {
            if !seen.insert(wf_id.as_str()) {
                return Err(AppError::Validation(format!("顺序列表存在重复 ID: {}", wf_id)));
            }
            let n = tx
                .execute(
                    "UPDATE workflows SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                    params![idx as i64, now, wf_id],
                )
                .map_err(AppError::from)?;
            if n == 0 {
                return Err(AppError::NotFound(format!("工作流不存在: {}", wf_id)));
            }
        }
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

/// 编辑保存：名称 / 描述 / 步骤整表替换在同一事务内完成。
///
/// 之前的「先 replace_steps 再 update_workflow」是两条独立事务，元信息失败时
/// 步骤已落库、界面却只报失败。编辑路径必须整次原子，避免半保存状态。
pub fn replace_steps_and_update(
    db: &Db,
    workflow_id: &str,
    name: String,
    description: String,
    inputs: Vec<StepInput>,
) -> AppResult<Vec<WorkflowStepRow>> {
    let name = check_workflow_name(&name)?;
    let description = check_workflow_description(&description)?;
    let normalized = normalize_step_inputs(db, &inputs)?;
    let now = now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM workflows WHERE id = ?1",
                [workflow_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("工作流不存在: {}", workflow_id)));
        }
        tx.execute(
            "UPDATE workflows SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, description, now, workflow_id],
        )
        .map_err(AppError::from)?;
        tx.execute(
            "DELETE FROM workflow_steps WHERE workflow_id = ?1",
            [workflow_id],
        )
        .map_err(AppError::from)?;
        insert_steps_tx(&tx, workflow_id, &normalized)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    list_steps(db, workflow_id)
}

/// 整表替换步骤编排（新增 / 编辑 / 删除 / 排序共用一个原子事务）。
pub fn replace_steps(
    db: &Db,
    workflow_id: &str,
    inputs: Vec<StepInput>,
) -> AppResult<Vec<WorkflowStepRow>> {
    let normalized = normalize_step_inputs(db, &inputs)?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM workflows WHERE id = ?1",
                [workflow_id],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("工作流不存在: {}", workflow_id)));
        }
        tx.execute(
            "DELETE FROM workflow_steps WHERE workflow_id = ?1",
            [workflow_id],
        )
        .map_err(AppError::from)?;
        insert_steps_tx(&tx, workflow_id, &normalized)?;
        tx.execute(
            "UPDATE workflows SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), workflow_id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    list_steps(db, workflow_id)
}

// ── 运行记录 ────────────────────────────────────────────────

/// 创建一次运行：运行头 + 全部步骤的 pending 回执行 + 工作流 last_run_at，
/// 同一事务写入；任何失败整体回滚，不会出现「有运行无回执」的脏状态。
pub struct NewRun {
    pub run_id: String,
    pub total_steps: i64,
}

pub fn create_run(
    db: &Db,
    workflow_id: &str,
    workflow_name: &str,
    steps: &[WorkflowStepRow],
) -> AppResult<NewRun> {
    let now = now_iso();
    let run_id = new_id();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO workflow_runs (id, workflow_id, workflow_name, status, current_step_index, total_steps, completed_steps, started_at, finished_at, error)
             VALUES (?1, ?2, ?3, 'running', 0, ?4, 0, ?5, NULL, NULL)",
            params![run_id, workflow_id, workflow_name, steps.len() as i64, now],
        )
        .map_err(AppError::from)?;
        for (order, step) in steps.iter().enumerate() {
            tx.execute(
                &format!(
                    "INSERT INTO workflow_run_steps ({RUN_STEP_COLS})
                     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', '', NULL, NULL, NULL, '')"
                ),
                params![
                    new_id(),
                    run_id,
                    step.id,
                    step.step_type,
                    order as i64,
                ],
            )
            .map_err(AppError::from)?;
        }
        tx.execute(
            "UPDATE workflows SET last_run_at = ?1 WHERE id = ?2",
            params![now, workflow_id],
        )
        .map_err(AppError::from)?;
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })?;
    Ok(NewRun {
        run_id,
        total_steps: steps.len() as i64,
    })
}

/// 运行详情（头 + 回执）。运行中会被引擎高频更新，读走写连接保证最新。
pub fn get_run(db: &Db, run_id: &str) -> AppResult<WorkflowRunDetail> {
    let run = db
        .with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {RUN_COLS} FROM workflow_runs WHERE id = ?1"),
                [run_id],
                row_to_run,
            )
            .optional()
            .map_err(AppError::from)
        })?
        .ok_or_else(|| AppError::NotFound(format!("运行记录不存在: {}", run_id)))?;
    let steps = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {RUN_STEP_COLS} FROM workflow_run_steps WHERE run_id = ?1 \
             ORDER BY display_order"
        ))?;
        let rows = stmt
            .query_map([run_id], row_to_run_step)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(WorkflowRunDetail { run, steps })
}

/// 某工作流的最近一次运行。
pub fn last_run(db: &Db, workflow_id: &str) -> AppResult<Option<WorkflowRunDetail>> {
    let latest: Option<String> = db.with_read(|conn| {
        conn.query_row(
            "SELECT id FROM workflow_runs WHERE workflow_id = ?1 \
             ORDER BY started_at DESC, rowid DESC LIMIT 1",
            [workflow_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)
    })?;
    match latest {
        Some(id) => Ok(Some(get_run(db, &id)?)),
        None => Ok(None),
    }
}

/// 运行历史分页（新→旧）。
pub fn list_runs(db: &Db, workflow_id: &str, limit: i64, offset: i64) -> AppResult<WorkflowRunPage> {
    let limit = limit.clamp(1, 100);
    let offset = offset.max(0);
    let total: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = ?1",
            [workflow_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    let items = db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {RUN_COLS} FROM workflow_runs WHERE workflow_id = ?1 \
             ORDER BY started_at DESC, rowid DESC LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = stmt
            .query_map(params![workflow_id, limit, offset], row_to_run)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(WorkflowRunPage {
        items,
        total,
        limit,
        offset,
    })
}

/// 运行进度更新（引擎在状态迁移点调用）。
pub struct RunProgress {
    pub status: Option<String>,
    pub current_step_index: Option<i64>,
    pub completed_steps: Option<i64>,
    pub error: Option<String>,
}

pub fn update_run(db: &Db, run_id: &str, p: &RunProgress) -> AppResult<()> {
    db.with_conn(|conn| {
        if let Some(status) = &p.status {
            conn.execute(
                "UPDATE workflow_runs SET status = ?1 WHERE id = ?2",
                params![status, run_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = p.current_step_index {
            conn.execute(
                "UPDATE workflow_runs SET current_step_index = ?1 WHERE id = ?2",
                params![v, run_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = p.completed_steps {
            conn.execute(
                "UPDATE workflow_runs SET completed_steps = ?1 WHERE id = ?2",
                params![v, run_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(e) = &p.error {
            conn.execute(
                "UPDATE workflow_runs SET error = ?1 WHERE id = ?2",
                params![e, run_id],
            )
            .map_err(AppError::from)?;
        }
        Ok(())
    })
}

/// 运行收尾：终态 + finished_at 一次写入。
pub fn finish_run(db: &Db, run_id: &str, status: &str, error: Option<&str>) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE workflow_runs SET status = ?1, finished_at = ?2, error = ?3 WHERE id = ?4",
            params![status, now_iso(), error, run_id],
        )
        .map_err(AppError::from)?;
        Ok(())
    })
}

/// 回执行状态更新。
pub struct RunStepUpdate {
    pub status: Option<String>,
    pub detail: Option<String>,
    pub result: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Some(op_id) 写入；None 不动；Some("") 显式清空。
    pub operation_id: Option<String>,
}

pub fn update_run_step(
    db: &Db,
    run_id: &str,
    step_id: &str,
    u: &RunStepUpdate,
) -> AppResult<()> {
    db.with_conn(|conn| {
        if let Some(v) = &u.status {
            conn.execute(
                "UPDATE workflow_run_steps SET status = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![v, run_id, step_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = &u.detail {
            conn.execute(
                "UPDATE workflow_run_steps SET detail = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![v, run_id, step_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = &u.result {
            conn.execute(
                "UPDATE workflow_run_steps SET result = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![v, run_id, step_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = &u.started_at {
            conn.execute(
                "UPDATE workflow_run_steps SET started_at = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![v, run_id, step_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = &u.finished_at {
            conn.execute(
                "UPDATE workflow_run_steps SET finished_at = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![v, run_id, step_id],
            )
            .map_err(AppError::from)?;
        }
        if let Some(v) = &u.operation_id {
            conn.execute(
                "UPDATE workflow_run_steps SET operation_id = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![v, run_id, step_id],
            )
            .map_err(AppError::from)?;
        }
        Ok(())
    })
}

/// 把某次运行中所有仍处 pending 的步骤标记为 cancelled（取消 / 失败停止时收尾）。
pub fn cancel_pending_steps(db: &Db, run_id: &str) -> AppResult<usize> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE workflow_run_steps SET status = 'cancelled', finished_at = ?1 \
             WHERE run_id = ?2 AND status IN ('pending','running')",
            params![now_iso(), run_id],
        )
        .map_err(AppError::from)
    })
}

/// 运行历史保留：只删最旧的超额运行记录（级联删回执行），不碰工作流定义与步骤。
pub fn prune_runs(db: &Db, workflow_id: &str, keep: i64) -> AppResult<usize> {
    db.with_conn(|conn| {
        let n = conn
            .execute(
                "DELETE FROM workflow_runs WHERE workflow_id = ?1 AND id NOT IN (
                   SELECT id FROM workflow_runs WHERE workflow_id = ?1
                   ORDER BY started_at DESC, rowid DESC LIMIT ?2
                 )",
                params![workflow_id, keep],
            )
            .map_err(AppError::from)?;
        Ok(n)
    })
}

/// 应用启动恢复：把上次异常退出遗留的 running/paused 运行标记为 interrupted，
/// running 步骤标为 failed（结果未知，绝不自动重放副作用），pending 步骤标为 cancelled。
/// 幂等：没有遗留行时是空操作。返回受影响的运行数。
pub fn recover_stale_runs(db: &Db) -> AppResult<usize> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let stale: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM workflow_runs WHERE status IN ('running','paused')",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for run_id in &stale {
            tx.execute(
                "UPDATE workflow_runs SET status = 'interrupted', \
                        error = '应用异常退出，运行未完成；已产生的副作用不会被自动重放', \
                        finished_at = ?1 \
                 WHERE id = ?2",
                params![now_iso(), run_id],
            )
            .map_err(AppError::from)?;
            tx.execute(
                "UPDATE workflow_run_steps SET status = 'failed', \
                        detail = '应用退出时该步骤结果未知，请人工确认是否已产生副作用', \
                        finished_at = ?1 \
                 WHERE run_id = ?2 AND status = 'running'",
                params![now_iso(), run_id],
            )
            .map_err(AppError::from)?;
            tx.execute(
                "UPDATE workflow_run_steps SET status = 'cancelled', finished_at = ?1 \
                 WHERE run_id = ?2 AND status = 'pending'",
                params![now_iso(), run_id],
            )
            .map_err(AppError::from)?;
        }
        tx.commit().map_err(AppError::from)?;
        Ok(stale.len())
    })
}

/// 步骤执行前调用：运行时重校验（目标可能已被删除 / 路径失效）。
/// 返回校验后的强类型步骤供执行器使用。
pub fn revalidate_step(
    db: &Db,
    step_type: &str,
    params: &StepParams,
) -> AppResult<(StepType, super::ValidatedStep)> {
    validate_step(db, step_type, params, true).map_err(|e| match e {
        AppError::Validation(m) => {
            AppError::Validation(format!("步骤执行前校验失败: {}", m))
        }
        other => other,
    })
}

/// 失败策略解析（数据库值 → 枚举；非法值按 stop 兜底并记录）。
pub fn parse_on_error(raw: &str) -> OnError {
    OnError::parse(raw).unwrap_or(OnError::Stop)
}

#[cfg(test)]
mod tests;
