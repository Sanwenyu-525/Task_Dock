//! 本地语音缓存：内容寻址文件名 + 原子写 + 有界 LRU。
//!
//! - 文件名只使用稳定哈希，绝不把播报原文写入路径（敏感动态文本不会落盘）。
//! - Key 覆盖：引擎 ID、引擎/格式版本、语音 ID、语言、语速、文本。音量只影响播放，
//!   不参与 Key。不同引擎即使音色同名也绝不会命中彼此的缓存。
//! - 写入走「临时文件 + 原子替换」，半成品不会被后续请求当成有效缓存。
//! - LRU 以文件 mtime 为序；命中时最多每 60 秒触碰一次 mtime，避免高频磁盘写。
//! - 读取失败（损坏/被外部删除）直接丢弃条目并返回未命中，由调用方重新合成。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};

/// 影响音频字节的格式/引擎版本。任何影响合成结果的改动都必须递增，
/// 使旧缓存整体失效（缓存目录中旧文件由 LRU 自然回收）。
///
/// v2（2026-11-05 音色系统升级）：Key 增加引擎维度，旧 `winrt-speech/1` 条目
/// 不再命中并随 LRU 自然淘汰（不做批量删除，避免误删用户仍在使用的条目）。
pub const ENGINE_FORMAT_VERSION: &str = "tts-key/2/wav";

/// 命中后触碰 mtime 的最小间隔。
const TOUCH_INTERVAL: Duration = Duration::from_secs(60);
const MAX_RESOURCE_SCAN_ENTRIES: usize = 10_000;
const RESOURCE_SCAN_TIME_BUDGET: Duration = Duration::from_secs(5);

/// 稳定缓存 Key：SHA-256 前 128 位（32 个十六进制字符），文件名即 `<key>.<ext>`。
pub fn cache_key(
    text: &str,
    voice_id: &str,
    language: &str,
    rate_percent: u32,
    engine: &str,
) -> String {
    let mut hasher = Sha256::new();
    // 使用不可出现在常规文本中的分隔符，避免字段拼接歧义。
    // 引擎 ID 放在版本号之前：不同引擎（系统 / 高品质模型）绝不共享音频。
    for field in [
        engine,
        ENGINE_FORMAT_VERSION,
        voice_id,
        language,
        &rate_percent.to_string(),
        text,
    ] {
        hasher.update(field.as_bytes());
        hasher.update([0x1f]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 由合成流 ContentType 决定扩展名，避免出现「WAV 内容 + mp3 后缀」。
pub fn extension_for_content_type(content_type: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("wav") || ct.contains("wave") || ct.contains("riff") {
        "wav"
    } else if ct.contains("mpeg") || ct.contains("mp3") {
        "mp3"
    } else {
        "audio"
    }
}

#[derive(Debug, Clone)]
struct Entry {
    path: PathBuf,
    size: u64,
    touched: SystemTime,
    content_type: String,
}

/// 扩展名 → MIME：命中缓存时前端 `<audio>` 依赖正确的 data URL 类型。
fn content_type_for_ext(ext: Option<&str>) -> &'static str {
    match ext {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Default, Clone)]
pub struct CacheStats {
    pub bytes: u64,
    pub files: u32,
    pub hits: u64,
    pub misses: u64,
    pub writes: u64,
    pub evictions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceCacheFile {
    pub name: String,
    pub size: u64,
    pub modified_ns: u128,
    pub file_identity: u128,
}

#[derive(Debug, Clone, Default)]
pub struct ResourceCacheScan {
    pub files: Vec<ResourceCacheFile>,
    pub skipped_files: u32,
    pub incomplete: bool,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct CacheClearStats {
    pub freed_bytes: u64,
    pub deleted_files: u32,
    pub skipped_files: u32,
    pub failed_files: u32,
}

pub struct TtsCache {
    dir: Option<PathBuf>,
    entries: HashMap<String, Entry>,
    total: u64,
    hits: AtomicU64,
    misses: AtomicU64,
    writes: AtomicU64,
    evictions: AtomicU64,
    /// 临时文件名序号，避免同进程内并发写重名。
    temp_seq: AtomicU64,
}

impl TtsCache {
    /// 构造时扫描已有缓存；目录不可用（未配置/无权限）时退化为「不持久化」，
    /// 仍可通过内存缓存与即时合成为播报服务。
    pub fn new(dir: Option<PathBuf>) -> Self {
        let mut cache = Self {
            dir,
            entries: HashMap::new(),
            total: 0,
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            writes: AtomicU64::new(0),
            evictions: AtomicU64::new(0),
            temp_seq: AtomicU64::new(0),
        };
        cache.rescan();
        cache
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// 目录是否可写（创建成功且能写入临时探针）。只在配置变更/诊断时调用。
    pub fn ensure_dir(&mut self) -> bool {
        let Some(dir) = self.dir.clone() else {
            return false;
        };
        if fs::create_dir_all(&dir).is_err() {
            return false;
        }
        let probe = dir.join(".write-probe");
        let ok = fs::write(&probe, b"ok").is_ok();
        let _ = fs::remove_file(probe);
        ok
    }

    /// 轻量重扫：只用于显式恢复（如清理失败后核对索引），不做持续轮询。
    pub fn rescan(&mut self) {
        self.entries.clear();
        self.total = 0;
        let Some(dir) = self.dir.clone() else {
            return;
        };
        let Ok(root_meta) = fs::symlink_metadata(&dir) else {
            return;
        };
        if !root_meta.is_dir() || is_reparse_point(&root_meta) {
            return;
        }
        let Ok(root) = fs::canonicalize(&dir) else {
            return;
        };
        let Ok(read) = fs::read_dir(&root) else {
            return;
        };
        for item in read.flatten() {
            let path = item.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') || name.contains(".tmp-") {
                continue;
            }
            if !is_cache_extension(path.extension().and_then(|e| e.to_str())) {
                continue;
            }
            // 只认本服务生成的文件名（32 位十六进制 Key），
            // 避免把用户放在同目录下的其他音频文件纳入索引、进而被 LRU/清理删除。
            if !is_service_key_file_name(name) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_file()
                || is_reparse_point(&meta)
                || fs::canonicalize(&path)
                    .ok()
                    .and_then(|p| p.parent().map(Path::to_path_buf))
                    != Some(root.clone())
            {
                continue;
            }
            let key = name.rsplit_once('.').map(|(k, _)| k.to_string());
            let Some(key) = key else { continue };
            let touched = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let content_type =
                content_type_for_ext(path.extension().and_then(|e| e.to_str())).to_string();
            self.total = self.total.saturating_add(meta.len());
            self.entries.insert(
                key,
                Entry {
                    path,
                    size: meta.len(),
                    touched,
                    content_type,
                },
            );
        }
    }

    /// 读缓存：成功返回字节与真实内容类型；损坏/缺失返回 None 并清除条目（触发重新合成）。
    pub fn get(&mut self, key: &str) -> Option<(Vec<u8>, String)> {
        let entry = self.entries.get(key)?.clone();
        let ext = entry.path.extension().and_then(|e| e.to_str());
        match fs::read(&entry.path) {
            Ok(bytes) if is_valid_payload(ext, &bytes) => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                self.touch(key, &entry);
                Some((bytes, entry.content_type))
            }
            _ => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                // 损坏/截断/空文件：删除条目并返回未命中，绝不把坏音频交给播放器。
                self.remove_entry(key);
                None
            }
        }
    }

    fn touch(&mut self, key: &str, entry: &Entry) {
        let now = SystemTime::now();
        if now
            .duration_since(entry.touched)
            .map(|d| d < TOUCH_INTERVAL)
            .unwrap_or(false)
        {
            return;
        }
        // 失败不影响播放，只是 LRU 顺序略微滞后。
        if let Ok(file) = fs::File::options().write(true).open(&entry.path) {
            if let Ok(times) = file.set_modified(now) {
                let _ = times;
            }
        }
        if let Some(e) = self.entries.get_mut(key) {
            e.touched = now;
        }
    }

    /// 原子写入。返回 Ok(true) 表示已持久化；Ok(false) 表示本次未落盘（超限/不可用/写失败）。
    pub fn put(&mut self, key: &str, ext: &str, bytes: &[u8], max_bytes: u64) -> bool {
        if bytes.is_empty() || bytes.len() as u64 > max_bytes {
            return false;
        }
        let Some(dir) = self.dir.clone() else {
            return false;
        };
        if fs::create_dir_all(&dir).is_err() {
            return false;
        }
        let final_path = dir.join(format!("{key}.{ext}"));
        let seq = self.temp_seq.fetch_add(1, Ordering::Relaxed);
        let temp_path = dir.join(format!(".{key}.tmp-{}-{seq}", std::process::id()));
        let write_result = (|| -> io::Result<()> {
            fs::write(&temp_path, bytes)?;
            // 目标已存在（旧格式/损坏同名）时先移除，保证 rename 在 Windows 上成功。
            if final_path.exists() {
                fs::remove_file(&final_path)?;
            }
            fs::rename(&temp_path, &final_path)
        })();
        if let Err(err) = write_result {
            let _ = fs::remove_file(&temp_path);
            tracing::warn!(
                "语音缓存写入失败（分类: {:?}），本次改为直接播放",
                err.kind()
            );
            return false;
        }
        let size = bytes.len() as u64;
        if let Some(old) = self.entries.remove(key) {
            self.total = self.total.saturating_sub(old.size);
        }
        self.entries.insert(
            key.to_string(),
            Entry {
                path: final_path,
                size,
                touched: SystemTime::now(),
                content_type: content_type_for_ext(Some(ext)).to_string(),
            },
        );
        self.total = self.total.saturating_add(size);
        self.writes.fetch_add(1, Ordering::Relaxed);
        self.evict_to(max_bytes);
        true
    }

    /// 有界 LRU：最久未使用的条目先删，直到总占用不超过上限。
    /// 删除失败（文件被占用/无权限）时保留条目并继续尝试下一个，绝不虚报已释放。
    pub fn evict_to(&mut self, max_bytes: u64) {
        if self.total <= max_bytes || self.entries.is_empty() {
            return;
        }
        let mut victims: Vec<(String, SystemTime)> = self
            .entries
            .iter()
            .map(|(k, e)| (k.clone(), e.touched))
            .collect();
        victims.sort_by_key(|(_, touched)| *touched);
        for (key, _) in victims {
            if self.total <= max_bytes {
                break;
            }
            let Some(entry) = self.entries.get(&key).cloned() else {
                continue;
            };
            match delete_cache_file(&entry.path) {
                DeleteOutcome::Deleted => {
                    self.entries.remove(&key);
                    self.total = self.total.saturating_sub(entry.size);
                    self.evictions.fetch_add(1, Ordering::Relaxed);
                }
                DeleteOutcome::Missing => {
                    // 文件已被外部删除：索引同步移除，但不计为本次释放/驱逐。
                    self.entries.remove(&key);
                    self.total = self.total.saturating_sub(entry.size);
                }
                DeleteOutcome::Failed => {
                    // 保留条目，继续尝试下一个受害者；统计以磁盘实际为准。
                }
            }
        }
        self.recompute_total();
    }

    /// 一键清理：只删除本服务创建的缓存文件（固定扩展名），不触碰用户其他文件。
    /// 只有真正删除成功（或文件已不存在）才更新占用；删除失败保留索引，避免假报释放。
    pub fn clear(&mut self) -> (u64, u32) {
        let stats = self.clear_all_detailed();
        (stats.freed_bytes, stats.deleted_files)
    }

    pub fn resource_files(&self) -> io::Result<ResourceCacheScan> {
        self.resource_files_with_limits(MAX_RESOURCE_SCAN_ENTRIES, RESOURCE_SCAN_TIME_BUDGET)
    }

    fn resource_files_with_limits(
        &self,
        max_entries: usize,
        time_budget: Duration,
    ) -> io::Result<ResourceCacheScan> {
        const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);
        let Some(dir) = self.dir.as_ref() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "TTS cache unavailable",
            ));
        };
        validate_path_ancestors(dir)?;
        let root_meta = fs::symlink_metadata(dir)?;
        if !root_meta.is_dir() || is_reparse_point(&root_meta) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unsafe TTS cache root",
            ));
        }
        let root = fs::canonicalize(dir)?;
        let mut result = ResourceCacheScan::default();
        let started = Instant::now();
        let mut entries = fs::read_dir(&root)?;
        let mut visited = 0usize;
        loop {
            if started.elapsed() >= time_budget {
                result.incomplete = true;
                break;
            }
            if visited >= max_entries {
                match entries.next() {
                    Some(Ok(_)) => result.incomplete = true,
                    Some(Err(_)) => {
                        result.skipped_files = result.skipped_files.saturating_add(1);
                        result.incomplete = true;
                    }
                    None => {}
                }
                break;
            }
            let Some(item) = entries.next() else {
                break;
            };
            visited += 1;
            let item = match item {
                Ok(item) => item,
                Err(_) => {
                    result.skipped_files = result.skipped_files.saturating_add(1);
                    continue;
                }
            };
            let name = item.file_name().to_string_lossy().to_string();
            let meta = match fs::symlink_metadata(item.path()) {
                Ok(meta) => meta,
                Err(_) => {
                    result.skipped_files = result.skipped_files.saturating_add(1);
                    continue;
                }
            };
            if !meta.is_file() || is_reparse_point(&meta) {
                result.skipped_files = result.skipped_files.saturating_add(1);
                continue;
            }
            let owned = is_service_key_file_name(&name)
                || (is_service_temp_file_name(&name)
                    && meta
                        .modified()
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age >= STALE_TEMP_AGE));
            if !owned || fs::canonicalize(item.path())?.parent() != Some(root.as_path()) {
                result.skipped_files = result.skipped_files.saturating_add(1);
                continue;
            }
            let Some(modified_ns) = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
            else {
                result.skipped_files = result.skipped_files.saturating_add(1);
                continue;
            };
            let Some(file_identity) = file_identity(&item.path()) else {
                result.skipped_files = result.skipped_files.saturating_add(1);
                continue;
            };
            result.files.push(ResourceCacheFile {
                name,
                size: meta.len(),
                modified_ns,
                file_identity,
            });
        }
        Ok(result)
    }

    pub fn clear_resource_files(&mut self, expected: &[ResourceCacheFile]) -> CacheClearStats {
        let mut stats = CacheClearStats::default();
        let Some(dir) = self.dir.clone() else {
            stats.failed_files = expected.len().min(u32::MAX as usize) as u32;
            return stats;
        };
        if validate_path_ancestors(&dir).is_err() {
            stats.failed_files = expected.len().min(u32::MAX as usize) as u32;
            return stats;
        }
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && !is_reparse_point(&meta) => meta,
            Ok(_) => {
                stats.failed_files = expected.len().min(u32::MAX as usize) as u32;
                return stats;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                stats.skipped_files = expected.len().min(u32::MAX as usize) as u32;
                return stats;
            }
            Err(_) => {
                stats.failed_files = expected.len().min(u32::MAX as usize) as u32;
                return stats;
            }
        };
        let root = match fs::canonicalize(&dir) {
            Ok(root) => root,
            Err(_) => {
                stats.failed_files = expected.len().min(u32::MAX as usize) as u32;
                return stats;
            }
        };
        for candidate in expected {
            if !(is_service_key_file_name(&candidate.name)
                || is_service_temp_file_name(&candidate.name))
            {
                stats.skipped_files = stats.skipped_files.saturating_add(1);
                continue;
            }
            let path = root.join(&candidate.name);
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_file() && !is_reparse_point(&meta) => meta,
                Ok(_) => {
                    stats.skipped_files = stats.skipped_files.saturating_add(1);
                    continue;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    stats.skipped_files = stats.skipped_files.saturating_add(1);
                    continue;
                }
                Err(_) => {
                    stats.failed_files = stats.failed_files.saturating_add(1);
                    continue;
                }
            };
            if is_service_temp_file_name(&candidate.name) && !is_stale_temp_meta(&meta) {
                stats.skipped_files = stats.skipped_files.saturating_add(1);
                continue;
            }
            let Some(modified_ns) = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
            else {
                stats.skipped_files = stats.skipped_files.saturating_add(1);
                continue;
            };
            if file_identity(&path) != Some(candidate.file_identity) {
                stats.skipped_files = stats.skipped_files.saturating_add(1);
                continue;
            }
            if meta.len() != candidate.size
                || modified_ns != candidate.modified_ns
                || fs::canonicalize(&path)
                    .ok()
                    .and_then(|p| p.parent().map(Path::to_path_buf))
                    != Some(root.clone())
            {
                stats.skipped_files = stats.skipped_files.saturating_add(1);
                continue;
            }
            match crate::fs_safety::remove_file_if_unchanged(
                &path,
                candidate.size,
                candidate.modified_ns,
                candidate.file_identity,
            ) {
                Ok(true) => {
                    stats.freed_bytes = stats.freed_bytes.saturating_add(meta.len());
                    stats.deleted_files = stats.deleted_files.saturating_add(1);
                    if let Some(key) = candidate.name.rsplit_once('.').map(|(key, _)| key) {
                        self.entries.remove(key);
                    }
                }
                Ok(false) => {
                    stats.skipped_files = stats.skipped_files.saturating_add(1);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    stats.skipped_files = stats.skipped_files.saturating_add(1);
                }
                Err(_) => stats.failed_files = stats.failed_files.saturating_add(1),
            }
        }
        self.recompute_total();
        stats
    }

    pub fn clear_all_detailed(&mut self) -> CacheClearStats {
        let mut stats = CacheClearStats::default();
        let entries = std::mem::take(&mut self.entries);
        let canonical_root = self.dir.as_ref().and_then(|dir| {
            validate_path_ancestors(dir).ok()?;
            let metadata = fs::symlink_metadata(dir).ok()?;
            if !metadata.is_dir() || is_reparse_point(&metadata) {
                return None;
            }
            fs::canonicalize(dir).ok()
        });
        for (key, entry) in entries {
            let outcome = canonical_root
                .as_ref()
                .map_or(DeleteOutcome::Failed, |root| {
                    delete_owned_cache_file(root, &entry.path, &key, entry.size)
                });
            match outcome {
                DeleteOutcome::Deleted => {
                    stats.freed_bytes = stats.freed_bytes.saturating_add(entry.size);
                    stats.deleted_files = stats.deleted_files.saturating_add(1);
                }
                DeleteOutcome::Missing => {
                    // 文件已不存在：索引可清理，但本次没有释放任何字节。
                    stats.skipped_files = stats.skipped_files.saturating_add(1);
                }
                DeleteOutcome::Failed => {
                    // 删除失败：保留条目，统计与磁盘保持一致。
                    self.entries.insert(key, entry);
                    stats.failed_files = stats.failed_files.saturating_add(1);
                }
            }
        }
        // 兜底清理可能残留的临时文件（仅匹配本服务的 `.tmp-` 命名）。
        if let Some(dir) = self.dir.clone() {
            let canonical = fs::symlink_metadata(&dir)
                .ok()
                .filter(|meta| meta.is_dir() && !is_reparse_point(meta))
                .and_then(|_| fs::canonicalize(&dir).ok());
            if let Some(canonical) = canonical {
                if let Ok(read) = fs::read_dir(&canonical) {
                    for item in read.flatten() {
                        let path = item.path();
                        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if is_service_temp_file_name(name) {
                            match fs::symlink_metadata(&path) {
                                Ok(meta)
                                    if meta.is_file()
                                        && !is_reparse_point(&meta)
                                        && is_stale_temp_meta(&meta)
                                        && fs::canonicalize(&path)
                                            .ok()
                                            .and_then(|p| p.parent().map(Path::to_path_buf))
                                            == Some(canonical.clone()) =>
                                {
                                    let modified_ns = meta
                                        .modified()
                                        .ok()
                                        .and_then(|time| {
                                            time.duration_since(SystemTime::UNIX_EPOCH).ok()
                                        })
                                        .map(|time| time.as_nanos());
                                    let identity = file_identity(&path);
                                    match modified_ns.zip(identity).map_or(
                                        Ok(false),
                                        |(modified, identity)| {
                                            crate::fs_safety::remove_file_if_unchanged(
                                                &path,
                                                meta.len(),
                                                modified,
                                                identity,
                                            )
                                        },
                                    ) {
                                        Ok(true) => {
                                            stats.freed_bytes =
                                                stats.freed_bytes.saturating_add(meta.len());
                                            stats.deleted_files =
                                                stats.deleted_files.saturating_add(1);
                                        }
                                        Ok(false) => {
                                            stats.skipped_files =
                                                stats.skipped_files.saturating_add(1)
                                        }
                                        Err(e) if e.kind() == io::ErrorKind::NotFound => {
                                            stats.skipped_files =
                                                stats.skipped_files.saturating_add(1)
                                        }
                                        Err(_) => {
                                            stats.failed_files =
                                                stats.failed_files.saturating_add(1)
                                        }
                                    }
                                }
                                Ok(_) => {
                                    stats.skipped_files = stats.skipped_files.saturating_add(1)
                                }
                                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                                    stats.skipped_files = stats.skipped_files.saturating_add(1)
                                }
                                Err(_) => stats.failed_files = stats.failed_files.saturating_add(1),
                            }
                        }
                    }
                }
            }
        }
        self.recompute_total();
        stats
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            bytes: self.total,
            files: self.entries.len() as u32,
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            writes: self.writes.load(Ordering::Relaxed),
            evictions: self.evictions.load(Ordering::Relaxed),
        }
    }

    fn remove_entry(&mut self, key: &str) {
        let Some(entry) = self.entries.get(key).cloned() else {
            return;
        };
        match delete_cache_file(&entry.path) {
            DeleteOutcome::Deleted | DeleteOutcome::Missing => {
                self.entries.remove(key);
                self.total = self.total.saturating_sub(entry.size);
            }
            DeleteOutcome::Failed => {
                // 文件仍在（被占用/无权限）：保留条目，占用统计不虚减。
            }
        }
    }

    /// 以索引为准重算总占用，消除任何路径上的统计漂移。
    fn recompute_total(&mut self) {
        self.total = self.entries.values().map(|e| e.size).sum();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeleteOutcome {
    Deleted,
    Missing,
    Failed,
}

fn delete_cache_file(path: &Path) -> DeleteOutcome {
    match fs::remove_file(path) {
        Ok(()) => DeleteOutcome::Deleted,
        Err(err) if err.kind() == io::ErrorKind::NotFound => DeleteOutcome::Missing,
        Err(_) => DeleteOutcome::Failed,
    }
}

fn delete_owned_cache_file(
    root: &Path,
    path: &Path,
    key: &str,
    expected_size: u64,
) -> DeleteOutcome {
    if !is_cache_key(key)
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .map_or(true, |name| !is_service_key_file_name(name))
    {
        return DeleteOutcome::Failed;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return DeleteOutcome::Missing,
        _ => return DeleteOutcome::Failed,
    };
    let Some(modified_ns) = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
    else {
        return DeleteOutcome::Failed;
    };
    let Some(identity) = file_identity(path) else {
        return DeleteOutcome::Failed;
    };
    let canonical_path = match fs::canonicalize(path) {
        Ok(canonical) if canonical.parent() == Some(root) => canonical,
        _ => return DeleteOutcome::Failed,
    };
    if metadata.len() != expected_size {
        return DeleteOutcome::Failed;
    }
    match crate::fs_safety::remove_file_if_unchanged(
        &canonical_path,
        expected_size,
        modified_ns,
        identity,
    ) {
        Ok(true) => DeleteOutcome::Deleted,
        Ok(false) => DeleteOutcome::Failed,
        Err(error) if error.kind() == io::ErrorKind::NotFound => DeleteOutcome::Missing,
        Err(_) => DeleteOutcome::Failed,
    }
}

fn is_cache_key(key: &str) -> bool {
    key.len() == 32
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 轻量校验：只检查格式头与最小长度，不做全量解码，保持缓存读取性能。
fn is_valid_payload(ext: Option<&str>, bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    if ext == Some("wav") {
        return is_valid_wav(bytes);
    }
    // 非 WAV（mp3/未知）只要求非空；WAV 是当前 WinRT 输出格式，做必要头校验。
    true
}

fn is_valid_wav(bytes: &[u8]) -> bool {
    // RIFF 头 + fmt 块 + data 块的最小长度。
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    let riff_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as u64;
    // 允许流式写入的 0；否则 RIFF 声明长度不得超出文件实际长度。
    if riff_size != 0 && riff_size + 8 > bytes.len() as u64 {
        return false;
    }
    let head = &bytes[12..bytes.len().min(512)];
    let has_fmt = head.windows(4).any(|w| w == &b"fmt "[..]);
    let has_data = head.windows(4).any(|w| w == &b"data"[..]);
    has_fmt && has_data
}

fn is_cache_extension(ext: Option<&str>) -> bool {
    matches!(ext, Some("wav" | "mp3" | "audio"))
}

/// 本服务缓存文件名 = 32 位小写十六进制 Key + 允许的扩展名。
/// 重扫与清理只处理这类文件；用户同目录的其他文件一律不纳入索引。
fn is_service_key_file_name(name: &str) -> bool {
    let Some((key, ext)) = name.rsplit_once('.') else {
        return false;
    };
    is_cache_extension(Some(ext)) && is_cache_key(key)
}

fn is_service_temp_file_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let Some((key, suffix)) = rest.split_once(".tmp-") else {
        return false;
    };
    let mut parts = suffix.split('-');
    let pid = parts.next().unwrap_or_default();
    let seq = parts.next().unwrap_or_default();
    key.len() == 32
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && !seq.is_empty()
        && seq.bytes().all(|b| b.is_ascii_digit())
        && parts.next().is_none()
}

fn is_stale_temp_meta(metadata: &fs::Metadata) -> bool {
    const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);
    metadata
        .modified()
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|age| age >= STALE_TEMP_AGE)
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn validate_path_ancestors(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if is_reparse_point(&meta) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "unsafe cache ancestor",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn file_identity(path: &Path) -> Option<u128> {
    let file = fs::File::open(path).ok()?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 {
            return None;
        }
        let info = unsafe { info.assume_init() };
        Some(
            ((info.dwVolumeSerialNumber as u128) << 64)
                | ((info.nFileIndexHigh as u128) << 32)
                | info.nFileIndexLow as u128,
        )
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().ok()?;
        Some(((meta.dev() as u128) << 64) | meta.ino() as u128)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = file;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-audio-cache-test-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 生成最小合法 WAV（44 字节头 + 负载），用于命中/损坏校验测试。
    fn wav_bytes(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(44 + payload.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + payload.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&16000u32.to_le_bytes());
        out.extend_from_slice(&32000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn key_is_stable_and_sensitive_to_audio_parameters() {
        let a = cache_key("任务已完成", "voice-zh-cn", "zh-CN", 100, "system");
        assert_eq!(
            a,
            cache_key("任务已完成", "voice-zh-cn", "zh-CN", 100, "system")
        );
        assert_eq!(a.len(), 32);
        assert_ne!(
            a,
            cache_key("任务已完成", "voice-zh-cn", "zh-CN", 150, "system")
        );
        assert_ne!(
            a,
            cache_key("任务已完成", "voice-other", "zh-CN", 100, "system")
        );
        assert_ne!(
            a,
            cache_key("任务已完成", "voice-zh-cn", "en-US", 100, "system")
        );
        assert_ne!(
            a,
            cache_key("需要你的操作", "voice-zh-cn", "zh-CN", 100, "system")
        );
        // 引擎隔离：同名音色在不同引擎下不得复用缓存。
        assert_ne!(
            a,
            cache_key("任务已完成", "voice-zh-cn", "zh-CN", 100, "neural")
        );
    }

    #[test]
    fn put_get_roundtrip_and_hit_does_not_rewrite() {
        let dir = temp_dir("roundtrip");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let key = cache_key("任务已完成", "v", "zh-CN", 100, "system");
        assert!(cache.get(&key).is_none());
        let wav = wav_bytes(b"abc");
        assert!(cache.put(&key, "wav", &wav, 50 * 1024 * 1024));
        let (bytes, content_type) = cache.get(&key).expect("命中缓存");
        assert_eq!(bytes, wav);
        assert_eq!(content_type, "audio/wav");
        let stats = cache.stats();
        assert_eq!(stats.writes, 1);
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.files, 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_wav_is_never_served_and_entry_is_dropped() {
        let dir = temp_dir("bad-wav");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let key = cache_key("执行失败", "v", "zh-CN", 100, "system");
        // 只有 RIFF/WAVE 魔数、长度不足的截断文件。
        assert!(cache.put(&key, "wav", b"RIFFxxxxWAVE", 1024));
        let path = dir.join(format!("{key}.wav"));
        assert!(cache.get(&key).is_none(), "截断 WAV 不得命中");
        assert!(!path.exists(), "损坏缓存应被移除");
        assert_eq!(cache.stats().files, 0);

        let key2 = cache_key("任务提醒时间到", "v", "zh-CN", 100, "system");
        let mut no_data = wav_bytes(b"");
        no_data[36..40].copy_from_slice(b"JUNK");
        assert!(cache.put(&key2, "wav", &no_data, 1024));
        assert!(cache.get(&key2).is_none(), "缺少 data 块的 WAV 不得命中");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupted_entry_is_dropped_and_misses() {
        let dir = temp_dir("corrupt");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let key = cache_key("执行失败", "v", "zh-CN", 100, "system");
        assert!(cache.put(&key, "wav", &wav_bytes(b"abc"), 1024));
        let path = dir.join(format!("{key}.wav"));
        fs::write(&path, b"").expect("写空文件模拟损坏");
        assert!(cache.get(&key).is_none());
        assert!(!path.exists(), "损坏缓存应被移除");
        assert_eq!(cache.stats().files, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lru_eviction_keeps_cache_bounded() {
        let dir = temp_dir("lru");
        let mut cache = TtsCache::new(Some(dir.clone()));
        // 每个 100 字节，上限 300 字节：写入 5 个后只保留最新的 3 个。
        for i in 0..5u32 {
            let key = cache_key(&format!("phrase-{i}"), "v", "zh-CN", 100, "system");
            assert!(cache.put(&key, "wav", &vec![b'x'; 100], 300));
        }
        let stats = cache.stats();
        assert!(stats.bytes <= 300, "缓存应受容量上限约束: {}", stats.bytes);
        assert_eq!(stats.files, 3);
        assert!(stats.evictions >= 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn oversized_payload_is_not_cached() {
        let dir = temp_dir("oversize");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let key = cache_key("phrase", "v", "zh-CN", 100, "system");
        assert!(!cache.put(&key, "wav", &vec![b'x'; 512], 256));
        assert_eq!(cache.stats().files, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_removes_only_cache_files() {
        let dir = temp_dir("clear");
        fs::write(dir.join("user-note.txt"), b"keep").expect("写用户文件");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let key = cache_key("任务已完成", "v", "zh-CN", 100, "system");
        assert!(cache.put(&key, "wav", wav_bytes(b"abcd").as_slice(), 1024));
        let (freed, removed) = cache.clear();
        assert_eq!(removed, 1);
        assert_eq!(freed, 48);
        assert!(dir.join("user-note.txt").exists(), "不得误删非缓存文件");
        assert_eq!(cache.stats().files, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resource_scan_and_execution_use_service_filename_and_fingerprint() {
        let dir = temp_dir("resource-clear");
        let key = cache_key("任务已完成", "v", "zh-CN", 100, "system");
        let mut cache = TtsCache::new(Some(dir.clone()));
        assert!(cache.put(&key, "wav", wav_bytes(b"abcd").as_slice(), 1024));
        fs::write(dir.join("user-recording.wav"), wav_bytes(b"abcd")).unwrap();

        let preview = cache.resource_files().unwrap();
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.files[0].name, format!("{key}.wav"));

        fs::write(dir.join(format!("{key}.wav")), wav_bytes(b"changed-size")).unwrap();
        let report = cache.clear_resource_files(&preview.files);
        assert_eq!(report.deleted_files, 0);
        assert_eq!(report.freed_bytes, 0);
        assert_eq!(report.skipped_files, 1);
        assert!(dir.join(format!("{key}.wav")).exists());
        assert!(dir.join("user-recording.wav").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resource_scan_limit_returns_a_partial_result() {
        let dir = temp_dir("resource-scan-limit");
        for phrase in ["first", "second"] {
            let key = cache_key(phrase, "v", "zh-CN", 100, "system");
            fs::write(dir.join(format!("{key}.wav")), wav_bytes(b"a")).unwrap();
        }
        let cache = TtsCache::new(Some(dir.clone()));
        let scan = cache
            .resource_files_with_limits(1, Duration::from_secs(5))
            .unwrap();

        assert_eq!(scan.files.len(), 1);
        assert!(scan.incomplete);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn resource_clear_deletes_only_a_matching_service_file() {
        let dir = temp_dir("resource-clear-handle");
        let key = cache_key("清理缓存", "v", "zh-CN", 100, "system");
        let mut cache = TtsCache::new(Some(dir.clone()));
        assert!(cache.put(&key, "wav", wav_bytes(b"safe").as_slice(), 1024));
        let preview = cache.resource_files().unwrap();

        let stats = cache.clear_resource_files(&preview.files);
        assert_eq!(stats.deleted_files, 1);
        assert_eq!(stats.failed_files, 0);
        assert_eq!(stats.skipped_files, 0);
        assert!(!dir.join(format!("{key}.wav")).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn temporary_name_requires_exact_tts_owner_pattern() {
        assert!(is_service_temp_file_name(
            ".0123456789abcdef0123456789abcdef.tmp-42-7"
        ));
        assert!(!is_service_temp_file_name(".user.tmp-42-7"));
        assert!(!is_service_temp_file_name(
            ".0123456789abcdef0123456789abcdef.tmp-x-7"
        ));
        assert!(!is_service_temp_file_name(
            ".0123456789abcdef0123456789abcdef.tmp-42-7-extra"
        ));
    }

    #[test]
    fn rescan_only_adopts_service_generated_file_names() {
        let dir = temp_dir("rescan-foreign");
        let key = cache_key("任务已完成", "v", "zh-CN", 100, "system");
        fs::write(dir.join(format!("{key}.wav")), wav_bytes(b"abcd")).expect("写本服务缓存");
        fs::write(dir.join("user-recording.wav"), wav_bytes(b"abcd")).expect("写用户文件");
        let mut cache = TtsCache::new(Some(dir.clone()));
        assert_eq!(
            cache.stats().files,
            1,
            "只索引 32 位十六进制 Key 命名的文件"
        );
        assert!(cache.get(&key).is_some());
        // 用户文件既不进索引，也不被清理。
        let (_, removed) = cache.clear();
        assert_eq!(removed, 1);
        assert!(dir.join("user-recording.wav").exists(), "不得删除用户文件");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn clear_delete_failure_keeps_entry_and_never_fake_release() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("clear-fail");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let key = cache_key("任务已完成", "v", "zh-CN", 100, "system");
        assert!(cache.put(&key, "wav", wav_bytes(b"abcd").as_slice(), 1024));
        let path = dir.join(format!("{key}.wav"));
        // Windows 文件占用：仅允许读共享，删除会得到 sharing violation。
        let guard = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .expect("占用缓存文件");
        let (freed, removed) = cache.clear();
        assert_eq!(freed, 0, "删除失败不得虚报释放字节");
        assert_eq!(removed, 0, "删除失败不得计为已删除");
        assert_eq!(cache.stats().files, 1, "失败条目应保留以保持索引与磁盘一致");
        assert!(path.exists());
        drop(guard);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn evict_delete_failure_keeps_entry_and_total_accurate() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("evict-fail");
        let mut cache = TtsCache::new(Some(dir.clone()));
        let mut paths = Vec::new();
        for i in 0..2u32 {
            let key = cache_key(&format!("phrase-{i}"), "v", "zh-CN", 100, "system");
            assert!(cache.put(&key, "wav", wav_bytes(&vec![b'x'; 100]).as_slice(), 10_000));
            paths.push(dir.join(format!("{key}.wav")));
        }
        // 全部占用：LRU 无法删除任何条目，占用统计必须保持真实值。
        let guards: Vec<_> = paths
            .iter()
            .map(|p| {
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(p)
                    .expect("占用缓存文件")
            })
            .collect();
        let before = cache.stats().bytes;
        cache.evict_to(0);
        assert_eq!(cache.stats().bytes, before, "删除失败时占用不得下降");
        assert_eq!(cache.stats().files, 2, "删除失败时索引不得提前移除");
        drop(guards);
        for path in &paths {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir_all(dir);
    }
}
