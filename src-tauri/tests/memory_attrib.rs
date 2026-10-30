//! 内存驻留归因工具（手动运行，不进入常规 CI）：
//! `cargo test --release --test memory_attrib -- --ignored --nocapture`
//!
//! 目的：把「30 分钟压测里 task-dock.exe 私有内存 11.4 → 95.1 MB 单调上升」
//! （约 +84 MB / 36,000 事件 ≈ 2.3 KB/事件）**归因到具体层**，而不是笼统记一句
//! 「未找到无界增长点」。
//!
//! 方法：**同一负载、一次只改一个变量**的差分实验。每个臂单独跑一个进程
//! （由 `TD_MEM_ATTRIB_ARM` 选择），避免同一进程内堆状态互相污染：
//!
//! | 臂 | 负载 | 回答的问题 |
//! |---|---|---|
//! | `full` | 真实管线 + 真实 SQLite 写库 | 复现增长吗 |
//! | `pipeline_only` | 真实管线 + 丢弃 sink（不碰 DB） | 增长在**进程内**（合并缓冲/解析/对象）吗 |
//! | `db_only` | 绕过管线，直接 `ingest_core` 批量写库 | 增长在**数据库层**（页缓存/WAL）吗 |
//! | `full_checkpoint` | 同 `full`，但每 2 s 主动 `wal_checkpoint(TRUNCATE)` | 是 WAL 吗（截断 WAL 后是否消失） |
//!
//! 每个臂采样：进程私有字节 / 工作集、DB 主文件大小、`-wal` 大小、`-shm` 大小、
//! `PRAGMA page_count`。**只采样、不修改生产代码**；结论由四个臂的差分给出。
//!
//! 环境变量：
//! - `TD_MEM_ATTRIB_ARM`：`full` | `pipeline_only` | `db_only` | `full_checkpoint`
//! - `TD_MEM_ATTRIB_EVENTS`：事件数（默认 36000，与 30 分钟 soak 同量）
//! - `TD_MEM_ATTRIB_SETTLE`：结束后静置秒数（默认 60，用于区分「涨后回落」与「涨后不回落」）
//! - `TD_MEM_ATTRIB_OUT`：结果 JSON 目录（默认 `docs/performance/results`）
//!
//! 提交按 `SUBMIT_BATCH`（= 管线默认批大小 100）成组提交，每组一次事务：
//! 与生产「一个事务写一组事件」一致；逐事件提交会变成每事件一次 fsync，
//! 测到的是磁盘延迟而不是内存行为。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use task_dock_lib::agents::pipeline::{IngestPipeline, IngestSink, PipelineConfig};
use task_dock_lib::agents::{
    ingest_core, now_iso, AgentEvent, AgentState, EventOrigin, IngestOutcome, Transport,
};
use task_dock_lib::db::Db;
use task_dock_lib::error::AppResult;

const SOURCE: &str = "codex";
const RUN_LEN: usize = 20;
/// 提交批大小：与 `PipelineConfig::default().batch_size` 一致，
/// 保证一次事务写入一组事件（否则每事件一次 fsync，测的是磁盘而不是内存）。
const SUBMIT_BATCH: usize = 100;

// ── 进程内存采样 ──

/// (私有字节, 工作集字节)；非 Windows 返回 (0, 0)。
fn mem_snapshot() -> (u64, u64) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        // PrivateUsage 只在 PROCESS_MEMORY_COUNTERS_EX 里有；API 仍以基类指针入参，
        // 靠 cb 告知结构体大小（Windows 侧按 cb 决定读多少字段）。
        let mut counters = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        let ok = GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            counters.cb,
        ) != 0;
        if ok {
            return (counters.PrivateUsage as u64, counters.WorkingSetSize as u64);
        }
        (0, 0)
    }
    #[cfg(not(windows))]
    {
        (0, 0)
    }
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn db_sizes(db_path: &Path) -> (u64, u64, u64) {
    let main = file_len(db_path);
    let wal = file_len(&db_path.with_extension("db-wal"));
    let shm = file_len(&db_path.with_extension("db-shm"));
    (main, wal, shm)
}

fn page_count(db: &Db) -> i64 {
    db.with_read(|c| {
        c.query_row("PRAGMA page_count", [], |r| r.get(0))
            .map_err(task_dock_lib::error::AppError::from)
    })
    .unwrap_or(0)
}

// ── sink ──

struct DbSink {
    db: Arc<Db>,
    checkpoint: bool,
}

impl IngestSink for DbSink {
    fn commit_events(&self, items: &[(AgentEvent, Transport)]) -> AppResult<Vec<IngestOutcome>> {
        let now = now_iso();
        let out = self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut outs = Vec::with_capacity(items.len());
            for (ev, transport) in items {
                outs.push(ingest_core(&tx, ev, &now, *transport)?);
            }
            tx.commit()?;
            Ok(outs)
        })?;
        if self.checkpoint {
            // 主动截断 WAL：用来判断「增长是否来自 WAL 累积」。
            let _ = self.db.with_conn(|conn| {
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                Ok(())
            });
        }
        Ok(out)
    }

    fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
}

/// 丢弃 sink：不碰数据库。用来隔离「进程内」与「数据库层」。
struct DropSink;

impl IngestSink for DropSink {
    fn commit_events(&self, items: &[(AgentEvent, Transport)]) -> AppResult<Vec<IngestOutcome>> {
        Ok(items
            .iter()
            .map(|_| IngestOutcome {
                run_row_id: String::new(),
                session_row_id: String::new(),
                state: AgentState::Running,
                prev_state: None,
                origin: EventOrigin::Real,
                deduplicated: false,
                late: false,
                notification: None,
            })
            .collect())
    }

    fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
}

// ── 事件构造 ──

fn mk_event(agent: usize, index: usize, state: &str, run: &str) -> AgentEvent {
    AgentEvent {
        schema_version: Some(1),
        event_id: Some(format!("mem-a{}-e{}", agent, index)),
        source_id: SOURCE.into(),
        instance_id: Some(format!("mem-instance-{}", agent)),
        session_id: format!("mem-session-{}", agent),
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
    format!("mem-run-{}-{}", agent, index / RUN_LEN)
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

// ── 采样线程 ──

struct Sampler {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<Vec<Value>>>,
}

impl Sampler {
    fn start(db_path: PathBuf, db: Option<Arc<Db>>) -> Sampler {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            let mut samples: Vec<Value> = Vec::new();
            while !flag.load(Ordering::Relaxed) {
                let (private, ws) = mem_snapshot();
                let (main, wal, shm) = db_sizes(&db_path);
                let pages = db.as_ref().map(|d| page_count(d)).unwrap_or(0);
                samples.push(json!({
                    "t_ms": 0,
                    "private_bytes": private,
                    "working_set_bytes": ws,
                    "db_main_bytes": main,
                    "db_wal_bytes": wal,
                    "db_shm_bytes": shm,
                    "page_count": pages,
                }));
                std::thread::sleep(Duration::from_secs(2));
            }
            samples
        });
        Sampler {
            stop,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> Vec<Value> {
        self.stop.store(true, Ordering::Relaxed);
        self.handle
            .take()
            .map(|h| h.join().unwrap_or_default())
            .unwrap_or_default()
    }
}

// ── 驱动 ──

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn results_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TD_MEM_ATTRIB_OUT") {
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

fn temp_db(tag: &str) -> (Arc<Db>, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "taskdock-memattrib-{}-{}",
        tag,
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let path = dir.join("mem.db");
    let db = Db::open(&path).expect("打开归因数据库失败");
    (Arc::new(db), path)
}

/// 构造第 `i` 个事件。
fn event_at(i: usize, agents: usize) -> AgentEvent {
    let agent = i % agents;
    let state = state_of(i);
    let run = run_of(agent, i);
    mk_event(agent, i, state, &run)
}

/// 直接写库（绕过管线）：只保留 DB 层变量。
async fn run_db_only(db: Arc<Db>, total: u64, agents: usize) {
    let mut i = 0usize;
    while (i as u64) < total {
        let n = SUBMIT_BATCH.min((total - i as u64) as usize);
        let batch: Vec<AgentEvent> = (i..i + n).map(|k| event_at(k, agents)).collect();
        let now = now_iso();
        let _ = db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for ev in &batch {
                let _ = ingest_core(&tx, ev, &now, Transport::Http)?;
            }
            tx.commit()?;
            Ok(())
        });
        i += n;
    }
}

#[test]
#[ignore = "内存归因工具：需手动运行并逐臂对比"]
fn memory_growth_attribution() {
    let arm = std::env::var("TD_MEM_ATTRIB_ARM").unwrap_or_else(|_| "full".into());
    let total = env_u64("TD_MEM_ATTRIB_EVENTS", 36_000);
    let settle = env_u64("TD_MEM_ATTRIB_SETTLE", 60);
    let agents = 4usize;

    let rt = runtime();

    // 每个臂一个独立进程：本测试二进制每次只跑一个臂。
    let (db, db_path) = temp_db(&arm);
    let (private_base, ws_base) = mem_snapshot();

    let sampler = Sampler::start(db_path.clone(), Some(db.clone()));
    let submitted = Arc::new(AtomicU64::new(0));

    match arm.as_str() {
        "full" | "full_checkpoint" => {
            let sink = Arc::new(DbSink {
                db: db.clone(),
                checkpoint: arm == "full_checkpoint",
            });
            let pipeline = IngestPipeline::new(sink, PipelineConfig::default());
            pipeline.start();
            rt.block_on(async {
                let mut i = 0usize;
                while (i as u64) < total {
                    let n = SUBMIT_BATCH.min((total - i as u64) as usize);
                    let batch: Vec<AgentEvent> = (i..i + n).map(|k| event_at(k, agents)).collect();
                    let _ = pipeline
                        .submit(batch, Transport::Http, "memory_attrib", true)
                        .await;
                    submitted.fetch_add(n as u64, Ordering::Relaxed);
                    i += n;
                }
                pipeline.shutdown().await;
            });
        }
        "pipeline_only" => {
            let pipeline = IngestPipeline::new(Arc::new(DropSink), PipelineConfig::default());
            pipeline.start();
            rt.block_on(async {
                let mut i = 0usize;
                while (i as u64) < total {
                    let n = SUBMIT_BATCH.min((total - i as u64) as usize);
                    let batch: Vec<AgentEvent> = (i..i + n).map(|k| event_at(k, agents)).collect();
                    let _ = pipeline
                        .submit(batch, Transport::Http, "memory_attrib", true)
                        .await;
                    submitted.fetch_add(n as u64, Ordering::Relaxed);
                    i += n;
                }
                pipeline.shutdown().await;
            });
        }
        "db_only" => {
            rt.block_on(run_db_only(db.clone(), total, agents));
            submitted.fetch_add(total, Ordering::Relaxed);
        }
        other => panic!("未知臂：{}", other),
    }

    let load_done = Instant::now();
    // 静置：区分「涨后回落」与「涨后不回落」。
    std::thread::sleep(Duration::from_secs(settle));
    let (private_after, ws_after) = mem_snapshot();
    let (main_after, wal_after, shm_after) = db_sizes(&db_path);
    let pages_after = page_count(&db);
    let samples = sampler.finish();

    let private_growth = private_after.saturating_sub(private_base);
    let per_event = if submitted.load(Ordering::Relaxed) > 0 {
        private_growth as f64 / submitted.load(Ordering::Relaxed) as f64
    } else {
        0.0
    };

    let report = json!({
        "arm": arm,
        "machine": machine_info(),
        "events": submitted.load(Ordering::Relaxed),
        "submit_batch": SUBMIT_BATCH,
        "settle_secs": settle,
        "load_secs": load_done.elapsed().as_secs_f64(),
        "memory": {
            "private_base_bytes": private_base,
            "private_after_bytes": private_after,
            "private_growth_bytes": private_growth,
            "private_growth_per_event_bytes": (per_event * 100.0).round() / 100.0,
            "working_set_base_bytes": ws_base,
            "working_set_after_bytes": ws_after,
        },
        "database": {
            "main_bytes": main_after,
            "wal_bytes": wal_after,
            "shm_bytes": shm_after,
            "page_count": pages_after,
            "rows_agent_events": db
                .with_read(|c| {
                    c.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))
                        .map_err(task_dock_lib::error::AppError::from)
                })
                .unwrap_or(0),
        },
        "samples": samples,
    });

    let dir = results_dir();
    std::fs::create_dir_all(&dir).expect("创建结果目录失败");
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("MEMATTR-{}-{}.json", arm, ts));
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).expect("写入报告失败");

    println!(
        "\n[归因·{}] 事件 {} · 私有字节 {:+} B（{:.2} B/事件）· WAL {} B · 主库 {} B · page_count {}",
        arm,
        submitted.load(Ordering::Relaxed),
        private_growth as i64,
        per_event,
        wal_after,
        main_after,
        pages_after
    );
    println!("[报告] {}", path.display());
}
