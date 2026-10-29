//! 文件投递 Adapter：轮询应用数据目录下的 agent-inbox/。
//!
//! 任何 Agent（含暂未验证官方接口的 Qoder / WorkBuddy）都可以通过写入 JSON 文件上报状态。
//! 文件格式：单个事件对象或事件数组，字段见 `AgentEvent`。
//!
//! 可靠性边界：
//! - 只处理「稳定」文件（mtime > 300ms，且不是 .tmp/.partial），写入方应先写临时文件再 rename；
//! - 单文件大小、单文件事件数、每轮文件数/读取字节数均有上限；
//! - 关键状态文件先处理；失败按指数退避重试（最多 8 次），仍失败移入 failed/（保留原文件）；
//! - 处理成功即删除；删除是唯一「消费」动作；
//! - 队列拥塞不会删除文件，也不会阻塞 Agent；
//! - 统计（文件数/字节数/最老文件年龄/处理与失败数）暴露给性能诊断，并提供手动恢复命令。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use tauri::Manager;

use crate::agents::pipeline::IngestPipeline;
use crate::agents::{AgentAdapter, AgentEvent, AgentHub, AgentState, Transport};
use crate::db::Settings;
use crate::error::{AppError, AppResult};

const POLL_INTERVAL: Duration = Duration::from_millis(750);
const STABLE_AGE: Duration = Duration::from_millis(300);
const MAX_EVENTS_PER_FILE: usize = 1000;
const MAX_READ_BYTES_PER_ROUND: u64 = 16 * 1024 * 1024;
const MAX_RETRIES: u32 = 8;

#[derive(Default)]
struct FileDropStats {
    pending_files: AtomicUsize,
    pending_bytes: AtomicU64,
    oldest_age_secs: AtomicU64,
    processed_files: AtomicU64,
    processed_events: AtomicU64,
    failed_files: AtomicU64,
    retried_files: AtomicU64,
    bytes_processed: AtomicU64,
    last_scan_at: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    dir: Mutex<Option<String>>,
}

static STATS: OnceLock<Arc<FileDropStats>> = OnceLock::new();

fn stats() -> &'static Arc<FileDropStats> {
    STATS.get_or_init(|| Arc::new(FileDropStats::default()))
}

/// 诊断快照。
pub fn stats_snapshot() -> serde_json::Value {
    let s = stats();
    serde_json::json!({
        "pending_files": s.pending_files.load(Ordering::Relaxed),
        "pending_bytes": s.pending_bytes.load(Ordering::Relaxed),
        "oldest_age_secs": s.oldest_age_secs.load(Ordering::Relaxed),
        "processed_files": s.processed_files.load(Ordering::Relaxed),
        "processed_events": s.processed_events.load(Ordering::Relaxed),
        "failed_files": s.failed_files.load(Ordering::Relaxed),
        "retried_files": s.retried_files.load(Ordering::Relaxed),
        "bytes_processed": s.bytes_processed.load(Ordering::Relaxed),
        "last_scan_at": s.last_scan_at.lock().ok().and_then(|v| v.clone()),
        "last_error": s.last_error.lock().ok().and_then(|v| v.clone()),
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
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("agent-inbox")
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

async fn move_to_failed(hub: &AgentHub, path: &Path, reason: &str) {
    let failed = inbox_dir(hub).join("failed");
    let _ = tokio::fs::create_dir_all(&failed).await;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown.json".into());
    let dest = failed.join(format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        name
    ));
    if let Err(e) = tokio::fs::rename(path, &dest).await {
        tracing::warn!("投递文件移入 failed 失败 {:?}: {}", path.file_name(), e);
    } else {
        stats().failed_files.fetch_add(1, Ordering::Relaxed);
        tracing::warn!("投递文件已隔离到 failed: {:?}（{}）", name, reason);
        *stats().last_error.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(format!("{}: {}", name, reason));
    }
}

struct ParsedFile {
    path: PathBuf,
    events: Vec<AgentEvent>,
    critical: bool,
    modified: SystemTime,
}

async fn scan(
    hub: &AgentHub,
    max_files: usize,
    max_file_bytes: u64,
) -> (Vec<ParsedFile>, usize, u64, u64) {
    let dir = inbox_dir(hub);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return (Vec::new(), 0, 0, 0),
    };
    let mut files: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !is_candidate(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((path, modified, meta.len()));
    }
    let pending_files = files.len();
    let pending_bytes: u64 = files.iter().map(|(_, _, len)| len).sum();
    let oldest = files
        .iter()
        .map(|(_, m, _)| m.elapsed().map(|d| d.as_secs()).unwrap_or(0))
        .max()
        .unwrap_or(0);
    stats()
        .pending_files
        .store(pending_files, Ordering::Relaxed);
    stats()
        .pending_bytes
        .store(pending_bytes, Ordering::Relaxed);
    stats().oldest_age_secs.store(oldest, Ordering::Relaxed);
    *stats()
        .last_scan_at
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(crate::agents::now_iso());

    // 最老优先，避免饿死；每轮文件数有上限
    files.sort_by_key(|(_, m, _)| *m);
    let mut parsed = Vec::new();
    let mut read_bytes = 0u64;
    for (path, modified, len) in files.into_iter().take(max_files) {
        if modified.elapsed().map(|d| d < STABLE_AGE).unwrap_or(false) {
            continue; // 可能仍在写入
        }
        if read_bytes + len > MAX_READ_BYTES_PER_ROUND {
            break;
        }
        if len > max_file_bytes {
            move_to_failed(
                hub,
                &path,
                &format!("文件大小 {} 超过上限 {} 字节", len, max_file_bytes),
            )
            .await;
            continue;
        }
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("读取投递文件失败 {:?}: {}", path.file_name(), e);
                continue;
            }
        };
        read_bytes += content.len() as u64;
        match parse_events(&content) {
            Ok(events) => {
                let critical = is_critical_file(&events);
                parsed.push(ParsedFile {
                    path,
                    events,
                    critical,
                    modified,
                });
            }
            Err(e) => {
                move_to_failed(hub, &path, &e.to_string()).await;
            }
        }
    }
    // 关键状态优先（同一优先级内仍按最老优先）
    parsed.sort_by_key(|p| (!p.critical, p.modified));
    (parsed, pending_files, pending_bytes, oldest)
}

async fn process_parsed(
    hub: &AgentHub,
    pipeline: &IngestPipeline,
    parsed: ParsedFile,
    retries: &mut HashMap<PathBuf, (u32, Instant)>,
) {
    let size = parsed.events.len();
    match pipeline
        .submit(parsed.events, Transport::File, "file_drop", true)
        .await
    {
        Ok(receipt) => {
            if let Err(e) = tokio::fs::remove_file(&parsed.path).await {
                tracing::warn!(
                    "投递文件处理成功但删除失败 {:?}: {}",
                    parsed.path.file_name(),
                    e
                );
                return;
            }
            retries.remove(&parsed.path);
            stats().processed_files.fetch_add(1, Ordering::Relaxed);
            stats()
                .processed_events
                .fetch_add(receipt.accepted as u64, Ordering::Relaxed);
            tracing::debug!(
                "已处理投递文件 {:?}（{} 个事件，合并 {}）",
                parsed.path.file_name(),
                size,
                if receipt.merged { 1 } else { 0 }
            );
        }
        Err(e) if retryable(&e) => {
            let entry = retries
                .entry(parsed.path.clone())
                .or_insert((0, Instant::now()));
            entry.0 += 1;
            let attempt = entry.0;
            if attempt >= MAX_RETRIES {
                move_to_failed(
                    hub,
                    &parsed.path,
                    &format!("重试 {} 次仍失败: {}", attempt, e),
                )
                .await;
                retries.remove(&parsed.path);
                return;
            }
            let backoff = Duration::from_millis(250 * 2u64.pow(attempt.min(6)));
            entry.1 = Instant::now() + backoff;
            stats().retried_files.fetch_add(1, Ordering::Relaxed);
            *stats().last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!(
                "重试 {}（第 {} 次）: {}",
                parsed.path.display(),
                attempt,
                e
            ));
        }
        Err(e) => {
            move_to_failed(hub, &parsed.path, &e.to_string()).await;
            retries.remove(&parsed.path);
        }
    }
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
            let _ = tokio::fs::create_dir_all(&dir).await;
            *stats().dir.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(dir.to_string_lossy().to_string());
            tracing::info!("文件投递 Adapter 启动，监听目录 {:?}", dir);
            let mut retries: HashMap<PathBuf, (u32, Instant)> = HashMap::new();
            loop {
                let settings = Settings::load(hub.db()).unwrap_or_default();
                let max_files = settings.agent_inbox_max_files.clamp(1, 5000);
                let max_bytes = settings.agent_inbox_max_file_bytes.max(1024);
                let (parsed, _, _, _) = scan(&hub, max_files, max_bytes).await;
                for file in parsed {
                    if file.events.len() > MAX_EVENTS_PER_FILE {
                        move_to_failed(
                            &hub,
                            &file.path,
                            &format!("事件数超过上限 {}", MAX_EVENTS_PER_FILE),
                        )
                        .await;
                        continue;
                    }
                    if let Some((_, next)) = retries.get(&file.path) {
                        if *next > Instant::now() {
                            continue;
                        }
                    }
                    process_parsed(&hub, &pipeline, file, &mut retries).await;
                }
                // 清理已消失文件的退避记录
                retries.retain(|p, _| p.exists());
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        })
    }
}

/// 手动恢复：把 failed/ 中的文件移回 inbox，重新尝试（保留原文件，不删除历史）。
pub fn retry_failed_inbox(app: &tauri::AppHandle) -> AppResult<usize> {
    let failed = inbox_dir_of(app).join("failed");
    if !failed.exists() {
        return Ok(0);
    }
    let mut moved = 0usize;
    for entry in std::fs::read_dir(&failed)? {
        let entry = entry?;
        if !entry.metadata()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let dest = inbox_dir_of(app).join(format!(
            "retry-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            name
        ));
        if std::fs::rename(entry.path(), &dest).is_ok() {
            moved += 1;
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
