use super::*;

fn insert_session(conn: &Connection, id: &str, status: &str, at: &str) -> AppResult<()> {
    insert_session_for_source(conn, "codex", id, status, at)
}

fn insert_session_for_source(
    conn: &Connection,
    source_id: &str,
    id: &str,
    status: &str,
    at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sessions
         (id, source_id, external_id, title, status, first_seen_at, last_seen_at, origin)
         VALUES (?1, ?2, ?1, ?1, ?3, ?4, ?4, 'real')",
        rusqlite::params![id, source_id, status, at],
    )?;
    insert_run_for_source(conn, source_id, id, &format!("run-{id}"), status, at)
}

fn insert_run_for_source(
    conn: &Connection,
    source_id: &str,
    session_id: &str,
    id: &str,
    status: &str,
    at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_runs
         (id, session_id, source_id, task_title, status, started_at, updated_at, pending_items, origin)
         VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?5, '[]', 'real')",
        rusqlite::params![id, session_id, source_id, status, at],
    )?;
    Ok(())
}

fn insert_run(
    conn: &Connection,
    session_id: &str,
    id: &str,
    status: &str,
    at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_runs
         (id, session_id, source_id, task_title, status, started_at, updated_at, pending_items, origin)
         VALUES (?1, ?2, 'codex', ?1, ?3, ?4, ?4, '[]', 'real')",
        rusqlite::params![id, session_id, status, at],
    )?;
    Ok(())
}

fn insert_session_without_run(
    conn: &Connection,
    id: &str,
    status: &str,
    at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sessions
         (id, source_id, external_id, title, status, first_seen_at, last_seen_at, origin)
         VALUES (?1, 'codex', ?1, ?1, ?2, ?3, ?3, 'real')",
        rusqlite::params![id, status, at],
    )?;
    Ok(())
}

fn collect_live_sessions(db: &Db, first_cursor: Option<String>) -> AppResult<Vec<String>> {
    let mut cursor = first_cursor;
    let mut ids = Vec::new();
    loop {
        let page = history::query_sessions(
            db,
            &history::AgentSessionHistoryQuery {
                live_only: Some(true),
                cursor,
                limit: Some(100),
                ..Default::default()
            },
        )?;
        ids.extend(page.items.into_iter().map(|item| item.id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(ids)
}

#[test]
fn snapshot_keeps_old_waiting_when_history_exceeds_window() {
    let db = Db::open_in_memory().unwrap();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        insert_session(&tx, "old-waiting", "waiting", "2026-01-01T00:00:00+00:00")?;
        for i in 0..301 {
            insert_session(
                &tx,
                &format!("history-{i:04}"),
                "completed",
                "2026-02-01T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let snapshot = snapshot_query(&db).unwrap();
    let history =
        history::query_sessions(&db, &history::AgentSessionHistoryQuery::default()).unwrap();
    assert_eq!(history.total, 301);
    assert!(
        snapshot
            .sessions
            .iter()
            .any(|session| session.id == "old-waiting"),
        "仍在等待的会话不得同时被快照窗口与历史实时过滤遗漏"
    );
    assert!(snapshot
        .runs
        .iter()
        .any(|run| run.session_id == "old-waiting"));
    assert_eq!(snapshot.sessions.len(), 1, "完成历史不占实时会话快照容量");
    assert_eq!(snapshot.sessions[0].live_run_count, 1);
    assert_eq!(snapshot.live_summary.session_total, 1);
    assert_eq!(snapshot.live_summary.run_total, 1);
    assert_eq!(snapshot.live_summary.waiting, 1);
    assert_eq!(snapshot.live_summary.by_source["codex"].waiting, 1);
    assert!(!snapshot.live_summary.sessions_truncated);
    assert!(!snapshot.live_summary.runs_truncated);

    let live_page = history::query_sessions(
        &db,
        &history::AgentSessionHistoryQuery {
            live_only: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(live_page.total, 1);
    assert_eq!(live_page.items[0].id, "old-waiting");
    assert_eq!(live_page.items[0].live_state.as_deref(), Some("waiting"));
    assert_eq!(live_page.items[0].live_run_count, 1);
}

#[test]
fn snapshot_limits_are_correct_for_zero_ten_two_hundred_and_two_hundred_one_sessions() {
    let db = Db::open_in_memory().unwrap();
    let empty = snapshot_query(&db).unwrap();
    assert!(empty.sessions.is_empty());
    assert!(empty.runs.is_empty());
    assert_eq!(empty.live_summary.session_total, 0);
    assert_eq!(empty.live_summary.active_session_total, 0);
    assert_eq!(empty.live_summary.run_total, 0);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for i in 0..10 {
            insert_session(
                &tx,
                &format!("live-{i:02}"),
                "running",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    let snapshot = snapshot_query(&db).unwrap();
    assert_eq!(snapshot.sessions.len(), 10);
    assert_eq!(snapshot.runs.len(), 10);
    assert_eq!(snapshot.live_summary.session_total, 10);
    assert_eq!(snapshot.live_summary.active_session_total, 10);
    assert_eq!(snapshot.live_summary.running, 10);
    assert!(!snapshot.live_summary.sessions_truncated);
    assert!(!snapshot.live_summary.runs_truncated);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for i in 10..200 {
            insert_session(
                &tx,
                &format!("live-{i:03}"),
                "running",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    let at_limit = snapshot_query(&db).unwrap();
    assert_eq!(at_limit.sessions.len(), 200);
    assert_eq!(at_limit.live_summary.session_total, 200);
    assert!(!at_limit.live_summary.sessions_truncated);

    db.with_conn(|conn| insert_session(conn, "live-200", "running", "2026-11-06T00:00:00+00:00"))
        .unwrap();
    let over_limit = snapshot_query(&db).unwrap();
    assert_eq!(over_limit.sessions.len(), 200);
    assert_eq!(over_limit.live_summary.session_total, 201);
    assert!(over_limit.live_summary.sessions_truncated);
    assert!(over_limit.live_summary.next_cursor.is_some());
}

#[test]
fn running_and_waiting_sessions_beyond_snapshot_window_remain_keyset_reachable() {
    for status in ["running", "waiting"] {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for i in 0..201 {
                insert_session(
                    &tx,
                    &format!("{status}-{i:03}"),
                    status,
                    "2026-11-06T00:00:00+00:00",
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .unwrap();

        let snapshot = snapshot_query(&db).unwrap();
        assert_eq!(snapshot.sessions.len(), 200);
        assert_eq!(snapshot.live_summary.session_total, 201);
        assert_eq!(snapshot.live_summary.active_session_total, 201);
        assert_eq!(snapshot.live_summary.run_total, 201);
        assert_eq!(
            snapshot.live_summary.by_source["codex"].active_session_total,
            201
        );
        if status == "running" {
            assert_eq!(snapshot.live_summary.by_source["codex"].running, 201);
        } else {
            assert_eq!(snapshot.live_summary.by_source["codex"].waiting, 201);
        }
        assert!(snapshot.live_summary.sessions_truncated);
        assert!(snapshot.live_summary.next_cursor.is_some());
        let tail = collect_live_sessions(&db, snapshot.live_summary.next_cursor.clone()).unwrap();
        assert_eq!(tail.len(), 1);
        assert!(!snapshot.sessions.iter().any(|s| s.id == tail[0]));

        let all = collect_live_sessions(&db, None).unwrap();
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(all.len(), 201);
        assert_eq!(unique.len(), 201);
        assert_eq!(all.iter().filter(|id| id.starts_with(status)).count(), 201);
    }
}

#[test]
fn one_thousand_live_sessions_are_counted_and_reachable_by_bounded_pages() {
    let db = Db::open_in_memory().unwrap();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for i in 0..1_000 {
            insert_session(
                &tx,
                &format!("live-{i:04}"),
                "running",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let snapshot = snapshot_query(&db).unwrap();
    assert_eq!(snapshot.sessions.len(), 200);
    assert_eq!(snapshot.live_summary.session_total, 1_000);
    assert_eq!(snapshot.live_summary.run_total, 1_000);
    assert!(snapshot.live_summary.sessions_truncated);
    let tail = collect_live_sessions(&db, snapshot.live_summary.next_cursor.clone()).unwrap();
    assert_eq!(tail.len(), 800);
    let all = collect_live_sessions(&db, None).unwrap();
    assert_eq!(all.len(), 1_000);
    assert_eq!(
        all.iter().collect::<std::collections::HashSet<_>>().len(),
        1_000
    );
}

#[test]
fn multiple_sources_keep_independent_live_counts_and_share_one_bounded_snapshot() {
    let db = Db::open_in_memory().unwrap();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for source in ["codex", "trae"] {
            for i in 0..210 {
                insert_session_for_source(
                    &tx,
                    source,
                    &format!("{source}-{i:03}"),
                    "waiting",
                    "2026-11-06T00:00:00+00:00",
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let snapshot = snapshot_query(&db).unwrap();
    assert_eq!(snapshot.sessions.len(), 200);
    assert_eq!(snapshot.live_summary.session_total, 420);
    assert_eq!(snapshot.live_summary.waiting, 420);
    assert_eq!(snapshot.live_summary.by_source["codex"].session_total, 210);
    assert_eq!(snapshot.live_summary.by_source["trae"].session_total, 210);
    let tail = collect_live_sessions(&db, snapshot.live_summary.next_cursor.clone()).unwrap();
    let mut all_ids: Vec<_> = snapshot.sessions.iter().map(|s| s.id.clone()).collect();
    all_ids.extend(tail);
    let all: std::collections::HashSet<_> = all_ids.iter().collect();
    assert_eq!(all_ids.len(), 420);
    assert_eq!(all.len(), 420, "跨来源续页不得遗漏或重复会话");
}

#[test]
fn three_hundred_historical_runs_and_ten_live_runs_stay_disjoint() {
    let db = Db::open_in_memory().unwrap();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        insert_session_without_run(&tx, "mixed-session", "running", "2026-11-06T00:00:00+00:00")?;
        for i in 0..300 {
            insert_run(
                &tx,
                "mixed-session",
                &format!("completed-{i:03}"),
                "completed",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        for i in 0..10 {
            insert_run(
                &tx,
                "mixed-session",
                &format!("running-{i:02}"),
                "running",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let snapshot = snapshot_query(&db).unwrap();
    assert_eq!(snapshot.live_summary.run_total, 10);
    assert_eq!(snapshot.runs.len(), 10);
    assert_eq!(snapshot.sessions[0].live_run_count, 10);
    let historical =
        history::query_runs(&db, "mixed-session", None, Some(100), None, None).unwrap();
    assert_eq!(historical.total, 300);
    assert_eq!(historical.items.len(), 100);
    assert!(historical.items.iter().all(|run| run.status == "completed"));
    let live =
        history::query_runs(&db, "mixed-session", None, Some(50), Some(true), Some(true)).unwrap();
    assert_eq!(live.total, 10);
    assert!(live.items.iter().all(|run| run.status == "running"));
    let historical_ids: std::collections::HashSet<_> =
        historical.items.iter().map(|run| run.id.as_str()).collect();
    assert!(live
        .items
        .iter()
        .all(|run| !historical_ids.contains(run.id.as_str())));
}

#[test]
fn snapshot_run_capacity_reports_counts_and_keeps_every_session_represented() {
    for run_count in [0usize, 10, 300, 301] {
        let db = Db::open_in_memory().unwrap();
        if run_count > 0 {
            db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                insert_session_without_run(
                    &tx,
                    "busy-session",
                    "running",
                    "2026-11-06T00:00:00+00:00",
                )?;
                for i in 0..run_count {
                    insert_run(
                        &tx,
                        "busy-session",
                        &format!("run-{i:03}"),
                        "running",
                        &format!("2026-11-06T00:00:{:02}.{:06}+00:00", i % 60, i),
                    )?;
                }
                tx.commit()?;
                Ok(())
            })
            .unwrap();
        }
        let snapshot = snapshot_query(&db).unwrap();
        assert_eq!(snapshot.live_summary.run_total, run_count as i64);
        assert_eq!(snapshot.runs.len(), run_count.min(300));
        assert_eq!(snapshot.live_summary.runs_truncated, run_count > 300);
        assert_eq!(snapshot.sessions.len(), usize::from(run_count > 0));
        assert_eq!(
            snapshot.live_summary.active_session_total,
            i64::from(run_count > 0)
        );
        if run_count > 0 {
            assert_eq!(snapshot.runs[0].session_id, "busy-session");
            assert_eq!(snapshot.sessions[0].live_run_count, run_count as i64);
            assert_eq!(
                snapshot.live_summary.by_source["codex"].run_total,
                run_count as i64
            );
            assert_eq!(
                snapshot.live_summary.by_source["codex"].active_session_total,
                1
            );
            let mut cursor = None;
            let mut seen = std::collections::HashSet::new();
            loop {
                let page = history::query_runs(
                    &db,
                    "busy-session",
                    cursor.as_deref(),
                    Some(100),
                    Some(true),
                    Some(true),
                )
                .unwrap();
                for run in page.items {
                    assert!(seen.insert(run.id), "实时轮次 keyset 不得重复");
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            assert_eq!(
                seen.len(),
                run_count,
                "快照上限外的轮次仍可通过有界分页访问"
            );
        }
    }
}

#[test]
fn realtime_summary_uses_one_hour_window_and_real_origin_only() {
    let db = Db::open_in_memory().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let old = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (id, status, at) in [
            ("running-old", "running", old.as_str()),
            ("waiting-old", "waiting", old.as_str()),
            ("failed-old", "failed", old.as_str()),
            ("disconnected-old", "disconnected", old.as_str()),
            ("failed-recent", "failed", now.as_str()),
            ("disconnected-recent", "disconnected", now.as_str()),
            ("completed", "completed", now.as_str()),
        ] {
            insert_session(&tx, id, status, at)?;
        }
        insert_session(&tx, "selftest-running", "running", &now)?;
        tx.execute(
            "UPDATE agent_runs SET origin = 'selftest' WHERE session_id = 'selftest-running'",
            [],
        )?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let snapshot = snapshot_query(&db).unwrap();
    let ids: std::collections::HashSet<_> =
        snapshot.sessions.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(snapshot.live_summary.session_total, 4);
    assert_eq!(snapshot.live_summary.active_session_total, 2);
    assert_eq!(snapshot.live_summary.run_total, 4);
    assert_eq!(snapshot.live_summary.running, 1);
    assert_eq!(snapshot.live_summary.waiting, 1);
    assert_eq!(snapshot.live_summary.failed, 1);
    assert_eq!(snapshot.live_summary.disconnected, 1);
    assert!(ids.contains("running-old"));
    assert!(ids.contains("waiting-old"));
    assert!(ids.contains("failed-recent"));
    assert!(ids.contains("disconnected-recent"));
    assert!(!ids.contains("failed-old"));
    assert!(!ids.contains("disconnected-old"));
    assert!(!ids.contains("completed"));
    assert!(!ids.contains("selftest-running"));
}

#[test]
fn snapshot_membership_tracks_terminal_and_recent_failure_transitions() {
    let db = Db::open_in_memory().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let old = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
    db.with_conn(|conn| insert_session(conn, "transition", "running", &now))
        .unwrap();

    assert_eq!(snapshot_query(&db).unwrap().live_summary.session_total, 1);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET status = 'completed', ended_at = ?1 WHERE session_id = 'transition'",
            [&now],
        )?;
        conn.execute(
            "UPDATE agent_sessions SET status = 'completed' WHERE id = 'transition'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let completed = snapshot_query(&db).unwrap();
    assert!(completed.sessions.is_empty());
    assert_eq!(completed.live_summary.session_total, 0);
    assert_eq!(
        history::query_sessions(&db, &history::AgentSessionHistoryQuery::default())
            .unwrap()
            .total,
        1
    );

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET status = 'disconnected', updated_at = ?1 WHERE session_id = 'transition'",
            [&now],
        )?;
        conn.execute(
            "UPDATE agent_sessions SET status = 'disconnected' WHERE id = 'transition'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let disconnected = snapshot_query(&db).unwrap();
    assert_eq!(disconnected.sessions[0].live_run_count, 1);
    assert_eq!(disconnected.live_summary.disconnected, 1);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET status = 'running', updated_at = ?1 WHERE session_id = 'transition'",
            [&now],
        )?;
        conn.execute(
            "UPDATE agent_sessions SET status = 'running' WHERE id = 'transition'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let running = snapshot_query(&db).unwrap();
    assert_eq!(running.live_summary.running, 1);
    assert_eq!(running.live_summary.disconnected, 0);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET status = 'failed', updated_at = ?1 WHERE session_id = 'transition'",
            [&old],
        )?;
        conn.execute(
            "UPDATE agent_sessions SET status = 'failed' WHERE id = 'transition'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let old_failure = snapshot_query(&db).unwrap();
    assert!(old_failure.sessions.is_empty());
    assert_eq!(old_failure.live_summary.session_total, 0);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET updated_at = ?1 WHERE session_id = 'transition'",
            [&now],
        )?;
        Ok(())
    })
    .unwrap();
    let recent_failure = snapshot_query(&db).unwrap();
    assert_eq!(recent_failure.live_summary.failed, 1);
    assert_eq!(recent_failure.sessions[0].live_run_count, 1);
}

#[test]
fn snapshot_tracks_direct_running_failed_disconnected_and_reconnect_transitions() {
    let db = Db::open_in_memory().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let old = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
    db.with_conn(|conn| insert_session(conn, "state-change", "running", &now))
        .unwrap();

    let running = snapshot_query(&db).unwrap();
    assert_eq!(running.live_summary.running, 1);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_runs SET status = 'failed', updated_at = ?1 WHERE session_id = 'state-change'",
            [&now],
        )?;
        tx.execute(
            "UPDATE agent_sessions SET status = 'failed', last_seen_at = ?1 WHERE id = 'state-change'",
            [&now],
        )?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    assert_eq!(snapshot_query(&db).unwrap().live_summary.failed, 1);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_runs SET status = 'running', updated_at = ?1 WHERE session_id = 'state-change'",
            [&now],
        )?;
        tx.execute(
            "UPDATE agent_sessions SET status = 'running', last_seen_at = ?1 WHERE id = 'state-change'",
            [&now],
        )?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    assert_eq!(snapshot_query(&db).unwrap().live_summary.running, 1);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_runs SET status = 'disconnected', updated_at = ?1 WHERE session_id = 'state-change'",
            [&now],
        )?;
        tx.execute(
            "UPDATE agent_sessions SET status = 'disconnected', last_seen_at = ?1 WHERE id = 'state-change'",
            [&now],
        )?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    assert_eq!(snapshot_query(&db).unwrap().live_summary.disconnected, 1);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_runs SET status = 'running', updated_at = ?1 WHERE session_id = 'state-change'",
            [&now],
        )?;
        tx.execute(
            "UPDATE agent_sessions SET status = 'running', last_seen_at = ?1 WHERE id = 'state-change'",
            [&now],
        )?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    assert_eq!(snapshot_query(&db).unwrap().live_summary.running, 1);

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_runs SET status = 'failed', updated_at = ?1 WHERE session_id = 'state-change'",
            [&old],
        )?;
        tx.execute(
            "UPDATE agent_sessions SET status = 'failed', last_seen_at = ?1 WHERE id = 'state-change'",
            [&old],
        )?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    let expired = snapshot_query(&db).unwrap();
    assert!(expired.sessions.is_empty());
    assert_eq!(expired.live_summary.session_total, 0);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_runs SET updated_at = ?1 WHERE session_id = 'state-change'",
            [&now],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(snapshot_query(&db).unwrap().live_summary.failed, 1);
}

#[test]
fn snapshot_is_consistent_while_committed_agent_states_change_concurrently() {
    use std::sync::{Arc, Barrier};

    let task_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tmp/acceptance/historical-task-closure-round5");
    std::fs::create_dir_all(&task_dir).unwrap();
    let db_path = task_dir.join(format!(
        "snapshot-consistency-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let db = Arc::new(Db::open(&db_path).unwrap());
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for i in 0..20 {
            insert_session(
                &tx,
                &format!("concurrent-{i:02}"),
                "running",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let start = Arc::new(Barrier::new(2));
    let writer_db = db.clone();
    let writer_start = start.clone();
    let writer = std::thread::spawn(move || {
        writer_start.wait();
        for i in 0..80 {
            let status = if i % 2 == 0 { "waiting" } else { "running" };
            let now = chrono::Utc::now().to_rfc3339();
            writer_db
                .with_conn(|conn| {
                    let tx = conn.unchecked_transaction()?;
                    tx.execute(
                        "UPDATE agent_runs SET status = ?1, updated_at = ?2 WHERE session_id LIKE 'concurrent-%'",
                        rusqlite::params![status, now],
                    )?;
                    tx.execute(
                        "UPDATE agent_sessions SET status = ?1, last_seen_at = ?2 WHERE id LIKE 'concurrent-%'",
                        rusqlite::params![status, now],
                    )?;
                    tx.commit()?;
                    Ok(())
                })
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    });

    start.wait();
    let mut snapshots = 0;
    while !writer.is_finished() || snapshots < 10 {
        let snapshot = snapshot_query(&db).unwrap();
        assert_eq!(snapshot.live_summary.session_total, 20);
        assert_eq!(snapshot.live_summary.run_total, 20);
        assert_eq!(snapshot.sessions.len(), 20);
        assert_eq!(snapshot.runs.len(), 20);
        let running = snapshot
            .runs
            .iter()
            .filter(|run| run.status == "running")
            .count() as i64;
        let waiting = snapshot
            .runs
            .iter()
            .filter(|run| run.status == "waiting")
            .count() as i64;
        assert_eq!(snapshot.live_summary.running, running);
        assert_eq!(snapshot.live_summary.waiting, waiting);
        assert!(
            running == 20 || waiting == 20,
            "一次快照不得混合两个已提交状态"
        );
        for session in &snapshot.sessions {
            let run = snapshot
                .runs
                .iter()
                .find(|run| run.session_id == session.id)
                .unwrap();
            assert_eq!(session.status, run.status, "会话与轮次必须来自同一读快照");
        }
        snapshots += 1;
    }
    writer.join().unwrap();
    assert!(snapshots >= 10);

    drop(db);
    for suffix in ["", "-wal", "-shm"] {
        let mut path = db_path.as_os_str().to_os_string();
        path.push(suffix);
        let _ = std::fs::remove_file(std::path::PathBuf::from(path));
    }
}

#[test]
fn ten_thousand_completed_sessions_do_not_consume_live_snapshot_capacity() {
    let db = Db::open_in_memory().unwrap();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for i in 0..10_000 {
            insert_session(
                &tx,
                &format!("completed-{i:05}"),
                "completed",
                "2026-11-06T00:00:00+00:00",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    let snapshot = snapshot_query(&db).unwrap();
    assert!(snapshot.sessions.is_empty());
    assert!(snapshot.runs.is_empty());
    assert_eq!(snapshot.live_summary.session_total, 0);
    assert_eq!(snapshot.live_summary.active_session_total, 0);
    assert_eq!(snapshot.live_summary.run_total, 0);
    assert!(!snapshot.live_summary.sessions_truncated);
}

#[test]
fn stale_cleanup_payload_single_source_matches_batch_contract() {
    let notified = vec![("run-1".to_string(), "codex".to_string())];
    let payload = stale_cleanup_payload(&notified, "sess-1");
    assert_eq!(payload["source_id"], "codex");
    assert_eq!(payload["sources"], serde_json::json!(["codex"]));
    assert_eq!(payload["session_id"], "sess-1");
    assert_eq!(payload["run_id"], "run-1");
    assert_eq!(payload["state"], "disconnected");
    assert_eq!(payload["states"], serde_json::json!({ "disconnected": 1 }));
    assert_eq!(payload["batch"], 1);
    assert_eq!(payload["changed"], true);
    assert_eq!(payload["deduplicated"], false);
    assert_eq!(payload["late"], false);
    assert_eq!(payload["stale_cleanup"], 1);
    assert!(payload["sources"].is_array(), "前端 sources 必须为数组");
}

#[test]
fn stale_cleanup_payload_multi_source_deduplicates_sources() {
    let notified = vec![
        ("run-1".to_string(), "codex".to_string()),
        ("run-2".to_string(), "trae".to_string()),
        ("run-3".to_string(), "codex".to_string()),
    ];
    let payload = stale_cleanup_payload(&notified, "");
    assert_eq!(payload["source_id"], "codex", "source_id 取最后一条");
    assert_eq!(payload["sources"], serde_json::json!(["codex", "trae"]));
    assert_eq!(payload["session_id"], "");
    assert_eq!(payload["run_id"], "run-3");
    assert_eq!(payload["states"], serde_json::json!({ "disconnected": 3 }));
    assert_eq!(payload["batch"], 3);
    assert_eq!(payload["changed"], true);
    assert_eq!(payload["stale_cleanup"], 3);
}

#[test]
fn stale_cleanup_payload_empty_does_not_fabricate_sources() {
    let payload = stale_cleanup_payload(&[], "");
    assert_eq!(payload["source_id"], "");
    assert_eq!(payload["sources"], serde_json::json!([]));
    assert_eq!(payload["states"], serde_json::json!({ "disconnected": 0 }));
    assert_eq!(payload["batch"], 0);
    assert_eq!(payload["stale_cleanup"], 0);
}

#[test]
fn snapshot_perf_measurement_10k_history_1k_live() {
    // 性能量测 harness：正确性断言 + 打印耗时分位与执行计划（不设时间阈值，避免负载抖动误报）。
    // 数据：10k 完成历史 + 1000 实时（codex/trae 500/500），覆盖 COUNT、聚合、首屏与深页。
    let db = Db::open_in_memory().unwrap();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for i in 0..10_000 {
            insert_session(&tx, &format!("hist-{i:05}"), "completed", "2026-11-06T00:00:00+00:00")?;
        }
        for i in 0..500 {
            insert_session_for_source(&tx, "codex", &format!("live-codex-{i:03}"), "running", "2026-11-06T00:00:00+00:00")?;
        }
        for i in 0..500 {
            insert_session_for_source(&tx, "trae", &format!("live-trae-{i:03}"), "waiting", "2026-11-06T00:00:00+00:00")?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    // EXPLAIN QUERY PLAN：会话窗口与历史 COUNT 的索引使用
    db.with_conn(|conn| {
        for (label, sql) in [
            ("live_session_window", "EXPLAIN QUERY PLAN SELECT s.id FROM agent_sessions s WHERE s.origin = 'real' AND s.source_id IN (SELECT id FROM agent_sources WHERE hidden = 0) ORDER BY s.last_seen_at DESC, s.id DESC LIMIT 200"),
            ("history_count", "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM agent_sessions s WHERE s.origin = 'real' AND s.source_id IN (SELECT id FROM agent_sources WHERE hidden = 0)"),
            ("live_runs_by_source", "EXPLAIN QUERY PLAN SELECT s.source_id, COUNT(*) FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id WHERE r.origin = 'real' GROUP BY s.source_id"),
        ] {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)))?;
            for row in rows {
                let (id, parent, _unused, detail) = row?;
                let _ = (id, parent, _unused);
                eprintln!("[PERF-PLAN] {label}: {detail}");
            }
        }
        Ok::<_, AppError>(())
    })
    .unwrap();

    fn measure_ms<F: FnMut() -> AppResult<T>, T>(label: &str, iters: usize, mut f: F) {
        let mut samples: Vec<f64> = Vec::with_capacity(iters);
        for _ in 0..iters {
            let t0 = std::time::Instant::now();
            let _ = f().unwrap();
            samples.push(t0.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let p50 = samples[iters / 2];
        let p95 = samples[(iters as f64 * 0.95) as usize - 1];
        let max = *samples.last().unwrap();
        eprintln!("[PERF] {label}: n={iters} p50={p50:.2}ms p95={p95:.2}ms max={max:.2}ms");
    }

    measure_ms("snapshot_query_10k_hist_1k_live", 20, || snapshot_query(&db));
    measure_ms("history_sessions_first_page", 20, || history::query_sessions(&db, &history::AgentSessionHistoryQuery { limit: Some(10), ..Default::default() }));
    measure_ms("history_sessions_live_only_first", 20, || history::query_sessions(&db, &history::AgentSessionHistoryQuery { live_only: Some(true), limit: Some(100), ..Default::default() }));
    measure_ms("history_groups_codex", 10, || history::query_groups(&db, &history::AgentHistoryGroupQuery { source_id: Some("codex".to_string()), ..Default::default() }));

    let snapshot = snapshot_query(&db).unwrap();
    assert_eq!(snapshot.live_summary.session_total, 1000);
    assert_eq!(snapshot.sessions.len(), 200);
    assert!(snapshot.live_summary.sessions_truncated);
    let hist = history::query_sessions(&db, &history::AgentSessionHistoryQuery::default()).unwrap();
    assert_eq!(hist.total, 10_000);
    let live = history::query_sessions(&db, &history::AgentSessionHistoryQuery { live_only: Some(true), ..Default::default() }).unwrap();
    assert_eq!(live.total, 1000);
}
