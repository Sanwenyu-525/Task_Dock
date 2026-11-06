//! 由用户显式触发的应用缓存扫描、预览与清理。
//!
//! 固定类别白名单：暂存架陈旧原子写入残留、TTS 服务缓存、剪贴板/暂存架无引用缩略图。
//! 执行只接受服务端预览 ID，并再次验证文件身份。
//! Windows 通过拒绝并发写/删共享的文件句柄复核后对同一对象设置删除标记；其他平台跳过。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audio::{cache::ResourceCacheFile, AudioService};
use crate::clipboard::ClipboardRuntime;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::shelf::{self, ShelfState};

const PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PREVIEWS: usize = 32;
const MAX_SCAN_ENTRIES: usize = 10_000;
const SCAN_TIME_BUDGET: Duration = Duration::from_secs(5);
const SHELF_TEMP_MIN_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Temporary,
    Tts,
    OrphanThumbnails,
}

impl Category {
    fn all() -> [Self; 3] {
        [Self::Temporary, Self::Tts, Self::OrphanThumbnails]
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub sampled_at: String,
    pub application: ApplicationSnapshot,
    pub memory: MemorySnapshot,
    pub disks: Vec<DiskSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSnapshot {
    pub known_cache_bytes: Option<u64>,
    pub known_cache_files: Option<u64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSnapshot {
    pub volume: String,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPreview {
    pub category: Category,
    pub status: String,
    pub candidates: u64,
    pub estimated_bytes: u64,
    pub protected_files: u64,
    pub skipped_files: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub preview_id: String,
    pub created_at: String,
    pub expires_at: String,
    pub categories: Vec<CategoryPreview>,
    pub total_candidates: u64,
    pub total_estimated_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryResult {
    pub category: Category,
    pub status: String,
    pub candidates: u64,
    pub estimated_bytes: u64,
    pub freed_bytes: u64,
    pub deleted_files: u64,
    pub skipped_files: u64,
    pub failed_files: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReport {
    pub job_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: String,
    pub total_freed_bytes: u64,
    pub total_deleted_files: u64,
    pub categories: Vec<CategoryResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Owner {
    Tts,
    Clipboard,
    Shelf,
    ShelfTemporary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    owner: Owner,
    name: String,
    size: u64,
    modified_ns: u128,
    file_identity: u128,
}

#[derive(Debug)]
struct PlannedCategory {
    candidates: Vec<Candidate>,
    skipped_files: u64,
    protected_files: u64,
    incomplete: bool,
    error_code: Option<String>,
}

#[derive(Debug)]
struct PreviewRecord {
    expires: Instant,
    categories: HashMap<Category, PlannedCategory>,
}

#[derive(Default)]
pub struct ResourceCleanupState {
    previews: Mutex<HashMap<String, PreviewRecord>>,
    executing: Mutex<()>,
}

impl ResourceCleanupState {
    pub fn snapshot(
        &self,
        clipboard: &ClipboardRuntime,
        shelf_state: &ShelfState,
        audio: &AudioService,
    ) -> ResourceSnapshot {
        let mut known_bytes = 0u64;
        let mut known_files = 0u64;
        let mut partial = false;
        let mut metrics_available = true;
        let mut available_sources = 0u8;

        match audio.resource_cache_files() {
            Ok(scan) => {
                available_sources += 1;
                add_counts(
                    &mut known_bytes,
                    &mut known_files,
                    scan.files.iter().map(|f| f.size),
                );
                partial |= scan.skipped_files > 0 || scan.incomplete;
            }
            Err(_) => {
                partial = true;
                metrics_available = false;
            }
        }
        match scan_thumbnails(clipboard, shelf_state) {
            Ok(scan) => {
                available_sources += 1;
                known_bytes = known_bytes.saturating_add(scan.known_bytes);
                known_files = known_files.saturating_add(scan.known_files);
                partial |= scan.skipped > 0 || scan.incomplete;
            }
            Err(_) => {
                partial = true;
                metrics_available = false;
            }
        }
        match scan_shelf_temporaries(&shelf_state.root) {
            Ok(scan) => {
                available_sources += 1;
                known_bytes = known_bytes.saturating_add(scan.known_bytes);
                known_files = known_files.saturating_add(scan.known_files);
                partial |= scan.skipped > 0 || scan.incomplete || scan.protected > 0;
            }
            Err(_) => {
                partial = true;
                metrics_available = false;
            }
        }

        ResourceSnapshot {
            sampled_at: chrono::Utc::now().to_rfc3339(),
            application: ApplicationSnapshot {
                known_cache_bytes: metrics_available.then_some(known_bytes),
                known_cache_files: metrics_available.then_some(known_files),
                status: if available_sources == 0 {
                    "unavailable"
                } else if partial {
                    "partial"
                } else {
                    "ready"
                }
                .into(),
            },
            // Windows memory sampling remains unavailable on builds without a stable API.
            // Null communicates unknown and is never represented as zero.
            memory: MemorySnapshot {
                total_bytes: None,
                available_bytes: None,
            },
            disks: disk_snapshot(&clipboard.root),
        }
    }

    pub fn preview(
        &self,
        categories: Vec<Category>,
        clipboard: &ClipboardRuntime,
        shelf_state: &ShelfState,
        audio: &AudioService,
    ) -> AppResult<Preview> {
        let _job = self.try_begin_job()?;
        if categories.is_empty() || categories.iter().any(|c| !Category::all().contains(c)) {
            return Err(AppError::Validation("清理类别为空或无效".into()));
        }
        let unique = categories.iter().copied().collect::<HashSet<_>>();
        if unique.len() != categories.len() {
            return Err(AppError::Validation("清理类别不能重复".into()));
        }

        let mut category_previews = Vec::with_capacity(categories.len());
        let mut plans = HashMap::new();
        for category in categories {
            let scan = match category {
                // 仅清理 Shelf 自有、规范 UUID 命名且超过 24 小时的原子写入 `.part`。
                // Agent spool 与 backup/restore 临时文件属于恢复状态，不纳入白名单。
                Category::Temporary => {
                    scan_shelf_temporaries(&shelf_state.root).map_err(|_| ScanError {
                        code: "SCAN_UNAVAILABLE".into(),
                        message: "暂存架临时文件当前不可读取".into(),
                    })
                }
                Category::Tts => audio
                    .resource_cache_files()
                    .map(|scan| Scan {
                        candidates: scan.files.into_iter().map(tts_candidate).collect(),
                        skipped: scan.skipped_files as u64,
                        incomplete: scan.incomplete,
                        ..Scan::default()
                    })
                    .map_err(|code| ScanError {
                        code,
                        message: "TTS 缓存当前不可读取".into(),
                    }),
                Category::OrphanThumbnails => scan_thumbnails(clipboard, shelf_state),
            };
            match scan {
                Ok(scan) => {
                    let total = scan.candidates.iter().map(|candidate| candidate.size).sum();
                    let incomplete_code = if scan.incomplete {
                        Some("SCAN_LIMIT_REACHED")
                    } else if category == Category::Temporary && scan.protected > 0 {
                        Some("TEMP_SOURCES_PROTECTED")
                    } else {
                        None
                    };
                    category_previews.push(CategoryPreview {
                        category,
                        status: if scan.skipped > 0 || scan.incomplete || scan.protected > 0 {
                            "partial"
                        } else {
                            "ready"
                        }
                        .into(),
                        candidates: scan.candidates.len() as u64,
                        estimated_bytes: total,
                        protected_files: scan.protected,
                        skipped_files: scan.skipped,
                        error_code: if let Some(code) = incomplete_code {
                            Some(code.into())
                        } else if scan.skipped > 0 {
                            Some("SCAN_UNAVAILABLE".into())
                        } else {
                            None
                        },
                        error_message: if scan.incomplete {
                            Some("扫描达到数量或时间上限，当前结果不完整".into())
                        } else if category == Category::Temporary && scan.protected > 0 {
                            Some("未超过 24 小时的 Shelf 临时文件受到保护".into())
                        } else if scan.skipped > 0 {
                            Some("部分文件因路径或身份无法验证而跳过".into())
                        } else {
                            None
                        },
                    });
                    plans.insert(
                        category,
                        PlannedCategory {
                            candidates: scan.candidates,
                            skipped_files: scan.skipped,
                            protected_files: scan.protected,
                            incomplete: scan.incomplete,
                            error_code: if let Some(code) = incomplete_code {
                                Some(code.into())
                            } else if scan.skipped > 0 {
                                Some("SCAN_UNAVAILABLE".into())
                            } else {
                                None
                            },
                        },
                    );
                }
                Err(error) => {
                    tracing::warn!(category = ?category, error_code = %error.code, "资源清理类别扫描不可用");
                    category_previews.push(CategoryPreview {
                        category,
                        status: "unavailable".into(),
                        candidates: 0,
                        estimated_bytes: 0,
                        protected_files: 0,
                        skipped_files: 0,
                        error_code: Some(error.code),
                        error_message: Some(error.message),
                    });
                }
            }
        }

        let created = chrono::Utc::now();
        let expires = created
            + chrono::Duration::from_std(PREVIEW_TTL).unwrap_or(chrono::Duration::minutes(5));
        let id = Uuid::new_v4().to_string();
        let mut state = self
            .previews
            .lock()
            .map_err(|_| AppError::Unavailable("清理预览状态不可用".into()))?;
        let now = Instant::now();
        state.retain(|_, record| record.expires > now);
        while state.len() >= MAX_PREVIEWS {
            let Some(oldest) = state
                .iter()
                .min_by_key(|(_, record)| record.expires)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            state.remove(&oldest);
        }
        state.insert(
            id.clone(),
            PreviewRecord {
                expires: now + PREVIEW_TTL,
                categories: plans,
            },
        );
        Ok(Preview {
            preview_id: id,
            created_at: created.to_rfc3339(),
            expires_at: expires.to_rfc3339(),
            total_candidates: category_previews.iter().map(|c| c.candidates).sum(),
            total_estimated_bytes: category_previews.iter().map(|c| c.estimated_bytes).sum(),
            categories: category_previews,
        })
    }

    pub fn execute(
        &self,
        preview_id: String,
        categories: Vec<Category>,
        clipboard: &ClipboardRuntime,
        shelf_state: &ShelfState,
        audio: &AudioService,
    ) -> AppResult<ExecutionReport> {
        let started = chrono::Utc::now();
        let started_at = Instant::now();
        let _job = self.try_begin_job()?;
        if categories.is_empty() || categories.iter().any(|c| !Category::all().contains(c)) {
            return Err(AppError::Validation("清理类别为空或无效".into()));
        }
        let unique = categories.iter().copied().collect::<HashSet<_>>();
        if unique.len() != categories.len() {
            return Err(AppError::Validation("清理类别不能重复".into()));
        }
        let plan = consume_preview(&self.previews, &preview_id, &categories)?;

        let job_id = Uuid::new_v4().to_string();
        let mut results = Vec::with_capacity(categories.len());
        for category in categories {
            let planned = plan.categories.get(&category).expect("validated category");
            results.push(self.execute_category(category, planned, clipboard, shelf_state, audio));
        }
        let total_freed_bytes = results.iter().map(|result| result.freed_bytes).sum();
        let total_deleted_files = results.iter().map(|result| result.deleted_files).sum();
        let status = overall_status(&results);
        tracing::info!(
            job_id = %job_id,
            status,
            total_freed_bytes,
            total_deleted_files,
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "资源清理执行结束"
        );
        Ok(ExecutionReport {
            job_id,
            started_at: started.to_rfc3339(),
            finished_at: chrono::Utc::now().to_rfc3339(),
            status: status.into(),
            total_freed_bytes,
            total_deleted_files,
            categories: results,
        })
    }

    fn try_begin_job(&self) -> AppResult<std::sync::MutexGuard<'_, ()>> {
        match self.executing.try_lock() {
            Ok(guard) => Ok(guard),
            Err(std::sync::TryLockError::WouldBlock) => {
                Err(AppError::Conflict("CLEANUP_BUSY".into()))
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                Err(AppError::Unavailable("清理执行锁不可用".into()))
            }
        }
    }

    fn execute_category(
        &self,
        category: Category,
        planned: &PlannedCategory,
        clipboard: &ClipboardRuntime,
        shelf_state: &ShelfState,
        audio: &AudioService,
    ) -> CategoryResult {
        let candidates = planned.candidates.len() as u64;
        let estimated_bytes = planned.candidates.iter().map(|c| c.size).sum();
        if category == Category::Temporary {
            let Some(_maintenance) = shelf_state.try_acquire_maintenance_permit() else {
                let skipped = candidates + planned.skipped_files + planned.protected_files;
                return result(
                    category,
                    "skipped",
                    candidates,
                    estimated_bytes,
                    0,
                    0,
                    skipped,
                    0,
                    Some("CLEANUP_BUSY".into()),
                    Some("暂存架文件操作进行中，请稍后重新扫描".into()),
                );
            };
            let mut deleted = 0u64;
            let mut skipped = planned.skipped_files + planned.protected_files;
            let mut failed = 0u64;
            let mut freed = 0u64;
            for candidate in &planned.candidates {
                match delete_shelf_temporary(&shelf_state.root, candidate) {
                    Ok(DeleteOutcome::Deleted(bytes)) => {
                        deleted += 1;
                        freed = freed.saturating_add(bytes);
                    }
                    Ok(DeleteOutcome::Skipped) => skipped += 1,
                    Err(_) => failed += 1,
                }
            }
            let status = if planned.incomplete {
                "partial"
            } else {
                classify(deleted, skipped, failed, candidates)
            };
            return result(
                category,
                status,
                candidates,
                estimated_bytes,
                freed,
                deleted,
                skipped,
                failed,
                planned
                    .error_code
                    .clone()
                    .or_else(|| (failed > 0).then(|| "PARTIAL_FAILURE".into())),
                None,
            );
        }
        if category == Category::Tts {
            let expected = planned
                .candidates
                .iter()
                .filter_map(|candidate| {
                    if candidate.owner != Owner::Tts {
                        return None;
                    }
                    Some(ResourceCacheFile {
                        name: candidate.name.clone(),
                        size: candidate.size,
                        modified_ns: candidate.modified_ns,
                        file_identity: candidate.file_identity,
                    })
                })
                .collect::<Vec<_>>();
            return match audio.clear_resource_cache_files(&expected) {
                Ok(stats) => {
                    let skipped_files = stats.skipped_files as u64
                        + planned.skipped_files
                        + planned.protected_files;
                    let status = if planned.incomplete {
                        "partial"
                    } else {
                        classify(
                            stats.deleted_files as u64,
                            skipped_files,
                            stats.failed_files as u64,
                            candidates,
                        )
                    };
                    result(
                        category,
                        status,
                        candidates,
                        estimated_bytes,
                        stats.freed_bytes,
                        stats.deleted_files as u64,
                        skipped_files,
                        stats.failed_files as u64,
                        (stats.failed_files > 0)
                            .then(|| "PARTIAL_FAILURE".into())
                            .or_else(|| planned.error_code.clone()),
                        None,
                    )
                }
                Err(code) => {
                    tracing::warn!(category = ?category, error_code = %code, "TTS 缓存执行不可用");
                    let skipped = planned.skipped_files + planned.protected_files;
                    result(
                        category,
                        classify(0, skipped, 1, candidates),
                        candidates,
                        estimated_bytes,
                        0,
                        0,
                        skipped,
                        1,
                        Some(code),
                        Some("TTS 缓存暂不可用，未删除文件".into()),
                    )
                }
            };
        }

        let _capture = match clipboard.capture_gate.lock() {
            Ok(gate) => gate,
            Err(_) => {
                let skipped = candidates + planned.skipped_files + planned.protected_files;
                return result(
                    category,
                    classify(0, skipped, 1, candidates),
                    candidates,
                    estimated_bytes,
                    0,
                    0,
                    skipped,
                    1,
                    Some("CLEANUP_BUSY".into()),
                    Some("剪贴板采集同步锁不可用".into()),
                );
            }
        };
        if clipboard.paste.is_active() {
            let skipped = candidates + planned.skipped_files + planned.protected_files;
            return result(
                category,
                "skipped",
                skipped,
                estimated_bytes,
                0,
                0,
                candidates,
                0,
                Some("CLEANUP_BUSY".into()),
                Some("粘贴任务进行中，请稍后重新扫描".into()),
            );
        }
        let Some(_shelf_maintenance) = shelf_state.try_acquire_maintenance_permit() else {
            let skipped = candidates + planned.skipped_files + planned.protected_files;
            return result(
                category,
                "skipped",
                candidates,
                estimated_bytes,
                0,
                0,
                skipped,
                0,
                Some("CLEANUP_BUSY".into()),
                Some("暂存架文件操作进行中，请稍后重新扫描".into()),
            );
        };
        let mut deleted = 0u64;
        let mut skipped = planned.skipped_files + planned.protected_files;
        let mut failed = 0u64;
        let mut freed = 0u64;
        let mut error_code = None;
        for (index, candidate) in planned.candidates.iter().enumerate() {
            let outcome = match candidate.owner {
                Owner::Clipboard => {
                    delete_clipboard_thumbnail(&clipboard.db, &clipboard.root, candidate)
                }
                Owner::Shelf => {
                    delete_shelf_thumbnail(&shelf_state.db, &shelf_state.root, candidate)
                }
                Owner::Tts => {
                    skipped += 1;
                    continue;
                }
                Owner::ShelfTemporary => {
                    skipped += 1;
                    continue;
                }
            };
            match outcome {
                Ok(DeleteOutcome::Deleted(bytes)) => {
                    deleted += 1;
                    freed = freed.saturating_add(bytes);
                }
                Ok(DeleteOutcome::Skipped) => skipped += 1,
                Err(error) => {
                    failed += 1;
                    let code = cleanup_error_code(&error);
                    error_code.get_or_insert_with(|| code.to_string());
                    if matches!(
                        code,
                        "DATABASE_READ_FAILED" | "CLEANUP_BUSY" | "PATH_UNSAFE"
                    ) {
                        // 引用/路径状态不可确定时，不再对本类别后续候选执行删除。
                        skipped += (planned.candidates.len() - index - 1) as u64;
                        break;
                    }
                }
            }
        }
        let status = if planned.incomplete {
            "partial"
        } else {
            classify(deleted, skipped, failed, candidates)
        };
        result(
            category,
            status,
            candidates,
            estimated_bytes,
            freed,
            deleted,
            skipped,
            failed,
            error_code
                .or_else(|| planned.error_code.clone())
                .or_else(|| (failed > 0).then(|| "PARTIAL_FAILURE".into())),
            None,
        )
    }
}

fn consume_preview(
    previews: &Mutex<HashMap<String, PreviewRecord>>,
    preview_id: &str,
    categories: &[Category],
) -> AppResult<PreviewRecord> {
    let mut state = previews
        .lock()
        .map_err(|_| AppError::Unavailable("清理预览状态不可用".into()))?;
    let now = Instant::now();
    state.retain(|_, record| record.expires > now);
    let Some(record) = state.remove(preview_id) else {
        return Err(AppError::Conflict("PREVIEW_EXPIRED".into()));
    };
    if categories
        .iter()
        .any(|category| !record.categories.contains_key(category))
    {
        return Err(AppError::Validation("清理类别不属于此预览".into()));
    }
    Ok(record)
}

#[derive(Default)]
struct Scan {
    candidates: Vec<Candidate>,
    protected: u64,
    skipped: u64,
    known_bytes: u64,
    known_files: u64,
    incomplete: bool,
}

struct ScanError {
    code: String,
    message: String,
}

fn scan_shelf_temporaries(root: &Path) -> AppResult<Scan> {
    let mut total = Scan::default();
    for sub in ["files", "images", "thumbs"] {
        let scan = scan_shelf_temporary_directory(root, sub, MAX_SCAN_ENTRIES, SCAN_TIME_BUDGET)?;
        total.candidates.extend(scan.candidates);
        total.protected = total.protected.saturating_add(scan.protected);
        total.skipped = total.skipped.saturating_add(scan.skipped);
        total.known_bytes = total.known_bytes.saturating_add(scan.known_bytes);
        total.known_files = total.known_files.saturating_add(scan.known_files);
        total.incomplete |= scan.incomplete;
    }
    Ok(total)
}

fn scan_shelf_temporary_directory(
    root: &Path,
    sub: &str,
    max_entries: usize,
    time_budget: Duration,
) -> AppResult<Scan> {
    let Some(directory) = safe_shelf_subdir(root, sub)? else {
        return Ok(Scan::default());
    };
    let mut result = Scan::default();
    let started = Instant::now();
    let mut entries = fs::read_dir(&directory)?;
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
                    result.skipped += 1;
                    result.incomplete = true;
                }
                None => {}
            }
            break;
        }
        let Some(entry) = entries.next() else {
            break;
        };
        visited += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_owned_shelf_part_name(sub, &name) {
            continue;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !shelf::is_reparse_point(&metadata) => metadata,
            Ok(_) | Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let canonical_path = match fs::canonicalize(&path) {
            Ok(path) if path.parent() == Some(directory.as_path()) => path,
            _ => {
                result.skipped += 1;
                continue;
            }
        };
        let Some(modified_ns) = modified_ns(&metadata) else {
            result.skipped += 1;
            continue;
        };
        let Some(file_identity) = shelf::file_identity(&canonical_path) else {
            result.skipped += 1;
            continue;
        };
        result.known_bytes = result.known_bytes.saturating_add(metadata.len());
        result.known_files = result.known_files.saturating_add(1);
        let old_enough = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= SHELF_TEMP_MIN_AGE);
        if !old_enough {
            result.protected += 1;
            continue;
        }
        result.candidates.push(Candidate {
            owner: Owner::ShelfTemporary,
            name: format!("{sub}/{name}"),
            size: metadata.len(),
            modified_ns,
            file_identity,
        });
    }
    Ok(result)
}

fn is_owned_shelf_part_name(sub: &str, name: &str) -> bool {
    if !matches!(sub, "files" | "images" | "thumbs") {
        return false;
    }
    let Some(base) = name.strip_suffix(".part") else {
        return false;
    };
    let mut components = base.split('.');
    let Some(id) = components.next() else {
        return false;
    };
    if Uuid::parse_str(id).map_or(true, |parsed| {
        parsed.to_string() != id || parsed.get_version_num() != 4
    }) {
        return false;
    }
    let extension = match (components.next(), components.next()) {
        (None, None) => None,
        (Some(extension), None) => Some(extension),
        _ => return false,
    };
    match sub {
        "thumbs" => extension == Some("png"),
        "files" | "images" => match extension {
            None => true,
            Some(extension) => {
                !extension.is_empty()
                    && extension.len() <= 16
                    && extension
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            }
        },
        _ => false,
    }
}

fn delete_shelf_temporary(root: &Path, candidate: &Candidate) -> AppResult<DeleteOutcome> {
    if candidate.owner != Owner::ShelfTemporary {
        return Ok(DeleteOutcome::Skipped);
    }
    let Some(path) = verified_shelf_temporary(root, candidate)? else {
        return Ok(DeleteOutcome::Skipped);
    };
    match crate::fs_safety::remove_file_if_unchanged(
        &path,
        candidate.size,
        candidate.modified_ns,
        candidate.file_identity,
    ) {
        Ok(true) => Ok(DeleteOutcome::Deleted(candidate.size)),
        Ok(false) => Ok(DeleteOutcome::Skipped),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DeleteOutcome::Skipped),
        Err(error) => Err(AppError::from(error)),
    }
}

fn verified_shelf_temporary(root: &Path, candidate: &Candidate) -> AppResult<Option<PathBuf>> {
    let Some((sub, name)) = candidate.name.split_once('/') else {
        return Ok(None);
    };
    if !is_owned_shelf_part_name(sub, name) {
        return Ok(None);
    }
    let Some(directory) = safe_shelf_subdir(root, sub)? else {
        return Ok(None);
    };
    let path = directory.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !shelf::is_reparse_point(&metadata) => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some(modified_ns) = modified_ns(&metadata) else {
        return Ok(None);
    };
    let old_enough = metadata
        .modified()?
        .elapsed()
        .is_ok_and(|age| age >= SHELF_TEMP_MIN_AGE);
    if metadata.len() != candidate.size || modified_ns != candidate.modified_ns || !old_enough {
        return Ok(None);
    }
    let canonical = fs::canonicalize(&path)?;
    if canonical.parent() != Some(directory.as_path())
        || shelf::file_identity(&canonical) != Some(candidate.file_identity)
    {
        return Ok(None);
    }
    Ok(Some(canonical))
}

fn scan_thumbnails(
    clipboard: &ClipboardRuntime,
    shelf_state: &ShelfState,
) -> Result<Scan, ScanError> {
    let _capture = clipboard.capture_gate.lock().map_err(|_| ScanError {
        code: "CLEANUP_BUSY".into(),
        message: "剪贴板采集同步锁不可用".into(),
    })?;
    if clipboard.paste.is_active() {
        return Err(ScanError {
            code: "CLEANUP_BUSY".into(),
            message: "粘贴任务进行中，请稍后重新扫描".into(),
        });
    }
    let mut scan =
        scan_clipboard_thumbnails(&clipboard.db, &clipboard.root).map_err(|_| ScanError {
            code: "DATABASE_READ_FAILED".into(),
            message: "剪贴板缩略图引用关系无法读取".into(),
        })?;
    let shelf_scan =
        scan_shelf_thumbnails(&shelf_state.db, &shelf_state.root).map_err(|_| ScanError {
            code: "DATABASE_READ_FAILED".into(),
            message: "暂存架缩略图引用关系无法读取".into(),
        })?;
    scan.candidates.extend(shelf_scan.candidates);
    scan.protected += shelf_scan.protected;
    scan.skipped += shelf_scan.skipped;
    scan.known_bytes = scan.known_bytes.saturating_add(shelf_scan.known_bytes);
    scan.known_files = scan.known_files.saturating_add(shelf_scan.known_files);
    scan.incomplete |= shelf_scan.incomplete;
    Ok(scan)
}

fn scan_clipboard_thumbnails(db: &Db, root: &Path) -> AppResult<Scan> {
    let referenced = db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT path FROM clipboard_assets")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut refs = HashSet::new();
        for row in rows {
            refs.insert(row?);
        }
        Ok(refs)
    })?;
    scan_thumbnail_directory(root, Owner::Clipboard, |name| {
        let rel = format!("thumbs/{name}");
        referenced.contains(&rel)
    })
}

fn scan_shelf_thumbnails(db: &Db, root: &Path) -> AppResult<Scan> {
    let referenced = db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM shelf_items WHERE kind = 'image'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut refs = HashSet::new();
        for row in rows {
            refs.insert(row?);
        }
        Ok(refs)
    })?;
    scan_thumbnail_directory(root, Owner::Shelf, |name| {
        name.strip_suffix(".png")
            .is_some_and(|id| referenced.contains(id))
    })
}

fn scan_thumbnail_directory(
    root: &Path,
    owner: Owner,
    is_referenced: impl Fn(&str) -> bool,
) -> AppResult<Scan> {
    scan_thumbnail_directory_with_limits(
        root,
        owner,
        is_referenced,
        MAX_SCAN_ENTRIES,
        SCAN_TIME_BUDGET,
    )
}

fn scan_thumbnail_directory_with_limits(
    root: &Path,
    owner: Owner,
    is_referenced: impl Fn(&str) -> bool,
    max_entries: usize,
    time_budget: Duration,
) -> AppResult<Scan> {
    let Some(directory) = safe_thumbnail_dir(root)? else {
        return Ok(Scan::default());
    };
    let mut result = Scan::default();
    let started = Instant::now();
    let mut entries = fs::read_dir(&directory)?;
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
                    result.skipped += 1;
                    result.incomplete = true;
                }
                None => {}
            }
            break;
        }
        let Some(entry) = entries.next() else {
            break;
        };
        visited += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".png")
            || name.strip_suffix(".png").map_or(true, |raw_id| {
                Uuid::parse_str(raw_id).map_or(true, |id| id.to_string() != raw_id)
            })
        {
            result.skipped += 1;
            continue;
        }
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && !shelf::is_reparse_point(&meta) => meta,
            Ok(_) => {
                result.skipped += 1;
                continue;
            }
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if fs::canonicalize(&path)
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            != Some(directory.clone())
        {
            result.skipped += 1;
            continue;
        }
        let Some(modified_ns) = modified_ns(&meta) else {
            result.skipped += 1;
            continue;
        };
        let Some(file_identity) = shelf::file_identity(&path) else {
            result.skipped += 1;
            continue;
        };
        result.known_bytes = result.known_bytes.saturating_add(meta.len());
        result.known_files = result.known_files.saturating_add(1);
        if is_referenced(&name) {
            result.protected += 1;
            continue;
        }
        result.candidates.push(Candidate {
            owner: owner.clone(),
            name,
            size: meta.len(),
            modified_ns,
            file_identity,
        });
    }
    Ok(result)
}

fn safe_thumbnail_dir(root: &Path) -> AppResult<Option<PathBuf>> {
    safe_shelf_subdir(root, "thumbs")
}

fn safe_shelf_subdir(root: &Path, sub: &str) -> AppResult<Option<PathBuf>> {
    if !matches!(sub, "files" | "images" | "thumbs") {
        return Err(AppError::Validation("PATH_UNSAFE".into()));
    }
    for ancestor in root.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if shelf::is_reparse_point(&meta) => {
                return Err(AppError::Validation("PATH_UNSAFE".into()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let root_meta = match fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !root_meta.is_dir() || shelf::is_reparse_point(&root_meta) {
        return Err(AppError::Validation("PATH_UNSAFE".into()));
    }
    let canonical_root = fs::canonicalize(root)?;
    let dir = root.join(sub);
    let metadata = match fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || shelf::is_reparse_point(&metadata) {
        return Err(AppError::Validation("PATH_UNSAFE".into()));
    }
    let canonical_dir = fs::canonicalize(&dir)?;
    if canonical_dir.parent() != Some(canonical_root.as_path()) {
        return Err(AppError::Validation("PATH_UNSAFE".into()));
    }
    Ok(Some(canonical_dir))
}

enum DeleteOutcome {
    Deleted(u64),
    Skipped,
}

fn delete_clipboard_thumbnail(
    db: &Db,
    root: &Path,
    candidate: &Candidate,
) -> AppResult<DeleteOutcome> {
    if candidate.owner != Owner::Clipboard {
        return Ok(DeleteOutcome::Skipped);
    }
    delete_thumbnail_transaction(db, root, candidate, |tx, name| {
        let rel = format!("thumbs/{name}");
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM clipboard_assets WHERE path = ?1)",
            [rel],
            |r| r.get::<_, bool>(0),
        )
        .map_err(AppError::from)
    })
}

fn delete_shelf_thumbnail(db: &Db, root: &Path, candidate: &Candidate) -> AppResult<DeleteOutcome> {
    if candidate.owner != Owner::Shelf {
        return Ok(DeleteOutcome::Skipped);
    }
    let id = candidate
        .name
        .strip_suffix(".png")
        .ok_or_else(|| AppError::Validation("PATH_UNSAFE".into()))?
        .to_string();
    delete_thumbnail_transaction(db, root, candidate, |tx, _| {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM shelf_items WHERE id = ?1 AND kind = 'image')",
            [id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(AppError::from)
    })
}

fn delete_thumbnail_transaction(
    db: &Db,
    root: &Path,
    candidate: &Candidate,
    is_referenced: impl FnOnce(&Connection, &str) -> AppResult<bool>,
) -> AppResult<DeleteOutcome> {
    // DB writer reservation closes the reference-insertion race. Windows deletion is applied to
    // the same verified handle; unsupported platforms conservatively skip the file.
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            if is_referenced(conn, &candidate.name)? {
                return Ok(DeleteOutcome::Skipped);
            }
            let Some(path) = verified_file(
                root,
                &candidate.name,
                candidate.size,
                candidate.modified_ns,
                candidate.file_identity,
            )?
            else {
                return Ok(DeleteOutcome::Skipped);
            };
            match crate::fs_safety::remove_file_if_unchanged(
                &path,
                candidate.size,
                candidate.modified_ns,
                candidate.file_identity,
            ) {
                Ok(true) => Ok(DeleteOutcome::Deleted(candidate.size)),
                Ok(false) => Ok(DeleteOutcome::Skipped),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(DeleteOutcome::Skipped)
                }
                Err(error) => Err(AppError::from(error)),
            }
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

fn verified_file(
    root: &Path,
    name: &str,
    size: u64,
    modified: u128,
    identity: u128,
) -> AppResult<Option<PathBuf>> {
    let Some(directory) = safe_thumbnail_dir(root)? else {
        return Ok(None);
    };
    let path = directory.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && !shelf::is_reparse_point(&meta) => meta,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.len() != size
        || modified_ns(&metadata) != Some(modified)
        || shelf::file_identity(&path) != Some(identity)
    {
        return Ok(None);
    }
    let canonical = fs::canonicalize(&path)?;
    if canonical.parent() != Some(directory.as_path()) {
        return Ok(None);
    }
    Ok(Some(canonical))
}

fn tts_candidate(file: ResourceCacheFile) -> Candidate {
    Candidate {
        owner: Owner::Tts,
        name: file.name,
        size: file.size,
        modified_ns: file.modified_ns,
        file_identity: file.file_identity,
    }
}

fn modified_ns(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
}

fn cleanup_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::Db(_) => "DATABASE_READ_FAILED",
        AppError::Conflict(_) | AppError::Overloaded(_) => "CLEANUP_BUSY",
        AppError::Validation(_) => "PATH_UNSAFE",
        AppError::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            #[cfg(windows)]
            if matches!(error.raw_os_error(), Some(32 | 33)) {
                return "FILE_IN_USE";
            }
            "PERMISSION_DENIED"
        }
        AppError::Io(_) => "INTERNAL_ERROR",
        _ => "INTERNAL_ERROR",
    }
}

fn add_counts(bytes: &mut u64, files: &mut u64, sizes: impl Iterator<Item = u64>) {
    for size in sizes {
        *bytes = bytes.saturating_add(size);
        *files = files.saturating_add(1);
    }
}

fn classify(deleted: u64, skipped: u64, failed: u64, candidates: u64) -> &'static str {
    if skipped > 0 {
        if deleted > 0 || failed > 0 {
            "partial"
        } else {
            "skipped"
        }
    } else if failed > 0 {
        if deleted > 0 {
            "partial"
        } else {
            "failed"
        }
    } else if candidates == 0 || deleted == candidates {
        "success"
    } else {
        "partial"
    }
}

fn overall_status(results: &[CategoryResult]) -> &'static str {
    if results.iter().all(|result| result.status == "success") {
        "success"
    } else if results.iter().all(|result| result.status == "failed") {
        "failed"
    } else {
        "partial"
    }
}

#[allow(clippy::too_many_arguments)]
fn result(
    category: Category,
    status: &str,
    candidates: u64,
    estimated_bytes: u64,
    freed_bytes: u64,
    deleted_files: u64,
    skipped_files: u64,
    failed_files: u64,
    error_code: Option<String>,
    error_message: Option<String>,
) -> CategoryResult {
    CategoryResult {
        category,
        status: status.into(),
        candidates,
        estimated_bytes,
        freed_bytes,
        deleted_files,
        skipped_files,
        failed_files,
        error_code,
        error_message,
    }
}

#[cfg(windows)]
fn disk_snapshot(path: &Path) -> Vec<DiskSnapshot> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    let volume = path
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default();
    vec![DiskSnapshot {
        volume,
        total_bytes: (ok != 0).then_some(total),
        available_bytes: (ok != 0).then_some(available),
    }]
}

#[cfg(not(windows))]
fn disk_snapshot(_path: &Path) -> Vec<DiskSnapshot> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("td-resource-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn categories_are_fixed_and_have_no_duplicate_ids() {
        let all = Category::all();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().copied().collect::<HashSet<_>>().len(), 3);
    }

    #[test]
    fn temporary_scan_only_selects_stale_shelf_owned_part_files() {
        let root = temp_root("shelf-temp");
        for sub in ["files", "images", "thumbs"] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }
        let stale = root
            .join("files")
            .join(format!("{}.bin.part", Uuid::new_v4()));
        fs::write(&stale, b"stale-part").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(48 * 60 * 60))
            .unwrap();
        let recent = root
            .join("images")
            .join(format!("{}.png.part", Uuid::new_v4()));
        fs::write(&recent, b"recent-part").unwrap();
        fs::write(root.join("files/not-owned.part"), b"unknown").unwrap();
        fs::write(
            root.join("thumbs/00000000-0000-0000-0000-000000000001.png"),
            b"complete-thumb",
        )
        .unwrap();

        let scan = scan_shelf_temporaries(&root).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(
            scan.candidates[0].name,
            format!("files/{}", stale.file_name().unwrap().to_string_lossy())
        );
        assert_eq!(scan.protected, 1);
        assert_eq!(scan.known_files, 2);
        assert_eq!(
            scan.known_bytes,
            b"stale-part".len() as u64 + b"recent-part".len() as u64
        );
        assert!(!scan.incomplete);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temporary_scan_limit_is_marked_incomplete() {
        let root = temp_root("shelf-temp-limit");
        fs::create_dir_all(root.join("files")).unwrap();
        let scan = scan_shelf_temporary_directory(&root, "files", MAX_SCAN_ENTRIES, Duration::ZERO)
            .unwrap();
        assert!(scan.incomplete);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temporary_deletion_revalidates_stale_candidate() {
        let root = temp_root("shelf-temp-delete");
        fs::create_dir_all(root.join("files")).unwrap();
        let path = root
            .join("files")
            .join(format!("{}.bin.part", Uuid::new_v4()));
        fs::write(&path, b"stale-part").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(48 * 60 * 60))
            .unwrap();
        let scan = scan_shelf_temporaries(&root).unwrap();
        assert_eq!(scan.candidates.len(), 1);

        let outcome = delete_shelf_temporary(&root, &scan.candidates[0]).unwrap();
        #[cfg(windows)]
        {
            assert!(
                matches!(outcome, DeleteOutcome::Deleted(bytes) if bytes == b"stale-part".len() as u64)
            );
            assert!(!path.exists());
        }
        #[cfg(not(windows))]
        {
            assert!(matches!(outcome, DeleteOutcome::Skipped));
            assert!(path.exists());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temporary_candidate_name_requires_canonical_uuid_and_owned_extension() {
        let id = Uuid::new_v4().to_string();
        assert!(is_owned_shelf_part_name(
            "thumbs",
            &format!("{id}.png.part")
        ));
        assert!(is_owned_shelf_part_name("files", &format!("{id}.part")));
        assert!(!is_owned_shelf_part_name("files", "not-an-id.png.part"));
        assert!(!is_owned_shelf_part_name(
            "thumbs",
            &format!("{id}.png.tmp")
        ));
        assert!(!is_owned_shelf_part_name(
            "images",
            &format!("{id}.some.ext.part")
        ));
        assert!(!is_owned_shelf_part_name(
            "thumbs",
            &format!("{id}.bin.part")
        ));
        assert!(!is_owned_shelf_part_name(
            "thumbs",
            "00000000-0000-0000-0000-000000000001.png.part"
        ));
    }

    #[test]
    fn preview_and_candidate_types_keep_only_server_side_identity() {
        let candidate = Candidate {
            owner: Owner::Shelf,
            name: "00000000-0000-0000-0000-000000000001.png".into(),
            size: 8,
            modified_ns: 10,
            file_identity: 12,
        };
        assert_eq!(candidate.name, "00000000-0000-0000-0000-000000000001.png");
        let json = serde_json::to_value(Category::OrphanThumbnails).unwrap();
        assert_eq!(json, "orphan_thumbnails");
    }

    #[test]
    fn result_classification_does_not_count_missing_files_as_successful_deletions() {
        assert_eq!(classify(0, 1, 0, 1), "skipped");
        assert_eq!(classify(0, 0, 1, 1), "failed");
        assert_eq!(classify(1, 1, 0, 2), "partial");
    }

    #[test]
    fn concurrent_resource_job_returns_busy_immediately() {
        let state = ResourceCleanupState::default();
        let _guard = state.executing.lock().unwrap();
        assert!(matches!(
            state.try_begin_job(),
            Err(AppError::Conflict(code)) if code == "CLEANUP_BUSY"
        ));
    }

    #[test]
    fn protected_or_skipped_category_keeps_execution_report_partial() {
        let category = result(
            Category::Temporary,
            "partial",
            0,
            0,
            0,
            0,
            1,
            0,
            Some("TEMP_SOURCES_PROTECTED".into()),
            None,
        );
        assert_eq!(overall_status(&[category]), "partial");
    }

    #[test]
    fn preview_is_single_use_and_expired_records_are_rejected() {
        let previews = Mutex::new(HashMap::new());
        let id = "one-shot".to_string();
        let mut categories = HashMap::new();
        categories.insert(
            Category::Tts,
            PlannedCategory {
                candidates: Vec::new(),
                skipped_files: 0,
                protected_files: 0,
                incomplete: false,
                error_code: None,
            },
        );
        previews.lock().unwrap().insert(
            id.clone(),
            PreviewRecord {
                expires: Instant::now() + PREVIEW_TTL,
                categories,
            },
        );
        assert!(consume_preview(&previews, &id, &[Category::Tts]).is_ok());
        assert!(consume_preview(&previews, &id, &[Category::Tts]).is_err());

        previews.lock().unwrap().insert(
            id.clone(),
            PreviewRecord {
                expires: Instant::now() - Duration::from_secs(1),
                categories: HashMap::from([(
                    Category::Tts,
                    PlannedCategory {
                        candidates: Vec::new(),
                        skipped_files: 0,
                        protected_files: 0,
                        incomplete: false,
                        error_code: None,
                    },
                )]),
            },
        );
        assert!(consume_preview(&previews, &id, &[Category::Tts]).is_err());
        assert!(!previews.lock().unwrap().contains_key(&id));
    }

    #[test]
    fn clipboard_thumbnail_scan_is_limited_to_thumbs_and_fails_closed_on_db_error() {
        let root = temp_root("thumb-scan");
        fs::create_dir_all(root.join("thumbs")).unwrap();
        fs::create_dir_all(root.join("images")).unwrap();
        let id = Uuid::new_v4().to_string();
        fs::write(root.join("thumbs").join(format!("{id}.png")), b"thumb").unwrap();
        fs::write(root.join("images").join(format!("{id}.png")), b"original").unwrap();
        let db = Db::open_in_memory().unwrap();

        let scan = scan_clipboard_thumbnails(&db, &root).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.known_files, 1);
        assert_eq!(scan.known_bytes, 5);
        assert_eq!(scan.candidates[0].name, format!("{id}.png"));

        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE clipboard_assets;")?;
            Ok(())
        })
        .unwrap();
        assert!(scan_clipboard_thumbnails(&db, &root).is_err());
        assert!(root.join("thumbs").join(format!("{id}.png")).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn thumbnail_scan_limit_is_marked_incomplete() {
        let root = temp_root("thumb-scan-limit");
        fs::create_dir_all(root.join("thumbs")).unwrap();
        fs::write(
            root.join("thumbs").join(format!("{}.png", Uuid::new_v4())),
            b"a",
        )
        .unwrap();
        fs::write(
            root.join("thumbs").join(format!("{}.png", Uuid::new_v4())),
            b"b",
        )
        .unwrap();
        let scan = scan_thumbnail_directory_with_limits(
            &root,
            Owner::Clipboard,
            |_| false,
            1,
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.incomplete);
        assert_eq!(scan.known_files, 1);
        assert_eq!(scan.known_bytes, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clipboard_thumbnail_reference_added_after_preview_prevents_delete() {
        let root = temp_root("thumb-ref-race");
        fs::create_dir_all(root.join("thumbs")).unwrap();
        let id = Uuid::new_v4().to_string();
        let path = root.join("thumbs").join(format!("{id}.png"));
        fs::write(&path, b"thumb").unwrap();
        let db = Db::open_in_memory().unwrap();
        let scan = scan_clipboard_thumbnails(&db, &root).unwrap();
        let candidate = scan.candidates.into_iter().next().unwrap();

        // 在 preview 与 execute 之间登记新引用；执行端的 IMMEDIATE transaction 必须重查。
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO clipboard_items (id, kind, content_hash, created_at, last_seen_at) VALUES (?1,'image',?2,'now','now')",
                rusqlite::params![id, format!("hash-{id}")],
            )?;
            conn.execute(
                "INSERT INTO clipboard_assets (id, item_id, role, path, created_at) VALUES (?1,?2,'thumb',?3,'now')",
                rusqlite::params![Uuid::new_v4().to_string(), id, format!("thumbs/{id}.png")],
            )?;
            Ok(())
        }).unwrap();

        assert!(matches!(
            delete_clipboard_thumbnail(&db, &root, &candidate).unwrap(),
            DeleteOutcome::Skipped
        ));
        assert!(path.exists(), "执行时新增的数据库引用必须保护缩略图");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clipboard_thumbnail_delete_fails_closed_when_reference_query_fails() {
        let root = temp_root("thumb-delete-query-fail");
        fs::create_dir_all(root.join("thumbs")).unwrap();
        let id = Uuid::new_v4().to_string();
        let path = root.join("thumbs").join(format!("{id}.png"));
        fs::write(&path, b"thumb").unwrap();
        let db = Db::open_in_memory().unwrap();
        let scan = scan_clipboard_thumbnails(&db, &root).unwrap();
        let candidate = scan.candidates.into_iter().next().unwrap();
        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE clipboard_assets;")?;
            Ok(())
        })
        .unwrap();

        assert!(delete_clipboard_thumbnail(&db, &root, &candidate).is_err());
        assert!(path.exists(), "引用复查失败必须保留文件");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn thumbnail_replacement_with_same_size_and_mtime_is_not_the_previewed_file() {
        let root = temp_root("thumb-replaced");
        let thumbs = root.join("thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        let id = Uuid::new_v4().to_string();
        let path = thumbs.join(format!("{id}.png"));
        fs::write(&path, b"same-size").unwrap();
        let scan = scan_thumbnail_directory(&root, Owner::Clipboard, |_| false).unwrap();
        let candidate = scan.candidates.into_iter().next().unwrap();
        let old_modified = fs::metadata(&path).unwrap().modified().unwrap();

        let replaced = thumbs.join("replacement.tmp");
        fs::rename(&path, &replaced).unwrap();
        fs::write(&path, b"same-size").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old_modified)
            .unwrap();

        assert!(verified_file(
            &root,
            &candidate.name,
            candidate.size,
            candidate.modified_ns,
            candidate.file_identity,
        )
        .unwrap()
        .is_none());
        let db = Db::open_in_memory().unwrap();
        assert!(matches!(
            delete_clipboard_thumbnail(&db, &root, &candidate).unwrap(),
            DeleteOutcome::Skipped
        ));
        assert!(path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
