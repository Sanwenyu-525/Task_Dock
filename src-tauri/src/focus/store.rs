//! SQLite 读写：`focus_sessions`（会话与历史）与 `focus_daily_stats`（按本地日期聚合）。
//!
//! 写入频率约定：只在状态变化、每 30 秒恢复节点与完成时落库，**绝不每秒写库**。
//! 会话的 `accumulated_ms` 是权威有效时长；`running_since` 仅用于重启恢复与展示。

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::model::{
    local_day, parse_ts, ts, FocusHistoryItem, SessionKind, SessionState, TodayStats,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 迁移草稿（集成会话会把等价 SQL 追加到 `db::MIGRATIONS`；版本号由集成统一分配）。
pub const FOCUS_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('focus','short_break','long_break')),
  state TEXT NOT NULL CHECK (state IN ('focusing','paused','break','completed','cancelled')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  task_id TEXT,
  task_title TEXT NOT NULL DEFAULT '',
  planned_seconds INTEGER NOT NULL CHECK (planned_seconds > 0),
  extension_seconds INTEGER NOT NULL DEFAULT 0 CHECK (extension_seconds >= 0),
  accumulated_ms INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_ms >= 0),
  started_at TEXT NOT NULL,
  running_since TEXT,
  last_tick_at TEXT,
  paused_at TEXT,
  pause_reason TEXT,
  ended_at TEXT,
  round_index INTEGER NOT NULL DEFAULT 1 CHECK (round_index >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_single_active
  ON focus_sessions(active) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_focus_task ON focus_sessions(task_id);

CREATE TABLE IF NOT EXISTS focus_daily_stats (
  day TEXT PRIMARY KEY NOT NULL,
  focus_ms INTEGER NOT NULL DEFAULT 0 CHECK (focus_ms >= 0),
  break_ms INTEGER NOT NULL DEFAULT 0 CHECK (break_ms >= 0),
  completed_focus INTEGER NOT NULL DEFAULT 0 CHECK (completed_focus >= 0),
  updated_at TEXT NOT NULL
);
"#;

/// 一行会话记录的持久化视图（core 负责与内存状态互转）。
#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub id: String,
    pub kind: SessionKind,
    pub state: SessionState,
    pub task_id: Option<String>,
    pub task_title: String,
    pub planned_seconds: i64,
    pub extension_seconds: i64,
    pub accumulated_ms: i64,
    pub started_at: DateTime<Utc>,
    pub running_since: Option<DateTime<Utc>>,
    pub last_tick_at: Option<DateTime<Utc>>,
    pub paused_at: Option<DateTime<Utc>>,
    pub pause_reason: Option<String>,
    pub ended_at: Option<DateTime<Utc>>,
    pub round_index: i64,
}

impl SessionRecord {
    fn active_flag(&self) -> i64 {
        if self.state.is_active() {
            1
        } else {
            0
        }
    }
}

pub fn insert_session(conn: &Connection, rec: &SessionRecord, now: DateTime<Utc>) -> AppResult<()> {
    let now_s = ts(now);
    conn.execute(
        "INSERT INTO focus_sessions (
            id, kind, state, active, task_id, task_title, planned_seconds, extension_seconds,
            accumulated_ms, started_at, running_since, last_tick_at, paused_at, pause_reason,
            ended_at, round_index, created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17)",
        params![
            rec.id,
            rec.kind.as_str(),
            rec.state.as_str(),
            rec.active_flag(),
            rec.task_id,
            rec.task_title,
            rec.planned_seconds,
            rec.extension_seconds,
            rec.accumulated_ms,
            ts(rec.started_at),
            rec.running_since.map(ts),
            rec.last_tick_at.map(ts),
            rec.paused_at.map(ts),
            rec.pause_reason,
            rec.ended_at.map(ts),
            rec.round_index,
            now_s,
        ],
    )?;
    Ok(())
}

pub fn update_session(conn: &Connection, rec: &SessionRecord, now: DateTime<Utc>) -> AppResult<()> {
    conn.execute(
        "UPDATE focus_sessions SET
            kind = ?2, state = ?3, active = ?4, task_id = ?5, task_title = ?6,
            planned_seconds = ?7, extension_seconds = ?8, accumulated_ms = ?9,
            running_since = ?10, last_tick_at = ?11, paused_at = ?12, pause_reason = ?13,
            ended_at = ?14, round_index = ?15, updated_at = ?16
         WHERE id = ?1",
        params![
            rec.id,
            rec.kind.as_str(),
            rec.state.as_str(),
            rec.active_flag(),
            rec.task_id,
            rec.task_title,
            rec.planned_seconds,
            rec.extension_seconds,
            rec.accumulated_ms,
            rec.running_since.map(ts),
            rec.last_tick_at.map(ts),
            rec.paused_at.map(ts),
            rec.pause_reason,
            rec.ended_at.map(ts),
            rec.round_index,
            ts(now),
        ],
    )?;
    Ok(())
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    let kind_raw: String = row.get("kind")?;
    let state_raw: String = row.get("state")?;
    let started_raw: String = row.get("started_at")?;
    Ok(SessionRecord {
        id: row.get("id")?,
        kind: SessionKind::parse(&kind_raw).unwrap_or(SessionKind::Focus),
        state: SessionState::parse(&state_raw).unwrap_or(SessionState::Cancelled),
        task_id: row.get("task_id")?,
        task_title: row.get("task_title")?,
        planned_seconds: row.get("planned_seconds")?,
        extension_seconds: row.get("extension_seconds")?,
        accumulated_ms: row.get("accumulated_ms")?,
        started_at: parse_ts(&started_raw).unwrap_or_else(Utc::now),
        running_since: row
            .get::<_, Option<String>>("running_since")?
            .and_then(|s| parse_ts(&s)),
        last_tick_at: row
            .get::<_, Option<String>>("last_tick_at")?
            .and_then(|s| parse_ts(&s)),
        paused_at: row
            .get::<_, Option<String>>("paused_at")?
            .and_then(|s| parse_ts(&s)),
        pause_reason: row.get("pause_reason")?,
        ended_at: row
            .get::<_, Option<String>>("ended_at")?
            .and_then(|s| parse_ts(&s)),
        round_index: row.get("round_index")?,
    })
}

/// 读取唯一活跃会话。数据库层的 `active = 1` 唯一索引保证不会出现多会话。
pub fn load_active(db: &Db) -> AppResult<Option<SessionRecord>> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT * FROM focus_sessions WHERE active = 1 LIMIT 1",
            [],
            row_to_record,
        )
        .optional()
        .map_err(AppError::from)
    })
}

/// 今日聚合（未包含进程内尚未落库的增量，由 core 补齐）。
pub fn read_today(db: &Db, day: &str) -> AppResult<TodayStats> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT focus_ms, break_ms, completed_focus FROM focus_daily_stats WHERE day = ?1",
                params![day],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let (focus_ms, break_ms, completed_focus) = row.unwrap_or((0, 0, 0));
        Ok(TodayStats {
            day: day.to_string(),
            focus_ms,
            break_ms,
            completed_focus,
        })
    })
}

/// 增量写今日聚合：`focus_delta_ms` / `break_delta_ms` / `completed_delta` 可同时为 0。
pub fn upsert_daily(
    conn: &Connection,
    day: &str,
    focus_delta_ms: i64,
    break_delta_ms: i64,
    completed_delta: i64,
    now: DateTime<Utc>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO focus_daily_stats (day, focus_ms, break_ms, completed_focus, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(day) DO UPDATE SET
            focus_ms = focus_ms + excluded.focus_ms,
            break_ms = break_ms + excluded.break_ms,
            completed_focus = completed_focus + excluded.completed_focus,
            updated_at = excluded.updated_at",
        params![
            day,
            focus_delta_ms,
            break_delta_ms,
            completed_delta,
            ts(now)
        ],
    )?;
    Ok(())
}

/// 任意设置键写入（会话内部状态，避免为专注模块再开一张 KV 表）。
pub fn upsert_setting(
    conn: &Connection,
    key: &str,
    value: &Value,
    now: DateTime<Utc>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, serde_json::to_string(value)?, ts(now)],
    )?;
    Ok(())
}

/// 通知历史：与通知中心一致，失败不阻断会话状态落库（由调用方统一提交）。
pub fn insert_notification(
    conn: &Connection,
    id: &str,
    kind: &str,
    title: &str,
    body: &str,
    ref_type: &str,
    ref_id: &str,
    occurrence: &str,
    now: DateTime<Utc>,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO notification_history
            (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8)",
        params![id, kind, title, body, ref_type, ref_id, occurrence, ts(now)],
    )?;
    Ok(())
}

/// 最近历史。任务被硬删除时保留快照标题并标记 `task_deleted`（不级联删除历史）。
pub fn list_history(db: &Db, limit: u32) -> AppResult<Vec<FocusHistoryItem>> {
    let limit = limit.clamp(1, 200);
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.kind, s.state, s.task_id, s.task_title, s.planned_seconds,
                    s.accumulated_ms, s.started_at, s.ended_at, s.round_index,
                    CASE WHEN s.task_id IS NOT NULL AND t.id IS NULL THEN 1 ELSE 0 END AS task_deleted
             FROM focus_sessions s
             LEFT JOIN tasks t ON t.id = s.task_id
             WHERE s.active = 0
             ORDER BY s.started_at DESC, s.updated_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            let kind_raw: String = r.get(1)?;
            let state_raw: String = r.get(2)?;
            let started_raw: String = r.get(7)?;
            Ok(FocusHistoryItem {
                id: r.get(0)?,
                kind: SessionKind::parse(&kind_raw).unwrap_or(SessionKind::Focus),
                state: SessionState::parse(&state_raw).unwrap_or(SessionState::Cancelled),
                task_id: r.get(3)?,
                task_title: r.get(4)?,
                task_deleted: r.get::<_, i64>(10)? != 0,
                planned_seconds: r.get(5)?,
                accumulated_ms: r.get(6)?,
                started_at: started_raw,
                ended_at: r.get(8)?,
                round_index: r.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// 任务存在性校验：开始专注只记录当前任务，**不改变任务状态**。
pub fn task_title(conn: &Connection, task_id: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT title FROM tasks WHERE id = ?1",
        params![task_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(AppError::from)
}

/// 今日键（便于 core 与测试共享）。
pub fn day_of(now: DateTime<Utc>) -> String {
    local_day(now)
}

#[cfg(test)]
pub fn create_test_schema(db: &Db) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute_batch(FOCUS_SCHEMA_SQL)?;
        Ok(())
    })
}
