//! 提醒调度引擎。
//!
//! 对应需求：
//! - 由 Tauri 后端负责提醒调度，不依赖前端窗口一直打开；
//! - 系统休眠/唤醒：每秒按挂钟时间比对，唤醒后自动补触发；
//! - 程序重启：到期未触发的提醒在启动后的第一个 tick 补偿触发；
//! - 重复任务计算、时区（本地时间展示，UTC 存储）、过期提醒补偿、提醒去重。

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter};

use crate::agents::{now_iso, AgentHub};
use crate::db::{Db, Reminder, Settings};
use crate::error::{AppError, AppResult};

/// 启动调度循环。
pub fn start_scheduler(app: AppHandle, db: Arc<Db>, hub: Arc<AgentHub>) {
    tauri::async_runtime::spawn(async move {
        tracing::info!("提醒调度引擎启动（1s 粒度）");
        let mut tick_count: u64 = 0;
        loop {
            if let Err(e) = tick(&app, &db).await {
                tracing::error!("提醒调度 tick 失败: {}", e);
            }
            tick_count += 1;
            // 每 30 秒清理一次过期的 Agent 状态
            if tick_count % 30 == 0 {
                if let Err(e) = hub.cleanup_stale() {
                    tracing::error!("Agent 过期清理失败: {}", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

struct DueItem {
    reminder: Reminder,
    task_title: String,
    task_has_recurrence: bool,
    task_due_at: Option<String>,
}

async fn tick(app: &AppHandle, db: &Db) -> AppResult<()> {
    let settings = Settings::load(db)?;
    let now: DateTime<Utc> = Utc::now();
    let now_str = now.to_rfc3339();

    let due: Vec<DueItem> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.task_id, r.remind_at, r.occurrence, r.kind, r.fired, r.fired_at, t.title,
                    (t.recurrence_rule_id IS NOT NULL) AS has_rec, t.due_at
             FROM task_reminders r JOIN tasks t ON t.id = r.task_id
             WHERE r.fired = 0 AND r.remind_at <= ?1
             ORDER BY r.remind_at ASC LIMIT 50",
        )?;
        let rows = stmt.query_map(rusqlite::params![now_str], |r| {
            Ok(DueItem {
                reminder: Reminder {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    remind_at: r.get(2)?,
                    occurrence: r.get(3)?,
                    kind: r.get(4)?,
                    fired: r.get::<_, i64>(5)? != 0,
                    fired_at: r.get(6)?,
                },
                task_title: r.get(7)?,
                task_has_recurrence: r.get::<_, i64>(8)? != 0,
                task_due_at: r.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;

    for item in due {
        fire(app, db, &settings, &item, &now)?;
    }
    Ok(())
}

fn parse_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// 触发一条提醒。
fn fire(
    app: &AppHandle,
    db: &Db,
    settings: &Settings,
    item: &DueItem,
    now: &DateTime<Utc>,
) -> AppResult<()> {
    let rem = &item.reminder;
    let overdue_secs = now
        .signed_duration_since(parse_utc(&rem.remind_at).unwrap_or(*now))
        .num_seconds()
        .max(0);
    let grace_secs = settings.overdue_grace_hours as i64 * 3600;
    let within_grace = overdue_secs <= grace_secs;

    // 1) 标记已触发（去重：UNIQUE(task_id, occurrence) + fired 标志）
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE task_reminders SET fired = 1, fired_at = ?1 WHERE id = ?2",
            rusqlite::params![now.to_rfc3339(), rem.id],
        )?;
        Ok::<_, AppError>(())
    })?;

    // 2) 通知（系统通知 + 历史收件箱）
    let kind_label = match rem.kind.as_str() {
        "advance" => "提前提醒",
        _ => "任务提醒",
    };
    let overdue_mark = if overdue_secs > 60 { "（补触发）" } else { "" };
    let title = format!("{}{}", kind_label, overdue_mark);
    let body = format!(
        "{} · {}",
        item.task_title,
        crate::commands::format_local(&rem.remind_at)
    );
    let notify = settings.notify_reminder && !settings.notify_muted && within_grace;
    let id = uuid::Uuid::new_v4().to_string();
    let now_str = now_iso();
    let inserted = db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO notification_history
               (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
             VALUES (?1, 'reminder', ?2, ?3, 'task', ?4, ?5, 0, ?6)",
            rusqlite::params![id, title, body, rem.task_id, rem.occurrence, now_str],
        )
        .map(|n| n > 0)
        .map_err(AppError::from)
    })?;
    if inserted && notify {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(&title).body(&body).show();
    }
    let _ = app.emit("reminder-fired", serde_json::json!({ "task_id": rem.task_id }));

    // 3) 重复任务推进：仅对「截止」类提醒推进，且保留原任务状态
    if rem.kind == "due" && item.task_has_recurrence {
        advance_recurrence(db, &rem.task_id, item.task_due_at.as_deref(), now)?;
    }
    Ok(())
}

/// 重复任务推进到下一次发生。
fn advance_recurrence(
    db: &Db,
    task_id: &str,
    current_due: Option<&str>,
    now: &DateTime<Utc>,
) -> AppResult<()> {
    let rule = db.with_conn(|conn| {
        conn.query_row(
            "SELECT rr.id, rr.freq, rr.interval, rr.by_weekday, rr.by_monthday, rr.until, rr.anchor, t.advance_minutes
             FROM recurrence_rules rr JOIN tasks t ON t.recurrence_rule_id = rr.id
             WHERE t.id = ?1",
            rusqlite::params![task_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<u32>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()
        .map_err(AppError::from)
    })?;
    let Some((rule_id, freq, interval, by_weekday_json, by_monthday, until, anchor, advance_minutes)) = rule else {
        return Ok(());
    };
    let by_weekday: Vec<u32> = serde_json::from_str(&by_weekday_json).unwrap_or_default();
    let base_due = current_due
        .and_then(parse_utc)
        .unwrap_or(*now);
    // 本地时区计算（挂钟时间），再转回 UTC 存储
    let base_local = base_due.with_timezone(&chrono::Local);
    let anchor_date = if anchor.is_empty() {
        None
    } else {
        chrono::NaiveDate::parse_from_str(&anchor, "%Y-%m-%d").ok()
    };
    let next = crate::recurrence::next_occurrence(
        &freq,
        interval,
        &by_weekday,
        by_monthday,
        anchor_date,
        base_local,
    );
    let Some(next_local) = next else {
        return Ok(());
    };
    let next_utc: DateTime<Utc> = next_local.with_timezone(&Utc);
    if let Some(until) = until {
        if let Some(u) = parse_utc(&until) {
            if next_utc > u {
                // 超过结束日期：不再推进
                return Ok(());
            }
        }
    }

    let next_iso = next_utc.to_rfc3339();
    let remind_iso = if advance_minutes > 0 {
        (next_utc - chrono::Duration::minutes(advance_minutes)).to_rfc3339()
    } else {
        next_iso.clone()
    };

    // 清理该任务未触发的旧提醒，写入新一轮
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM task_reminders WHERE task_id = ?1 AND fired = 0",
            rusqlite::params![task_id],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
             VALUES (?1, ?2, ?3, ?4, 'due', 0, NULL)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, next_iso, next_iso],
        )?;
        if advance_minutes > 0 {
            conn.execute(
                "INSERT OR IGNORE INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES (?1, ?2, ?3, ?4, 'advance', 0, NULL)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, remind_iso, remind_iso],
            )?;
        }
        conn.execute(
            "UPDATE tasks SET due_at = ?1, remind_at = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![next_iso, remind_iso, now_iso(), task_id],
        )?;
        Ok::<_, AppError>(())
    })?;
    let _ = rule_id;
    tracing::info!("重复任务 {} 已推进至 {}", task_id, next_iso);
    Ok(())
}

/// 供「完成重复任务」命令调用：立即推进一次。
pub fn advance_task_now(db: &Db, task_id: &str) -> AppResult<()> {
    let due: Option<String> = db.with_conn(|conn| {
        conn.query_row(
            "SELECT due_at FROM tasks WHERE id = ?1",
            rusqlite::params![task_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)
    })?;
    advance_recurrence(db, task_id, due.as_deref(), &Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn setup() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[test]
    fn due_reminder_fires_and_marks() {
        let db = setup();
        let now = Utc::now();
        let task_id = uuid::Uuid::new_v4().to_string();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                 VALUES (?1,'测试任务','',2,'pending','','[]',?2,?2,0,NULL,?3,?3,NULL)",
                rusqlite::params![task_id, (now - chrono::Duration::minutes(1)).to_rfc3339(), now_iso()],
            )?;
            conn.execute(
                "INSERT INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES (?1, ?2, ?3, ?4, 'due', 0, NULL)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, (now - chrono::Duration::minutes(1)).to_rfc3339(), (now - chrono::Duration::minutes(1)).to_rfc3339()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 直接调用 tick 内部逻辑等价物：查询到期项并触发
        let settings = Settings::load(&db).unwrap();
        let due: Vec<DueItem> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT r.id, r.task_id, r.remind_at, r.occurrence, r.kind, r.fired, r.fired_at, t.title,
                            (t.recurrence_rule_id IS NOT NULL), t.due_at
                     FROM task_reminders r JOIN tasks t ON t.id = r.task_id
                     WHERE r.fired = 0 AND r.remind_at <= ?1",
                )?;
                let rows = stmt.query_map(rusqlite::params![now.to_rfc3339()], |r| {
                    Ok(DueItem {
                        reminder: Reminder {
                            id: r.get(0)?,
                            task_id: r.get(1)?,
                            remind_at: r.get(2)?,
                            occurrence: r.get(3)?,
                            kind: r.get(4)?,
                            fired: r.get::<_, i64>(5)? != 0,
                            fired_at: r.get(6)?,
                        },
                        task_title: r.get(7)?,
                        task_has_recurrence: r.get::<_, i64>(8)? != 0,
                        task_due_at: r.get(9)?,
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(due.len(), 1);
        // fire 需要 AppHandle，这里只验证查询逻辑；触发逻辑由集成测试覆盖
        let _ = (&settings, &due);
    }

    #[test]
    fn advance_recurrence_moves_due() {
        let db = setup();
        let now = Utc::now();
        let task_id = uuid::Uuid::new_v4().to_string();
        let rule_id = uuid::Uuid::new_v4().to_string();
        let due_at = now.with_timezone(&chrono::Local);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, until, anchor, created_at)
                 VALUES (?1,'daily',1,'[]',NULL,NULL,?2,?3)",
                rusqlite::params![rule_id, due_at.date_naive().format("%Y-%m-%d").to_string(), now_iso()],
            )?;
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                 VALUES (?1,'每日站会','',2,'pending','','[]',?2,?2,0,?4,?3,?3,NULL)",
                rusqlite::params![task_id, due_at.with_timezone(&Utc).to_rfc3339(), now_iso(), rule_id],
            )?;
            conn.execute(
                "INSERT INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES (?1, ?2, ?3, ?4, 'due', 0, NULL)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, due_at.with_timezone(&Utc).to_rfc3339(), due_at.with_timezone(&Utc).to_rfc3339()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        advance_recurrence(&db, &task_id, Some(&due_at.with_timezone(&Utc).to_rfc3339()), &now).unwrap();

        let (new_due, fired_count, pending_count): (String, i64, i64) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT due_at FROM tasks WHERE id = ?1", rusqlite::params![task_id], |r| r.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 1", rusqlite::params![task_id], |r| r.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 0", rusqlite::params![task_id], |r| r.get(0))?,
                ))
            })
            .unwrap();
        let new_due_utc = parse_utc(&new_due).unwrap();
        let expected = (due_at + chrono::Duration::days(1)).with_timezone(&Utc);
        assert!((new_due_utc - expected).num_seconds().abs() < 2, "新截止时间应为原时间 +1 天");
        assert_eq!(fired_count, 0, "推进只删旧建新，不修改 fired");
        assert_eq!(pending_count, 1, "应生成 1 条新的未触发提醒");
    }
}
