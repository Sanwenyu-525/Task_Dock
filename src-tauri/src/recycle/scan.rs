//! 回收站索引扫描器：一次目录枚举 + 按需读取 `$I` 头部，绝不递归 `$R`。
//!
//! 同步策略（增量）：
//! 1. 枚举 `$Recycle.Bin\<SID>` 一遍，拿到 `$I` 列表（名字/长度/修改时间）与
//!    `$R` 存在性/是否目录——Windows 的 `FindNextFileW` 已返回这些属性，
//!    不再对每个条目单独 `stat`；
//! 2. 与数据库中的 `(meta_len, meta_mtime)` 指纹比较：**只有新增/变化的
//!    `$I` 才打开读取**；
//! 3. 数据库中已有但磁盘上不存在的记录 → 删除索引行；
//! 4. 分批事务写入（400 条/批），每批回调进度；取消只在批次之间生效。
//!
//! 该流程在 13 万条记录上只需一遍目录枚举 + 少量文件读取，避免旧实现
//! 递归遍历 `$R` 目录树、读取全部数据导致的分钟级耗时。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use super::index::{self, IndexItem, STATE_MISSING_DATA, STATE_PRESENT, STATE_UNREADABLE};
use super::meta::{self, MAX_META_BYTES};
use super::volume::BinVolume;
use crate::error::{AppError, AppResult};

/// 每批写入条数：与 `MAX_OP_PATHS=500` 同量级，单事务耗时可忽略。
const WRITE_BATCH: usize = 400;

/// 枚举阶段回调间隔（条目数）。
const PROGRESS_STEP: usize = 2000;

/// `$I` 头部并行读取线程数。本机实测单文件读取约 3–5ms（杀软参与时更高），
/// 4 线程已接近饱和；只在待读条目足够多时启用，避免小回收站付出线程开销。
const META_READ_WORKERS: usize = 4;
const META_READ_PARALLEL_MIN: usize = 256;
const META_READ_QUEUE: usize = 128;

/// `$R` 存在但 `$I` 缺失：索引得到条目，但原始路径/删除时间不可知。
const ANOMALY_ORPHAN_DATA: &str = "ORPHAN_DATA";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanPhase {
    Enumerating,
    Reading,
    Writing,
    Verifying,
    Done,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub volume: String,
    pub phase: ScanPhase,
    pub done: usize,
    pub total: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutcome {
    pub volume: String,
    /// ok | partial | offline | error
    pub state: String,
    pub items: i64,
    pub known_bytes: i64,
    pub unknown_size: i64,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unreadable: usize,
    pub missing_data: usize,
    pub duration_ms: u64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl ScanOutcome {
    fn failed(volume: &str, code: &str, message: String, started: Instant) -> Self {
        Self {
            volume: volume.to_string(),
            state: if code == "NOT_FOUND" || code == "OFFLINE" {
                "offline".into()
            } else {
                "error".into()
            },
            items: 0,
            known_bytes: 0,
            unknown_size: 0,
            added: 0,
            updated: 0,
            removed: 0,
            unreadable: 0,
            missing_data: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            error_code: Some(code.to_string()),
            error_message: Some(message),
        }
    }
}

/// 第一阶段筛出的待读条目：第二阶段由工作线程并行读取 `$I` 头部。
struct PendingMetaRead {
    key: String,
    meta_len: i64,
    meta_mtime: i64,
    has_data: bool,
    is_dir: bool,
}

struct DirSnapshot {
    /// `$I` 文件名 → (长度, 修改时间毫秒)
    meta_files: HashMap<String, (i64, i64)>,
    /// `$R` 后缀 → 是否目录
    data_entries: HashMap<String, bool>,
}

fn snapshot_dir(root: &Path, cancel: &AtomicBool, progress: &dyn Fn(usize)) -> std::io::Result<DirSnapshot> {
    let mut meta_files = HashMap::new();
    let mut data_entries = HashMap::new();
    let mut enumerated = 0;
    progress(0);
    for entry in fs::read_dir(root)? {
        if cancel.load(Ordering::Relaxed) { break; }
        // 不完整枚举不能拿去做差集删除：任一读取失败均保留旧索引等待下一轮。
        let entry = entry?;
        enumerated += 1;
        if enumerated % PROGRESS_STEP == 0 { progress(enumerated); }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(suffix) = name.strip_prefix("$I") {
            // `$I` 必须是普通文件；目录/重解析点不是元数据记录。
            match entry.file_type()? {
                kind if kind.is_file() && !kind.is_symlink() => {}
                _ => continue,
            }
            let (len, mtime_ms) = match entry.metadata() {
                Ok(md) => (
                    md.len() as i64,
                    md.modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                ),
                Err(error) => return Err(error),
            };
            meta_files.insert(suffix.to_string(), (len, mtime_ms));
        } else if let Some(suffix) = name.strip_prefix("$R") {
            let is_dir = entry.file_type()?.is_dir();
            data_entries.insert(suffix.to_string(), is_dir);
        }
    }
    Ok(DirSnapshot {
        meta_files,
        data_entries,
    })
}

/// 整卷清空成功后，把 Shell 留下的孤立元数据与清理索引一起提交。
pub fn reconcile_empty(conn: &Connection, volume: &BinVolume) -> AppResult<()> {
    let snapshot = snapshot_dir(&volume.root, &AtomicBool::new(false), &|_| {})?;
    if snapshot.meta_files.keys().any(|key| snapshot.data_entries.contains_key(key)) {
        return Err(AppError::Conflict("回收站仍有条目，请重新同步".into()));
    }
    let bin_root = volume.root.to_string_lossy();
    let tx = conn.unchecked_transaction()?;
    {
        // 先为索引中已有的每条记录写墓碑：清空时这些 `$I`/`$R` 已被 Shell 删除，
        // 清空前启动的旧扫描快照仍可能带着它们回来，墓碑会阻止写回。
        tx.execute(
            "INSERT OR REPLACE INTO recycle_restored_metadata
             SELECT bin_root, record_key, meta_len, meta_mtime_ms FROM recycle_index
             WHERE bin_root = ?1",
            [bin_root.as_ref()],
        )?;
        let mut insert = tx.prepare(
            "INSERT OR REPLACE INTO recycle_restored_metadata
             (bin_root, record_key, meta_len, meta_mtime_ms) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (key, (len, mtime)) in snapshot.meta_files {
            insert.execute(rusqlite::params![bin_root.as_ref(), key, len, mtime])?;
        }
    }
    index::clear_volume(&tx, &bin_root)?;
    index::set_state(&tx, &bin_root, &volume.volume, "ok", 0, 0, 0, None,
        chrono::Utc::now().timestamp_millis())?;
    tx.execute(
        "UPDATE recycle_volume_state SET system_items = NULL, system_bytes = NULL,
         system_checked_ms = NULL WHERE bin_root = ?1", [bin_root.as_ref()],
    )?;
    tx.commit()?;
    Ok(())
}

fn read_meta_header(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut buf = vec![0u8; MAX_META_BYTES];
    let mut filled = 0usize;
    loop {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                if filled == buf.len() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

/// 增量同步一个卷。`progress` 在批次之间回调；`cancel` 置位后停止，
/// 已完成批次保留（索引仍可用），不执行删除阶段。
pub fn scan_volume(
    conn: &Connection,
    volume: &BinVolume,
    cancel: &AtomicBool,
    progress: &(dyn Fn(ScanProgress) + Sync),
) -> AppResult<ScanOutcome> {
    let started = Instant::now();
    let bin_root = volume.root.to_string_lossy().into_owned();
    let label = volume.volume.clone();

    index::mark_scanning(conn, &bin_root, &label)?;

    let tombstones = index::tombstone_fingerprints(conn, &bin_root)?;
    let snapshot = match snapshot_dir(&volume.root, cancel, &|done| progress(ScanProgress {
        volume: label.clone(), phase: ScanPhase::Enumerating, done, total: 0,
        added: 0, updated: 0, removed: 0,
    })) {
        Ok(snapshot) => snapshot,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::NotFound {
                "NOT_FOUND"
            } else if e.kind() == std::io::ErrorKind::PermissionDenied {
                "ACCESS_DENIED"
            } else {
                "IO"
            };
            index::set_state(
                conn,
                &bin_root,
                &label,
                if code == "NOT_FOUND" { "offline" } else { "error" },
                0,
                0,
                0,
                Some(code),
                chrono::Utc::now().timestamp_millis(),
            )?;
            return Ok(ScanOutcome::failed(&label, code, e.to_string(), started));
        }
    };
    let total = snapshot.meta_files.len();
    progress(ScanProgress {
        volume: label.clone(),
        phase: ScanPhase::Enumerating,
        done: total,
        total,
        added: 0,
        updated: 0,
        removed: 0,
    });

    let known = index::existing_fingerprints(conn, &bin_root)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut seen: HashSet<String> = HashSet::with_capacity(total);
    let mut batch: Vec<IndexItem> = Vec::with_capacity(WRITE_BATCH);
    let mut added = 0usize;
    let mut updated = 0usize;
    let unreadable: usize;
    let missing_data: usize;
    let mut processed = 0usize;
    let mut cancelled = cancel.load(Ordering::Relaxed);

    // 第一阶段（无 IO）：只筛选「新增 / 指纹变化」的条目。未变化的直接跳过读取，
    // 这是增量同步的主要提速点；同时把 `seen` 填满，供后面的删除阶段使用。
    let mut pending: Vec<PendingMetaRead> = Vec::with_capacity(total);
    for (key, (meta_len, meta_mtime)) in &snapshot.meta_files {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let has_data = snapshot.data_entries.contains_key(key);
        // 墓碑命中（指纹一致）说明该条已被本应用成功恢复/永久删除，而当前快照
        // 可能早于那次操作：整条跳过，不写回索引也不产生孤儿记录。
        if tombstones.get(key) == Some(&(*meta_len, *meta_mtime)) {
            processed += 1;
            continue;
        }
        seen.insert(key.clone());
        let is_dir = snapshot.data_entries.get(key).copied().unwrap_or(false);
        let state_hint = if !has_data {
            STATE_MISSING_DATA
        } else {
            STATE_PRESENT
        };
        let unchanged = known
            .get(key)
            .map(|fp| {
                fp.meta_len == *meta_len
                    && fp.meta_mtime_ms == *meta_mtime
                    && fp.state == state_hint
                    && fp.is_dir == is_dir
            })
            .unwrap_or(false);
        if unchanged {
            processed += 1;
            continue;
        }
        pending.push(PendingMetaRead {
            key: key.clone(),
            meta_len: *meta_len,
            meta_mtime: *meta_mtime,
            has_data,
            is_dir,
        });
    }

    // 第二阶段：`$I` 头部读取是纯文件 IO（本机实测单文件 3–5ms，杀软参与时更高），
    // 16 万条串行要 20 分钟；改为固定 4 线程有界并行读取，SQLite 仍只由主线程写入。
    if !pending.is_empty() {
        let workers = if pending.len() >= META_READ_PARALLEL_MIN {
            META_READ_WORKERS
        } else {
            1
        };
        let (sender, receiver) =
            std::sync::mpsc::sync_channel::<(usize, std::io::Result<Vec<u8>>)>(META_READ_QUEUE);
        let cursor = AtomicUsize::new(0);
        std::thread::scope(|scope| -> AppResult<()> {
            for _ in 0..workers {
                let sender = sender.clone();
                let pending_ref = &pending;
                let root = &volume.root;
                let cursor_ref = &cursor;
                scope.spawn(move || loop {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let index = cursor_ref.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = pending_ref.get(index) else {
                        break;
                    };
                    let bytes = read_meta_header(&root.join(format!("$I{}", item.key)));
                    if sender.send((index, bytes)).is_err() {
                        break;
                    }
                });
            }
            drop(sender);
            for (index, bytes) in receiver {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let Some(item) = pending.get(index) else {
                    continue;
                };
                processed += 1;
                let parsed = match &bytes {
                    Ok(bytes) => meta::parse_meta(bytes, now_ms),
                    Err(_) => meta::ParsedMeta {
                        original_path: String::new(),
                        size: 0,
                        deleted_ms: 0,
                        version: 0,
                        anomaly: Some(meta::ANOMALY_TRUNCATED),
                    },
                };
                // 瞬时读取失败（被占用 / 杀软扫描 / 权限抖动）不得覆盖已有可用缓存：
                // 那会把「用户看得到的文件名和原始路径」变成不可恢复的孤儿记录。
                // 指纹已变化，下一轮同步会自动重试；真正的损坏（读取成功但解析失败）仍照旧登记。
                if bytes.is_err() {
                    if let Some(fingerprint) = known.get(&item.key) {
                        if fingerprint.state != STATE_UNREADABLE {
                            continue;
                        }
                    }
                }
                let meta_unreadable = bytes.is_err()
                    || parsed.original_path.is_empty()
                    || matches!(
                        parsed.anomaly,
                        Some(meta::ANOMALY_TRUNCATED)
                            | Some(meta::ANOMALY_BAD_VERSION)
                            | Some(meta::ANOMALY_BAD_PATH)
                            | Some(meta::ANOMALY_PATH_TOO_LONG)
                            | Some(meta::ANOMALY_EMPTY_PATH)
                    );
                let file_name = if parsed.original_path.is_empty() {
                    // 元数据不可读时至少保留稳定标识；不要把内部 `$R` 前缀展示给用户。
                    item.key.clone()
                } else {
                    meta::file_name_of(&parsed.original_path)
                };
                let state = if meta_unreadable {
                    STATE_UNREADABLE
                } else if !item.has_data {
                    STATE_MISSING_DATA
                } else {
                    STATE_PRESENT
                };
                batch.push(IndexItem {
                    record_key: item.key.clone(),
                    data_name: format!("$R{}", item.key),
                    volume: label.clone(),
                    original_path: parsed.original_path,
                    file_name,
                    is_dir: item.is_dir,
                    size: parsed.size.min(i64::MAX as u64) as i64,
                    // 目录的 `$I` 大小时常为 0；损坏元数据的 size 同样不可信，
                    // 都不能伪装成「0 字节」。
                    size_known: !item.is_dir && !meta_unreadable,
                    deleted_ms: parsed.deleted_ms,
                    state: state.to_string(),
                    anomaly: parsed.anomaly.map(str::to_string),
                    meta_len: item.meta_len,
                    meta_mtime_ms: item.meta_mtime,
                });
                if known.contains_key(&item.key) {
                    updated += 1;
                } else {
                    added += 1;
                }
                if batch.len() >= WRITE_BATCH {
                    index::upsert_items(conn, &bin_root, &batch)?;
                    batch.clear();
                    progress(ScanProgress {
                        volume: label.clone(),
                        phase: ScanPhase::Writing,
                        done: processed,
                        total,
                        added,
                        updated,
                        removed: 0,
                    });
                }
                if processed % PROGRESS_STEP == 0 {
                    progress(ScanProgress {
                        volume: label.clone(),
                        phase: ScanPhase::Reading,
                        done: processed,
                        total,
                        added,
                        updated,
                        removed: 0,
                    });
                }
            }
            Ok(())
        })?;
    }
    // `$R` 有数据但 `$I` 缺失：不猜测原始路径，也不递归读取目录，只登记为不可读孤儿。
    // 这样统计不会漏项，恢复入口会因 state=unreadable 被拒绝。
    for (key, is_dir) in &snapshot.data_entries {
        if snapshot.meta_files.contains_key(key) {
            continue;
        }
        seen.insert(key.clone());
        // 已登记且未变化的孤儿条目：不重复写库。
        // 旧实现每次同步都无条件 upsert 全部孤儿，10 万条规模下会造成无谓写入与
        // 「updated」统计虚高（每次同步都显示更新了几千条）。
        if let Some(fingerprint) = known.get(key) {
            if fingerprint.state == STATE_UNREADABLE
                && fingerprint.meta_len == 0
                && fingerprint.meta_mtime_ms == 0
                && fingerprint.is_dir == *is_dir
            {
                continue;
            }
        }
        if known.contains_key(key) {
            updated += 1;
        } else {
            added += 1;
        }
        batch.push(IndexItem {
            record_key: key.clone(),
            data_name: format!("$R{key}"),
            volume: label.clone(),
            original_path: String::new(),
            file_name: key.clone(),
            is_dir: *is_dir,
            size: 0,
            size_known: false,
            deleted_ms: 0,
            state: STATE_UNREADABLE.into(),
            anomaly: Some(ANOMALY_ORPHAN_DATA.into()),
            meta_len: 0,
            meta_mtime_ms: 0,
        });
        if batch.len() >= WRITE_BATCH {
            index::upsert_items(conn, &bin_root, &batch)?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        index::upsert_items(conn, &bin_root, &batch)?;
    }

    let mut removed = 0usize;
    if !cancelled {
        let stale: Vec<String> = known
            .keys()
            .filter(|key| !seen.contains(*key))
            .cloned()
            .collect();
        removed = index::delete_records(conn, &bin_root, &stale)?;
        let expired = tombstones.iter()
            .filter(|(key, fingerprint)| snapshot.meta_files.get(*key) != Some(*fingerprint))
            .collect();
        index::forget_tombstones(conn, &bin_root, expired)?;
    }

    let (items, known_bytes, unknown_size, unreadable_count, missing_count): (i64, i64, i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*), \
         COALESCE(SUM(CASE WHEN size_known = 1 THEN size ELSE 0 END), 0), \
         COALESCE(SUM(CASE WHEN size_known = 0 THEN 1 ELSE 0 END), 0), \
         COALESCE(SUM(CASE WHEN state = 'unreadable' THEN 1 ELSE 0 END), 0), \
         COALESCE(SUM(CASE WHEN state = 'missing_data' THEN 1 ELSE 0 END), 0) \
         FROM recycle_index WHERE bin_root = ?1",
        rusqlite::params![bin_root],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    unreadable = unreadable_count as usize;
    missing_data = missing_count as usize;
    let state = if cancelled { "partial" } else { "ok" };
    index::set_state(
        conn,
        &bin_root,
        &label,
        state,
        items,
        known_bytes,
        unknown_size,
        None,
        now_ms,
    )?;
    progress(ScanProgress {
        volume: label.clone(),
        phase: ScanPhase::Done,
        done: processed,
        total,
        added,
        updated,
        removed,
    });

    Ok(ScanOutcome {
        volume: label,
        state: state.into(),
        items,
        known_bytes,
        unknown_size,
        added,
        updated,
        removed,
        unreadable,
        missing_data,
        duration_ms: started.elapsed().as_millis() as u64,
        error_code: None,
        error_message: None,
    })
}

/// 只在测试中使用的辅助：把 `$I` 目录快照读成索引条目（不写库）。
#[cfg(test)]
pub fn build_items_for_test(dir: &Path, volume: &str) -> AppResult<Vec<IndexItem>> {
    let snapshot = snapshot_dir(dir, &AtomicBool::new(false), &|_| {}).map_err(AppError::Io)?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut out = Vec::new();
    for (key, (len, mtime)) in snapshot.meta_files {
        let path: PathBuf = dir.join(format!("$I{key}"));
        let bytes = read_meta_header(&path).map_err(AppError::Io)?;
        let parsed = meta::parse_meta(&bytes, now_ms);
        let is_dir = snapshot.data_entries.get(&key).copied().unwrap_or(false);
        out.push(IndexItem {
            record_key: key.clone(),
            data_name: format!("$R{key}"),
            volume: volume.into(),
            file_name: meta::file_name_of(&parsed.original_path),
            original_path: parsed.original_path,
            is_dir,
            size: parsed.size as i64,
            size_known: !is_dir,
            deleted_ms: parsed.deleted_ms,
            state: STATE_PRESENT.into(),
            anomaly: parsed.anomaly.map(str::to_string),
            meta_len: len,
            meta_mtime_ms: mtime,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod perf_tests {
    use super::*;

    #[test]
    fn empty_reconciliation_keeps_live_pairs_and_hides_only_residual_metadata() {
        let root = std::env::temp_dir().join(format!("td-recycle-empty-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("$Itest"), []).unwrap();
        fs::write(root.join("$Rtest"), []).unwrap();
        let volume = BinVolume { volume: "T:".into(), root: root.clone(), drive_root: "T:\\".into() };
        let conn = Connection::open_in_memory().unwrap();
        index::init_schema(&conn).unwrap();
        let bin_root = root.to_str().unwrap();
        assert!(reconcile_empty(&conn, &volume).is_err());
        assert!(index::tombstone_fingerprints(&conn, bin_root).unwrap().is_empty());
        fs::remove_file(root.join("$Rtest")).unwrap();
        reconcile_empty(&conn, &volume).unwrap();
        assert!(index::tombstone_fingerprints(&conn, bin_root).unwrap().contains_key("test"));
        let outcome = scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(outcome.items, 0);
        fs::remove_file(root.join("$Itest")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn backend_round2_cancel_during_enumeration_keeps_old_index() {
        let root = std::env::temp_dir().join(format!("td-recycle-enum-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for i in 0..(PROGRESS_STEP + 10) { fs::write(root.join(format!("entry-{i}")), []).unwrap(); }
        let conn = Connection::open_in_memory().unwrap();
        index::init_schema(&conn).unwrap();
        let bin_root = root.to_string_lossy().into_owned();
        index::upsert_items(&conn, &bin_root, &[IndexItem {
            record_key: "old".into(), data_name: "$Rold".into(), volume: "T:".into(),
            original_path: "T:\\original.txt".into(), file_name: "original.txt".into(),
            is_dir: false, size: 3, size_known: true, deleted_ms: 1,
            state: STATE_PRESENT.into(), anomaly: None, meta_len: 0, meta_mtime_ms: 0,
        }]).unwrap();
        let volume = BinVolume { volume: "T:".into(), root: root.clone(), drive_root: "T:\\".into() };
        let cancel = AtomicBool::new(false);
        let outcome = scan_volume(&conn, &volume, &cancel, &|p| {
            if p.phase == ScanPhase::Enumerating && p.done >= PROGRESS_STEP {
                cancel.store(true, Ordering::SeqCst);
            }
        }).unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        assert_eq!(outcome.state, "partial");
        assert_eq!(outcome.removed, 0);
        assert_eq!(outcome.items, 1);
        assert_eq!(index::page(&conn, &index::RecycleQuery::default()).unwrap().total, 1);
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    use crate::recycle::index::{self, RecycleQuery};

    fn ms(started: Instant) -> f64 {
        started.elapsed().as_secs_f64() * 1000.0
    }

    fn measure_pages(conn: &Connection, tag: &str, total: i64) {
        let mut first = RecycleQuery::default();
        first.limit = 100;
        first.include_stats = true;
        let started = Instant::now();
        let page = index::page(conn, &first).expect("page first");
        println!(
            "MEASURE page[{tag}] first+stats total={} items={} ms={:.1}",
            page.total,
            page.items.len(),
            ms(started)
        );

        let mut deep = RecycleQuery::default();
        deep.limit = 100;
        // 深分页取总量中点，避免固定 offset 在小于 10 万时直接为空。
        deep.offset = (total.max(0) as usize) / 2;
        deep.include_stats = false;
        let started = Instant::now();
        let page = index::page(conn, &deep).expect("page deep");
        println!(
            "MEASURE page[{tag}] offset={} items={} ms={:.1}",
            deep.offset,
            page.items.len(),
            ms(started)
        );

        let mut search = RecycleQuery::default();
        search.search = "文件1".into();
        search.limit = 100;
        search.include_stats = false;
        let started = Instant::now();
        let page = index::page(conn, &search).expect("page search");
        println!(
            "MEASURE page[{tag}] search=文件1 hits={} items={} ms={:.1}",
            page.total,
            page.items.len(),
            ms(started)
        );

        let mut by_size = RecycleQuery::default();
        by_size.sort = "size".into();
        by_size.limit = 100;
        by_size.include_stats = false;
        let started = Instant::now();
        let page = index::page(conn, &by_size).expect("page size");
        println!(
            "MEASURE page[{tag}] sort=size items={} ms={:.1}",
            page.items.len(),
            ms(started)
        );
    }

    /// 真机大回收站测量：只读 `$I` 元数据，索引写入临时库，输出仅计数与耗时。
    /// 需显式开启：`TD_REAL_RECYCLE_MEASURE=1`，可用 `TD_REAL_RECYCLE_VOLUME=D:` 指定卷。
    #[test]
    #[ignore = "真机 10 万条回收站性能测量，需 TD_REAL_RECYCLE_MEASURE=1"]
    fn real_bin_scale_measurement() {
        if std::env::var("TD_REAL_RECYCLE_MEASURE").as_deref() != Ok("1") {
            println!("MEASURE skipped: TD_REAL_RECYCLE_MEASURE!=1");
            return;
        }
        let want = std::env::var("TD_REAL_RECYCLE_VOLUME").unwrap_or_else(|_| "D:".to_string());
        let db_path = std::env::temp_dir().join(format!(
            "taskdock-recycle-measure-{}.db",
            std::process::id()
        ));
        let _ = fs::remove_file(&db_path);
        let conn = Connection::open(&db_path).expect("open temp db");
        index::init_schema(&conn).expect("schema");

        let volumes = match crate::recycle::volume::bin_volumes() {
            Ok(volumes) => volumes,
            Err((code, message)) => {
                println!("MEASURE bin_volumes error code={code} msg={message}");
                return;
            }
        };
        for volume in volumes {
            if volume.volume != want {
                continue;
            }
            let cancel = AtomicBool::new(false);
            let started = Instant::now();
            let outcome = scan_volume(&conn, &volume, &cancel, &|_p| {}).expect("scan");
            println!(
                "MEASURE scan[{want}] first state={} items={} added={} updated={} removed={} unreadable={} missing_data={} known_bytes={} unknown_size={} internal_ms={} wall_ms={:.1}",
                outcome.state,
                outcome.items,
                outcome.added,
                outcome.updated,
                outcome.removed,
                outcome.unreadable,
                outcome.missing_data,
                outcome.known_bytes,
                outcome.unknown_size,
                outcome.duration_ms,
                ms(started)
            );
            measure_pages(&conn, "first", outcome.items);

            let started = Instant::now();
            let again = scan_volume(&conn, &volume, &cancel, &|_p| {}).expect("scan again");
            println!(
                "MEASURE scan[{want}] second items={} added={} updated={} removed={} unreadable={} internal_ms={} wall_ms={:.1}",
                again.items,
                again.added,
                again.updated,
                again.removed,
                again.unreadable,
                again.duration_ms,
                ms(started)
            );
            measure_pages(&conn, "cached", again.items);
        }

        let db_bytes = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
        println!("MEASURE db_bytes={db_bytes}");
        drop(conn);
        let _ = fs::remove_file(&db_path);
        let _ = fs::remove_file(db_path.with_extension("db-wal"));
        let _ = fs::remove_file(db_path.with_extension("db-shm"));
    }

    // ── 合成规模测量（1 万 / 4 万 / 10 万）─────────────────────────────
    //
    // 约束：不为 10 万条创建真实 80GB 数据。1 万 / 4 万用真实 `$I`/`$R`
    // 小文件覆盖完整扫描链路；10 万走索引模拟（只写 SQLite），用于验证
    // 缓存加载、分页、搜索、排序、库体积与批处理吞吐。

    #[cfg(windows)]
    fn process_peak_working_set() -> u64 {
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = unsafe {
            GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                counters.cb,
            )
        };
        if ok == 0 {
            0
        } else {
            counters.PeakWorkingSetSize as u64
        }
    }

    #[cfg(not(windows))]
    fn process_peak_working_set() -> u64 {
        0
    }

    /// 生成一条合法 v2 `$I` 头（version/size/FILETIME/path）。
    fn meta_bytes(original: &str, size: u64, deleted_ms: i64) -> Vec<u8> {
        let mut path: Vec<u16> = original.encode_utf16().collect();
        path.push(0);
        let filetime = ((deleted_ms + 11_644_473_600_000) * 10_000) as u64;
        let mut out = Vec::with_capacity(28 + path.len() * 2);
        out.extend_from_slice(&2u64.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&filetime.to_le_bytes());
        out.extend_from_slice(&(path.len() as u32).to_le_bytes());
        for unit in path {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    fn synthetic_bin(count: usize) -> PathBuf {
        let root = std::env::temp_dir().join(format!("taskdock-scale-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for index in 0..count {
            let key = format!("S{index:07}");
            let original = format!(r"D:\scale\目录{index}\文件{index}.bin");
            fs::write(root.join(format!("$I{key}")), meta_bytes(&original, 4096, now_ms - index as i64 * 1000)).unwrap();
            fs::write(root.join(format!("$R{key}")), []).unwrap();
        }
        root
    }

    fn simulated_index(db_path: &Path, count: usize) {
        let conn = Connection::open(db_path).expect("open scale db");
        index::init_schema(&conn).expect("schema");
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for chunk_start in (0..count).step_by(2_000) {
            let batch: Vec<IndexItem> = (chunk_start..(chunk_start + 2_000).min(count))
                .map(|index| IndexItem {
                    record_key: format!("S{index:07}"),
                    data_name: format!("$RS{index:07}"),
                    volume: "D:".into(),
                    original_path: format!(r"D:\scale\目录{index}\文件{index}.bin"),
                    file_name: format!("文件{index}.bin"),
                    is_dir: index % 7 == 0,
                    size: (index as i64 % 1_000_000) + 1,
                    size_known: index % 7 != 0,
                    deleted_ms: now_ms - index as i64 * 1000,
                    state: STATE_PRESENT.into(),
                    anomaly: None,
                    meta_len: 90,
                    meta_mtime_ms: 10,
                })
                .collect();
            index::upsert_items(&conn, r"D:\$Recycle.Bin\S-1", &batch).expect("upsert");
        }
    }

    fn measure_scales(tag: &str, db_path: &Path, volume: &str) {
        let started = Instant::now();
        // 库表已在写入阶段建立；这里只模拟「冷启动」重新打开连接。
        let conn = Connection::open(db_path).expect("open cold");
        let stats = index::stats(&conn).expect("stats");
        let first = index::page(&conn, &index::RecycleQuery::default()).expect("first page");
        println!(
            "MEASURE cache[{tag}] cold_open+stats+first_page items={} page_items={} ms={:.1}",
            stats.items,
            first.items.len(),
            ms(started)
        );
        measure_pages(&conn, tag, stats.items);
        let db_bytes = fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);
        println!("MEASURE db_bytes[{tag}] bytes={db_bytes}");
        println!(
            "MEASURE memory[{tag}] peak_working_set_bytes={}",
            process_peak_working_set()
        );
        // 批量操作吞吐：解析 + 墓碑写入（每项独立事务，与真实任务一致）。
        let total = stats.items.max(0) as usize;
        if total > 0 {
            let ids: Vec<String> = (0..total.min(20_000))
                .map(|index| format!("{volume}|S{index:07}"))
                .collect();
            let started = Instant::now();
            let resolved = index::resolve(&conn, &ids).expect("resolve");
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "MEASURE batch[{tag}] resolve_requested={} resolved={} ms={:.1} per_sec={:.0}",
                ids.len(),
                resolved.items.len(),
                elapsed * 1000.0,
                ids.len() as f64 / elapsed.max(0.000_001)
            );
            let started = Instant::now();
            let mut removed = 0usize;
            // 与生产任务一致的 40 项/批单事务写入。
            let keys: Vec<(String, String)> = resolved
                .items
                .iter()
                .take(5_000)
                .map(|item| (item.bin_root.clone(), item.record_key.clone()))
                .collect();
            for chunk in keys.chunks(40) {
                removed += index::mark_removed_batch(&conn, chunk).expect("tombstone batch");
            }
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "MEASURE batch[{tag}] tombstone_writes={} ms={:.1} per_sec={:.0}",
                removed,
                elapsed * 1000.0,
                removed as f64 / elapsed.max(0.000_001)
            );
        }
    }

    /// 对账：系统侧删除成功但索引写入失败（进程异常退出）后，
    /// 下一次扫描按真实 `$I`/`$R` 状态移除陈旧记录。
    #[test]
    fn scan_reconciles_stale_index_after_missing_cache_write() {
        let root = std::env::temp_dir().join(format!("td-reconcile-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("$Ikeep"), meta_bytes(r"D:\keep\a.txt", 5, 1_700_000_000_000)).unwrap();
        fs::write(root.join("$Rkeep"), b"hello").unwrap();
        let volume = BinVolume { volume: "T:".into(), root: root.clone(), drive_root: "T:\\".into() };
        let conn = Connection::open_in_memory().unwrap();
        index::init_schema(&conn).unwrap();
        let first = scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(first.items, 1);
        // 模拟「系统已删除 $I/$R，但索引删除没有落库」。
        fs::remove_file(root.join("$Ikeep")).unwrap();
        fs::remove_file(root.join("$Rkeep")).unwrap();
        let second = scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(second.items, 0);
        assert_eq!(second.removed, 1);
        let stats = index::stats(&conn).unwrap();
        assert_eq!(stats.items, 0);
        fs::remove_dir_all(root).unwrap();
    }

    /// 旧扫描快照不得复活已被本应用恢复/永久删除的条目。
    #[test]
    fn scan_ignores_stale_snapshot_for_tombstoned_entry() {
        let root = std::env::temp_dir().join(format!("td-stale-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("$Igone"), meta_bytes(r"D:\gone\a.txt", 5, 1_700_000_000_000)).unwrap();
        fs::write(root.join("$Rgone"), b"hello").unwrap();
        let volume = BinVolume { volume: "T:".into(), root: root.clone(), drive_root: "T:\\".into() };
        let conn = Connection::open_in_memory().unwrap();
        index::init_schema(&conn).unwrap();
        scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        let bin_root = root.to_string_lossy().into_owned();
        // 系统操作成功：写墓碑 + 删除索引行。
        index::mark_removed(&conn, &bin_root, "gone").unwrap();
        // 旧快照仍带着同一个 `$I` 指纹（模拟扫描先于操作开始、写入晚于操作）。
        let again = scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(again.items, 0, "墓碑命中的旧快照不得写回索引");
        assert_eq!(index::page(&conn, &index::RecycleQuery::default()).unwrap().total, 0);
        fs::remove_dir_all(root).unwrap();
    }

    /// 进程异常退出导致索引整表丢失：下一次扫描按 `$I` 元数据完整重建。
    #[test]
    fn scan_rebuilds_index_from_real_meta_after_cache_loss() {
        let root = std::env::temp_dir().join(format!("td-rebuild-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("$Iabc"), meta_bytes(r"D:\dir\季度 报告.docx", 128, 1_700_000_000_000)).unwrap();
        fs::write(root.join("$Rabc"), []).unwrap();
        let volume = BinVolume { volume: "T:".into(), root: root.clone(), drive_root: "T:\\".into() };
        let conn = Connection::open_in_memory().unwrap();
        index::init_schema(&conn).unwrap();
        scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        // 模拟缓存整表丢失（例如旧进程写入未落盘）。
        index::clear_volume(&conn, &root.to_string_lossy()).unwrap();
        assert_eq!(index::stats(&conn).unwrap().items, 0);
        let rebuilt = scan_volume(&conn, &volume, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(rebuilt.items, 1);
        let page = index::page(&conn, &index::RecycleQuery::default()).unwrap();
        assert_eq!(page.items[0].original_path, r"D:\dir\季度 报告.docx");
        assert_eq!(page.items[0].size, Some(128));
        fs::remove_dir_all(root).unwrap();
    }

    /// 1 万 / 4 万 / 10 万规模测量（需显式开启）。
    /// 运行示例：
    /// `$env:TD_RECYCLE_SCALE_MEASURE="1"; cargo test --lib synthetic_scale_measurement -- --ignored --nocapture`
    #[test]
    #[ignore = "回收站 1万/4万/10万规模测量，需 TD_RECYCLE_SCALE_MEASURE=1"]
    fn synthetic_scale_measurement() {
        if std::env::var("TD_RECYCLE_SCALE_MEASURE").as_deref() != Ok("1") {
            println!("MEASURE skipped: TD_RECYCLE_SCALE_MEASURE!=1");
            return;
        }
        for count in [10_000usize, 40_000usize, 100_000usize] {
            let tag = format!("{count}");
            let db_path = std::env::temp_dir().join(format!(
                "taskdock-scale-{count}-{}.db",
                std::process::id()
            ));
            let _ = fs::remove_file(&db_path);
            let _ = fs::remove_file(db_path.with_extension("db-wal"));
            let _ = fs::remove_file(db_path.with_extension("db-shm"));
            if count > 40_000 {
                // 10 万只写索引，不创建 20 万个真实文件。
                simulated_index(&db_path, count);
                measure_scales(&tag, &db_path, "D:");
                println!("MEASURE scan[{tag}] skipped=simulated_index_only");
            } else {
                let root = synthetic_bin(count);
                let volume = BinVolume {
                    volume: "T:".into(),
                    root: root.clone(),
                    drive_root: "T:\\".into(),
                };
                let conn = Connection::open(&db_path).expect("open db");
                index::init_schema(&conn).expect("schema");
                let cancel = AtomicBool::new(false);
                let started = Instant::now();
                let first = scan_volume(&conn, &volume, &cancel, &|_| {}).expect("scan");
                println!(
                    "MEASURE scan[{tag}] first items={} added={} updated={} removed={} internal_ms={} wall_ms={:.1}",
                    first.items, first.added, first.updated, first.removed, first.duration_ms, ms(started)
                );
                let started = Instant::now();
                let second = scan_volume(&conn, &volume, &cancel, &|_| {}).expect("scan again");
                println!(
                    "MEASURE scan[{tag}] second items={} added={} updated={} removed={} internal_ms={} wall_ms={:.1}",
                    second.items, second.added, second.updated, second.removed, second.duration_ms, ms(started)
                );
                // 取消响应：在枚举进度到达 200 条时请求取消，记录到扫描返回的时间。
                let cancel = AtomicBool::new(false);
                let requested_at: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
                let started = Instant::now();
                let outcome = scan_volume(&conn, &volume, &cancel, &|progress| {
                    let mut slot = requested_at.lock().unwrap_or_else(|e| e.into_inner());
                    if slot.is_none()
                        && progress.phase == ScanPhase::Enumerating
                        && progress.done >= 200
                    {
                        cancel.store(true, Ordering::SeqCst);
                        *slot = Some(Instant::now());
                    }
                })
                .expect("cancel scan");
                let response = requested_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|at| at.elapsed().as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                println!(
                    "MEASURE cancel[{tag}] state={} response_ms={:.1} total_ms={:.1}",
                    outcome.state,
                    response,
                    ms(started)
                );
                drop(conn);
                measure_scales(&tag, &db_path, "T:");
                fs::remove_dir_all(&root).ok();
            }
            let _ = fs::remove_file(&db_path);
            let _ = fs::remove_file(db_path.with_extension("db-wal"));
            let _ = fs::remove_file(db_path.with_extension("db-shm"));
        }
    }
}
