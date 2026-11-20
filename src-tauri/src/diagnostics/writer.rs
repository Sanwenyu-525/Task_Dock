//! 诊断日志的单写线程：唯一接触日志文件的地方。
//!
//! 设计要点：
//! - 有界队列 + 固定容量聚合表，内存不随运行时间增长；
//! - 追加写入用 `BufWriter`，按 200ms 批次 flush，绝不对每条日志 `sync_all`；
//! - 轮转、保留清理、清空全部在本线程执行，避免与读线程/其它窗口竞争同一文件；
//! - 任何 IO 失败只更新计数并在 stderr 限流提示，绝不向业务返回错误、绝不 panic；
//! - 本文件只使用 `eprintln!`，不调用 `tracing`（防止日志系统自身递归）。

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{
    now_iso, Counters, DiagLevel, DiagStatus, DiagnosticEvent, Diagnostics, WriterConfig,
    ACTIVE_FILE, ARCHIVE_PREFIX,
};

/// 写线程消息。
pub(crate) enum Msg {
    Event(Box<DiagnosticEvent>),
    Flush(SyncSender<()>),
    Clear {
        ack: SyncSender<Result<u64, String>>,
        /// 调用方超时后置位：写线程在开始删除前检查，避免"提示失败却删了"。
        cancelled: Arc<AtomicBool>,
    },
    Shutdown,
}

/// 批次 flush 间隔：最多丢 200ms 的尾部日志，换来不做逐条写系统调用。
const FLUSH_INTERVAL: Duration = Duration::from_millis(200);
/// 写失败后的退避时长：避免磁盘满/权限错误时形成错误风暴。
const ERROR_BACKOFF: Duration = Duration::from_secs(60);
/// stderr 提示的最小间隔（日志系统故障本身也要限流）。
const STDERR_INTERVAL: Duration = Duration::from_secs(30);
/// 轮转重试基础退避：rename 失败（文件被占用等）后至少等这么久再试，
/// 重试窗口内**跳过 rotate 判断**，消除「每写一条就重试一次 rename」的失败风暴。
/// （测试构建缩短到 500ms，保证故障注入测试可在秒级完成；生产行为不变。）
#[cfg(not(test))]
const ROTATE_RETRY_BACKOFF: Duration = Duration::from_secs(60);
#[cfg(test)]
const ROTATE_RETRY_BACKOFF: Duration = Duration::from_millis(500);
/// 轮转重试退避上限（指数退避封顶）：60s → 120s → 240s → … 最长 16 分钟。
#[cfg(not(test))]
const ROTATE_RETRY_BACKOFF_MAX: Duration = Duration::from_secs(16 * 60);
#[cfg(test)]
const ROTATE_RETRY_BACKOFF_MAX: Duration = Duration::from_millis(4000);
/// 活动文件绝对硬上限：轮转长期失败时活动文件增长到此值后**整体停止写入**
/// （只计数），直到轮转恢复。64 MB 远大于正常的 5 MB 轮转阈值，
/// 足以保留完整故障现场，又不会把磁盘撑爆。
pub(crate) const ACTIVE_HARD_CAP_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) fn run(
    dir: PathBuf,
    cfg: WriterConfig,
    counters: Arc<Counters>,
    rx: Receiver<Msg>,
    diag: Arc<Diagnostics>,
) {
    let mut writer = Writer::new(dir, cfg, counters, diag);
    writer.startup();
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(Msg::Event(event)) => writer.push(*event),
            Ok(Msg::Flush(ack)) => {
                writer.flush_pending();
                writer.flush_file();
                let _ = ack.send(());
            }
            Ok(Msg::Clear { ack, cancelled }) => {
                // 取消检查放在清理前：调用方超时后不再执行任何文件删除。
                let result = if cancelled.load(Ordering::Acquire) {
                    Err(super::CLEAR_CANCELLED.to_string())
                } else {
                    writer.clear(Some(&cancelled))
                };
                let _ = ack.send(result);
            }
            Ok(Msg::Shutdown) => {
                writer.finish();
                break;
            }
            Err(RecvTimeoutError::Timeout) => writer.tick(),
            Err(RecvTimeoutError::Disconnected) => {
                writer.finish();
                break;
            }
        }
    }
}

struct Writer {
    dir: PathBuf,
    cfg: WriterConfig,
    counters: Arc<Counters>,
    diag: Arc<Diagnostics>,
    out: Option<BufWriter<File>>,
    bytes_in_file: u64,
    dirty: bool,
    last_flush: Instant,
    last_stderr: Option<Instant>,
    retry_after: Option<Instant>,
    agg: Aggregator,
    rotate_seq: u32,
    /// 轮转降级：rename 失败后置位，重试成功后清除。
    rotate_degraded: bool,
    /// 连续轮转失败次数（指数退避依据；恢复后归零，计数器里的历史不清零）。
    rotate_failures: u32,
    /// 下次允许重试轮转的时间（`None` = 立即可试；降级窗口内跳过 rotate 判断）。
    rotate_retry_at: Option<Instant>,
}

impl Writer {
    fn new(
        dir: PathBuf,
        cfg: WriterConfig,
        counters: Arc<Counters>,
        diag: Arc<Diagnostics>,
    ) -> Self {
        let agg = Aggregator::new(cfg.agg_capacity, cfg.agg_window);
        let now = Instant::now();
        Self {
            dir,
            cfg,
            counters,
            diag,
            out: None,
            bytes_in_file: 0,
            dirty: false,
            last_flush: now,
            last_stderr: None,
            retry_after: None,
            agg,
            rotate_seq: 0,
            rotate_degraded: false,
            rotate_failures: 0,
            rotate_retry_at: None,
        }
    }

    fn startup(&mut self) {
        if let Err(e) = std::fs::create_dir_all(&self.dir) {
            self.fail_io(format!("创建日志目录失败: {e}"), &e);
            self.diag.set_disabled(true);
            return;
        }
        self.prune();
        if let Err(e) = self.open_active() {
            self.fail_io(format!("打开活动日志失败: {e}"), &e);
        }
    }

    fn open_active(&mut self) -> std::io::Result<()> {
        let path = self.dir.join(ACTIVE_FILE);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.bytes_in_file = file.metadata().map(|m| m.len()).unwrap_or(0);
        // 64 KiB 缓冲：一次系统调用可容纳数十条事件，同时限制崩溃时未落盘的尾量。
        self.out = Some(BufWriter::with_capacity(64 * 1024, file));
        self.diag.set_disabled(false);
        Ok(())
    }

    /// 写入一条事件（先经过聚合决策：重复的 WARN/ERROR 可能被抑制）。
    fn push(&mut self, event: DiagnosticEvent) {
        let now = Instant::now();
        for item in self.agg.observe(event, now) {
            if item.event == "aggregated" {
                self.counters
                    .aggregated
                    .fetch_add(u64::from(item.count), Ordering::Relaxed);
            }
            self.write_line(&item);
        }
    }

    fn write_line(&mut self, event: &DiagnosticEvent) {
        if self
            .retry_after
            .map(|at| Instant::now() < at)
            .unwrap_or(false)
        {
            // 磁盘/权限错误退避期内直接丢弃，避免错误风暴；已计入 dropped。
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let mut line = match serde_json::to_string(event) {
            Ok(text) => text,
            Err(e) => {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                self.fail(format!("诊断事件序列化失败: {e}"));
                return;
            }
        };
        line.push('\n');

        if self.out.is_none() {
            if let Err(e) = self.open_active() {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                self.fail_io(format!("重新打开活动日志失败: {e}"), &e);
                self.retry_after = Some(Instant::now() + ERROR_BACKOFF);
                return;
            }
        }

        // 轮转在写入前判断，保证一行不会跨文件。
        // 降级期内按退避窗口节流：窗口未到则跳过 rotate 判断，
        // 消除「每写一条就重试一次 rename」的失败风暴。
        let exceeds_limit = self.bytes_in_file > 0
            && self
                .bytes_in_file
                .saturating_add(line.len() as u64)
                > self.cfg.max_file_bytes;
        if exceeds_limit && self.rotate_retry_due() {
            self.rotate();
        }

        // 降级写入策略：低等级事件计数丢弃以减缓增长；达到硬上限后整体停止
        // 写入（只计数），直到轮转恢复。任何分支都不阻塞、不 panic。
        if self.rotate_degraded
            && degraded_should_drop(event.level, self.bytes_in_file, line.len() as u64)
        {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        let Some(out) = self.out.as_mut() else {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        match out.write_all(line.as_bytes()) {
            Ok(()) => {
                self.bytes_in_file = self.bytes_in_file.saturating_add(line.len() as u64);
                self.counters.written.fetch_add(1, Ordering::Relaxed);
                self.dirty = true;
            }
            Err(e) => {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                self.out = None;
                self.fail_io(format!("写入诊断日志失败: {e}"), &e);
                self.retry_after = Some(Instant::now() + ERROR_BACKOFF);
            }
        }
    }

    fn flush_file(&mut self) {
        if !self.dirty {
            return;
        }
        if let Some(out) = self.out.as_mut() {
            match out.flush() {
                Ok(()) => {
                    self.dirty = false;
                    self.last_flush = Instant::now();
                }
                Err(e) => {
                    self.out = None;
                    self.dirty = false;
                    self.fail_io(format!("刷新诊断日志失败: {e}"), &e);
                    self.retry_after = Some(Instant::now() + ERROR_BACKOFF);
                }
            }
        }
    }

    /// 刷出所有待写内容（包括聚合表的摘要行）。
    fn flush_pending(&mut self) {
        let now = Instant::now();
        for summary in self.agg.drain_expired(now, true) {
            self.counters
                .aggregated
                .fetch_add(u64::from(summary.count), Ordering::Relaxed);
            self.write_line(&summary);
        }
    }

    fn tick(&mut self) {
        let now = Instant::now();
        for summary in self.agg.drain_expired(now, false) {
            self.counters
                .aggregated
                .fetch_add(u64::from(summary.count), Ordering::Relaxed);
            self.write_line(&summary);
        }
        if self.dirty && now.duration_since(self.last_flush) >= FLUSH_INTERVAL {
            self.flush_file();
        }
    }

    fn rotate(&mut self) {
        self.flush_file();
        self.out = None;
        let active = self.dir.join(ACTIVE_FILE);
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let mut target = self.dir.join(format!(
            "{ARCHIVE_PREFIX}{stamp}-{:03}.jsonl",
            self.rotate_seq
        ));
        while target.exists() && self.rotate_seq < 9999 {
            self.rotate_seq = self.rotate_seq.saturating_add(1);
            target = self.dir.join(format!(
                "{ARCHIVE_PREFIX}{stamp}-{:03}.jsonl",
                self.rotate_seq
            ));
        }
        self.rotate_seq = self.rotate_seq.saturating_add(1);
        match std::fs::rename(&active, &target) {
            Ok(()) => {
                self.counters.rotations.fetch_add(1, Ordering::Relaxed);
                if self.rotate_degraded {
                    // 轮转恢复：退出降级状态，恢复正常轮转（文件重新可用）。
                    self.rotate_degraded = false;
                    self.rotate_failures = 0;
                    self.rotate_retry_at = None;
                    self.diag.record(
                        DiagnosticEvent::new(DiagLevel::Info, "diagnostics", "rotate", "recovered")
                            .with_message("日志轮转已恢复"),
                    );
                }
            }
            Err(e) => {
                // rename 失败（文件被占用等）进入降级：按指数退避窗口重试，窗口内
                // 继续追加（低等级事件丢弃、硬上限兜底），绝不阻塞写入线程。
                self.rotate_degraded = true;
                self.rotate_failures = self.rotate_failures.saturating_add(1);
                let backoff = self.rotate_backoff();
                self.rotate_retry_at = Some(Instant::now() + backoff);
                self.counters.rotate_failures.fetch_add(1, Ordering::Relaxed);
                self.fail_io(
                    format!(
                        "日志轮转失败（进入降级，{} 后重试）: {e}",
                        format_duration_secs(backoff)
                    ),
                    &e,
                );
            }
        }
        if let Err(e) = self.open_active() {
            self.fail_io(format!("轮转后重开活动日志失败: {e}"), &e);
            self.out = None;
            self.retry_after = Some(Instant::now() + ERROR_BACKOFF);
            return;
        }
        self.prune();
    }

    /// 连续轮转失败后的重试退避：60s → 120s → 240s → …（指数，封顶 16 分钟）。
    fn rotate_backoff(&self) -> Duration {
        let shift = self.rotate_failures.saturating_sub(1).min(4);
        ROTATE_RETRY_BACKOFF
            .saturating_mul(1u32 << shift)
            .min(ROTATE_RETRY_BACKOFF_MAX)
    }

    /// 是否到了重试轮转的时间（非降级状态恒为 true，行为与旧逻辑一致）。
    fn rotate_retry_due(&self) -> bool {
        self.rotate_retry_at
            .map(|at| Instant::now() >= at)
            .unwrap_or(true)
    }

    /// 保留策略：时间维度 + 归档数量上限 + 目录总字节上限，删最旧的归档。
    ///
    /// 三个维度互补：
    /// - **时间**（`max_age_days`）：防「低频使用时目录几个月不动，总量上限永远碰不到」；
    /// - **数量**（`max_archive_files`）：防归档个数无限增长；
    /// - **容量**（`max_total_bytes`）：防单次大量写入把磁盘吃满。
    fn prune(&mut self) {
        let mut archives = archive_files(&self.dir);
        // 新的在前。
        archives.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        let mut total: u64 = archives.iter().map(|(_, _, bytes)| *bytes).sum::<u64>()
            + std::fs::metadata(self.dir.join(ACTIVE_FILE))
                .map(|m| m.len())
                .unwrap_or(0);

        // 1) 时间维度：过期归档先删（最旧的一批在队尾）。`max_age_days = 0` 表示不启用。
        let cutoff = if self.cfg.max_age_days == 0 {
            None
        } else {
            Some(
                std::time::SystemTime::now()
                    .checked_sub(Duration::from_secs(
                        self.cfg.max_age_days.saturating_mul(86_400),
                    ))
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
        };
        loop {
            let expired = match (cutoff, archives.last()) {
                (Some(cutoff), Some((_, modified, _))) => *modified < cutoff,
                _ => false,
            };
            if !expired {
                break;
            }
            let Some((path, _, bytes)) = archives.pop() else {
                break;
            };
            match std::fs::remove_file(&path) {
                Ok(()) => total = total.saturating_sub(bytes),
                Err(e) => {
                    self.fail_io(format!("删除过期归档失败: {e}"), &e);
                    // 目录里还有删不掉的文件时不再继续尝试，留给下次启动。
                    break;
                }
            }
        }

        // 2) 归档数量上限。
        while archives.len() > self.cfg.max_archive_files {
            let Some((path, _, bytes)) = archives.pop() else {
                break;
            };
            match std::fs::remove_file(&path) {
                Ok(()) => total = total.saturating_sub(bytes),
                Err(e) => {
                    self.fail_io(format!("删除过期归档失败: {e}"), &e);
                    // 目录里还有删不掉的文件时不再继续尝试，留给下次启动。
                    break;
                }
            }
        }
        // 3) 目录总字节上限。
        while total > self.cfg.max_total_bytes && !archives.is_empty() {
            let Some((path, _, bytes)) = archives.pop() else {
                break;
            };
            match std::fs::remove_file(&path) {
                Ok(()) => total = total.saturating_sub(bytes),
                Err(e) => {
                    self.fail_io(format!("按容量删除归档失败: {e}"), &e);
                    break;
                }
            }
        }
    }

    /// 清空历史：删除全部归档并截断活动文件。只处理本模块命名规则的文件。
    fn clear(&mut self, cancelled: Option<&AtomicBool>) -> Result<u64, String> {
        let stop = || {
            cancelled
                .map(|flag| flag.load(Ordering::Acquire))
                .unwrap_or(false)
        };
        if stop() {
            return Err(super::CLEAR_CANCELLED.to_string());
        }
        self.flush_pending();
        self.flush_file();
        self.out = None;
        self.agg.clear();

        let mut removed: u64 = 0;
        let mut failures: Vec<String> = Vec::new();
        for (path, _, bytes) in archive_files(&self.dir) {
            if stop() {
                return Err(super::CLEAR_CANCELLED.to_string());
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed = removed.saturating_add(bytes),
                Err(e) => failures.push(format!(
                    "{}: {e}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                )),
            }
        }
        let active = self.dir.join(ACTIVE_FILE);
        if stop() {
            return Err(super::CLEAR_CANCELLED.to_string());
        }
        if active.exists() {
            let before = std::fs::metadata(&active).map(|m| m.len()).unwrap_or(0);
            match OpenOptions::new().write(true).truncate(true).open(&active) {
                Ok(file) => {
                    drop(file);
                    removed = removed.saturating_add(before);
                }
                Err(e) => failures.push(format!("{ACTIVE_FILE}: {e}")),
            }
        }
        if let Err(e) = self.open_active() {
            return Err(format!("清理后重开活动日志失败: {e}"));
        }
        self.bytes_in_file = 0;
        self.dirty = false;
        if failures.is_empty() {
            Ok(removed)
        } else {
            Err(format!(
                "部分日志未能删除（可能被占用）: {}",
                failures.join("; ")
            ))
        }
    }

    fn finish(&mut self) {
        self.flush_pending();
        self.flush_file();
        if let Some(mut out) = self.out.take() {
            // 退出时只做一次 sync，保证最后一批日志在进程结束后仍可读。
            let _ = out.flush();
            let _ = out.get_ref().sync_all();
        }
        self.dirty = false;
    }

    fn fail(&mut self, message: String) {
        self.fail_with_kind(message, super::WriteFailureKind::Unknown);
    }

    /// 记录一次 IO 失败，并按错误类型分类（磁盘满 / 权限不足 / 文件被占用）。
    fn fail_io(&mut self, message: String, err: &std::io::Error) {
        self.fail_with_kind(message, super::WriteFailureKind::from_io(err));
    }

    fn fail_with_kind(&mut self, message: String, kind: super::WriteFailureKind) {
        self.counters.failures.fetch_add(1, Ordering::Relaxed);
        self.diag.record_writer_error(message.clone(), kind);
        let now = Instant::now();
        let should_print = self
            .last_stderr
            .map(|at| now.duration_since(at) >= STDERR_INTERVAL)
            .unwrap_or(true);
        if should_print {
            self.last_stderr = Some(now);
            // 日志系统自身故障只进 stderr：绝不再走 tracing，避免递归。
            eprintln!("[diagnostics] {message}");
        }
    }
}

/// 测试专用：直接构造写线程状态并执行一次清理（验证取消标记不影响文件）。
#[cfg(test)]
pub(crate) fn clear_for_test(
    dir: &std::path::Path,
    diag: Arc<Diagnostics>,
    cancelled: &AtomicBool,
) -> Result<u64, String> {
    let mut writer = Writer::new(
        dir.to_path_buf(),
        WriterConfig::default(),
        Arc::new(super::Counters::default()),
        diag,
    );
    writer.startup();
    writer.clear(Some(cancelled))
}

/// 归档日志文件列表：`(路径, 修改时间, 字节数)`，只匹配本模块命名规则。
fn archive_files(dir: &Path) -> Vec<(PathBuf, std::time::SystemTime, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(ARCHIVE_PREFIX) || !name.ends_with(".jsonl") || name == ACTIVE_FILE {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        out.push((
            entry.path(),
            meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            meta.len(),
        ));
    }
    out
}

/// 降级期写入决策：`true` = 该事件应被丢弃（只计入 dropped）。
///
/// - **硬上限优先**：活动文件将超过 [`ACTIVE_HARD_CAP_BYTES`] 时，任何级别都停止写入
///   （防磁盘撑爆；轮转恢复后自动回到正常写入）；
/// - **低等级丢弃**：Trace/Debug/Info 直接计数丢弃，保留 Warn/Error/Critical 故障现场。
pub(crate) fn degraded_should_drop(level: DiagLevel, bytes_in_file: u64, line_bytes: u64) -> bool {
    if bytes_in_file.saturating_add(line_bytes) > ACTIVE_HARD_CAP_BYTES {
        return true;
    }
    matches!(level, DiagLevel::Trace | DiagLevel::Debug | DiagLevel::Info)
}

/// 退避时长的人类可读形式（提示信息用，只保留整数秒）。
fn format_duration_secs(d: Duration) -> String {
    let secs = d.as_secs();
    if secs > 0 {
        format!("{secs}s")
    } else {
        format!("{}ms", d.as_millis())
    }
}

/// 异常聚合：同一指纹在窗口内只落一条原始行 + 一条摘要行。
struct AggEntry {
    sample: DiagnosticEvent,
    first_seen: String,
    last: Instant,
    suppressed: u32,
}

struct Aggregator {
    map: HashMap<String, AggEntry>,
    capacity: usize,
    window: Duration,
}

impl Aggregator {
    fn new(capacity: usize, window: Duration) -> Self {
        Self {
            map: HashMap::new(),
            capacity: capacity.max(1),
            window,
        }
    }

    fn clear(&mut self) {
        self.map.clear();
    }

    fn window_secs(&self) -> u64 {
        self.window.as_secs().max(1)
    }

    /// 决定该事件现在应写出哪些行（0..=2 条）。
    fn observe(&mut self, event: DiagnosticEvent, now: Instant) -> Vec<DiagnosticEvent> {
        if !eligible(&event) {
            return vec![event];
        }
        let key = event.fingerprint();
        let mut out = Vec::new();

        let is_duplicate = self
            .map
            .get(&key)
            .map(|entry| now.duration_since(entry.last) <= self.window)
            .unwrap_or(false);
        if is_duplicate {
            if let Some(entry) = self.map.get_mut(&key) {
                entry.suppressed = entry.suppressed.saturating_add(1);
                entry.last = now;
            }
            // 重复发生被抑制：不写新行，由窗口结束时的摘要行代表。
            return out;
        }
        // 指纹相同但窗口已过：先落摘要，再作为新一轮的第一条。
        if let Some(existing) = self.map.remove(&key) {
            if let Some(summary) = summarize(existing, self.window_secs()) {
                out.push(summary);
            }
        }
        self.map.insert(
            key,
            AggEntry {
                sample: event.clone(),
                first_seen: event.timestamp.clone(),
                last: now,
                suppressed: 0,
            },
        );
        out.push(event);
        if self.map.len() > self.capacity {
            if let Some(summary) = self.evict_oldest() {
                out.push(summary);
            }
        }
        out
    }

    /// 取出所有已过期（或 `all=true` 时全部）的聚合摘要。
    fn drain_expired(&mut self, now: Instant, all: bool) -> Vec<DiagnosticEvent> {
        let expired: Vec<String> = self
            .map
            .iter()
            .filter(|(_, entry)| all || now.duration_since(entry.last) > self.window)
            .map(|(key, _)| key.clone())
            .collect();
        let window = self.window_secs();
        let mut out = Vec::new();
        for key in expired {
            if let Some(entry) = self.map.remove(&key) {
                if let Some(summary) = summarize(entry, window) {
                    out.push(summary);
                }
            }
        }
        out
    }

    fn evict_oldest(&mut self) -> Option<DiagnosticEvent> {
        let oldest = self
            .map
            .iter()
            .min_by_key(|(_, entry)| entry.last)
            .map(|(key, _)| key.clone())?;
        let window = self.window_secs();
        self.map.remove(&oldest).and_then(|e| summarize(e, window))
    }
}

/// 只有“高频可恢复噪声”才聚合：WARN/ERROR、无操作 ID、失败态、带错误码或文案。
///
/// 用户主动操作的失败一定带 `operation_id`，因此永远不会被合并；
/// CRITICAL（数据一致性）也从不聚合，每次发生都必须独立可见。
fn eligible(event: &DiagnosticEvent) -> bool {
    matches!(event.level, DiagLevel::Warn | DiagLevel::Error)
        && event.operation_id.is_none()
        && matches!(event.status, None | Some(DiagStatus::Failed))
        && event.event != "aggregated"
        && (event.error_code.is_some() || event.message.is_some())
}

fn summarize(entry: AggEntry, window_secs: u64) -> Option<DiagnosticEvent> {
    if entry.suppressed == 0 {
        // 只有一次发生：原始行已写出，不需要摘要。
        return None;
    }
    let mut summary = entry.sample;
    summary.event = "aggregated".to_string();
    summary.timestamp = now_iso();
    // count = 被抑制的重复次数（不含已写出的第一条），查询侧求和即真实次数。
    summary.count = entry.suppressed;
    let meta = summary.metadata.get_or_insert_with(Default::default);
    meta.insert(
        "occurrences".to_string(),
        Value::from(u64::from(entry.suppressed) + 1),
    );
    meta.insert("first_seen".to_string(), Value::from(entry.first_seen));
    meta.insert("window_secs".to_string(), Value::from(window_secs));
    Some(summary)
}
