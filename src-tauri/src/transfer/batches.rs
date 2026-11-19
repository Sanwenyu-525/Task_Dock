//! 批次记录：一次批量发送的真实结果、进度来源与撤销信息。
//!
//! 设计：
//! - 批次只记录「这一次发送」，不替代条目状态机；
//! - 进度不单独存表，由 fsops 的 `JobRegistry` 快照聚合后回写（单一事实来源）；
//! - `results_json` 存逐条结果（最多 [`super::MAX_FAILURES`] 条失败明细）；
//! - 撤销信息只记「本批次创建/复制出的目标路径」，绝不记源文件。

use rusqlite::{params, OptionalExtension};
use serde_json::json;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{BatchEntry, TransferBatch, TransferTarget, MAX_BATCH_HISTORY, MAX_FAILURES};

pub struct NewBatch<'a> {
    pub target: &'a TransferTarget,
    pub operation: &'a str,
    /// 初始状态：`preparing` 表示批次已建立但任务尚未全部提交。
    pub status: &'a str,
    pub total: usize,
    pub plan: serde_json::Value,
    pub job_ids: Vec<String>,
    pub undo_kind: &'a str,
    pub undo_payload: serde_json::Value,
    pub undo_state: &'a str,
    pub message: &'a str,
}

/// 创建批次；返回批次 id。
pub fn create(db: &Db, new: NewBatch<'_>) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let plan_json = serde_json::to_string(&new.plan).unwrap_or_else(|_| "[]".into());
    let job_ids_json = serde_json::to_string(&new.job_ids).unwrap_or_else(|_| "[]".into());
    let undo_payload_json =
        serde_json::to_string(&new.undo_payload).unwrap_or_else(|_| "{}".into());
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO transfer_batches (
                id, target_module, target_ref, operation, status, total, ok, failed, skipped,
                job_ids_json, plan_json, results_json, undo_kind, undo_state, undo_payload_json,
                error_message, created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,0,0,0,?7,?8,'[]',?9,?10,?11,?12,?13,?13)",
            params![
                id,
                new.target.module,
                new.target.target_ref,
                new.operation,
                new.status,
                new.total as i64,
                job_ids_json,
                plan_json,
                new.undo_kind,
                new.undo_state,
                undo_payload_json,
                new.message,
                now,
            ],
        )?;
        // 只保留最近 N 条终态批次，避免表无限增长（运行中的批次永不淘汰）。
        tx.execute(
            "DELETE FROM transfer_batches WHERE id IN (
                SELECT id FROM transfer_batches
                WHERE status IN ('completed','partial','failed','cancelled')
                ORDER BY created_at DESC LIMIT -1 OFFSET ?1
             )",
            params![MAX_BATCH_HISTORY as i64],
        )?;
        tx.commit()?;
        Ok(id)
    })
}

/// 任务全部提交成功后回填 jobIds 并切换状态（预建批次的第二步）。
pub fn attach_jobs(db: &Db, id: &str, job_ids: &[String], status: &str, message: &str) -> AppResult<()> {
    let job_ids_json = serde_json::to_string(job_ids).unwrap_or_else(|_| "[]".into());
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE transfer_batches SET job_ids_json = ?2, status = ?3, error_message = ?4,
             updated_at = ?5 WHERE id = ?1",
            params![id, job_ids_json, status, message, now_iso()],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("批次不存在".into()));
        }
        Ok(())
    })
}

/// 撤销状态机：available / partial / running / used / unavailable。
pub fn set_undo_state(db: &Db, id: &str, state: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE transfer_batches SET undo_state = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, state, now_iso()],
        )?;
        Ok(())
    })
}

pub struct BatchUpdate<'a> {
    pub status: &'a str,
    pub ok: usize,
    pub failed: usize,
    pub skipped: usize,
    pub entries: &'a [BatchEntry],
    pub undo_state: Option<&'a str>,
    pub message: &'a str,
}

pub fn update(db: &Db, id: &str, update: BatchUpdate<'_>) -> AppResult<()> {
    let trimmed: Vec<&BatchEntry> = update.entries.iter().take(MAX_FAILURES).collect();
    let results_json = serde_json::to_string(&trimmed).unwrap_or_else(|_| "[]".into());
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE transfer_batches SET status = ?2, ok = ?3, failed = ?4, skipped = ?5,
             results_json = ?6, undo_state = COALESCE(?7, undo_state), error_message = ?8,
             updated_at = ?9 WHERE id = ?1",
            params![
                id,
                update.status,
                update.ok as i64,
                update.failed as i64,
                update.skipped as i64,
                results_json,
                update.undo_state,
                update.message,
                now_iso(),
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("批次不存在".into()));
        }
        Ok(())
    })
}

pub fn mark_undo_used(db: &Db, id: &str) -> AppResult<()> {
    set_undo_state(db, id, "used")
}

pub struct BatchRow {
    pub id: String,
    pub target_module: String,
    pub target_ref: String,
    pub operation: String,
    pub status: String,
    pub total: i64,
    pub ok: i64,
    pub failed: i64,
    pub skipped: i64,
    pub job_ids_json: String,
    pub plan_json: String,
    pub entries_json: String,
    pub undo_kind: String,
    pub undo_state: String,
    pub undo_payload_json: String,
    pub message: String,
    pub created_at: String,
    pub updated_at: String,
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BatchRow> {
    Ok(BatchRow {
        id: row.get(0)?,
        target_module: row.get(1)?,
        target_ref: row.get(2)?,
        operation: row.get(3)?,
        status: row.get(4)?,
        total: row.get(5)?,
        ok: row.get(6)?,
        failed: row.get(7)?,
        skipped: row.get(8)?,
        job_ids_json: row.get(9)?,
        plan_json: row.get(10)?,
        entries_json: row.get(11)?,
        undo_kind: row.get(12)?,
        undo_state: row.get(13)?,
        undo_payload_json: row.get(14)?,
        message: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

pub fn load_row(db: &Db, id: &str) -> AppResult<BatchRow> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT id, target_module, target_ref, operation, status, total, ok, failed, skipped,
             job_ids_json, plan_json, results_json, undo_kind, undo_state, undo_payload_json,
             error_message, created_at, updated_at FROM transfer_batches WHERE id = ?1",
            params![id],
            read_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("批次不存在".into()))
    })
}

pub fn row_to_batch(row: BatchRow) -> TransferBatch {
    let job_ids: Vec<String> = serde_json::from_str(&row.job_ids_json).unwrap_or_default();
    let entries: Vec<BatchEntry> = serde_json::from_str(&row.entries_json).unwrap_or_default();
    let undo_state = row.undo_state.clone();
    let undo_reason = match row.undo_state.as_str() {
        "available" => "可撤销：本批次生成/复制的文件可移入回收站".to_string(),
        "partial" => "部分可撤销：仅新建/复制的文件可移入回收站，移动的源文件不恢复".to_string(),
        "running" => "正在撤销：等待文件任务真实完成".to_string(),
        "used" => "已撤销".to_string(),
        _ => match row.undo_kind.as_str() {
            "none" => "该操作没有可撤销的新文件".to_string(),
            _ => "不可撤销（移动已改变原位置内容）".to_string(),
        },
    };
    TransferBatch {
        id: row.id,
        target_module: row.target_module,
        target_ref: row.target_ref,
        operation: row.operation,
        status: row.status,
        total: row.total.max(0) as usize,
        ok: row.ok.max(0) as usize,
        failed: row.failed.max(0) as usize,
        skipped: row.skipped.max(0) as usize,
        job_ids,
        entries,
        undo_state,
        undo_reason,
        message: row.message,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn get(db: &Db, id: &str) -> AppResult<TransferBatch> {
    Ok(row_to_batch(load_row(db, id)?))
}

pub fn list(db: &Db, limit: usize) -> AppResult<Vec<TransferBatch>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, target_module, target_ref, operation, status, total, ok, failed, skipped,
             job_ids_json, plan_json, results_json, undo_kind, undo_state, undo_payload_json,
             error_message, created_at, updated_at FROM transfer_batches
             ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.clamp(1, 100) as i64], read_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row_to_batch(row?));
        }
        Ok(out)
    })
}

/// 撤销载荷：本批次创建/复制出的目标路径（不含源文件）。
pub fn undo_paths(row: &BatchRow) -> Vec<String> {
    let value: serde_json::Value =
        serde_json::from_str(&row.undo_payload_json).unwrap_or_else(|_| json!({}));
    value
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub fn job_ids(row: &BatchRow) -> Vec<String> {
    serde_json::from_str(&row.job_ids_json).unwrap_or_default()
}
