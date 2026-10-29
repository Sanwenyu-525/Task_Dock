//! A–E 性能压测：真实 `IngestPipeline` + 真实 SQLite 状态机（`ingest_core`）。
//!
//! 本测试不启动 WebView2 / Tauri 窗口，因此只覆盖后端接入与写库路径；
//! 前端刷新指标由 `src/lib` 的 `getAgentRefreshMetrics()` 在真机运行应用时读取。
//! 所有场景默认 `#[ignore]`，需手动运行并把结果与机器配置一起记录：
//!
//! ```text
//! cargo test --release --test ingest_perf -- --ignored --nocapture
//! cargo test --release --test ingest_perf scenario_b -- --ignored --nocapture
//! TD_PERF_A_SECS=600 TD_PERF_OUT=../docs/performance/results \
//!   cargo test --release --test ingest_perf scenario_a -- --ignored --nocapture
//! ```
//!
//! 结果同时打印到 stdout 并写入 `docs/performance/results/<scenario>-<时间戳>.json`。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use task_dock_lib::agents::pipeline::{IngestPipeline, IngestSink, PipelineConfig, PipelineStats};
use task_dock_lib::agents::{ingest_core, now_iso, AgentEvent, IngestOutcome, Transport};
use task_dock_lib::db::Db;
use task_dock_lib::error::{AppError, AppResult};

const SOURCE: &str = "codex";
/// 每个轮次内的事件数（决定关键事件比例：每轮 1 waiting + 1 completed）。
const RUN_LEN: usize = 20;

// ── 测试用 SQLite sink（与 AgentHub::commit_events 相同的单事务批处理）──

struct DbSink {
    db: Arc<Db>,
    /// 模拟慢写（用于过载场景）
    delay: Duration,
    /// 模拟指定会话的写库失败（用于故障隔离场景）
    fail_session: Option<String>,
}

impl DbSink {
    fn new(db: Arc<Db>) -> Self {
        Self {
            db,
            delay: Duration::ZERO,
            fail_session: None,
        }
    }
}

impl IngestSink for DbSink {
    fn commit_events(&self, items: &[(AgentEvent, Transport)]) -> AppResult<Vec<IngestOutcome>> {
        if let Some(bad) = &self.fail_session {
            if items.iter().any(|(e, _)| &e.session_id == bad) {
                return Err(AppError::Unavailable("injected sink failure".into()));
            }
        }
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        let now = now_iso();
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut outs = Vec::with_capacity(items.len());
            for (ev, transport) in items {
                outs.push(ingest_core(&tx, ev, &now, *transport)?);
            }
            tx.commit()?;
            Ok(outs)
        })
    }

    fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
}

// ── 基础设施 ──

fn temp_db(tag: &str) -> (Arc<Db>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("taskdock-perf-{}-{}", tag, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let db = Db::open(&dir.join("perf.db")).expect("打开压测数据库失败");
    (Arc::new(db), dir)
}

fn open_pipeline(sink: Arc<dyn IngestSink>, config: PipelineConfig) -> Arc<IngestPipeline> {
    let pipeline = IngestPipeline::new(sink, config);
    pipeline.start();
    pipeline
}

/// 进程级唯一 tokio runtime：`tauri::async_runtime::set` 只允许调用一次。
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<&'static tokio::runtime::Runtime> =
        std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        let rt = Box::leak(Box::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .enable_all()
                .build()
                .expect("创建 tokio runtime 失败"),
        ));
        tauri::async_runtime::set(rt.handle().clone());
        rt
    })
}

/// 场景串行执行：并发压测会互相干扰，且多个慢写场景的延迟数据不可比。
fn scenario_guard() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GUARD.lock().unwrap_or_else(|e| e.into_inner())
}

fn mk_event(agent: usize, index: usize, state: &str, run: &str) -> AgentEvent {
    AgentEvent {
        schema_version: Some(1),
        event_id: Some(format!("perf-a{}-e{}", agent, index)),
        source_id: SOURCE.into(),
        instance_id: Some(format!("perf-instance-{}", agent)),
        session_id: format!("perf-session-{}", agent),
        run_id: Some(run.into()),
        task_title: Some(format!("压测轮次 {}", run)),
        state: state.into(),
        message: Some(format!("perf event {} #{}", agent, index)),
        occurred_at: None,
        transport: Some("http".into()),
        evidence_type: Some("observed".into()),
        confidence: Some(1.0),
        ..Default::default()
    }
}

fn run_of(agent: usize, index: usize) -> String {
    format!("perf-run-{}-{}", agent, index / RUN_LEN)
}

fn state_of(index: usize) -> &'static str {
    if index % RUN_LEN == RUN_LEN - 1 {
        "completed"
    } else if index % RUN_LEN == RUN_LEN / 2 {
        "waiting"
    } else {
        "running"
    }
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn results_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TD_PERF_OUT") {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/performance/results")
        .canonicalize()
        .unwrap_or_else(|_| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../docs/performance/results")
                .to_path_buf()
        })
}

fn write_report(scenario: &str, report: &Value) -> PathBuf {
    let dir = results_dir();
    std::fs::create_dir_all(&dir).expect("创建结果目录失败");
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("{}-{}.json", scenario, ts));
    std::fs::write(
        &path,
        serde_json::to_string_pretty(report).expect("序列化报告失败"),
    )
    .expect("写入报告失败");
    println!("\n[报告] {}", path.display());
    path
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

fn cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0)
}

fn sample_rss_bytes() -> Option<u64> {
    if !cfg!(windows) {
        return None;
    }
    let pid = std::process::id();
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {}).WorkingSet64", pid),
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// 数据库规模与状态分布。
fn db_snapshot(db: &Db) -> Value {
    db.with_read(|conn| {
        let total: u64 = conn.query_row("SELECT COUNT(*) FROM agent_events", [], |r| {
            r.get::<_, i64>(0).map(|v| v.max(0) as u64)
        })?;
        let mut by_state = HashMap::new();
        let mut stmt = conn.prepare("SELECT state, COUNT(*) FROM agent_events GROUP BY state")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (state, n) = row?;
            by_state.insert(state, n.max(0) as u64);
        }
        Ok(json!({
            "events": total,
            "by_state": by_state,
        }))
    })
    .unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

fn db_event_ids(db: &Db) -> HashSet<String> {
    db.with_read(|conn| {
        let mut stmt =
            conn.prepare("SELECT event_id FROM agent_events WHERE event_id IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    })
    .unwrap_or_default()
}

fn run_status(db: &Db, run: &str) -> Option<String> {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT status FROM agent_runs WHERE external_run_id = ?1",
            rusqlite::params![run],
            |r| r.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.into()),
        })
    })
    .ok()
    .flatten()
}

// ── 负载驱动 ──

#[derive(Default)]
struct DriveCounters {
    submitted: AtomicU64,
    running_accepted: AtomicU64,
    merged: AtomicU64,
    sampled: AtomicU64,
    submit_errors: AtomicU64,
    critical_sent: AtomicU64,
    critical_ok: AtomicU64,
    critical_failed: AtomicU64,
    critical_retries: AtomicU64,
}

struct DriveResult {
    submitted: u64,
    running_accepted: u64,
    merged: u64,
    sampled: u64,
    submit_errors: u64,
    critical_sent: u64,
    critical_ok: u64,
    critical_failed: u64,
    critical_retries: u64,
    critical_ids: Vec<String>,
    max_queue_depth: usize,
    max_batch_size: usize,
    stats: PipelineStats,
    elapsed_ms: u128,
}

async fn submit_critical(
    pipeline: Arc<IngestPipeline>,
    event: AgentEvent,
    id: String,
    counters: Arc<DriveCounters>,
) {
    let started = Instant::now();
    let mut attempt = 0u64;
    loop {
        match pipeline
            .submit(vec![event.clone()], Transport::Http, "perf", true)
            .await
        {
            Ok(_) => {
                counters.critical_ok.fetch_add(1, Ordering::Relaxed);
                return;
            }
            Err(AppError::Overloaded(_)) | Err(AppError::Unavailable(_)) => {
                attempt += 1;
                counters.critical_retries.fetch_add(1, Ordering::Relaxed);
                if attempt >= 60 || started.elapsed() > Duration::from_secs(90) {
                    counters.critical_failed.fetch_add(1, Ordering::Relaxed);
                    eprintln!("关键事件重试耗尽: {}", id);
                    return;
                }
                let backoff = 50u64.saturating_mul(1 << attempt.min(5) as u32);
                tokio::time::sleep(Duration::from_millis(backoff.min(2000))).await;
            }
            Err(e) => {
                counters.critical_failed.fetch_add(1, Ordering::Relaxed);
                eprintln!("关键事件提交失败 {}: {}", id, e);
                counters.critical_retries.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// 按 Agent 并发发送；每个 Agent 独立节拍，关键状态异步等待确认并有限重试。
async fn drive(
    pipeline: Arc<IngestPipeline>,
    agents: usize,
    rate_per_agent: u64,
    duration: Duration,
) -> DriveResult {
    let counters = Arc::new(DriveCounters::default());
    let ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let max_depth = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();

    let mon_pipeline = pipeline.clone();
    let mon_stop = stop.clone();
    let mon_depth = max_depth.clone();
    let monitor = tokio::spawn(async move {
        while !mon_stop.load(Ordering::Relaxed) {
            let d = mon_pipeline.stats().queue_depth_events;
            mon_depth.fetch_max(d, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    let mut agent_tasks = Vec::new();
    for agent in 0..agents {
        let pipeline = pipeline.clone();
        let counters = counters.clone();
        let ids = ids.clone();
        agent_tasks.push(tokio::spawn(async move {
            let period = Duration::from_secs_f64(1.0 / rate_per_agent.max(1) as f64);
            let mut ticker = tokio::time::interval(period);
            // Delay 会跳过迟到节拍（Windows 定时器粒度 ~15.6ms 下 20ms 周期实测只有 ~32/s/Agent，
            // 注入速率达不到名义值）；Burst 立即补发欠下的节拍，保证长期平均速率。
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
            let end = tokio::time::Instant::now() + duration;
            let mut critical_tasks = Vec::new();
            let mut index = 0usize;
            loop {
                ticker.tick().await;
                if tokio::time::Instant::now() >= end {
                    break;
                }
                let state = state_of(index);
                let run = run_of(agent, index);
                let event = mk_event(agent, index, state, &run);
                let event_id = event.event_id.clone().unwrap_or_default();
                if state == "running" {
                    counters.submitted.fetch_add(1, Ordering::Relaxed);
                    match pipeline
                        .submit(vec![event], Transport::Http, "perf", false)
                        .await
                    {
                        Ok(r) => {
                            counters.running_accepted.fetch_add(1, Ordering::Relaxed);
                            counters
                                .merged
                                .fetch_add(r.merged as u64, Ordering::Relaxed);
                            counters
                                .sampled
                                .fetch_add(r.sampled as u64, Ordering::Relaxed);
                        }
                        Err(_) => {
                            counters.submit_errors.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                } else {
                    counters.submitted.fetch_add(1, Ordering::Relaxed);
                    counters.critical_sent.fetch_add(1, Ordering::Relaxed);
                    ids.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(event_id.clone());
                    let p = pipeline.clone();
                    let c = counters.clone();
                    critical_tasks.push(tokio::spawn(async move {
                        submit_critical(p, event, event_id, c).await;
                    }));
                }
                index += 1;
            }
            for t in critical_tasks {
                let _ = t.await;
            }
        }));
    }

    for t in agent_tasks {
        let _ = t.await;
    }
    stop.store(true, Ordering::Relaxed);
    let _ = monitor.await;
    let _ = pipeline.flush().await;
    let stats = pipeline.stats();
    let elapsed = started.elapsed();

    let critical_ids = ids.lock().unwrap_or_else(|e| e.into_inner()).clone();
    DriveResult {
        submitted: counters.submitted.load(Ordering::Relaxed),
        running_accepted: counters.running_accepted.load(Ordering::Relaxed),
        merged: counters.merged.load(Ordering::Relaxed),
        sampled: counters.sampled.load(Ordering::Relaxed),
        submit_errors: counters.submit_errors.load(Ordering::Relaxed),
        critical_sent: counters.critical_sent.load(Ordering::Relaxed),
        critical_ok: counters.critical_ok.load(Ordering::Relaxed),
        critical_failed: counters.critical_failed.load(Ordering::Relaxed),
        critical_retries: counters.critical_retries.load(Ordering::Relaxed),
        critical_ids,
        max_queue_depth: max_depth.load(Ordering::Relaxed),
        max_batch_size: stats.max_batch_size,
        stats,
        elapsed_ms: elapsed.as_millis(),
    }
}

fn critical_missing(db: &Db, ids: &[String]) -> usize {
    let present = db_event_ids(db);
    ids.iter().filter(|id| !present.contains(*id)).count()
}

fn base_report(scenario: &str, config: &Value) -> Value {
    json!({
        "scenario": scenario,
        "machine": machine_info(),
        "config": config,
        "started_at": chrono::Utc::now().to_rfc3339(),
        "backend_only": true,
        "note": "真实 IngestPipeline + 真实 SQLite 状态机；不含 WebView2/Tauri 窗口与托盘 UI",
    })
}

fn print_summary(report: &Value) {
    println!("\n==== 压测结果 {} ====", report["scenario"]);
    println!(
        "{}",
        serde_json::to_string_pretty(report).unwrap_or_default()
    );
    let pass = report["pass"].as_bool().unwrap_or(false);
    println!(
        "\n判定：{}",
        if pass {
            "PASS（本次运行范围内）"
        } else {
            "FAIL / 需复核"
        }
    );
}

// ── 场景 A：10 Agent × 50 事件/秒 × 10 分钟 ──

#[test]
#[ignore = "压测场景 A：需手动运行（默认 10 分钟）"]
fn scenario_a_sustained_10_agents() {
    let _guard = scenario_guard();
    let secs = env_u64("TD_PERF_A_SECS", 600);
    let agents = env_u64("TD_PERF_A_AGENTS", 10) as usize;
    let rate = env_u64("TD_PERF_A_RATE", 50);
    let (db, dir) = temp_db("a");
    let sink: Arc<dyn IngestSink> = Arc::new(DbSink::new(db.clone()));
    let rt = runtime();
    let pipeline = open_pipeline(sink, PipelineConfig::default());
    let result = rt.block_on(drive(
        pipeline.clone(),
        agents,
        rate,
        Duration::from_secs(secs),
    ));
    rt.block_on(pipeline.shutdown());

    let missing = critical_missing(&db, &result.critical_ids);
    let snapshot = db_snapshot(&db);
    let total = (agents as u64) * rate * secs;
    let mut report = base_report(
        "A",
        &json!({
            "agents": agents,
            "rate_per_agent": rate,
            "duration_secs": secs,
            "queue_capacity": pipeline.config().queue_capacity,
            "batch_size": pipeline.config().batch_size,
            "coalesce_ms": pipeline.config().coalesce_window.as_millis(),
            "expected_events": total,
        }),
    );
    let pass = result.critical_failed == 0
        && missing == 0
        && result.critical_ok == result.critical_sent
        && result.submit_errors == 0;
    report["pass"] = json!(pass);
    report["elapsed_ms"] = json!(result.elapsed_ms);
    report["throughput_ev_per_s"] = json!(
        (result.submitted as f64 / (result.elapsed_ms as f64 / 1000.0) * 100.0).round() / 100.0
    );
    report["counts"] = json!({
        "submitted": result.submitted,
        "running_accepted": result.running_accepted,
        "merged": result.merged,
        "sampled": result.sampled,
        "submit_errors": result.submit_errors,
        "critical_sent": result.critical_sent,
        "critical_ok": result.critical_ok,
        "critical_failed": result.critical_failed,
        "critical_retries": result.critical_retries,
        "critical_missing_in_db": missing,
        "max_queue_depth": result.max_queue_depth,
        "max_batch_size": result.max_batch_size,
    });
    report["pipeline"] = serde_json::to_value(&result.stats).unwrap_or(Value::Null);
    report["db"] = snapshot;
    report["db_file_mb"] = json!(dir
        .join("perf.db")
        .metadata()
        .map(|m| (m.len() as f64 / 1048576.0 * 10.0).round() / 10.0)
        .unwrap_or(0.0));
    print_summary(&report);
    write_report("A", &report);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(pass, "场景 A 未达标：关键事件缺失或提交错误");
}

// ── 场景 B：200 事件/秒、60 秒突发 ──

#[test]
#[ignore = "压测场景 B：需手动运行（默认 60 秒突发 + 排空）"]
fn scenario_b_burst_200eps() {
    let _guard = scenario_guard();
    let secs = env_u64("TD_PERF_B_SECS", 60);
    let agents = env_u64("TD_PERF_B_AGENTS", 4) as usize;
    let rate = env_u64("TD_PERF_B_RATE", 50);
    let (db, dir) = temp_db("b");
    let sink: Arc<dyn IngestSink> = Arc::new(DbSink::new(db.clone()));
    let rt = runtime();
    let pipeline = open_pipeline(sink, PipelineConfig::default());
    let total = agents as u64 * rate * secs;

    let load_started = Instant::now();
    let result = rt.block_on(drive(
        pipeline.clone(),
        agents,
        rate,
        Duration::from_secs(secs),
    ));
    let drain_ms = load_started
        .elapsed()
        .as_millis()
        .saturating_sub(result.elapsed_ms);
    rt.block_on(pipeline.shutdown());

    let missing = critical_missing(&db, &result.critical_ids);
    let pass = result.critical_failed == 0 && missing == 0 && result.submit_errors == 0;
    let mut report = base_report(
        "B",
        &json!({
            "agents": agents,
            "rate_per_agent": rate,
            "duration_secs": secs,
            "expected_events": total,
        }),
    );
    report["pass"] = json!(pass);
    report["elapsed_ms"] = json!(result.elapsed_ms);
    report["drain_ms"] = json!(drain_ms);
    report["counts"] = json!({
        "submitted": result.submitted,
        "merged": result.merged,
        "sampled": result.sampled,
        "submit_errors": result.submit_errors,
        "critical_sent": result.critical_sent,
        "critical_ok": result.critical_ok,
        "critical_failed": result.critical_failed,
        "critical_missing_in_db": missing,
        "max_queue_depth": result.max_queue_depth,
        "max_batch_size": result.max_batch_size,
    });
    report["pipeline"] = serde_json::to_value(&result.stats).unwrap_or(Value::Null);
    report["db"] = db_snapshot(&db);
    print_summary(&report);
    write_report("B", &report);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(pass, "场景 B 未达标：关键事件缺失或提交错误");
}

// ── 场景 C：持续过载（小队列 + 慢写），关键事件必须重试成功 ──

#[test]
#[ignore = "压测场景 C：需手动运行（持续过载 + 恢复）"]
fn scenario_c_overload_recovers() {
    let _guard = scenario_guard();
    let secs = env_u64("TD_PERF_C_SECS", 20);
    let agents = env_u64("TD_PERF_C_AGENTS", 8) as usize;
    let rate = env_u64("TD_PERF_C_RATE", 100);
    let (db, dir) = temp_db("c");
    let sink: Arc<dyn IngestSink> = Arc::new(DbSink {
        db: db.clone(),
        delay: Duration::from_millis(30),
        fail_session: None,
    });
    let config = PipelineConfig {
        queue_capacity: 64,
        batch_size: 10,
        coalesce_window: Duration::from_millis(100),
        ..Default::default()
    };
    let (rt, pipeline) = (runtime(), open_pipeline(sink, config));
    let result = rt.block_on(drive(
        pipeline.clone(),
        agents,
        rate,
        Duration::from_secs(secs),
    ));
    let stats_after_load = pipeline.stats();

    // 过载后恢复：单条关键事件仍能被接受并落库（消费者未卡死）
    let recovery_event = mk_event(99, 0, "completed", "perf-recovery-run");
    let recovery =
        rt.block_on(pipeline.submit(vec![recovery_event], Transport::Http, "perf", true));
    rt.block_on(pipeline.shutdown());

    let missing = critical_missing(&db, &result.critical_ids);
    let pass = result.critical_failed == 0
        && missing == 0
        && result.submit_errors == 0
        && stats_after_load.overload_rejects > 0
        && recovery.is_ok();
    let mut report = base_report(
        "C",
        &json!({
            "agents": agents,
            "rate_per_agent": rate,
            "duration_secs": secs,
            "queue_capacity": 64,
            "batch_size": 10,
            "coalesce_ms": 100,
            "injected_sink_delay_ms": 30,
        }),
    );
    report["pass"] = json!(pass);
    report["counts"] = json!({
        "submitted": result.submitted,
        "merged": result.merged,
        "sampled": result.sampled,
        "submit_errors": result.submit_errors,
        "critical_sent": result.critical_sent,
        "critical_ok": result.critical_ok,
        "critical_failed": result.critical_failed,
        "critical_retries": result.critical_retries,
        "critical_missing_in_db": missing,
        "max_queue_depth": result.max_queue_depth,
        "overload_rejects": stats_after_load.overload_rejects,
        "merge_buffer_after_load": stats_after_load.merge_buffer,
        "recovery_ok": recovery.is_ok(),
    });
    report["pipeline"] = serde_json::to_value(&result.stats).unwrap_or(Value::Null);
    report["db"] = db_snapshot(&db);
    print_summary(&report);
    write_report("C", &report);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(pass, "场景 C 未达标：过载未显式拒绝或关键事件丢失");
}

// ── 基线对比：等效旧路径（每事件一个事务）vs 新管线（批处理）──

#[test]
#[ignore = "压测基线：旧写路径 vs 新管线（默认 5000 事件）"]
fn scenario_baseline_write_comparison() {
    let _guard = scenario_guard();
    let n = env_u64("TD_PERF_BASE_EVENTS", 5000) as usize;
    let agents = 10usize;

    // 旧路径：每条事件单独开事务调用同一个 ingest_core（v0.4 之前的写库方式）
    let (db_old, dir_old) = temp_db("baseline-old");
    let now = now_iso();
    let t = Instant::now();
    for i in 0..n {
        let agent = i % agents;
        let ev = mk_event(agent, i, state_of(i), &run_of(agent, i));
        db_old
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                ingest_core(&tx, &ev, &now, Transport::Http)?;
                tx.commit()?;
                Ok(())
            })
            .expect("旧路径写入失败");
    }
    let old_ms = t.elapsed().as_millis();

    // 新路径：同一批事件经有界管线，单消费者批处理
    let (db_new, dir_new) = temp_db("baseline-new");
    let sink: Arc<dyn IngestSink> = Arc::new(DbSink::new(db_new.clone()));
    let rt = runtime();
    let pipeline = open_pipeline(sink, PipelineConfig::default());
    let t = Instant::now();
    for i in 0..n {
        let agent = i % agents;
        let ev = mk_event(agent, i, state_of(i), &run_of(agent, i));
        rt.block_on(pipeline.submit(vec![ev], Transport::Http, "perf", false))
            .expect("新管线提交失败");
    }
    rt.block_on(pipeline.flush()).expect("新管线排空失败");
    let new_ms = t.elapsed().as_millis();
    let stats = pipeline.stats();
    rt.block_on(pipeline.shutdown());

    let old_rows = old_db_count(&db_old).unwrap_or(0);
    let new_rows = old_db_count(&db_new).unwrap_or(0);
    println!(
        "\n[基线] 旧路径 {} 条事件: {} ms，新管线: {} ms（批处理 {} 批，写库 p50={}ms），speedup={:.2}x",
        n,
        old_ms,
        new_ms,
        stats.batches,
        stats.db_write_latency.p50_ms,
        old_ms as f64 / new_ms.max(1) as f64
    );

    let mut report = base_report(
        "baseline",
        &json!({
            "events": n,
            "agents": agents,
            "old_path": "每事件独立事务 + ingest_core（等效 v0.4 写库路径，未含通知/托盘副作用）",
            "new_path": "有界管线 + 批处理 + 同一 ingest_core",
        }),
    );
    report["pass"] = json!(new_rows > 0 && old_rows > 0);
    report["old_path_ms"] = json!(old_ms);
    report["new_path_ms"] = json!(new_ms);
    report["speedup"] = json!((old_ms as f64 / new_ms.max(1) as f64 * 100.0).round() / 100.0);
    report["old_rows"] = json!(old_rows);
    report["new_rows"] = json!(new_rows);
    report["new_batches"] = json!(stats.batches);
    report["pipeline"] = serde_json::to_value(&stats).unwrap_or(Value::Null);
    print_summary(&report);
    write_report("baseline", &report);
    let _ = std::fs::remove_dir_all(&dir_old);
    let _ = std::fs::remove_dir_all(&dir_new);
    assert!(new_rows > 0 && old_rows > 0, "基线对比写入为空");
}

fn old_db_count(db: &Db) -> Option<u64> {
    db.with_read(|conn| {
        conn.query_row("SELECT COUNT(*) FROM agent_events", [], |r| {
            r.get::<_, i64>(0).map(|v| v.max(0) as u64)
        })
        .map_err(Into::into)
    })
    .ok()
}

// ── 场景 D：故障注入（写库失败隔离 / 幂等 / 乱序 / 终态后重连）──

#[test]
#[ignore = "压测场景 D：故障注入（可随时运行，约 5 秒）"]
fn scenario_d_failure_injection() {
    let _guard = scenario_guard();
    let (db, dir) = temp_db("d");
    let sink: Arc<dyn IngestSink> = Arc::new(DbSink {
        db: db.clone(),
        delay: Duration::ZERO,
        fail_session: Some("perf-bad-session".into()),
    });
    let rt = runtime();
    let pipeline = open_pipeline(sink, PipelineConfig::default());

    let mut checks = serde_json::Map::new();

    // D1: 同一批中混入坏事件 → 按作业回退，好事件仍落库
    let good = mk_event(1, 0, "running", "d-run-good");
    let bad = mk_event(2, 0, "waiting", "d-run-bad");
    let mut bad = bad;
    bad.session_id = "perf-bad-session".into();
    let good_outcome = rt.block_on(pipeline.submit(vec![good], Transport::Http, "perf", true));
    let bad_outcome = rt.block_on(pipeline.submit(vec![bad], Transport::Http, "perf", true));
    let good_in_db = !db_event_ids(&db).is_empty();
    checks.insert(
        "d1_good_committed".into(),
        json!(good_outcome.is_ok() && good_in_db),
    );
    checks.insert("d1_bad_rejected".into(), json!(bad_outcome.is_err()));

    // D2: 幂等（同 event_id 重复提交，仅一行）
    let dup = mk_event(3, 1, "waiting", "d-run-dup");
    let first = rt.block_on(pipeline.submit(vec![dup.clone()], Transport::Http, "perf", true));
    let second = rt.block_on(pipeline.submit(vec![dup], Transport::Http, "perf", true));
    let dedup = second
        .as_ref()
        .ok()
        .and_then(|r| r.outcomes.as_ref())
        .map(|o| o.iter().any(|x| x.deduplicated))
        .unwrap_or(false);
    let dup_rows: u64 = db
        .with_read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_events WHERE event_id = 'perf-a3-e1'",
                [],
                |r| r.get::<_, i64>(0).map(|v| v.max(0) as u64),
            )
            .map_err(Into::into)
        })
        .unwrap_or(0);
    checks.insert(
        "d2_idempotent".into(),
        json!(first.is_ok() && dedup && dup_rows == 1),
    );

    // D3: 乱序保护（终态后到达更早的 running，不改终态）
    let done = mk_event(4, 2, "completed", "d-run-terminal");
    let done_outcome = rt.block_on(pipeline.submit(vec![done], Transport::Http, "perf", true));
    let mut late = mk_event(4, 3, "running", "d-run-terminal");
    late.occurred_at = Some((chrono::Utc::now() - chrono::Duration::seconds(120)).to_rfc3339());
    let late_outcome = rt.block_on(pipeline.submit(vec![late], Transport::Http, "perf", true));
    let late_flag = late_outcome
        .as_ref()
        .ok()
        .and_then(|r| r.outcomes.as_ref())
        .map(|o| o.iter().any(|x| x.late))
        .unwrap_or(false);
    let terminal_state = run_status(&db, "d-run-terminal");
    checks.insert(
        "d3_out_of_order_protected".into(),
        json!(done_outcome.is_ok() && late_flag && terminal_state.as_deref() == Some("completed")),
    );

    // D4: 终态后新一轮运行（重连）不复用旧终态
    let reconnect = mk_event(4, 4, "running", "d-run-reconnect");
    let reconnect_outcome =
        rt.block_on(pipeline.submit(vec![reconnect], Transport::Http, "perf", true));
    let reconnect_state = run_status(&db, "d-run-reconnect");
    checks.insert(
        "d4_reconnect_new_run".into(),
        json!(reconnect_outcome.is_ok() && reconnect_state.as_deref() == Some("running")),
    );

    rt.block_on(pipeline.shutdown());
    let stats = pipeline.stats();
    let pass = checks.values().all(|v| v.as_bool().unwrap_or(false));
    let mut report = base_report("D", &json!({ "injected_fail_session": "perf-bad-session" }));
    report["pass"] = json!(pass);
    report["checks"] = Value::Object(checks);
    report["pipeline"] = serde_json::to_value(&stats).unwrap_or(Value::Null);
    report["db"] = db_snapshot(&db);
    print_summary(&report);
    write_report("D", &report);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(pass, "场景 D 未达标：故障隔离/幂等/乱序/重连检查失败");
}

// ── 场景 E：≥30 分钟稳定性（RSS、行数、吞吐）──

#[test]
#[ignore = "压测场景 E：需手动运行（默认 30 分钟）"]
fn scenario_e_soak_30min() {
    let _guard = scenario_guard();
    let secs = env_u64("TD_PERF_E_SECS", 1800);
    let agents = env_u64("TD_PERF_E_AGENTS", 4) as usize;
    let rate = env_u64("TD_PERF_E_RATE", 5);
    let (db, dir) = temp_db("e");
    let sink: Arc<dyn IngestSink> = Arc::new(DbSink::new(db.clone()));
    let rt = runtime();
    let pipeline = open_pipeline(sink, PipelineConfig::default());

    let baseline_rss = sample_rss_bytes();
    let load = rt.spawn({
        let pipeline = pipeline.clone();
        async move { drive(pipeline, agents, rate, Duration::from_secs(secs)).await }
    });

    let mut rss_samples: Vec<(u64, Option<u64>)> = Vec::new();
    let mut elapsed = 0u64;
    while elapsed < secs {
        std::thread::sleep(Duration::from_secs(30));
        elapsed += 30;
        rss_samples.push((elapsed, sample_rss_bytes()));
    }
    let result = rt.block_on(load).expect("负载任务失败");
    rt.block_on(pipeline.shutdown());

    let missing = critical_missing(&db, &result.critical_ids);
    let snapshot = db_snapshot(&db);
    let first_rss = rss_samples.first().and_then(|(_, v)| *v);
    let last_rss = rss_samples.last().and_then(|(_, v)| *v);
    let growth_mb = match (first_rss, last_rss) {
        (Some(a), Some(b)) => Some(((b as f64 - a as f64) / 1048576.0 * 10.0).round() / 10.0),
        _ => None,
    };
    let pass = result.critical_failed == 0
        && missing == 0
        && result.submit_errors == 0
        && growth_mb.map(|g| g < 200.0).unwrap_or(true);
    let rss_json: Vec<Value> = rss_samples
        .iter()
        .map(|(t, v)| {
            json!({
                "t_secs": t,
                "rss_mb": v.map(|b| (b as f64 / 1048576.0 * 10.0).round() / 10.0),
            })
        })
        .collect();
    let mut report = base_report(
        "E",
        &json!({
            "agents": agents,
            "rate_per_agent": rate,
            "duration_secs": secs,
            "sampling": "RSS 每 30 秒（PowerShell Get-Process WorkingSet64）",
        }),
    );
    report["pass"] = json!(pass);
    report["baseline_rss_mb"] =
        json!(baseline_rss.map(|b| (b as f64 / 1048576.0 * 10.0).round() / 10.0));
    report["rss_growth_mb_first_to_last"] = json!(growth_mb);
    report["rss_samples"] = json!(rss_json);
    report["counts"] = json!({
        "submitted": result.submitted,
        "merged": result.merged,
        "sampled": result.sampled,
        "submit_errors": result.submit_errors,
        "critical_sent": result.critical_sent,
        "critical_ok": result.critical_ok,
        "critical_failed": result.critical_failed,
        "critical_missing_in_db": missing,
        "max_queue_depth": result.max_queue_depth,
    });
    report["pipeline"] = serde_json::to_value(&result.stats).unwrap_or(Value::Null);
    report["db"] = snapshot;
    report["cpu_threads"] = json!(cpu_threads());
    print_summary(&report);
    write_report("E", &report);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(pass, "场景 E 未达标：稳定性检查失败");
}
