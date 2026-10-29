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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use super::{validate_event, AgentEvent, AgentHub, AgentState, IngestOutcome, Transport};
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
            diagnostics: settings.perf_diagnostics_enabled,
        }
    }

    fn channel_capacity(&self) -> usize {
        self.queue_capacity.clamp(16, 4096)
    }
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
    wake_pending: AtomicBool,
    consumer_alive: AtomicBool,
    merge: Mutex<HashMap<String, (AgentEvent, Transport)>>,
    counters: Counters,
    metrics: Mutex<Metrics>,
    started_at: Instant,
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
        let keys: Vec<String> = map.keys().take(max).cloned().collect();
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
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
        let shared = Arc::new(Shared {
            sink,
            sem: Arc::new(Semaphore::new(config.queue_capacity)),
            config,
            closed: AtomicBool::new(false),
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
        });
        Arc::new(Self {
            tx,
            rx: Mutex::new(Some(rx)),
            shared,
            handle: Mutex::new(None),
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
    fn start_tokio(self: &Arc<Self>) {
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

    pub async fn shutdown(&self) {
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let (tx, rx) = oneshot::channel();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.tx.send(Job::shutdown(tx))).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), rx).await;
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
        events: Vec<AgentEvent>,
        transport: Transport,
        _submitter: &'static str,
        wait: bool,
    ) -> AppResult<SubmitReceipt> {
        if events.is_empty() {
            return Err(AppError::Validation("事件列表为空".into()));
        }
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(AppError::Unavailable("接入管线已关闭".into()));
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
            if self.shared.has_merged() {
                self.shared.wake_pending.store(false, Ordering::Release);
                let buffered = self.shared.take_merged(self.shared.config.batch_size);
                if !buffered.is_empty() {
                    self.process(Vec::new(), buffered).await;
                    continue;
                }
            }
            let first = match rx.recv().await {
                Some(j) => j,
                None => break,
            };
            if let Some(done) = first.shutdown {
                pending_shutdown = Some(done);
                break;
            }
            if first.wake {
                self.shared.wake_pending.store(false, Ordering::Release);
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
        }
        // 退出前冲刷合并缓冲（非关键 running 事件，最多一轮；失败也不阻塞退出）
        if self.shared.has_merged() {
            let buffered = self.shared.take_merged(self.shared.config.batch_size);
            if !buffered.is_empty() {
                self.process(Vec::new(), buffered).await;
            }
        }
        self.shared.consumer_alive.store(false, Ordering::Release);
        if let Some(done) = pending_shutdown {
            let _ = done.send(());
        }
    }

    async fn process(&self, jobs: Vec<Job>, buffered: Vec<(AgentEvent, Transport)>) {
        if jobs.is_empty() && buffered.is_empty() {
            return;
        }
        // 组合并：仅同一轮次键的 running 单事件作业可互相覆盖
        let mut slots: Vec<Option<(AgentEvent, Transport)>> = Vec::new();
        let mut slot_jobs: Vec<Vec<usize>> = Vec::new();
        let mut job_slots: Vec<Vec<usize>> = vec![Vec::new(); jobs.len()];
        let mut running_keys: HashMap<String, usize> = HashMap::new();
        let mut coalesced: u64 = 0;

        for (ji, job) in jobs.iter().enumerate() {
            if job.events.is_empty() {
                continue;
            }
            let single_running = job.events.len() == 1
                && AgentState::parse(&job.events[0].0.state) == Some(AgentState::Running);
            for (ev, transport) in &job.events {
                let key = if single_running {
                    Some(coalesce_key(ev, *transport))
                } else {
                    None
                };
                let mut prev_slot: Option<usize> = None;
                if let Some(key) = &key {
                    if let Some(prev) = running_keys.get(key).copied() {
                        if let Some(slot) = slots.get_mut(prev) {
                            if slot.take().is_some() {
                                coalesced += 1;
                                prev_slot = Some(prev);
                            }
                        }
                    }
                }
                let redirect: Vec<usize> = prev_slot
                    .and_then(|prev| slot_jobs.get_mut(prev).map(std::mem::take))
                    .unwrap_or_default();
                let idx = slots.len();
                slots.push(Some((ev.clone(), *transport)));
                slot_jobs.push(vec![ji]);
                job_slots[ji].push(idx);
                if let Some(prev) = prev_slot {
                    for j in redirect {
                        if let Some(list) = job_slots.get_mut(j) {
                            list.retain(|v| *v != prev);
                            list.push(idx);
                        }
                    }
                }
                if let Some(key) = key {
                    running_keys.insert(key, idx);
                }
            }
        }
        for (ev, transport) in &buffered {
            let idx = slots.len();
            slots.push(Some((ev.clone(), *transport)));
            slot_jobs.push(Vec::new());
            let _ = idx;
        }

        // 去掉被覆盖的槽位并重映射
        let mut remap: Vec<usize> = Vec::with_capacity(slots.len());
        let mut items: Vec<(AgentEvent, Transport)> = Vec::with_capacity(slots.len());
        for slot in slots {
            match slot {
                Some(item) => {
                    remap.push(items.len());
                    items.push(item);
                }
                None => remap.push(usize::MAX),
            }
        }
        for list in job_slots.iter_mut() {
            for v in list.iter_mut() {
                *v = if *v == usize::MAX {
                    usize::MAX
                } else {
                    remap[*v]
                };
            }
            list.retain(|v| *v != usize::MAX);
        }
        // 被合并掉的旧作业：把它的确认目标改到最终留存槽位
        // （构建阶段已把旧 slot 索引替换为新 slot 索引，这里只需再重映射）
        if items.is_empty() {
            for job in jobs {
                if let Some(ack) = job.ack {
                    let _ = ack.send(Ok(Vec::new()));
                }
            }
            return;
        }

        let batch_len = items.len();
        self.shared.counters.batches.fetch_add(1, Ordering::Relaxed);
        self.shared
            .counters
            .last_batch_size
            .store(batch_len, Ordering::Relaxed);
        self.shared
            .counters
            .events_processed
            .fetch_add(batch_len as u64, Ordering::Relaxed);
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
        let join = tokio::time::timeout(
            Duration::from_secs(60),
            tokio::task::spawn_blocking(move || {
                let db_started = Instant::now();
                let result = sink.commit_events(&items_for_db);
                let db_elapsed = db_started.elapsed();
                if let Ok(outcomes) = &result {
                    let events: Vec<AgentEvent> =
                        items_for_db.iter().map(|(e, _)| e.clone()).collect();
                    sink.after_batch(&events, outcomes);
                }
                (result, db_elapsed)
            }),
        )
        .await;
        let committed = match join {
            Ok(Ok((result, db_elapsed))) => Some((result, db_elapsed)),
            Ok(Err(e)) => {
                self.shared
                    .counters
                    .commit_failures
                    .fetch_add(1, Ordering::Relaxed);
                Some((
                    Err(AppError::Agent(format!("写入任务异常: {}", e))),
                    Duration::ZERO,
                ))
            }
            Err(_) => {
                self.shared
                    .counters
                    .commit_failures
                    .fetch_add(1, Ordering::Relaxed);
                Some((
                    Err(AppError::Overloaded("数据库写入超时".into())),
                    Duration::ZERO,
                ))
            }
        };
        let (result, db_elapsed) = committed.expect("committed is always Some");
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
                for (ji, job) in jobs.into_iter().enumerate() {
                    if let Some(ack) = job.ack {
                        let outs: Vec<IngestOutcome> = job_slots[ji]
                            .iter()
                            .filter_map(|&i| outcomes.get(i).cloned())
                            .collect();
                        let _ = ack.send(Ok(outs));
                    }
                }
            }
            Err(e) => {
                self.shared
                    .counters
                    .commit_failures
                    .fetch_add(1, Ordering::Relaxed);
                self.fallback_jobs(jobs).await;
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
            }
        }
    }

    /// 单批事务失败时的回退：每个作业独立事务，隔离坏事件，保留单作业原子性。
    async fn fallback_jobs(&self, jobs: Vec<Job>) {
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
                }
                Err(e) => {
                    self.shared
                        .counters
                        .commit_failures
                        .fetch_add(1, Ordering::Relaxed);
                    if let Some(ack) = job.ack {
                        let _ = ack.send(Err(AppError::Agent(format!("写入任务异常: {}", e))));
                    }
                }
            }
        }
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
            submissions: c.submissions.load(Ordering::Relaxed),
            events_received: c.events_received.load(Ordering::Relaxed),
            events_processed: c.events_processed.load(Ordering::Relaxed),
            events_merged: c.events_merged.load(Ordering::Relaxed),
            events_sampled: c.events_sampled.load(Ordering::Relaxed),
            overload_rejects: c.overload_rejects.load(Ordering::Relaxed),
            commit_failures: c.commit_failures.load(Ordering::Relaxed),
            fallback_jobs: c.fallback_jobs.load(Ordering::Relaxed),
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
    pub submissions: u64,
    pub events_received: u64,
    pub events_processed: u64,
    pub events_merged: u64,
    pub events_sampled: u64,
    pub overload_rejects: u64,
    pub commit_failures: u64,
    pub fallback_jobs: u64,
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
}
