//! Agent 事件保留与归档。
//!
//! 策略（与文档 `docs/PERFORMANCE_ARCHITECTURE.md` 一致）：
//! - 只清理 `running` / `idle` 进度事件：这两类可由后续心跳/状态重建；
//! - `waiting` / `failed` / `completed` / `disconnected` 是审计与用户可见状态，
//!   **永不因保留策略自动删除**（数量受 Agent 轮次规模约束，不随工具进度无限增长）；
//! - 触发条件：超过保留天数，或 running/idle 行数超过上限（保留最新 N 条）；
//! - 清理前先写 JSONL 归档（可在设置中关闭，但关闭时仍不会静默删除：
//!   报告会明确标记 archived=false）；
//! - 分块事务删除，避免长时间占用写锁；单次运行有行数上限，避免启动变慢。

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

/// 单次运行最多清理的事件数（避免长事务/长启动）。
pub const MAX_PRUNE_PER_RUN: usize = 5000;
/// 每批删除的事务大小。
const DELETE_CHUNK: usize = 500;
/// 只有这些状态允许被保留策略清理。
const PRUNABLE_STATES: &str = "('running','idle')";

#[derive(Debug, Clone, Serialize)]
pub struct RetentionReport {
    pub ran_at: String,
    pub cutoff: Option<String>,
    pub candidates: usize,
    pub deleted: usize,
    pub archived: usize,
    pub archive_file: Option<String>,
    pub archive_error: Option<String>,
    /// running/idle 剩余行数
    pub prunable_remaining: u64,
    /// 不可清理的状态事件总数（审计保留）
    pub protected_rows: u64,
}

#[derive(Debug, Clone)]
struct EventLine {
    id: String,
    source_id: String,
    session_external_id: String,
    run_external_id: Option<String>,
    event_type: String,
    state: String,
    message: Option<String>,
    received_at: String,
    schema_version: i64,
    event_id: Option<String>,
    instance_id: Option<String>,
    parent_run_id: Option<String>,
    occurred_at: Option<String>,
    transport: String,
    evidence_type: String,
    confidence: f64,
    dedupe_key: Option<String>,
}

impl EventLine {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "source_id": self.source_id,
            "session_external_id": self.session_external_id,
            "run_external_id": self.run_external_id,
            "event_type": self.event_type,
            "state": self.state,
            "message": self.message,
            "received_at": self.received_at,
            "schema_version": self.schema_version,
            "event_id": self.event_id,
            "instance_id": self.instance_id,
            "parent_run_id": self.parent_run_id,
            "occurred_at": self.occurred_at,
            "transport": self.transport,
            "evidence_type": self.evidence_type,
            "confidence": self.confidence,
            "dedupe_key": self.dedupe_key,
        })
    }
}

pub fn archive_dir(app_data: &Path) -> PathBuf {
    app_data.join("archive")
}

fn count_where(db: &Db, sql: &str) -> AppResult<u64> {
    db.with_read(|conn| {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .map(|v| v.max(0) as u64)
            .map_err(AppError::from)
    })
}

/// 计算本次候选：超龄的 running/idle + 超出上限的最旧 running/idle。
fn collect_candidates(
    db: &Db,
    cutoff: Option<&str>,
    overflow: u64,
    limit: usize,
) -> AppResult<Vec<EventLine>> {
    db.with_read(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut ids: Vec<String> = Vec::new();
        if let Some(cutoff) = cutoff {
            let mut stmt = tx.prepare(&format!(
                "SELECT id FROM agent_events WHERE state IN {} AND received_at < ?1
                 ORDER BY received_at ASC LIMIT ?2",
                PRUNABLE_STATES
            ))?;
            let rows = stmt.query_map(rusqlite::params![cutoff, limit as i64], |r| {
                r.get::<_, String>(0)
            })?;
            for row in rows {
                ids.push(row?);
            }
        }
        if overflow > 0 && ids.len() < limit {
            let mut stmt = tx.prepare(&format!(
                "SELECT id FROM agent_events WHERE state IN {} ORDER BY received_at ASC LIMIT ?1",
                PRUNABLE_STATES
            ))?;
            let rows = stmt.query_map(rusqlite::params![overflow as i64], |r| {
                r.get::<_, String>(0)
            })?;
            for row in rows {
                let id = row?;
                if !ids.contains(&id) {
                    ids.push(id);
                }
                if ids.len() >= limit {
                    break;
                }
            }
        }
        if ids.is_empty() {
            tx.commit()?;
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(ids.len());
        let mut stmt = tx.prepare(
            "SELECT id, source_id, session_external_id, run_external_id, event_type, state,
                    message, received_at, schema_version, event_id, instance_id, parent_run_id,
                    occurred_at, transport, evidence_type, confidence, dedupe_key
             FROM agent_events WHERE id = ?1",
        )?;
        for id in &ids {
            let row = stmt.query_row(rusqlite::params![id], |r| {
                Ok(EventLine {
                    id: r.get(0)?,
                    source_id: r.get(1)?,
                    session_external_id: r.get(2)?,
                    run_external_id: r.get(3)?,
                    event_type: r.get(4)?,
                    state: r.get(5)?,
                    message: r.get(6)?,
                    received_at: r.get(7)?,
                    schema_version: r.get(8)?,
                    event_id: r.get(9)?,
                    instance_id: r.get(10)?,
                    parent_run_id: r.get(11)?,
                    occurred_at: r.get(12)?,
                    transport: r.get(13)?,
                    evidence_type: r.get(14)?,
                    confidence: r.get(15)?,
                    dedupe_key: r.get(16)?,
                })
            })?;
            out.push(row);
        }
        drop(stmt);
        tx.commit()?;
        Ok(out)
    })
}

fn write_archive(dir: &Path, rows: &[EventLine]) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name = format!(
        "agent-events-{}-{}.jsonl",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let path = dir.join(name);
    let tmp = path.with_extension("jsonl.tmp");
    {
        let file = std::fs::File::create(&tmp)?;
        let mut w = BufWriter::new(file);
        writeln!(
            w,
            "{}",
            serde_json::json!({
                "kind": "taskdock-agent-events-archive",
                "version": 1,
                "created_at": crate::agents::now_iso(),
                "policy": "仅归档 running/idle；关键状态事件不参与自动清理",
            })
        )?;
        for row in rows {
            serde_json::to_writer(&mut w, &row.to_json())?;
            w.write_all(b"\n")?;
        }
        w.flush()?;
        w.get_ref().sync_all()?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Io(e)
    })?;
    Ok(path)
}

fn delete_ids(db: &Db, ids: &[String]) -> AppResult<usize> {
    let mut deleted = 0usize;
    for chunk in ids.chunks(DELETE_CHUNK) {
        deleted += db.with_conn(|conn| {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!("DELETE FROM agent_events WHERE id IN ({})", placeholders);
            let params: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            Ok(conn.execute(&sql, params.as_slice())?)
        })?;
    }
    Ok(deleted)
}

/// 执行一次保留策略。`app_data` 为空时跳过归档（仅测试使用）。
pub fn run_retention(
    db: &Db,
    settings: &Settings,
    app_data: Option<&Path>,
    limit: usize,
) -> AppResult<RetentionReport> {
    let ran_at = crate::agents::now_iso();
    let cutoff = if settings.agent_event_retention_days > 0 {
        Some(
            (chrono::Utc::now()
                - chrono::Duration::days(settings.agent_event_retention_days as i64))
            .to_rfc3339(),
        )
    } else {
        None
    };
    let prunable: u64 = count_where(
        db,
        &format!(
            "SELECT COUNT(*) FROM agent_events WHERE state IN {}",
            PRUNABLE_STATES
        ),
    )?;
    let overflow = if settings.agent_event_max_rows > 0 {
        prunable.saturating_sub(settings.agent_event_max_rows)
    } else {
        0
    };
    let limit = limit.clamp(1, MAX_PRUNE_PER_RUN);
    let rows = collect_candidates(db, cutoff.as_deref(), overflow, limit)?;

    let mut archived = 0usize;
    let mut archive_file = None;
    let mut archive_error = None;
    if !rows.is_empty() && settings.agent_event_archive {
        match app_data {
            Some(dir) => match write_archive(&archive_dir(dir), &rows) {
                Ok(p) => {
                    archived = rows.len();
                    archive_file = Some(p.to_string_lossy().to_string());
                }
                Err(e) => {
                    // 归档失败 → 本次不删除，避免不可恢复的数据丢失
                    archive_error = Some(e.to_string());
                    tracing::error!("事件归档失败，已中止本次清理: {}", e);
                    let protected: u64 = count_where(
                        db,
                        &format!(
                            "SELECT COUNT(*) FROM agent_events WHERE state NOT IN {}",
                            PRUNABLE_STATES
                        ),
                    )?;
                    return Ok(RetentionReport {
                        ran_at,
                        cutoff,
                        candidates: rows.len(),
                        deleted: 0,
                        archived: 0,
                        archive_file: None,
                        archive_error,
                        prunable_remaining: prunable,
                        protected_rows: protected,
                    });
                }
            },
            None => {
                archive_error = Some("未配置归档目录，已跳过删除".into());
                let protected: u64 = count_where(
                    db,
                    &format!(
                        "SELECT COUNT(*) FROM agent_events WHERE state NOT IN {}",
                        PRUNABLE_STATES
                    ),
                )?;
                return Ok(RetentionReport {
                    ran_at,
                    cutoff,
                    candidates: rows.len(),
                    deleted: 0,
                    archived: 0,
                    archive_file: None,
                    archive_error,
                    prunable_remaining: prunable,
                    protected_rows: protected,
                });
            }
        }
    }

    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let deleted = if ids.is_empty() {
        0
    } else {
        delete_ids(db, &ids)?
    };
    let prunable_remaining = prunable.saturating_sub(deleted as u64);
    let protected_rows: u64 = count_where(
        db,
        &format!(
            "SELECT COUNT(*) FROM agent_events WHERE state NOT IN {}",
            PRUNABLE_STATES
        ),
    )?;
    if deleted > 0 {
        tracing::info!(
            "事件保留：归档 {} 条、删除 {} 条 running/idle（剩余可清理 {}，受保护 {}）",
            archived,
            deleted,
            prunable_remaining,
            protected_rows
        );
    }
    Ok(RetentionReport {
        ran_at,
        cutoff,
        candidates: rows.len(),
        deleted,
        archived,
        archive_file,
        archive_error,
        prunable_remaining,
        protected_rows,
    })
}

/// 后台保留任务：启动 20 秒后首跑，之后每 6 小时一次。
/// 计算与文件写入都在阻塞线程池，不在启动路径同步扫表、不占 UI 主线程。
pub fn start_background(app: tauri::AppHandle, db: Arc<Db>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let db2 = db.clone();
            let dir = app.path().app_data_dir().ok();
            let report = tauri::async_runtime::spawn_blocking(move || {
                let settings = Settings::load(&db2).unwrap_or_default();
                run_retention(&db2, &settings, dir.as_deref(), MAX_PRUNE_PER_RUN)
            })
            .await;
            match report {
                Ok(Ok(r)) => {
                    if r.deleted > 0 {
                        let _ = app.emit("agent-retention", &r);
                    }
                }
                Ok(Err(e)) => tracing::warn!("事件保留任务失败: {}", e),
                Err(e) => tracing::warn!("事件保留任务中断: {}", e),
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// 归档文件清单（设置页展示 / 手动导出路径）。
pub fn list_archives(app_data: &Path) -> AppResult<Vec<serde_json::Value>> {
    let dir = archive_dir(app_data);
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() && entry.file_name().to_string_lossy().ends_with(".jsonl") {
            out.push(serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "path": entry.path().to_string_lossy(),
                "size": meta.len(),
                "modified": meta.modified().ok().map(|t| {
                    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()
                }),
            }));
        }
    }
    out.sort_by(|a, b| {
        b["modified"]
            .as_str()
            .unwrap_or("")
            .cmp(a["modified"].as_str().unwrap_or(""))
    });
    Ok(out)
}

/// 当前事件表规模与保护情况（诊断面板）。
pub fn retention_status(db: &Db, settings: &Settings) -> AppResult<serde_json::Value> {
    let (total, prunable, oldest): (i64, i64, Option<String>) = db.with_read(|conn| {
        let total = conn.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))?;
        let prunable = conn.query_row(
            &format!("SELECT COUNT(*) FROM agent_events WHERE state IN {}", PRUNABLE_STATES),
            [],
            |r| r.get(0),
        )?;
        let oldest = conn
            .query_row(
                &format!(
                    "SELECT received_at FROM agent_events WHERE state IN {} ORDER BY received_at ASC LIMIT 1",
                    PRUNABLE_STATES
                ),
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok((total, prunable, oldest))
    })?;
    Ok(serde_json::json!({
        "total_rows": total,
        "prunable_rows": prunable,
        "protected_rows": total - prunable,
        "oldest_prunable": oldest,
        "retention_days": settings.agent_event_retention_days,
        "max_rows": settings.agent_event_max_rows,
        "archive_enabled": settings.agent_event_archive,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{ingest_core, AgentEvent, Transport};

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn seed(db: &Db, state: &str, n: usize, age_days: i64) {
        for i in 0..n {
            let ev = AgentEvent {
                source_id: "codex".into(),
                session_id: "retention-session".into(),
                run_id: Some(format!("run-{}-{}", state, i)),
                state: state.into(),
                ..Default::default()
            };
            let ts = (chrono::Utc::now() - chrono::Duration::days(age_days)).to_rfc3339();
            db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                ingest_core(&tx, &ev, &ts, Transport::Http)?;
                tx.commit()?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        }
    }

    #[test]
    fn prunes_only_running_and_archives_before_delete() {
        let db = memdb();
        seed(&db, "running", 10, 40);
        seed(&db, "waiting", 2, 40);
        seed(&db, "completed", 2, 40);
        let dir = std::env::temp_dir().join(format!("td-retention-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Settings::load(&db).unwrap();
        let report = run_retention(&db, &settings, Some(&dir), 20).unwrap();
        assert_eq!(report.candidates, 10, "只有 running 可清理");
        assert_eq!(report.deleted, 10);
        assert_eq!(report.archived, 10);
        assert!(report.archive_file.is_some());
        let waiting: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM agent_events WHERE state IN ('waiting','completed')",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(waiting, 4, "关键状态事件必须完整保留");
        let lines = std::fs::read_to_string(report.archive_file.unwrap()).unwrap();
        assert_eq!(lines.lines().count(), 11, "1 行头 + 10 行归档事件");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn row_cap_keeps_newest_running_events() {
        let db = memdb();
        seed(&db, "running", 8, 0);
        db.set_setting("agent_event_retention_days", serde_json::json!(0))
            .unwrap();
        db.set_setting("agent_event_max_rows", serde_json::json!(3))
            .unwrap();
        let settings = Settings::load(&db).unwrap();
        let dir = std::env::temp_dir().join(format!("td-retention-cap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let report = run_retention(&db, &settings, Some(&dir), 20).unwrap();
        assert_eq!(report.deleted, 5, "超出上限的最旧 5 条被清理");
        assert_eq!(report.archived, 5, "清理前必须归档");
        assert_eq!(report.prunable_remaining, 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn archive_failure_never_deletes_rows() {
        let db = memdb();
        seed(&db, "running", 3, 40);
        let settings = Settings::load(&db).unwrap();
        // 父路径是普通文件 → 无法创建归档目录
        let dir = std::env::temp_dir().join(format!("td-retention-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let report = run_retention(&db, &settings, Some(&blocker), 20).unwrap();
        assert_eq!(report.deleted, 0);
        assert!(report.archive_error.is_some());
        let left: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(left, 3, "归档失败必须保留全部事件");
        std::fs::remove_dir_all(&dir).ok();
    }
}
