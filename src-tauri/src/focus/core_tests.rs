// Rust 单元测试：状态机、时间核算、跨午夜、时间跳变、重启恢复与删除任务后的历史。

use super::*;
use chrono::{Duration as CD, Local, TimeZone};

fn test_db() -> Db {
    let db = Db::open_in_memory().expect("内存数据库");
    store::create_test_schema(&db).expect("创建 focus 测试表");
    db
}

fn seed_task(db: &Db, id: &str, title: &str) {
    let now = ts(Utc::now());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![id, title, now],
        )?;
        Ok(())
    })
    .expect("插入任务");
}

fn boot(db: &Db, now: DateTime<Utc>, mono: Instant) -> FocusCore {
    let mut core = FocusCore::new();
    core.ensure_loaded(db, now, mono).expect("加载专注状态");
    core
}

fn local_midnight() -> DateTime<Utc> {
    let date = Local::now().date_naive();
    let naive = date.and_hms_opt(0, 0, 0).expect("本地午夜");
    Local
        .from_local_datetime(&naive)
        .single()
        .expect("本地时区无歧义")
        .with_timezone(&Utc)
}

fn active_rows(db: &Db) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM focus_sessions WHERE active = 1",
            [],
            |r| r.get(0),
        )?)
    })
    .expect("统计活跃会话")
}

fn recent_state(db: &Db) -> (String, i64) {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            // 同一秒内可能完成/新建多个会话，时间戳精度只到秒，需用插入顺序兜底。
            "SELECT state, accumulated_ms FROM focus_sessions \
                 ORDER BY updated_at DESC, started_at DESC, rowid DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )?)
    })
    .expect("读取最近会话")
}

#[test]
fn duplicate_start_keeps_single_session() {
    let db = test_db();
    seed_task(&db, "task-1", "写周报");
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);

    assert!(core
        .start_focus(&db, Some("task-1".to_string()), w, m)
        .unwrap());
    assert!(!core
        .start_focus(&db, Some("task-1".to_string()), w, m)
        .unwrap());
    assert!(!core.start_focus(&db, None, w, m).unwrap());
    assert_eq!(active_rows(&db), 1);
    assert_eq!(core.active.as_ref().unwrap().rec.task_title, "写周报");
}

#[test]
fn start_focus_rejects_missing_task() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    let err = core
        .start_focus(&db, Some("missing".to_string()), w, m)
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    assert_eq!(active_rows(&db), 0);
}

#[test]
fn pause_and_resume_exclude_paused_time() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();

    core.tick(&db, w + CD::seconds(5), m + Duration::from_secs(5))
        .unwrap();
    core.pause(&db, w + CD::seconds(10), m + Duration::from_secs(10))
        .unwrap();
    // 暂停期间推进 60 秒，不应计入有效时长。
    core.tick(&db, w + CD::seconds(70), m + Duration::from_secs(70))
        .unwrap();
    assert_eq!(core.active.as_ref().unwrap().rec.accumulated_ms, 10_000);
    assert_eq!(
        core.active.as_ref().unwrap().rec.state,
        SessionState::Paused
    );

    core.resume(&db, w + CD::seconds(70), m + Duration::from_secs(70))
        .unwrap();
    core.tick(&db, w + CD::seconds(75), m + Duration::from_secs(75))
        .unwrap();
    assert_eq!(core.active.as_ref().unwrap().rec.accumulated_ms, 15_000);

    assert!(core
        .finish(&db, w + CD::seconds(75), m + Duration::from_secs(75))
        .unwrap());
    let (state, accum) = recent_state(&db);
    assert_eq!(state, "completed");
    assert_eq!(accum, 15_000);
}

#[test]
fn natural_completion_marks_round_and_notifies() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.prefs.focus_minutes = 1; // 测试用 60 秒
    core.start_focus(&db, None, w, m).unwrap();

    let mut last_effects = TickEffects::default();
    for i in 1..=60u64 {
        last_effects = core
            .tick(&db, w + CD::seconds(i as i64), m + Duration::from_secs(i))
            .unwrap();
    }
    assert!(last_effects.completed.is_some());
    assert!(core.active.is_none());
    assert_eq!(core.rounds_since_long, 1);

    let (state, accum) = recent_state(&db);
    assert_eq!(state, "completed");
    assert_eq!(accum, 60_000);
    let today = store::read_today(&db, &local_day(w)).unwrap();
    assert_eq!(today.completed_focus, 1);
    assert!(today.focus_ms >= 60_000);

    let notified: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM notification_history WHERE kind = 'focus'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(notified, 1);
}

#[test]
fn manual_finish_records_time_but_not_round() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();
    // 9s < UNCONFIRMED_GAP(10s)：正常计入有效时长。
    // （恰好 10s 属「无法确认的挂起区间」，由 tick_gap_at_threshold_pauses_without_crediting 覆盖）
    core.tick(&db, w + CD::seconds(9), m + Duration::from_secs(9))
        .unwrap();
    assert!(core
        .finish(&db, w + CD::seconds(9), m + Duration::from_secs(9))
        .unwrap());
    assert_eq!(core.rounds_since_long, 0);
    let (state, accum) = recent_state(&db);
    assert_eq!(state, "completed");
    assert_eq!(accum, 9_000);
    let today = store::read_today(&db, &local_day(w)).unwrap();
    assert_eq!(today.completed_focus, 0);
    assert_eq!(today.focus_ms, 9_000);
}

#[test]
fn cancel_records_valid_time_without_round() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();
    core.tick(&db, w + CD::seconds(8), m + Duration::from_secs(8))
        .unwrap();
    assert!(core
        .cancel(&db, w + CD::seconds(8), m + Duration::from_secs(8))
        .unwrap());
    let (state, accum) = recent_state(&db);
    assert_eq!(state, "cancelled");
    assert_eq!(accum, 8_000);
    assert_eq!(core.rounds_since_long, 0);
    assert!(core.active.is_none());
}

#[test]
fn cross_midnight_splits_daily_stats() {
    let db = test_db();
    let midnight = local_midnight();
    let w = midnight - CD::seconds(30);
    let m = Instant::now();
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();

    for i in 1..=40i64 {
        core.tick(&db, w + CD::seconds(i), m + Duration::from_secs(i as u64))
            .unwrap();
    }

    let before = local_day(w);
    let after = local_day(midnight + CD::seconds(1));
    assert_ne!(before, after);
    // 第 30 次 tick 正好落在本地午夜，按「归属当前 tick 的本地日期」计入新的一天。
    let before_stats = store::read_today(&db, &before).unwrap();
    assert_eq!(before_stats.focus_ms, 29_000);
    let snapshot = core
        .snapshot(&db, w + CD::seconds(40), m + Duration::from_secs(40))
        .unwrap();
    assert_eq!(snapshot.today.focus_ms, 11_000);
}

#[test]
fn sleep_gap_pauses_without_crediting() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();
    core.tick(&db, w + CD::seconds(2), m + Duration::from_secs(2))
        .unwrap();

    let effects = core
        .tick(&db, w + CD::hours(3), m + Duration::from_secs(3 * 3600))
        .unwrap();
    assert!(effects.paused_due_to_gap);
    let active = core.active.as_ref().unwrap();
    assert_eq!(active.rec.state, SessionState::Paused);
    assert_eq!(active.rec.pause_reason.as_deref(), Some("unconfirmed_gap"));
    assert_eq!(active.rec.accumulated_ms, 2_000);

    let (_, persisted) = recent_state(&db);
    assert_eq!(persisted, 2_000);
}

#[test]
fn wall_clock_backwards_does_not_break_countdown() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();

    core.tick(&db, w - CD::hours(2), m + Duration::from_secs(2))
        .unwrap();
    let active = core.active.as_ref().unwrap();
    assert_eq!(active.rec.accumulated_ms, 2_000);
    assert!(active.clock_jumps >= 1);
    assert_eq!(active.rec.state, SessionState::Focusing);
    let snapshot = core
        .snapshot(&db, w - CD::hours(2), m + Duration::from_secs(2))
        .unwrap();
    let view = snapshot.active.unwrap();
    assert_eq!(view.remaining_ms, 25 * 60 * 1000 - 2_000);
}

#[test]
fn restart_recovery_pauses_without_crediting_gap() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    {
        let mut core = boot(&db, w, m);
        core.start_focus(&db, None, w, m).unwrap();
        // 逐秒推进到 30 秒，累计 30 秒会触发恢复点落库。
        for i in 1..=30u64 {
            core.tick(&db, w + CD::seconds(i as i64), m + Duration::from_secs(i))
                .unwrap();
        }
        assert_eq!(active_rows(&db), 1);
    }

    let restart_wall = w + CD::minutes(10);
    let restart_mono = m + Duration::from_secs(600);
    let recovered = boot(&db, restart_wall, restart_mono);
    let active = recovered.active.as_ref().unwrap();
    assert_eq!(active.rec.state, SessionState::Paused);
    assert_eq!(active.rec.pause_reason.as_deref(), Some("app_restart"));
    assert_eq!(active.rec.accumulated_ms, 30_000);
    assert!(active.rec.running_since.is_none());
}

#[test]
fn deleted_task_history_keeps_snapshot() {
    let db = test_db();
    seed_task(&db, "task-2", "整理需求");
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, Some("task-2".to_string()), w, m)
        .unwrap();
    core.tick(&db, w + CD::seconds(5), m + Duration::from_secs(5))
        .unwrap();
    core.finish(&db, w + CD::seconds(5), m + Duration::from_secs(5))
        .unwrap();

    db.with_conn(|conn| {
        conn.execute("DELETE FROM tasks WHERE id = 'task-2'", [])?;
        Ok(())
    })
    .unwrap();

    let history = core.history(&db, 10).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].task_title, "整理需求");
    assert!(history[0].task_deleted);
    assert_eq!(history[0].state, SessionState::Completed);
    assert!(!history[0].state.is_active());
}

#[test]
fn pomodoro_rounds_choose_long_break_and_support_extension() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.prefs.focus_minutes = 1;
    core.prefs.long_break_every = 2;
    core.prefs.short_break_minutes = 5;
    core.prefs.long_break_minutes = 15;

    let mut clock = 0i64;
    let run_focus = |core: &mut FocusCore, clock: &mut i64| {
        core.start_focus(
            &db,
            None,
            w + CD::seconds(*clock),
            m + Duration::from_secs(*clock as u64),
        )
        .unwrap();
        for _ in 0..60 {
            *clock += 1;
            core.tick(
                &db,
                w + CD::seconds(*clock),
                m + Duration::from_secs(*clock as u64),
            )
            .unwrap();
        }
    };

    run_focus(&mut core, &mut clock);
    assert_eq!(core.rounds_since_long, 1);
    assert!(core.start_break(&db, w + CD::seconds(clock), m).unwrap());
    assert_eq!(
        core.active.as_ref().unwrap().rec.kind,
        SessionKind::ShortBreak
    );
    core.finish(&db, w + CD::seconds(clock), m).unwrap();

    run_focus(&mut core, &mut clock);
    assert_eq!(core.rounds_since_long, 2);
    assert!(core.start_break(&db, w + CD::seconds(clock), m).unwrap());
    let active = core.active.as_ref().unwrap();
    assert_eq!(active.rec.kind, SessionKind::LongBreak);
    assert_eq!(active.rec.planned_seconds, 15 * 60);
    assert_eq!(core.rounds_since_long, 0);

    core.extend_break(&db, 5, w + CD::seconds(clock)).unwrap();
    let active = core.active.as_ref().unwrap();
    assert_eq!(active.rec.planned_seconds, 20 * 60);
    assert_eq!(active.rec.extension_seconds, 5 * 60);

    assert!(core
        .skip_break(
            &db,
            w + CD::seconds(clock),
            m + Duration::from_secs(clock as u64)
        )
        .unwrap());
    assert!(core.active.is_none());
    let (state, _) = recent_state(&db);
    assert_eq!(state, "cancelled");
}

#[test]
fn sedentary_reminder_fires_and_snooze_delays() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.update_prefs(
        &db,
        FocusPrefsPatch {
            sedentary_enabled: Some(true),
            sedentary_interval_minutes: Some(15),
            ..Default::default()
        },
        w,
    )
    .unwrap();

    let effects = core
        .tick(&db, w + CD::minutes(16), m + Duration::from_secs(16 * 60))
        .unwrap();
    assert!(effects.sedentary_due);
    let next = core.sedentary_next.unwrap();
    assert!(next > w + CD::minutes(16));

    assert!(core.snooze_sedentary(&db, 30, w + CD::minutes(17)).unwrap());
    assert_eq!(
        core.sedentary_next.unwrap(),
        w + CD::minutes(47),
        "延后 30 分钟应从当前时刻重新计时"
    );
}

#[test]
fn changing_sedentary_interval_reschedules_next_reminder() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.update_prefs(
        &db,
        FocusPrefsPatch {
            sedentary_enabled: Some(true),
            sedentary_interval_minutes: Some(60),
            ..Default::default()
        },
        w,
    )
    .unwrap();
    assert_eq!(core.sedentary_next.unwrap(), w + CD::minutes(60));

    // 间隔变化：从保存时刻按新间隔重排，而不是继续等旧的 60 分钟计划。
    core.update_prefs(
        &db,
        FocusPrefsPatch {
            sedentary_interval_minutes: Some(90),
            ..Default::default()
        },
        w + CD::minutes(10),
    )
    .unwrap();
    assert_eq!(core.sedentary_next.unwrap(), w + CD::minutes(100));

    // 间隔未变的保存不得推迟既有计划（保留「延后」的结果）。
    core.update_prefs(
        &db,
        FocusPrefsPatch {
            sedentary_enabled: Some(true),
            ..Default::default()
        },
        w + CD::minutes(20),
    )
    .unwrap();
    assert_eq!(core.sedentary_next.unwrap(), w + CD::minutes(100));
}

#[test]
fn tick_gap_at_threshold_pauses_without_crediting() {
    let db = test_db();
    let (w, m) = (Utc::now(), Instant::now());
    let mut core = boot(&db, w, m);
    core.start_focus(&db, None, w, m).unwrap();
    core.tick(&db, w + CD::seconds(2), m + Duration::from_secs(2))
        .unwrap();

    // 恰好 10 秒（UNCONFIRMED_GAP）按「≥ 阈值」处理：暂停且不补记这段区间。
    let effects = core
        .tick(&db, w + CD::seconds(12), m + Duration::from_secs(12))
        .unwrap();
    assert!(effects.paused_due_to_gap);
    let active = core.active.as_ref().unwrap();
    assert_eq!(active.rec.state, SessionState::Paused);
    assert_eq!(active.rec.accumulated_ms, 2_000);
}
