//! 行动中心查询性能采样（手动运行，不进入常规 CI）：
//! `cargo test --release --test actions_perf -- --ignored --nocapture`
//!
//! 预算（docs/V05_DESIGN.md）：扫描 600 条真实事件 + 合并 + 任务映射 +
//! 覆盖度聚合，默认过滤下 `feed` p95 ≤ 60ms。
//! 测试使用真实 SQLite（内存库）与真实 `actions::feed`，不 mock 查询路径。

use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use rusqlite::params;
use serde_json::{json, Value};
use task_dock_lib::actions::{feed, ActionFilter};
use task_dock_lib::db::Db;

const SOURCES: [&str; 6] = ["codex", "qoder", "claude", "trae", "cursor", "workbuddy"];
const SESSIONS_PER_SOURCE: usize = 10;
const EVENTS_PER_SESSION: usize = 10;
const TOTAL_EVENTS: usize = SOURCES.len() * SESSIONS_PER_SOURCE * EVENTS_PER_SESSION;
const BUDGET_P95_MS: f64 = 60.0;

fn results_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/performance/results")
        .canonicalize()
        .unwrap_or_else(|_| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../docs/performance/results")
                .to_path_buf()
        })
}

fn machine_info() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "computer": std::env::var("COMPUTERNAME").unwrap_or_default(),
        "logical_cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "app_version": env!("CARGO_PKG_VERSION"),
    })
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

/// 构造接近真实的负载：6 来源 × 10 会话 × 10 事件。
/// 每条消息不同 → 600 个独立合并组（最坏情况：无法合并压缩）。
/// 20 个会话绑定任务，100 条 run 参与 run_row 反查。
fn seed(db: &Db) {
    let now = Utc::now();
    let mut links = 0usize;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (si, source) in SOURCES.iter().enumerate() {
            tx.execute(
                "INSERT OR REPLACE INTO agent_sources
                   (id, display_name, kind, enabled, verified, transport_verified, hidden,
                    adapter, note, created_at, updated_at, last_event_at)
                 VALUES (?1, ?2, 'transport', 1, 1, 1, 0, ?1, '', ?3, ?3, ?3)",
                params![source, format!("性能来源 {}", si), now.to_rfc3339()],
            )?;
            for session in 0..SESSIONS_PER_SOURCE {
                let session_id = format!("perf-{}-s{}", source, session);
                let run_ext = format!("perf-{}-s{}-r0", source, session);
                tx.execute(
                    "INSERT INTO agent_sessions
                       (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                     VALUES (?1, ?2, ?3, '', 'running', ?4, ?4)",
                    params![session_id, source, session_id, now.to_rfc3339()],
                )?;
                tx.execute(
                    "INSERT INTO agent_runs
                       (id, session_id, source_id, external_run_id, task_title, status,
                        started_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, '', 'running', ?5, ?5)",
                    params![
                        format!("run-{}-{}", source, session),
                        session_id,
                        source,
                        run_ext,
                        now.to_rfc3339()
                    ],
                )?;
                if session % 5 == 0 {
                    let task_id = format!("perf-task-{}", links);
                    tx.execute(
                        "INSERT INTO tasks (id, title, status, created_at, updated_at)
                         VALUES (?1, ?2, 'pending', ?3, ?3)",
                        params![task_id, format!("性能任务 {}", links), now.to_rfc3339()],
                    )?;
                    tx.execute(
                        "INSERT INTO task_agent_links
                           (id, task_id, source_id, session_external_id, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            format!("perf-link-{}", links),
                            task_id,
                            source,
                            session_id,
                            now.to_rfc3339()
                        ],
                    )?;
                    links += 1;
                }
                for e in 0..EVENTS_PER_SESSION {
                    let state = match e % 10 {
                        0 => "waiting",
                        1 => "running",
                        9 => "failed",
                        _ => "running",
                    };
                    let at = now - ChronoDuration::seconds((e * 3 + si) as i64);
                    tx.execute(
                        "INSERT INTO agent_events
                           (id, source_id, session_external_id, run_external_id, event_type,
                            state, message, received_at, occurred_at, dedupe_key)
                         VALUES (?1, ?2, ?3, ?4, 'status', ?5, ?6, ?7, ?7, ?8)",
                        params![
                            format!("perf-{}-s{}-e{}", source, session, e),
                            source,
                            session_id,
                            run_ext,
                            state,
                            format!("性能事件 {} 会话 {} #{}", source, session, e),
                            at.to_rfc3339_opts(SecondsFormat::Millis, true),
                            format!("perf:{}:{}:{}", source, session, e),
                        ],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .expect("写入压测夹具失败");
}

#[test]
#[ignore = "性能采样：需手动运行并记录环境"]
fn actions_feed_perf_sample() {
    let db = Db::open_in_memory().unwrap();
    seed(&db);

    let filter = ActionFilter::default();
    // 预热：迁移/语句缓存/页预热不计入样本
    for _ in 0..5 {
        feed(&db, &filter).unwrap();
    }

    let mut samples = Vec::with_capacity(30);
    let mut scanned = 0usize;
    let mut items = 0usize;
    let mut counts = json!(null);
    for _ in 0..30 {
        let t = Instant::now();
        let out = feed(&db, &filter).unwrap();
        samples.push(ms(t.elapsed()));
        scanned = out.scanned_events;
        items = out.items.len();
        counts = json!({
            "failed": out.counts.failed,
            "authorization": out.counts.authorization,
            "waiting_input": out.counts.waiting_input,
            "running": out.counts.running,
            "completed": out.counts.completed,
            "disconnected": out.counts.disconnected,
            "reminder": out.counts.reminder,
        });
    }

    let mut sorted = samples.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = pct(&sorted, 0.50);
    let p95 = pct(&sorted, 0.95);
    let max = *sorted.last().unwrap();
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let pass = scanned == TOTAL_EVENTS && p95 <= BUDGET_P95_MS;

    let mut report = json!({
        "scenario": "actions-feed-600",
        "machine": machine_info(),
        "fixture": {
            "sources": SOURCES.len(),
            "sessions": SOURCES.len() * SESSIONS_PER_SOURCE,
            "events": TOTAL_EVENTS,
            "task_links": SOURCES.len() * SESSIONS_PER_SOURCE / 5,
            "note": "每条事件消息唯一，600 个合并组，默认过滤 limit=120",
        },
        "query": {
            "scanned_events": scanned,
            "returned_items": items,
            "counts": counts,
            "iterations": samples.len(),
            "p50_ms": (p50 * 100.0).round() / 100.0,
            "p95_ms": (p95 * 100.0).round() / 100.0,
            "max_ms": (max * 100.0).round() / 100.0,
            "mean_ms": (mean * 100.0).round() / 100.0,
        },
        "budget": { "p95_ms_max": BUDGET_P95_MS },
        "pass": pass,
    });
    report["samples_ms"] = json!(samples
        .iter()
        .map(|v| (v * 100.0).round() / 100.0)
        .collect::<Vec<_>>());
    println!(
        "\n[行动中心] 扫描 {} 条 / 返回 {} 条 → p50 {:.2}ms · p95 {:.2}ms · max {:.2}ms（预算 p95 ≤ {:.0}ms）",
        scanned, items, p50, p95, max, BUDGET_P95_MS
    );

    let dir = results_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("Q-actions-{}.json", ts));
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("[报告] {}", path.display());

    assert!(scanned == TOTAL_EVENTS, "夹具未覆盖 600 条事件扫描");
    assert!(
        p95 <= BUDGET_P95_MS,
        "行动中心查询 p95 {:.2}ms 超出预算 {:.0}ms",
        p95,
        BUDGET_P95_MS
    );
}
