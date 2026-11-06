//! 统一诊断日志基础设施：本机持久化、有界写入、轮转保留、查询、摘要与脱敏导出。
//!
//! ## 定位
//! 这里**不是**业务审计系统，也不替代任何业务表（工作流回执、备份 manifest、文件
//! 投递恢复记录都在各自模块独立保存）。诊断日志只回答一个问题：
//! **某次运行中，哪个模块的哪个操作在哪个阶段失败了、错误码是什么、是否恢复。**
//!
//! ## 结构
//! ```text
//! 前端 (diagnostics.ts)  ─┐
//! tracing Layer          ─┼─► DiagnosticEvent ─► 有界队列 ─► 单写线程 ─► JSONL 文件
//! 业务代码 diagnostics::*─┘                                        └► 查询 / 摘要 / 导出
//! ```
//!
//! ## 硬约束
//! - **单进程单写线程**：所有文件写入（追加、轮转、清理）只在写线程发生，避免多窗口/
//!   多任务竞争同一个日志文件；
//! - **有界**：队列容量固定，满了按级别丢弃并计数；聚合表容量固定；
//! - **不阻塞业务**：前端入口用 `try_send`；只有 ERROR/CRITICAL 允许极短（≤2ms）重试；
//! - **日志失败不影响业务**：任何写入错误只更新计数器并在 stderr 提示（限流），
//!   不 panic、不向调用方返回错误；
//! - **不递归**：写线程内部只用 `eprintln!`，绝不调用 `tracing`；
//! - **隐私**：`message`/`metadata` 经过白名单 + 脱敏（见 `privacy`）。
//!
//! ## 级别策略
//! - `tracing` 事件默认只落盘 WARN/ERROR/CRITICAL；INFO 及以下需要用户开启详细诊断模式
//!   （tracing 的 INFO 多为开发期流水，长期落盘没有诊断价值）。
//! - 业务代码显式 `diagnostics::event(Info, ...)` 的关键操作里程碑始终落盘（数量受控）。
//! - 详细诊断模式有超时（默认 30 分钟）并自动恢复；进程重启也回到正常模式。

pub(crate) mod privacy;
pub(crate) mod query;
mod tracing_layer;
mod writer;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::AppResult;

pub use query::{DiagnosticPage, DiagnosticQuery, DiagnosticSummary};
pub use tracing_layer::DiagnosticsLayer;

/// 单个日志文件上限（5 MB）。超过即轮转。
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// 最多保留的归档文件数（不含当前活动文件）。5 个文件 ≈ 25 MB 总量目标。
pub const MAX_ARCHIVE_FILES: usize = 4;
/// 目录总量上限（活动 + 归档）。
pub const MAX_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
/// 写入队列容量（事件条数）。
pub const CHANNEL_CAPACITY: usize = 1024;
/// 异常聚合表容量（指纹条数）。
pub const AGG_MAX_ENTRIES: usize = 256;
/// 相同指纹的聚合窗口。
pub const AGG_WINDOW: Duration = Duration::from_secs(60);
/// 详细诊断模式默认时长。
pub const VERBOSE_DEFAULT_MINUTES: u32 = 30;
/// 详细诊断模式最长时长（防止长期高噪声）。
pub const VERBOSE_MAX_MINUTES: u32 = 120;

/// 刷盘回执等待上限（写线程按 200ms 批次 flush，正常远小于此值）。
const FLUSH_ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// 清理回执等待上限：超时即请求取消，避免"提示失败但稍后静默删除"。
const CLEAR_ACK_TIMEOUT: Duration = Duration::from_secs(3);
/// 写线程回报的取消哨兵值。
const CLEAR_CANCELLED: &str = "cancelled";

const ACTIVE_FILE: &str = "diagnostics-active.jsonl";
const ARCHIVE_PREFIX: &str = "diagnostics-";

/// 日志级别切换回调（参数为 verbose）。
type FilterReload = Box<dyn Fn(bool) + Send + Sync>;

static GLOBAL: OnceLock<Arc<Diagnostics>> = OnceLock::new();

/// 诊断级别。排序用于 `>=` 过滤，与前端字符串一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiagLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
    Critical,
}

impl DiagLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
            Self::Critical => "CRITICAL",
        }
    }

    /// 合法字符串 → 级别；非法值返回 `None`（调用方据此拒绝事件）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "TRACE" => Some(Self::Trace),
            "DEBUG" => Some(Self::Debug),
            "INFO" => Some(Self::Info),
            "WARN" | "WARNING" => Some(Self::Warn),
            "ERROR" => Some(Self::Error),
            "CRITICAL" | "FATAL" => Some(Self::Critical),
            _ => None,
        }
    }
}

/// 操作生命周期状态（与前端 `status` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagStatus {
    Started,
    Success,
    Failed,
    Cancelled,
    Recovered,
}

impl DiagStatus {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "started" => Some(Self::Started),
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            "recovered" => Some(Self::Recovered),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Recovered => "recovered",
        }
    }
}

/// 事件来源：Rust 内部 / 前端 / 系统（启动、退出等）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DiagSource {
    #[default]
    Rust,
    Frontend,
    System,
}

/// 一条结构化诊断事件（也是落盘 JSONL 的一行）。
///
/// 字段名使用 snake_case：这是**稳定存储契约**（同时被前端与开发 Agent 直接读取），
/// 与 `Task` 等后端载荷一致；IPC 命令参数本身仍按项目规范使用 camelCase。
/// 所有字段在反序列化时都有默认值，旧日志/半截行不会破坏查询。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DiagnosticEvent {
    /// 带时区的 RFC3339（写入端统一生成，避免多窗口时钟不一致）。
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub level: DiagLevel,
    #[serde(default)]
    pub module: String,
    #[serde(default)]
    pub action: String,
    /// 事件短名（started/failed/aggregated/...），与 `action` 组合成稳定指纹。
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DiagStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(default)]
    pub source: DiagSource,
    /// 本行代表的“被抑制的重复次数”。普通事件 = 1；聚合摘要行 = 被合并的次数。
    /// 查询侧对 `count` 求和即可得到真实发生次数。
    #[serde(default = "one")]
    pub count: u32,
}

fn one() -> u32 {
    1
}

impl DiagnosticEvent {
    pub fn new(level: DiagLevel, module: &str, action: &str, event: &str) -> Self {
        Self {
            level,
            module: module.to_string(),
            action: action.to_string(),
            event: event.to_string(),
            count: 1,
            ..Default::default()
        }
    }

    /// 落盘前统一规范化：标识符、错误码、文本、metadata、时间与会话。
    /// 返回 `false` 表示该事件级别在当前模式下应被丢弃（DEBUG/TRACE 且非详细模式）。
    fn normalize(&mut self, session_id: &str, verbose: bool) -> bool {
        if matches!(self.level, DiagLevel::Debug | DiagLevel::Trace) && !verbose {
            return false;
        }
        self.timestamp = now_iso();
        if self.session_id.trim().is_empty() {
            self.session_id = session_id.to_string();
        }
        self.module = privacy::normalize_ident(&self.module, 32, "unknown");
        self.action = privacy::normalize_ident(&self.action, 64, "unknown");
        self.event = privacy::normalize_ident(&self.event, 48, "log");
        if let Some(window) = self.window_id.take() {
            self.window_id = Some(privacy::normalize_ident(&window, 32, "unknown"));
        }
        if let Some(component) = self.component.take() {
            let cleaned = privacy::sanitize_message(&component);
            if !cleaned.is_empty() {
                self.component = Some(cleaned);
            }
        }
        if let Some(stage) = self.stage.take() {
            self.stage = Some(privacy::normalize_ident(&stage, 32, "unknown"));
        }
        if let Some(code) = self.error_code.take() {
            self.error_code = privacy::normalize_error_code(&code);
        }
        if let Some(category) = self.error_category.take() {
            self.error_category = Some(privacy::normalize_ident(&category, 24, "unknown"));
        }
        if let Some(message) = self.message.take() {
            let cleaned = privacy::sanitize_message(&message);
            if !cleaned.is_empty() {
                self.message = Some(cleaned);
            }
        }
        if let Some(meta) = self.metadata.take() {
            self.metadata = privacy::sanitize_metadata(&meta);
        }
        if let Some(op) = self.operation_id.take() {
            let cleaned = privacy::normalize_ident(&op, 64, "");
            if !cleaned.is_empty() {
                self.operation_id = Some(cleaned);
            }
        }
        self.count = self.count.max(1);
        true
    }

    /// 聚合指纹：级别 + 模块 + 操作 + 事件 + 错误码（不含 `operation_id`）。
    fn fingerprint(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.level.as_str(),
            self.module,
            self.action,
            self.event,
            self.error_code.as_deref().unwrap_or("-"),
        )
    }
}

/// 刷盘结果：调用方（导出/清理）必须据此判断内容是否可信，不能默认成功。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushOutcome {
    /// 写线程已把队列中此前的事件（含聚合摘要）落盘。
    pub flushed: bool,
    /// 入队/回执超时：磁盘上可能有更新的数据未包含在本次读取中。
    pub timed_out: bool,
    /// 队列满载：刷盘请求可能排在很后面。
    pub queue_full: bool,
}

impl FlushOutcome {
    pub fn ok() -> Self {
        Self {
            flushed: true,
            timed_out: false,
            queue_full: false,
        }
    }

    pub fn degraded(&self) -> bool {
        !self.flushed || self.timed_out || self.queue_full
    }
}

/// 清理结果：`completed=false` 表示没有执行（调用方超时/取消），文件未被修改。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutcome {
    pub removed_bytes: u64,
    /// 清理是否真正执行完成。false = 取消或未开始，日志保持原样。
    pub completed: bool,
}

/// 写入端计数器（无锁，查询时快照）。
#[derive(Debug, Default)]
pub struct Counters {
    pub written: AtomicU64,
    pub dropped: AtomicU64,
    pub queue_full: AtomicU64,
    pub aggregated: AtomicU64,
    pub rotations: AtomicU64,
    pub failures: AtomicU64,
    pub skipped_lines: AtomicU64,
}

impl Counters {
    /// 快照（`(written, dropped, queue_full, aggregated, rotations, failures, skipped)`）。
    pub fn snapshot(&self) -> [u64; 7] {
        [
            self.written.load(Ordering::Relaxed),
            self.dropped.load(Ordering::Relaxed),
            self.queue_full.load(Ordering::Relaxed),
            self.aggregated.load(Ordering::Relaxed),
            self.rotations.load(Ordering::Relaxed),
            self.failures.load(Ordering::Relaxed),
            self.skipped_lines.load(Ordering::Relaxed),
        ]
    }
}

/// 写线程配置（测试可调小阈值）。
#[derive(Debug, Clone)]
pub struct WriterConfig {
    pub max_file_bytes: u64,
    pub max_archive_files: usize,
    pub max_total_bytes: u64,
    pub agg_window: Duration,
    pub agg_capacity: usize,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_FILE_BYTES,
            max_archive_files: MAX_ARCHIVE_FILES,
            max_total_bytes: MAX_TOTAL_BYTES,
            agg_window: AGG_WINDOW,
            agg_capacity: AGG_MAX_ENTRIES,
        }
    }
}

/// 诊断日志句柄：所有写操作转发到单写线程，读操作在调用线程完成。
pub struct Diagnostics {
    dir: PathBuf,
    session_id: String,
    started_at: String,
    started: Instant,
    tx: SyncSender<writer::Msg>,
    counters: Arc<Counters>,
    /// 详细诊断模式到期的单调毫秒（相对 `started`）；0 = 正常模式。
    verbose_until_ms: AtomicU64,
    disabled: AtomicBool,
    /// 清理单飞：并发点击只允许一个请求进入写线程。
    clearing: AtomicBool,
    /// 退出收尾单飞。
    shutting_down: AtomicBool,
    /// 动态日志级别回调（由 lib.rs 挂载 `tracing_subscriber::reload`）。
    /// 详细模式必须真正改变 `tracing` 过滤，否则 DEBUG 在进入诊断层之前就被丢弃。
    filter_reload: Mutex<Option<FilterReload>>,
    join: Mutex<Option<JoinHandle<()>>>,
    last_writer_error: Mutex<Option<String>>,
}

impl Diagnostics {
    /// 启动诊断日志：创建目录、清理过期归档、启动单写线程。
    ///
    /// 任何失败都**不阻断启动**：返回的句柄仍可接收事件，只是 `disabled=true`。
    pub fn init(app: &tauri::AppHandle) -> Arc<Self> {
        let dir = crate::app_data_dir(app).join("diagnostics");
        Self::init_at(dir, WriterConfig::default())
    }

    pub fn init_at(dir: PathBuf, cfg: WriterConfig) -> Arc<Self> {
        let (tx, rx) = sync_channel(CHANNEL_CAPACITY);
        let counters = Arc::new(Counters::default());
        let mut disabled = false;
        if let Err(e) = std::fs::create_dir_all(&dir) {
            disabled = true;
            eprintln!("[diagnostics] 日志目录不可用，诊断落盘已降级: {e}");
        }
        let diag = Arc::new(Self {
            dir: dir.clone(),
            session_id: uuid::Uuid::new_v4().to_string(),
            started_at: now_iso(),
            started: Instant::now(),
            tx,
            counters: counters.clone(),
            verbose_until_ms: AtomicU64::new(0),
            disabled: AtomicBool::new(disabled),
            clearing: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            filter_reload: Mutex::new(None),
            join: Mutex::new(None),
            last_writer_error: Mutex::new(None),
        });
        let thread_diag = diag.clone();
        let handle = std::thread::Builder::new()
            .name("diagnostics-writer".to_string())
            .spawn(move || writer::run(dir, cfg, counters, rx, thread_diag))
            .ok();
        if let Ok(mut slot) = diag.join.lock() {
            *slot = handle;
        }
        diag
    }

    /// 注册为进程级单例。重复调用返回第一次的实例（多窗口共享同一写线程）。
    pub fn install(self: &Arc<Self>) -> Arc<Self> {
        GLOBAL.get_or_init(|| self.clone()).clone()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    pub fn counters(&self) -> &Arc<Counters> {
        &self.counters
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled.load(Ordering::Relaxed)
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// 详细诊断模式是否生效（到期自动恢复为正常模式）。
    pub fn is_verbose(&self) -> bool {
        let deadline = self.verbose_until_ms.load(Ordering::Relaxed);
        if deadline == 0 {
            return false;
        }
        if self.now_ms() < deadline {
            return true;
        }
        // 到期：CAS 归零，只让一个线程负责记录恢复事件。
        if self
            .verbose_until_ms
            .compare_exchange(deadline, 0, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            // 先恢复 `tracing` 过滤，再记录事件；事件本身也走统一入口（补时间戳/会话）。
            self.apply_filter(false);
            self.record(
                DiagnosticEvent::new(DiagLevel::Info, "diagnostics", "verbose_mode", "expired")
                    .with_message("详细诊断模式已到期，自动恢复为正常模式"),
            );
        }
        false
    }

    /// 切换诊断模式。`minutes` 仅详细模式有效，收敛到 1..=VERBOSE_MAX_MINUTES。
    /// 返回详细模式的剩余分钟数（正常模式为 0）。
    pub fn set_mode(&self, verbose: bool, minutes: Option<u32>) -> u32 {
        let mins = if verbose {
            minutes
                .unwrap_or(VERBOSE_DEFAULT_MINUTES)
                .clamp(1, VERBOSE_MAX_MINUTES)
        } else {
            0
        };
        let deadline = if verbose {
            self.now_ms().saturating_add(u64::from(mins) * 60_000)
        } else {
            0
        };
        self.verbose_until_ms.store(deadline, Ordering::Relaxed);
        self.apply_filter(verbose);
        // 可复核的级别切换探针：详细模式下这条 DEBUG 必须落盘，正常模式下必须被过滤。
        tracing::debug!(verbose, minutes = mins, "诊断日志级别已切换");
        // 统一入口：与普通事件一样经过 normalize（时间戳/session/脱敏）。
        self.record(
            DiagnosticEvent::new(DiagLevel::Info, "diagnostics", "verbose_mode", "changed")
                .with_message(format!(
                    "诊断模式切换为{}",
                    if verbose { "详细" } else { "正常" }
                ))
                .with_metadata(
                    "mode",
                    Value::String(if verbose {
                        "verbose".into()
                    } else {
                        "normal".into()
                    }),
                ),
        );
        mins
    }

    pub fn verbose_remaining_ms(&self) -> u64 {
        let deadline = self.verbose_until_ms.load(Ordering::Relaxed);
        if deadline == 0 {
            return 0;
        }
        deadline.saturating_sub(self.now_ms())
    }

    /// 记录一条事件（非阻塞）。`false` 表示被丢弃（队列满或级别被过滤）。
    pub fn record(&self, mut event: DiagnosticEvent) -> bool {
        if !event.normalize(&self.session_id, self.is_verbose()) {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let level = event.level;
        let mut boxed = Box::new(event);
        let mut retried = 0u8;
        loop {
            match self.tx.try_send(writer::Msg::Event(boxed)) {
                Ok(()) => return true,
                Err(std::sync::mpsc::TrySendError::Full(msg)) => {
                    if retried == 0 {
                        self.counters.queue_full.fetch_add(1, Ordering::Relaxed);
                    }
                    boxed = match msg {
                        writer::Msg::Event(ev) => ev,
                        other => {
                            let _ = self.tx.try_send(other);
                            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                            return false;
                        }
                    };
                    // 高优先级错误允许极短重试（≤2ms）；其余直接丢弃并计数。
                    if level >= DiagLevel::Error && retried < 2 {
                        retried += 1;
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
            }
        }
    }

    /// 挂载动态日志级别回调（仅 lib.rs 启动时调用一次）。
    ///
    /// 详细诊断模式必须**真正改变 `tracing` 过滤**：否则 `EnvFilter` 会在事件
    /// 到达诊断层之前丢弃 DEBUG/TRACE，模式只剩一个界面开关。
    pub fn attach_filter_reload<F>(&self, reload: F)
    where
        F: Fn(bool) + Send + Sync + 'static,
    {
        if let Ok(mut slot) = self.filter_reload.lock() {
            *slot = Some(Box::new(reload));
        }
    }

    fn apply_filter(&self, verbose: bool) {
        // 回调只做 reload，不写日志（避免递归）。
        if let Ok(slot) = self.filter_reload.lock() {
            if let Some(reload) = slot.as_ref() {
                reload(verbose);
            }
        }
    }

    /// 有界投递消息：最多等待 `wait`，绝不在业务线程上无限阻塞。
    fn send_bounded(&self, mut msg: writer::Msg, wait: Duration) -> Result<(), &'static str> {
        let deadline = Instant::now() + wait;
        loop {
            match self.tx.try_send(msg) {
                Ok(()) => return Ok(()),
                Err(std::sync::mpsc::TrySendError::Full(back)) => {
                    if Instant::now() >= deadline {
                        self.counters.queue_full.fetch_add(1, Ordering::Relaxed);
                        return Err("queue_full");
                    }
                    msg = back;
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => return Err("closed"),
            }
        }
    }

    /// 刷盘并等待写线程处理完当前队列（导出/清理前调用）。
    ///
    /// 返回明确结果：调用方不得在 `flushed=false` 时声称数据完整。
    pub fn flush_blocking(&self) -> FlushOutcome {
        let (ack_tx, ack_rx) = sync_channel(1);
        if let Err(reason) =
            self.send_bounded(writer::Msg::Flush(ack_tx), Duration::from_millis(300))
        {
            return FlushOutcome {
                flushed: false,
                timed_out: reason == "closed",
                queue_full: reason == "queue_full",
            };
        }
        match ack_rx.recv_timeout(FLUSH_ACK_TIMEOUT) {
            Ok(()) => FlushOutcome::ok(),
            Err(_) => FlushOutcome {
                flushed: false,
                timed_out: true,
                queue_full: false,
            },
        }
    }

    /// 清空历史日志（只删本目录下自己的 JSONL 文件，绝不触碰业务数据）。
    ///
    /// 生命周期：单飞占用 → 有界入队 → 等待回执。超时会**请求取消**（写线程在开始
    /// 删除前检查标记），因此不会出现"界面提示失败、稍后又静默删除"的不一致。
    pub fn clear(&self) -> AppResult<ClearOutcome> {
        if self
            .clearing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(crate::error::AppError::Conflict(
                "已有诊断日志清理在进行中".into(),
            ));
        }
        struct Guard<'a>(&'a AtomicBool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = Guard(&self.clearing);

        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let (ack_tx, ack_rx) = sync_channel(1);
        self.send_bounded(
            writer::Msg::Clear {
                ack: ack_tx,
                cancelled: cancelled.clone(),
            },
            Duration::from_millis(500),
        )
        .map_err(|reason| match reason {
            "queue_full" => crate::error::AppError::Overloaded(
                "日志队列繁忙，清理请求未提交（日志未删除）".into(),
            ),
            _ => crate::error::AppError::Unavailable("诊断写入线程已退出".into()),
        })?;
        match ack_rx.recv_timeout(CLEAR_ACK_TIMEOUT) {
            Ok(Ok(removed)) => Ok(ClearOutcome {
                removed_bytes: removed,
                completed: true,
            }),
            Ok(Err(msg)) if msg == CLEAR_CANCELLED => {
                Err(timeout_error("清理请求已取消（超时未执行），日志保持原样"))
            }
            Ok(Err(msg)) => Err(crate::error::AppError::Io(std::io::Error::other(msg))),
            Err(_) => {
                // 超时：标记取消；写线程若尚未开始则放弃删除。
                cancelled.store(true, Ordering::Release);
                Err(timeout_error(
                    "清理超时（结果未确认），已请求取消；请稍后刷新确认",
                ))
            }
        }
    }

    /// 目录文件快照（只统计本模块命名规则的文件，新的在前）。
    pub fn file_snapshot(&self) -> Vec<query::LogFile> {
        query::list_files(&self.dir)
    }

    pub fn total_bytes(&self) -> u64 {
        self.file_snapshot().iter().map(|f| f.bytes).sum()
    }

    pub fn last_writer_error(&self) -> Option<String> {
        self.last_writer_error
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }

    pub(crate) fn set_disabled(&self, value: bool) {
        self.disabled.store(value, Ordering::Relaxed);
    }

    pub(crate) fn record_writer_error(&self, message: String) {
        if let Ok(mut slot) = self.last_writer_error.lock() {
            *slot = Some(message);
        }
    }

    /// 停止写线程（幂等，退出流程专用）。有界入队 + 单飞，避免队列满时卡住退出。
    pub fn shutdown(&self) {
        if self
            .shutting_down
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        // 队列满时仍要尽量收尾：最多等 1 秒，随后直接 join（写线程会在断开时自行收尾）。
        let _ = self.send_bounded(writer::Msg::Shutdown, Duration::from_secs(1));
        let mut slot = match self.join.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(handle) = slot.take() {
            let _ = handle.join();
        }
    }
}

/// 进程级句柄；未初始化时返回 `None`（单元测试、CLI 子命令）。
pub fn global() -> Option<&'static Arc<Diagnostics>> {
    GLOBAL.get()
}

/// 记录事件（未初始化时静默丢弃）。业务代码的主要入口。
pub fn emit(event: DiagnosticEvent) {
    if let Some(diag) = GLOBAL.get() {
        diag.record(event);
    }
}

/// 便捷构造：`diagnostics::event(DiagLevel::Info, "task", "create", "success")`
pub fn event(level: DiagLevel, module: &str, action: &str, name: &str) -> EventBuilder {
    EventBuilder {
        event: DiagnosticEvent::new(level, module, action, name),
    }
}

/// 链式事件构造器（避免业务代码拼装大结构体）。
pub struct EventBuilder {
    event: DiagnosticEvent,
}

impl EventBuilder {
    pub fn stage(mut self, stage: &str) -> Self {
        self.event.stage = Some(stage.to_string());
        self
    }

    pub fn status(mut self, status: DiagStatus) -> Self {
        self.event.status = Some(status);
        self
    }

    pub fn operation(mut self, operation_id: &str) -> Self {
        self.event.operation_id = Some(operation_id.to_string());
        self
    }

    pub fn window(mut self, window_id: &str) -> Self {
        self.event.window_id = Some(window_id.to_string());
        self
    }

    pub fn component(mut self, component: &str) -> Self {
        self.event.component = Some(component.to_string());
        self
    }

    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.event.message = Some(message.into());
        self
    }

    pub fn error_code(mut self, code: &str) -> Self {
        self.event.error_code = Some(code.to_string());
        self
    }

    pub fn error_category(mut self, category: &str) -> Self {
        self.event.error_category = Some(category.to_string());
        self
    }

    pub fn duration_ms(mut self, ms: u64) -> Self {
        self.event.duration_ms = Some(ms);
        self
    }

    pub fn retry_count(mut self, count: u32) -> Self {
        self.event.retry_count = Some(count);
        self
    }

    pub fn metadata(mut self, key: &str, value: Value) -> Self {
        self.event
            .metadata
            .get_or_insert_with(Map::new)
            .insert(key.to_string(), value);
        self
    }

    /// 从 `AppError` 填充错误码与错误分类（错误文案走调用方提供的语义化 message）。
    pub fn from_error(self, err: &crate::error::AppError) -> Self {
        let code = err.code();
        let category = err.category().as_str();
        self.error_code(code).error_category(category)
    }

    pub fn build(self) -> DiagnosticEvent {
        self.event
    }

    pub fn emit(self) {
        emit(self.event);
    }
}

// 事件构造的私有便捷方法（供 `Diagnostics` 内部与测试使用）。
impl DiagnosticEvent {
    fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    fn with_metadata(mut self, key: &str, value: Value) -> Self {
        self.metadata
            .get_or_insert_with(Map::new)
            .insert(key.to_string(), value);
        self
    }
}

/// 清理/刷盘超时：映射到 `AppError::Io(TimedOut)`（错误码 TIMEOUT，可重试）。
fn timeout_error(message: &str) -> crate::error::AppError {
    crate::error::AppError::Io(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        message.to_string(),
    ))
}

/// 带时区的 RFC3339 毫秒时间戳（本地时区）。
pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

#[cfg(test)]
mod tests;
