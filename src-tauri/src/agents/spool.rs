//! 退出超时/写失败事件的磁盘暂存与重启重放。
//!
//! 约束：
//! - 只在退出超时或批量写失败时写盘，正常路径零额外 IO；
//! - 每个暂存文件先写 `.tmp-*`、fsync 后原子改名，崩溃时不会留下半个文件；
//! - 事件保留原 `event_id`（若 Adapter 提供）与内容，**不伪造** event_id；
//!   无 event_id 的事件在重放时依赖内容签名幂等键，同样不会重复入库；
//! - 重放成功后删除文件；失败保留文件并停止后续文件，保持跨文件受理顺序；
//! - 损坏文件隔离到 `corrupt/`，不静默删除用户数据。

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::pipeline::IngestPipeline;
use super::{AgentEvent, Transport};
use crate::error::{AppError, AppResult};

pub const SPOOL_FORMAT: &str = "taskdock-spool";
pub const SPOOL_VERSION: u32 = 1;
const SPOOL_BATCH_EVENTS: usize = 500;
const REPLAY_BATCH_EVENTS: usize = 500;
const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Spool {
    dir: PathBuf,
}

#[derive(Serialize)]
struct FileHeader<'a> {
    record: &'a str,
    app: &'a str,
    format: &'a str,
    version: u32,
    tag: &'a str,
    saved_at: String,
    count: usize,
}

#[derive(Serialize, Deserialize)]
struct EventRecord {
    record: String,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    event: Option<AgentEvent>,
}

/// 重启重放结果（写入 `last-spool-replay.json` 供验收/诊断）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct SpoolReplayReport {
    pub files_found: usize,
    pub files_replayed: usize,
    pub files_quarantined: usize,
    pub events_replayed: usize,
    pub deduplicated: usize,
    pub failed_files: usize,
    pub stopped_early: bool,
    pub elapsed_ms: u64,
    pub errors: Vec<String>,
}

impl Spool {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 按批写入暂存文件（每文件 ≤500 事件），全部 fsync 后返回文件列表。
    pub fn write_batches(
        &self,
        items: &[(AgentEvent, Transport)],
        tag: &str,
    ) -> AppResult<Vec<PathBuf>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        std::fs::create_dir_all(&self.dir)?;
        let mut out = Vec::new();
        for (i, chunk) in items.chunks(SPOOL_BATCH_EVENTS).enumerate() {
            out.push(self.write_file(chunk, tag, i)?);
        }
        Ok(out)
    }

    fn write_file(
        &self,
        items: &[(AgentEvent, Transport)],
        tag: &str,
        seq: usize,
    ) -> AppResult<PathBuf> {
        let tag = sanitize_tag(tag);
        let stamp = chrono::Utc::now().timestamp_millis();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let name = format!("spool-{}-{}-{}-{}.jsonl", stamp, tag, seq, &id[..8]);
        let final_path = self.dir.join(&name);
        let tmp_path = self.dir.join(format!(".tmp-{}.jsonl", id));
        let write = || -> AppResult<()> {
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&tmp_path)?;
            let mut w = BufWriter::new(file);
            let header = FileHeader {
                record: "header",
                app: "task-dock",
                format: SPOOL_FORMAT,
                version: SPOOL_VERSION,
                tag: &tag,
                saved_at: super::now_iso(),
                count: items.len(),
            };
            serde_json::to_writer(&mut w, &header)?;
            w.write_all(b"\n")?;
            for (ev, tr) in items {
                let rec = EventRecord {
                    record: "event".into(),
                    transport: Some(tr.as_str().to_string()),
                    event: Some(ev.clone()),
                };
                serde_json::to_writer(&mut w, &rec)?;
                w.write_all(b"\n")?;
            }
            w.flush()?;
            let file = w.into_inner().map_err(|e| AppError::Io(e.into_error()))?;
            file.sync_all()?;
            std::fs::rename(&tmp_path, &final_path)?;
            Ok(())
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        Ok(final_path)
    }

    /// 待重放文件，按文件名（时间戳）升序。
    pub fn pending_files(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("spool-") && n.ends_with(".jsonl"))
                        .unwrap_or(false)
            })
            .collect();
        files.sort();
        files
    }

    pub fn pending_files_count(&self) -> usize {
        self.pending_files().len()
    }

    pub fn read_file(path: &Path) -> AppResult<Vec<(AgentEvent, Transport)>> {
        let file = File::open(path)?;
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(AppError::Validation("暂存文件为空".into()));
        }
        let header: serde_json::Value = serde_json::from_str(line.trim_end())
            .map_err(|e| AppError::Validation(format!("暂存文件头不是合法 JSON: {}", e)))?;
        if header.get("record").and_then(|v| v.as_str()) != Some("header")
            || header.get("format").and_then(|v| v.as_str()) != Some(SPOOL_FORMAT)
        {
            return Err(AppError::Validation("不是 Task Dock 事件暂存文件".into()));
        }
        let version = header.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
        if version != SPOOL_VERSION as u64 {
            return Err(AppError::Validation(format!(
                "不支持的暂存文件版本: {}",
                version
            )));
        }
        let expected = header.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let mut out = Vec::with_capacity(expected);
        let mut line_no = 1usize;
        loop {
            line.clear();
            let n = reader.read_line(&mut line)?;
            if n == 0 {
                break;
            }
            line_no += 1;
            if line.len() > MAX_LINE_BYTES {
                return Err(AppError::Validation(format!(
                    "暂存文件第 {} 行超过上限",
                    line_no
                )));
            }
            if line.trim().is_empty() {
                continue;
            }
            let rec: EventRecord = serde_json::from_str(line.trim_end()).map_err(|e| {
                AppError::Validation(format!("暂存文件第 {} 行非法: {}", line_no, e))
            })?;
            if rec.record != "event" {
                return Err(AppError::Validation(format!(
                    "暂存文件第 {} 行未知记录类型: {}",
                    line_no, rec.record
                )));
            }
            let transport = rec
                .transport
                .as_deref()
                .and_then(Transport::parse)
                .ok_or_else(|| {
                    AppError::Validation(format!("暂存文件第 {} 行通道非法", line_no))
                })?;
            let event = rec.event.ok_or_else(|| {
                AppError::Validation(format!("暂存文件第 {} 行缺少事件", line_no))
            })?;
            out.push((event, transport));
        }
        if out.len() != expected {
            return Err(AppError::Validation(format!(
                "暂存文件事件数与文件头不一致：期望 {}，实际 {}",
                expected,
                out.len()
            )));
        }
        Ok(out)
    }

    /// 把损坏文件移到 `corrupt/`，保留证据供人工检查。
    pub fn quarantine(&self, path: &Path) -> AppResult<PathBuf> {
        let dir = self.dir.join("corrupt");
        std::fs::create_dir_all(&dir)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown.jsonl");
        let mut dest = dir.join(name);
        if dest.exists() {
            dest = dir.join(format!("{}-{}.jsonl", name, uuid::Uuid::new_v4().simple()));
        }
        std::fs::rename(path, &dest)?;
        Ok(dest)
    }

    pub fn remove_file(path: &Path) -> AppResult<()> {
        std::fs::remove_file(path)?;
        Ok(())
    }
}

fn sanitize_tag(tag: &str) -> String {
    let cleaned: String = tag
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(24)
        .collect();
    if cleaned.is_empty() {
        "events".into()
    } else {
        cleaned
    }
}

/// 启动时重放全部暂存事件；成功文件删除，失败/损坏文件保留并报告。
pub async fn replay_pending(pipeline: &Arc<IngestPipeline>, spool: &Spool) -> SpoolReplayReport {
    let started = Instant::now();
    let files = spool.pending_files();
    let mut report = SpoolReplayReport {
        files_found: files.len(),
        ..Default::default()
    };
    let max_chunk = pipeline
        .config()
        .queue_capacity
        .clamp(1, REPLAY_BATCH_EVENTS);

    for path in files {
        let read_path = path.clone();
        let parsed = tokio::task::spawn_blocking(move || Spool::read_file(&read_path)).await;
        let items = match parsed {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                report.failed_files += 1;
                report.errors.push(format!(
                    "{}: {}",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                    e
                ));
                match spool.quarantine(&path) {
                    Ok(dest) => {
                        report.files_quarantined += 1;
                        report.errors.push(format!("已隔离到 {:?}", dest));
                    }
                    Err(move_err) => report.errors.push(format!("隔离失败: {}", move_err)),
                }
                continue;
            }
            Err(e) => {
                report.failed_files += 1;
                report.errors.push(format!("读取暂存文件任务失败: {}", e));
                break;
            }
        };

        let mut file_ok = true;
        let mut idx = 0usize;
        while idx < items.len() {
            let tr = items[idx].1;
            let mut end = idx + 1;
            while end < items.len() && items[end].1 == tr && end - idx < max_chunk {
                end += 1;
            }
            let chunk: Vec<AgentEvent> = items[idx..end].iter().map(|(e, _)| e.clone()).collect();
            match pipeline.submit(chunk, tr, "spool_replay", true).await {
                Ok(receipt) => {
                    report.events_replayed += receipt.accepted;
                    if let Some(outs) = &receipt.outcomes {
                        report.deduplicated += outs.iter().filter(|o| o.deduplicated).count();
                    }
                }
                Err(e) => {
                    file_ok = false;
                    report.failed_files += 1;
                    report.stopped_early = true;
                    report.errors.push(format!(
                        "{} 重放失败，保留文件等待下次启动: {}",
                        path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                        e
                    ));
                    break;
                }
            }
            idx = end;
        }
        if file_ok {
            match Spool::remove_file(&path) {
                Ok(()) => report.files_replayed += 1,
                Err(e) => {
                    report.failed_files += 1;
                    report
                        .errors
                        .push(format!("重放成功但删除暂存文件失败: {}", e));
                }
            }
        }
        if report.stopped_early {
            break;
        }
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::pipeline::{IngestPipeline, IngestSink, PipelineConfig};
    use crate::agents::{ingest_core, IngestOutcome};
    use crate::db::Db;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-spool-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ev(session: &str, state: &str) -> AgentEvent {
        AgentEvent {
            event_id: Some(format!("eid-{}-{}", session, state)),
            source_id: "codex".into(),
            session_id: session.into(),
            run_id: Some("r1".into()),
            state: state.into(),
            occurred_at: Some("2026-10-30T00:00:00Z".into()),
            ..Default::default()
        }
    }

    #[test]
    fn spool_roundtrip_preserves_event_transport_and_strips_ingest_seq() {
        let dir = temp_dir("roundtrip");
        let spool = Spool::new(dir.clone());
        let mut a = ev("s1", "running");
        a.ingest_seq = Some(42);
        let items = vec![
            (a, Transport::Http),
            (ev("s2", "completed"), Transport::File),
        ];
        let files = spool.write_batches(&items, "shutdown").unwrap();
        assert_eq!(files.len(), 1);
        let read = Spool::read_file(&files[0]).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].0.event_id.as_deref(), Some("eid-s1-running"));
        assert_eq!(read[0].1, Transport::Http);
        assert_eq!(read[1].1, Transport::File);
        assert!(
            read[0].0.ingest_seq.is_none(),
            "重放必须重新分配受理序号，不能沿用旧水位"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "原子写不得留下临时文件");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn spool_batches_split_at_500() {
        let dir = temp_dir("split");
        let spool = Spool::new(dir.clone());
        let items: Vec<(AgentEvent, Transport)> = (0..1200)
            .map(|i| (ev(&format!("s{}", i), "running"), Transport::Http))
            .collect();
        let files = spool.write_batches(&items, "shutdown").unwrap();
        assert_eq!(files.len(), 3);
        let total: usize = files
            .iter()
            .map(|f| Spool::read_file(f).unwrap().len())
            .sum();
        assert_eq!(total, 1200);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_spool_is_rejected_and_quarantined() {
        let dir = temp_dir("corrupt");
        let spool = Spool::new(dir.clone());
        let bad = dir.join("spool-1-bad-0-dead.jsonl");
        std::fs::write(
            &bad,
            "{\"record\":\"header\",\"app\":\"task-dock\",\"format\":\"taskdock-spool\",\"version\":1,\"tag\":\"x\",\"saved_at\":\"\",\"count\":2}\n{\"record\":\"event\"}\n",
        )
        .unwrap();
        let err = Spool::read_file(&bad).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let dest = spool.quarantine(&bad).unwrap();
        assert!(dest.exists());
        assert!(!bad.exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn truncated_spool_is_rejected() {
        let dir = temp_dir("truncated");
        let spool = Spool::new(dir.clone());
        let files = spool
            .write_batches(&[(ev("s1", "completed"), Transport::Http)], "shutdown")
            .unwrap();
        let text = std::fs::read_to_string(&files[0]).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        lines.truncate(1);
        std::fs::write(&files[0], lines.join("\n")).unwrap();
        assert!(Spool::read_file(&files[0]).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    struct DbSink {
        db: Arc<Db>,
    }

    impl IngestSink for DbSink {
        fn commit_events(
            &self,
            items: &[(AgentEvent, Transport)],
        ) -> AppResult<Vec<IngestOutcome>> {
            self.db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let mut outs = Vec::with_capacity(items.len());
                for (ev, tr) in items {
                    outs.push(ingest_core(&tx, ev, "2026-10-30T00:00:00+00:00", *tr)?);
                }
                tx.commit()?;
                Ok(outs)
            })
        }
        fn after_batch(&self, _events: &[AgentEvent], _outcomes: &[IngestOutcome]) {}
    }

    fn db_sink(db: &Arc<Db>, spool_dir: PathBuf) -> Arc<IngestPipeline> {
        IngestPipeline::new(
            Arc::new(DbSink { db: db.clone() }),
            PipelineConfig {
                queue_capacity: 256,
                batch_size: 100,
                coalesce_window: std::time::Duration::from_millis(5),
                enqueue_timeout: std::time::Duration::from_millis(500),
                ack_timeout: std::time::Duration::from_secs(5),
                merge_buffer_capacity: 32,
                shutdown_timeout: std::time::Duration::from_secs(2),
                spool_timeout: std::time::Duration::from_secs(2),
                spool_dir: Some(spool_dir),
                diagnostics: true,
            },
        )
    }

    fn count(db: &Db, sql: &str) -> i64 {
        db.with_conn(|conn| {
            conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                .map_err(AppError::from)
        })
        .unwrap()
    }

    /// 重启重放：已提交但客户端超时的事件按 event_id 幂等去重；旧 running 不得复活终态轮次；
    /// 新事件正常入库；不产生重复通知。
    #[tokio::test]
    async fn restart_replay_is_idempotent_and_does_not_resurrect_runs() {
        let dir = temp_dir("replay");
        let db = Arc::new(Db::open_in_memory().unwrap());
        let pipeline = db_sink(&db, dir.clone());
        pipeline.start_tokio();

        let running = AgentEvent {
            event_id: Some("ev-1".into()),
            source_id: "codex".into(),
            session_id: "s1".into(),
            run_id: Some("r1".into()),
            state: "running".into(),
            occurred_at: Some("2026-10-29T23:58:00Z".into()),
            ..Default::default()
        };
        let completed = AgentEvent {
            event_id: Some("ev-2".into()),
            occurred_at: Some("2026-10-29T23:59:00Z".into()),
            state: "completed".into(),
            ..running.clone()
        };
        let receipt = pipeline
            .submit(
                vec![running.clone(), completed.clone()],
                Transport::Http,
                "test",
                true,
            )
            .await
            .unwrap();
        let outcomes = receipt.outcomes.expect("等待提交必须返回结果");
        assert!(outcomes[1].notification.is_some(), "首次完成应产生通知");
        let run_row_id = outcomes[1].run_row_id.clone();
        let events_before = count(&db, "SELECT COUNT(*) FROM agent_events");
        let notes_before = count(&db, "SELECT COUNT(*) FROM notification_history");
        assert_eq!(events_before, 2);
        assert_eq!(notes_before, 1);

        // 模拟重启后重放：已提交的两条事件（客户端超时重试）+ 一条迟到 running + 一个新轮次。
        let old_running = AgentEvent {
            event_id: Some("ev-4".into()),
            occurred_at: Some("2026-10-29T23:58:30Z".into()),
            state: "running".into(),
            ..running.clone()
        };
        let new_run = AgentEvent {
            event_id: Some("ev-3".into()),
            session_id: "s2".into(),
            run_id: Some("r2".into()),
            state: "running".into(),
            occurred_at: Some("2026-10-30T00:01:00Z".into()),
            ..running.clone()
        };
        let spool = Spool::new(dir.clone());
        spool
            .write_batches(
                &[
                    (running, Transport::Http),
                    (completed, Transport::Http),
                    (old_running, Transport::Http),
                    (new_run, Transport::Http),
                ],
                "restart",
            )
            .unwrap();

        let report = replay_pending(&pipeline, &spool).await;
        assert_eq!(report.files_found, 1);
        assert_eq!(report.files_replayed, 1);
        assert_eq!(report.files_quarantined, 0);
        assert_eq!(report.failed_files, 0);
        assert_eq!(report.events_replayed, 4);
        assert_eq!(report.deduplicated, 2, "已提交事件重放必须幂等去重");
        assert!(
            spool.pending_files().is_empty(),
            "重放成功后必须删除暂存文件"
        );

        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_events"),
            events_before + 2,
            "去重事件不得重复入库，新事件/迟到事件各留一条流水"
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM notification_history"),
            notes_before,
            "重放不得产生重复通知"
        );
        let status: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM agent_runs WHERE id = ?1",
                    rusqlite::params![&run_row_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(status, "completed", "旧 running 重放不得复活已结束轮次");
        let run2: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM agent_runs WHERE external_run_id = 'r2'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(run2, "running");

        let shutdown = pipeline.shutdown().await;
        assert_eq!(shutdown.lifecycle, "stopped");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_failure_returns_error_and_leaves_no_temp() {
        let dir = temp_dir("fail");
        let blocker = dir.join("blocked");
        std::fs::write(&blocker, b"x").unwrap();
        let spool = Spool::new(blocker.join("spool"));
        let err = spool
            .write_batches(&[(ev("s1", "completed"), Transport::Http)], "shutdown")
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        std::fs::remove_dir_all(dir).ok();
    }
}
