//! 用户级磁盘垃圾清理：回收站、用户/系统临时文件、崩溃转储。
//!
//! 与 `mod.rs` 的应用缓存清理**相互独立**：类别、扫描根、预览记录、作业闸都不共享，
//! 也不扩大对方的删除范围。
//!
//! 边界：
//! - 固定类别白名单；扫描根只由系统环境变量解析（`TEMP` / `LOCALAPPDATA` / `SystemRoot`），
//!   **不接受前端传入路径**；解析后要求存在、是普通目录、且规范化为本地盘符路径；
//! - 只删除**文件**，不删除目录、不跟随符号链接 / reparse point、不进入挂载点；
//! - 临时类文件必须超过 7 天未被修改；更年轻的文件计为受保护，不出现在候选里；
//! - 执行只接受服务端预览 ID（5 分钟 TTL、一次性消费），并对每个候选重新校验
//!   根目录归属、文件身份、大小、修改时间与年龄；
//! - 回收站预览按文件系统口径统计当前用户在各卷的 `$Recycle.Bin\<SID>`（Shell 枚举
//!   在万级项目时需要数十秒，不适合作为预览）；清空走 `SHEmptyRecycleBinW`，
//!   实际释放量按清空前后的同一文件系统口径差测量，不声称逐文件身份复核；
//! - 有界：每个类别最多检查 24,000 个条目、6 秒预算、递归深度 4；超限标记不完整，
//!   结果只代表已检查子集。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::classify;

const PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
/// 用户垃圾的预览记录最多 8 条：单条可能持有上万个路径，避免常驻内存无界。
const MAX_PREVIEWS: usize = 8;
const MAX_ENTRIES: usize = 24_000;
const TIME_BUDGET: Duration = Duration::from_secs(6);
const MAX_DEPTH: usize = 4;
/// 临时类数据的最短保留年龄：7 天。运行中的安装程序、编辑器等不会命中。
const MIN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// 回收站统计单独的上限：回收站可能包含数万个条目，但仍必须可中断。
const RECYCLE_MAX_ENTRIES: usize = 240_000;
const RECYCLE_TIME_BUDGET: Duration = Duration::from_secs(8);
const RECYCLE_MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JunkCategory {
    RecycleBin,
    UserTemp,
    SystemTemp,
    CrashDumps,
}

impl JunkCategory {
    fn all() -> [Self; 4] {
        [
            Self::RecycleBin,
            Self::UserTemp,
            Self::SystemTemp,
            Self::CrashDumps,
        ]
    }

    fn uses_file_roots(self) -> bool {
        !matches!(self, Self::RecycleBin)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunkCategoryPreview {
    pub category: JunkCategory,
    pub status: String,
    /// 文件类为候选文件数；回收站为 Shell 报告的项数。
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
pub struct JunkPreview {
    pub preview_id: String,
    pub created_at: String,
    pub expires_at: String,
    /// 临时类候选的最短年龄（小时）；界面据此说明「早于 N 天」。
    pub minimum_age_hours: u64,
    pub categories: Vec<JunkCategoryPreview>,
    pub total_candidates: u64,
    pub total_estimated_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunkCategoryResult {
    pub category: JunkCategory,
    pub status: String,
    pub candidates: u64,
    pub estimated_bytes: u64,
    /// 实际释放量：文件类为成功删除文件的大小之和；回收站为清空前后统计差。
    pub freed_bytes: u64,
    /// 文件类为删除文件数；回收站为清空的项数。
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
pub struct JunkExecutionReport {
    pub job_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: String,
    pub total_freed_bytes: u64,
    pub total_deleted_files: u64,
    pub categories: Vec<JunkCategoryResult>,
}

#[derive(Debug, Clone)]
struct JunkCandidate {
    path: PathBuf,
    size: u64,
    modified_ns: u128,
    identity: u128,
}

#[derive(Debug)]
struct PlannedJunk {
    candidates: Vec<JunkCandidate>,
    estimated_bytes: u64,
    /// 回收站的项数；文件类为 0。
    recycle_items: u64,
    protected_files: u64,
    skipped_files: u64,
    incomplete: bool,
    /// 扫描结论：`ready` / `partial`（不完整）/ `unavailable`（根或 Shell 不可用）。
    status: &'static str,
    error_code: Option<String>,
    error_message: Option<String>,
}

impl Default for PlannedJunk {
    fn default() -> Self {
        Self {
            candidates: Vec::new(),
            estimated_bytes: 0,
            recycle_items: 0,
            protected_files: 0,
            skipped_files: 0,
            incomplete: false,
            status: "ready",
            error_code: None,
            error_message: None,
        }
    }
}

impl PlannedJunk {
    fn candidate_count(&self) -> u64 {
        if self.recycle_items > 0 {
            self.recycle_items
        } else {
            self.candidates.len() as u64
        }
    }
}

#[derive(Debug)]
struct PreviewRecord {
    expires: Instant,
    categories: HashMap<JunkCategory, PlannedJunk>,
}

#[derive(Default)]
pub struct UserJunkState {
    previews: Mutex<HashMap<String, PreviewRecord>>,
    executing: Mutex<()>,
}

impl UserJunkState {
    /// 扫描固定类别的用户级垃圾。只读；不删除、不写入。
    pub fn preview(&self, categories: Vec<JunkCategory>) -> AppResult<JunkPreview> {
        let _job = self.try_begin_job()?;
        validate_categories(&categories)?;

        let mut previews = Vec::with_capacity(categories.len());
        let mut plans = HashMap::new();
        for category in categories {
            let planned = if category.uses_file_roots() {
                match roots_for(category) {
                    Ok(roots) => scan_roots(&roots, category, Limits::default()),
                    Err((code, message)) => PlannedJunk {
                        skipped_files: 1,
                        incomplete: true,
                        status: "unavailable",
                        error_code: Some(code),
                        error_message: Some(message),
                        ..PlannedJunk::default()
                    },
                }
            } else {
                scan_recycle_bin()
            };
            previews.push(JunkCategoryPreview {
                category,
                status: planned.status.into(),
                candidates: planned.candidate_count(),
                estimated_bytes: planned.estimated_bytes,
                protected_files: planned.protected_files,
                skipped_files: planned.skipped_files,
                error_code: planned.error_code.clone(),
                error_message: planned.error_message.clone(),
            });
            plans.insert(category, planned);
        }

        let created = chrono::Utc::now();
        let expires = created
            + chrono::Duration::from_std(PREVIEW_TTL).unwrap_or_else(|_| chrono::Duration::minutes(5));
        let id = Uuid::new_v4().to_string();
        let mut state = self
            .previews
            .lock()
            .map_err(|_| AppError::Unavailable("垃圾清理预览状态不可用".into()))?;
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

        Ok(JunkPreview {
            preview_id: id,
            created_at: created.to_rfc3339(),
            expires_at: expires.to_rfc3339(),
            minimum_age_hours: MIN_AGE.as_secs() / 3600,
            total_candidates: previews.iter().map(|row| row.candidates).sum(),
            total_estimated_bytes: previews.iter().map(|row| row.estimated_bytes).sum(),
            categories: previews,
        })
    }

    /// 执行预览中已勾选的类别。预览一次性消费；每个文件在删除前重新验证身份。
    pub fn execute(
        &self,
        preview_id: String,
        categories: Vec<JunkCategory>,
    ) -> AppResult<JunkExecutionReport> {
        let started = chrono::Utc::now();
        let _job = self.try_begin_job()?;
        validate_categories(&categories)?;
        let plan = consume_preview(&self.previews, &preview_id, &categories)?;

        let job_id = Uuid::new_v4().to_string();
        let mut results = Vec::with_capacity(categories.len());
        for category in categories {
            let planned = plan.categories.get(&category).expect("validated category");
            results.push(if category == JunkCategory::RecycleBin {
                execute_recycle_bin(planned)
            } else {
                execute_files(category, planned)
            });
        }
        let total_freed_bytes = results.iter().map(|row| row.freed_bytes).sum();
        let total_deleted_files = results.iter().map(|row| row.deleted_files).sum();
        let status = overall_junk_status(&results);
        tracing::info!(
            job_id = %job_id,
            status,
            total_freed_bytes,
            total_deleted_files,
            "用户级垃圾清理执行结束"
        );
        Ok(JunkExecutionReport {
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
}

fn validate_categories(categories: &[JunkCategory]) -> AppResult<()> {
    if categories.is_empty() || categories.iter().any(|c| !JunkCategory::all().contains(c)) {
        return Err(AppError::Validation("清理类别为空或无效".into()));
    }
    let unique = categories.iter().copied().collect::<HashSet<_>>();
    if unique.len() != categories.len() {
        return Err(AppError::Validation("清理类别不能重复".into()));
    }
    Ok(())
}

fn consume_preview(
    previews: &Mutex<HashMap<String, PreviewRecord>>,
    preview_id: &str,
    categories: &[JunkCategory],
) -> AppResult<PreviewRecord> {
    let mut state = previews
        .lock()
        .map_err(|_| AppError::Unavailable("垃圾清理预览状态不可用".into()))?;
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

#[derive(Debug, Clone, Copy)]
struct Limits {
    entries: usize,
    budget: Duration,
    depth: usize,
    min_age: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: MAX_ENTRIES,
            budget: TIME_BUDGET,
            depth: MAX_DEPTH,
            min_age: MIN_AGE,
        }
    }
}

/// 类别 → 扫描根。根目录只从系统环境变量推导，调用方不能指定路径。
fn roots_for(category: JunkCategory) -> Result<Vec<PathBuf>, (String, String)> {
    let missing = || {
        (
            "SCAN_UNAVAILABLE".to_string(),
            "系统目录不可用，无法扫描该类别".to_string(),
        )
    };
    let mut candidates = Vec::new();
    match category {
        JunkCategory::RecycleBin => return Ok(Vec::new()),
        JunkCategory::UserTemp => {
            if let Some(value) = non_empty_env("TEMP") {
                candidates.push(PathBuf::from(value));
            }
            if let Some(base) = non_empty_env("LOCALAPPDATA") {
                candidates.push(PathBuf::from(base).join("Temp"));
            }
            if candidates.is_empty() {
                return Err(missing());
            }
        }
        JunkCategory::SystemTemp => {
            let base = non_empty_env("SystemRoot")
                .or_else(|| non_empty_env("windir"))
                .or_else(|| Some(std::ffi::OsString::from("C:\\Windows")))
                .ok_or_else(missing)?;
            candidates.push(PathBuf::from(base).join("Temp"));
        }
        JunkCategory::CrashDumps => {
            let base = non_empty_env("LOCALAPPDATA").ok_or_else(missing)?;
            let base = PathBuf::from(base);
            candidates.push(base.join("CrashDumps"));
            candidates.push(base.join("Microsoft\\Windows\\WER\\ReportArchive"));
            candidates.push(base.join("Microsoft\\Windows\\WER\\ReportQueue"));
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        let Some(root) = normalize_root(&candidate) else {
            continue;
        };
        if !roots.iter().any(|existing| same_path(existing, &root)) {
            roots.push(root);
        }
    }
    if roots.is_empty() && matches!(category, JunkCategory::SystemTemp) {
        return Err(missing());
    }
    Ok(roots)
}

fn non_empty_env(key: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(key).filter(|value| !value.is_empty())
}

/// 规范化扫描根：必须存在、是普通目录、规范化为本地盘符路径。
/// 指向其他位置的链接会被 `canonicalize` 解析成真实目录（用户环境的真实临时目录），
/// 候选路径因此都落在规范化后的根下。
fn normalize_root(path: &Path) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    if !is_local_drive_path(&canonical) {
        return None;
    }
    Some(canonical)
}

fn is_local_drive_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        // `fs::canonicalize` 在 Windows 返回 `\\?\C:\...`（VerbatimDisk），
        // 普通输入路径则是 `Disk`。两者都是本地盘符；UNC / 设备路径一律拒绝。
        matches!(
            path.components().next(),
            Some(std::path::Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                )
        ) && path.has_root()
    }
    #[cfg(not(windows))]
    {
        path.is_absolute()
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_path(left) == normalized_path(right)
}

fn normalized_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    let value = if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()
    };
    value.trim_end_matches('\\').to_lowercase()
}

fn scan_roots(roots: &[PathBuf], _category: JunkCategory, limits: Limits) -> PlannedJunk {
    let mut planned = PlannedJunk::default();
    let started = Instant::now();
    let mut entries_left = limits.entries;
    for root in roots {
        if entries_left == 0 || started.elapsed() >= limits.budget {
            planned.incomplete = true;
            break;
        }
        scan_root(root, &mut planned, &mut entries_left, started, limits);
    }
    if planned.incomplete {
        planned.status = "partial";
        planned.error_code = Some("SCAN_LIMIT_REACHED".into());
        planned.error_message = Some("扫描达到数量或时间上限，结果仅包含已检查部分".into());
    } else if planned.skipped_files > 0 {
        planned.status = "partial";
        planned.error_code = Some("PARTIAL_READ".into());
        planned.error_message = Some("部分文件因权限或路径无法验证而跳过".into());
    }
    planned
}

fn scan_root(
    root: &Path,
    planned: &mut PlannedJunk,
    entries_left: &mut usize,
    started: Instant,
    limits: Limits,
) {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            planned.skipped_files += 1;
            return;
        }
    };
    if !metadata.is_dir() {
        planned.skipped_files += 1;
        return;
    }
    if crate::shelf::is_reparse_point(&metadata) {
        planned.skipped_files += 1;
        return;
    }
    let canonical = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(_) => {
            planned.skipped_files += 1;
            return;
        }
    };

    let mut stack = vec![(canonical, 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                planned.skipped_files += 1;
                continue;
            }
        };
        for entry in entries {
            if *entries_left == 0 || started.elapsed() >= limits.budget {
                planned.incomplete = true;
                return;
            }
            *entries_left -= 1;
            let Ok(entry) = entry else {
                planned.skipped_files += 1;
                continue;
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    planned.skipped_files += 1;
                    continue;
                }
            };
            if metadata.is_dir() {
                if depth + 1 < limits.depth {
                    if crate::shelf::is_reparse_point(&metadata) {
                        planned.skipped_files += 1;
                    } else {
                        stack.push((path, depth + 1));
                    }
                }
                continue;
            }
            if !metadata.is_file() || crate::shelf::is_reparse_point(&metadata) {
                planned.skipped_files += 1;
                continue;
            }
            let Some(modified_ns) = modified_ns(&metadata) else {
                planned.skipped_files += 1;
                continue;
            };
            let old_enough = metadata
                .modified()
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= limits.min_age);
            if !old_enough {
                planned.protected_files += 1;
                continue;
            }
            let Some(identity) = crate::shelf::file_identity(&path) else {
                planned.skipped_files += 1;
                continue;
            };
            planned.estimated_bytes = planned.estimated_bytes.saturating_add(metadata.len());
            planned.candidates.push(JunkCandidate {
                path,
                size: metadata.len(),
                modified_ns,
                identity,
            });
        }
    }
}

fn execute_files(category: JunkCategory, planned: &PlannedJunk) -> JunkCategoryResult {
    let candidates = planned.candidates.len() as u64;
    let estimated_bytes = planned.candidates.iter().map(|c| c.size).sum::<u64>();
    let roots = roots_for(category)
        .map(|roots| roots.iter().map(|root| normalized_path(root)).collect::<Vec<_>>())
        .unwrap_or_default();
    let now = SystemTime::now();
    let mut deleted = 0u64;
    let mut freed = 0u64;
    let mut skipped = planned.skipped_files;
    let mut failed = 0u64;
    let mut error_code = None;
    for candidate in &planned.candidates {
        if !roots
            .iter()
            .any(|root| normalized_path(&candidate.path).starts_with(&format!("{root}\\")))
        {
            skipped += 1;
            continue;
        }
        if !still_matches(candidate, now) {
            skipped += 1;
            continue;
        }
        match crate::fs_safety::remove_scanned_file(
            &candidate.path,
            candidate.size,
            candidate.modified_ns,
            candidate.identity,
        ) {
            Ok(true) => {
                deleted += 1;
                freed = freed.saturating_add(candidate.size);
            }
            Ok(false) => skipped += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => skipped += 1,
            Err(error) => {
                failed += 1;
                error_code.get_or_insert_with(|| file_error_code(&error).to_string());
            }
        }
    }
    let status = if planned.incomplete {
        "partial"
    } else {
        classify(deleted, skipped, failed, candidates)
    };
    JunkCategoryResult {
        category,
        status: status.into(),
        candidates,
        estimated_bytes,
        freed_bytes: freed,
        deleted_files: deleted,
        skipped_files: skipped,
        failed_files: failed,
        error_code: error_code
            .or_else(|| planned.error_code.clone())
            .or_else(|| (failed > 0).then(|| "PARTIAL_FAILURE".into())),
        error_message: planned.error_message.clone(),
    }
}

/// 执行前复核：仍然是同一个普通文件，且仍然超过保留年龄。
fn still_matches(candidate: &JunkCandidate, now: SystemTime) -> bool {
    let Ok(metadata) = fs::symlink_metadata(&candidate.path) else {
        return false;
    };
    if !metadata.is_file() || crate::shelf::is_reparse_point(&metadata) {
        return false;
    }
    if metadata.len() != candidate.size || modified_ns(&metadata) != Some(candidate.modified_ns) {
        return false;
    }
    if crate::shelf::file_identity(&candidate.path) != Some(candidate.identity) {
        return false;
    }
    metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age >= MIN_AGE)
}

fn overall_junk_status(results: &[JunkCategoryResult]) -> &'static str {
    if results.iter().all(|row| row.status == "success") {
        "success"
    } else if results
        .iter()
        .all(|row| matches!(row.status.as_str(), "failed" | "unavailable"))
    {
        "failed"
    } else {
        "partial"
    }
}

fn file_error_code(error: &std::io::Error) -> &'static str {    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return "FILE_IN_USE";
    }
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return "PERMISSION_DENIED";
    }
    "INTERNAL_ERROR"
}

fn modified_ns(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
}

/// 回收站：只读统计。使用文件系统口径（各卷 `$Recycle.Bin\<当前用户 SID>`），
/// 不调用 `SHQueryRecycleBinW`：实测 1.8 万项时 Shell 枚举需要约 80 秒，
/// 会拖死整次预览。清空仍走 Shell，释放量按清空前后的同一文件系统口径差测量。
fn scan_recycle_bin() -> PlannedJunk {
    match recycle_bin_roots() {
        Ok(roots) if roots.is_empty() => PlannedJunk::default(),
        Ok(roots) => {
            let totals = recycle_totals_for(&roots);
            let mut planned = PlannedJunk {
                recycle_items: totals.items,
                estimated_bytes: totals.bytes,
                skipped_files: totals.skipped,
                ..PlannedJunk::default()
            };
            if totals.incomplete {
                planned.status = "partial";
                planned.error_code = Some("SCAN_LIMIT_REACHED".into());
                planned.error_message =
                    Some("回收站统计达到数量或时间上限，仅包含已检查部分".into());
            } else if totals.skipped > 0 {
                planned.status = "partial";
                planned.error_code = Some("PARTIAL_READ".into());
                planned.error_message = Some("部分回收站项目无法读取".into());
            }
            planned
        }
        Err((code, message)) => PlannedJunk {
            skipped_files: 1,
            incomplete: true,
            status: "unavailable",
            error_code: Some(code),
            error_message: Some(message),
            ..PlannedJunk::default()
        },
    }
}

fn execute_recycle_bin(planned: &PlannedJunk) -> JunkCategoryResult {
    let candidates = planned.recycle_items;
    let estimated_bytes = planned.estimated_bytes;
    if planned.status == "unavailable" {
        return JunkCategoryResult {
            category: JunkCategory::RecycleBin,
            status: "unavailable".into(),
            candidates: 0,
            estimated_bytes: 0,
            freed_bytes: 0,
            deleted_files: 0,
            skipped_files: planned.skipped_files,
            failed_files: 0,
            error_code: planned.error_code.clone(),
            error_message: planned.error_message.clone(),
        };
    }
    // 清空前后各测量一次：释放量以同一口径的差值为准，测量失败时不虚报数字。
    let before = recycle_bin_roots()
        .ok()
        .map(|roots| recycle_totals_for(&roots));
    match empty_recycle_bin() {
        Ok(()) => {
            let after = recycle_bin_roots()
                .ok()
                .map(|roots| recycle_totals_for(&roots));
            let (deleted, freed, measured) = match (before, after) {
                (Some(before), Some(after)) => (
                    before.items.saturating_sub(after.items),
                    before.bytes.saturating_sub(after.bytes),
                    true,
                ),
                _ => (0, 0, false),
            };
            JunkCategoryResult {
                category: JunkCategory::RecycleBin,
                status: if measured { "success" } else { "partial" }.into(),
                candidates,
                estimated_bytes,
                freed_bytes: freed,
                deleted_files: deleted,
                skipped_files: 0,
                failed_files: 0,
                error_code: (!measured).then(|| "MEASURE_UNAVAILABLE".into()),
                error_message: (!measured)
                    .then(|| "回收站已清空，但无法复核释放量".to_string()),
            }
        }
        Err((code, message)) => JunkCategoryResult {
            category: JunkCategory::RecycleBin,
            status: "failed".into(),
            candidates,
            estimated_bytes,
            freed_bytes: 0,
            deleted_files: 0,
            skipped_files: 0,
            failed_files: candidates,
            error_code: Some(code),
            error_message: Some(message),
        },
    }
}

#[derive(Debug, Default)]
struct RecycleTotals {
    items: u64,
    bytes: u64,
    skipped: u64,
    incomplete: bool,
}

fn recycle_totals_for(roots: &[PathBuf]) -> RecycleTotals {
    let mut totals = RecycleTotals::default();
    let started = Instant::now();
    let mut entries_left = RECYCLE_MAX_ENTRIES;
    for root in roots {
        walk_recycle_root(root, &mut totals, &mut entries_left, started);
    }
    totals
}

/// 一个卷的回收站目录。Shell 以 `$I` 记录识别项目，`$R` 是数据本体；
/// 只统计「有 `$I` 记录与之配对」的 `$R`，避免把清空后残留的孤儿数据算成可清理项。
fn walk_recycle_root(
    root: &Path,
    totals: &mut RecycleTotals,
    entries_left: &mut usize,
    started: Instant,
) {
    let mut keys: HashSet<String> = HashSet::new();
    match fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries {
                if *entries_left == 0 || started.elapsed() >= RECYCLE_TIME_BUDGET {
                    totals.incomplete = true;
                    return;
                }
                *entries_left -= 1;
                let Ok(entry) = entry else {
                    totals.skipped += 1;
                    continue;
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("$I") {
                    continue;
                }
                let metadata = match fs::symlink_metadata(entry.path()) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        totals.skipped += 1;
                        continue;
                    }
                };
                if metadata.is_file() && !crate::shelf::is_reparse_point(&metadata) {
                    keys.insert(name[2..].to_ascii_lowercase());
                }
            }
        }
        Err(_) => {
            totals.skipped += 1;
            return;
        }
    }
    if keys.is_empty() {
        return;
    }

    match fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries {
                if *entries_left == 0 || started.elapsed() >= RECYCLE_TIME_BUDGET {
                    totals.incomplete = true;
                    return;
                }
                *entries_left -= 1;
                let Ok(entry) = entry else {
                    totals.skipped += 1;
                    continue;
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("$R") || !keys.contains(&name[2..].to_ascii_lowercase()) {
                    continue;
                }
                let path = entry.path();
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        totals.skipped += 1;
                        continue;
                    }
                };
                if crate::shelf::is_reparse_point(&metadata) {
                    totals.skipped += 1;
                    continue;
                }
                if metadata.is_file() {
                    totals.items += 1;
                    totals.bytes = totals.bytes.saturating_add(metadata.len());
                } else if metadata.is_dir() {
                    totals.items += 1;
                    sum_recycle_tree(&path, 0, totals, entries_left, started);
                }
            }
        }
        Err(_) => totals.skipped += 1,
    }
}

fn sum_recycle_tree(
    directory: &Path,
    depth: usize,
    totals: &mut RecycleTotals,
    entries_left: &mut usize,
    started: Instant,
) {
    if depth >= RECYCLE_MAX_DEPTH {
        totals.incomplete = true;
        return;
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            totals.skipped += 1;
            return;
        }
    };
    for entry in entries {
        if *entries_left == 0 || started.elapsed() >= RECYCLE_TIME_BUDGET {
            totals.incomplete = true;
            return;
        }
        *entries_left -= 1;
        let Ok(entry) = entry else {
            totals.skipped += 1;
            continue;
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                totals.skipped += 1;
                continue;
            }
        };
        if crate::shelf::is_reparse_point(&metadata) {
            totals.skipped += 1;
            continue;
        }
        if metadata.is_file() {
            totals.bytes = totals.bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            sum_recycle_tree(&path, depth + 1, totals, entries_left, started);
        }
    }
}

#[cfg(windows)]
fn recycle_bin_roots() -> Result<Vec<PathBuf>, (String, String)> {
    let sid = current_user_sid().ok_or_else(|| {
        (
            "SHELL_FAILED".to_string(),
            "无法确定当前用户标识，暂不能统计回收站".to_string(),
        )
    })?;
    let mut roots = Vec::new();
    for drive in super::volumes::local_drive_roots() {
        let root = PathBuf::from(format!("{drive}\\$Recycle.Bin\\{sid}"));
        if root.is_dir() {
            roots.push(root);
        }
    }
    Ok(roots)
}

#[cfg(not(windows))]
fn recycle_bin_roots() -> Result<Vec<PathBuf>, (String, String)> {
    Err((
        "UNSUPPORTED".into(),
        "当前平台不支持回收站清理".into(),
    ))
}

#[cfg(windows)]
struct TokenGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for TokenGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// 当前进程用户的 SID 字符串（`S-1-5-21-...`），用于定位各卷的回收站目录。
#[cfg(windows)]
fn current_user_sid() -> Option<String> {
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let _guard = TokenGuard(token);

    let mut needed = 0u32;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed < 8 {
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut core::ffi::c_void,
            needed,
            &mut needed,
        )
    } == 0
    {
        return None;
    }
    let user = unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const TOKEN_USER) };
    if user.User.Sid.is_null() {
        return None;
    }
    let sid = user.User.Sid as *const u8;
    let count = unsafe { *sid.add(1) } as usize;
    if count > 15 {
        return None;
    }
    let length = 8 + count * 4;
    if length > buffer.len() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(sid, length) };
    sid_bytes_to_string(bytes)
}

/// SID 二进制 → `S-revision-authority-sub1-sub2...`（不依赖额外 Win32 feature）。
fn sid_bytes_to_string(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        return None;
    }
    let revision = bytes[0];
    let count = bytes[1] as usize;
    if count > 15 || bytes.len() < 8 + count * 4 {
        return None;
    }
    let authority = bytes[2..8]
        .iter()
        .fold(0u64, |accumulated, byte| (accumulated << 8) | u64::from(*byte));
    let mut text = format!("S-{revision}-{authority}");
    for index in 0..count {
        let offset = 8 + index * 4;
        let value = u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        text.push('-');
        text.push_str(&value.to_string());
    }
    Some(text)
}

#[cfg(windows)]
fn empty_recycle_bin() -> Result<(), (String, String)> {
    use windows_sys::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
    };

    // 无确认框、无进度条、无提示音：调用前用户已在应用内确认过。
    let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
    let hwnd: *mut core::ffi::c_void = std::ptr::null_mut();
    let result = unsafe { SHEmptyRecycleBinW(hwnd, std::ptr::null(), flags) };
    if result < 0 {
        return Err((
            "SHELL_FAILED".into(),
            format!("清空回收站失败（Shell 返回 0x{result:08X}）"),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn empty_recycle_bin() -> Result<(), (String, String)> {
    Err((
        "UNSUPPORTED".into(),
        "当前平台不支持回收站清理".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("td-junk-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn age_file(path: &Path, age: Duration) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - age)
            .unwrap();
    }

    #[test]
    fn categories_are_fixed_and_cannot_repeat() {
        let all = JunkCategory::all();
        assert_eq!(all.len(), 4);
        assert_eq!(all.iter().copied().collect::<HashSet<_>>().len(), 4);
        assert!(validate_categories(&[]).is_err());
        assert!(validate_categories(&[JunkCategory::UserTemp, JunkCategory::UserTemp]).is_err());
        assert!(validate_categories(&[JunkCategory::UserTemp, JunkCategory::RecycleBin]).is_ok());
        let json = serde_json::to_value(JunkCategory::RecycleBin).unwrap();
        assert_eq!(json, "recycle_bin");
    }

    #[test]
    fn temp_scan_selects_only_stale_files_and_reports_protected() {
        let root = temp_root("scan");
        let stale = root.join("old.tmp");
        fs::write(&stale, b"stale-junk").unwrap();
        age_file(&stale, Duration::from_secs(8 * 24 * 60 * 60));
        let recent = root.join("recent.tmp");
        fs::write(&recent, b"recent").unwrap();

        let planned = scan_roots(&[root.clone()], JunkCategory::UserTemp, Limits::default());
        assert_eq!(planned.candidates.len(), 1);
        assert!(
            same_path(&planned.candidates[0].path, &stale),
            "候选路径必须是扫描到的同一个文件（允许 canonical 前缀差异）"
        );
        assert_eq!(planned.estimated_bytes, b"stale-junk".len() as u64);
        assert_eq!(planned.protected_files, 1);
        assert_eq!(planned.candidate_count(), 1);
        assert_eq!(planned.status, "ready");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nested_files_within_depth_are_included_and_depth_limit_is_respected() {
        let root = temp_root("depth");
        let deep = root.join("a").join("b");
        fs::create_dir_all(&deep).unwrap();
        let file = deep.join("old.log");
        fs::write(&file, b"deep-junk").unwrap();
        age_file(&file, Duration::from_secs(9 * 24 * 60 * 60));

        let planned = scan_roots(&[root.clone()], JunkCategory::UserTemp, Limits::default());
        assert_eq!(planned.candidates.len(), 1);

        let shallow = scan_roots(
            &[root.clone()],
            JunkCategory::UserTemp,
            Limits { depth: 1, ..Limits::default() },
        );
        assert_eq!(shallow.candidates.len(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn entry_limit_marks_scan_incomplete_without_counting_as_zero() {
        let root = temp_root("limit");
        for index in 0..6 {
            let path = root.join(format!("file-{index}.tmp"));
            fs::write(&path, b"x").unwrap();
            age_file(&path, Duration::from_secs(8 * 24 * 60 * 60));
        }
        let planned = scan_roots(
            &[root.clone()],
            JunkCategory::UserTemp,
            Limits { entries: 3, ..Limits::default() },
        );
        assert!(planned.incomplete);
        assert_eq!(planned.error_code.as_deref(), Some("SCAN_LIMIT_REACHED"));
        assert!(planned.candidate_count() <= 3);
        assert_eq!(planned.status, "partial");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn zero_budget_marks_scan_incomplete() {
        let root = temp_root("budget");
        let planned = scan_roots(
            &[root.clone()],
            JunkCategory::UserTemp,
            Limits { budget: Duration::ZERO, ..Limits::default() },
        );
        // 空目录可能来不及进入循环；关键是绝不把「没扫完」报告成完整结果。
        assert!(planned.incomplete || planned.candidates.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn candidate_outside_whitelisted_roots_is_rejected_before_delete() {
        let root = temp_root("outside");
        let inside = root.join("old.tmp");
        let outside = root.join("keep.tmp");
        fs::write(&inside, b"junk").unwrap();
        fs::write(&outside, b"keep").unwrap();
        age_file(&inside, Duration::from_secs(8 * 24 * 60 * 60));
        age_file(&outside, Duration::from_secs(8 * 24 * 60 * 60));

        let candidate = JunkCandidate {
            path: outside.clone(),
            size: b"keep".len() as u64,
            modified_ns: modified_ns(&fs::metadata(&outside).unwrap()).unwrap(),
            identity: crate::shelf::file_identity(&outside).unwrap(),
        };
        // 白名单根是 another 目录：候选路径不在其下，必须拒绝。
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        let roots = vec![normalized_path(&other)];
        assert!(!roots.iter().any(|prefix| normalized_path(&candidate.path)
            .starts_with(&format!("{prefix}\\"))));
        assert!(outside.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replaced_candidate_is_not_deleted() {
        let root = temp_root("replaced");
        let path = root.join("old.tmp");
        fs::write(&path, b"same-size").unwrap();
        age_file(&path, Duration::from_secs(8 * 24 * 60 * 60));
        let planned = scan_roots(&[root.clone()], JunkCategory::UserTemp, Limits::default());
        let candidate = planned.candidates.into_iter().next().unwrap();
        assert!(still_matches(&candidate, SystemTime::now()));

        let moved = root.join("moved.tmp");
        fs::rename(&path, &moved).unwrap();
        fs::write(&path, b"same-size").unwrap();
        age_file(&path, Duration::from_secs(8 * 24 * 60 * 60));
        assert!(
            !still_matches(&candidate, SystemTime::now()),
            "同路径替换不得按旧身份删除"
        );
        assert!(path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refreshed_file_is_rejected_by_age_check() {
        let root = temp_root("age");
        let path = root.join("old.tmp");
        fs::write(&path, b"junk").unwrap();
        age_file(&path, Duration::from_secs(8 * 24 * 60 * 60));
        let planned = scan_roots(&[root.clone()], JunkCategory::UserTemp, Limits::default());
        let candidate = planned.candidates.into_iter().next().unwrap();
        // 预览后文件被重新写入：修改时间变新，执行端必须拒绝。
        fs::write(&path, b"junk").unwrap();
        assert!(!still_matches(&candidate, SystemTime::now()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preview_is_single_use_and_expired_records_are_rejected() {
        let state = UserJunkState::default();
        let previews = Mutex::new(HashMap::new());
        let id = "one-shot".to_string();
        previews.lock().unwrap().insert(
            id.clone(),
            PreviewRecord {
                expires: Instant::now() + PREVIEW_TTL,
                categories: HashMap::from([(JunkCategory::UserTemp, PlannedJunk::default())]),
            },
        );
        assert!(consume_preview(&previews, &id, &[JunkCategory::UserTemp]).is_ok());
        assert!(consume_preview(&previews, &id, &[JunkCategory::UserTemp]).is_err());

        previews.lock().unwrap().insert(
            id.clone(),
            PreviewRecord {
                expires: Instant::now() - Duration::from_secs(1),
                categories: HashMap::from([(JunkCategory::UserTemp, PlannedJunk::default())]),
            },
        );
        assert!(consume_preview(&previews, &id, &[JunkCategory::UserTemp]).is_err());
        assert!(!previews.lock().unwrap().contains_key(&id));
        drop(state);
    }

    #[test]
    fn concurrent_user_junk_job_returns_busy() {
        let state = UserJunkState::default();
        let _guard = state.executing.lock().unwrap();
        assert!(matches!(
            state.try_begin_job(),
            Err(AppError::Conflict(code)) if code == "CLEANUP_BUSY"
        ));
    }

    #[test]
    fn recycle_bin_category_never_exposes_client_paths() {
        // 回收站预览只返回项数与字节，不返回路径；类别序列化值固定。
        let json = serde_json::to_value(JunkCategory::RecycleBin).unwrap();
        assert_eq!(json, "recycle_bin");
        assert!(!JunkCategory::RecycleBin.uses_file_roots());
    }

    #[test]
    fn recycle_bin_counts_only_paired_items() {
        let root = temp_root("bin");
        fs::write(root.join("$IAAAAAA"), b"meta").unwrap();
        fs::write(root.join("$RAAAAAA"), b"paired-data").unwrap();
        // 孤儿数据（没有 $I 记录）：Shell 不会把它当成项目，不计入可清理量。
        fs::write(root.join("$RORPHAN"), b"orphan").unwrap();
        fs::write(root.join("desktop.ini"), b"x").unwrap();
        fs::create_dir(root.join("$RBBBBBB")).unwrap();
        fs::write(root.join("$RBBBBBB").join("inside.bin"), b"12345").unwrap();
        fs::write(root.join("$IBBBBBB"), b"meta").unwrap();

        let mut totals = RecycleTotals::default();
        let mut entries_left = 100usize;
        walk_recycle_root(&root, &mut totals, &mut entries_left, Instant::now());
        assert_eq!(totals.items, 2, "只有配对的 $R 条目才算项目");
        assert_eq!(
            totals.bytes,
            b"paired-data".len() as u64 + b"12345".len() as u64
        );
        assert!(!totals.incomplete);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sid_binary_is_rendered_like_windows() {
        // S-1-5-18（LocalSystem）
        let local_system = [1u8, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
        assert_eq!(sid_bytes_to_string(&local_system).as_deref(), Some("S-1-5-18"));
        // S-1-5-21-1-2-3
        let user = [
            1u8, 4, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0,
        ];
        assert_eq!(
            sid_bytes_to_string(&user).as_deref(),
            Some("S-1-5-21-1-2-3")
        );
        assert!(sid_bytes_to_string(&[1, 1, 0]).is_none());
        assert!(sid_bytes_to_string(&[1, 16]).is_none());
    }

    #[test]
    fn canonical_temp_root_is_accepted_as_local_drive() {
        // 回归：`fs::canonicalize` 在 Windows 返回 `\\?\C:\...`（VerbatimDisk），
        // 只接受 `Disk` 前缀会让所有环境变量根被判为非法、预览永远 0 候选。
        let root = std::env::temp_dir();
        let normalized = normalize_root(&root).expect("临时目录必须是合法扫描根");
        assert!(is_local_drive_path(&normalized));
    }
}
