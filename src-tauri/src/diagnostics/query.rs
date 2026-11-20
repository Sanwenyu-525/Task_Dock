//! 诊断日志读取：分页查询、错误摘要、脱敏报告导出。
//!
//! 读操作全部在调用线程完成（不经过写线程），约束：
//! - **不把全部历史读进内存**：调用方传 `limit`（≤500）与 `offset`；
//! - **不做无限扫描**：行数上限 + 时间预算（超限置 `truncated` 并如实返回）；
//! - **容忍半截行**：解析失败只计 `skipped`，不影响其它行；
//! - 导出走临时文件 + rename，失败不会破坏已有报告。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

use super::{
    now_iso, Counters, DiagLevel, DiagStatus, DiagnosticEvent, Diagnostics, ACTIVE_FILE,
    ARCHIVE_PREFIX,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security_audit::{self, AuditFilter};

/// 单次扫描的最大行数（防止一次请求扫爆大目录）。
const MAX_SCAN_LINES: u64 = 200_000;
/// 单次扫描的时间预算。
const SCAN_BUDGET: Duration = Duration::from_millis(400);
/// 单次查询返回上限。
const MAX_PAGE: usize = 500;
/// 偏移上限（防止极端深分页）。
const MAX_OFFSET: usize = 100_000;
/// 摘要最多返回的分组数。
const MAX_GROUPS: usize = 50;
/// 导出最多包含的事件条数。
const MAX_EXPORT_RECORDS: usize = 5_000;
/// 审计段请求并入的事件条数上限；`security_audit::list_page` 既有分页钳制为
/// 100 条/页（`MAX_PAGE_LIMIT`），实际生效上限以该只读查询为准，防止审计段撑爆报告。
const MAX_AUDIT_RECORDS: u32 = 100;
/// 预览估算：报告固定外壳（schema/app/range/summary/log_system/privacy 等）字节数。
const REPORT_ENVELOPE_BYTES: u64 = 4_096;
/// 预览不扫描审计表：审计段只计入固定外壳；单条审计事件字节未计入（保守下限）。
const AUDIT_SECTION_ENVELOPE_BYTES: u64 = 512;

/// 目录中的一个日志文件（只包含本模块命名规则的文件）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub bytes: u64,
    /// RFC3339 本地时间；读取失败时为 `None`。
    pub modified_at: Option<String>,
    pub active: bool,
}

/// 列出日志目录中的文件（新的在前）。
pub fn list_files(dir: &Path) -> Vec<LogFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(LogFile, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".jsonl") || !name.starts_with(ARCHIVE_PREFIX) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let modified_at = modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| {
                DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
                    .map(|utc| {
                        utc.with_timezone(&chrono::Local)
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
                    })
                    .unwrap_or_default()
            });
        files.push((
            LogFile {
                active: name == ACTIVE_FILE,
                name,
                bytes: meta.len(),
                modified_at,
            },
            modified,
        ));
    }
    files.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    files.into_iter().map(|(file, _)| file).collect()
}

/// 查询条件（IPC 参数：camelCase；事件体保持 snake_case 存储契约）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiagnosticQuery {
    /// 级别白名单；空 = 全部。
    pub levels: Vec<String>,
    pub modules: Vec<String>,
    pub error_codes: Vec<String>,
    pub statuses: Vec<String>,
    pub window_ids: Vec<String>,
    /// 精确匹配一次操作（跨阶段、跨窗口找回完整链路）。
    pub operation_id: Option<String>,
    /// 自由文本（message/action/module/component 的子串，忽略大小写）。
    pub text: Option<String>,
    /// RFC3339 起点（含）。
    pub since: Option<String>,
    /// RFC3339 终点（含）。
    pub until: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    /// 摘要/导出：只统计错误级别（WARN 及以上）。
    pub anomalies_only: Option<bool>,
}

impl DiagnosticQuery {
    fn effective_limit(&self) -> usize {
        self.limit.unwrap_or(100).clamp(1, MAX_PAGE)
    }

    /// 导出专用：允许更大的上限（普通 UI 查询仍受 `MAX_PAGE` 约束）。
    fn export_limit(&self) -> usize {
        self.limit.unwrap_or(100).clamp(1, MAX_EXPORT_RECORDS)
    }

    fn effective_offset(&self) -> usize {
        self.offset.unwrap_or(0).min(MAX_OFFSET)
    }

    fn levels(&self) -> Vec<DiagLevel> {
        self.levels
            .iter()
            .filter_map(|raw| DiagLevel::parse(raw))
            .collect()
    }

    fn since_dt(&self) -> Option<DateTime<FixedOffset>> {
        self.since
            .as_deref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
    }

    fn until_dt(&self) -> Option<DateTime<FixedOffset>> {
        self.until
            .as_deref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
    }

    fn wants_anomalies_only(&self) -> bool {
        self.anomalies_only.unwrap_or(false)
    }

    fn matches(
        &self,
        event: &DiagnosticEvent,
        levels: &[DiagLevel],
        since: Option<&DateTime<FixedOffset>>,
        until: Option<&DateTime<FixedOffset>>,
    ) -> bool {
        if !levels.is_empty() && !levels.contains(&event.level) {
            return false;
        }
        if self.wants_anomalies_only() && event.level < DiagLevel::Warn {
            return false;
        }
        if !self.modules.is_empty() && !self.modules.iter().any(|m| m == &event.module) {
            return false;
        }
        if !self.error_codes.is_empty() {
            let code = event.error_code.as_deref().unwrap_or("");
            if !self.error_codes.iter().any(|c| c == code) {
                return false;
            }
        }
        if !self.statuses.is_empty() {
            let status = event.status.map(|s| s.as_str()).unwrap_or("");
            if !self.statuses.iter().any(|s| s == status) {
                return false;
            }
        }
        if !self.window_ids.is_empty() {
            let window = event.window_id.as_deref().unwrap_or("");
            if !self.window_ids.iter().any(|w| w == window) {
                return false;
            }
        }
        if let Some(op) = self
            .operation_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if event.operation_id.as_deref() != Some(op) {
                return false;
            }
        }
        if let Some(text) = self
            .text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let needle = text.to_lowercase();
            let haystack = format!(
                "{} {} {} {}",
                event.module,
                event.action,
                event.message.as_deref().unwrap_or(""),
                event.component.as_deref().unwrap_or("")
            )
            .to_lowercase();
            if !haystack.contains(&needle) {
                return false;
            }
        }
        if since.is_some() || until.is_some() {
            let Some(ts) = DateTime::parse_from_rfc3339(&event.timestamp).ok() else {
                // 时间戳损坏的行在时间过滤下直接跳过（无法判断归属）。
                return false;
            };
            if let Some(since) = since {
                if ts < *since {
                    return false;
                }
            }
            if let Some(until) = until {
                if ts > *until {
                    return false;
                }
            }
        }
        true
    }
}

/// 分页结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPage {
    pub items: Vec<DiagnosticEvent>,
    /// 匹配总数（受扫描上限约束；`truncated=true` 时为“至少这么多”）。
    pub matched: u64,
    pub scanned: u64,
    pub truncated: bool,
    pub files: usize,
    /// 解析失败的行数（半截行/损坏行）。
    pub skipped: u64,
}

/// 每个分组的失败/恢复时间线（恢复状态判定的唯一依据）。
#[derive(Debug, Default, Clone)]
struct RecoveryTrack {
    /// operation_id → 最近一次失败时间。
    op_failures: std::collections::HashMap<String, String>,
    /// 无 operation_id 的最近一次失败时间。
    anon_failure_ts: Option<String>,
    /// 最近一次恢复：(时间, operation_id)。
    last_recovered: Option<(String, Option<String>)>,
}

/// 计数项（模块/错误码分布）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountItem {
    pub key: String,
    pub count: u64,
}

/// 异常分组（按 模块+操作+错误码 聚合）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryGroup {
    pub module: String,
    pub action: String,
    pub error_code: Option<String>,
    pub level: DiagLevel,
    pub count: u64,
    pub first_seen: String,
    pub last_seen: String,
    pub last_status: Option<DiagStatus>,
    /// 分组内最后一次状态为 recovered（且此前出现过失败）。
    pub recovered: bool,
    pub sample_message: Option<String>,
    pub sample_operation_id: Option<String>,
}

/// 错误摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSummary {
    pub total: u64,
    pub errors: u64,
    pub warnings: u64,
    pub infos: u64,
    pub groups: Vec<SummaryGroup>,
    pub by_module: Vec<CountItem>,
    pub by_code: Vec<CountItem>,
    pub truncated: bool,
    pub scanned: u64,
    pub skipped: u64,
    pub files: usize,
    pub generated_at: String,
    pub since: Option<String>,
    pub until: Option<String>,
}

/// 顺序扫描器：从最新文件读到最旧文件，每个文件内倒序（新→旧）。
///
/// 时间预算与行数上限都作用于整个扫描过程，触发即置 `truncated`。
struct Scanner {
    files: Vec<PathBuf>,
    deadline: Instant,
    scanned: u64,
    skipped: u64,
    truncated: bool,
}

impl Scanner {
    fn new(dir: &Path) -> Self {
        let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
        if let Ok(read) = std::fs::read_dir(dir) {
            for entry in read.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".jsonl") || !name.starts_with(ARCHIVE_PREFIX) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                entries.push((
                    entry.path(),
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                ));
            }
        }
        // 新文件先读。
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        Self {
            files: entries.into_iter().map(|(path, _)| path).collect(),
            deadline: Instant::now() + SCAN_BUDGET,
            scanned: 0,
            skipped: 0,
            truncated: false,
        }
    }

    /// 逐条回调；`f` 返回 `false` 表示调用方已满足，停止扫描（不算 truncated）。
    fn scan<F: FnMut(DiagnosticEvent) -> bool>(&mut self, mut f: F) {
        for path in std::mem::take(&mut self.files) {
            let Ok(file) = std::fs::File::open(&path) else {
                continue;
            };
            let mut lines: Vec<String> = Vec::new();
            for line in BufReader::new(file).lines() {
                match line {
                    Ok(text) => {
                        if !text.trim().is_empty() {
                            lines.push(text);
                        }
                    }
                    Err(_) => self.skipped += 1,
                }
                if self.budget_exceeded() {
                    self.truncated = true;
                    return;
                }
            }
            for line in lines.iter().rev() {
                if self.budget_exceeded() {
                    self.truncated = true;
                    return;
                }
                self.scanned += 1;
                match serde_json::from_str::<DiagnosticEvent>(line) {
                    Ok(event) => {
                        if !f(event) {
                            return;
                        }
                    }
                    Err(_) => self.skipped += 1,
                }
            }
        }
    }

    fn budget_exceeded(&self) -> bool {
        self.scanned >= MAX_SCAN_LINES || Instant::now() >= self.deadline
    }
}

/// 执行分页查询（同步 IO，命令层用 `spawn_blocking` 调用）。
pub fn query(dir: &Path, filter: &DiagnosticQuery, counters: &Counters) -> DiagnosticPage {
    query_with_limit(dir, filter, counters, filter.effective_limit())
}

/// 带显式上限的查询：导出使用独立上限，保证契约（5000 条）与普通分页（500 条）一致。
pub fn query_with_limit(
    dir: &Path,
    filter: &DiagnosticQuery,
    counters: &Counters,
    limit: usize,
) -> DiagnosticPage {
    let offset = filter.effective_offset();
    let levels = filter.levels();
    let since = filter.since_dt();
    let until = filter.until_dt();
    let mut matched: u64 = 0;
    let mut items: Vec<DiagnosticEvent> = Vec::with_capacity(limit);
    let mut scanner = Scanner::new(dir);
    scanner.scan(|event| {
        if !filter.matches(&event, &levels, since.as_ref(), until.as_ref()) {
            return true;
        }
        matched += 1;
        if matched > offset as u64 && items.len() < limit {
            items.push(event);
        }
        true
    });
    counters
        .skipped_lines
        .fetch_add(scanner.skipped, Ordering::Relaxed);
    DiagnosticPage {
        items,
        matched,
        scanned: scanner.scanned,
        truncated: scanner.truncated,
        files: list_files(dir).len(),
        skipped: scanner.skipped,
    }
}

/// 错误摘要（按 模块+操作+错误码 聚合，附带模块/错误码分布）。
pub fn summary(dir: &Path, filter: &DiagnosticQuery, counters: &Counters) -> DiagnosticSummary {
    let levels = filter.levels();
    let since = filter.since_dt();
    let until = filter.until_dt();
    let mut groups: std::collections::HashMap<String, SummaryGroup> =
        std::collections::HashMap::new();
    let mut tracks: std::collections::HashMap<String, RecoveryTrack> =
        std::collections::HashMap::new();
    let mut by_module: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    let mut by_code: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    let (mut total, mut errors, mut warnings, mut infos) = (0u64, 0u64, 0u64, 0u64);

    let mut scanner = Scanner::new(dir);
    scanner.scan(|event| {
        if !filter.matches(&event, &levels, since.as_ref(), until.as_ref()) {
            return true;
        }
        let weight = u64::from(event.count.max(1));
        total += weight;
        match event.level {
            DiagLevel::Critical | DiagLevel::Error => errors += weight,
            DiagLevel::Warn => warnings += weight,
            _ => infos += weight,
        }
        *by_module.entry(event.module.clone()).or_default() += weight;
        if let Some(code) = event.error_code.clone() {
            *by_code.entry(code).or_default() += weight;
        }
        // 恢复事件通常是 INFO：必须在"只看 WARN 以上"之前处理，否则永远关联不上。
        let group_key = format!(
            "{}|{}|{}",
            event.module,
            event.action,
            event.error_code.as_deref().unwrap_or("-")
        );
        let track = tracks.entry(group_key.clone()).or_default();
        if matches!(event.status, Some(DiagStatus::Recovered)) {
            let newer = track
                .last_recovered
                .as_ref()
                .map(|(ts, _)| event.timestamp > *ts)
                .unwrap_or(true);
            if newer {
                track.last_recovered = Some((event.timestamp.clone(), event.operation_id.clone()));
            }
            // 恢复不是新的错误：不增加分组计数，直接返回。
            return true;
        }
        if event.level < DiagLevel::Warn {
            return true;
        }
        let key = group_key;
        {
            // 失败时间线：区分"同一次操作"与"匿名失败"，供恢复判定使用。
            if let Some(op) = event.operation_id.as_ref() {
                if track.op_failures.len() < 32 || track.op_failures.contains_key(op) {
                    let newer = track
                        .op_failures
                        .get(op)
                        .map(|ts| event.timestamp > *ts)
                        .unwrap_or(true);
                    if newer {
                        track
                            .op_failures
                            .insert(op.clone(), event.timestamp.clone());
                    }
                }
            } else {
                let newer = track
                    .anon_failure_ts
                    .as_ref()
                    .map(|ts| event.timestamp > *ts)
                    .unwrap_or(true);
                if newer {
                    track.anon_failure_ts = Some(event.timestamp.clone());
                }
            }
        }
        let entry = groups.entry(key).or_insert_with(|| SummaryGroup {
            module: event.module.clone(),
            action: event.action.clone(),
            error_code: event.error_code.clone(),
            level: event.level,
            count: 0,
            first_seen: event.timestamp.clone(),
            last_seen: event.timestamp.clone(),
            last_status: event.status,
            recovered: false,
            sample_message: event.message.clone(),
            sample_operation_id: event.operation_id.clone(),
        });
        entry.count += weight;
        // 文件是新→旧扫描的：`first_seen` 用更早的时间覆盖，`last_seen` 保留较晚的。
        if event.timestamp < entry.first_seen {
            entry.first_seen = event.timestamp.clone();
        }
        if event.timestamp > entry.last_seen {
            entry.last_seen = event.timestamp.clone();
            entry.last_status = event.status;
            entry.level = event.level;
        }
        if matches!(event.level, DiagLevel::Critical) {
            entry.level = DiagLevel::Critical;
        }
        if entry.sample_message.is_none() {
            entry.sample_message = event.message.clone();
        }
        if entry.sample_operation_id.is_none() {
            entry.sample_operation_id = event.operation_id.clone();
        }
        true
    });

    counters
        .skipped_lines
        .fetch_add(scanner.skipped, Ordering::Relaxed);
    // 恢复判定（精确关联，避免"历史上出现过 recovered 就算恢复"）：
    // - 带 operation_id 的恢复只能匹配同一 operation_id 的失败；
    // - 匿名恢复只匹配匿名失败；
    // - 恢复时间必须晚于对应失败；之后又有新失败则重新显示为未恢复。
    for (key, group) in groups.iter_mut() {
        let Some(track) = tracks.get(key) else {
            continue;
        };
        let Some((recovered_at, op)) = track.last_recovered.as_ref() else {
            continue;
        };
        let failure_at = match op {
            Some(op) => track.op_failures.get(op),
            None => track.anon_failure_ts.as_ref(),
        };
        if failure_at
            .map(|failed_at| failed_at < recovered_at)
            .unwrap_or(false)
        {
            group.recovered = true;
            group.last_status = Some(DiagStatus::Recovered);
        }
    }
    let mut groups: Vec<SummaryGroup> = groups.into_values().collect();
    groups.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| b.last_seen.cmp(&a.last_seen))
    });
    groups.truncate(MAX_GROUPS);
    DiagnosticSummary {
        total,
        errors,
        warnings,
        infos,
        groups,
        by_module: top_counts(by_module),
        by_code: top_counts(by_code),
        truncated: scanner.truncated,
        scanned: scanner.scanned,
        skipped: scanner.skipped,
        files: list_files(dir).len(),
        generated_at: now_iso(),
        since: filter.since.clone(),
        until: filter.until.clone(),
    }
}

fn top_counts(map: std::collections::HashMap<String, u64>) -> Vec<CountItem> {
    let mut items: Vec<CountItem> = map
        .into_iter()
        .map(|(key, count)| CountItem { key, count })
        .collect();
    items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    items.truncate(20);
    items
}

/// 导出前预览（契约 §3.3）：只读扫描日志目录，**不生成文件、不落盘、不访问数据库**。
///
/// 字段与前端 `DiagnosticsExportPreview` 一一对应；`redaction` 恒为 `applied`
/// （脱敏在导出路径强制执行，预览侧不存在“可关闭脱敏”的分支）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub since: Option<String>,
    pub until: Option<String>,
    /// 将包含的事件条数（未加权，与导出 `records` 口径一致）。
    pub records: u64,
    pub errors: u64,
    pub warnings: u64,
    /// 涉及模块（≤20，按事件数降序，并列按模块名升序）。
    pub modules: Vec<String>,
    /// 导出文件大小估算（字节，口径见 [`export_preview`] 注释）。
    pub estimated_bytes: u64,
    pub includes_security_audit: bool,
    pub includes_device_diagnostics: bool,
    /// 恒 `"applied"`：导出前强制脱敏。
    pub redaction: String,
    /// 扫描或条数上限触发截断。
    pub truncated: bool,
}

/// 只读扫描并统计导出预览。取消语义由前端保证：本函数不创建任何文件、不写目录、
/// 不打开数据库连接；扫描上限复用 [`Scanner`] 的行数与时间预算（超限 `truncated=true`）。
///
/// 估算口径（`estimated_bytes`）：
/// - 固定报告外壳 [`REPORT_ENVELOPE_BYTES`]；
/// - 每条命中事件按其落盘 JSON 重新序列化后的字节数累加（落盘行已经过脱敏，
///   以此作为脱敏后样本体积的代理；不读原始未脱敏内存）；
/// - `include_security_audit=true` 时另加审计段固定外壳 [`AUDIT_SECTION_ENVELOPE_BYTES`]；
///   预览阶段不读审计表，单条审计事件字节未计入，因此审计段体积为保守下限。
pub fn export_preview(
    dir: &Path,
    filter: &DiagnosticQuery,
    include_security_audit: bool,
) -> ExportPreview {
    let levels = filter.levels();
    let since = filter.since_dt();
    let until = filter.until_dt();
    let mut records: u64 = 0;
    let mut errors: u64 = 0;
    let mut warnings: u64 = 0;
    let mut module_counts: std::collections::HashMap<String, u64> = Default::default();
    let mut matched_bytes: u64 = 0;

    let mut scanner = Scanner::new(dir);
    scanner.scan(|event| {
        if !filter.matches(&event, &levels, since.as_ref(), until.as_ref()) {
            return true;
        }
        records += 1;
        match event.level {
            DiagLevel::Critical | DiagLevel::Error => errors += 1,
            DiagLevel::Warn => warnings += 1,
            _ => {}
        }
        *module_counts.entry(event.module.clone()).or_default() += 1;
        if let Ok(bytes) = serde_json::to_vec(&event) {
            matched_bytes += bytes.len() as u64;
        }
        true
    });

    let mut modules: Vec<(String, u64)> = module_counts.into_iter().collect();
    modules.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    modules.truncate(20);
    let modules = modules.into_iter().map(|(key, _)| key).collect();

    let audit_envelope = if include_security_audit {
        AUDIT_SECTION_ENVELOPE_BYTES
    } else {
        0
    };
    let truncated = scanner.truncated || records > MAX_EXPORT_RECORDS as u64;
    let estimated_bytes = REPORT_ENVELOPE_BYTES + matched_bytes + audit_envelope;

    ExportPreview {
        since: filter.since.clone(),
        until: filter.until.clone(),
        records,
        errors,
        warnings,
        modules,
        estimated_bytes,
        includes_security_audit: include_security_audit,
        includes_device_diagnostics: true,
        redaction: "applied".to_string(),
        truncated,
    }
}

/// 导出结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
    pub records: u64,
    /// 扫描或条数上限截断：报告只包含部分事件。
    pub truncated: bool,
    /// 导出前是否确认刷盘成功（false 表示可能有更新的日志未进入报告）。
    pub flushed: bool,
    /// 刷盘降级原因（超时/队列满）；`flushed=true` 时为 None。
    #[serde(rename = "flushIssue")]
    pub flush_issue: Option<String>,
    /// 报告内容是否完整可信（flushed && !truncated）。
    pub complete: bool,
    /// 本次导出是否包含安全审计事件（默认不含，须用户显式授权）。
    #[serde(default)]
    pub includes_security_audit: bool,
}

/// 脱敏诊断报告（开发 Agent 的机器可读入口，字段稳定 + 版本标识）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    schema: &'static str,
    generated_at: String,
    app: ReportApp,
    range: ReportRange,
    summary: DiagnosticSummary,
    /// 最近关键异常（新→旧，最多 `MAX_EXPORT_RECORDS` 条）。
    records: Vec<DiagnosticEvent>,
    log_system: ReportLogSystem,
    privacy: ReportPrivacy,
    /// 安全审计段；`None` 表示本次导出未并入审计事件（默认 / 未显式授权）。
    #[serde(skip_serializing_if = "Option::is_none")]
    security_audit: Option<ReportSecurityAudit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportApp {
    name: &'static str,
    version: &'static str,
    profile: &'static str,
    os: &'static str,
    arch: &'static str,
    session_id: String,
    session_started_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportRange {
    since: Option<String>,
    until: Option<String>,
    /// 实际看到的日志时间范围（来自扫描到的第一条/最后一条）。
    observed_first: Option<String>,
    observed_last: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportLogSystem {
    log_dir: String,
    files: Vec<LogFile>,
    total_bytes: u64,
    max_file_bytes: u64,
    max_total_bytes: u64,
    written: u64,
    dropped: u64,
    queue_full: u64,
    aggregated: u64,
    rotations: u64,
    failures: u64,
    skipped_lines: u64,
    degraded: bool,
    last_writer_error: Option<String>,
    verbose_mode: bool,
    verbose_remaining_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportPrivacy {
    local_only: bool,
    redacted_fields: Vec<&'static str>,
    note: &'static str,
}

/// 并入诊断报告的安全审计段（独立顶层段落；来源显式标注，不伪装成诊断日志）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportSecurityAudit {
    /// 来源标识：固定 `securityAuditLog`。
    source: &'static str,
    /// `available` / `empty` / `not_wired` / `error`。
    status: String,
    total: u64,
    items: Vec<ReportAuditItem>,
    note: String,
}

/// 审计条目导出投影：最小字段集，标识符经诊断侧规范化/脱敏后并入报告。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportAuditItem {
    id: String,
    source: &'static str,
    event_type: String,
    category: String,
    subject: Option<String>,
    action: String,
    result: String,
    reason_code: Option<String>,
    correlation_id: Option<String>,
    created_at: String,
}

/// 只读查询审计表并投影为报告段落。**仅在 `include_security_audit=true` 时调用**；
/// `false` 路径绝不进入本函数、不打开数据库连接。
///
/// 脱敏复用诊断侧白名单/规范化（`privacy::normalize_ident` / `sanitize_message`），
/// 不新增绕过分支；审计表落库时已不含配对码、token、密钥或业务正文（见
/// `mobile_sync::audit_events` 模块注释）。查询走 `security_audit::list_page`
/// 的只读连接池，本函数不执行任何写语句。
fn read_audit_section(
    db: Option<&Db>,
    filter: &DiagnosticQuery,
) -> AppResult<ReportSecurityAudit> {
    let Some(db) = db else {
        return Ok(ReportSecurityAudit {
            source: "securityAuditLog",
            status: "not_wired".to_string(),
            total: 0,
            items: Vec::new(),
            note: "命令层未注入数据库句柄，本次导出未并入审计事件。".to_string(),
        });
    };
    let audit_filter = AuditFilter {
        category: None,
        event_type: None,
        from: filter.since.clone(),
        to: filter.until.clone(),
        limit: Some(MAX_AUDIT_RECORDS),
        offset: None,
    };
    let page = match security_audit::list_page(db, audit_filter) {
        Ok(page) => page,
        Err(e) => {
            return Ok(ReportSecurityAudit {
                source: "securityAuditLog",
                status: "error".to_string(),
                total: 0,
                items: Vec::new(),
                note: e.to_string(),
            });
        }
    };
    let items = page
        .items
        .into_iter()
        .map(|a| ReportAuditItem {
            id: a.id,
            source: "securityAuditLog",
            event_type: super::privacy::normalize_ident(&a.event_type, 48, "unknown"),
            category: super::privacy::normalize_ident(&a.category, 24, "other"),
            subject: a.subject.and_then(|s| {
                let cleaned = super::privacy::sanitize_message(&s);
                (!cleaned.is_empty()).then_some(cleaned)
            }),
            action: super::privacy::normalize_ident(&a.action, 64, "unknown"),
            result: super::privacy::normalize_ident(&a.result, 24, "unknown"),
            reason_code: a.reason_code.and_then(|c| {
                let cleaned = super::privacy::normalize_ident(&c, 40, "unknown");
                (!cleaned.is_empty()).then_some(cleaned)
            }),
            correlation_id: a.correlation_id.and_then(|c| {
                let cleaned = super::privacy::normalize_ident(&c, 64, "");
                (!cleaned.is_empty()).then_some(cleaned)
            }),
            created_at: a.created_at,
        })
        .collect();
    let status = if page.total == 0 { "empty" } else { "available" };
    Ok(ReportSecurityAudit {
        source: "securityAuditLog",
        status: status.to_string(),
        total: page.total as u64,
        items,
        note: "审计事件为库内 UUID / 最小化网段与稳定枚举；不含配对码、token、密钥或业务正文。"
            .to_string(),
    })
}

/// 生成并写入脱敏报告（旧签名保持不变）：等价于 `include_security_audit=false`，
/// 不读取审计表。
pub fn export(
    dir: &Path,
    diag: &Diagnostics,
    filter: &DiagnosticQuery,
    flush: super::FlushOutcome,
) -> AppResult<ExportResult> {
    export_with_db(dir, diag, filter, flush, false, None)
}

/// 带选项导出（契约 §3.3）：`include_security_audit=true` 时把安全审计事件作为
/// 独立顶层段落并入报告；`false` 时绝不读取审计表。
///
/// `flush_ok` 为调用方已确认的刷盘结果；超时/队列满等细分降级分类由命令层保留。
pub fn export_with_options(
    dir: &Path,
    diag: &Diagnostics,
    filter: &DiagnosticQuery,
    flush_ok: bool,
    include_security_audit: bool,
) -> AppResult<ExportResult> {
    let flush = super::FlushOutcome {
        flushed: flush_ok,
        timed_out: false,
        queue_full: false,
    };
    export_with_db(dir, diag, filter, flush, include_security_audit, None)
}

/// 内部版本：命令层注入已打开的数据库句柄做只读审计查询。
///
/// - `include_security_audit=false`：完全不触碰 `db`，不打开审计表连接；
/// - `include_security_audit=true` 且 `db=None`：审计段标记 `not_wired`，不报错；
/// - 审计查询只走只读连接池，本模块不提供任何写库路径。
pub(crate) fn export_with_db(
    dir: &Path,
    diag: &Diagnostics,
    filter: &DiagnosticQuery,
    flush: super::FlushOutcome,
    include_security_audit: bool,
    db: Option<&Db>,
) -> AppResult<ExportResult> {
    let export_dir = dir.join("exports");
    std::fs::create_dir_all(&export_dir)?;
    let mut page_filter = filter.clone();
    page_filter.limit = Some(MAX_EXPORT_RECORDS);
    page_filter.offset = Some(0);
    let page = query_with_limit(
        dir,
        &page_filter,
        diag.counters(),
        page_filter.export_limit(),
    );
    let summary = summary(dir, filter, diag.counters());
    // 刷盘结果由调用方传入前已获取；这里只负责把它写进报告。

    let observed_last = page.items.first().map(|e| e.timestamp.clone());
    let observed_first = page.items.last().map(|e| e.timestamp.clone());
    let files = list_files(dir);
    let total_bytes = files.iter().map(|f| f.bytes).sum();
    let counters = diag.counters().snapshot();

    // 只有显式授权时才读审计表；false 路径下面 db 保持未使用。
    let security_audit = match include_security_audit {
        true => Some(read_audit_section(db, filter)?),
        false => None,
    };

    let report = DiagnosticReport {
        schema: "taskdock.diagnostic-report/1",
        generated_at: now_iso(),
        app: ReportApp {
            name: "Task Dock",
            version: env!("CARGO_PKG_VERSION"),
            profile: if cfg!(debug_assertions) { "debug" } else { "release" },
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            session_id: diag.session_id().to_string(),
            session_started_at: diag.started_at().to_string(),
        },
        range: ReportRange {
            since: filter.since.clone(),
            until: filter.until.clone(),
            observed_first,
            observed_last,
        },
        summary,
        records: page.items,
        log_system: ReportLogSystem {
            // 路径可能包含用户名：导出前脱敏。
            log_dir: super::privacy::sanitize_message(&dir.display().to_string()),
            files,
            total_bytes,
            max_file_bytes: super::MAX_FILE_BYTES,
            max_total_bytes: super::MAX_TOTAL_BYTES,
            written: counters[0],
            dropped: counters[1],
            queue_full: counters[2],
            aggregated: counters[3],
            rotations: counters[4],
            failures: counters[5],
            skipped_lines: counters[6],
            degraded: diag.is_disabled(),
            last_writer_error: diag
                .last_writer_error()
                .map(|text| super::privacy::sanitize_message(&text)),
            verbose_mode: diag.is_verbose(),
            verbose_remaining_ms: diag.verbose_remaining_ms(),
        },
        privacy: ReportPrivacy {
            local_only: true,
            redacted_fields: vec![
                "message",
                "component",
                "metadata",
                "logDir",
                "lastWriterError",
            ],
            note: "本报告仅在本机生成，不包含剪贴板正文/图片、凭证明文、用户目录、Agent 对话正文或 HTTP 请求体。",
        },
        security_audit,
    };

    // 流式写：BufWriter 分块落盘，`serde_json` 直接序列化到写入器，
    // 不先把整份报告拼成一个中间 String。命中事件受 MAX_EXPORT_RECORDS 上限约束；
    // 扫描器逐行读取（单文件缓冲为既有设计，受 MAX_FILE_BYTES 约束）。
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = export_dir.join(format!("diagnostic-report-{stamp}-{}.json", short_id()));
    let tmp = export_dir.join(format!(".{}.tmp", short_id()));
    {
        let file = std::fs::File::create(&tmp)?;
        let mut writer = std::io::BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, &report)
            .map_err(|e| AppError::Validation(format!("诊断报告序列化失败: {e}")))?;
        writer.flush()?;
    }
    let bytes = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(ExportResult {
        path: target.display().to_string(),
        bytes,
        records: report.records.len() as u64,
        truncated: page.truncated,
        flushed: flush.flushed,
        flush_issue: if flush.degraded() {
            Some(if flush.queue_full {
                "queue_full".to_string()
            } else if flush.timed_out {
                "timeout".to_string()
            } else {
                "not_flushed".to_string()
            })
        } else {
            None
        },
        complete: flush.flushed && !page.truncated,
        includes_security_audit: include_security_audit,
    })
}

fn short_id() -> String {
    uuid::Uuid::new_v4().to_string()[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    use crate::db::Db;
    use crate::diagnostics::WriterConfig;
    use crate::security_audit::{
        insert_event, AuditEvent, CATEGORY_PAIRING, EVENT_PAIRING_SUCCEEDED, RESULT_OK,
    };

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-diag-query-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_events(dir: &Path, events: &[DiagnosticEvent]) {
        let path = dir.join(ACTIVE_FILE);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for event in events {
            writeln!(file, "{}", serde_json::to_string(event).unwrap()).unwrap();
        }
        file.flush().unwrap();
    }

    fn sample(level: DiagLevel, module: &str, action: &str, code: Option<&str>) -> DiagnosticEvent {
        let mut event = DiagnosticEvent::new(level, module, action, "failed");
        event.timestamp = now_iso();
        event.error_code = code.map(str::to_string);
        event.count = 1;
        event
    }

    #[test]
    fn query_filters_and_paginates() {
        let dir = temp_dir("page");
        let events: Vec<DiagnosticEvent> = (0..7)
            .map(|i| {
                let mut e = sample(
                    if i % 2 == 0 {
                        DiagLevel::Error
                    } else {
                        DiagLevel::Info
                    },
                    "task",
                    "create",
                    Some("IO_ERROR"),
                );
                e.message = Some(format!("第 {i} 条"));
                e
            })
            .collect();
        write_events(&dir, &events);

        let filter = DiagnosticQuery {
            limit: Some(3),
            offset: Some(2),
            ..Default::default()
        };
        let page = query(&dir, &filter, &Counters::default());
        assert_eq!(page.matched, 7);
        assert_eq!(page.items.len(), 3);
        assert!(!page.truncated);

        let errors = query(
            &dir,
            &DiagnosticQuery {
                levels: vec!["ERROR".into()],
                ..Default::default()
            },
            &Counters::default(),
        );
        assert_eq!(errors.matched, 4);

        let by_code = query(
            &dir,
            &DiagnosticQuery {
                error_codes: vec!["IO_ERROR".into()],
                ..Default::default()
            },
            &Counters::default(),
        );
        assert_eq!(by_code.matched, 7);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn query_tolerates_corrupt_lines() {
        let dir = temp_dir("corrupt");
        write_events(
            &dir,
            &[sample(
                DiagLevel::Warn,
                "clipboard",
                "paste",
                Some("IO_ERROR"),
            )],
        );
        let path = dir.join(ACTIVE_FILE);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{ this is not json").unwrap();
        writeln!(file).unwrap();
        file.flush().unwrap();

        let page = query(&dir, &DiagnosticQuery::default(), &Counters::default());
        assert_eq!(page.matched, 1);
        assert_eq!(page.skipped, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn summary_weights_aggregated_counts() {
        let dir = temp_dir("summary");
        let mut first = sample(DiagLevel::Error, "agent", "connect", Some("AGENT_ERROR"));
        first.message = Some("连接失败".into());
        let mut aggregated = sample(DiagLevel::Error, "agent", "connect", Some("AGENT_ERROR"));
        aggregated.event = "aggregated".into();
        aggregated.count = 9;
        aggregated.message = Some("连接失败".into());
        let mut recovered = sample(DiagLevel::Warn, "agent", "connect", Some("AGENT_ERROR"));
        recovered.status = Some(DiagStatus::Recovered);
        recovered.level = DiagLevel::Info;
        write_events(&dir, &[first, aggregated, recovered]);

        let result = summary(&dir, &DiagnosticQuery::default(), &Counters::default());
        assert_eq!(result.errors, 10, "1 条原始 + 9 条被抑制的次数");
        let group = result
            .groups
            .iter()
            .find(|g| g.module == "agent" && g.action == "connect")
            .expect("应有 agent/connect 分组");
        assert_eq!(group.count, 10);
        assert!(group.sample_message.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn since_until_filter_by_time() {
        let dir = temp_dir("time");
        let mut old = sample(DiagLevel::Error, "task", "create", Some("IO_ERROR"));
        old.timestamp = "2026-01-01T00:00:00.000+08:00".into();
        let mut new = sample(DiagLevel::Error, "task", "create", Some("IO_ERROR"));
        new.timestamp = "2026-06-01T00:00:00.000+08:00".into();
        write_events(&dir, &[old, new]);

        let page = query(
            &dir,
            &DiagnosticQuery {
                since: Some("2026-05-01T00:00:00+08:00".into()),
                ..Default::default()
            },
            &Counters::default(),
        );
        assert_eq!(page.matched, 1);
        assert_eq!(page.items[0].timestamp, "2026-06-01T00:00:00.000+08:00");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_files_only_reports_own_files() {
        let dir = temp_dir("files");
        write_events(&dir, &[sample(DiagLevel::Info, "task", "create", None)]);
        std::fs::write(dir.join("unrelated.txt"), "x").unwrap();
        let files = list_files(&dir);
        assert_eq!(files.len(), 1);
        assert!(files[0].active);
        assert!(files[0].bytes > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── 导出预览（契约 §3.3）─────────────────────────────────────────────

    fn fixed_event(level: DiagLevel, module: &str, ts: &str) -> DiagnosticEvent {
        let mut event = sample(level, module, "act", None);
        event.timestamp = ts.to_string();
        event
    }

    fn read_report(path: &str) -> serde_json::Value {
        let text = std::fs::read(path).expect("报告文件应存在");
        serde_json::from_slice(&text).expect("报告应为合法 JSON")
    }

    fn seed_audit_db() -> Db {
        let db = Db::open_in_memory().unwrap();
        for idx in 0..2 {
            let event = AuditEvent {
                subject: Some(format!("device-{idx}-uuid")),
                ..AuditEvent::new(
                    CATEGORY_PAIRING,
                    EVENT_PAIRING_SUCCEEDED,
                    "complete_pairing",
                    RESULT_OK,
                )
            };
            db.with_conn(|conn| insert_event(conn, &event)).unwrap();
        }
        db
    }

    #[test]
    fn preview_empty_dir_returns_zero_without_panic() {
        let dir = temp_dir("preview-empty");
        let preview = export_preview(&dir, &DiagnosticQuery::default(), false);
        assert_eq!(preview.records, 0);
        assert_eq!(preview.errors, 0);
        assert_eq!(preview.warnings, 0);
        assert!(preview.modules.is_empty());
        assert!(!preview.truncated);
        assert_eq!(preview.redaction, "applied");
        assert!(!preview.includes_security_audit);
        assert!(preview.includes_device_diagnostics);
        assert_eq!(preview.estimated_bytes, REPORT_ENVELOPE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_level_and_time_filters_count() {
        let dir = temp_dir("preview-filter");
        let old_err = fixed_event(DiagLevel::Error, "task", "2026-01-01T00:00:00.000+08:00");
        let new_err = fixed_event(DiagLevel::Error, "clipboard", "2026-06-01T00:00:00.000+08:00");
        let new_info = fixed_event(DiagLevel::Info, "clipboard", "2026-06-01T00:01:00.000+08:00");
        write_events(&dir, &[old_err, new_err, new_info]);

        let all = export_preview(&dir, &DiagnosticQuery::default(), false);
        assert_eq!(all.records, 3);
        assert_eq!(all.errors, 2);
        assert_eq!(all.warnings, 0);
        assert_eq!(
            all.modules,
            vec!["clipboard".to_string(), "task".to_string()]
        );

        let errors_only = export_preview(
            &dir,
            &DiagnosticQuery {
                levels: vec!["ERROR".into()],
                ..Default::default()
            },
            false,
        );
        assert_eq!(errors_only.records, 2);
        assert_eq!(errors_only.errors, 2);

        let since = export_preview(
            &dir,
            &DiagnosticQuery {
                since: Some("2026-05-01T00:00:00+08:00".into()),
                ..Default::default()
            },
            false,
        );
        assert_eq!(since.records, 2);
        assert_eq!(since.errors, 1);

        let since_error = export_preview(
            &dir,
            &DiagnosticQuery {
                levels: vec!["ERROR".into()],
                since: Some("2026-05-01T00:00:00+08:00".into()),
                ..Default::default()
            },
            false,
        );
        assert_eq!(since_error.records, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_writes_no_files() {
        let dir = temp_dir("preview-nofile");
        write_events(&dir, &[sample(DiagLevel::Info, "task", "create", None)]);
        let before: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|x| x.file_name().to_string_lossy().to_string()))
            .collect();
        // include_security_audit=true 也只置标记，预览阶段不打开数据库、不产生文件。
        let _ = export_preview(&dir, &DiagnosticQuery::default(), true);
        let after: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|x| x.file_name().to_string_lossy().to_string()))
            .collect();
        assert_eq!(before, after);
        assert!(!dir.join("exports").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn estimated_bytes_grows_with_records() {
        let one = temp_dir("preview-bytes-1");
        write_events(&one, &[sample(DiagLevel::Info, "task", "create", None)]);
        let p1 = export_preview(&one, &DiagnosticQuery::default(), false);

        let three = temp_dir("preview-bytes-3");
        let events: Vec<DiagnosticEvent> = (0..3)
            .map(|_| sample(DiagLevel::Info, "task", "create", None))
            .collect();
        write_events(&three, &events);
        let p3 = export_preview(&three, &DiagnosticQuery::default(), false);

        assert!(p1.estimated_bytes >= REPORT_ENVELOPE_BYTES);
        assert!(
            p3.estimated_bytes > p1.estimated_bytes,
            "{} > {}",
            p3.estimated_bytes,
            p1.estimated_bytes
        );
        std::fs::remove_dir_all(&one).ok();
        std::fs::remove_dir_all(&three).ok();
    }

    #[test]
    fn export_audit_disabled_never_reads_table() {
        let dir = temp_dir("export-noaudit");
        let handle = Diagnostics::init_at(dir.clone(), WriterConfig::default());
        write_events(&dir, &[sample(DiagLevel::Error, "task", "create", Some("IO_ERROR"))]);
        let db = seed_audit_db();

        let result = export_with_db(
            &dir,
            &handle,
            &DiagnosticQuery::default(),
            crate::diagnostics::FlushOutcome::ok(),
            false,
            Some(&db),
        )
        .expect("导出应成功");
        assert!(!result.includes_security_audit);
        let report = read_report(&result.path);
        assert!(
            report.get("securityAudit").is_none(),
            "未授权时不得并入审计段"
        );
        // 未授权路径不得读写审计表：导出后行数保持不变（只读 COUNT 复核）。
        let remaining: i64 = db
            .with_read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM security_audit_log", [], |r| {
                    r.get(0)
                })
                .map_err(crate::error::AppError::from)
            })
            .unwrap();
        assert_eq!(remaining, 2);
        handle.shutdown();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_audit_enabled_includes_redacted_section() {
        let dir = temp_dir("export-audit");
        let handle = Diagnostics::init_at(dir.clone(), WriterConfig::default());
        write_events(&dir, &[sample(DiagLevel::Warn, "clipboard", "paste", Some("IO_ERROR"))]);
        let db = seed_audit_db();

        let result = export_with_db(
            &dir,
            &handle,
            &DiagnosticQuery::default(),
            crate::diagnostics::FlushOutcome::ok(),
            true,
            Some(&db),
        )
        .expect("导出应成功");
        assert!(result.includes_security_audit);
        let report = read_report(&result.path);
        let section = report.get("securityAudit").expect("授权后应包含审计段");
        assert_eq!(section["source"], "securityAuditLog");
        assert_eq!(section["status"], "available");
        assert_eq!(section["total"], 2);
        let items = section["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["source"], "securityAuditLog");
        // subject 经规范化保留设备标识形态；不含原始敏感正文。
        assert!(items[0]["subject"].as_str().unwrap().starts_with("device-"));
        let redacted = report["privacy"]["redactedFields"].as_array().unwrap();
        assert!(!redacted.is_empty());
        handle.shutdown();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_with_options_delegates_without_db() {
        let dir = temp_dir("export-opts");
        let handle = Diagnostics::init_at(dir.clone(), WriterConfig::default());
        write_events(&dir, &[sample(DiagLevel::Info, "task", "create", None)]);
        let result = export_with_options(
            &dir,
            &handle,
            &DiagnosticQuery::default(),
            true,
            false,
        )
        .expect("导出应成功");
        assert!(!result.includes_security_audit);
        let report = read_report(&result.path);
        assert!(report.get("securityAudit").is_none());
        handle.shutdown();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn large_log_export_is_bounded() {
        let dir = temp_dir("export-large");
        let handle = Diagnostics::init_at(dir.clone(), WriterConfig::default());
        let events: Vec<DiagnosticEvent> = (0..50_000)
            .map(|i| {
                let mut event = sample(DiagLevel::Info, "task", &format!("create-{}", i % 16), None);
                event.message = Some(format!("批量事件 {i}"));
                event
            })
            .collect();
        write_events(&dir, &events);

        let started = Instant::now();
        let result = export_with_db(
            &dir,
            &handle,
            &DiagnosticQuery::default(),
            crate::diagnostics::FlushOutcome::ok(),
            false,
            None,
        )
        .expect("大日志导出应成功");
        let elapsed = started.elapsed();

        assert_eq!(
            result.records,
            MAX_EXPORT_RECORDS as u64,
            "命中事件必须被导出上限截断"
        );
        assert!(result.bytes > 0);
        eprintln!(
            "[large-log] 50000 行导出: records={} bytes={} elapsed={:?}",
            result.records, result.bytes, elapsed
        );
        assert!(
            elapsed < Duration::from_secs(15),
            "导出超时边界: {elapsed:?}"
        );
        handle.shutdown();
        std::fs::remove_dir_all(&dir).ok();
    }
}
