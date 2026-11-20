//! 性能指标聚合：**阈值触发** + 有界统计（设计文档 unified-observability §4.5）。
//!
//! ## 定位
//! 不是所有耗时都记日志：常规操作只更新内存聚合（计数 / p95 / 失败率），
//! 超过阈值才产生一条 WARN 诊断事件（`stage=slow`）；高频事件（投屏帧、剪贴板
//! 捕获、文件扫描）绝不逐条落盘，只进聚合。
//!
//! ## 硬约束
//! - **内存有界**：指纹数上限 [`MAX_FINGERPRINTS`]，超限按最近活跃淘汰；
//!   每个指纹只保留最近 [`SAMPLE_WINDOW`] 个耗时样本（p95 用环形窗口）；
//! - **不新增常驻线程**：聚合在调用线程完成，单次 O(1)～O(n)（n ≤ 容量上限，
//!   仅淘汰时发生），锁内无 IO、无系统调用；
//! - **绝不影响业务**：锁中毒时恢复内部状态继续工作，不 panic；诊断事件经
//!   `diagnostics::emit`（未初始化时静默丢弃）。
//!
//! ## 与前端的对应关系
//! `src/lib/diagnostics.ts` 的 `measureOperation / recordDuration /
//! recordSlowOperation / recordFailure` 与本模块同名函数语义一致（阈值表同源），
//! 前端不做聚合（无全局状态），只做阈值触发。

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;

use super::{event, DiagLevel, DiagStatus, DiagnosticEvent};

/// 聚合指纹容量上限（module+action 组合数）。
const MAX_FINGERPRINTS: usize = 256;
/// 每个指纹保留的耗时样本数（p95 计算窗口，环形淘汰最旧样本）。
const SAMPLE_WINDOW: usize = 64;
/// 模块 / 操作名的长度上限（防御异常输入撑爆内存；与事件 normalize 上限对齐）。
const IDENT_MAX: usize = 64;
/// 未命中阈值表的模块使用的默认慢阈值（毫秒）。候选值待实测校准。
const DEFAULT_THRESHOLD_MS: u64 = 1000;
/// 慢操作诊断事件的稳定错误码（诊断中心可按它筛选）。
const SLOW_OPERATION_CODE: &str = "SLOW_OPERATION";

/// 默认慢阈值表（毫秒）。设计文档 §4.5.2 候选值，**待实测校准**
/// （正式基线见 `docs/acceptance/logging-performance-report.md`）。
fn default_threshold_ms(module: &str) -> u64 {
    match module {
        // 桌面启动（首屏可交互）
        "startup" | "system" => 3000,
        // 文件工作区目录加载
        "file" => 1500,
        // 全局搜索（与前端 moduleForCommand 的 "search" 命名对齐）
        "search" => 1000,
        // 资源扫描
        "resource" | "ocr" => 5000,
        // 剪贴板捕获
        "clipboard" => 200,
        // 投屏建连
        "screen" => 3000,
        // 设备通信请求
        "device" | "mobile_sync" => 5000,
        // MCP 工具调用
        "mcp" => 10_000,
        // Agent 任务
        "agent" => 30_000,
        // SQLite 单条查询
        "db" => 500,
        // 回收站枚举（1000）等未列出的常规操作走默认值
        _ => DEFAULT_THRESHOLD_MS,
    }
}

/// 单个（module, action）指纹的聚合状态。
struct OpStats {
    count: u64,
    total_ms: u64,
    max_ms: u64,
    /// 超过阈值的次数（真实发生次数；WARN 事件可能被聚合器合并）。
    slow_count: u64,
    failures: u64,
    /// 最近耗时样本（有界环形窗口，p95 用）。
    samples: VecDeque<u64>,
    /// 最近一次活跃时间（容量淘汰依据）。
    last_seen: Instant,
}

impl OpStats {
    fn new() -> Self {
        Self {
            count: 0,
            total_ms: 0,
            max_ms: 0,
            slow_count: 0,
            failures: 0,
            samples: VecDeque::with_capacity(SAMPLE_WINDOW),
            last_seen: Instant::now(),
        }
    }

    fn observe_duration(&mut self, ms: u64, slow: bool) {
        self.count = self.count.saturating_add(1);
        self.total_ms = self.total_ms.saturating_add(u64::from(ms));
        self.max_ms = self.max_ms.max(ms);
        if slow {
            self.slow_count = self.slow_count.saturating_add(1);
        }
        if self.samples.len() >= SAMPLE_WINDOW {
            self.samples.pop_front();
        }
        self.samples.push_back(ms);
        self.last_seen = Instant::now();
    }

    fn observe_failure(&mut self) {
        self.failures = self.failures.saturating_add(1);
        self.last_seen = Instant::now();
    }
}

/// 单个指纹的快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsEntry {
    pub module: String,
    pub action: String,
    /// 耗时记录次数。
    pub count: u64,
    /// 失败记录次数。
    pub failures: u64,
    /// 超过阈值的次数。
    pub slow_count: u64,
    /// 平均耗时（毫秒；窗口内样本的总均值，溢出饱和）。
    pub avg_ms: u64,
    /// 最大耗时（毫秒）。
    pub max_ms: u64,
    /// 窗口内 p95（毫秒；只基于最近 [`SAMPLE_WINDOW`] 个样本）。
    pub p95_ms: u64,
}

/// 有界聚合快照（供查询命令与基准脚本消费；条目数 ≤ [`MAX_FINGERPRINTS`]）。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSummary {
    /// 聚合指纹数。
    pub fingerprints: usize,
    /// 各指纹的聚合条目（按 module + action 排序，输出确定）。
    pub entries: Vec<MetricsEntry>,
    /// 因容量淘汰被丢弃的指纹数（真实发生次数可能大于此值可见部分）。
    pub evicted: u64,
}

/// 指标聚合注册表（单实例由全局互斥锁保护；测试可构造独立实例）。
struct MetricsRegistry {
    /// key = `{module}\u{1}{action}`。
    entries: HashMap<String, OpStats>,
    capacity: usize,
    evicted: u64,
}

impl MetricsRegistry {
    fn new() -> Self {
        Self::with_limits(MAX_FINGERPRINTS)
    }

    fn with_limits(capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            capacity: capacity.max(1),
            evicted: 0,
        }
    }

    fn key(module: &str, action: &str) -> String {
        // 截断超长输入（防御；正常调用方传的都是代码内常量）。
        let module = truncate_ident(module);
        let action = truncate_ident(action);
        format!("{module}\u{1}{action}")
    }

    /// 记录一次耗时。超过阈值返回 `true`（调用方据此发出 slow 事件）。
    fn observe_duration(&mut self, module: &str, action: &str, ms: u64, threshold_ms: u64) -> bool {
        let slow = ms > threshold_ms;
        let key = Self::key(module, action);
        let stats = self.entry(&key);
        stats.observe_duration(ms, slow);
        slow
    }

    fn observe_failure(&mut self, module: &str, action: &str) {
        let key = Self::key(module, action);
        self.entry(&key).observe_failure();
    }

    /// 取（或创建）指纹条目；容量超限时淘汰最久未活跃的指纹。
    fn entry(&mut self, key: &str) -> &mut OpStats {
        if !self.entries.contains_key(key) && self.entries.len() >= self.capacity {
            self.evict_oldest();
        }
        self.entries.entry(key.to_string()).or_insert_with(OpStats::new)
    }

    fn evict_oldest(&mut self) {
        let oldest = self
            .entries
            .iter()
            .min_by_key(|(_, stats)| stats.last_seen)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            self.entries.remove(&key);
            self.evicted = self.evicted.saturating_add(1);
        }
    }

    fn summary(&self) -> MetricsSummary {
        let mut entries: Vec<MetricsEntry> = self
            .entries
            .iter()
            .map(|(key, stats)| {
                let (module, action) = split_key(key);
                MetricsEntry {
                    module,
                    action,
                    count: stats.count,
                    failures: stats.failures,
                    slow_count: stats.slow_count,
                    avg_ms: if stats.count == 0 {
                        0
                    } else {
                        stats.total_ms / stats.count
                    },
                    max_ms: stats.max_ms,
                    p95_ms: percentile(&stats.samples, 95),
                }
            })
            .collect();
        entries.sort_by(|a, b| a.module.cmp(&b.module).then(a.action.cmp(&b.action)));
        MetricsSummary {
            fingerprints: self.entries.len(),
            entries,
            evicted: self.evicted,
        }
    }
}

/// 截断超长标识（按字符边界；非字符串安全输入按字节截断到合法 UTF-8）。
fn truncate_ident(raw: &str) -> String {
    if raw.len() <= IDENT_MAX {
        return raw.to_string();
    }
    let mut end = IDENT_MAX;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    raw[..end].to_string()
}

/// 拆分内部 key（`\u{1}` 是控制字符，不会出现在常规标识里）。
fn split_key(key: &str) -> (String, String) {
    match key.split_once('\u{1}') {
        Some((module, action)) => (module.to_string(), action.to_string()),
        None => (key.to_string(), String::new()),
    }
}

/// 最近样本窗口内的分位数（整数下标：`pct * n / 100`，封顶最后一个样本）。
fn percentile(samples: &VecDeque<u64>, pct: u32) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted: Vec<u64> = samples.iter().copied().collect();
    sorted.sort_unstable();
    let index = (((pct as usize) * sorted.len()) / 100).min(sorted.len() - 1);
    sorted[index]
}

static REGISTRY: OnceLock<Mutex<MetricsRegistry>> = OnceLock::new();

/// 聚合窗口起始时刻（RFC3339）。注册表首次初始化时记录，供诊断中心如实说明
/// 「进程启动以来累计」这一数据窗口：重启进程即重置，**不存在**滚动 24 小时窗口。
static REGISTRY_STARTED: OnceLock<String> = OnceLock::new();

pub fn started_at() -> String {
    REGISTRY_STARTED
        .get_or_init(|| chrono::Utc::now().to_rfc3339())
        .clone()
}

/// 全局注册表；锁中毒时恢复内部数据（聚合非关键路径，绝不 panic）。
fn global() -> &'static Mutex<MetricsRegistry> {
    REGISTRY.get_or_init(|| {
        // 先固定窗口起点，再建注册表：保证 started_at 不晚于任何一条观测。
        let _ = started_at();
        Mutex::new(MetricsRegistry::new())
    })
}

/// 构造慢操作诊断事件（超过阈值才调用；WARN + stage=slow + 耗时元数据）。
/// message 用于让写线程聚合器把持续慢操作合并成摘要行，不逐条刷屏。
fn slow_event(module: &str, action: &str, ms: u64, threshold_ms: u64) -> DiagnosticEvent {
    event(DiagLevel::Warn, module, action, "slow")
        .stage("slow")
        .error_code(SLOW_OPERATION_CODE)
        .error_category("slow")
        .duration_ms(ms)
        .metadata("duration_ms", Value::from(ms))
        .metadata("threshold_ms", Value::from(threshold_ms))
        .message(format!("操作耗时 {ms} ms 超过阈值 {threshold_ms} ms"))
        .build()
}

/// 计时并记录一次同步操作的耗时（超过默认阈值才产生诊断事件）。
///
/// `f` panic 时正常向上传播（不记录耗时、不吞异常），与 Rust 语义一致。
pub fn measure_operation<T>(module: &str, action: &str, f: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let result = f();
    let ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    record_duration(module, action, ms);
    result
}

/// 记录一次耗时：只更新聚合；超过模块默认阈值才产生一条 WARN 诊断事件。
pub fn record_duration(module: &str, action: &str, ms: u64) {
    record_slow_if_exceeds(module, action, ms, default_threshold_ms(module));
}

/// 记录一次耗时（显式阈值）：超过 `threshold_ms` 才产生一条 WARN 诊断事件。
pub fn record_slow_operation(module: &str, action: &str, ms: u64, threshold_ms: u64) {
    record_slow_if_exceeds(module, action, ms, threshold_ms);
}

/// 异步操作收尾：用调用方在操作起点取得的 [`Instant`] 计算耗时并记录一次。
///
/// 适用于跨 `.await` 的命令：起点在进入命令时取得，await 结束后调用本函数；
/// 与同步 [`measure_operation`] 共用同一阈值表与有界聚合。不新增常驻线程、
/// 不引入全局可变状态；`Instant` 可跨 await 持有。失败路径由调用方另行
/// [`record_failure`]，本函数只记耗时。
pub fn record_duration_async(module: &str, action: &str, started: Instant) {
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    record_duration(module, action, ms);
}

/// 异步操作计时器：跨 `.await` 可安全持有，结束时一次性记录耗时。
///
/// 语义：
/// - [`OperationTimer::new`] 记录起点；计时器只持有 `Instant` 与自有字符串，
///   无全局可变状态、不新增线程，`Send` 可移入 async 闭包；
/// - 显式 [`OperationTimer::finish`] 消费计时器并记录一次耗时；
/// - 若在 `finish` 前被丢弃（提前返回、任务取消或 panic 展开），`Drop` 兜底
///   记录一次耗时，保证失败/早退路径也有观测；`finished` 标志保证同一次操作
///   绝不重复入账；
/// - 失败计数由调用方在错误路径显式 [`record_failure`]，计时器本身不推断失败。
#[derive(Debug)]
pub struct OperationTimer {
    module: String,
    action: String,
    started: Instant,
    finished: bool,
}

impl OperationTimer {
    /// 开始计时（起点为当前时刻）。
    pub fn new(module: &str, action: &str) -> Self {
        Self {
            module: module.to_string(),
            action: action.to_string(),
            started: Instant::now(),
            finished: false,
        }
    }

    /// 显式收尾：记录一次耗时并返回经过的毫秒数。消费计时器；随后 Drop 不会重复入账。
    pub fn finish(mut self) -> u64 {
        let ms = self.elapsed_ms();
        if !self.finished {
            self.finished = true;
            record_duration(&self.module, &self.action, ms);
        }
        ms
    }

    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

impl Drop for OperationTimer {
    fn drop(&mut self) {
        if !self.finished {
            self.finished = true;
            record_duration(&self.module, &self.action, self.elapsed_ms());
        }
    }
}

fn record_slow_if_exceeds(module: &str, action: &str, ms: u64, threshold_ms: u64) {
    let slow = match global().lock() {
        Ok(mut registry) => registry.observe_duration(module, action, ms, threshold_ms),
        Err(poisoned) => {
            poisoned.into_inner().observe_duration(module, action, ms, threshold_ms)
        }
    };
    if slow {
        super::emit(slow_event(module, action, ms, threshold_ms));
    }
}

/// 构造失败诊断事件（级别按错误类别推断；message 经 normalize 脱敏）。
fn failure_event(module: &str, action: &str, error: &crate::error::AppError) -> DiagnosticEvent {
    let category = error.category().as_str();
    event(DiagLevel::from_category(category), module, action, "failed")
        .status(DiagStatus::Failed)
        .error_code(error.code())
        .error_category(category)
        .message(error.to_string())
        .build()
}

/// 记录一次业务失败：聚合计数 + 一条 failed 诊断事件（级别按错误类别推断）。
pub fn record_failure(module: &str, action: &str, error: &crate::error::AppError) {
    {
        let result = global().lock();
        match result {
            Ok(mut registry) => registry.observe_failure(module, action),
            Err(poisoned) => poisoned.into_inner().observe_failure(module, action),
        }
    }
    super::emit(failure_event(module, action, error));
}

/// 有界聚合快照（计数 / p95 / 失败率原料）。条目数有界，可安全序列化。
pub fn summary() -> MetricsSummary {
    match global().lock() {
        Ok(registry) => registry.summary(),
        Err(poisoned) => poisoned.into_inner().summary(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    /// 构造独立注册表（与全局实例隔离，避免并行测试互相淘汰）。
    fn local() -> MetricsRegistry {
        MetricsRegistry::with_limits(MAX_FINGERPRINTS)
    }

    #[test]
    fn threshold_triggers_and_stays_silent_below() {
        let mut registry = local();
        // clipboard 默认阈值 200ms：低于不触发。
        assert!(!registry.observe_duration("clipboard", "capture", 150, 200));
        assert!(!registry.observe_duration("clipboard", "capture", 200, 200), "等于阈值不算超");
        assert!(registry.observe_duration("clipboard", "capture", 201, 200), "超过阈值必须触发");
        let summary = registry.summary();
        assert_eq!(summary.fingerprints, 1);
        let entry = &summary.entries[0];
        assert_eq!(entry.count, 3);
        assert_eq!(entry.slow_count, 1);
        assert_eq!(entry.p95_ms, 201);
        assert_eq!(entry.max_ms, 201);
    }

    #[test]
    fn slow_event_shape_matches_contract() {
        let ev = slow_event("db", "query", 1500, 500);
        assert_eq!(ev.level, DiagLevel::Warn);
        assert_eq!(ev.event, "slow");
        assert_eq!(ev.stage.as_deref(), Some("slow"));
        assert_eq!(ev.error_code.as_deref(), Some(SLOW_OPERATION_CODE));
        assert_eq!(ev.duration_ms, Some(1500));
        let meta = ev.metadata.as_ref().expect("必须带耗时元数据");
        assert_eq!(meta.get("duration_ms").and_then(|v| v.as_u64()), Some(1500));
        assert_eq!(meta.get("threshold_ms").and_then(|v| v.as_u64()), Some(500));
        // 带 message：写线程聚合器才能把持续慢操作合并为摘要行。
        assert!(ev.message.as_deref().is_some_and(|m| m.contains("1500")));
    }

    #[test]
    fn failure_event_shape_matches_contract() {
        // 校验类失败保持 WARN。
        let err = AppError::Validation("输入非法".into());
        let ev = failure_event("task", "create", &err);
        assert_eq!(ev.level, DiagLevel::Warn);
        assert_eq!(ev.event, "failed");
        assert_eq!(ev.status, Some(DiagStatus::Failed));
        assert_eq!(ev.error_code.as_deref(), Some("VALIDATION_ERROR"));
        assert_eq!(ev.error_category.as_deref(), Some("validation"));

        // IO 类失败必须升为 ERROR。
        let io = AppError::Io(std::io::Error::other("磁盘写入失败"));
        let ev2 = failure_event("file", "write", &io);
        assert_eq!(ev2.level, DiagLevel::Error);
        assert_eq!(ev2.error_code.as_deref(), Some("IO_ERROR"));
    }

    #[test]
    fn aggregation_is_bounded_and_evicts_least_recent() {
        let mut registry = MetricsRegistry::with_limits(8);
        for i in 0..64u64 {
            // 16 个指纹 × 循环；旧指纹会被逐步淘汰。
            registry.observe_duration("module", &format!("action-{}", i % 16), i + 1, 0);
        }
        let summary = registry.summary();
        assert!(
            summary.fingerprints <= 8,
            "指纹数必须受容量约束: {}",
            summary.fingerprints
        );
        assert!(summary.evicted > 0, "超容量必须产生淘汰计数");
    }

    #[test]
    fn sample_window_keeps_only_recent_and_p95_matches() {
        let mut registry = local();
        for i in 1..=100u64 {
            registry.observe_duration("db", "query", i, 100_000);
        }
        let summary = registry.summary();
        let entry = &summary.entries[0];
        // 窗口 64：只保留最近 64 个样本（37..=100）。
        assert_eq!(entry.count, 100, "计数必须是真实发生次数");
        // p95 下标 = 95 * 64 / 100 = 60 → 窗口内升序第 61 个 = 37 + 60 = 97。
        assert_eq!(entry.p95_ms, 97, "p95 必须来自最近 64 个样本窗口");
        assert_eq!(entry.max_ms, 100);
        assert_eq!(entry.avg_ms, 50, "均值覆盖全部 100 次（5050/100）");
    }

    #[test]
    fn failure_counts_are_recorded_per_fingerprint() {
        let mut registry = local();
        registry.observe_failure("agent", "connect");
        registry.observe_failure("agent", "connect");
        registry.observe_duration("agent", "connect", 10, 1_000_000);
        registry.observe_failure("mcp", "tool");
        let summary = registry.summary();
        let agent = summary
            .entries
            .iter()
            .find(|e| e.module == "agent" && e.action == "connect")
            .expect("agent 指纹必须存在");
        assert_eq!(agent.failures, 2);
        assert_eq!(agent.count, 1);
        assert_eq!(summary.fingerprints, 2);
    }

    #[test]
    fn default_threshold_table_matches_design_candidates() {
        // 设计文档 §4.5.2 候选值（待实测校准）；回归锁值防止无意漂移。
        assert_eq!(default_threshold_ms("startup"), 3000);
        assert_eq!(default_threshold_ms("file"), 1500);
        assert_eq!(default_threshold_ms("clipboard"), 200);
        assert_eq!(default_threshold_ms("screen"), 3000);
        assert_eq!(default_threshold_ms("mcp"), 10_000);
        assert_eq!(default_threshold_ms("agent"), 30_000);
        assert_eq!(default_threshold_ms("db"), 500);
        assert_eq!(default_threshold_ms("search"), 1000);
        // 回收站枚举等未单列模块走默认 1000ms。
        assert_eq!(default_threshold_ms("recycle"), 1000);
    }

    #[test]
    fn global_helpers_never_panic_and_aggregate() {
        // 与生产完全一致的入口（emit 在未初始化时静默丢弃）。
        record_duration("bench", "noop", 1);
        record_slow_operation("bench", "noop", 2, 1);
        record_failure("bench", "noop", &AppError::Conflict("冲突".into()));
        let summary = summary();
        let entry = summary
            .entries
            .iter()
            .find(|e| e.module == "bench")
            .expect("全局聚合必须包含 bench 指纹");
        assert_eq!(entry.count, 2);
        assert!(entry.failures >= 1);
    }

    #[test]
    fn concurrent_recording_is_safe_and_accounted() {
        // 多线程冒烟：不同指纹并发写全局注册表，计数必须恰好等于尝试次数。
        let handles: Vec<_> = (0..4)
            .map(|thread| {
                std::thread::spawn(move || {
                    for i in 0..500u64 {
                        record_duration("bench-concurrent", &format!("op-{thread}"), i % 7);
                        if i % 100 == 0 {
                            record_failure(
                                "bench-concurrent",
                                &format!("op-{thread}"),
                                &AppError::Unavailable("暂时不可用".into()),
                            );
                        }
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("工作线程不得 panic");
        }
        let summary = summary();
        let total: u64 = summary
            .entries
            .iter()
            .filter(|e| e.module == "bench-concurrent")
            .map(|e| e.count)
            .sum();
        assert_eq!(total, 4 * 500, "并发记录必须全部入账");
    }

    #[test]
    fn truncate_ident_bounds_memory() {
        let long = "x".repeat(1000);
        assert_eq!(truncate_ident(&long).len(), IDENT_MAX);
        // 多字节字符按边界截断，不得 panic。
        let wide = "中".repeat(200);
        assert!(truncate_ident(&wide).is_char_boundary(0));
        assert!(truncate_ident(&wide).len() <= IDENT_MAX + 3);
    }

    #[test]
    fn async_record_duration_aggregates_once() {
        // 与生产一致的异步收尾入口：起点 Instant 跨 await 后入账，只记一次。
        let started = Instant::now();
        record_duration_async("bench-async", "pull", started);
        let summary = summary();
        let entry = summary
            .entries
            .iter()
            .find(|e| e.module == "bench-async" && e.action == "pull")
            .expect("异步收尾指纹必须存在");
        assert_eq!(entry.count, 1);
        assert!(entry.avg_ms <= entry.max_ms);
    }

    #[test]
    fn timer_explicit_finish_does_not_record_twice_on_drop() {
        let timer = OperationTimer::new("bench-timer", "finish");
        let ms = timer.finish();
        assert!(ms <= u64::MAX);
        // finish 后 Drop 兜底不得重复入账。
        let summary = summary();
        let entry = summary
            .entries
            .iter()
            .find(|e| e.module == "bench-timer" && e.action == "finish")
            .expect("显式 finish 指纹必须存在");
        assert_eq!(entry.count, 1, "finish + Drop 只能入账一次");
    }

    #[test]
    fn timer_drop_fallback_records_once_when_never_finished() {
        {
            let _timer = OperationTimer::new("bench-timer", "drop-fallback");
            // 不调用 finish：离开作用域由 Drop 兜底记录。
        }
        let summary = summary();
        let entry = summary
            .entries
            .iter()
            .find(|e| e.module == "bench-timer" && e.action == "drop-fallback")
            .expect("Drop 兜底指纹必须存在");
        assert_eq!(entry.count, 1, "未 finish 的计时器只能兜底入账一次");
    }

    #[test]
    fn timer_is_send_for_async_ownership() {
        // 编译期约束：计时器必须能移入 async 闭包/跨 await 持有。
        fn assert_send<T: Send>(_: &T) {}
        let timer = OperationTimer::new("bench-timer", "send");
        assert_send(&timer);
    }
}
