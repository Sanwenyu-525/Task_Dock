//! 历史测试/压测数据审计与清理。
//!
//! 原则：
//! - 只处理「可证明」的测试数据（origin != real，由 v12 迁移按保守规则标记）；
//! - 默认 dry-run，只报告不修改；
//! - 真正清理前先用 `VACUUM INTO` 生成完整数据库快照，失败即中止；
//! - 在单事务内按依赖顺序删除，最后用 SQLite 外键检查兜底；
//! - 无法证明的数据保持原样并列入「待人工确认」，绝不批量误删；
//! - 保留 bench/mock 来源注册项，避免压测脚本下次运行时来源不存在。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Default, Clone, Serialize)]
pub struct TableCounts {
    pub events: i64,
    pub sessions: i64,
    pub runs: i64,
    pub instances: i64,
    pub notifications: i64,
}

impl TableCounts {
    fn total(&self) -> i64 {
        self.events + self.sessions + self.runs + self.instances + self.notifications
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OriginBucket {
    pub origin: String,
    pub counts: TableCounts,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UncertainItem {
    pub kind: String,
    pub detail: String,
    pub count: i64,
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestDataAudit {
    pub dry_run: bool,
    pub generated_at: String,
    pub real: TableCounts,
    pub provable: Vec<OriginBucket>,
    pub provable_total: TableCounts,
    pub uncertain: Vec<UncertainItem>,
    /// 仅 apply=true 且确实删除了数据时存在
    pub backup_path: Option<String>,
    /// 实际删除的行数（dry-run 为 None）
    pub deleted: Option<TableCounts>,
    pub fk_violations: i64,
    pub notes: Vec<String>,
}

fn count_eq(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
    origin: &str,
) -> AppResult<i64> {
    let sql = format!("SELECT COUNT(*) FROM {} WHERE {} = ?1", table, column);
    Ok(conn.query_row(&sql, params![origin], |r| r.get(0))?)
}

fn count_real(conn: &rusqlite::Connection, table: &str, column: &str) -> AppResult<i64> {
    let sql = format!("SELECT COUNT(*) FROM {} WHERE {} = 'real'", table, column);
    Ok(conn.query_row(&sql, [], |r| r.get(0))?)
}

fn counts_all_real(conn: &rusqlite::Connection) -> AppResult<TableCounts> {
    Ok(TableCounts {
        events: count_real(conn, "agent_events", "origin")?,
        sessions: count_real(conn, "agent_sessions", "origin")?,
        runs: count_real(conn, "agent_runs", "origin")?,
        instances: count_real(conn, "agent_instances", "origin")?,
        notifications: count_real(conn, "notification_history", "agent_origin")?,
    })
}

fn counts_for_origin(conn: &rusqlite::Connection, origin: &str) -> AppResult<TableCounts> {
    Ok(TableCounts {
        events: count_eq(conn, "agent_events", "origin", origin)?,
        sessions: count_eq(conn, "agent_sessions", "origin", origin)?,
        runs: count_eq(conn, "agent_runs", "origin", origin)?,
        instances: count_eq(conn, "agent_instances", "origin", origin)?,
        notifications: count_eq(conn, "notification_history", "agent_origin", origin)?,
    })
}

fn non_real_origins(conn: &rusqlite::Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT origin FROM agent_events WHERE origin <> 'real'
         UNION SELECT origin FROM agent_sessions WHERE origin <> 'real'
         UNION SELECT origin FROM agent_runs WHERE origin <> 'real'
         UNION SELECT origin FROM agent_instances WHERE origin <> 'real'
         UNION SELECT agent_origin FROM notification_history WHERE agent_origin <> 'real'
         ORDER BY 1",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn origin_sources(conn: &rusqlite::Connection, origin: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT source_id FROM (
             SELECT DISTINCT source_id FROM agent_events WHERE origin = ?1
             UNION SELECT DISTINCT source_id FROM agent_sessions WHERE origin = ?1
             UNION SELECT DISTINCT source_id FROM agent_runs WHERE origin = ?1
         ) ORDER BY source_id LIMIT 20",
    )?;
    let rows = stmt.query_map(params![origin], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn sample(conn: &rusqlite::Connection, sql: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![10i64], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn collect_uncertain(conn: &rusqlite::Connection) -> AppResult<Vec<UncertainItem>> {
    let checks: [(&str, &str, &str, &str); 4] = [
        (
            "event-prefix-only",
            "带有 http-perf 会话前缀、但缺少轮次佐证的事件（无法证明是压测数据，保持 real）",
            "SELECT COUNT(*) FROM agent_events WHERE origin = 'real' AND session_external_id LIKE 'http-perf-%' AND (run_external_id IS NULL OR run_external_id NOT LIKE 'http-perf-%')",
            "SELECT id FROM agent_events WHERE origin = 'real' AND session_external_id LIKE 'http-perf-%' AND (run_external_id IS NULL OR run_external_id NOT LIKE 'http-perf-%') ORDER BY received_at DESC LIMIT ?1",
        ),
        (
            "session-prefix-only",
            "带有 http-perf 会话前缀、但没有 http-perf 轮次的会话（保持 real）",
            "SELECT COUNT(*) FROM agent_sessions WHERE origin = 'real' AND external_id LIKE 'http-perf-%' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = agent_sessions.id AND r.external_run_id LIKE 'http-perf-%')",
            "SELECT id FROM agent_sessions WHERE origin = 'real' AND external_id LIKE 'http-perf-%' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = agent_sessions.id AND r.external_run_id LIKE 'http-perf-%') ORDER BY last_seen_at DESC LIMIT ?1",
        ),
        (
            "orphan-notification",
            "引用已不存在轮次的 Agent 通知（无法判断来源，保持 real）",
            "SELECT COUNT(*) FROM notification_history WHERE agent_origin = 'real' AND ref_type = 'agent_run' AND ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = notification_history.ref_id)",
            "SELECT id FROM notification_history WHERE agent_origin = 'real' AND ref_type = 'agent_run' AND ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = notification_history.ref_id) ORDER BY created_at DESC LIMIT ?1",
        ),
        (
            "unknown-source-event",
            "来源已从注册表移除的事件（保持 real，等待人工确认）",
            "SELECT COUNT(*) FROM agent_events WHERE origin = 'real' AND source_id NOT IN (SELECT id FROM agent_sources)",
            "SELECT id FROM agent_events WHERE origin = 'real' AND source_id NOT IN (SELECT id FROM agent_sources) ORDER BY received_at DESC LIMIT ?1",
        ),
    ];
    let mut out = Vec::new();
    for (kind, detail, count_sql, sample_sql) in checks {
        let count: i64 = conn.query_row(count_sql, [], |r| r.get(0))?;
        if count > 0 {
            out.push(UncertainItem {
                kind: kind.into(),
                detail: detail.into(),
                count,
                samples: sample(conn, sample_sql)?,
            });
        }
    }
    Ok(out)
}

fn build_report(conn: &rusqlite::Connection, dry_run: bool) -> AppResult<TestDataAudit> {
    let origins = non_real_origins(conn)?;
    let mut provable = Vec::new();
    let mut provable_total = TableCounts::default();
    for origin in origins {
        let counts = counts_for_origin(conn, &origin)?;
        provable_total.events += counts.events;
        provable_total.sessions += counts.sessions;
        provable_total.runs += counts.runs;
        provable_total.instances += counts.instances;
        provable_total.notifications += counts.notifications;
        provable.push(OriginBucket {
            sources: origin_sources(conn, &origin)?,
            origin,
            counts,
        });
    }
    Ok(TestDataAudit {
        dry_run,
        generated_at: crate::agents::now_iso(),
        real: counts_all_real(conn)?,
        provable,
        provable_total,
        uncertain: collect_uncertain(conn)?,
        backup_path: None,
        deleted: None,
        fk_violations: 0,
        notes: Vec::new(),
    })
}

fn snapshot_into(conn: &rusqlite::Connection, path: &Path) -> AppResult<()> {
    // VACUUM INTO 生成一致性快照（WAL 内容一并落盘），且不会改动源库。
    let file = path.display().to_string();
    conn.execute("VACUUM INTO ?1", params![file])?;
    Ok(())
}

fn apply_cleanup(db: &Db, backup_dir: &Path, report: &mut TestDataAudit) -> AppResult<()> {
    let total = report.provable_total.total();
    if total == 0 {
        report
            .notes
            .push("没有可证明的测试数据，未做任何修改".into());
        return Ok(());
    }
    std::fs::create_dir_all(backup_dir)?;
    let backup_path = backup_dir.join(format!(
        "testdata-audit-{}.db",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    db.with_conn(|conn| snapshot_into(conn, &backup_path))?;
    let size = std::fs::metadata(&backup_path)?.len();
    if size == 0 {
        return Err(AppError::Validation(
            "清理前数据库快照为空，已中止（未删除任何数据）".into(),
        ));
    }

    let deleted = db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> AppResult<TableCounts> {
            // 先清行动中心确认记录，避免留下指向已删除事件的残余
            conn.execute(
                "DELETE FROM action_acks WHERE
                   event_id IN (SELECT id FROM notification_history WHERE agent_origin <> 'real')
                   OR event_id IN (SELECT 'run:' || id FROM agent_runs WHERE origin <> 'real')
                   OR event_id IN (SELECT id FROM agent_events WHERE origin <> 'real')",
                [],
            )?;
            let notifications = conn.execute(
                "DELETE FROM notification_history WHERE agent_origin <> 'real'",
                [],
            )? as i64;
            let events =
                conn.execute("DELETE FROM agent_events WHERE origin <> 'real'", [])? as i64;
            let runs = conn.execute("DELETE FROM agent_runs WHERE origin <> 'real'", [])? as i64;
            let sessions =
                conn.execute("DELETE FROM agent_sessions WHERE origin <> 'real'", [])? as i64;
            let instances =
                conn.execute("DELETE FROM agent_instances WHERE origin <> 'real'", [])? as i64;
            Ok(TableCounts {
                events,
                sessions,
                runs,
                instances,
                notifications,
            })
        })();
        match result {
            Ok(counts) => {
                conn.execute_batch("COMMIT")?;
                Ok::<_, AppError>(counts)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })?;

    let fk: i64 = db.with_conn(|conn| {
        Ok::<_, AppError>(conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
            [],
            |r| r.get(0),
        )?)
    })?;
    report.backup_path = Some(backup_path.to_string_lossy().to_string());
    report.deleted = Some(deleted);
    report.fk_violations = fk;
    if fk > 0 {
        report.notes.push(format!(
            "清理后仍有 {} 处外键引用不一致，请用备份文件恢复并反馈问题",
            fk
        ));
    } else {
        report
            .notes
            .push("清理完成：仅删除可证明的测试数据；备份文件可用于完整恢复".into());
    }
    // 清理后重新统计一次真实数据量
    let report_after = db.with_conn(|conn| build_report(conn, false))?;
    report.real = report_after.real;
    report.provable = report_after.provable;
    report.provable_total = report_after.provable_total;
    report.uncertain = report_after.uncertain;
    Ok(())
}

fn audit_impl(db: &Db, backup_dir: &Path, apply: bool) -> AppResult<TestDataAudit> {
    let mut report = db.with_conn(|conn| build_report(conn, !apply))?;
    if apply {
        apply_cleanup(db, backup_dir, &mut report)?;
    } else {
        report.notes.push(
            "dry-run：未修改任何数据。确认无误后以 apply=true 重新执行（会先自动备份数据库）。"
                .into(),
        );
    }
    Ok(report)
}

#[tauri::command]
pub fn audit_test_data(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    apply: bool,
) -> AppResult<TestDataAudit> {
    let dir: PathBuf = crate::app_data_dir(&app).join("backups");
    audit_impl(db.inner(), &dir, apply)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(db: &Db) {
        db.with_conn(|conn| {
            let now = "2026-10-25T10:00:00+00:00";
            for (id, session, run, state) in [
                ("real-run", "real-sess", "real-1", "running"),
                ("bench-run", "perf-sess", "http-perf-1-run-0-0", "completed"),
            ] {
                conn.execute(
                    "INSERT INTO agent_sessions (id, source_id, external_id, status, first_seen_at, last_seen_at)
                     VALUES (?1, 'codex', ?2, 'idle', ?3, ?3)",
                    params![session, if id == "real-run" { "real-1" } else { "http-perf-1-session-0" }, now],
                )
                .ok();
                conn.execute(
                    "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, status, started_at, updated_at, origin)
                     VALUES (?1, ?2, 'codex', ?3, ?4, ?5, ?5, ?6)",
                    params![id, session, run, state, now, if id == "real-run" { "real" } else { "benchmark" }],
                )?;
            }
            conn.execute(
                "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, state, received_at, origin)
                 VALUES ('real-ev', 'codex', 'real-1', 'real-1', 'running', ?1, 'real')",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, state, received_at, origin)
                 VALUES ('bench-ev', 'codex', 'http-perf-1-session-0', 'http-perf-1-run-0-0', 'completed', ?1, 'benchmark')",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO notification_history (id, kind, title, ref_type, ref_id, occurrence, created_at, agent_origin)
                 VALUES ('bench-n', 'agent_done', '完成', 'agent_run', 'bench-run', 'bench-run:completed', ?1, 'benchmark')",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO notification_history (id, kind, title, ref_type, ref_id, occurrence, created_at, agent_origin)
                 VALUES ('real-n', 'reminder', '提醒', NULL, NULL, NULL, ?1, 'real')",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO action_acks (event_id, acked_at) VALUES ('run:bench-run', ?1), ('bench-ev', ?1)",
                params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn dry_run_never_deletes() {
        let db = Db::open_in_memory().unwrap();
        seed(&db);
        let dir = std::env::temp_dir().join(format!("td-audit-{}", uuid::Uuid::new_v4()));
        let report = audit_impl(&db, &dir, false).unwrap();
        assert!(report.dry_run);
        assert_eq!(report.provable_total.runs, 1);
        assert_eq!(report.provable_total.events, 1);
        assert_eq!(report.provable_total.notifications, 1);
        assert!(report.backup_path.is_none());
        assert_eq!(
            db.with_conn(|conn| Ok::<_, AppError>(conn.query_row(
                "SELECT COUNT(*) FROM agent_runs",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
            2
        );
    }

    #[test]
    fn apply_deletes_only_provable_data_with_backup() {
        let db = Db::open_in_memory().unwrap();
        seed(&db);
        let dir = std::env::temp_dir().join(format!("td-audit-{}", uuid::Uuid::new_v4()));
        let report = audit_impl(&db, &dir, true).unwrap();
        assert_eq!(report.deleted.as_ref().unwrap().runs, 1);
        assert_eq!(report.deleted.as_ref().unwrap().events, 1);
        assert_eq!(report.deleted.as_ref().unwrap().notifications, 1);
        assert!(report.backup_path.as_ref().unwrap().ends_with(".db"));
        assert!(std::path::Path::new(report.backup_path.as_ref().unwrap()).exists());
        assert_eq!(report.fk_violations, 0);
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_runs WHERE origin <> 'real'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_runs WHERE origin = 'real'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_events WHERE id = 'real-ev'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM notification_history WHERE id = 'real-n'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM action_acks", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok::<_, AppError>(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_without_provable_data_does_nothing() {
        let db = Db::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(format!("td-audit-{}", uuid::Uuid::new_v4()));
        let report = audit_impl(&db, &dir, true).unwrap();
        assert!(report.deleted.is_none());
        assert!(report.backup_path.is_none());
        assert!(report.notes.iter().any(|n| n.contains("没有可证明")));
    }
}
