//! 诊断日志读取：分页查询、错误摘要、脱敏报告导出。
//!
//! 读操作全部在调用线程完成（不经过写线程），约束：
//! - **不把全部历史读进内存**：调用方传 `limit`（≤500）与 `offset`；
//! - **不做无限扫描**：行数上限 + 时间预算（超限置 `truncated` 并如实返回）；
//! - **容忍半截行**：解析失败只计 `skipped`，不影响其它行；
//! - 导出走临时文件 + rename，失败不会破坏已有报告。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

use super::{
    now_iso, Counters, DiagLevel, DiagStatus, DiagnosticEvent, Diagnostics, ACTIVE_FILE,
    ARCHIVE_PREFIX,
};
use crate::error::{AppError, AppResult};

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

/// 生成并写入脱敏报告。返回文件路径与统计。
pub fn export(
    dir: &Path,
    diag: &Diagnostics,
    filter: &DiagnosticQuery,
    flush: super::FlushOutcome,
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
    // 刷盘结果由调用方传入前已获取；这里只负责把它写进报告（见 export_with_flush）。

    let observed_last = page.items.first().map(|e| e.timestamp.clone());
    let observed_first = page.items.last().map(|e| e.timestamp.clone());
    let files = list_files(dir);
    let total_bytes = files.iter().map(|f| f.bytes).sum();
    let counters = diag.counters().snapshot();

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
    };

    let text = serde_json::to_string_pretty(&report)
        .map_err(|e| AppError::Validation(format!("诊断报告序列化失败: {e}")))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = export_dir.join(format!("diagnostic-report-{stamp}-{}.json", short_id()));
    let tmp = export_dir.join(format!(".{}.tmp", short_id()));
    std::fs::write(&tmp, text.as_bytes())?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(ExportResult {
        path: target.display().to_string(),
        bytes: text.len() as u64,
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
    })
}

fn short_id() -> String {
    uuid::Uuid::new_v4().to_string()[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
}
