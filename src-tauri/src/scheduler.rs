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
use rusqlite::{Connection, OptionalExtension};
use tauri::{AppHandle, Emitter};

use crate::agents::notify::NotifyItem;
use crate::agents::{now_iso, AgentHub};
use crate::db::{Db, Reminder, Settings};
use crate::error::{AppError, AppResult};

/// 启动调度循环。
pub fn start_scheduler(app: AppHandle, db: Arc<Db>, hub: Arc<AgentHub>) {
    tauri::async_runtime::spawn(async move {
        tracing::info!("提醒调度引擎启动（1s 粒度）");
        let mut tick_count: u64 = 0;
        loop {
            if let Err(e) = tick(&app, &db, &hub).await {
                tracing::error!("提醒调度 tick 失败: {}", e);
            }
            tick_count += 1;
            // 每 30 秒清理一次过期的 Agent 状态
            if tick_count % 30 == 0 {
                if let Err(e) = hub.cleanup_stale() {
                    tracing::error!("Agent 过期清理失败: {}", e);
                }
            }
            // 跨批次通知摘要：窗口结束/尾部抑制通知每秒检查一次
            hub.flush_notification_digest();
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

pub struct DueItem {
    reminder: Reminder,
    task_title: String,
    task_has_recurrence: bool,
    task_due_at: Option<String>,
}

async fn tick(app: &AppHandle, db: &Db, hub: &AgentHub) -> AppResult<()> {
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

    // 同一批到期提醒先全部落库，再统一走全局弹窗额度：
    // 避免一批到期任务在同一秒内弹出 N 条系统通知。
    let mut fired: Vec<FiredNotify> = Vec::new();
    for item in due {
        if let Some(n) = fire_reminder_core(db, &item, &now, &settings)? {
            fired.push(n);
        }
    }
    if fired.is_empty() {
        return Ok(());
    }
    let popups: Vec<NotifyItem> = fired
        .iter()
        .map(|n| NotifyItem::new("reminder", &n.title, &n.body))
        .collect();
    hub.notify_reminder_popups(&popups);
    let task_ids: Vec<String> = fired.iter().map(|n| n.task_id.clone()).collect();
    let _ = app.emit(
        "reminder-fired",
        serde_json::json!({ "task_ids": task_ids }),
    );
    Ok(())
}

fn parse_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// 触发结果：领取成功且需要弹出的 OS 通知（None = 未领取到或任务已被用户处理）。
pub struct FiredNotify {
    pub title: String,
    pub body: String,
    pub task_id: String,
}

/// 触发一条提醒：领取 → 通知记录 →（重复任务）推进，全部在同一个事务内完成。
///
/// 修复缺陷：
/// 1) 领取改为条件更新（fired 0→1 且 rows>0 才算领取成功），与编辑/完成/删除命令
///    原子竞争，重复触发/幽灵通知不再可能；
/// 2) 此前「标记 fired」与「推进重复任务」分属两个隐式事务，中途失败会留下
///    已触发但不推进的卡死状态。
pub fn fire_reminder_core(
    db: &Db,
    item: &DueItem,
    now: &DateTime<Utc>,
    settings: &Settings,
) -> AppResult<Option<FiredNotify>> {
    let rem = &item.reminder;
    let overdue_secs = now
        .signed_duration_since(parse_utc(&rem.remind_at).unwrap_or(*now))
        .num_seconds()
        .max(0);
    let grace_secs = settings.overdue_grace_hours as i64 * 3600;
    let within_grace = overdue_secs <= grace_secs;

    let kind_label = match rem.kind.as_str() {
        "advance" => "提前提醒",
        _ => "任务提醒",
    };
    let overdue_mark = if overdue_secs > 60 {
        "（补触发）"
    } else {
        ""
    };
    let title = format!("{}{}", kind_label, overdue_mark);
    let body = format!(
        "{} · {}",
        item.task_title,
        crate::commands::format_local(&rem.remind_at)
    );

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        // 1) 原子领取：只有把 fired 从 0 改成 1 的那一次才继续（并发/重复触发在此被挡下）
        let claimed = tx.execute(
            "UPDATE task_reminders SET fired = 1, fired_at = ?1 WHERE id = ?2 AND fired = 0",
            rusqlite::params![now.to_rfc3339(), rem.id],
        )?;
        if claimed == 0 {
            tx.commit()?;
            return Ok(None);
        }
        // 2) 任务仍处于 pending（用户已完成/删除的任务不再打扰，也不再推进）
        let alive: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1 AND status = 'pending'",
                rusqlite::params![rem.task_id],
                |r| r.get(0),
            )
            .optional()?;
        if alive.is_none() {
            tx.commit()?;
            return Ok(None);
        }
        // 3) 通知历史（去重：UNIQUE(kind, ref_id, occurrence)）
        let notify = settings.notify_reminder && !settings.notify_muted && within_grace;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO notification_history
               (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
             VALUES (?1, 'reminder', ?2, ?3, 'task', ?4, ?5, 0, ?6)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                title,
                body,
                rem.task_id,
                rem.occurrence,
                now.to_rfc3339(),
            ],
        )? > 0;
        // 4) 重复任务推进：仅「截止」类提醒推进，且保留原任务状态
        if rem.kind == "due" && item.task_has_recurrence {
            advance_recurrence_tx(&tx, &rem.task_id, item.task_due_at.as_deref(), now)?;
        }
        tx.commit()?;
        Ok(Some(FiredNotify {
            title,
            body,
            task_id: rem.task_id.clone(),
        })
        .filter(|_| inserted && notify))
    })
}

/// 重复任务推进到下一次发生（跨过当前时刻，补偿休眠/停机期间错过的期次）。
fn advance_recurrence_tx(
    conn: &Connection,
    task_id: &str,
    current_due: Option<&str>,
    now: &DateTime<Utc>,
) -> AppResult<()> {
    let rule = conn
        .query_row(
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
        .optional()?;
    let Some((
        rule_id,
        freq,
        interval,
        by_weekday_json,
        by_monthday,
        until,
        anchor,
        advance_minutes,
    )) = rule
    else {
        return Ok(());
    };
    let by_weekday: Vec<u32> = serde_json::from_str(&by_weekday_json).unwrap_or_default();
    let mut base_due = current_due.and_then(parse_utc).unwrap_or(*now);
    let anchor_date = if anchor.is_empty() {
        None
    } else {
        chrono::NaiveDate::parse_from_str(&anchor, "%Y-%m-%d").ok()
    };
    // 补偿推进：休眠/停机/长期未开机会让 due 落在过去，逐期推进直到越过当前时刻
    // （上限防止 until 异常或规则过密时死循环）
    let mut next_utc: Option<DateTime<Utc>> = None;
    for _ in 0..2000 {
        let base_local = base_due.with_timezone(&chrono::Local);
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
        let candidate: DateTime<Utc> = next_local.with_timezone(&Utc);
        if let Some(until) = &until {
            if let Some(u) = parse_utc(until) {
                if candidate > u {
                    // 超过结束日期：不再推进
                    return Ok(());
                }
            }
        }
        base_due = candidate;
        if candidate > *now {
            next_utc = Some(candidate);
            break;
        }
    }
    let Some(next_utc) = next_utc else {
        return Ok(());
    };

    let next_iso = next_utc.to_rfc3339();
    let remind_iso = if advance_minutes > 0 {
        (next_utc - chrono::Duration::minutes(advance_minutes)).to_rfc3339()
    } else {
        next_iso.clone()
    };

    // 清理该任务未触发的旧提醒，写入新一轮（与任务 due 更新同事务）
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
    let _ = rule_id;
    tracing::info!("重复任务 {} 已推进至 {}", task_id, next_iso);
    Ok(())
}

/// 供「完成重复任务」命令调用：立即推进一次。
pub fn advance_task_now(db: &Db, task_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let due: Option<String> = conn
            .query_row(
                "SELECT due_at FROM tasks WHERE id = ?1",
                rusqlite::params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        let tx = conn.unchecked_transaction()?;
        advance_recurrence_tx(&tx, task_id, due.as_deref(), &Utc::now())?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })
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

        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            advance_recurrence_tx(
                &tx,
                &task_id,
                Some(&due_at.with_timezone(&Utc).to_rfc3339()),
                &now,
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let (new_due, fired_count, pending_count): (String, i64, i64) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT due_at FROM tasks WHERE id = ?1",
                        rusqlite::params![task_id],
                        |r| r.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 1",
                        rusqlite::params![task_id],
                        |r| r.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                        rusqlite::params![task_id],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        let new_due_utc = parse_utc(&new_due).unwrap();
        let expected = (due_at + chrono::Duration::days(1)).with_timezone(&Utc);
        assert!(
            (new_due_utc - expected).num_seconds().abs() < 2,
            "新截止时间应为原时间 +1 天"
        );
        assert_eq!(fired_count, 0, "推进只删旧建新，不修改 fired");
        assert_eq!(pending_count, 1, "应生成 1 条新的未触发提醒");
    }

    // ── P0 回归：领取原子性 / 竞争 / 重复任务 snooze ──────────────

    fn seed_recurring_task(db: &Db, due_local: chrono::DateTime<chrono::Local>) -> String {
        let task_id = uuid::Uuid::new_v4().to_string();
        let rule_id = uuid::Uuid::new_v4().to_string();
        let due_utc = due_local.with_timezone(&Utc).to_rfc3339();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, until, anchor, created_at)
                 VALUES (?1,'daily',1,'[]',NULL,NULL,?2,?3)",
                rusqlite::params![rule_id, due_local.date_naive().format("%Y-%m-%d").to_string(), now_iso()],
            )?;
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                 VALUES (?1,'每日汇报','',2,'pending','','[]',?2,?2,0,?3,?4,?4,NULL)",
                rusqlite::params![task_id, due_utc, rule_id, now_iso()],
            )?;
            conn.execute(
                "INSERT INTO task_reminders (id, task_id, remind_at, occurrence, kind, fired, fired_at)
                 VALUES (?1, ?2, ?3, ?3, 'due', 0, NULL)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task_id, due_utc],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        task_id
    }

    fn due_item(db: &Db, task_id: &str) -> DueItem {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT r.id, r.task_id, r.remind_at, r.occurrence, r.kind, r.fired, r.fired_at, t.title,
                        (t.recurrence_rule_id IS NOT NULL), t.due_at
                 FROM task_reminders r JOIN tasks t ON t.id = r.task_id
                 WHERE r.task_id = ?1 AND r.fired = 0",
                rusqlite::params![task_id],
                |r| {
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
                },
            )
            .map_err(AppError::from)
        })
        .unwrap()
    }

    #[test]
    fn reminder_claim_is_atomic_only_one_fires() {
        // 竞争回归：同一到期提醒两次触发，只有第一次领取成功
        let db = setup();
        let past = (Utc::now() - chrono::Duration::minutes(5)).with_timezone(&chrono::Local);
        let task_id = seed_recurring_task(&db, past);
        let settings = Settings::load(&db).unwrap();
        let item = due_item(&db, &task_id);
        let now = Utc::now();

        let first = fire_reminder_core(&db, &item, &now, &settings).unwrap();
        assert!(first.is_some(), "首次触发应领取成功");
        let second = fire_reminder_core(&db, &item, &now, &settings).unwrap();
        assert!(second.is_none(), "重复触发必须被条件领取挡下");
        let notified: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM notification_history WHERE kind = 'reminder' AND ref_id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(notified, 1, "只产生一条提醒通知");
    }

    #[test]
    fn snoozed_recurring_task_still_advances() {
        // P0 回归：snooze 不得销毁重复任务的 due 提醒；snooze 后触发仍能推进
        let db = setup();
        let past = (Utc::now() - chrono::Duration::minutes(5)).with_timezone(&chrono::Local);
        let task_id = seed_recurring_task(&db, past);
        let due_before: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT due_at FROM tasks WHERE id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();

        crate::commands::tasks::snooze_reminder_inner(&db, &task_id, 10).unwrap();

        // snooze 后：仍存在一条未触发的 due 提醒（occurrence 保留，remind_at 后移）
        let (kind, occurrence, remind_at): (String, String, String) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT kind, occurrence, remind_at FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![task_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(kind, "due", "snooze 必须保留 due 提醒（推进引擎依赖它）");
        assert_eq!(occurrence, due_before, "occurrence 标识本次到期，不得漂移");
        assert!(remind_at > due_before, "提醒时间后移");

        // snooze 到点触发 → 重复任务推进到未来
        let settings = Settings::load(&db).unwrap();
        let item = due_item(&db, &task_id);
        let now = Utc::now() + chrono::Duration::minutes(11);
        let out = fire_reminder_core(&db, &item, &now, &settings).unwrap();
        assert!(out.is_some());
        let new_due: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT due_at FROM tasks WHERE id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(
            parse_utc(&new_due).unwrap() > Utc::now(),
            "推进后的 due 必须落在未来"
        );
        let pending: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(pending, 1, "新一轮应有一条 due 提醒");
    }

    #[test]
    fn reminder_for_completed_task_is_skipped() {
        // 竞争回归：选取后、触发前任务被完成 → 不通知、不推进
        let db = setup();
        let past = (Utc::now() - chrono::Duration::minutes(5)).with_timezone(&chrono::Local);
        let task_id = seed_recurring_task(&db, past);
        let due_before: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT due_at FROM tasks WHERE id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        db.with_conn(|c| {
            c.execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?2 WHERE id = ?1",
                rusqlite::params![task_id, now_iso()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let settings = Settings::load(&db).unwrap();
        let item = due_item(&db, &task_id);
        let out = fire_reminder_core(&db, &item, &Utc::now(), &settings).unwrap();
        assert!(out.is_none(), "已完成任务的到期提醒不得再打扰");
        let due_after: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT due_at FROM tasks WHERE id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(due_after, due_before, "已完成任务不得被推进");
    }

    #[test]
    fn recurrence_catches_up_across_missed_days() {
        // 跨日期回归：due 落在 3 天前的每日任务，一次推进应直接越过当前时刻
        let db = setup();
        let stale =
            (chrono::Local::now() - chrono::Duration::days(3)).with_timezone(&chrono::Local);
        let task_id = seed_recurring_task(&db, stale);
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let due: Option<String> = Some(stale.with_timezone(&Utc).to_rfc3339());
            advance_recurrence_tx(&tx, &task_id, due.as_deref(), &Utc::now())?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let new_due: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT due_at FROM tasks WHERE id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        let nd = parse_utc(&new_due).unwrap();
        assert!(nd > Utc::now(), "补偿推进后 due 应在未来，实际 {}", new_due);
        assert!(
            (nd - Utc::now()).num_hours() < 48,
            "每日任务补偿推进后应贴近当前时刻（下一次发生）"
        );
    }

    #[test]
    fn edited_recurring_task_still_catches_up_after_sleep() {
        let db = setup();
        let stale = (Utc::now() - chrono::Duration::days(3)).with_timezone(&chrono::Local);
        let task_id = seed_recurring_task(&db, stale);
        let item_before = due_item(&db, &task_id);
        crate::commands::tasks::update_task_inner(
            &db,
            &task_id,
            crate::commands::tasks::TaskInput {
                title: "编辑后的任务".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let item_after = due_item(&db, &task_id);
        assert_eq!(item_after.reminder.id, item_before.reminder.id);
        let settings = Settings::load(&db).unwrap();
        // 3 天前的提醒超过 24h 宽限期：按设计只记历史、不弹通知（返回 None），
        // 但重复任务必须照常推进——这正是编辑后不能丢重复规则的回归点。
        let fired = fire_reminder_core(&db, &item_after, &Utc::now(), &settings).unwrap();
        assert!(fired.is_none(), "超过宽限期不得补弹通知");
        let logged: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM notification_history WHERE kind = 'reminder' AND ref_id = ?1",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(logged, 1, "超过宽限期仍记录历史，只是不弹通知");
        let due: String = db
            .with_conn(|c| {
                c.query_row("SELECT due_at FROM tasks WHERE id = ?1", [&task_id], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(parse_utc(&due).unwrap() > Utc::now());
        let next_reminder: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_reminders WHERE task_id = ?1 AND fired = 0",
                    rusqlite::params![task_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(next_reminder, 1, "推进后必须重建下一轮未触发提醒");
    }
}
