//! 文件投递目录的共享容量管理：受控写入（Hook CLI）与扫描器（主程序）共用上限。
//!
//! 可靠性边界：
//! - 三重上限：总文件数、总字节数、单文件大小；关键事件可使用预留额度，普通事件先停写；
//! - 跨进程预留：`create_new` 原子创建 `.inbox-quota.lock`，锁内容带 PID，
//!   持有者死亡或超过 60 秒即视为陈旧并回收，进程崩溃不会永久锁死投递；
//! - 写入一律 `.tmp` + rename，扫描器只消费 `.json`，不会读到半写文件；
//! - 容量不足时返回明确原因，调用方记录到有界失败日志，绝静默删除已有事件；
//! - 外部写入方（未使用本模块的脚本）无法参与预留，扫描器只能尽快消费并在诊断中暴露积压。

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use chrono::{SecondsFormat, Utc};

/// 目录内最多保留的事件文件数（受控写入的硬上限）。
pub const MAX_FILES: usize = 5000;
/// 目录内事件文件总字节硬上限。
pub const MAX_BYTES: u64 = 256 * 1024 * 1024;
/// 单个投递文件大小硬上限。
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 关键事件预留：普通配额耗尽后仍可为 waiting/completed/failed 写入。
pub const CRITICAL_HEADROOM_FILES: usize = 250;
pub const CRITICAL_HEADROOM_BYTES: u64 = 16 * 1024 * 1024;

pub const QUOTA_LOCK: &str = ".inbox-quota.lock";
const FAILURE_LOG: &str = ".inbox-failures.log";
const FAILURE_LOG_MAX_BYTES: u64 = 256 * 1024;
/// 单次测量/扫描的目录项上限：外部写入制造超大目录时保证 CPU/IO 有界。
pub const MAX_MEASURE_ENTRIES: usize = 20_000;

const LOCK_STALE: Duration = Duration::from_secs(60);
const TMP_STALE: Duration = Duration::from_secs(120);
const NORMAL_LOCK_TIMEOUT: Duration = Duration::from_millis(250);
const CRITICAL_LOCK_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QuotaUsage {
    pub files: usize,
    pub bytes: u64,
    pub tmp_files: usize,
    pub tmp_bytes: u64,
    pub controlled_files: usize,
    pub external_files: usize,
    /// 目录项超过测量上限：统计不完整，非关键写入应暂停。
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct QuotaLimits {
    pub max_files: usize,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for QuotaLimits {
    fn default() -> Self {
        Self {
            max_files: MAX_FILES,
            max_bytes: MAX_BYTES,
            max_file_bytes: MAX_FILE_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReserveError {
    TooLarge {
        size: u64,
        limit: u64,
    },
    Full {
        files: usize,
        bytes: u64,
        reason: &'static str,
    },
    LockTimeout,
    Io(String),
}

impl std::fmt::Display for ReserveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { size, limit } => {
                write!(f, "文件 {} 字节超过单文件上限 {}", size, limit)
            }
            Self::Full {
                files,
                bytes,
                reason,
            } => write!(
                f,
                "投递目录已满（{} 个文件 / {} 字节，{}）",
                files, bytes, reason
            ),
            Self::LockTimeout => write!(f, "容量预留锁等待超时"),
            Self::Io(e) => write!(f, "投递写入失败: {}", e),
        }
    }
}

fn is_tmp_name(name: &str) -> bool {
    (name.starts_with('.') && name.ends_with(".tmp")) || name.ends_with(".tmp")
}

fn is_internal(name: &str) -> bool {
    name == QUOTA_LOCK || name == FAILURE_LOG
}

/// 统计目录用量（只统计顶层文件；`failed/` 等子目录不计入）。
pub fn measure(dir: &Path) -> std::io::Result<QuotaUsage> {
    let mut usage = QuotaUsage::default();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(usage),
        Err(e) => return Err(e),
    };
    let mut seen = 0usize;
    for entry in entries.flatten() {
        seen += 1;
        if seen > MAX_MEASURE_ENTRIES {
            usage.truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_internal(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if is_tmp_name(&name) {
            usage.tmp_files += 1;
            usage.tmp_bytes += meta.len();
        } else if name.ends_with(".json") {
            usage.files += 1;
            usage.bytes += meta.len();
            if name.starts_with("hook-") || name.starts_with("retry-") {
                usage.controlled_files += 1;
            } else {
                usage.external_files += 1;
            }
        }
    }
    Ok(usage)
}

/// 清理崩溃/中断遗留的半写临时文件；返回清理数量。
pub fn cleanup_stale_tmp(dir: &Path, age: Duration) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut cleaned = 0;
    for entry in entries.flatten().take(MAX_MEASURE_ENTRIES) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_tmp_name(&name) || is_internal(&name) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| now.duration_since(m).ok())
            .map(|d| d >= age)
            .unwrap_or(false);
        if stale && fs::remove_file(entry.path()).is_ok() {
            cleaned += 1;
        }
    }
    cleaned
}

struct QuotaGuard {
    path: PathBuf,
}

impl Drop for QuotaGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    if pid == 0 || pid == u32::MAX {
        return false;
    }
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        // WAIT_OBJECT_0(0) = 已退出；其余（含 WAIT_TIMEOUT 258）= 仍存活。
        let exited = WaitForSingleObject(handle, 0) == 0;
        CloseHandle(handle);
        !exited
    }
}

#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    true
}

fn lock_stale(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return true;
    };
    let age = meta.modified().ok().and_then(|m| m.elapsed().ok());
    if age.map(|a| a > LOCK_STALE).unwrap_or(false) {
        return true;
    }
    let mut raw = String::new();
    if File::open(path)
        .and_then(|f| f.take(128).read_to_string(&mut raw))
        .is_err()
    {
        return false;
    }
    let pid = raw
        .split_whitespace()
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(0);
    if pid == 0 {
        // create_new 与写入 PID 之间有极短窗口：并发进程可能读到空锁。
        // 新锁一律视为存活，否则会被误删，导致多个进程同时持锁。
        return age.map(|a| a > Duration::from_secs(2)).unwrap_or(false);
    }
    !pid_alive(pid)
}

fn acquire_lock(dir: &Path, critical: bool) -> Result<QuotaGuard, ReserveError> {
    let path = dir.join(QUOTA_LOCK);
    let timeout = if critical {
        CRITICAL_LOCK_TIMEOUT
    } else {
        NORMAL_LOCK_TIMEOUT
    };
    let started = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                // 先写 PID 再放锁：等待者据此判断持有者是否仍存活。
                let _ = f.write_all(
                    format!("{} {}", std::process::id(), Utc::now().timestamp_millis()).as_bytes(),
                );
                let _ = f.sync_all();
                return Ok(QuotaGuard { path });
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                if lock_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                if started.elapsed() >= timeout {
                    return Err(ReserveError::LockTimeout);
                }
                std::thread::sleep(Duration::from_millis(4));
            }
            Err(e) => return Err(ReserveError::Io(format!("创建锁失败: {}", e))),
        }
    }
}

/// Windows 上杀毒/索引器会短暂持有新建文件，rename 可能瞬时返回拒绝访问；
/// 重试不退化为覆盖：目标名唯一，失败路径仍会清理 tmp。
fn rename_with_retry(tmp: &Path, target: &Path) -> std::io::Result<()> {
    for attempt in 0..3u64 {
        match fs::rename(tmp, target) {
            Ok(()) => return Ok(()),
            Err(e)
                if attempt < 2
                    && matches!(
                        e.kind(),
                        ErrorKind::PermissionDenied | ErrorKind::WouldBlock
                    ) =>
            {
                std::thread::sleep(Duration::from_millis(10 * (attempt + 1)));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 预留容量并原子写入一个事件文件。
///
/// `critical=true` 时可使用预留额度（普通配额耗尽后仍写入关键状态）；
/// 任何情况下都不会覆盖已有文件或删除他人文件。
pub fn write_reserved(
    dir: &Path,
    name: &str,
    body: &[u8],
    critical: bool,
    limits: QuotaLimits,
) -> Result<PathBuf, ReserveError> {
    if name.starts_with('.') || !name.ends_with(".json") {
        return Err(ReserveError::Io("非法投递文件名".into()));
    }
    if body.len() as u64 > limits.max_file_bytes {
        return Err(ReserveError::TooLarge {
            size: body.len() as u64,
            limit: limits.max_file_bytes,
        });
    }
    fs::create_dir_all(dir).map_err(|e| ReserveError::Io(format!("创建目录失败: {}", e)))?;
    let guard = acquire_lock(dir, critical)?;
    let usage = measure(dir).map_err(|e| ReserveError::Io(format!("统计目录失败: {}", e)))?;
    let _ = cleanup_stale_tmp(dir, TMP_STALE);
    let allowed_files = limits.max_files + if critical { CRITICAL_HEADROOM_FILES } else { 0 };
    let allowed_bytes = limits.max_bytes + if critical { CRITICAL_HEADROOM_BYTES } else { 0 };
    if usage.files + 1 > allowed_files {
        let reason = if critical {
            "关键预留也已耗尽"
        } else {
            "关键事件预留空间保留"
        };
        return Err(ReserveError::Full {
            files: usage.files,
            bytes: usage.bytes,
            reason,
        });
    }
    if usage.bytes + usage.tmp_bytes + body.len() as u64 > allowed_bytes {
        let reason = if critical {
            "关键预留也已耗尽"
        } else {
            "关键事件预留空间保留"
        };
        return Err(ReserveError::Full {
            files: usage.files,
            bytes: usage.bytes + usage.tmp_bytes,
            reason,
        });
    }
    if usage.truncated && !critical {
        return Err(ReserveError::Full {
            files: usage.files,
            bytes: usage.bytes,
            reason: "目录项过多，非关键写入暂停",
        });
    }
    let tmp = dir.join(format!(".{}.tmp", name));
    let final_path = dir.join(name);
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| ReserveError::Io(format!("创建临时文件失败: {}", e)))?;
    if let Err(e) = f.write_all(body).and_then(|_| f.sync_all()) {
        drop(f);
        let _ = fs::remove_file(&tmp);
        return Err(ReserveError::Io(format!("写入临时文件失败: {}", e)));
    }
    drop(f);
    if let Err(e) = rename_with_retry(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(ReserveError::Io(format!("提交投递文件失败: {}", e)));
    }
    drop(guard);
    Ok(final_path)
}

/// 有界失败日志：Hook 投递失败的原因留在目录内，供诊断读取；超过上限先滚动清空。
pub fn record_failure(dir: &Path, reason: &str) {
    let _ = fs::create_dir_all(dir);
    let path = dir.join(FAILURE_LOG);
    if fs::metadata(&path)
        .map(|m| m.len() > FAILURE_LOG_MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&path);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let line = format!(
            "{} pid={} {}\n",
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            std::process::id(),
            reason.replace(['\n', '\r'], " ")
        );
        let _ = f.write_all(line.as_bytes());
    }
}

/// 失败日志摘要：`(条数, 最后一条)`；读取上限 256 KiB。
pub fn failure_log_summary(dir: &Path) -> (usize, Option<String>) {
    let path = dir.join(FAILURE_LOG);
    let Ok(meta) = fs::metadata(&path) else {
        return (0, None);
    };
    if meta.len() > FAILURE_LOG_MAX_BYTES {
        return (0, Some("失败日志超过上限等待滚动".into()));
    }
    match fs::read_to_string(&path) {
        Ok(text) => {
            let mut lines = text.lines().filter(|l| !l.trim().is_empty());
            let count = lines.clone().count();
            (count, lines.next_back().map(str::to_string))
        }
        Err(_) => (0, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-inbox-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn limits(files: usize, bytes: u64, file: u64) -> QuotaLimits {
        QuotaLimits {
            max_files: files,
            max_bytes: bytes,
            max_file_bytes: file,
        }
    }

    #[test]
    fn reservation_enforces_total_file_cap() {
        let dir = temp_dir("files");
        let l = limits(2, 1 << 20, 1 << 10);
        assert!(write_reserved(&dir, "hook-1.json", b"{}", false, l).is_ok());
        assert!(write_reserved(&dir, "hook-2.json", b"{}", false, l).is_ok());
        assert!(matches!(
            write_reserved(&dir, "hook-3.json", b"{}", false, l),
            Err(ReserveError::Full { .. })
        ));
        assert_eq!(measure(&dir).unwrap().files, 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reservation_enforces_total_byte_cap() {
        let dir = temp_dir("bytes");
        let l = limits(100, 100, 100);
        assert!(write_reserved(&dir, "hook-1.json", &[b'x'; 60], false, l).is_ok());
        assert!(matches!(
            write_reserved(&dir, "hook-2.json", &[b'x'; 60], false, l),
            Err(ReserveError::Full { .. })
        ));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn critical_writes_use_reserved_headroom() {
        let dir = temp_dir("headroom");
        let l = limits(1, 1 << 20, 1 << 10);
        assert!(write_reserved(&dir, "hook-1.json", b"{}", false, l).is_ok());
        assert!(write_reserved(&dir, "hook-2.json", b"{}", false, l).is_err());
        assert!(
            write_reserved(&dir, "hook-3.json", b"{}", true, l).is_ok(),
            "关键事件必须能使用预留额度"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_single_file_is_rejected_without_lock() {
        let dir = temp_dir("large");
        let l = limits(10, 1 << 20, 8);
        match write_reserved(&dir, "hook-big.json", &[b'x'; 9], false, l) {
            Err(ReserveError::TooLarge { size: 9, limit: 8 }) => {}
            other => panic!("预期 TooLarge，实际 {:?}", other),
        }
        assert_eq!(measure(&dir).unwrap().files, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_are_atomic_and_leave_no_tmp() {
        let dir = temp_dir("atomic");
        let path = write_reserved(
            &dir,
            "hook-a.json",
            b"payload",
            false,
            QuotaLimits::default(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"payload");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["hook-a.json".to_string()]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fresh_empty_lock_is_not_reclaimed() {
        let dir = temp_dir("lock-empty");
        let path = dir.join(QUOTA_LOCK);
        fs::write(&path, "").unwrap();
        assert!(
            !lock_stale(&path),
            "刚创建但尚未写入 PID 的锁不能被并发进程误删"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dead_owner_lock_is_reclaimed() {
        let dir = temp_dir("lock-dead");
        // 不存在的 PID：立即可回收，无需等待 60 秒。
        fs::write(dir.join(QUOTA_LOCK), format!("{} 0", u32::MAX - 1)).unwrap();
        assert!(write_reserved(
            &dir,
            "hook-a.json",
            b"{}",
            false,
            limits(10, 1 << 20, 1 << 10)
        )
        .is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn live_lock_times_out_then_recovers() {
        let dir = temp_dir("lock-live");
        let guard = acquire_lock(&dir, true).unwrap();
        assert_eq!(
            write_reserved(
                &dir,
                "hook-b.json",
                b"{}",
                false,
                limits(10, 1 << 20, 1 << 10)
            ),
            Err(ReserveError::LockTimeout)
        );
        drop(guard);
        assert!(write_reserved(
            &dir,
            "hook-b.json",
            b"{}",
            false,
            limits(10, 1 << 20, 1 << 10)
        )
        .is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_writers_never_exceed_capacity() {
        let dir = temp_dir("concurrent");
        let l = limits(10, 1 << 20, 1 << 10);
        let mut handles = Vec::new();
        for i in 0..40 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                write_reserved(&dir, &format!("hook-{}.json", i), b"{}", false, l).is_ok()
            }));
        }
        let ok = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert!(ok <= 10, "并发预留必须严格不超上限，实际 {}", ok);
        assert!(ok >= 1, "高并发下至少要有写入成功");
        assert_eq!(measure(&dir).unwrap().files, ok);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn measure_ignores_failed_and_tmp_but_counts_external() {
        let dir = temp_dir("measure");
        fs::create_dir_all(dir.join("failed")).unwrap();
        fs::write(dir.join("failed").join("x.json"), b"{}").unwrap();
        fs::write(dir.join(".half.tmp"), b"xx").unwrap();
        fs::write(dir.join("external-script.json"), b"{}").unwrap();
        let u = measure(&dir).unwrap();
        assert_eq!(u.files, 1);
        assert_eq!(u.external_files, 1);
        assert_eq!(u.tmp_files, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stale_tmp_is_cleaned_but_fresh_tmp_is_kept() {
        let dir = temp_dir("tmp");
        fs::write(dir.join(".old.tmp"), b"x").unwrap();
        fs::write(dir.join(".new.tmp"), b"x").unwrap();
        // 不能依赖文件系统时间精度：用 0 秒阈值清理旧文件，再用 1 小时阈值验证新文件保留。
        assert_eq!(cleanup_stale_tmp(&dir, Duration::ZERO), 2);
        fs::write(dir.join(".new.tmp"), b"x").unwrap();
        assert_eq!(cleanup_stale_tmp(&dir, Duration::from_secs(3600)), 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failure_log_is_recorded_and_summarized() {
        let dir = temp_dir("fail-log");
        record_failure(&dir, "full capacity\nline2");
        record_failure(&dir, "lock timeout");
        let (count, last) = failure_log_summary(&dir);
        assert_eq!(count, 2);
        assert!(last.unwrap().contains("lock timeout"));
        let raw = fs::read_to_string(dir.join(FAILURE_LOG)).unwrap();
        assert!(!raw.contains("\nline2"), "原因中的换行必须转义");
        fs::remove_dir_all(&dir).ok();
    }
}
