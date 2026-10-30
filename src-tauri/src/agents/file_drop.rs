//! 文件投递 Adapter：轮询应用数据目录下的 agent-inbox/。
//!
//! 任何 Agent（含暂未验证官方接口的 Qoder / WorkBuddy）都可以通过写入 JSON 文件上报状态。
//! 文件格式：单个事件对象或事件数组，字段见 `AgentEvent`。
//!
//! 可靠性边界：
//! - 只处理「稳定」文件（mtime > 300ms，且不是 .tmp/.partial），写入方应先写临时文件再 rename；
//! - 单文件大小、单文件事件数、每轮文件数/读取字节数均有上限；
//! - 目录枚举有上限（2 万项），外部写入制造超大目录也不会拖垮主程序；
//! - 扫描节奏自适应：有积压 750ms~1s，空闲逐步退避到 5s，不再无条件全量高频扫描；
//! - 双通道：最老文件保证不饿死；最新文件中的关键状态（waiting/completed/failed/…）
//!   当轮优先处理，旧积压无法无限阻挡新关键事件（状态顺序由受理序号 + 事件时间屏障兜底）；
//! - 关键状态文件先处理；失败按指数退避重试（最多 8 次），仍失败移入 failed/（保留原文件）；
//! - 连续 5 次读取失败（独占锁/权限）移入 failed/，不在原地无限重试；
//! - 处理成功即删除；删除是唯一「消费」动作；队列拥塞不会删除文件，也不会阻塞 Agent；
//! - 统计（文件数/字节数/最老年龄/扫描耗时/退避/淘汰/失败日志）暴露给性能诊断。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::agents::inbox;
use crate::agents::pipeline::IngestPipeline;
use crate::agents::{AgentAdapter, AgentEvent, AgentHub, AgentState, Transport};
use crate::db::Settings;
use crate::error::{AppError, AppResult};

const POLL_ACTIVE: Duration = Duration::from_millis(750);
/// 有积压但本轮没有可处理文件（半写/退避）时的节奏。
const POLL_BACKLOG: Duration = Duration::from_millis(1000);
const POLL_IDLE_MAX: Duration = Duration::from_secs(5);
const STABLE_AGE: Duration = Duration::from_millis(300);
const MAX_EVENTS_PER_FILE: usize = 1000;
const MAX_READ_BYTES_PER_ROUND: u64 = 16 * 1024 * 1024;
/// 最新通道：每轮最多解析的新文件数 / 字节数（只为捞取关键状态）。
const NEWEST_LANE_FILES: usize = 64;
const NEWEST_LANE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_READ_ERRORS: u32 = 5;
const MAX_RETRIES: u32 = 8;
const SETTINGS_TTL: Duration = Duration::from_secs(5);
const FAILED_STATS_TTL: Duration = Duration::from_secs(60);
const TMP_CLEANUP_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct FileDropStats {
    pending_files: AtomicUsize,
    pending_bytes: AtomicU64,
    pending_tmp_files: AtomicU64,
    oldest_age_secs: AtomicU64,
    processed_files: AtomicU64,
    processed_events: AtomicU64,
    failed_files: AtomicU64,
    retried_files: AtomicU64,
    bytes_processed: AtomicU64,
    scan_rounds: AtomicU64,
    scan_ms_last: AtomicU64,
    scan_ms_max: AtomicU64,
    adaptive_interval_ms: AtomicU64,
    truncated_scans: AtomicU64,
    empty_rounds: AtomicU64,
    critical_lane_files: AtomicU64,
    deferred_files: AtomicU64,
    cleaned_tmp_files: AtomicU64,
    failed_pending_files: AtomicU64,
    failed_pending_bytes: AtomicU64,
    failure_log_entries: AtomicU64,
    over_capacity_rounds: AtomicU64,
    last_scan_at: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    last_failure: Mutex<Option<String>>,
    dir: Mutex<Option<String>>,
}

static STATS: OnceLock<Arc<FileDropStats>> = OnceLock::new();

fn stats() -> &'static Arc<FileDropStats> {
    STATS.get_or_init(|| Arc::new(FileDropStats::default()))
}

fn set_error(msg: impl Into<String>) {
    *stats().last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg.into());
}

/// 诊断快照。
pub fn stats_snapshot() -> serde_json::Value {
    let s = stats();
    serde_json::json!({
        "pending_files": s.pending_files.load(Ordering::Relaxed),
        "pending_bytes": s.pending_bytes.load(Ordering::Relaxed),
        "pending_tmp_files": s.pending_tmp_files.load(Ordering::Relaxed),
        "oldest_age_secs": s.oldest_age_secs.load(Ordering::Relaxed),
        "processed_files": s.processed_files.load(Ordering::Relaxed),
        "processed_events": s.processed_events.load(Ordering::Relaxed),
        "failed_files": s.failed_files.load(Ordering::Relaxed),
        "retried_files": s.retried_files.load(Ordering::Relaxed),
        "bytes_processed": s.bytes_processed.load(Ordering::Relaxed),
        "scan_rounds": s.scan_rounds.load(Ordering::Relaxed),
        "scan_ms_last": s.scan_ms_last.load(Ordering::Relaxed),
        "scan_ms_max": s.scan_ms_max.load(Ordering::Relaxed),
        "adaptive_interval_ms": s.adaptive_interval_ms.load(Ordering::Relaxed),
        "truncated_scans": s.truncated_scans.load(Ordering::Relaxed),
        "empty_rounds": s.empty_rounds.load(Ordering::Relaxed),
        "critical_lane_files": s.critical_lane_files.load(Ordering::Relaxed),
        "deferred_files": s.deferred_files.load(Ordering::Relaxed),
        "cleaned_tmp_files": s.cleaned_tmp_files.load(Ordering::Relaxed),
        "failed_pending_files": s.failed_pending_files.load(Ordering::Relaxed),
        "failed_pending_bytes": s.failed_pending_bytes.load(Ordering::Relaxed),
        "failure_log_entries": s.failure_log_entries.load(Ordering::Relaxed),
        "over_capacity_rounds": s.over_capacity_rounds.load(Ordering::Relaxed),
        "capacity_limits": {
            "max_files": inbox::MAX_FILES,
            "max_bytes": inbox::MAX_BYTES,
            "max_file_bytes": inbox::MAX_FILE_BYTES,
            "critical_headroom_files": inbox::CRITICAL_HEADROOM_FILES,
            "critical_headroom_bytes": inbox::CRITICAL_HEADROOM_BYTES,
        },
        "last_scan_at": s.last_scan_at.lock().ok().and_then(|v| v.clone()),
        "last_error": s.last_error.lock().ok().and_then(|v| v.clone()),
        "last_failure": s.last_failure.lock().ok().and_then(|v| v.clone()),
        "dir": s.dir.lock().ok().and_then(|v| v.clone()),
    })
}

pub struct FileDropAdapter {
    pipeline: Arc<IngestPipeline>,
}

impl FileDropAdapter {
    pub fn new(pipeline: Arc<IngestPipeline>) -> Self {
        Self { pipeline }
    }
}

pub fn inbox_dir_of(app: &tauri::AppHandle) -> PathBuf {
    crate::app_data_dir(app).join("agent-inbox")
}

fn inbox_dir(hub: &AgentHub) -> PathBuf {
    inbox_dir_of(hub.app())
}

fn is_candidate(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    !name.starts_with('.')
        && path.extension().map(|e| e == "json").unwrap_or(false)
        && !name.ends_with(".tmp.json")
}

/// 校验并解析文件内容（全成功/全失败）。
fn parse_events(content: &str) -> Result<Vec<AgentEvent>, AppError> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|_| AppError::Validation("投递文件 JSON 解析失败".into()))?;
    match value {
        serde_json::Value::Object(_) => {
            let ev = serde_json::from_value::<AgentEvent>(value)
                .map_err(|_| AppError::Validation("投递文件事件字段非法".into()))?;
            Ok(vec![ev])
        }
        serde_json::Value::Array(arr) => {
            if arr.len() > MAX_EVENTS_PER_FILE {
                return Err(AppError::Validation(format!(
                    "单文件事件数超过上限 {}",
                    MAX_EVENTS_PER_FILE
                )));
            }
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(
                    serde_json::from_value::<AgentEvent>(item)
                        .map_err(|_| AppError::Validation("投递文件数组元素非法".into()))?,
                );
            }
            Ok(out)
        }
        _ => Err(AppError::Validation("投递文件必须是对象或数组".into())),
    }
}

fn is_critical_file(events: &[AgentEvent]) -> bool {
    events
        .iter()
        .any(|e| AgentState::parse(&e.state) != Some(AgentState::Running))
}

fn retryable(err: &AppError) -> bool {
    matches!(
        err,
        AppError::Overloaded(_)
            | AppError::Unavailable(_)
            | AppError::Db(_)
            | AppError::Io(_)
            | AppError::Json(_)
    )
}

async fn move_to_failed(failed_dir: &Path, path: &Path, reason: &str) {
    let _ = tokio::fs::create_dir_all(failed_dir).await;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown.json".into());
    let dest = failed_dir.join(format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        name
    ));
    if let Err(e) = tokio::fs::rename(path, &dest).await {
        tracing::warn!("投递文件移入 failed 失败 {:?}: {}", path.file_name(), e);
        set_error(format!("{} 隔离失败: {}", name, e));
    } else {
        stats().failed_files.fetch_add(1, Ordering::Relaxed);
        tracing::warn!("投递文件已隔离到 failed: {:?}（{}）", name, reason);
        set_error(format!("{}: {}", name, reason));
    }
}

#[derive(Debug)]
struct ParsedFile {
    path: PathBuf,
    events: Vec<AgentEvent>,
    critical: bool,
    modified: SystemTime,
    bytes: u64,
}

#[derive(Debug, Clone, Copy)]
struct FileEntry {
    modified: SystemTime,
    len: u64,
}

#[derive(Default)]
struct ScanState {
    retries: HashMap<PathBuf, (u32, Instant)>,
    read_errors: HashMap<PathBuf, u32>,
    last_tmp_cleanup: Option<Instant>,
}

struct ScanResult {
    parsed: Vec<ParsedFile>,
    pending_files: usize,
    pending_bytes: u64,
    oldest_secs: u64,
    tmp_files: usize,
    truncated: bool,
    deferred: usize,
    critical: usize,
    cleaned_tmp: usize,
    scan_ms: u64,
}

/// 单轮扫描：有界枚举 → 最老通道保证顺序推进；最新通道只捞关键状态。
async fn scan(
    dir: &Path,
    failed_dir: &Path,
    max_files: usize,
    max_file_bytes: u64,
    state: &mut ScanState,
) -> ScanResult {
    let started = Instant::now();
    let mut entries: Vec<(PathBuf, FileEntry)> = Vec::new();
    let mut pending_files = 0usize;
    let mut pending_bytes = 0u64;
    let mut tmp_files = 0usize;
    let mut truncated = false;
    let mut seen = 0usize;

    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            seen += 1;
            if seen > inbox::MAX_MEASURE_ENTRIES {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == inbox::QUOTA_LOCK || name == ".inbox-failures.log" {
                continue;
            }
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            if name.ends_with(".tmp") {
                tmp_files += 1;
                continue;
            }
            let path = entry.path();
            if !is_candidate(&path) {
                continue;
            }
            pending_files += 1;
            pending_bytes += meta.len();
            entries.push((
                path,
                FileEntry {
                    modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    len: meta.len(),
                },
            ));
        }
    }

    let oldest_secs = entries
        .iter()
        .map(|(_, e)| e.modified.elapsed().map(|d| d.as_secs()).unwrap_or(0))
        .max()
        .unwrap_or(0);

    // 清理崩溃遗留的半写文件（节流，避免每轮额外遍历）
    let mut cleaned_tmp = 0usize;
    let cleanup_due = state
        .last_tmp_cleanup
        .map(|t| t.elapsed() >= TMP_CLEANUP_TTL)
        .unwrap_or(true);
    if cleanup_due {
        let dir = dir.to_path_buf();
        cleaned_tmp = tokio::task::spawn_blocking(move || {
            inbox::cleanup_stale_tmp(&dir, Duration::from_secs(120))
        })
        .await
        .unwrap_or(0);
        state.last_tmp_cleanup = Some(Instant::now());
    }

    entries.sort_by_key(|(_, e)| e.modified);
    let now = Instant::now();
    let mut parsed: Vec<ParsedFile> = Vec::new();
    let mut read_paths: HashSet<PathBuf> = HashSet::new();
    let mut read_bytes = 0u64;
    let mut deferred = 0usize;

    let backoff_active = |path: &Path| -> bool {
        state
            .retries
            .get(path)
            .map(|(_, next)| *next > now)
            .unwrap_or(false)
    };

    // 最新通道：只保留关键状态，先于旧积压处理。目录很小时全部落在最老通道，
    // 由 ParsedFile.critical 排序保证关键状态仍排在最前。
    let oldest_count = entries.len().min(max_files);
    let lane_start = entries
        .len()
        .saturating_sub(NEWEST_LANE_FILES)
        .max(oldest_count);
    let mut lane_bytes = 0u64;
    for (path, entry) in entries[lane_start..].iter().rev() {
        if lane_bytes + entry.len > NEWEST_LANE_BYTES {
            continue;
        }
        if entry
            .modified
            .elapsed()
            .map(|d| d < STABLE_AGE)
            .unwrap_or(false)
        {
            continue;
        }
        if backoff_active(path) {
            deferred += 1;
            continue;
        }
        if entry.len > max_file_bytes {
            move_to_failed(
                failed_dir,
                path,
                &format!("文件大小 {} 超过上限 {} 字节", entry.len, max_file_bytes),
            )
            .await;
            continue;
        }
        let content = match tokio::fs::read_to_string(path).await {
            Ok(c) => {
                state.read_errors.remove(path);
                c
            }
            Err(e) => {
                let attempts = state.read_errors.entry(path.clone()).or_insert(0);
                *attempts += 1;
                let n = *attempts;
                if n >= MAX_READ_ERRORS {
                    state.read_errors.remove(path);
                    move_to_failed(failed_dir, path, "连续读取失败（独占锁或权限不足）").await;
                } else {
                    tracing::warn!(
                        "读取投递文件失败 {:?}（第 {} 次）: {}",
                        path.file_name(),
                        n,
                        e
                    );
                    set_error(format!("读取失败 {}（第 {} 次）: {}", path.display(), n, e));
                }
                continue;
            }
        };
        lane_bytes += content.len() as u64;
        read_paths.insert(path.clone());
        match parse_events(&content) {
            Ok(events) => {
                if is_critical_file(&events) {
                    parsed.push(ParsedFile {
                        path: path.clone(),
                        events,
                        critical: true,
                        modified: entry.modified,
                        bytes: content.len() as u64,
                    });
                }
            }
            Err(e) => move_to_failed(failed_dir, path, &e.to_string()).await,
        }
    }

    // 最老通道：按时间推进，保证任何文件最终都会轮到。
    for (path, entry) in entries[..oldest_count].iter() {
        if read_paths.contains(path) {
            continue;
        }
        if entry
            .modified
            .elapsed()
            .map(|d| d < STABLE_AGE)
            .unwrap_or(false)
        {
            continue;
        }
        if backoff_active(path) {
            deferred += 1;
            continue;
        }
        if read_bytes + entry.len > MAX_READ_BYTES_PER_ROUND {
            break;
        }
        if entry.len > max_file_bytes {
            move_to_failed(
                failed_dir,
                path,
                &format!("文件大小 {} 超过上限 {} 字节", entry.len, max_file_bytes),
            )
            .await;
            continue;
        }
        let content = match tokio::fs::read_to_string(path).await {
            Ok(c) => {
                state.read_errors.remove(path);
                c
            }
            Err(e) => {
                let attempts = state.read_errors.entry(path.clone()).or_insert(0);
                *attempts += 1;
                let n = *attempts;
                if n >= MAX_READ_ERRORS {
                    state.read_errors.remove(path);
                    move_to_failed(failed_dir, path, "连续读取失败（独占锁或权限不足）").await;
                } else {
                    tracing::warn!(
                        "读取投递文件失败 {:?}（第 {} 次）: {}",
                        path.file_name(),
                        n,
                        e
                    );
                    set_error(format!("读取失败 {}（第 {} 次）: {}", path.display(), n, e));
                }
                continue;
            }
        };
        read_bytes += content.len() as u64;
        read_paths.insert(path.clone());
        match parse_events(&content) {
            Ok(events) => {
                let critical = is_critical_file(&events);
                parsed.push(ParsedFile {
                    path: path.clone(),
                    events,
                    critical,
                    modified: entry.modified,
                    bytes: content.len() as u64,
                });
            }
            Err(e) => move_to_failed(failed_dir, path, &e.to_string()).await,
        }
    }

    // 关键文件优先（同优先级内新文件先处理），其余保持最老优先。
    parsed.sort_by(|a, b| match (a.critical, b.critical) {
        (true, true) => b.modified.cmp(&a.modified),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => a.modified.cmp(&b.modified),
    });
    let critical = parsed.iter().filter(|p| p.critical).count();
    let scan_ms = started.elapsed().as_millis() as u64;
    ScanResult {
        parsed,
        pending_files,
        pending_bytes,
        oldest_secs,
        tmp_files,
        truncated,
        deferred,
        critical,
        cleaned_tmp,
        scan_ms,
    }
}

async fn process_parsed(
    hub: &AgentHub,
    pipeline: &IngestPipeline,
    parsed: ParsedFile,
    state: &mut ScanState,
) {
    let size = parsed.events.len();
    match pipeline
        .submit(parsed.events, Transport::File, "file_drop", true)
        .await
    {
        Ok(receipt) => {
            state.read_errors.remove(&parsed.path);
            if let Err(e) = tokio::fs::remove_file(&parsed.path).await {
                tracing::warn!(
                    "投递文件处理成功但删除失败 {:?}: {}",
                    parsed.path.file_name(),
                    e
                );
                set_error(format!("已入库但删除失败 {}: {}", parsed.path.display(), e));
                return;
            }
            state.retries.remove(&parsed.path);
            stats().processed_files.fetch_add(1, Ordering::Relaxed);
            stats()
                .processed_events
                .fetch_add(receipt.accepted as u64, Ordering::Relaxed);
            stats()
                .bytes_processed
                .fetch_add(parsed.bytes, Ordering::Relaxed);
            tracing::debug!(
                "已处理投递文件 {:?}（{} 个事件，合并 {}）",
                parsed.path.file_name(),
                size,
                if receipt.merged { 1 } else { 0 }
            );
        }
        Err(e) if retryable(&e) => {
            let entry = state
                .retries
                .entry(parsed.path.clone())
                .or_insert((0, Instant::now()));
            entry.0 += 1;
            let attempt = entry.0;
            if attempt >= MAX_RETRIES {
                move_to_failed(
                    &inbox_dir(hub).join("failed"),
                    &parsed.path,
                    &format!("重试 {} 次仍失败: {}", attempt, e),
                )
                .await;
                state.retries.remove(&parsed.path);
                return;
            }
            let backoff = Duration::from_millis(250 * 2u64.pow(attempt.min(6)));
            entry.1 = Instant::now() + backoff;
            stats().retried_files.fetch_add(1, Ordering::Relaxed);
            set_error(format!(
                "重试 {}（第 {} 次）: {}",
                parsed.path.display(),
                attempt,
                e
            ));
        }
        Err(e) => {
            move_to_failed(&inbox_dir(hub).join("failed"), &parsed.path, &e.to_string()).await;
            state.retries.remove(&parsed.path);
        }
    }
}

async fn refresh_failed_stats(dir: PathBuf) {
    let summary = tokio::task::spawn_blocking(move || {
        let failed = dir.join("failed");
        let usage = inbox::measure(&failed).unwrap_or_default();
        let (entries, last) = inbox::failure_log_summary(&dir);
        (usage, entries, last)
    })
    .await;
    if let Ok((usage, entries, last)) = summary {
        stats()
            .failed_pending_files
            .store(usage.files as u64, Ordering::Relaxed);
        stats()
            .failed_pending_bytes
            .store(usage.bytes, Ordering::Relaxed);
        stats()
            .failure_log_entries
            .store(entries as u64, Ordering::Relaxed);
        *stats()
            .last_failure
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = last;
    }
}

fn note_scan(result: &ScanResult, interval: Duration, rounds: u64) {
    let s = stats();
    s.pending_files
        .store(result.pending_files, Ordering::Relaxed);
    s.pending_bytes
        .store(result.pending_bytes, Ordering::Relaxed);
    s.pending_tmp_files
        .store(result.tmp_files as u64, Ordering::Relaxed);
    s.oldest_age_secs
        .store(result.oldest_secs, Ordering::Relaxed);
    s.scan_rounds.store(rounds, Ordering::Relaxed);
    s.scan_ms_last.store(result.scan_ms, Ordering::Relaxed);
    s.scan_ms_max.fetch_max(result.scan_ms, Ordering::Relaxed);
    s.adaptive_interval_ms
        .store(interval.as_millis() as u64, Ordering::Relaxed);
    if result.truncated {
        s.truncated_scans.fetch_add(1, Ordering::Relaxed);
        set_error(format!(
            "投递目录超过 {} 项，本轮只处理前 {} 项",
            inbox::MAX_MEASURE_ENTRIES,
            inbox::MAX_MEASURE_ENTRIES
        ));
    }
    if result.parsed.is_empty() {
        s.empty_rounds.fetch_add(1, Ordering::Relaxed);
    }
    s.critical_lane_files
        .fetch_add(result.critical as u64, Ordering::Relaxed);
    s.deferred_files
        .fetch_add(result.deferred as u64, Ordering::Relaxed);
    s.cleaned_tmp_files
        .fetch_add(result.cleaned_tmp as u64, Ordering::Relaxed);
    if result.pending_files > inbox::MAX_FILES || result.pending_bytes > inbox::MAX_BYTES {
        s.over_capacity_rounds.fetch_add(1, Ordering::Relaxed);
    }
    *s.last_scan_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(crate::agents::now_iso());
}

impl AgentAdapter for FileDropAdapter {
    fn id(&self) -> &'static str {
        "file_drop"
    }

    fn spawn(
        self: Box<Self>,
        hub: std::sync::Arc<AgentHub>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let pipeline = self.pipeline.clone();
        tauri::async_runtime::spawn(async move {
            let dir = inbox_dir(&hub);
            let failed_dir = dir.join("failed");
            let _ = tokio::fs::create_dir_all(&dir).await;
            *stats().dir.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(dir.to_string_lossy().to_string());
            tracing::info!("文件投递 Adapter 启动，监听目录 {:?}", dir);
            let mut state = ScanState::default();
            let mut settings = Settings::load(hub.db()).unwrap_or_default();
            let mut settings_at = Instant::now();
            let mut failed_at: Option<Instant> = None;
            let mut interval = POLL_ACTIVE;
            let mut rounds = 0u64;
            loop {
                if crate::agents::shutdown_signal::is_set() {
                    tracing::info!("应用退出：文件投递 Adapter 停止扫描（未处理文件保留在收件箱）");
                    break;
                }
                if settings_at.elapsed() >= SETTINGS_TTL {
                    settings = Settings::load(hub.db()).unwrap_or(settings);
                    settings_at = Instant::now();
                }
                if failed_at
                    .map(|t| t.elapsed() >= FAILED_STATS_TTL)
                    .unwrap_or(true)
                {
                    refresh_failed_stats(dir.clone()).await;
                    failed_at = Some(Instant::now());
                }
                let max_files = settings.agent_inbox_max_files.clamp(1, inbox::MAX_FILES);
                let max_bytes = settings
                    .agent_inbox_max_file_bytes
                    .clamp(1024, inbox::MAX_FILE_BYTES);
                rounds += 1;
                let mut result = scan(&dir, &failed_dir, max_files, max_bytes, &mut state).await;
                let parsed_count = result.parsed.len();
                for file in std::mem::take(&mut result.parsed) {
                    if file.events.len() > MAX_EVENTS_PER_FILE {
                        move_to_failed(
                            &failed_dir,
                            &file.path,
                            &format!("事件数超过上限 {}", MAX_EVENTS_PER_FILE),
                        )
                        .await;
                        continue;
                    }
                    process_parsed(&hub, &pipeline, file, &mut state).await;
                }
                // 清理已消失文件的退避/读错记录
                state.retries.retain(|p, _| p.exists());
                state.read_errors.retain(|p, _| p.exists());
                interval = if result.pending_files == 0 && parsed_count == 0 {
                    (interval * 2).min(POLL_IDLE_MAX)
                } else if parsed_count == 0 {
                    POLL_BACKLOG
                } else {
                    POLL_ACTIVE
                };
                note_scan(&result, interval, rounds);
                tokio::select! {
                    _ = crate::agents::shutdown_signal::wait() => break,
                    _ = tokio::time::sleep(interval) => {}
                }
            }
        })
    }
}

/// 手动恢复：把 failed/ 中的文件移回 inbox，重新尝试（保留原文件，不删除历史）。
/// 受目录总容量约束：空位不足时拒绝并返回明确错误，绝不清空/覆盖现有投递。
pub fn retry_failed_inbox(app: &tauri::AppHandle) -> AppResult<usize> {
    let inbox = inbox_dir_of(app);
    let failed = inbox.join("failed");
    if !failed.exists() {
        return Ok(0);
    }
    let usage = inbox::measure(&inbox)?;
    let slots = inbox::MAX_FILES.saturating_sub(usage.files);
    let mut bytes_left = inbox::MAX_BYTES.saturating_sub(usage.bytes);
    if slots == 0 {
        return Err(AppError::Overloaded(
            "投递目录已满，等待扫描消费后再恢复失败文件".into(),
        ));
    }
    let mut moved = 0usize;
    for entry in std::fs::read_dir(&failed)?.take(slots.min(1000)) {
        let entry = entry?;
        if !entry.metadata()?.is_file() {
            continue;
        }
        let len = entry.metadata()?.len();
        if len > bytes_left {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let dest = inbox.join(format!(
            "retry-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            name
        ));
        if std::fs::rename(entry.path(), &dest).is_ok() {
            bytes_left = bytes_left.saturating_sub(len);
            moved += 1;
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("td-filedrop-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn event_json(session: &str, state: &str) -> String {
        json!({
            "source_id": "codex",
            "session_id": session,
            "state": state,
            "event_id": format!("e-{}-{}", session, state),
            "occurred_at": "2026-10-25T10:00:00Z",
        })
        .to_string()
    }

    fn write_file(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn parse_rejects_non_object_and_oversized_batches() {
        assert!(parse_events("123").is_err());
        let arr = serde_json::json!([]);
        assert_eq!(parse_events(&arr.to_string()).unwrap().len(), 0);
    }

    #[test]
    fn critical_detection_covers_all_non_running_states() {
        let mk = |state: &str| AgentEvent {
            source_id: "bridge".into(),
            session_id: "s".into(),
            state: state.into(),
            ..Default::default()
        };
        assert!(!is_critical_file(&[mk("running")]));
        for state in ["waiting", "failed", "completed", "disconnected", "idle"] {
            assert!(is_critical_file(&[mk(state)]), "{} 必须视为关键", state);
        }
    }

    #[tokio::test]
    async fn scan_skips_half_written_and_tmp_files() {
        let dir = temp_dir("half");
        let failed = dir.join("failed");
        write_file(&dir, "fresh.json", &event_json("s1", "waiting"));
        write_file(&dir, ".writing.json.tmp", &event_json("s2", "waiting"));
        write_file(&dir, "legacy.tmp.json", &event_json("s3", "waiting"));
        let mut state = ScanState::default();
        let result = scan(&dir, &failed, 200, 4096, &mut state).await;
        assert_eq!(result.pending_files, 1, "半写/临时文件不计入待处理");
        assert!(result.parsed.is_empty(), "未稳定文件本轮不得读取");
        tokio::time::sleep(Duration::from_millis(350)).await;
        let result = scan(&dir, &failed, 200, 4096, &mut state).await;
        assert_eq!(result.parsed.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn scan_quarantines_invalid_and_oversized_files_without_deleting() {
        let dir = temp_dir("bad");
        let failed = dir.join("failed");
        write_file(&dir, "broken.json", "{not-json");
        write_file(&dir, "big.json", &"x".repeat(2048));
        tokio::time::sleep(Duration::from_millis(350)).await;
        let mut state = ScanState::default();
        let result = scan(&dir, &failed, 200, 1024, &mut state).await;
        assert!(result.parsed.is_empty());
        let quarantined = std::fs::read_dir(&failed).unwrap().count();
        assert_eq!(quarantined, 2, "坏文件必须进入 failed/ 而不是删除");
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "只剩 failed 子目录"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn scan_oldest_lane_progresses_with_bounded_batch() {
        let dir = temp_dir("oldest");
        let failed = dir.join("failed");
        for i in 0..30 {
            write_file(
                &dir,
                &format!("f-{:02}.json", i),
                &event_json(&format!("s{}", i), "running"),
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let mut state = ScanState::default();
        let result = scan(&dir, &failed, 10, 4096, &mut state).await;
        assert_eq!(result.parsed.len(), 10, "每轮文件数必须受上限约束");
        let first = result.parsed[0].path.file_name().unwrap().to_string_lossy();
        assert_eq!(first, "f-00.json", "最老文件优先，积压不会饿死");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn newest_critical_jumps_ahead_of_large_backlog() {
        let dir = temp_dir("critical-lane");
        let failed = dir.join("failed");
        for i in 0..300 {
            write_file(
                &dir,
                &format!("old-{:03}.json", i),
                &event_json(&format!("s{}", i), "running"),
            );
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        write_file(
            &dir,
            "new-waiting.json",
            &event_json("new-session", "waiting"),
        );
        tokio::time::sleep(Duration::from_millis(350)).await;
        let mut state = ScanState::default();
        let result = scan(&dir, &failed, 200, 4096, &mut state).await;
        assert!(result.critical >= 1);
        assert_eq!(
            result.parsed[0].path.file_name().unwrap().to_string_lossy(),
            "new-waiting.json",
            "新关键事件必须排在整个旧积压之前"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn scan_bounds_reads_for_batch_and_skips_backoff_files() {
        let dir = temp_dir("budget");
        let failed = dir.join("failed");
        for i in 0..5 {
            write_file(
                &dir,
                &format!("f-{}.json", i),
                &event_json(&format!("s{}", i), "running"),
            );
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let mut state = ScanState::default();
        let blocked = dir.join("f-0.json");
        state.retries.insert(
            blocked.clone(),
            (1, Instant::now() + Duration::from_secs(30)),
        );
        let result = scan(&dir, &failed, 200, 4096, &mut state).await;
        assert_eq!(result.deferred, 1);
        assert!(result.parsed.iter().all(|p| p.path != blocked));
        assert_eq!(result.parsed.len(), 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    // 真实万级文件 IO 场景：手动 `cargo test --lib scan_ten_thousand -- --ignored` 运行，
    // 避免并行测试互相抢磁盘导致其他时序测试抖动。
    #[ignore = "万级文件真实 IO 场景，手动运行"]
    #[tokio::test]
    async fn scan_ten_thousand_files_stays_bounded_and_fast_enough() {
        let dir = temp_dir("10k");
        let failed = dir.join("failed");
        for i in 0..10_000 {
            write_file(
                &dir,
                &format!("f-{:05}.json", i),
                &event_json(&format!("s{}", i), "running"),
            );
        }
        let mut state = ScanState::default();
        let started = Instant::now();
        let result = scan(&dir, &failed, 200, 4096, &mut state).await;
        let elapsed = started.elapsed();
        assert_eq!(result.pending_files, 10_000);
        assert_eq!(result.parsed.len(), 200, "每轮读取必须有界");
        eprintln!(
            "10k files: pending={} parsed={} scan_ms={}",
            result.pending_files,
            result.parsed.len(),
            elapsed.as_millis()
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "扫描 1 万文件耗时过长: {:?}",
            elapsed
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unreadable_file_is_retried_then_quarantined_without_deletion() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("unreadable");
        let failed = dir.join("failed");
        let path = dir.join("locked.json");
        write_file(&dir, "locked.json", &event_json("s1", "waiting"));
        tokio::time::sleep(Duration::from_millis(350)).await;
        // 允许删除（rename），但拒绝读取：模拟被其他进程独占/权限不足。
        let hold = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(2 | 4)
            .open(&path)
            .unwrap();
        let mut state = ScanState::default();
        for _ in 0..MAX_READ_ERRORS {
            let result = scan(&dir, &failed, 200, 4096, &mut state).await;
            assert!(result.parsed.is_empty(), "不可读文件不得进入处理流程");
        }
        assert_eq!(
            std::fs::read_dir(&failed).unwrap().count(),
            1,
            "连续读取失败后应隔离到 failed/ 而非删除"
        );
        drop(hold);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_event_id_is_deduplicated_at_ingest() {
        use crate::error::AppResult;
        let db = crate::db::Db::open_in_memory().unwrap();
        let ev = AgentEvent {
            source_id: "codex".into(),
            session_id: "s1".into(),
            run_id: Some("r1".into()),
            state: "waiting".into(),
            event_id: Some("same-event".into()),
            occurred_at: Some("2026-10-25T10:00:00Z".into()),
            ..Default::default()
        };
        let now = crate::agents::now_iso();
        let ingest = |transport| -> AppResult<crate::agents::IngestOutcome> {
            db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let out = crate::agents::ingest_core(&tx, &ev, &now, transport)?;
                tx.commit()?;
                Ok(out)
            })
        };
        let first = ingest(Transport::File).unwrap();
        let second = ingest(Transport::Http).unwrap();
        assert!(!first.deduplicated);
        assert!(second.deduplicated);
        assert_eq!(first.run_row_id, second.run_row_id);
        let count: i64 = db
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))
                    .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(count, 1, "同一 event_id 跨通道最多一行");
    }
}
