//! 有界事件接入管线。
//!
//! 所有高频入口（HTTP / 文件投递 / 插件桥接）先经过本管线，再由单一消费者
//! 以「一个事务一批」写入 SQLite：
//! - 有界队列（按事件数计容量，默认 1024）+ 信号量背压；
//! - 批处理（默认 ≤100 事件）与合并窗口（默认 250ms，可配置 100~500ms）；
//! - 仅对同一 Agent/实例/会话/轮次/通道的重复 running 事件做合并；
//!   waiting/failed/completed/disconnected/idle 等关键状态永不合并、永不静默丢弃；
//! - 队列满时：非关键事件进入内存合并缓冲（按轮次键覆盖）或显式采样计数；
//!   关键事件返回可重试错误（`AppError::Overloaded`），绝不伪装成功；
//! - 单批次写失败时按作业回退（每个作业独立事务），隔离坏事件、保留单作业原子性；
//! - 提交后副作用（通知/广播/托盘）每批只执行一次；
//! - 显式生命周期：start / shutdown（排空队列与合并缓冲后退出）；
//! - 轻量指标：队列深度、吞吐、合并/采样数、拒绝数、接入与写库延迟分位。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use super::{
    next_ingest_seq, validate_event, AgentEvent, AgentHub, AgentState, IngestOutcome, Transport,
};
use crate::db::Settings;
use crate::error::{AppError, AppResult};

pub const DEFAULT_QUEUE_CAPACITY: usize = 1024;
pub const DEFAULT_BATCH_SIZE: usize = 100;
pub const DEFAULT_COALESCE_MS: u64 = 250;
const MAX_MERGE_BUFFER: usize = 4096;

/// 批量写入目标（AgentHub 的数据库实现 / 测试用假实现）。
pub trait IngestSink: Send + Sync + 'static {
    fn commit_events(&self, items: &[(AgentEvent, Transport)]) -> AppResult<Vec<IngestOutcome>>;
    fn after_batch(&self, events: &[AgentEvent], outcomes: &[IngestOutcome]);
}

impl IngestSink for AgentHub {
    fn commit_events(&self, items: &[(AgentEvent, Transport)]) -> AppResult<Vec<IngestOutcome>> {
        AgentHub::commit_events(self, items)
    }
    fn after_batch(&self, events: &[AgentEvent], outcomes: &[IngestOutcome]) {
        AgentHub::after_batch(self, events, outcomes)
    }
}

#[derive(Debug, Clone)]
pub struct PipelineConfig {
    /// 队列容量（事件数）
    pub queue_capacity: usize,
    /// 单事务最大事件数
    pub batch_size: usize,
    /// 合并窗口：首批到达后最多等待多久凑批
    pub coalesce_window: Duration,
    /// 关键事件等待信号量/入队的上限
    pub enqueue_timeout: Duration,
    /// 等待提交确认的上限（HTTP 请求等待已提交）
    pub ack_timeout: Duration,
    /// 合并缓冲最多保留的不同轮次键数量
    pub merge_buffer_capacity: usize,
    /// 退出排空总时限（超过后把未写入事件原子暂存到磁盘，不取消正在进行的写入）
    pub shutdown_timeout: Duration,
    /// 超时后写暂存文件的额外时限（应用退出最多等待 shutdown_timeout + spool_timeout）
    pub spool_timeout: Duration,
    /// 事件暂存目录；None 表示不落盘（测试/无数据目录场景）
    pub spool_dir: Option<std::path::PathBuf>,
    /// 是否采样延迟分位（关闭后仅保留计数器）
    pub diagnostics: bool,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            batch_size: DEFAULT_BATCH_SIZE,
            coalesce_window: Duration::from_millis(DEFAULT_COALESCE_MS),
            enqueue_timeout: Duration::from_millis(1500),
            ack_timeout: Duration::from_secs(15),
            merge_buffer_capacity: MAX_MERGE_BUFFER,
            shutdown_timeout: Duration::from_secs(10),
            spool_timeout: Duration::from_secs(5),
            spool_dir: None,
            diagnostics: true,
        }
    }
}

impl PipelineConfig {
    pub fn from_settings(settings: &Settings) -> Self {
        Self {
            queue_capacity: settings.ingest_queue_capacity.clamp(16, 65_536),
            batch_size: settings.ingest_batch_size.clamp(1, 1000),
            coalesce_window: Duration::from_millis(settings.ingest_coalesce_ms.clamp(100, 500)),
            enqueue_timeout: Duration::from_millis(1500),
            ack_timeout: Duration::from_secs(15),
            merge_buffer_capacity: MAX_MERGE_BUFFER,
            shutdown_timeout: Duration::from_secs(10),
            spool_timeout: Duration::from_secs(5),
            spool_dir: None,
            diagnostics: settings.perf_diagnostics_enabled,
        }
    }

    fn channel_capacity(&self) -> usize {
        self.queue_capacity.clamp(16, 4096)
    }
}

// 生命周期：RUNNING → QUIESCING（停收新提交）→ DRAINING（排空通道与合并缓冲）→ STOPPED。
pub const PHASE_RUNNING: u8 = 0;
pub const PHASE_QUIESCING: u8 = 1;
pub const PHASE_DRAINING: u8 = 2;
pub const PHASE_STOPPED: u8 = 3;

pub fn phase_name(phase: u8) -> &'static str {
    match phase {
        PHASE_QUIESCING => "quiescing",
        PHASE_DRAINING => "draining",
        PHASE_STOPPED => "stopped",
        _ => "running",
    }
}

/// 退出排空结果：显式报告完成了多少、还剩多少、是否超时，以及恢复方式。
#[derive(Debug, Clone, Serialize)]
pub struct ShutdownReport {
    pub lifecycle: String,
    /// 第二次及以后调用（管线已停止）
    pub already_stopped: bool,
    pub timed_out: bool,
    pub elapsed_ms: u64,
    /// 关闭开始时通道内待处理事件数（信号量占用）
    pub queued_events_at_start: usize,
    /// 关闭开始时合并缓冲事件数
    pub merge_events_at_start: usize,
    /// 本次关闭排空期间写入的事件数
    pub drained_events: u64,
    /// 本次管线生命周期内累计写入事件数
    pub events_processed: u64,
    /// 返回时仍未写入的事件数（排队 + 合并缓冲 + 正在写的批次）
    pub unfinished_events: usize,
    /// 本次退出期间原子暂存到磁盘、等待重启重放的事件数
    pub spooled_events: usize,
    /// 报告时磁盘上待重放的暂存文件总数（含运行期回退失败暂存）
    pub spool_files: usize,
    /// 暂存失败的事件数（既未落库也未暂存，必须由调用方重试）
    pub unsaved_events: usize,
    pub spool_error: Option<String>,
    pub recovery: String,
}

#[derive(Debug, Clone, Default)]
pub struct SubmitReceipt {
    pub accepted: usize,
    pub merged: bool,
    pub sampled: bool,
    pub outcomes: Option<Vec<IngestOutcome>>,
}

type Ack = oneshot::Sender<AppResult<Vec<IngestOutcome>>>;

struct Job {
    events: Vec<(AgentEvent, Transport)>,
    ack: Option<Ack>,
    enqueued: Instant,
    _permits: Option<OwnedSemaphorePermit>,
    shutdown: Option<oneshot::Sender<()>>,
    wake: bool,
}

impl Job {
    fn wake() -> Self {
        Self {
            events: Vec::new(),
            ack: None,
            enqueued: Instant::now(),
            _permits: None,
            shutdown: None,
            wake: true,
        }
    }
    fn shutdown(done: oneshot::Sender<()>) -> Self {
        Self {
            events: Vec::new(),
            ack: None,
            enqueued: Instant::now(),
            _permits: None,
            shutdown: Some(done),
            wake: false,
        }
    }
}

#[derive(Default)]
struct Counters {
    submissions: AtomicU64,
    events_received: AtomicU64,
    events_processed: AtomicU64,
    events_merged: AtomicU64,
    events_sampled: AtomicU64,
    overload_rejects: AtomicU64,
    commit_failures: AtomicU64,
    fallback_jobs: AtomicU64,
    batches: AtomicU64,
    last_batch_size: AtomicUsize,
    max_batch_size: AtomicUsize,
    queue_jobs: AtomicUsize,
    events_spooled: AtomicU64,
    spool_failures: AtomicU64,
    events_unsaved: AtomicU64,
}

struct LatencySampler {
    cap: usize,
    values: Vec<u64>,
    next: usize,
}

impl LatencySampler {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            values: Vec::with_capacity(cap),
            next: 0,
        }
    }
    fn push(&mut self, micros: u64) {
        if self.cap == 0 {
            return;
        }
        if self.values.len() < self.cap {
            self.values.push(micros);
        } else {
            self.values[self.next] = micros;
            self.next = (self.next + 1) % self.cap;
        }
    }
    fn percentiles(&self) -> Percentiles {
        if self.values.is_empty() {
            return Percentiles::default();
        }
        let mut v = self.values.clone();
        v.sort_unstable();
        let at = |q: f64| -> f64 {
            let idx = ((v.len() as f64 - 1.0) * q).round() as usize;
            (v[idx] as f64) / 1000.0
        };
        Percentiles {
            p50_ms: round2(at(0.50)),
            p95_ms: round2(at(0.95)),
            p99_ms: round2(at(0.99)),
            max_ms: round2((*v.last().unwrap() as f64) / 1000.0),
            samples: v.len(),
        }
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Percentiles {
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub samples: usize,
}

struct Metrics {
    ingest: LatencySampler,
    db_write: LatencySampler,
    last_flush_at: Option<String>,
}

struct Shared {
    sink: Arc<dyn IngestSink>,
    config: PipelineConfig,
    sem: Arc<Semaphore>,
    closed: AtomicBool,
    phase: AtomicU8,
    active_submits: AtomicUsize,
    in_flight_events: AtomicUsize,
    wake_pending: AtomicBool,
    consumer_alive: AtomicBool,
    merge: Mutex<HashMap<String, (AgentEvent, Transport)>>,
    counters: Counters,
    metrics: Mutex<Metrics>,
    started_at: Instant,
    shutdown_notify: tokio::sync::Notify,
    shutdown_report: Mutex<Option<ShutdownReport>>,
    shutdown_started: Mutex<Option<Instant>>,
    /// 退出排空硬时限：消费者超过它即把剩余事件原子暂存到磁盘并停止。
    drain_deadline: Mutex<Option<Instant>>,
    spool: Option<super::spool::Spool>,
    spool_error: Mutex<Option<String>>,
    /// 消费者是否因排空超时而触发了磁盘暂存。
    spool_triggered: AtomicBool,
    /// 关闭流程开始时各计数基线，用于本次退出的增量报告。
    shutdown_baseline: Mutex<Option<(u64, u64, u64)>>,
}

/// 在途提交守卫：关闭时等待所有已进入的生产者退出，避免「刚检查完关闭标志又被丢事件」。
struct SubmitGuard<'a> {
    shared: &'a Shared,
}

impl Drop for SubmitGuard<'_> {
    fn drop(&mut self) {
        if self.shared.active_submits.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.shared.shutdown_notify.notify_waiters();
        }
    }
}

/// 在写批次计数：批次结束（含消费者被取消）都会归还，供退出报告统计未完成事件。
struct InFlightGuard<'a> {
    shared: &'a Shared,
    events: usize,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.shared
            .in_flight_events
            .fetch_sub(self.events, Ordering::AcqRel);
    }
}

impl Shared {
    fn has_merged(&self) -> bool {
        self.merge.lock().map(|m| !m.is_empty()).unwrap_or(false)
    }
    fn merge_len(&self) -> usize {
        self.merge.lock().map(|m| m.len()).unwrap_or(0)
    }
    fn take_merged(&self, max: usize) -> Vec<(AgentEvent, Transport)> {
        if max == 0 {
            return Vec::new();
        }
        let mut map = match self.merge.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        // HashMap 迭代顺序不确定：按受理序号排序，保证批次内因果顺序稳定。
        let mut keys: Vec<(String, u64)> = map
            .iter()
            .map(|(k, (e, _))| (k.clone(), e.ingest_seq.unwrap_or(0)))
            .collect();
        keys.sort_by_key(|(_, seq)| *seq);
        let mut out = Vec::with_capacity(keys.len().min(max));
        for (k, _) in keys.into_iter().take(max) {
            if let Some(v) = map.remove(&k) {
                out.push(v);
            }
        }
        out
    }
}

pub struct IngestPipeline {
    tx: mpsc::Sender<Job>,
    rx: Mutex<Option<mpsc::Receiver<Job>>>,
    shared: Arc<Shared>,
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    shutdown_lock: tokio::sync::Mutex<()>,
}

/// 事件是否属于不可合并的关键状态。
fn is_critical(state: AgentState) -> bool {
    state != AgentState::Running
}

fn coalesce_key(ev: &AgentEvent, transport: Transport) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        ev.source_id,
        ev.instance_id.as_deref().unwrap_or(""),
        ev.session_id,
        ev.run_id.as_deref().unwrap_or(""),
        transport.as_str()
    )
}

impl IngestPipeline {
    pub fn new(sink: Arc<dyn IngestSink>, config: PipelineConfig) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(config.channel_capacity());
        let spool = config
            .spool_dir
            .as_ref()
            .map(|d| super::spool::Spool::new(d.clone()));
        let shared = Arc::new(Shared {
            sink,
            sem: Arc::new(Semaphore::new(config.queue_capacity)),
            config,
            closed: AtomicBool::new(false),
            phase: AtomicU8::new(PHASE_RUNNING),
            active_submits: AtomicUsize::new(0),
            in_flight_events: AtomicUsize::new(0),
            wake_pending: AtomicBool::new(false),
            consumer_alive: AtomicBool::new(false),
            merge: Mutex::new(HashMap::new()),
            counters: Counters::default(),
            metrics: Mutex::new(Metrics {
                ingest: LatencySampler::new(2048),
                db_write: LatencySampler::new(1024),
                last_flush_at: None,
            }),
            started_at: Instant::now(),
            shutdown_notify: tokio::sync::Notify::new(),
            shutdown_report: Mutex::new(None),
            shutdown_started: Mutex::new(None),
            drain_deadline: Mutex::new(None),
            spool,
            spool_error: Mutex::new(None),
            spool_triggered: AtomicBool::new(false),
            shutdown_baseline: Mutex::new(None),
        });
        Arc::new(Self {
            tx,
            rx: Mutex::new(Some(rx)),
            shared,
            handle: Mutex::new(None),
            shutdown_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn config(&self) -> &PipelineConfig {
        &self.shared.config
    }

    /// 启动唯一消费者（幂等：重复调用直接返回）。
    pub fn start(self: &Arc<Self>) {
        let mut guard = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut rx) = guard.take() else {
            return;
        };
        drop(guard);
        let this = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            this.run(&mut rx).await;
        });
        *self.handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    #[cfg(test)]
    pub(crate) fn start_tokio(self: &Arc<Self>) {
        let mut guard = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut rx) = guard.take() else {
            return;
        };
        drop(guard);
        let this = self.clone();
        tokio::spawn(async move {
            this.run(&mut rx).await;
        });
    }

    pub fn phase(&self) -> u8 {
        self.shared.phase.load(Ordering::Acquire)
    }

    fn begin_submit(&self) -> Option<SubmitGuard<'_>> {
        // 先计数再复核关闭标志：关闭流程看到 0 时，不存在已越过检查的在途提交。
        self.shared.active_submits.fetch_add(1, Ordering::AcqRel);
        if self.shared.closed.load(Ordering::Acquire) {
            if self.shared.active_submits.fetch_sub(1, Ordering::AcqRel) == 1 {
                self.shared.shutdown_notify.notify_waiters();
            }
            return None;
        }
        Some(SubmitGuard {
            shared: &self.shared,
        })
    }

    fn queued_events(&self) -> usize {
        self.shared
            .config
            .queue_capacity
            .saturating_sub(self.shared.sem.available_permits())
    }

    fn unfinished_events(&self) -> usize {
        self.queued_events()
            + self.shared.merge_len()
            + self.shared.in_flight_events.load(Ordering::Acquire)
    }

    async fn wait_active_submits(&self, deadline: Instant) {
        while self.shared.active_submits.load(Ordering::Acquire) > 0 {
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            let notified = self.shared.shutdown_notify.notified();
            if self.shared.active_submits.load(Ordering::Acquire) == 0 {
                return;
            }
            let _ = tokio::time::timeout(deadline - now, notified).await;
        }
    }

    async fn wait_for_stopped(&self, deadline: Instant) {
        loop {
            if self.phase() == PHASE_STOPPED {
                return;
            }
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            let notified = self.shared.shutdown_notify.notified();
            if self.phase() == PHASE_STOPPED {
                return;
            }
            let _ = tokio::time::timeout(deadline - now, notified).await;
        }
    }

    fn build_report(
        &self,
        lifecycle: &str,
        already_stopped: bool,
        timed_out: bool,
        queued_at_start: usize,
        merge_at_start: usize,
        processed_at_start: u64,
    ) -> ShutdownReport {
        let processed = self
            .shared
            .counters
            .events_processed
            .load(Ordering::Relaxed);
        let elapsed_ms = self
            .shared
            .shutdown_started
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let unfinished = self.unfinished_events();
        let (spooled, unsaved) = self.shutdown_deltas();
        // 待重放暂存文件数：包含本次退出暂存和运行期回退失败暂存，供重启核对。
        let spool_files = self
            .shared
            .spool
            .as_ref()
            .map(|s| s.pending_files_count())
            .unwrap_or(0);
        let spool_error = self
            .shared
            .spool_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let recovery = self.recovery_text(unfinished, spooled, unsaved);
        ShutdownReport {
            lifecycle: lifecycle.to_string(),
            already_stopped,
            timed_out,
            elapsed_ms,
            queued_events_at_start: queued_at_start,
            merge_events_at_start: merge_at_start,
            drained_events: processed.saturating_sub(processed_at_start),
            events_processed: processed,
            unfinished_events: unfinished,
            spooled_events: spooled,
            spool_files,
            unsaved_events: unsaved,
            spool_error,
            recovery,
        }
    }

    /// 本次关闭期间的（暂存事件数，未暂存事件数）。
    fn shutdown_deltas(&self) -> (usize, usize) {
        let baseline = self
            .shared
            .shutdown_baseline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or((0, 0, 0));
        let spooled = self
            .shared
            .counters
            .events_spooled
            .load(Ordering::Relaxed)
            .saturating_sub(baseline.1);
        let unsaved = self
            .shared
            .counters
            .events_unsaved
            .load(Ordering::Relaxed)
            .saturating_sub(baseline.2);
        (spooled as usize, unsaved as usize)
    }

    fn store_report(&self, report: &ShutdownReport) {
        *self
            .shared
            .shutdown_report
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(report.clone());
    }

    /// 优雅退出：停止接收 → 等待在途提交 → 排空通道与全部合并批次 → 返回显式报告。
    /// 超时只报告未完成数量，不取消正在进行的数据库写入（spawn_blocking 无取消语义）。
    /// 重复调用安全：第二次直接返回既有报告（already_stopped=true）。
    pub async fn shutdown(&self) -> ShutdownReport {
        let _lock = self.shutdown_lock.lock().await;
        let existing = self
            .shared
            .shutdown_report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(existing) = existing {
            if existing.lifecycle == "stopped" || self.phase() == PHASE_STOPPED {
                let mut r = existing;
                r.already_stopped = true;
                r.unfinished_events = self.unfinished_events();
                return r;
            }
            // 上次排空超时但消费者仍可能收尾：有限等待后再给出最新状态
            let deadline = Instant::now()
                + self.shared.config.shutdown_timeout
                + self.shared.config.spool_timeout;
            self.wait_for_stopped(deadline).await;
            if self.phase() == PHASE_STOPPED {
                let mut r = existing;
                r.lifecycle = "stopped".into();
                r.timed_out = self.shared.spool_triggered.load(Ordering::SeqCst);
                r.unfinished_events = 0;
                r.already_stopped = true;
                let (spooled, unsaved) = self.shutdown_deltas();
                r.spooled_events = spooled;
                r.unsaved_events = unsaved;
                r.elapsed_ms = self
                    .shared
                    .shutdown_started
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(r.elapsed_ms);
                self.store_report(&r);
                return r;
            }
            let mut r = existing;
            r.unfinished_events = self.unfinished_events();
            let (spooled, unsaved) = self.shutdown_deltas();
            r.spooled_events = spooled;
            r.unsaved_events = unsaved;
            r.already_stopped = false;
            return r;
        }

        let started = Instant::now();
        *self
            .shared
            .shutdown_started
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(started);
        let deadline = started + self.shared.config.shutdown_timeout;
        let queued_at_start = self.queued_events();
        let merge_at_start = self.shared.merge_len();
        let processed_at_start = self
            .shared
            .counters
            .events_processed
            .load(Ordering::Relaxed);
        *self
            .shared
            .shutdown_baseline
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some((
            processed_at_start,
            self.shared.counters.events_spooled.load(Ordering::Relaxed),
            self.shared.counters.events_unsaved.load(Ordering::Relaxed),
        ));
        *self
            .shared
            .drain_deadline
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(deadline);
        let was_stopped = self.phase() == PHASE_STOPPED;

        if !was_stopped {
            // 1. QUIESCING：拒绝新提交，等待已进入的提交退出（有限等待，不卡 UI）
            self.shared.closed.store(true, Ordering::SeqCst);
            self.shared.phase.store(PHASE_QUIESCING, Ordering::SeqCst);
            self.shared.shutdown_notify.notify_waiters();
            self.wait_active_submits(deadline).await;

            // 2. DRAINING：消费者排空通道与全部合并批次，并等待当前数据库事务结束。
            // 即使已到时限也必须把 shutdown 作业送进通道，让消费者执行磁盘暂存。
            if self.phase() != PHASE_STOPPED {
                self.shared.phase.store(PHASE_DRAINING, Ordering::SeqCst);
                self.shared.shutdown_notify.notify_waiters();
                let (tx, rx) = oneshot::channel();
                let send_budget = deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(100));
                let send = tokio::time::timeout(send_budget, self.tx.send(Job::shutdown(tx))).await;
                if matches!(send, Ok(Ok(()))) {
                    // 配了暂存目录时，消费者超过时限后还要写暂存文件，最多再等 spool_timeout。
                    let hard = if self.shared.spool.is_some() {
                        deadline + self.shared.config.spool_timeout
                    } else {
                        deadline
                    };
                    let _ =
                        tokio::time::timeout(hard.saturating_duration_since(Instant::now()), rx)
                            .await;
                }
            }
        }

        // 有暂存目录时等待消费者完成「超时后暂存」，否则维持原有有限等待语义。
        let hard_deadline = if self.shared.spool.is_some() {
            deadline + self.shared.config.spool_timeout
        } else {
            deadline
        };
        self.wait_for_stopped(hard_deadline).await;
        let stopped = self.phase() == PHASE_STOPPED;
        let lifecycle = if stopped { "stopped" } else { "draining" };
        let timed_out = !stopped || self.shared.spool_triggered.load(Ordering::SeqCst);
        let report = self.build_report(
            lifecycle,
            was_stopped && stopped,
            timed_out,
            queued_at_start,
            merge_at_start,
            processed_at_start,
        );
        self.store_report(&report);
        report
    }

    /// 等待此前提交的事件全部落库（测试/诊断用）。
    pub async fn flush(&self) -> AppResult<()> {
        let (tx, rx) = oneshot::channel();
        let job = Job {
            events: Vec::new(),
            ack: Some(tx),
            enqueued: Instant::now(),
            _permits: None,
            shutdown: None,
            wake: false,
        };
        self.tx
            .send(job)
            .await
            .map_err(|_| AppError::Unavailable("接入管线已关闭".into()))?;
        match tokio::time::timeout(self.shared.config.ack_timeout, rx).await {
            Ok(Ok(Ok(_))) => Ok(()),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(_)) => Err(AppError::Unavailable("接入管线已关闭".into())),
            Err(_) => Err(AppError::Overloaded("等待落库超时".into())),
        }
    }

    /// 提交事件。
    /// - `wait=true`：等待事务提交后返回（关键状态/批量/需要确认的调用方）。
    /// - `wait=false`：running 等非关键事件可快速入队；队列满时进入合并缓冲。
    pub async fn submit(
        &self,
        mut events: Vec<AgentEvent>,
        transport: Transport,
        _submitter: &'static str,
        wait: bool,
    ) -> AppResult<SubmitReceipt> {
        if events.is_empty() {
            return Err(AppError::Validation("事件列表为空".into()));
        }
        let _submit_guard = self
            .begin_submit()
            .ok_or_else(|| AppError::Unavailable("接入管线已关闭".into()))?;
        // 服务端受理序号：在入口、任何等待之前分配，跨队列/合并缓冲/通道保持因果顺序。
        for ev in events.iter_mut() {
            if ev.ingest_seq.is_none() {
                ev.ingest_seq = Some(next_ingest_seq());
            }
        }
        let mut critical = false;
        for ev in &events {
            let state = validate_event(ev)?;
            if is_critical(state) {
                critical = true;
            }
        }
        let mergeable = !critical && events.len() == 1;

        if mergeable && !wait {
            if let Some(receipt) = self.try_fast_enqueue(&events, transport) {
                return Ok(receipt);
            }
            return Ok(self.merge_or_sample(events, transport));
        }

        self.enqueue_waited(events, transport, wait).await
    }

    fn try_fast_enqueue(
        &self,
        events: &[AgentEvent],
        transport: Transport,
    ) -> Option<SubmitReceipt> {
        let permit = self.shared.sem.clone().try_acquire_owned().ok()?;
        let job = Job {
            events: events.iter().cloned().map(|e| (e, transport)).collect(),
            ack: None,
            enqueued: Instant::now(),
            _permits: Some(permit),
            shutdown: None,
            wake: false,
        };
        match self.tx.try_send(job) {
            Ok(()) => {
                self.shared
                    .counters
                    .submissions
                    .fetch_add(1, Ordering::Relaxed);
                self.shared
                    .counters
                    .events_received
                    .fetch_add(events.len() as u64, Ordering::Relaxed);
                self.shared
                    .counters
                    .queue_jobs
                    .fetch_add(1, Ordering::Relaxed);
                Some(SubmitReceipt {
                    accepted: events.len(),
                    ..Default::default()
                })
            }
            Err(_) => None,
        }
    }

    /// 非关键事件在队列满时进入按轮次键的合并缓冲；缓冲也满则显式采样。
    fn merge_or_sample(&self, events: Vec<AgentEvent>, transport: Transport) -> SubmitReceipt {
        let ev = &events[0];
        let key = coalesce_key(ev, transport);
        let mut map = self.shared.merge.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = map.get_mut(&key) {
            *slot = (ev.clone(), transport);
            self.shared
                .counters
                .events_merged
                .fetch_add(1, Ordering::Relaxed);
            self.shared
                .counters
                .events_received
                .fetch_add(1, Ordering::Relaxed);
            drop(map);
            self.wake_consumer();
            return SubmitReceipt {
                accepted: 0,
                merged: true,
                ..Default::default()
            };
        }
        if map.len() >= self.shared.config.merge_buffer_capacity {
            self.shared
                .counters
                .events_sampled
                .fetch_add(1, Ordering::Relaxed);
            self.shared
                .counters
                .events_received
                .fetch_add(1, Ordering::Relaxed);
            return SubmitReceipt {
                accepted: 0,
                sampled: true,
                ..Default::default()
            };
        }
        map.insert(key, (ev.clone(), transport));
        drop(map);
        self.shared
            .counters
            .events_received
            .fetch_add(1, Ordering::Relaxed);
        self.wake_consumer();
        SubmitReceipt {
            accepted: 0,
            merged: true,
            ..Default::default()
        }
    }

    fn wake_consumer(&self) {
        if self.shared.closed.load(Ordering::Acquire) {
            return;
        }
        if !self.shared.wake_pending.swap(true, Ordering::AcqRel)
            && self.tx.try_send(Job::wake()).is_err()
        {
            self.shared.wake_pending.store(false, Ordering::Release);
        }
    }

    async fn enqueue_waited(
        &self,
        events: Vec<AgentEvent>,
        transport: Transport,
        wait: bool,
    ) -> AppResult<SubmitReceipt> {
        let n = events.len();
        if n > self.shared.config.queue_capacity {
            self.shared
                .counters
                .overload_rejects
                .fetch_add(1, Ordering::Relaxed);
            return Err(AppError::Overloaded(format!(
                "单次提交 {} 条超过队列容量 {}",
                n, self.shared.config.queue_capacity
            )));
        }
        let permits = match tokio::time::timeout(
            self.shared.config.enqueue_timeout,
            self.shared.sem.clone().acquire_many_owned(n as u32),
        )
        .await
        {
            Ok(Ok(p)) => p,
            Ok(Err(_)) => {
                return Err(AppError::Unavailable("接入管线已关闭".into()));
            }
            Err(_) => {
                self.shared
                    .counters
                    .overload_rejects
                    .fetch_add(1, Ordering::Relaxed);
                return Err(AppError::Overloaded("接入队列已满，请重试".into()));
            }
        };
        let (ack_tx, ack_rx) = oneshot::channel();
        let job = Job {
            events: events.iter().cloned().map(|e| (e, transport)).collect(),
            ack: wait.then_some(ack_tx),
            enqueued: Instant::now(),
            _permits: Some(permits),
            shutdown: None,
            wake: false,
        };
        match tokio::time::timeout(self.shared.config.enqueue_timeout, self.tx.send(job)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(AppError::Unavailable("接入管线已关闭".into())),
            Err(_) => {
                self.shared
                    .counters
                    .overload_rejects
                    .fetch_add(1, Ordering::Relaxed);
                return Err(AppError::Overloaded("接入队列拥塞，请重试".into()));
            }
        }
        self.shared
            .counters
            .submissions
            .fetch_add(1, Ordering::Relaxed);
        self.shared
            .counters
            .events_received
            .fetch_add(n as u64, Ordering::Relaxed);
        self.shared
            .counters
            .queue_jobs
            .fetch_add(1, Ordering::Relaxed);
        if !wait {
            return Ok(SubmitReceipt {
                accepted: n,
                ..Default::default()
            });
        }
        match tokio::time::timeout(self.shared.config.ack_timeout, ack_rx).await {
            Ok(Ok(Ok(outs))) => Ok(SubmitReceipt {
                accepted: n,
                outcomes: Some(outs),
                ..Default::default()
            }),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(_)) => Err(AppError::Unavailable("接入管线已关闭".into())),
            Err(_) => {
                // 提交可能已在后台完成；调用方按幂等键重试是安全的
                Err(AppError::Overloaded("等待写入超时，请重试".into()))
            }
        }
    }

    async fn run(self: Arc<Self>, rx: &mut mpsc::Receiver<Job>) {
        self.shared.consumer_alive.store(true, Ordering::Release);
        let mut pending_shutdown: Option<oneshot::Sender<()>> = None;
        loop {
            // 关闭期间主循环同样受退出硬时限约束：已开始的数据库事务不打断，
            // 但写完当前批次后不再领取新作业，转入「暂存未处理事件」。
            let first = if self.shared.spool.is_some() && self.shared.closed.load(Ordering::Acquire)
            {
                let wait = self
                    .shared
                    .drain_deadline
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .map(|d| d.saturating_duration_since(Instant::now()))
                    .unwrap_or(Duration::from_secs(1));
                if wait.is_zero() {
                    break;
                }
                tokio::select! {
                    j = rx.recv() => match j {
                        Some(j) => j,
                        None => break,
                    },
                    _ = tokio::time::sleep(wait) => break,
                }
            } else {
                match rx.recv().await {
                    Some(j) => j,
                    None => break,
                }
            };
            if let Some(done) = first.shutdown {
                pending_shutdown = Some(done);
                break;
            }
            if first.wake {
                self.shared.wake_pending.store(false, Ordering::Release);
                // 唤醒：已就绪的主队列作业与合并缓冲合并成同一批，
                // 由 process 按受理序号排序后写入，避免「先清 merge 再读主队列」。
                let mut jobs = Vec::new();
                let mut total = 0usize;
                while total < self.shared.config.batch_size {
                    match rx.try_recv() {
                        Ok(j) => {
                            if let Some(done) = j.shutdown {
                                pending_shutdown = Some(done);
                                break;
                            }
                            if j.wake {
                                self.shared.wake_pending.store(false, Ordering::Release);
                                continue;
                            }
                            total += j.events.len();
                            jobs.push(j);
                        }
                        Err(_) => break,
                    }
                }
                let remaining = self.shared.config.batch_size.saturating_sub(total);
                let buffered = self.shared.take_merged(remaining);
                self.process(jobs, buffered).await;
                if pending_shutdown.is_some() {
                    break;
                }
                if rx.is_empty() && self.shared.has_merged() {
                    self.drain_merged(usize::MAX).await;
                }
                continue;
            }

            let mut jobs = vec![first];
            let mut total: usize = jobs[0].events.len();
            let deadline = Instant::now() + self.shared.config.coalesce_window;
            while total < self.shared.config.batch_size {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match tokio::time::timeout(deadline - now, rx.recv()).await {
                    Ok(Some(j)) => {
                        if let Some(done) = j.shutdown {
                            pending_shutdown = Some(done);
                            break;
                        }
                        if j.wake {
                            self.shared.wake_pending.store(false, Ordering::Release);
                            continue;
                        }
                        total += j.events.len();
                        jobs.push(j);
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            let remaining = self.shared.config.batch_size.saturating_sub(total);
            let buffered = self.shared.take_merged(remaining);
            self.process(jobs, buffered).await;

            if pending_shutdown.is_some() {
                break;
            }
            if rx.is_empty() && self.shared.has_merged() {
                self.drain_merged(usize::MAX).await;
            }
        }

        // 退出排空：先处理通道中已受理但未消费的作业（停止接收后不再有新提交），
        // 再按批次排空合并缓冲；超过硬时限或写入失败时，把剩余事件原子暂存到磁盘。
        loop {
            if self.shared.spool.is_some() && self.drain_deadline_reached() {
                self.spool_pending(rx, &mut pending_shutdown).await;
                break;
            }
            let mut jobs = Vec::new();
            let mut total = 0usize;
            while let Ok(j) = rx.try_recv() {
                if let Some(done) = j.shutdown {
                    pending_shutdown = Some(done);
                    continue;
                }
                if j.wake {
                    continue;
                }
                total += j.events.len();
                jobs.push(j);
                if total >= self.shared.config.batch_size {
                    break;
                }
            }
            if jobs.is_empty() {
                break;
            }
            let remaining = self.shared.config.batch_size.saturating_sub(total);
            let buffered = self.shared.take_merged(remaining);
            if !self.process(jobs, buffered).await {
                if self.shared.spool.is_some() {
                    self.spool_pending(rx, &mut pending_shutdown).await;
                }
                break;
            }
        }
        if !(self.shared.spool.is_some() && self.drain_deadline_reached()) {
            self.drain_merged(usize::MAX).await;
        }
        if self.shared.spool.is_some() && self.drain_deadline_reached() {
            self.spool_pending(rx, &mut pending_shutdown).await;
        }

        self.shared.phase.store(PHASE_STOPPED, Ordering::SeqCst);
        self.shared.consumer_alive.store(false, Ordering::Release);
        {
            let mut guard = self
                .shared
                .shutdown_report
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(report) = guard.as_mut() {
                report.lifecycle = "stopped".into();
                report.unfinished_events = self.unfinished_events();
                let (spooled, unsaved) = self.shutdown_deltas();
                report.spooled_events = spooled;
                report.unsaved_events = unsaved;
                report.timed_out = self.shared.spool_triggered.load(Ordering::SeqCst);
                report.recovery = self.recovery_text(report.unfinished_events, spooled, unsaved);
                report.elapsed_ms = self
                    .shared
                    .shutdown_started
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(report.elapsed_ms);
            }
        }
        self.shared.shutdown_notify.notify_waiters();
        if let Some(done) = pending_shutdown {
            let _ = done.send(());
        }
    }

    fn drain_deadline_reached(&self) -> bool {
        self.shared
            .drain_deadline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|d| Instant::now() >= d)
            .unwrap_or(false)
    }

    fn recovery_text(&self, unfinished: usize, spooled: usize, unsaved: usize) -> String {
        if unsaved > 0 {
            format!(
                "{} 条事件既未写入也未暂存：调用方必须按幂等键重试；已提交批次由 SQLite 事务保证完整",
                unsaved
            )
        } else if spooled > 0 {
            format!(
                "退出超时：{} 条已受理事件已原子暂存到 {:?}，下次启动自动幂等重放",
                spooled,
                self.shared.spool.as_ref().map(|s| s.dir())
            )
        } else if unfinished == 0 {
            "全部已受理事件均已写入（关键事件提交均收到确认）".to_string()
        } else {
            "仍有事件未写入：调用方应按幂等键重试；重启后遗留 running 轮次由 recover_after_restart 归位"
                .to_string()
        }
    }

    /// 把通道与合并缓冲中的剩余事件原子暂存到磁盘；等待确认的提交收到可重试错误。
    /// 返回实际暂存的事件数；暂存失败时返回 0 并把数量记入 unsaved。
    async fn spool_pending(
        &self,
        rx: &mut mpsc::Receiver<Job>,
        pending_shutdown: &mut Option<oneshot::Sender<()>>,
    ) -> usize {
        let mut items: Vec<(AgentEvent, Transport)> = Vec::new();
        let mut acks: Vec<Ack> = Vec::new();
        while let Ok(j) = rx.try_recv() {
            if let Some(done) = j.shutdown {
                *pending_shutdown = Some(done);
                continue;
            }
            if j.wake {
                continue;
            }
            if let Some(ack) = j.ack {
                acks.push(ack);
            }
            items.extend(j.events);
        }
        items.extend(self.shared.take_merged(usize::MAX));
        self.shared.spool_triggered.store(true, Ordering::SeqCst);
        let total = items.len();
        let spooled = self.spool_events(items, "shutdown").await;
        let err = if total > 0 && spooled == 0 {
            AppError::Unavailable("服务正在退出：部分事件未写入，请按幂等键重试".into())
        } else if total > 0 {
            AppError::Unavailable("服务正在退出：事件已原子暂存，重启后自动重放".into())
        } else {
            AppError::Unavailable("服务正在退出".into())
        };
        for ack in acks {
            let _ = ack.send(Err(err.duplicate()));
        }
        spooled
    }

    /// 写盘本身不持有任何管线锁；失败只报告，绝不把未落盘事件谎报为已保存。
    async fn spool_events(&self, items: Vec<(AgentEvent, Transport)>, tag: &'static str) -> usize {
        let n = items.len();
        if n == 0 {
            return 0;
        }
        let Some(spool) = self.shared.spool.clone() else {
            self.shared
                .counters
                .events_unsaved
                .fetch_add(n as u64, Ordering::Relaxed);
            return 0;
        };
        let result = tokio::task::spawn_blocking(move || spool.write_batches(&items, tag)).await;
        match result {
            Ok(Ok(paths)) => {
                self.shared
                    .counters
                    .events_spooled
                    .fetch_add(n as u64, Ordering::Relaxed);
                tracing::warn!(
                    "退出/写失败：{} 条事件已原子暂存到 {} 个文件",
                    n,
                    paths.len()
                );
                n
            }
            Ok(Err(e)) => {
                self.shared
                    .counters
                    .spool_failures
                    .fetch_add(1, Ordering::Relaxed);
                self.shared
                    .counters
                    .events_unsaved
                    .fetch_add(n as u64, Ordering::Relaxed);
                tracing::error!("事件暂存失败（{} 条未保存）: {}", n, e);
                *self
                    .shared
                    .spool_error
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(e.to_string());
                0
            }
            Err(e) => {
                self.shared
                    .counters
                    .spool_failures
                    .fetch_add(1, Ordering::Relaxed);
                self.shared
                    .counters
                    .events_unsaved
                    .fetch_add(n as u64, Ordering::Relaxed);
                let msg = format!("事件暂存任务异常: {}", e);
                tracing::error!("{}（{} 条未保存）", msg, n);
                *self
                    .shared
                    .spool_error
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(msg);
                0
            }
        }
    }

    /// 反复处理合并缓冲直到清空；写入失败时停下（事件已写回缓冲，不静默丢弃）。
    /// 返回实际成功处理的批次数量。
    async fn drain_merged(&self, max_batches: usize) -> usize {
        let mut batches = 0usize;
        while batches < max_batches && self.shared.has_merged() {
            if self.shared.spool.is_some() && self.drain_deadline_reached() {
                break;
            }
            let batch = self.shared.take_merged(self.shared.config.batch_size);
            if batch.is_empty() {
                break;
            }
            if !self.process(Vec::new(), batch).await {
                break;
            }
            batches += 1;
        }
        batches
    }

    /// 写入一批事件。返回是否成功提交（false 时已按作业回退，缓冲事件已写回）。
    async fn process(&self, jobs: Vec<Job>, buffered: Vec<(AgentEvent, Transport)>) -> bool {
        if jobs.is_empty() && buffered.is_empty() {
            return true;
        }
        let job_lens: Vec<usize> = jobs.iter().map(|j| j.events.len()).collect();
        let mut raw: Vec<(u64, Option<usize>, AgentEvent, Transport)> =
            Vec::with_capacity(job_lens.iter().sum::<usize>() + buffered.len());
        for (ji, job) in jobs.iter().enumerate() {
            for (ev, transport) in &job.events {
                raw.push((ev.ingest_seq.unwrap_or(0), Some(ji), ev.clone(), *transport));
            }
        }
        for (ev, transport) in &buffered {
            raw.push((ev.ingest_seq.unwrap_or(0), None, ev.clone(), *transport));
        }
        // 稳定排序：主队列与合并缓冲共用同一因果顺序（受理序号在入口分配）。
        raw.sort_by_key(|(seq, _, _, _)| *seq);

        let mut items: Vec<(AgentEvent, Transport)> = Vec::with_capacity(raw.len());
        let mut item_jobs: Vec<Vec<usize>> = Vec::with_capacity(raw.len());
        // 同一轮次键的连续 running 进度合并；关键状态出现即形成屏障，之后的进度不得与其合并。
        let mut running_slot: HashMap<String, usize> = HashMap::new();
        let mut coalesced: u64 = 0;
        for (_, ji, ev, transport) in raw {
            let state = AgentState::parse(&ev.state);
            let key = coalesce_key(&ev, transport);
            let single_running =
                state == Some(AgentState::Running) && ji.map(|i| job_lens[i] == 1).unwrap_or(true);
            if single_running {
                if let Some(&idx) = running_slot.get(&key) {
                    items[idx] = (ev, transport);
                    if let Some(ji) = ji {
                        item_jobs[idx].push(ji);
                    }
                    coalesced += 1;
                    continue;
                }
            }
            let idx = items.len();
            items.push((ev, transport));
            item_jobs.push(ji.map(|i| vec![i]).unwrap_or_default());
            if single_running {
                running_slot.insert(key, idx);
            } else {
                running_slot.remove(&key);
            }
        }

        if items.is_empty() {
            for job in jobs {
                if let Some(ack) = job.ack {
                    let _ = ack.send(Ok(Vec::new()));
                }
            }
            return true;
        }

        let batch_len = items.len();
        self.shared.counters.batches.fetch_add(1, Ordering::Relaxed);
        self.shared
            .counters
            .last_batch_size
            .store(batch_len, Ordering::Relaxed);
        self.shared
            .counters
            .events_merged
            .fetch_add(coalesced, Ordering::Relaxed);
        self.shared
            .counters
            .max_batch_size
            .fetch_max(batch_len, Ordering::Relaxed);
        self.shared.counters.queue_jobs.fetch_sub(
            jobs.iter().filter(|j| !j.events.is_empty()).count(),
            Ordering::Relaxed,
        );

        let sink = self.shared.sink.clone();
        let items_for_db = items.clone();
        // spawn_blocking 无取消语义：必须等真实写入结束，不能超时后当作已取消。
        self.shared
            .in_flight_events
            .fetch_add(batch_len, Ordering::AcqRel);
        let _inflight = InFlightGuard {
            shared: &self.shared,
            events: batch_len,
        };
        let join = tokio::task::spawn_blocking(move || {
            let db_started = Instant::now();
            let result = sink.commit_events(&items_for_db);
            let db_elapsed = db_started.elapsed();
            if let Ok(outcomes) = &result {
                let events: Vec<AgentEvent> = items_for_db.iter().map(|(e, _)| e.clone()).collect();
                sink.after_batch(&events, outcomes);
            }
            (result, db_elapsed)
        })
        .await;
        let (result, db_elapsed) = match join {
            Ok(v) => v,
            Err(e) => (
                Err(AppError::Agent(format!("写入任务异常: {}", e))),
                Duration::ZERO,
            ),
        };
        {
            let mut m = self
                .shared
                .metrics
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if self.shared.config.diagnostics {
                m.db_write.push(db_elapsed.as_micros() as u64);
                for job in &jobs {
                    if !job.events.is_empty() {
                        m.ingest.push(job.enqueued.elapsed().as_micros() as u64);
                    }
                }
            }
            m.last_flush_at = Some(super::now_iso());
        }

        match result {
            Ok(outcomes) => {
                self.shared
                    .counters
                    .events_processed
                    .fetch_add(batch_len as u64, Ordering::Relaxed);
                for (ji, job) in jobs.into_iter().enumerate() {
                    if let Some(ack) = job.ack {
                        let outs: Vec<IngestOutcome> = item_jobs
                            .iter()
                            .enumerate()
                            .filter(|(_, owners)| owners.contains(&ji))
                            .filter_map(|(i, _)| outcomes.get(i).cloned())
                            .collect();
                        let _ = ack.send(Ok(outs));
                    }
                }
                true
            }
            Err(e) => {
                self.shared
                    .counters
                    .commit_failures
                    .fetch_add(1, Ordering::Relaxed);
                let (saved, failed) = self.fallback_jobs(jobs).await;
                self.shared
                    .counters
                    .events_processed
                    .fetch_add(saved as u64, Ordering::Relaxed);
                // 回退仍失败的事件：能落盘就暂存，下次启动幂等重放；否则如实计入未保存。
                if !failed.is_empty() {
                    self.spool_events(failed, "fallback").await;
                }
                // 合并缓冲事件（非关键）写回缓冲，下一轮重试；超出容量则显式采样
                if !buffered.is_empty() {
                    let mut map = self.shared.merge.lock().unwrap_or_else(|e| e.into_inner());
                    for (ev, tr) in buffered {
                        if map.len() >= self.shared.config.merge_buffer_capacity {
                            self.shared
                                .counters
                                .events_sampled
                                .fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        map.insert(coalesce_key(&ev, tr), (ev, tr));
                    }
                    drop(map);
                    self.wake_consumer();
                }
                tracing::warn!("批量写入失败，已按作业回退: {}", e);
                false
            }
        }
    }

    /// 单批事务失败时的回退：每个作业独立事务，隔离坏事件，保留单作业原子性。
    /// 返回（回退成功写入的事件数，仍失败的事件）：失败事件交调用方落盘暂存。
    async fn fallback_jobs(&self, jobs: Vec<Job>) -> (usize, Vec<(AgentEvent, Transport)>) {
        let mut saved = 0usize;
        let mut failed: Vec<(AgentEvent, Transport)> = Vec::new();
        for job in jobs {
            if job.events.is_empty() {
                if let Some(ack) = job.ack {
                    let _ = ack.send(Ok(Vec::new()));
                }
                continue;
            }
            self.shared
                .counters
                .fallback_jobs
                .fetch_add(1, Ordering::Relaxed);
            let sink = self.shared.sink.clone();
            let evs = job.events.clone();
            let evs_len = evs.len();
            let result = tokio::task::spawn_blocking(move || {
                let r = sink.commit_events(&evs);
                if let Ok(outs) = &r {
                    let events: Vec<AgentEvent> = evs.iter().map(|(e, _)| e.clone()).collect();
                    sink.after_batch(&events, outs);
                }
                r
            })
            .await;
            match result {
                Ok(Ok(outs)) => {
                    saved += evs_len;
                    if let Some(ack) = job.ack {
                        let _ = ack.send(Ok(outs));
                    }
                }
                Ok(Err(e)) => {
                    self.shared
                        .counters
                        .commit_failures
                        .fetch_add(1, Ordering::Relaxed);
                    if let Some(ack) = job.ack {
                        let _ = ack.send(Err(e));
                    }
                    failed.extend(job.events);
                }
                Err(e) => {
                    self.shared
                        .counters
                        .commit_failures
                        .fetch_add(1, Ordering::Relaxed);
                    if let Some(ack) = job.ack {
                        let _ = ack.send(Err(AppError::Agent(format!("写入任务异常: {}", e))));
                    }
                    failed.extend(job.events);
                }
            }
        }
        (saved, failed)
    }

    pub fn stats(&self) -> PipelineStats {
        let c = &self.shared.counters;
        let m = self
            .shared
            .metrics
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        PipelineStats {
            running: self.shared.consumer_alive.load(Ordering::Acquire),
            lifecycle: phase_name(self.phase()).to_string(),
            submissions: c.submissions.load(Ordering::Relaxed),
            events_received: c.events_received.load(Ordering::Relaxed),
            events_processed: c.events_processed.load(Ordering::Relaxed),
            events_merged: c.events_merged.load(Ordering::Relaxed),
            events_sampled: c.events_sampled.load(Ordering::Relaxed),
            overload_rejects: c.overload_rejects.load(Ordering::Relaxed),
            commit_failures: c.commit_failures.load(Ordering::Relaxed),
            fallback_jobs: c.fallback_jobs.load(Ordering::Relaxed),
            events_spooled: c.events_spooled.load(Ordering::Relaxed),
            spool_failures: c.spool_failures.load(Ordering::Relaxed),
            events_unsaved: c.events_unsaved.load(Ordering::Relaxed),
            spool_pending_files: self
                .shared
                .spool
                .as_ref()
                .map(|s| s.pending_files_count())
                .unwrap_or(0),
            batches: c.batches.load(Ordering::Relaxed),
            queue_capacity: self.shared.config.queue_capacity,
            queue_depth_events: self
                .shared
                .config
                .queue_capacity
                .saturating_sub(self.shared.sem.available_permits()),
            queue_depth_jobs: c.queue_jobs.load(Ordering::Relaxed),
            merge_buffer: self.shared.merge_len(),
            last_batch_size: c.last_batch_size.load(Ordering::Relaxed),
            max_batch_size: c.max_batch_size.load(Ordering::Relaxed),
            coalesce_ms: self.shared.config.coalesce_window.as_millis() as u64,
            ingest_latency: m.ingest.percentiles(),
            db_write_latency: m.db_write.percentiles(),
            last_flush_at: m.last_flush_at.clone(),
            uptime_secs: self.shared.started_at.elapsed().as_secs(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PipelineStats {
    pub running: bool,
    /// running | quiescing | draining | stopped
    pub lifecycle: String,
    pub submissions: u64,
    pub events_received: u64,
    pub events_processed: u64,
    pub events_merged: u64,
    pub events_sampled: u64,
    pub overload_rejects: u64,
    pub commit_failures: u64,
    pub fallback_jobs: u64,
    /// 已原子暂存到磁盘、等待重放的事件数
    pub events_spooled: u64,
    pub spool_failures: u64,
    /// 既未落库也未暂存的事件数（调用方必须重试）
    pub events_unsaved: u64,
    pub spool_pending_files: usize,
    pub batches: u64,
    pub queue_capacity: usize,
    pub queue_depth_events: usize,
    pub queue_depth_jobs: usize,
    pub merge_buffer: usize,
    pub last_batch_size: usize,
    pub max_batch_size: usize,
    pub coalesce_ms: u64,
    pub ingest_latency: Percentiles,
    pub db_write_latency: Percentiles,
    pub last_flush_at: Option<String>,
    pub uptime_secs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::EventOrigin;
    use std::sync::atomic::AtomicBool;

    struct FakeSink {
        events: Mutex<Vec<AgentEvent>>,
        fail_next_multi: AtomicBool,
        commits: AtomicUsize,
    }

    impl FakeSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Vec::new()),
                fail_next_multi: AtomicBool::new(false),
                commits: AtomicUsize::new(0),
            })
        }
    }

    impl IngestSink for FakeSink {
        fn commit_events(
            &self,
            items: &[(AgentEvent, Transport)],
        ) -> AppResult<Vec<IngestOutcome>> {
            if items.len() > 1 && self.fail_next_multi.swap(false, Ordering::SeqCst) {
                return Err(AppError::Agent("模拟批量失败".into()));
            }
            self.commits.fetch_add(1, Ordering::Relaxed);
            let mut guard = self.events.lock().unwrap();
            guard.extend(items.iter().map(|(e, _)| e.clone()));
            Ok(items
                .iter()
                .enumerate()
                .map(|(i, (e, _))| IngestOutcome {
                    run_row_id: format!("run-{}", i),
                    session_row_id: format!("sess-{}", e.session_id),
                    state: AgentState::parse(&e.state).unwrap_or(AgentState::Running),
                    prev_state: None,
                    deduplicated: false,
                    late: false,
                    notification: None,
                    origin: EventOrigin::Real,
                })
                .collect())
        }
        fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
    }

    fn ev(session: &str, run: &str, state: &str) -> AgentEvent {
        AgentEvent {
            source_id: "bridge".into(),
            session_id: session.into(),
            run_id: Some(run.into()),
            state: state.into(),
            ..Default::default()
        }
    }

    fn config() -> PipelineConfig {
        PipelineConfig {
            queue_capacity: 1024,
            batch_size: 100,
            coalesce_window: Duration::from_millis(150),
            enqueue_timeout: Duration::from_millis(200),
            ack_timeout: Duration::from_secs(3),
            merge_buffer_capacity: 8,
            shutdown_timeout: Duration::from_secs(3),
            spool_timeout: Duration::from_secs(5),
            spool_dir: None,
            diagnostics: true,
        }
    }

    #[tokio::test]
    async fn repeated_running_events_are_coalesced_per_run() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        for _ in 0..50 {
            p.submit(
                vec![ev("s1", "r1", "running")],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        p.flush().await.unwrap();
        let got = sink.events.lock().unwrap().len();
        assert!(got <= 2, "50 条重复 running 应合并为少量事件，实际 {}", got);
        assert!(p.stats().events_merged > 0);
        p.shutdown().await;
    }

    #[tokio::test]
    async fn critical_events_are_never_coalesced() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        for _ in 0..10 {
            let r = p
                .submit(
                    vec![ev("s1", "r1", "waiting")],
                    Transport::Http,
                    "test",
                    false,
                )
                .await
                .unwrap();
            assert_eq!(r.accepted, 1);
        }
        p.flush().await.unwrap();
        let got = sink.events.lock().unwrap().len();
        assert_eq!(got, 10, "waiting 关键状态不得合并");
        p.shutdown().await;
    }

    #[tokio::test]
    async fn same_run_events_never_merge_across_sessions() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        p.submit(
            vec![ev("s1", "r1", "running")],
            Transport::Http,
            "test",
            false,
        )
        .await
        .unwrap();
        p.submit(
            vec![ev("s2", "r1", "running")],
            Transport::Http,
            "test",
            false,
        )
        .await
        .unwrap();
        p.flush().await.unwrap();
        assert_eq!(sink.events.lock().unwrap().len(), 2);
        p.shutdown().await;
    }

    #[tokio::test]
    async fn full_queue_rejects_critical_and_samples_noncritical() {
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.queue_capacity = 1;
        cfg.merge_buffer_capacity = 1;
        cfg.enqueue_timeout = Duration::from_millis(30);
        let p = IngestPipeline::new(sink.clone(), cfg);
        // 不启动消费者：占满队列
        p.submit(
            vec![ev("s1", "r1", "waiting")],
            Transport::Http,
            "test",
            false,
        )
        .await
        .unwrap();
        let err = p
            .submit(
                vec![ev("s2", "r1", "failed")],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Overloaded(_)),
            "关键事件应返回可重试错误"
        );
        // 非关键：第一次进入合并缓冲，第二个不同键被显式采样
        let r1 = p
            .submit(
                vec![ev("s3", "r1", "running")],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        assert!(r1.merged);
        let r2 = p
            .submit(
                vec![ev("s4", "r1", "running")],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        assert!(r2.sampled, "合并缓冲满时必须显式报告采样");
        assert!(p.stats().events_sampled >= 1);
        assert!(p.stats().overload_rejects >= 1);
    }

    #[tokio::test]
    async fn batch_failure_falls_back_per_job() {
        let sink = FakeSink::new();
        sink.fail_next_multi.store(true, Ordering::SeqCst);
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        // 并发提交 → 两个作业进入同一批；批量事务失败后应按作业回退成功
        let (a, b) = tokio::join!(
            p.submit(
                vec![ev("s1", "r1", "waiting")],
                Transport::Http,
                "test",
                true
            ),
            p.submit(
                vec![ev("s2", "r2", "failed")],
                Transport::Http,
                "test",
                true
            )
        );
        assert!(a.is_ok(), "{:?}", a.err());
        assert!(b.is_ok(), "{:?}", b.err());
        assert!(p.stats().fallback_jobs >= 2);
        p.shutdown().await;
    }

    // ── P0-01 顺序屏障 ────────────────────────────────────────

    fn seq_ev(session: &str, run: &str, state: &str, seq: u64) -> AgentEvent {
        let mut e = ev(session, run, state);
        e.ingest_seq = Some(seq);
        e
    }

    fn job_of(events: Vec<(AgentEvent, Transport)>) -> Job {
        Job {
            events,
            ack: None,
            enqueued: Instant::now(),
            _permits: None,
            shutdown: None,
            wake: false,
        }
    }

    fn recorded_seqs(sink: &FakeSink) -> Vec<u64> {
        sink.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.ingest_seq.unwrap_or(0))
            .collect()
    }

    fn temp_spool_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-pipeline-spool-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 持续失败：主批量与逐作业回退都失败，用于验证「能落盘就暂存，不能就如实计未保存」。
    struct FailingSink;

    impl IngestSink for FailingSink {
        fn commit_events(
            &self,
            _items: &[(AgentEvent, Transport)],
        ) -> AppResult<Vec<IngestOutcome>> {
            Err(AppError::Agent("模拟数据库持续失败".into()))
        }
        fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
    }

    struct SlowSink {
        events: Mutex<Vec<AgentEvent>>,
        delay: Duration,
    }

    impl SlowSink {
        fn new(delay: Duration) -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Vec::new()),
                delay,
            })
        }
    }

    impl IngestSink for SlowSink {
        fn commit_events(
            &self,
            items: &[(AgentEvent, Transport)],
        ) -> AppResult<Vec<IngestOutcome>> {
            std::thread::sleep(self.delay);
            self.events
                .lock()
                .unwrap()
                .extend(items.iter().map(|(e, _)| e.clone()));
            Ok(items
                .iter()
                .enumerate()
                .map(|(i, (e, _))| IngestOutcome {
                    run_row_id: format!("run-{}", i),
                    session_row_id: format!("sess-{}", e.session_id),
                    state: AgentState::parse(&e.state).unwrap_or(AgentState::Running),
                    prev_state: None,
                    deduplicated: false,
                    late: false,
                    notification: None,
                    origin: EventOrigin::Real,
                })
                .collect())
        }
        fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
    }

    #[tokio::test]
    async fn process_sorts_main_queue_and_merge_buffer_by_ingest_seq() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        let newer = job_of(vec![(seq_ev("s1", "rA", "running", 500), Transport::Http)]);
        let buffered = vec![
            (seq_ev("s1", "rC", "waiting", 300), Transport::File),
            (seq_ev("s1", "rB", "running", 100), Transport::Http),
        ];
        assert!(p.process(vec![newer], buffered).await);
        assert_eq!(
            recorded_seqs(&sink),
            vec![100, 300, 500],
            "主队列与合并缓冲必须按受理序号统一排序，而非先清缓冲"
        );
    }

    #[tokio::test]
    async fn critical_state_is_a_coalescing_barrier() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        let jobs = vec![
            job_of(vec![(seq_ev("s1", "r1", "running", 100), Transport::Http)]),
            job_of(vec![(seq_ev("s1", "r1", "waiting", 200), Transport::Http)]),
            job_of(vec![(seq_ev("s1", "r1", "running", 300), Transport::Http)]),
        ];
        assert!(p.process(jobs, Vec::new()).await);
        let states: Vec<String> = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.state.clone())
            .collect();
        assert_eq!(states, vec!["running", "waiting", "running"]);
        assert_eq!(
            p.stats().events_merged,
            0,
            "关键状态前后不得跨屏障合并进度事件"
        );
    }

    #[tokio::test]
    async fn thousand_running_burst_keeps_waiting_and_respects_barrier() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        let mut jobs = Vec::new();
        for i in 1..=500u64 {
            jobs.push(job_of(vec![(
                seq_ev("s1", "r1", "running", i),
                Transport::Http,
            )]));
        }
        jobs.push(job_of(vec![(
            seq_ev("s1", "r1", "waiting", 501),
            Transport::Http,
        )]));
        for i in 502..=1001u64 {
            jobs.push(job_of(vec![(
                seq_ev("s1", "r1", "running", i),
                Transport::Http,
            )]));
        }
        assert!(p.process(jobs, Vec::new()).await);
        let got = sink.events.lock().unwrap().clone();
        assert_eq!(got.len(), 3, "两侧进度各收敛为 1 条，waiting 必须保留");
        assert_eq!(got[0].state, "running");
        assert_eq!(got[0].ingest_seq, Some(500));
        assert_eq!(got[1].state, "waiting");
        assert_eq!(got[1].ingest_seq, Some(501));
        assert_eq!(got[2].state, "running");
        assert_eq!(got[2].ingest_seq, Some(1001));
    }

    #[tokio::test]
    async fn newest_waiting_wins_after_progress_burst() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        let mut jobs = Vec::new();
        for i in 1..=1000u64 {
            jobs.push(job_of(vec![(
                seq_ev("s1", "r1", "running", i),
                Transport::Http,
            )]));
        }
        jobs.push(job_of(vec![(
            seq_ev("s1", "r1", "waiting", 2000),
            Transport::Http,
        )]));
        assert!(p.process(jobs, Vec::new()).await);
        let got = sink.events.lock().unwrap().clone();
        assert_eq!(got.len(), 2);
        assert_eq!(
            got.last().unwrap().state,
            "waiting",
            "受理序号最新的关键状态必须最后落库"
        );
    }

    #[tokio::test]
    async fn drain_merged_handles_all_batches_in_seq_order() {
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.batch_size = 2;
        let p = IngestPipeline::new(sink.clone(), cfg);
        {
            let mut map = p.shared.merge.lock().unwrap();
            for i in 1..=7u64 {
                let run = format!("r{}", i);
                let e = seq_ev("s1", &run, "running", i);
                map.insert(coalesce_key(&e, Transport::Http), (e, Transport::Http));
            }
        }
        let batches = p.drain_merged(usize::MAX).await;
        assert_eq!(batches, 4, "7 条缓冲按每批 2 条应分 4 批全部排空");
        assert_eq!(recorded_seqs(&sink), (1..=7).collect::<Vec<_>>());
        assert_eq!(p.shared.merge_len(), 0);
    }

    #[tokio::test]
    async fn shutdown_drains_every_merge_batch() {
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.batch_size = 100;
        let p = IngestPipeline::new(sink.clone(), cfg);
        {
            let mut map = p.shared.merge.lock().unwrap();
            for i in 1..=450u64 {
                let run = format!("r{}", i);
                let e = seq_ev("s1", &run, "running", i);
                map.insert(coalesce_key(&e, Transport::Http), (e, Transport::Http));
            }
        }
        p.start_tokio();
        let report = p.shutdown().await;
        assert_eq!(p.shared.merge_len(), 0, "退出时必须排空全部合并批次");
        assert_eq!(
            sink.events.lock().unwrap().len(),
            450,
            "450 条缓冲（超过 3 个 batch）必须全部写入"
        );
        assert!(!p.stats().running);
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(report.merge_events_at_start, 450);
        assert_eq!(report.unfinished_events, 0);
    }

    #[tokio::test]
    async fn full_queue_alternating_critical_events_are_not_lost() {
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.queue_capacity = 1;
        cfg.merge_buffer_capacity = 8;
        cfg.coalesce_window = Duration::from_millis(20);
        cfg.enqueue_timeout = Duration::from_secs(2);
        cfg.ack_timeout = Duration::from_secs(5);
        let p = IngestPipeline::new(sink.clone(), cfg);
        p.start_tokio();
        for i in 0..10 {
            p.submit(
                vec![seq_ev("s1", "r1", "running", 100 + i as u64)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .expect("非关键进度可入队或显式合并");
            let receipt = p
                .submit(
                    vec![seq_ev("s1", "r1", "waiting", 200 + i as u64)],
                    Transport::Http,
                    "test",
                    true,
                )
                .await
                .unwrap_or_else(|e| panic!("第 {} 次关键事件不得丢失: {:?}", i, e));
            assert_eq!(receipt.accepted, 1);
        }
        p.flush().await.unwrap();
        let waiting = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.state == "waiting")
            .count();
        assert_eq!(waiting, 10, "队列满交替场景下关键事件必须全部落库");
        p.shutdown().await;
    }

    #[tokio::test]
    async fn http_and_file_progress_keep_global_order() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        let job = job_of(vec![(seq_ev("s1", "r2", "running", 200), Transport::Http)]);
        let buffered = vec![
            (seq_ev("s1", "r1", "running", 100), Transport::File),
            (seq_ev("s1", "r3", "running", 300), Transport::Http),
        ];
        assert!(p.process(vec![job], buffered).await);
        let got = sink.events.lock().unwrap().clone();
        let seqs: Vec<u64> = got.iter().map(|e| e.ingest_seq.unwrap()).collect();
        assert_eq!(seqs, vec![100, 200, 300]);
        let runs: Vec<Option<String>> = got.iter().map(|e| e.run_id.clone()).collect();
        assert_eq!(
            runs,
            vec![
                Some("r1".to_string()),
                Some("r2".to_string()),
                Some("r3".to_string())
            ],
            "跨通道进度必须按受理序号保持全局顺序"
        );
    }

    #[tokio::test]
    async fn merge_buffer_full_samples_only_noncritical_and_keeps_critical() {
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.queue_capacity = 1;
        cfg.merge_buffer_capacity = 4;
        cfg.enqueue_timeout = Duration::from_secs(2);
        let p = IngestPipeline::new(sink.clone(), cfg);
        // 不启动消费者：队列占满后，进度事件进入合并缓冲，超出容量显式采样
        let _ = p
            .submit(
                vec![seq_ev("s1", "r0", "waiting", 1)],
                Transport::Http,
                "test",
                false,
            )
            .await;
        for i in 0..5u64 {
            let _ = p
                .submit(
                    vec![seq_ev("s1", &format!("r{}", i + 1), "running", i + 2)],
                    Transport::Http,
                    "test",
                    false,
                )
                .await;
        }
        assert!(p.stats().events_sampled >= 1, "超出合并容量必须显式采样");
        p.start_tokio();
        let receipt = p
            .submit(
                vec![seq_ev("s1", "r9", "waiting", 99)],
                Transport::Http,
                "test",
                true,
            )
            .await
            .expect("关键事件不得因采样被丢弃");
        assert_eq!(receipt.accepted, 1);
        p.flush().await.unwrap();
        let waiting = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.state == "waiting")
            .count();
        assert_eq!(waiting, 2, "关键事件必须全部保留");
        p.shutdown().await;
    }

    // ── P0-02 退出排空生命周期 ────────────────────────────────

    #[tokio::test]
    async fn shutdown_reports_stopped_and_drains_queued_jobs() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        for i in 0..10u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert!(!report.timed_out);
        assert_eq!(report.unfinished_events, 0);
        assert!(report.drained_events >= 10);
        assert_eq!(sink.events.lock().unwrap().len(), 10);
        assert_eq!(p.stats().lifecycle, "stopped");
    }

    #[tokio::test]
    async fn double_shutdown_is_safe_and_idempotent() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        for i in 0..5u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        let first = p.shutdown().await;
        assert_eq!(first.lifecycle, "stopped");
        assert!(!first.already_stopped);
        let second = p.shutdown().await;
        assert!(second.already_stopped);
        assert_eq!(second.lifecycle, "stopped");
        assert_eq!(second.unfinished_events, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn submit_after_shutdown_is_rejected() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        p.shutdown().await;
        let err = p
            .submit(
                vec![seq_ev("s1", "r1", "waiting", 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Unavailable(_)));
    }

    #[tokio::test]
    async fn shutdown_waits_for_inflight_critical_submission() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        let p2 = p.clone();
        let submit = tokio::spawn(async move {
            p2.submit(
                vec![seq_ev("s1", "r1", "waiting", 1)],
                Transport::Http,
                "test",
                true,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let report = p.shutdown().await;
        let result = submit.await.unwrap();
        assert!(result.is_ok(), "在途关键提交必须完成: {:?}", result.err());
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(report.unfinished_events, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn shutdown_timeout_reports_unfinished_without_cancelling_write() {
        let sink = SlowSink::new(Duration::from_millis(400));
        let mut cfg = config();
        cfg.shutdown_timeout = Duration::from_millis(100);
        cfg.coalesce_window = Duration::from_millis(10);
        let p = IngestPipeline::new(sink.clone(), cfg);
        p.start_tokio();
        p.submit(
            vec![seq_ev("s1", "r1", "waiting", 1)],
            Transport::Http,
            "test",
            false,
        )
        .await
        .unwrap();
        let first = p.shutdown().await;
        assert!(first.timed_out, "慢写入应触发超时报告: {:?}", first);
        assert!(first.unfinished_events >= 1, "超时必须报告未完成数量");
        assert_eq!(first.lifecycle, "draining");

        // 超时不代表取消：写入继续完成，后续调用能看到 stopped 且未完成归零
        let mut last = first.clone();
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            last = p.shutdown().await;
            if last.lifecycle == "stopped" {
                break;
            }
        }
        assert_eq!(last.lifecycle, "stopped");
        assert_eq!(last.unfinished_events, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 1, "写入不得被取消");
    }

    #[tokio::test]
    async fn shutdown_with_no_events_finishes_quickly() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        let started = Instant::now();
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(report.events_processed, 0);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "空管线退出不得耗时 {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn shutdown_drains_queued_jobs_before_merge() {
        // 关闭时通道里仍有 12 个已受理作业：必须全部写入，而不是只处理一批。
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        for i in 0..12u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        p.start_tokio();
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(report.unfinished_events, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 12);
    }

    #[tokio::test]
    async fn lifecycle_moves_from_running_to_stopped() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        assert_eq!(p.stats().lifecycle, "running");
        p.start_tokio();
        assert_eq!(p.stats().lifecycle, "running");
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(p.stats().lifecycle, "stopped");
        assert!(!p.stats().running);
    }

    #[tokio::test]
    async fn shutdown_drains_500_queued_events() {
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.queue_capacity = 512;
        cfg.batch_size = 100;
        let p = IngestPipeline::new(sink.clone(), cfg);
        for i in 0..500u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        p.start_tokio();
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(report.unfinished_events, 0);
        assert!(report.queued_events_at_start >= 500);
        assert_eq!(sink.events.lock().unwrap().len(), 500);
    }

    #[tokio::test]
    async fn submissions_racing_shutdown_are_committed_or_cleanly_rejected() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        let mut handles = Vec::new();
        for i in 0..20u64 {
            let p2 = p.clone();
            handles.push(tokio::spawn(async move {
                p2.submit(
                    vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                    Transport::Http,
                    "race",
                    false,
                )
                .await
                .is_ok()
            }));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        let report = p.shutdown().await;
        let mut accepted = 0usize;
        for h in handles {
            if h.await.unwrap() {
                accepted += 1;
            }
        }
        let committed = sink.events.lock().unwrap().len();
        assert_eq!(
            committed, accepted,
            "被接受的提交必须全部落库，被拒绝的不得伪造成功"
        );
        assert_eq!(report.unfinished_events, 0);
    }

    // ── P1-03 退出超时事件可靠恢复 ─────────────────────────────

    #[tokio::test]
    async fn exit_with_spool_configured_and_healthy_sink_does_not_spool() {
        let sink = FakeSink::new();
        let dir = temp_spool_dir("healthy");
        let mut cfg = config();
        cfg.queue_capacity = 512;
        cfg.spool_dir = Some(dir.clone());
        let p = IngestPipeline::new(sink.clone(), cfg);
        p.start_tokio();
        for i in 0..500u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert!(!report.timed_out, "正常退出不应误报超时");
        assert_eq!(report.spooled_events, 0, "正常排空不得写暂存文件");
        assert_eq!(report.unsaved_events, 0);
        assert_eq!(report.spool_files, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 500);
        assert!(crate::agents::spool::Spool::new(dir.clone())
            .pending_files()
            .is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn exit_timeout_spools_unwritten_events_atomically() {
        // 慢写入（模拟延迟 SQLite）+ 极短退出时限：当前事务写完即停，剩余事件必须原子暂存。
        let sink = SlowSink::new(Duration::from_millis(400));
        let dir = temp_spool_dir("timeout");
        let mut cfg = config();
        cfg.queue_capacity = 64;
        cfg.batch_size = 1;
        cfg.coalesce_window = Duration::from_millis(5);
        cfg.shutdown_timeout = Duration::from_millis(80);
        cfg.spool_timeout = Duration::from_secs(5);
        cfg.spool_dir = Some(dir.clone());
        let p = IngestPipeline::new(sink.clone(), cfg);
        p.start_tokio();
        for i in 0..20u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        let started = Instant::now();
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert!(
            report.timed_out,
            "超过退出时限必须如实标记超时: {:?}",
            report
        );
        assert!(
            report.spooled_events > 0,
            "未写入事件必须暂存: {:?}",
            report
        );
        assert_eq!(report.unsaved_events, 0);
        assert_eq!(report.unfinished_events, 0);
        assert!(report.recovery.contains("暂存"), "{}", report.recovery);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "退出必须受硬时限约束，实际 {:?}",
            started.elapsed()
        );

        let spool = crate::agents::spool::Spool::new(dir.clone());
        let files = spool.pending_files();
        assert_eq!(files.len(), report.spool_files);
        let mut read = Vec::new();
        for f in &files {
            read.extend(crate::agents::spool::Spool::read_file(f).unwrap());
        }
        assert_eq!(read.len(), report.spooled_events);
        assert!(
            read.iter().all(|(e, _)| e.ingest_seq.is_none()),
            "暂存重放必须重新分配受理序号"
        );
        let committed = sink.events.lock().unwrap().len();
        assert_eq!(
            committed + read.len(),
            20,
            "已写入 + 已暂存必须覆盖全部被受理事件"
        );

        let second = p.shutdown().await;
        assert!(second.already_stopped);
        assert_eq!(second.spooled_events, report.spooled_events);
        assert_eq!(second.spool_files, report.spool_files);
        assert_eq!(second.unsaved_events, 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn spool_write_failure_reports_unsaved_events_honestly() {
        // 暂存目录被普通文件占用 → 写盘必然失败：绝不把未落盘事件谎报为已保存。
        let sink = SlowSink::new(Duration::from_millis(400));
        let dir = temp_spool_dir("unsaved");
        let blocker = dir.join("blocked");
        std::fs::write(&blocker, b"x").unwrap();
        let mut cfg = config();
        cfg.queue_capacity = 64;
        cfg.batch_size = 1;
        cfg.coalesce_window = Duration::from_millis(5);
        cfg.shutdown_timeout = Duration::from_millis(80);
        cfg.spool_timeout = Duration::from_secs(2);
        cfg.spool_dir = Some(blocker.join("spool"));
        let p = IngestPipeline::new(sink.clone(), cfg);
        p.start_tokio();
        for i in 0..10u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        let report = p.shutdown().await;
        assert!(report.timed_out);
        assert_eq!(report.spooled_events, 0, "写盘失败不得计为已暂存");
        assert!(
            report.unsaved_events > 0,
            "未落盘事件必须计入 unsaved: {:?}",
            report
        );
        assert!(report.spool_error.is_some(), "必须暴露暂存失败原因");
        assert!(
            report.recovery.contains("未写入"),
            "恢复说明必须要求调用方重试: {}",
            report.recovery
        );
        assert!(p.stats().spool_failures > 0);
        assert_eq!(p.stats().events_unsaved as usize, report.unsaved_events);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn fallback_failure_spools_events_for_restart_replay() {
        let sink: Arc<FailingSink> = Arc::new(FailingSink);
        let dir = temp_spool_dir("fallback");
        let mut cfg = config();
        cfg.spool_dir = Some(dir.clone());
        let p = IngestPipeline::new(sink.clone(), cfg);
        p.start_tokio();
        let err = p
            .submit(
                vec![seq_ev("s1", "r1", "waiting", 1)],
                Transport::Http,
                "test",
                true,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Agent(_)),
            "回退失败必须向调用方返回错误: {:?}",
            err
        );
        p.flush().await.ok();
        let files = crate::agents::spool::Spool::new(dir.clone()).pending_files();
        assert_eq!(files.len(), 1, "回退失败事件必须落盘暂存");
        let read = crate::agents::spool::Spool::read_file(&files[0]).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].0.run_id.as_deref(), Some("r1"));
        assert_eq!(p.stats().events_spooled, 1);
        assert_eq!(p.stats().events_unsaved, 0);
        let report = p.shutdown().await;
        assert_eq!(report.spool_files, 1, "退出报告必须披露待重放暂存文件");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn exit_drains_3000_events_spanning_queue_and_merge_buffer() {
        // 消费者未启动：1024 个作业占满主队列，其余 1976 个不同轮次键进入合并缓冲。
        let sink = FakeSink::new();
        let mut cfg = config();
        cfg.queue_capacity = 1024;
        cfg.merge_buffer_capacity = 4096;
        cfg.batch_size = 200;
        let p = IngestPipeline::new(sink.clone(), cfg);
        for i in 0..3000u64 {
            p.submit(
                vec![seq_ev("s1", &format!("r{}", i), "running", i + 1)],
                Transport::Http,
                "test",
                false,
            )
            .await
            .unwrap();
        }
        assert!(p.stats().merge_buffer >= 1000, "合并缓冲应承接超量事件");
        p.start_tokio();
        let report = p.shutdown().await;
        assert_eq!(report.lifecycle, "stopped");
        assert_eq!(report.unfinished_events, 0);
        assert_eq!(report.spooled_events, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 3000);
    }

    #[tokio::test]
    async fn http_submit_in_flight_at_exit_is_committed_or_retryable() {
        // HTTP 请求与退出并发：被接受的事件必须落库，失败必须是可重试错误，不得静默丢弃。
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        let mut handles = Vec::new();
        for i in 0..50u64 {
            let p2 = p.clone();
            handles.push(tokio::spawn(async move {
                p2.submit(
                    vec![seq_ev("s1", &format!("r{}", i), "waiting", i + 1)],
                    Transport::Http,
                    "http",
                    true,
                )
                .await
            }));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        let report = p.shutdown().await;
        let mut accepted = 0usize;
        let mut retryable = 0usize;
        for h in handles {
            match h.await.unwrap() {
                Ok(_) => accepted += 1,
                Err(e) => {
                    assert!(
                        matches!(e, AppError::Unavailable(_) | AppError::Overloaded(_)),
                        "退出期间的 HTTP 失败必须可重试: {:?}",
                        e
                    );
                    retryable += 1;
                }
            }
        }
        let committed = sink.events.lock().unwrap().len();
        assert_eq!(committed, accepted, "已确认的 HTTP 提交必须全部落库");
        assert_eq!(report.unfinished_events, 0);
        assert_eq!(accepted + retryable, 50);
    }

    #[tokio::test]
    async fn both_http_and_file_transports_stop_with_pipeline() {
        let sink = FakeSink::new();
        let p = IngestPipeline::new(sink.clone(), config());
        p.start_tokio();
        p.shutdown().await;
        for transport in [Transport::Http, Transport::File] {
            let err = p
                .submit(
                    vec![seq_ev("s1", "r1", "waiting", 1)],
                    transport,
                    "adapter",
                    false,
                )
                .await
                .unwrap_err();
            assert!(
                matches!(err, AppError::Unavailable(_)),
                "{:?} 通道关闭后必须拒绝新事件: {:?}",
                transport,
                err
            );
        }
        assert!(sink.events.lock().unwrap().is_empty());
    }
}
