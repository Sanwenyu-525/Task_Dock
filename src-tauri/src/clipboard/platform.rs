//! Windows 剪贴板读写与监听（唯一触碰 Win32 剪贴板的模块）。
//!
//! 监听使用 `AddClipboardFormatListener` + 消息专用窗口；读取只识别
//! 文本 / HTML / PNG / DIB / 文件列表，无法安全解析的格式不记录。
//! 本进程的所有写入（单项复制、整组复制、逐项粘贴、粘贴后恢复）都在
//! 进程级访问锁内完成并登记最终序列号，监听侧据此跳过自身写入事件。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::engine;
use super::image;
use super::store;
use super::{
    CapturedContent, CapturedImage, MAX_FILE_COUNT, MAX_HTML_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_BYTES,
};
use crate::db::{ClipboardConfigError, Db, Settings};
use crate::error::{AppError, AppResult};

/// 监听数据汇：去重/设置检查/落库/广播都在这里，监听线程只负责读取。
pub struct CaptureSink {
    pub db: Arc<Db>,
    pub root: PathBuf,
    pub app: AppHandle,
    pub self_write: Arc<AtomicU32>,
    /// 历史清空代数：事件在产生时记录代数，旧代数的内容不得在清空后回写。
    pub capture_epoch: Arc<AtomicU64>,
    /// 清空历史时刻的剪贴板序列号（0 = 从未清空）：事件序列号不晚于它，
    /// 说明内容来自清空之前；即使事件在清空后才派发、盖的是新代数，
    /// 也必须在采集侧丢弃，否则旧内容会复活。
    pub clear_seq: Arc<AtomicU32>,
    /// 清空与入库的临界区：清空期间不允许入库线程写资产。
    pub capture_gate: Arc<Mutex<()>>,
}

/// 内容队列条目：带上采集代数与**读取时刻**的序列号，工作线程在清空后据此丢弃旧内容。
///
/// 序列号是内容先后的权威证据（读取发生在清空之前则必然不晚于清空水位）；
/// 代数只用于序列号不可用时的兜底，单独使用会误杀「清空指令推进水位的极小
/// 窗口内盖章派发的清空后新复制」。
pub(crate) struct QueuedCapture {
    pub epoch: u64,
    pub sequence: u32,
    pub content: CapturedContent,
}

#[derive(Debug)]
pub enum ClipboardRead {
    /// 采集到的内容，以及**读取那一刻**观察到的剪贴板序列号。
    ///
    /// 序列号随内容一起返回，采集线程才能把水位推进到「真正读到的状态」：
    /// 同一份剪贴板状态只记一次，随后的同内容事件不会把 copy_count 顶上去。
    Content {
        sequence: u32,
        content: Box<CapturedContent>,
    },
    Skip(&'static str),
    /// 剪贴板当前没有可采集的内容（为空，或只有无法识别的格式）。
    Empty(&'static str),
}

// ── 有界队列与诊断计数（监听链路不允无限积压）──────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
    Pushed,
    /// 容量或字节上限已满，丢弃最旧的一条后写入
    DroppedOldest,
    /// 单条超过字节上限，拒绝入队
    RejectedTooLarge,
    Closed,
}

pub(crate) struct BoundedQueue<T> {
    state: Mutex<QueueState<T>>,
    cv: Condvar,
    capacity: usize,
    max_bytes: usize,
    closed: AtomicBool,
}

struct QueueState<T> {
    items: VecDeque<(T, usize)>,
    bytes: usize,
}

impl<T> BoundedQueue<T> {
    pub(crate) fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            state: Mutex::new(QueueState {
                items: VecDeque::new(),
                bytes: 0,
            }),
            cv: Condvar::new(),
            capacity: capacity.max(1),
            max_bytes: max_bytes.max(1),
            closed: AtomicBool::new(false),
        }
    }

    /// 非阻塞入队：满时丢弃最旧的若干条，保证最新事件一定能进入队列。
    /// 生产路径统一用 [`Self::push_counting`] 以便统计淘汰条数；这里保留给测试。
    #[cfg(test)]
    pub(crate) fn push(&self, item: T, weight: usize) -> PushOutcome {
        self.push_counting(item, weight).0
    }

    /// 与 [`Self::push`] 相同，但返回本次为腾空间淘汰的条数。
    ///
    /// 字节预算紧张时一次 push 可能连丢多条，诊断计数必须按实际条数累加，
    /// 否则 `dropped_contents`/`dropped_events` 会低报丢失量。
    pub(crate) fn push_counting(&self, item: T, weight: usize) -> (PushOutcome, usize) {
        if self.closed.load(Ordering::SeqCst) {
            return (PushOutcome::Closed, 0);
        }
        if weight > self.max_bytes {
            return (PushOutcome::RejectedTooLarge, 0);
        }
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut dropped = 0usize;
        while st.items.len() >= self.capacity
            || (st.bytes.saturating_add(weight) > self.max_bytes && !st.items.is_empty())
        {
            let Some((_, w)) = st.items.pop_front() else {
                break;
            };
            st.bytes = st.bytes.saturating_sub(w);
            dropped += 1;
        }
        st.items.push_back((item, weight));
        st.bytes = st.bytes.saturating_add(weight);
        self.cv.notify_one();
        let outcome = if dropped > 0 {
            PushOutcome::DroppedOldest
        } else {
            PushOutcome::Pushed
        };
        (outcome, dropped)
    }

    pub(crate) fn pop(&self) -> Option<T> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return None;
            }
            if let Some((item, weight)) = st.items.pop_front() {
                st.bytes = st.bytes.saturating_sub(weight);
                return Some(item);
            }
            st = self.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub(crate) fn try_pop(&self) -> Option<T> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (item, weight) = st.items.pop_front()?;
        st.bytes = st.bytes.saturating_sub(weight);
        Some(item)
    }

    pub(crate) fn len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .items
            .len()
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }
}

pub(crate) const EVENT_QUEUE_CAPACITY: usize = 64;
pub(crate) const CONTENT_QUEUE_CAPACITY: usize = 8;
/// 采集队列（未入库内容）的字节上限：8 条大图也不至于无限占用内存。
pub(crate) const CONTENT_QUEUE_MAX_BYTES: usize = 128 * 1024 * 1024;
/// 剪贴板被其他程序占用时事件重排的上限（每次重排 open_clipboard 内部还会
/// 重试约 120ms）：总等待有界，超限才放弃并计入 read_failed。
pub(crate) const MAX_READ_BUSY_RETRIES: u32 = 3;
/// 读空后的复核次数与等待：Win32 写入方常按 EmptyClipboard→SetClipboardData 两步
/// 提交，两步之间存在一个可被监听线程读到的空窗口（实测外部复制偶发
/// `observed=1 / captured=0 / empty_events=1`，而数百毫秒后剪贴板里确有 PNG）。
/// 空读只做一次有界复核，复核仍空才计入 `empty_events`，避免把已落地的复制永久丢弃，
/// 也不改变「空剪贴板」的判定语义。
pub(crate) const MAX_EMPTY_RECHECK: u32 = 1;
pub(crate) const EMPTY_RECHECK_DELAY_MS: u64 = 120;

struct MonitorCounters {
    observed_events: AtomicU64,
    /// WM_CLIPBOARDUPDATE 到达但监听实例尚未就绪（启动/看门狗重启间隙），
    /// 事件无法路由：这段盲区里的复制无法补偿，只能计数供诊断对账。
    unobserved_events: AtomicU64,
    /// 积压事件被合并进最新事件的条数：含被更新事件覆盖的、以及乱序丢弃的旧事件。
    merged_events: AtomicU64,
    captured: AtomicU64,
    recorded: AtomicU64,
    duplicates: AtomicU64,
    skipped: AtomicU64,
    /// 打开剪贴板重试后仍失败（被其他程序独占）的事件数。
    /// 与 `skipped`（配置拒绝/超限/自写等策略性跳过）分开，便于定位「读过但读不到」。
    read_failed: AtomicU64,
    /// 监听线程被看门狗检测到已退出并重新拉起的次数。
    monitor_restarts: AtomicU64,
    /// 序列号不晚于已采集水位：同一份剪贴板状态已经记过，不再重复入库。
    superseded_events: AtomicU64,
    /// 本进程自己的写入（复制/粘贴/恢复）产生的事件。
    self_write_events: AtomicU64,
    /// 事件到达但剪贴板里没有可采集的内容（为空或格式无法识别）。
    empty_events: AtomicU64,
    /// 清空前产生、清空后才处理的事件：不得回写历史（参与事件对账）。
    cleared_stale_events: AtomicU64,
    /// 清空前已入队、清空后才轮到处理的内容：不得回写历史。
    cleared_stale_contents: AtomicU64,
    dropped_events: AtomicU64,
    dropped_contents: AtomicU64,
    failed: AtomicU64,
    peak_event_queue: AtomicU64,
    peak_content_queue: AtomicU64,
    max_capture_latency_ms: AtomicU64,
    max_process_latency_ms: AtomicU64,
}

impl MonitorCounters {
    const fn new() -> Self {
        Self {
            observed_events: AtomicU64::new(0),
            unobserved_events: AtomicU64::new(0),
            merged_events: AtomicU64::new(0),
            captured: AtomicU64::new(0),
            recorded: AtomicU64::new(0),
            duplicates: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
            read_failed: AtomicU64::new(0),
            monitor_restarts: AtomicU64::new(0),
            superseded_events: AtomicU64::new(0),
            self_write_events: AtomicU64::new(0),
            empty_events: AtomicU64::new(0),
            cleared_stale_events: AtomicU64::new(0),
            cleared_stale_contents: AtomicU64::new(0),
            dropped_events: AtomicU64::new(0),
            dropped_contents: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            peak_event_queue: AtomicU64::new(0),
            peak_content_queue: AtomicU64::new(0),
            max_capture_latency_ms: AtomicU64::new(0),
            max_process_latency_ms: AtomicU64::new(0),
        }
    }

    fn bump_peak(counter: &AtomicU64, value: usize) {
        counter.fetch_max(value as u64, Ordering::Relaxed);
    }
}

static MONITOR_COUNTERS: MonitorCounters = MonitorCounters::new();

#[derive(Debug, Clone, Serialize)]
pub struct MonitorStats {
    pub observed_events: u64,
    pub unobserved_events: u64,
    pub merged_events: u64,
    pub captured: u64,
    pub recorded: u64,
    pub duplicates: u64,
    pub skipped: u64,
    pub read_failed: u64,
    pub monitor_restarts: u64,
    pub superseded_events: u64,
    pub self_write_events: u64,
    pub empty_events: u64,
    pub cleared_stale_events: u64,
    pub cleared_stale_contents: u64,
    pub dropped_events: u64,
    pub dropped_contents: u64,
    pub failed: u64,
    pub peak_event_queue: u64,
    pub peak_content_queue: u64,
    pub max_capture_latency_ms: u64,
    pub max_process_latency_ms: u64,
    pub event_queue_capacity: u64,
    pub content_queue_capacity: u64,
    pub content_queue_max_bytes: u64,
}

/// 监听链路诊断快照：只含计数，不含任何剪贴板内容。
pub fn monitor_stats() -> MonitorStats {
    let c = &MONITOR_COUNTERS;
    MonitorStats {
        observed_events: c.observed_events.load(Ordering::Relaxed),
        unobserved_events: c.unobserved_events.load(Ordering::Relaxed),
        merged_events: c.merged_events.load(Ordering::Relaxed),
        captured: c.captured.load(Ordering::Relaxed),
        recorded: c.recorded.load(Ordering::Relaxed),
        duplicates: c.duplicates.load(Ordering::Relaxed),
        skipped: c.skipped.load(Ordering::Relaxed),
        read_failed: c.read_failed.load(Ordering::Relaxed),
        monitor_restarts: c.monitor_restarts.load(Ordering::Relaxed),
        superseded_events: c.superseded_events.load(Ordering::Relaxed),
        self_write_events: c.self_write_events.load(Ordering::Relaxed),
        empty_events: c.empty_events.load(Ordering::Relaxed),
        cleared_stale_events: c.cleared_stale_events.load(Ordering::Relaxed),
        cleared_stale_contents: c.cleared_stale_contents.load(Ordering::Relaxed),
        dropped_events: c.dropped_events.load(Ordering::Relaxed),
        dropped_contents: c.dropped_contents.load(Ordering::Relaxed),
        failed: c.failed.load(Ordering::Relaxed),
        peak_event_queue: c.peak_event_queue.load(Ordering::Relaxed),
        peak_content_queue: c.peak_content_queue.load(Ordering::Relaxed),
        max_capture_latency_ms: c.max_capture_latency_ms.load(Ordering::Relaxed),
        max_process_latency_ms: c.max_process_latency_ms.load(Ordering::Relaxed),
        event_queue_capacity: EVENT_QUEUE_CAPACITY as u64,
        content_queue_capacity: CONTENT_QUEUE_CAPACITY as u64,
        content_queue_max_bytes: CONTENT_QUEUE_MAX_BYTES as u64,
    }
}

/// 记录一次看门狗重启，供诊断核对（只在真正重新拉起监听时调用）。
pub fn note_monitor_restart() {
    MONITOR_COUNTERS
        .monitor_restarts
        .fetch_add(1, Ordering::Relaxed);
}

fn estimate_content_bytes(c: &CapturedContent) -> usize {
    c.text.len()
        + c.html.len()
        + c.preview.len()
        + c.source_app.len()
        + c.source_title.len()
        + c.file_paths.iter().map(|p| p.len()).sum::<usize>()
        + c.image
            .as_ref()
            .map(|i| i.png.len() + i.rgba.len())
            .unwrap_or(0)
}

/// 入队记账：整条内容超过队列字节预算时，先释放解码像素再记账。
///
/// 队列里同时驻留 `png` 与 `rgba`，而 `rgba` 是像素数 ×4——只按 `png` 记账会让
/// 名义 128MB 的预算在连续几张 4K 截图后实际驻留数百 MB。超大条目（拼接屏、
/// 超高分辨率图）仍要入库，所以让它带着 `png` 入队，由工作线程重新解码一次；
/// 这样峰值受预算约束，代价只落在本来就罕见的一次额外解码上。
fn queue_weight_for(content: &mut CapturedContent) -> usize {
    let weight = estimate_content_bytes(content);
    if weight <= CONTENT_QUEUE_MAX_BYTES {
        return weight;
    }
    if let Some(image) = content.image.as_mut() {
        image.rgba = Vec::new();
    }
    estimate_content_bytes(content)
}

/// 入库结果：供监听线程更新诊断计数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessOutcome {
    Recorded { created: bool },
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureDecision {
    Accept,
    Skip(&'static str),
}

/// 采集过滤策略（纯函数，便于验证暂停、排除名单、来源未知与敏感策略）。
fn filter_capture(content: &mut CapturedContent, settings: &Settings) -> CaptureDecision {
    if !settings.clipboard_enabled || settings.clipboard_paused {
        return CaptureDecision::Skip("监听已暂停");
    }
    // 来源应用只是采集时的前台推断，不能当作绝对证据。
    let source_unknown =
        content.source_app.trim().is_empty() || content.source_app.eq_ignore_ascii_case("unknown");
    // 不再按「前台推断 == 本进程」跳过：采集读取是异步的，截图工具（如
    // Snipaste）复制后立即关闭覆盖层，前台切回 Task Dock，外部图片会被
    // 误判成自身复制而丢弃。本进程写入的识别只依赖自写序列号水位
    // （classify_event / read_clipboard_for_event），所有 Rust 写入路径
    // 都会在访问锁内登记水位；WebView 内用户主动的复制不属于回流，
    // 与系统剪贴板历史同样入库。
    if excluded(&settings.clipboard_exclude_apps, &content.source_app) {
        return CaptureDecision::Skip("来源应用在排除名单");
    }
    match content.kind.as_str() {
        super::KIND_IMAGE if !settings.clipboard_capture_images => {
            return CaptureDecision::Skip("未开启图片采集")
        }
        super::KIND_FILES if !settings.clipboard_capture_files => {
            return CaptureDecision::Skip("未开启文件采集")
        }
        super::KIND_HTML if !settings.clipboard_capture_html => {
            if content.text.trim().is_empty() {
                return CaptureDecision::Skip("未开启富文本采集且无纯文本");
            }
            content.kind = super::KIND_TEXT.into();
            content.html.clear();
        }
        _ => {}
    }
    if settings.clipboard_sensitive_filter {
        let hay = format!("{}\n{}", content.text, content.html);
        if engine::sensitive_reason(&hay).is_some() {
            return CaptureDecision::Skip("命中高置信敏感特征");
        }
        // 来源未知时采用更保守的高风险字段策略：无法确认是否来自密码管理器，
        // 宁可少记录，也不把疑似凭据落库。该项策略不做绝对保证。
        if source_unknown && engine::conservative_sensitive_reason(&hay).is_some() {
            return CaptureDecision::Skip("来源未知且命中保守敏感模式");
        }
    }
    CaptureDecision::Accept
}

fn process_catching_panic(f: impl FnOnce() -> ProcessOutcome) -> ProcessOutcome {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(outcome) => outcome,
        Err(_) => ProcessOutcome::Failed,
    }
}

/// 配置异常日志限频：最多每 60 秒记录一次，避免损坏配置导致无限日志。
fn log_config_error(error: &ClipboardConfigError) {
    static LAST_LOG_SECS: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last = LAST_LOG_SECS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 60
        || LAST_LOG_SECS
            .compare_exchange(last, now, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    tracing::warn!("剪贴板配置不可靠，自动记录已暂停：{}", error.message());
}

impl CaptureSink {
    /// 设置过滤 + 入库；只允许在工作线程调用，日志绝不包含正文。
    pub fn process(&self, mut content: CapturedContent) -> ProcessOutcome {
        let config = Settings::load_clipboard(&self.db);
        if !config.capture_allowed() {
            if let Some(error) = config.error.as_ref() {
                log_config_error(error);
            }
            return ProcessOutcome::Skipped;
        }
        if let CaptureDecision::Skip(reason) = filter_capture(&mut content, &config.settings) {
            tracing::debug!("剪贴板跳过：{}", reason);
            return ProcessOutcome::Skipped;
        }
        match store::record_capture(&self.db, &self.root, &content, &config.settings) {
            Ok(out) => {
                tracing::debug!(
                    "剪贴板记录：kind={} size={} created={} grouped={}",
                    out.item.kind,
                    out.item.byte_size,
                    out.created,
                    out.group_id.is_some()
                );
                let _ = self.app.emit(
                    "clipboard-changed",
                    serde_json::json!({
                        "kind": out.item.kind,
                        "created": out.created,
                        "grouped": out.group_id.is_some(),
                    }),
                );
                ProcessOutcome::Recorded {
                    created: out.created,
                }
            }
            Err(e) => {
                tracing::warn!("剪贴板入库失败（内容未记录）: {}", e);
                ProcessOutcome::Failed
            }
        }
    }
}

fn excluded(list: &str, app: &str) -> bool {
    fn exe_key(value: &str) -> String {
        value
            .trim()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
    }
    let app = exe_key(app);
    if app.is_empty() {
        return false;
    }
    list.split([',', ';', '\n', '\r'])
        .map(exe_key)
        .filter(|s| !s.is_empty())
        .any(|s| s == app)
}

// ── 写入载荷 ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ClipboardPayload {
    Text {
        text: String,
        /// HTML 片段（非完整文档；写入时自动加 CF_HTML 头）
        html: Option<String>,
    },
    Image {
        png: Vec<u8>,
        rgba: Option<Vec<u8>>,
        width: u32,
        height: u32,
    },
    Files {
        paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub exe_path: String,
}

/// 粘贴前快照的读取结果类别。
///
/// 「剪贴板为空」「当前读不到」「格式不支持/读取不完整」是三种不同事实，
/// 不能都当成「用户/其他程序接管」：前两者没有可保护的内容，后者只能证明
/// 无法验证，而不是内容已经变了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotState {
    /// 已读到可完整比较的载荷。
    Captured,
    /// 剪贴板上没有任何本应用能识别的内容格式。
    Empty,
    /// 存在内容格式，但无法完整读取或无法重建（例如损坏的图片、超大文本、
    /// 只含未知格式）。
    Unsupported,
    /// 当前打不开剪贴板，连快照都取不到。
    Unreadable,
}

#[derive(Debug)]
pub struct Snapshot {
    pub sequence: u32,
    pub payload: Option<ClipboardPayload>,
    pub state: SnapshotState,
}

/// 写入型真机测试的启动探测（只读，不属于生产粘贴链路）。
///
/// `snapshot` 为 `None` 表示剪贴板当前打不开，既取不到快照也无法证明可恢复；
/// `unsupported_formats` 非空表示剪贴板上存在 `ClipboardPayload` 无法无损重建的
/// 格式（RTF、Office 私有格式、第三方自定义格式、元文件等）；
/// `reconstruction` 判断这份格式集合能否由**读取到的单个载荷**重建（复合格式、
/// HTML-only、路径失效、枚举失败都在这里拒绝）。
/// 以上任一情况都必须拒绝启动写入型测试——测试工具只能重建
/// CF_UNICODETEXT / HTML Format / PNG / CF_DIB / CF_HDROP 及其系统合成格式。
#[derive(Debug)]
pub struct SnapshotProbe {
    pub snapshot: Option<Snapshot>,
    pub unsupported_formats: Vec<String>,
    /// 整份快照能否由读取到的载荷安全重建。
    ///
    /// 「每个格式都在白名单里」不等于「能重建整份内容」：剪贴板可能同时含多个
    /// 独立内容表示（如文本 + PNG），而 `ClipboardPayload` 只能按 `classify()`
    /// 优先级保留一种，其余会在恢复时永久丢失；HTML-only 能读出载荷，却过不了
    /// 写入层「纯文本非空」的必需格式约束。`Err` 中的原因可直接展示给使用者。
    pub reconstruction: Result<(), String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// 没有可恢复内容（原剪贴板为空或格式不支持）
    NoSnapshot,
    Restored,
    /// 期间其他程序写入了剪贴板，拒绝覆盖
    KeepUserCopy,
}

/// 写入守卫：决定本次是否允许执行 `EmptyClipboard`。
///
/// 内容守卫优先于序列号守卫：Windows 会在 `CloseClipboard` 之后继续为
/// 合成/延迟渲染格式递增序列号，序列号不能单独证明剪贴板归属。
#[derive(Debug, Clone, Copy)]
pub enum WriteGuard<'a> {
    /// 只允许在剪贴板内容仍等于该载荷时写入（自己的上一次写入或初始快照）。
    Content(&'a ClipboardPayload),
    /// 初始剪贴板没有可比较内容：仅当序列号未变化时写入。
    Sequence(u32),
    /// 用户主动复制：无条件覆盖。
    Unconditional,
}

/// 带守卫校验的写入结果。
#[derive(Debug, Clone, PartialEq)]
pub enum WriteOutcome {
    /// 写入成功，返回 CloseClipboard 之后读取的最终序列号
    /// （锁内读到的值可能因合成格式的延迟渲染而偏小）。
    Written {
        /// CloseClipboard 之后读取的最终序列号。
        seq: u32,
        /// 剪贴板上实际存在的形态：辅助格式写入失败时已剔除对应字段。
        /// 后续内容比对、自写登记必须以它为准——拿「原本想写的形态」去比，
        /// 会把自己少写的一个格式误判成用户接管，逐项粘贴会无故中止。
        effective: ClipboardPayload,
        /// 未能写入的辅助格式名（用户可见提示用）。
        degraded: Vec<String>,
    },
    /// 守卫拒绝：剪贴板内容已可靠判定为不同，或序列号已变化；
    /// 本次没有执行 EmptyClipboard。
    SequenceChanged,
    /// 守卫无法可靠验证当前剪贴板内容（图片格式读不到/解码失败等），
    /// 本次没有执行 EmptyClipboard，也不能据此断言内容已被改写。
    Unverifiable,
}

/// 单次格式写入的结果。
///
/// `effective` 是剪贴板上实际存在的形态（辅助格式失败时已剔除对应字段），
/// `degraded` 记录没能写入的辅助格式，供界面如实提示「部分格式写入失败」。
#[derive(Debug, Clone, PartialEq)]
pub struct FormatWrite {
    pub effective: ClipboardPayload,
    pub degraded: Vec<String>,
}

/// 只读内容比对结果。
///
/// 「读不到」与「内容不同」必须区分：剪贴板被其他程序短暂占用时，
/// 既不能据此宣布用户接管（会误停正常粘贴），也不能据此发送按键（无法确认内容）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardMatch {
    /// 当前内容与本进程写入的载荷一致。
    Same,
    /// 剪贴板可读，但内容已经变化（用户或第三方程序写入）。
    Different,
    /// 无法打开/读取剪贴板，不能判断内容是否变化。
    Unavailable,
}

/// 守卫判定（与平台无关，便于单元测试）。
pub(crate) fn guard_allows(
    guard: &WriteGuard<'_>,
    actual_sequence: u32,
    content_matches: bool,
) -> bool {
    match guard {
        WriteGuard::Unconditional => true,
        WriteGuard::Content(_) => content_matches,
        WriteGuard::Sequence(expected) => *expected == actual_sequence,
    }
}

/// 32 位剪贴板序列号的回绕安全比较：`candidate` 是否严格晚于 `reference`。
#[inline]
pub(crate) fn sequence_after(candidate: u32, reference: u32) -> bool {
    (candidate.wrapping_sub(reference) as i32) > 0
}

/// 事件序列号是否已被本进程的写入覆盖（自写本身或其重复/延迟通知）。
///
/// 序列号是 32 位计数器，按回绕差比较：`self_write` 当时及其之前的重复通知
/// 视为自写；用户随后复制的新内容严格更晚，必须放行。
#[inline]
pub(crate) fn is_own_write_sequence(event_sequence: u32, self_write: u32) -> bool {
    !sequence_after(event_sequence, self_write)
}

/// 采集事件的处置结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventDisposition {
    /// 继续读取剪贴板。
    Read,
    /// 序列号不晚于已采集水位：同一份剪贴板状态已经记过，不再重复入库。
    Superseded,
    /// 本进程自己的写入（复制/粘贴/恢复）产生的事件。
    SelfWrite,
}

/// 判定一个剪贴板事件是否还值得读取。
///
/// `last_captured` 是**已经读到的内容**对应的序列号，而不是事件序列号：
/// 事件序列号取自消息处理时刻，可能比真正读到的内容更晚或更早；
/// 用读取时的水位才能保证「同一份剪贴板状态只记一次」。
///
/// 自写判定放在覆盖判定之前：自写通知既可能被水位覆盖，也可能是
/// 更早的重复通知，先判自写才能把「本进程自己写的」与「用户重复复制」
/// 在计数器里分开归因。
fn classify_event(event_sequence: u32, last_captured: u32, self_write: u32) -> EventDisposition {
    if is_own_write_sequence(event_sequence, self_write) {
        return EventDisposition::SelfWrite;
    }
    if !sequence_after(event_sequence, last_captured) {
        return EventDisposition::Superseded;
    }
    EventDisposition::Read
}

/// 采集代数门：清空历史之前排队的事件与内容一律作废。
///
/// 两条队列都可能留着「清空前已排队、清空后才被取出」的采集项。内容本身没变，
/// 但用户已经明确清空历史，放行就会把旧内容重新写回库里。代数只增不减，
/// 因此不相等即代表它属于清空前。
pub(crate) fn epoch_is_stale(event_epoch: u64, current_epoch: u64) -> bool {
    event_epoch != current_epoch
}

/// 清空水位判定：事件序列号不晚于清空时刻的序列号，即来自清空前的旧内容。
///
/// 代数只在消息派发时盖章，清空前入队、清空后才处理的事件会拿到新代数；
/// 序列号才是内容先后的证据。`clear_sequence == 0` 表示从未清空过历史，
/// 此时任何事件都不因此丢弃（序列号 0 只在剪贴板从未被写过时出现）。
pub(crate) fn clear_supersedes(event_sequence: u32, clear_sequence: u32) -> bool {
    clear_sequence != 0 && !sequence_after(event_sequence, clear_sequence)
}

/// 采集代数门与清空水位的合并判定（纯函数，供事件层与内容层共用）。
///
/// 仅当「属于旧代数 **且** 序列号不晚于清空水位」时才丢弃。清空指令先记
/// 序列号水位、再推进代数，两步之间盖章派发的清空后新复制带着旧代数，
/// 但其序列号必然严格晚于清空水位——序列号是内容先后的权威证据，必须放行。
/// 若只看代数，用户「清空后立即复制」的那一次会偶发丢失（复现「复制了却
/// 没出现」）。
///
/// `clear_sequence == 0` 表示从未清空过历史：正常情况下与「旧代数」不会同时
/// 出现（水位与代数在同一点位设置），为保守起见维持旧语义，旧代数一律丢弃。
pub(crate) fn cleared_stale_gate(
    event_epoch: u64,
    current_epoch: u64,
    event_sequence: u32,
    clear_sequence: u32,
) -> bool {
    if !epoch_is_stale(event_epoch, current_epoch) {
        return false;
    }
    if clear_sequence == 0 {
        return true;
    }
    clear_supersedes(event_sequence, clear_sequence)
}

/// 登记自写水位：正常前进；序列号回绕时回退到新水位。
///
/// 只前进会把水位永久钉在回绕前的最大值，导致之后所有用户复制都被误判为
/// 自写而不再记录。明显属于过去的旧通知（回绕差为负且距离很近）不回退。
pub(crate) fn note_self_write_watermark(self_write: &AtomicU32, sequence: u32) {
    let mut current = self_write.load(Ordering::SeqCst);
    loop {
        // 序列号回绕后新值在数值上更小，但按回绕差仍是「更晚」，必须更新；
        // 明显过去的旧通知按回绕差为负，保持现有水位。
        let next = if sequence_after(sequence, current) {
            sequence
        } else {
            current
        };
        if next == current {
            return;
        }
        match self_write.compare_exchange(current, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return,
            Err(value) => current = value,
        }
    }
}

/// 恢复写入结束后的统一收尾：成功也只返回结果，**不登记自写水位**。
///
/// 恢复写回的是粘贴开始时的用户剪贴板内容，不是本进程的新内容。若把
/// `final_seq` 记成自写水位，恢复通知本身（以及队列合并后仅剩的最新事件）
/// 会被判成 SelfWrite 跳过；用户那次复制一旦还没被采集，内容就永久丢失。
/// 放行后的同内容记录会走 store 的重复路径，只抬计数、不新建行。
fn finish_restore(written: AppResult<()>) -> AppResult<RestoreOutcome> {
    written.map(|_| RestoreOutcome::Restored)
}

/// 当前剪贴板内容是否仍等于本进程写入的载荷。
///
/// Windows 会在 `CloseClipboard` 之后继续为合成/延迟渲染格式递增序列号，
/// 因此「序列号变化」不等于「用户换了内容」。粘贴前必须用内容比较兜底，
/// 既不能误停正常粘贴，也不能把用户后来复制的内容当成自己的。
///
/// 返回 `None` 表示**无法验证**：只允许出现在图片内容上（没有可解码的 PNG，
/// 也没有可解码的 DIB/DIBV5）。无法验证既不能当成 Same（会覆盖用户内容），
/// 也不能当成 Different（会把「读不到」误报成用户接管）。
pub(crate) fn payload_matches_read(
    expected: &ClipboardPayload,
    text: Option<&str>,
    html: Option<&str>,
    png: Option<&[u8]>,
    dib: Option<&[u8]>,
    files: &[String],
) -> Option<bool> {
    match expected {
        ClipboardPayload::Text {
            text: expected_text,
            html: expected_html,
        } => {
            // 长度为 0 的 CF_HTML 片段不代表富文本。若按「有 HTML」判定，
            // 本进程写入的纯文本会被当成用户已换成富文本：逐项粘贴误停、
            // 自写抑制失效并重复入库。期望侧与实际侧都按不存在处理。
            let html = html.filter(|h| !h.is_empty());
            let expected_html = expected_html.as_ref().filter(|h| !h.is_empty());
            if !expected_text.is_empty() && text != Some(expected_text.as_str()) {
                return Some(false);
            }
            match expected_html {
                Some(expected_html) => Some(html == Some(expected_html.as_str())),
                // 纯文本写入不应带 HTML；若出现 HTML，说明剪贴板已是别处的内容
                None => Some(html.is_none()),
            }
        }
        ClipboardPayload::Image {
            png: expected_png,
            rgba,
            width,
            height,
        } => {
            if expected_png.is_empty() {
                return Some(false);
            }
            // PNG 原始字节完全一致 → 直接判 Same，不做解码。
            if png == Some(expected_png.as_slice()) {
                return Some(true);
            }
            // 完全没有任何图片格式、却存在文本/HTML/文件：这是可靠的不同内容，
            // 不能因为「图片读不到」而报告成无法验证、放过用户的接管。
            let has_other_content = text.is_some_and(|t| !t.is_empty())
                || html.is_some_and(|h| !h.is_empty())
                || !files.is_empty();
            if png.is_none() && dib.is_none() && has_other_content {
                return Some(false);
            }
            // Windows 会用同源 CF_DIB 合成/替换「PNG」容器：容器字节变了不代表图片内容变了。
            // 只比容器字节会把本进程自己写入的图片误判成「用户已接管」，
            // 逐项粘贴会中途停、自写抑制会失效并重复入库，必须回退到像素判定。
            //
            // 剪贴板只有 CF_DIB/CF_DIBV5（Snipping Tool、Snipaste、旧式应用、
            // 第三方剪贴板管理器）时根本没有 PNG 容器：此时只能用 DIB 像素比较，
            // 否则「没有 PNG」会被误判成「内容已变化」，第 1 项就写不进来。
            let expected_pixels =
                expected_image_pixels(expected_png, rgba.as_ref(), *width, *height);
            let actual_pixels = actual_image_pixels(png, dib);
            match (expected_pixels, actual_pixels) {
                (Some((expected_rgba, expected_size)), Some((actual_rgba, actual_size))) => {
                    Some(actual_size == expected_size && actual_rgba == expected_rgba)
                }
                // 任一侧无法可靠解码：只能如实返回「无法验证」。
                _ => None,
            }
        }
        ClipboardPayload::Files { paths } => Some(
            paths.len() == files.len()
                && paths
                    .iter()
                    .zip(files)
                    .all(|(a, b)| a.eq_ignore_ascii_case(b)),
        ),
    }
}

/// 期望侧图片像素：优先使用随载荷缓存的 RGBA（尺寸元数据缺失或长度不符时
/// 退回解码 PNG）。两侧都按同一条 Alpha 归一规则处理。
fn expected_image_pixels(
    png: &[u8],
    rgba: Option<&Vec<u8>>,
    width: u32,
    height: u32,
) -> Option<(Vec<u8>, (u32, u32))> {
    if let Some(cached) = rgba.filter(|r| !r.is_empty()) {
        if width > 0 && height > 0 && cached.len() == width as usize * height as usize * 4 {
            let mut pixels = cached.clone();
            image::canonicalize_unused_alpha(&mut pixels);
            return Some((pixels, (width, height)));
        }
    }
    let (mut pixels, w, h) = image::decode_png_rgba(png).ok()?;
    image::canonicalize_unused_alpha(&mut pixels);
    Some((pixels, (w, h)))
}

/// 实际侧图片像素：优先解码 PNG 容器，失败/缺失时退回 CF_DIB / CF_DIBV5。
///
/// DIB 分支覆盖「只有 DIB」的剪贴板；`dib_to_rgba` 已按 Windows 语义把
/// 「Alpha 未使用」归为不透明，这里再做一次归一保持与 PNG 分支一致。
fn actual_image_pixels(png: Option<&[u8]>, dib: Option<&[u8]>) -> Option<(Vec<u8>, (u32, u32))> {
    if let Some(bytes) = png {
        if let Ok((mut pixels, w, h)) = image::decode_png_rgba(bytes) {
            // 32bpp CF_DIB 合成出的 PNG 容器 Alpha 字节全 0（通道未被使用），
            // 入库时已按不透明处理成 255。不归一就等于拿「Alpha=0 的容器」
            // 比「Alpha=255 的入库版本」，本进程刚写入的图片永远匹配不上自己的
            // 快照，逐项粘贴会在第 1 项就停成「剪贴板已被其他程序更新」。
            // 真实透明图（Alpha 并非全 0）不归一，仍与不透明图区分开。
            image::canonicalize_unused_alpha(&mut pixels);
            return Some((pixels, (w, h)));
        }
    }
    let (mut pixels, w, h) = image::dib_to_rgba(dib?)?;
    image::canonicalize_unused_alpha(&mut pixels);
    Some((pixels, (w, h)))
}

/// 内容不一致的诊断信息：只含格式名与字节数，绝不含正文、路径或图片内容。
pub(crate) fn payload_mismatch_detail(
    expected: &ClipboardPayload,
    text: Option<&str>,
    html: Option<&str>,
    png: Option<&[u8]>,
    dib: Option<&[u8]>,
    files: &[String],
) -> String {
    match expected {
        ClipboardPayload::Text {
            text: expected_text,
            html: expected_html,
        } => format!(
            "期望 text={}B html={:?}B；实际 text={:?}B html={:?}B",
            expected_text.len(),
            expected_html.as_ref().map(|h| h.len()),
            text.map(|t| t.len()),
            html.map(|h| h.len())
        ),
        ClipboardPayload::Image {
            png: expected_png, ..
        } => format!(
            "期望 png={}B；实际 png={:?}B dib={:?}B",
            expected_png.len(),
            png.map(|p| p.len()),
            dib.map(|d| d.len())
        ),
        ClipboardPayload::Files { paths } => {
            format!("期望 files={}；实际 files={}", paths.len(), files.len())
        }
    }
}

pub fn current_sequence() -> u32 {
    imp::current_sequence()
}

pub fn read_clipboard(ignore_markers: bool) -> ClipboardRead {
    imp::read_clipboard(ignore_markers)
}

/// 只读比较当前剪贴板内容，不写入；用于在发送按键前确认剪贴板仍是本项内容。
///
/// 必须区分「内容不同」与「读不到」：前者是用户接管，后者只是短暂占用。
pub fn clipboard_match(payload: &ClipboardPayload) -> ClipboardMatch {
    imp::clipboard_match(payload)
}

/// 无条件写入（用户主动复制）。仍走进程级写锁，避免与逐项粘贴互相覆盖。
pub fn write_payload(payload: &ClipboardPayload) -> AppResult<u32> {
    match write_guarded(payload, WriteGuard::Unconditional)? {
        WriteOutcome::Written { seq, .. } => Ok(seq),
        WriteOutcome::SequenceChanged => {
            Err(AppError::Validation("剪贴板状态已变化，写入已取消".into()))
        }
        WriteOutcome::Unverifiable => Err(AppError::Validation(
            "无法验证剪贴板当前内容，写入已取消".into(),
        )),
    }
}

/// 用户主动复制（单项/整组）的统一入口：写入与自写登记在同一把访问锁内完成。
///
/// 旧的「写入成功后再登记序列号」存在窗口：监听线程可能在登记前读取事件，
/// 把本进程的复制当成外部复制重复入库。
pub fn write_payload_notifying(
    payload: &ClipboardPayload,
    self_write: &AtomicU32,
) -> AppResult<u32> {
    match write_guarded_notifying(payload, WriteGuard::Unconditional, self_write)? {
        WriteOutcome::Written { seq, .. } => Ok(seq),
        WriteOutcome::SequenceChanged => {
            Err(AppError::Validation("剪贴板状态已变化，写入已取消".into()))
        }
        WriteOutcome::Unverifiable => Err(AppError::Validation(
            "无法验证剪贴板当前内容，写入已取消".into(),
        )),
    }
}

/// 带守卫写入：守卫判定与写入都在持有进程写锁 + 剪贴板锁期间完成。
///
/// 这是剪贴板写入竞态的唯一安全边界：守卫拒绝时不会执行 EmptyClipboard，
/// 也就不会覆盖用户后来复制的内容；其他进程也无法在校验与写入之间插入。
pub fn write_guarded(payload: &ClipboardPayload, guard: WriteGuard<'_>) -> AppResult<WriteOutcome> {
    imp::write_guarded(payload, guard)
}

/// 粘贴队列写入：写入成功后在同一个剪贴板访问锁内登记自写序列号。
///
/// 必须与写入选原子化，否则采集线程可能恰好抢在登记之前打开剪贴板，
/// 让本进程在按键发送前后重复占用剪贴板；
/// 只允许在锁内读取 CloseClipboard 之后的序列号，锁外读取会偏小。
pub fn write_guarded_notifying(
    payload: &ClipboardPayload,
    guard: WriteGuard<'_>,
    self_write: &AtomicU32,
) -> AppResult<WriteOutcome> {
    imp::write_guarded_notifying(payload, guard, self_write)
}

pub fn snapshot() -> Snapshot {
    imp::snapshot()
}

/// 快照 + 格式完整性探测：同一次剪贴板打开内完成格式枚举与读取，
/// 避免「先查格式、再快照」之间被其他程序改写而漏判。
///
/// 只供写入型真机验收判断能否安全启动，生产粘贴链路仍使用 `snapshot`。
pub fn snapshot_probe() -> SnapshotProbe {
    imp::snapshot_probe()
}

/// 只有剪贴板内容仍是本进程最后一次写入时才恢复，绝不覆盖用户后来复制的内容。
///
/// 以内容而不是序列号为准：Windows 会在 CloseClipboard 后继续为合成格式递增序列号，
/// 序列号相等/不等都不能单独证明剪贴板属于谁。恢复写入同样属于本进程自写，
/// 成功时在访问锁内登记最终序列号，监听线程不会把恢复当成新的外部复制。
pub fn restore_if_own_content(
    snapshot: &Snapshot,
    last_written: &ClipboardPayload,
    self_write: &AtomicU32,
) -> AppResult<RestoreOutcome> {
    let Some(payload) = snapshot.payload.as_ref() else {
        return Ok(RestoreOutcome::NoSnapshot);
    };
    imp::restore_if_own_content(payload, last_written, self_write)
}

pub fn send_ctrl_v() -> AppResult<()> {
    imp::send_ctrl_v()
}

pub fn foreground_target() -> Option<TargetWindow> {
    imp::foreground_target()
}

pub fn is_foreground(hwnd: isize) -> bool {
    imp::is_foreground(hwnd)
}

pub fn window_target(hwnd: isize) -> Option<TargetWindow> {
    imp::window_target(hwnd)
}

pub fn window_pid(hwnd: isize) -> Option<u32> {
    imp::window_pid(hwnd)
}

pub fn target_is_elevated(pid: u32) -> bool {
    imp::process_elevated(pid)
}

pub fn current_is_elevated() -> bool {
    imp::current_elevated()
}

/// 供 UI 选择粘贴目标：复用导航层的顶层窗口枚举。
pub fn visible_targets() -> Vec<TargetWindow> {
    let own = std::env::current_exe().ok();
    crate::navigation::window_manager::top_windows()
        .into_iter()
        .filter_map(|w| {
            let exe_path = w.exe_path?;
            if exe_path.is_empty() {
                return None;
            }
            if let Some(own) = own.as_ref() {
                if own.to_string_lossy().to_ascii_lowercase() == exe_path.to_ascii_lowercase() {
                    return None;
                }
            }
            Some(TargetWindow {
                hwnd: w.hwnd,
                pid: w.pid,
                title: w.title,
                exe_path,
            })
        })
        .collect()
}

pub fn png_from_item(db: &Db, root: &Path, item_id: &str) -> Option<Vec<u8>> {
    store::image_png(db, root, item_id)
}

// ── 监听器（Windows）────────────────────────────────────────

pub use imp::ClipboardMonitor;

// ── Windows 实现 ────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::mem::zeroed;
    use std::ptr::{null, null_mut};
    use std::sync::Mutex;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetLastError, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT,
        WAIT_OBJECT_0, WPARAM,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, EnumClipboardFormats,
        GetClipboardData, GetClipboardFormatNameW, GetClipboardOwner, GetClipboardSequenceNumber,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
        RemoveClipboardFormatListener, SetClipboardData,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, OpenProcess, OpenProcessToken, SetEvent, INFINITE,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
        GetMessageW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        MsgWaitForMultipleObjectsEx, PostMessageW, PostQuitMessage, RegisterClassW,
        TranslateMessage, HWND_MESSAGE, MSG, MWMO_INPUTAVAILABLE, QS_ALLINPUT, WM_CLIPBOARDUPDATE,
        WM_CLOSE, WM_DESTROY, WNDCLASSW,
    };

    /// HTML / PNG 是注册格式，必须运行时获取 ID。
    pub(super) fn format_id(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn current_sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    /// 打开剪贴板失败的原因串：采集侧据此把「读过但读不到」与策略性跳过分开计数。
    const READ_BUSY_REASON: &str = "剪贴板被其他程序占用";

    fn open_clipboard() -> bool {
        for _ in 0..10 {
            if unsafe { OpenClipboard(null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        false
    }

    unsafe fn read_handle(handle: HGLOBAL) -> Option<Vec<u8>> {
        if handle.is_null() {
            return None;
        }
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(handle);
        let bytes = if size == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(ptr as *const u8, size).to_vec()
        };
        GlobalUnlock(handle);
        Some(bytes)
    }

    unsafe fn get_bytes_format(fmt: u32) -> Option<Vec<u8>> {
        if IsClipboardFormatAvailable(fmt) == 0 {
            return None;
        }
        read_handle(GetClipboardData(fmt) as HGLOBAL)
    }

    unsafe fn read_text() -> Option<String> {
        let bytes = get_bytes_format(CF_UNICODETEXT as u32)?;
        if bytes.is_empty() {
            return Some(String::new());
        }
        let mut units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if let Some(pos) = units.iter().position(|&c| c == 0) {
            units.truncate(pos);
        }
        Some(String::from_utf16_lossy(&units))
    }

    unsafe fn read_html() -> Option<String> {
        let fmt = format_id("HTML Format");
        if fmt == 0 {
            return None;
        }
        let bytes = get_bytes_format(fmt)?;
        if bytes.len() > MAX_HTML_BYTES {
            return None;
        }
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        Some(extract_html_fragment(&raw))
    }

    pub fn extract_html_fragment(raw: &str) -> String {
        fn offset(raw: &str, key: &str) -> Option<usize> {
            raw.lines().find_map(|l| {
                l.trim()
                    .strip_prefix(key)
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
        }
        if let (Some(s), Some(e)) = (offset(raw, "StartFragment:"), offset(raw, "EndFragment:")) {
            if s < e && e <= raw.len() && raw.is_char_boundary(s) && raw.is_char_boundary(e) {
                return raw[s..e].to_string();
            }
        }
        // 头部损坏时退化为「第一个 < 之后」；仍无法判定则不保存 HTML
        raw.find('<')
            .map(|i| raw[i..].to_string())
            .unwrap_or_default()
    }

    unsafe fn read_png(dib_alpha_unused: bool) -> Option<CapturedImage> {
        let fmt = format_id("PNG");
        if fmt == 0 {
            return None;
        }
        let bytes = get_bytes_format(fmt)?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return None;
        }
        // Windows 会从 32bpp DIB 合成 Alpha 全 0 的 PNG；只有同源 DIB 能
        // 证明「Alpha 未被使用」时才归一化为不透明，否则保留合法透明图。
        let (png, rgba, w, h) = image::normalize_clipboard_png(bytes, dib_alpha_unused).ok()?;
        Some(CapturedImage {
            png,
            width: w,
            height: h,
            rgba,
        })
    }

    /// 只读原始 PNG 字节（不解码），用于确认剪贴板仍是本进程写入的图片。
    unsafe fn read_png_bytes() -> Option<Vec<u8>> {
        let fmt = format_id("PNG");
        if fmt == 0 {
            return None;
        }
        get_bytes_format(fmt).filter(|b| !b.is_empty())
    }

    /// 只读原始 DIB 字节，用于判定 Alpha 来源；解码留到真正需要时再做。
    unsafe fn read_dib_bytes() -> Option<Vec<u8>> {
        for fmt in [CF_DIBV5 as u32, CF_DIB as u32] {
            if let Some(bytes) = get_bytes_format(fmt) {
                if !bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES {
                    return Some(bytes);
                }
            }
        }
        None
    }

    fn captured_from_dib(bytes: &[u8]) -> Option<CapturedImage> {
        let (rgba, w, h) = image::dib_to_rgba(bytes)?;
        let png = image::encode_png(&rgba, w, h).ok()?;
        Some(CapturedImage {
            png,
            width: w,
            height: h,
            rgba,
        })
    }

    pub fn parse_hdrop(bytes: &[u8]) -> Vec<String> {
        if bytes.len() < 20 {
            return Vec::new();
        }
        let offset = u32::from_le_bytes(bytes[0..4].try_into().unwrap_or([0; 4])) as usize;
        let wide = u32::from_le_bytes(bytes[16..20].try_into().unwrap_or([0; 4])) != 0;
        if offset >= bytes.len() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut current: Vec<u8> = Vec::new();
        let mut i = offset;
        while i < bytes.len() && out.len() < MAX_FILE_COUNT {
            let ch = if wide {
                if i + 1 >= bytes.len() {
                    break;
                }
                let v = u16::from_le_bytes([bytes[i], bytes[i + 1]]) as u32;
                i += 2;
                v
            } else {
                let v = bytes[i] as u32;
                i += 1;
                v
            };
            if ch == 0 {
                if current.is_empty() {
                    break;
                }
                let s = if wide {
                    let units: Vec<u16> = current
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&units)
                } else {
                    String::from_utf8_lossy(&current).into_owned()
                };
                if !s.trim().is_empty() {
                    out.push(s);
                }
                current.clear();
            } else if wide {
                current.extend_from_slice(&(ch as u16).to_le_bytes());
            } else {
                current.push(ch as u8);
            }
        }
        out
    }

    unsafe fn read_files() -> Vec<String> {
        get_bytes_format(CF_HDROP as u32)
            .map(|b| parse_hdrop(&b))
            .unwrap_or_default()
    }

    /// 操作系统/密码管理器放置的敏感标记。
    unsafe fn os_marker() -> Option<&'static str> {
        for name in [
            "ExcludeClipboardContentFromMonitorProcessing",
            "Clipboard Viewer Ignore",
        ] {
            let fmt = format_id(name);
            if fmt != 0 && IsClipboardFormatAvailable(fmt) != 0 {
                return Some("系统或应用标记：不参与剪贴板监听");
            }
        }
        let fmt = format_id("CanIncludeInClipboardHistory");
        if fmt != 0 {
            if let Some(bytes) = get_bytes_format(fmt) {
                let v = u32::from_le_bytes(bytes[0..4].try_into().unwrap_or([1, 0, 0, 0]));
                if v == 0 {
                    return Some("应用标记：不进入剪贴板历史");
                }
            }
        }
        None
    }

    /// 一个窗口能给出的来源信息：应用（exe 文件名，小写）、窗口标题。
    ///
    /// 过滤器很保守：句柄无效、PID 取不到、exe 路径取不到都算「认不出」，
    /// 返回 None 交给上层回退，绝不用空壳数据冒充来源。
    fn source_of_window(hwnd: HWND) -> Option<(String, String)> {
        unsafe {
            if hwnd.is_null() || IsWindow(hwnd) == 0 {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return None;
            }
            let exe = crate::navigation::window_manager::exe_path_of(pid).unwrap_or_default();
            let app = Path::new(&exe)
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if app.is_empty() {
                return None;
            }
            Some((app, window_title(hwnd)))
        }
    }

    /// 采集环境来源：（应用, 窗口标题, 识别方式）。
    ///
    /// 先问剪贴板所有者。`WM_CLIPBOARDUPDATE` 只说明「有人写过剪贴板」，监听线程
    /// 真正处理时前台窗口可能早已切走（截图工具写完就收起、用户随手点了浏览器）；
    /// `GetClipboardOwner()` 指向系统登记的所有者窗口，相对更接近「内容从哪来」，
    /// 但它仍只是系统记录，不保证等于实际执行复制的程序。
    /// 所有者也可能为空、已销毁、或只是个消息窗口，那就退回前台窗口，并把
    /// 「这是推断」记进 `source_kind`，不许把回退值伪装成准确来源。
    /// 前台窗口若属于本进程，说明这次外部写入发生时用户正看着 Task Dock；
    /// 把它记成 task_dock.exe 只会制造虚假来源，按 unknown 处理。
    ///
    /// 必须在剪贴板已打开、且持有进程内访问锁时调用：`OpenClipboard` 期间其他进程
    /// 无法写入，读到内容与来源窗口来自同一份剪贴板状态；锁在 `read_open` 返回前
    /// 一直持有，不存在“读完内容再猜来源”的窗口期。
    fn clipboard_source() -> (String, String, &'static str) {
        if let Some((app, title)) = source_of_window(unsafe { GetClipboardOwner() }) {
            return (app, title, super::super::SOURCE_OWNER);
        }
        let foreground = unsafe { GetForegroundWindow() };
        if !foreground.is_null() && unsafe { IsWindow(foreground) } != 0 {
            let mut pid: u32 = 0;
            unsafe { GetWindowThreadProcessId(foreground, &mut pid) };
            if pid != 0 && pid != std::process::id() {
                if let Some((app, title)) = source_of_window(foreground) {
                    return (app, title, super::super::SOURCE_FOREGROUND);
                }
            }
        }
        (
            "unknown".into(),
            String::new(),
            super::super::SOURCE_UNKNOWN,
        )
    }

    pub fn read_clipboard(ignore_markers: bool) -> ClipboardRead {
        let _access = lock_access();
        read_locked(ignore_markers)
    }

    fn read_locked(ignore_markers: bool) -> ClipboardRead {
        if !open_clipboard() {
            return ClipboardRead::Skip(READ_BUSY_REASON);
        }
        let result = unsafe { read_open(ignore_markers) };
        unsafe { close() };
        result
    }

    pub fn read_clipboard_for_event(
        ignore_markers: bool,
        event_sequence: u32,
        self_write: &AtomicU32,
    ) -> ClipboardRead {
        let _access = lock_access();
        // 自写登记与这里使用同一把锁，锁内读到的值一定是最新值；
        // 事件在登记前通过检查也不会造成写入结束后再读一次剪贴板。
        if is_own_write_sequence(event_sequence, self_write.load(Ordering::SeqCst)) {
            return ClipboardRead::Skip("本应用自身写入");
        }
        read_locked(ignore_markers)
    }

    /// 调用方必须已持有剪贴板锁；返回前不关闭。
    unsafe fn read_open(ignore_markers: bool) -> ClipboardRead {
        // 读到的内容属于「此刻」的剪贴板状态：必须在锁内取序列号，
        // 之后任何写入都会让事件序列号与内容对不上。
        let sequence = current_sequence();
        if !ignore_markers {
            if let Some(reason) = os_marker() {
                return ClipboardRead::Skip(reason);
            }
        }
        let text = read_text().unwrap_or_default();
        let html = read_html().unwrap_or_default();
        let files = read_files();
        // 先取 DIB 原始字节作为「Alpha 是否被使用」的佐证，再决定 PNG 归一化；
        // PNG 缺失或损坏时才解码 DIB 兜底。
        let dib = read_dib_bytes();
        let dib_alpha_unused = dib.as_deref().is_some_and(image::dib_alpha_is_unused);
        let image =
            read_png(dib_alpha_unused).or_else(|| dib.as_deref().and_then(captured_from_dib));

        let kind = match super::super::engine::classify(&text, &html, image.is_some(), &files) {
            Some(k) => k,
            None => return ClipboardRead::Empty("剪贴板为空或只有无法识别的格式"),
        };
        if matches!(
            kind,
            super::super::KIND_TEXT | super::super::KIND_HTML | super::super::KIND_URL
        ) && text.len() > MAX_TEXT_BYTES
        {
            return ClipboardRead::Skip("文本超过采集上限");
        }
        let (source_app, source_title, source_kind) = clipboard_source();
        let preview = super::super::engine::make_preview(
            kind,
            &text,
            &html,
            &files,
            image.as_ref().map(|i| i.width),
            image.as_ref().map(|i| i.height),
        );
        ClipboardRead::Content {
            sequence,
            content: Box::new(CapturedContent {
                kind: kind.into(),
                text,
                html,
                preview,
                file_paths: files,
                image,
                source_app,
                source_title,
                source_kind: source_kind.into(),
                byte_size: 0,
            }),
        }
    }

    unsafe fn close() {
        CloseClipboard();
    }

    pub fn snapshot() -> Snapshot {
        let _access = lock_access();
        if !open_clipboard() {
            return Snapshot {
                sequence: current_sequence(),
                payload: None,
                state: SnapshotState::Unreadable,
            };
        }
        let read = unsafe { read_open(true) };
        let (payload, state) = unsafe { snapshot_payload_state(read) };
        unsafe { close() };
        // 序列号必须在 CloseClipboard 之后读取：关闭时可能因合成格式继续递增，
        // 锁内读到的值会偏小，导致后续守卫误判“剪贴板已被其他程序更新”。
        let sequence = unsafe { GetClipboardSequenceNumber() };
        Snapshot {
            sequence,
            payload,
            state,
        }
    }

    /// 把已打开剪贴板读到的内容归类成可恢复载荷 + 快照语义。
    ///
    /// 「空」与「读不到/不支持」必须分开：前者没有可保护内容，后者只能说明
    /// 无法验证，不能在任何后续路径里被当成「用户接管」。
    unsafe fn snapshot_payload_state(
        read: ClipboardRead,
    ) -> (Option<ClipboardPayload>, SnapshotState) {
        let payload = payload_from_read(read);
        if payload.is_some() {
            return (payload, SnapshotState::Captured);
        }
        // 读不到可比较载荷：只有剪贴板上确实存在本应用认识的内容格式，
        // 才说明这是「存在但无法完整读取」而不是「确实为空」。
        let state = if has_recognizable_content_format() {
            SnapshotState::Unsupported
        } else {
            SnapshotState::Empty
        };
        (None, state)
    }

    /// 剪贴板上是否存在本应用能识别（但不一定能完整比较）的内容格式。
    unsafe fn has_recognizable_content_format() -> bool {
        if IsClipboardFormatAvailable(CF_UNICODETEXT as u32) != 0
            || IsClipboardFormatAvailable(CF_HDROP as u32) != 0
            || IsClipboardFormatAvailable(CF_DIB as u32) != 0
            || IsClipboardFormatAvailable(CF_DIBV5 as u32) != 0
        {
            return true;
        }
        let html = format_id("HTML Format");
        if html != 0 && IsClipboardFormatAvailable(html) != 0 {
            return true;
        }
        let png = format_id("PNG");
        png != 0 && IsClipboardFormatAvailable(png) != 0
    }

    /// 快照 + 不可无损恢复格式清单 + 整份快照重建判定。
    ///
    /// 格式枚举与内容读取在同一次 `OpenClipboard` 内完成：两者对应同一份剪贴板
    /// 状态，不存在「按旧格式列表判断新内容」的窗口。这里只做**只读**判断，
    /// 不尝试解析或保存未知格式；无法读出的格式一律视为「不可完整恢复」，
    /// 由调用方拒绝写入型测试。
    pub fn snapshot_probe() -> SnapshotProbe {
        let _access = lock_access();
        if !open_clipboard() {
            return SnapshotProbe {
                snapshot: None,
                unsupported_formats: Vec::new(),
                // 打不开剪贴板时连格式都枚举不到，必须 fail-closed。
                reconstruction: Err("剪贴板被其他程序占用，无法枚举格式".into()),
            };
        }
        let enumerated = unsafe { enum_formats_open() };
        let read = unsafe { read_open(true) };
        let (payload, state) = unsafe { snapshot_payload_state(read) };
        unsafe { close() };
        let sequence = unsafe { GetClipboardSequenceNumber() };
        let (unsupported_formats, reconstruction) = match enumerated {
            Ok(formats) => {
                let mut unsupported: Vec<String> = formats
                    .iter()
                    .filter(|(fmt, _)| !is_recoverable_format(*fmt))
                    .map(|(_, name)| name.clone())
                    .collect();
                if unsupported.len() > 32 {
                    unsupported.truncate(32);
                    unsupported.push("（其余格式省略）".into());
                }
                let reconstruction = match payload.as_ref() {
                    Some(payload) => snapshot_reconstruction(&formats, payload),
                    // 空/不可读快照由调用方按 `SnapshotState` 给出更精确的拒绝原因。
                    None => Ok(()),
                };
                (unsupported, reconstruction)
            }
            Err(reason) => (Vec::new(), Err(reason)),
        };
        SnapshotProbe {
            snapshot: Some(Snapshot {
                sequence,
                payload,
                state,
            }),
            unsupported_formats,
            reconstruction,
        }
    }

    /// 调用方必须已持有剪贴板锁；枚举格式，并区分「正常结束」与枚举失败。
    ///
    /// `EnumClipboardFormats` 返回 0 既可能是「没有更多格式」，也可能是 API 失败；
    /// 文档要求用 `GetLastError` 区分。因此每次调用前清零错误码，返回 0 时只有
    /// 错误码为 0 才算正常结束。枚举中途失败时不能用已枚举到的部分判断完整性——
    /// 那样可能漏掉后面的不支持格式，整体判为「无法确认」，由调用方 fail-closed。
    unsafe fn enum_formats_open() -> Result<Vec<(u32, String)>, String> {
        let mut out: Vec<(u32, String)> = Vec::new();
        let mut fmt = 0u32;
        loop {
            SetLastError(0);
            fmt = EnumClipboardFormats(fmt);
            if fmt == 0 {
                let err = GetLastError();
                if err != 0 {
                    return Err(format!(
                        "枚举剪贴板格式失败（错误码 {err}），无法确认可完整恢复"
                    ));
                }
                break;
            }
            out.push((fmt, describe_format(fmt)));
        }
        Ok(out)
    }

    /// 剪贴板格式承载的「内容表示」类别。
    ///
    /// 只看格式 ID/名称，不读取格式内容。用于区分「Windows 自动合成的表示」
    /// 与「独立存储的数据格式」：同一族的格式可由同一份载荷重建，不同族则
    /// 会在单一载荷恢复时互相覆盖。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum FormatClass {
        /// 文本正文（CF_TEXT / CF_OEMTEXT 与 CF_UNICODETEXT 由 Windows 互转）。
        Text,
        /// HTML 片段（独立格式，必须显式写回）。
        Html,
        /// 图片（PNG / CF_DIB / CF_DIBV5 / CF_BITMAP 是同一图像的不同表示）。
        Image,
        /// 文件路径列表。
        Files,
        /// 不承载独立内容：语言标记、调色板等，由 Windows 随内容重建。
        Companion,
        /// 本工具无法重建的格式。
        Unsupported,
    }

    pub(super) fn classify_format(fmt: u32) -> FormatClass {
        match fmt {
            // CF_TEXT=1 / CF_OEMTEXT=7 与 CF_UNICODETEXT 是同一文本的系统转换形式。
            f if f == 1 || f == 7 || f == CF_UNICODETEXT as u32 => FormatClass::Text,
            // CF_BITMAP=2 / CF_DIB / CF_DIBV5 是同一图像的不同表示。
            f if f == 2 || f == CF_DIB as u32 || f == CF_DIBV5 as u32 => FormatClass::Image,
            // CF_PALETTE=9 只描述 CF_BITMAP 的调色板；CF_LOCALE=16 只标记语言。
            9 | 16 => FormatClass::Companion,
            f if f == CF_HDROP as u32 => FormatClass::Files,
            _ => match unsafe { clipboard_format_name(fmt) }.as_deref() {
                Some("HTML Format") => FormatClass::Html,
                Some("PNG") => FormatClass::Image,
                _ => FormatClass::Unsupported,
            },
        }
    }

    /// 本工具能**显式写回**或由 Windows 从这些格式**自动合成**的剪贴板格式。
    ///
    /// 显式写回：CF_UNICODETEXT、CF_DIB、CF_HDROP、HTML Format、PNG；
    /// 系统合成：CF_TEXT / CF_OEMTEXT / CF_BITMAP / CF_PALETTE / CF_DIBV5；
    /// 随文本出现的元数据：CF_LOCALE（只标记语言，不承载正文内容）。
    /// 注意 `EnumClipboardFormats` 会把系统可合成的格式一起枚举
    /// （例如只有 CF_DIB 时也会出现 CF_DIBV5），因此「枚举到 DIBV5」不能证明
    /// 剪贴板上有额外的私有数据，不能据此拒绝。
    ///
    /// 其余格式（RTF、Office 私有格式、第三方自定义格式、元文件、TIFF/RIFF/WAVE、
    /// 延迟渲染的自定义格式）不在 `ClipboardPayload` 的重建能力内：写回后会永久
    /// 丢失，必须视为不可完整恢复。宁可拒绝启动，也不做「看起来恢复了、实际少了
    /// 格式」的假成功。
    pub(super) fn is_recoverable_format(fmt: u32) -> bool {
        classify_format(fmt) != FormatClass::Unsupported
    }

    /// 判断「读取到的载荷能否重建整份剪贴板」。
    ///
    /// 白名单只能说明每个格式**单独**受支持；多个**独立内容表示**同时存在时，
    /// `ClipboardPayload` 只能保留一种（`classify()` 优先级：文件 > 图片 >
    /// HTML > 文本），恢复时其余表示会永久丢失。因此这里按内容族检查：
    /// - 文本族与 HTML 由同一个 `Text` 载荷重建（要求纯文本非空、HTML 可写回）；
    /// - PNG / DIB / DIBV5 / BITMAP / PALETTE 是同一图片的常见表示，由 `Image` 载荷重建；
    /// - 文件列表只能由 `Files` 载荷重建，且路径必须仍然有效；
    /// - 文本 / HTML / 图片 / 文件分属不同族时，当前载荷无法同时保留，保守拒绝；
    /// - 枚举失败、格式为空、载荷过不了写入层约束，同样拒绝。
    ///
    /// 无法可靠区分时一律拒绝：写入型真机测试宁可不动剪贴板，也不能做
    /// 「看起来恢复了、实际少了内容」的假成功。
    pub(super) fn snapshot_reconstruction(
        formats: &[(u32, String)],
        payload: &ClipboardPayload,
    ) -> Result<(), String> {
        if formats.is_empty() {
            return Err("未能枚举到任何剪贴板格式，无法确认可完整恢复".into());
        }
        let mut text: Vec<&str> = Vec::new();
        let mut html: Vec<&str> = Vec::new();
        let mut image: Vec<&str> = Vec::new();
        let mut files: Vec<&str> = Vec::new();
        let mut unsupported: Vec<&str> = Vec::new();
        for (fmt, name) in formats {
            match classify_format(*fmt) {
                FormatClass::Text => text.push(name.as_str()),
                FormatClass::Html => html.push(name.as_str()),
                FormatClass::Image => image.push(name.as_str()),
                FormatClass::Files => files.push(name.as_str()),
                FormatClass::Companion => {}
                FormatClass::Unsupported => unsupported.push(name.as_str()),
            }
        }
        if !unsupported.is_empty() {
            return Err(format!(
                "剪贴板包含无法重建的格式：{}，写回后会永久丢失",
                unsupported.join("、")
            ));
        }
        let joined = |list: &[&str]| list.join("、");
        match payload {
            ClipboardPayload::Text {
                text: body,
                html: payload_html,
            } => {
                if !image.is_empty() {
                    return Err(format!(
                        "剪贴板同时含文本与图片（{}、{}）：单一载荷只能保留图片，文本会在恢复时丢失",
                        joined(&text),
                        joined(&image)
                    ));
                }
                if !files.is_empty() {
                    return Err(format!(
                        "剪贴板同时含文本与文件路径（{}、{}）：单一载荷只能保留文件，文本会在恢复时丢失",
                        joined(&text),
                        joined(&files)
                    ));
                }
                if body.is_empty() {
                    return Err(format!(
                        "剪贴板只有 HTML（{}）而没有纯文本：现有写入机制要求非空纯文本，无法无损写回 HTML",
                        joined(&html)
                    ));
                }
                if !html.is_empty() && payload_html.is_none() {
                    return Err(format!(
                        "剪贴板含 HTML（{}），但未读出可写回的 HTML 片段，恢复会丢失 HTML",
                        joined(&html)
                    ));
                }
                if html.is_empty() && payload_html.is_some() {
                    return Err(
                        "读取到 HTML 载荷但剪贴板上没有 HTML Format，恢复会丢失 HTML".into(),
                    );
                }
                if payload_html.is_some() && format_id("HTML Format") == 0 {
                    return Err("HTML Format 无法注册，恢复会丢失 HTML".into());
                }
            }
            ClipboardPayload::Image { .. } => {
                if !text.is_empty() {
                    return Err(format!(
                        "剪贴板同时含图片与独立文本（{}、{}）：单一载荷只能保留图片，文本会在恢复时丢失",
                        joined(&image),
                        joined(&text)
                    ));
                }
                if !html.is_empty() {
                    return Err(format!(
                        "剪贴板同时含图片与独立 HTML（{}、{}）：单一载荷只能保留图片，HTML 会在恢复时丢失",
                        joined(&image),
                        joined(&html)
                    ));
                }
                if !files.is_empty() {
                    return Err(format!(
                        "剪贴板同时含图片与文件路径（{}、{}）：单一载荷只能保留图片，文件会在恢复时丢失",
                        joined(&image),
                        joined(&files)
                    ));
                }
            }
            ClipboardPayload::Files { paths } => {
                if !text.is_empty() || !html.is_empty() || !image.is_empty() {
                    return Err(format!(
                        "剪贴板同时含文件路径与文本/HTML/图片（{}）：单一载荷只能保留文件，其余内容会在恢复时丢失",
                        joined(&files)
                    ));
                }
                if valid_file_paths(paths).is_empty() {
                    return Err(format!(
                        "剪贴板里的 {} 个文件路径已失效，恢复写入必然失败",
                        paths.len()
                    ));
                }
            }
        }
        // 放行前再验证载荷能经现有写入机制重建（与 `write_formats_with` 共用判据）。
        if !payload_writable(payload) {
            return Err("读取到的载荷无法经现有写入机制重建，恢复必然失败".into());
        }
        Ok(())
    }

    /// 仅供诊断/拒绝信息使用：预定义格式没有可查询名称，按常量名输出。
    pub(super) fn describe_format(fmt: u32) -> String {
        let known = match fmt {
            3 => Some("CF_METAFILEPICT"),
            4 => Some("CF_SYLK"),
            5 => Some("CF_DIF"),
            6 => Some("CF_TIFF"),
            10 => Some("CF_PENDATA"),
            11 => Some("CF_RIFF"),
            12 => Some("CF_WAVE"),
            14 => Some("CF_ENHMETAFILE"),
            17 => Some("CF_DIBV5"),
            _ => None,
        };
        if let Some(name) = known {
            return name.to_string();
        }
        unsafe { clipboard_format_name(fmt) }
            .map(|n| format!("\"{n}\""))
            .unwrap_or_else(|| format!("CF#{fmt}"))
    }

    unsafe fn clipboard_format_name(fmt: u32) -> Option<String> {
        let mut buf = [0u16; 256];
        let n = GetClipboardFormatNameW(fmt, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..n as usize]))
    }

    /// 已打开的剪贴板读到的内容 → 可回写的载荷；无法完整比较的形态返回 None。
    ///
    /// `snapshot` 与「EmptyClipboard 之后的失败回滚」共用这份映射，
    /// 避免两条路径对「什么算可恢复」给出不同答案。
    pub(super) fn payload_from_read(read: ClipboardRead) -> Option<ClipboardPayload> {
        let c = match read {
            ClipboardRead::Content { content, .. } => content,
            _ => return None,
        };
        match c.kind.as_str() {
            super::super::KIND_IMAGE => c.image.map(|i| ClipboardPayload::Image {
                png: i.png,
                rgba: Some(i.rgba),
                width: i.width,
                height: i.height,
            }),
            super::super::KIND_FILES if !c.file_paths.is_empty() => Some(ClipboardPayload::Files {
                paths: c.file_paths,
            }),
            super::super::KIND_FILES => None,
            _ if !c.text.is_empty() || !c.html.is_empty() => Some(ClipboardPayload::Text {
                text: c.text,
                html: if c.html.is_empty() {
                    None
                } else {
                    Some(c.html)
                },
            }),
            _ => None,
        }
    }

    /// 写入前的兜底内容。只保留原始格式字节：恢复失败的写入不需要 RGBA、
    /// 预览或来源信息，现场解码 4K 图（约 33MB RGBA）纯属浪费。
    enum Preserved<'a> {
        Payload(&'a ClipboardPayload),
        Raw(FallbackFormats),
    }

    pub(super) struct FallbackFormats {
        pub(super) text: Option<String>,
        pub(super) html: Option<String>,
        pub(super) png: Option<Vec<u8>>,
        pub(super) dib: Option<Vec<u8>>,
        pub(super) files: Vec<String>,
    }

    impl FallbackFormats {
        pub(super) fn is_empty(&self) -> bool {
            self.text.as_deref().is_none_or(str::is_empty)
                && self.html.as_deref().is_none_or(str::is_empty)
                && self.png.is_none()
                && self.dib.is_none()
                && self.files.is_empty()
        }

        /// 调用方必须已持有剪贴板锁且已清空剪贴板；返回是否至少写回一种格式。
        unsafe fn restore(&self) -> bool {
            self.restore_with(|fmt, bytes| set_bytes(fmt, bytes))
        }

        pub(super) fn restore_with<F>(&self, mut set: F) -> bool
        where
            F: FnMut(u32, &[u8]) -> bool,
        {
            let mut wrote = false;
            if let Some(text) = self.text.as_deref().filter(|t| !t.is_empty()) {
                wrote |= set(CF_UNICODETEXT as u32, &text_utf16_bytes(text));
            }
            if let Some(html) = self.html.as_deref().filter(|h| !h.is_empty()) {
                let fmt = format_id("HTML Format");
                if fmt != 0 {
                    wrote |= set(fmt, engine::cf_html(html).as_bytes());
                }
            }
            if let Some(png) = self.png.as_deref() {
                let fmt = format_id("PNG");
                if fmt != 0 {
                    wrote |= set(fmt, png);
                }
            }
            if let Some(dib) = self.dib.as_deref() {
                wrote |= set(CF_DIB as u32, dib);
            }
            if !self.files.is_empty() {
                let valid: Vec<String> = self
                    .files
                    .iter()
                    .filter(|p| Path::new(p).exists())
                    .cloned()
                    .collect();
                if !valid.is_empty() {
                    wrote |= set(CF_HDROP as u32, &hdrop_bytes(&valid));
                }
            }
            wrote
        }
    }

    /// 调用方必须已持有剪贴板锁；只抓原始格式，不做解码/分类/预览。
    /// 超过采集上限的内容与旧路径保持一致：不可恢复（宁可留空也不写残缺内容）。
    unsafe fn capture_fallback() -> Option<FallbackFormats> {
        let raw = FallbackFormats {
            text: read_text().filter(|t| t.len() <= MAX_TEXT_BYTES),
            html: read_html(),
            png: read_png_bytes().filter(|b| b.len() <= MAX_IMAGE_BYTES),
            dib: read_dib_bytes(),
            files: read_files(),
        };
        if raw.is_empty() {
            None
        } else {
            Some(raw)
        }
    }

    unsafe fn set_bytes(fmt: u32, bytes: &[u8]) -> bool {
        let size = bytes.len().max(1);
        let handle = GlobalAlloc(GMEM_MOVEABLE, size);
        if handle.is_null() {
            return false;
        }
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            windows_sys::Win32::Foundation::GlobalFree(handle);
            return false;
        }
        if !bytes.is_empty() {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        }
        GlobalUnlock(handle);
        if SetClipboardData(fmt, handle).is_null() {
            windows_sys::Win32::Foundation::GlobalFree(handle);
            return false;
        }
        true
    }

    fn text_utf16_bytes(text: &str) -> Vec<u8> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let mut bytes = Vec::with_capacity(units.len() * 2);
        for u in units {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        bytes
    }

    fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
        let mut wide = Vec::<u16>::new();
        for p in paths {
            wide.extend(p.encode_utf16());
            wide.push(0);
        }
        wide.push(0);
        let mut out = vec![0u8; 20];
        out[0..4].copy_from_slice(&20u32.to_le_bytes());
        out[16..20].copy_from_slice(&1u32.to_le_bytes()); // fWide
        for u in wide {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }

    /// 进程级剪贴板访问锁：本进程所有 `OpenClipboard`→读写→`CloseClipboard`
    /// 序列（采集读取、快照、内容比较、写入、恢复）都必须持有它。
    ///
    /// 真机证据：同一进程的两个线程各自打开/关闭剪贴板会互相打断
    /// `GetClipboardData`（对方 Close 后句柄失效）。不串行化时，粘贴线程
    /// 刚写完就可能在验证读取中读到 None，被误判为“用户接管”。
    /// 该锁只覆盖剪贴板打开窗口，绝不跨等待目标应用或发送按键持有。
    static ACCESS_LOCK: Mutex<()> = Mutex::new(());

    fn lock_access() -> std::sync::MutexGuard<'static, ()> {
        ACCESS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 调用方必须已持有剪贴板锁；成功时返回写入后的序列号（仍在锁内读取）。
    unsafe fn write_open(payload: &ClipboardPayload) -> AppResult<u32> {
        if EmptyClipboard() == 0 {
            // 清空失败时不再写格式：否则会往未知的旧剪贴板里叠加内容。
            return Err(AppError::Validation("写入剪贴板失败".into()));
        }
        write_formats(payload)?;
        Ok(GetClipboardSequenceNumber())
    }

    /// 调用方必须已持有剪贴板锁；已清空剪贴板；只写格式，不清空。
    unsafe fn write_formats(payload: &ClipboardPayload) -> AppResult<FormatWrite> {
        write_formats_with(payload, |fmt, data| unsafe { set_bytes(fmt, data) })
    }

    /// 每条内容只有一个必需格式，其余为辅助格式：
    /// - 必需格式失败 → 整体失败，调用方负责把清空前的内容放回去；
    /// - 辅助格式失败 → 记为降级，实际形态里剔除该字段，
    ///   后续比对以实际形态为准。
    ///
    /// 之所以必须区分必需与辅助：必需格式缺失时剪贴板里根本没有这份内容，
    /// 报成功等于骗用户；辅助格式缺失只影响部分应用，剪贴板里仍有可用内容，
    /// 应当如实降级而不是中止整轮粘贴。
    ///
    /// 下面的 `*_payload_writable` 就是这里「必需格式」的判据：快照重建探测与
    /// 真实写入共用同一组函数，避免探测放行、写入才失败的规则漂移
    /// （HTML-only 就是典型：读取侧有载荷，写入侧直接报错）。
    pub(super) fn text_payload_writable(text: &str) -> bool {
        !text.is_empty()
    }

    /// 图片载荷能否写入：`PNG` 是必需格式（DIB 只是辅助格式）。
    pub(super) fn image_payload_writable(png: &[u8]) -> bool {
        format_id("PNG") != 0 && !png.is_empty()
    }

    /// 文件载荷的必需路径，条件与 `write_formats_with` 完全一致。
    pub(super) fn valid_file_paths(paths: &[String]) -> Vec<String> {
        paths
            .iter()
            .filter(|p| {
                let path = Path::new(p);
                path.is_absolute() && path.exists()
            })
            .take(MAX_FILE_COUNT)
            .cloned()
            .collect()
    }

    /// 载荷能否经现有写入机制重建（只读判断，不触碰剪贴板）。
    pub(super) fn payload_writable(payload: &ClipboardPayload) -> bool {
        match payload {
            ClipboardPayload::Text { text, .. } => text_payload_writable(text),
            ClipboardPayload::Image { png, .. } => image_payload_writable(png),
            ClipboardPayload::Files { paths } => !valid_file_paths(paths).is_empty(),
        }
    }

    /// 每种内容有且只有一个必需格式，其余为辅助格式：
    /// - 必需格式失败 → 整体失败，调用方负责把清空前的内容放回去；
    /// - 辅助格式失败 → 记为降级，实际形态里剔除该字段，
    ///   后续比对以实际形态为准。
    ///
    /// 之所以必须区分必需与辅助：必需格式缺失时剪贴板里根本没有这份内容，
    /// 报成功等于骗用户；辅助格式缺失只影响部分应用，剪贴板里仍有可用内容，
    /// 应当如实降级而不是中止整轮粘贴。
    pub(super) fn write_formats_with<F>(
        payload: &ClipboardPayload,
        mut set: F,
    ) -> AppResult<FormatWrite>
    where
        F: FnMut(u32, &[u8]) -> bool,
    {
        match payload {
            ClipboardPayload::Text { text, html } => {
                if !text_payload_writable(text) {
                    return Err(AppError::Validation("写入剪贴板失败".into()));
                }
                if !set(CF_UNICODETEXT as u32, &text_utf16_bytes(text)) {
                    return Err(AppError::Validation("写入剪贴板失败".into()));
                }
                let mut degraded = Vec::new();
                let html_ok = match html {
                    Some(html) => {
                        let fmt = format_id("HTML Format");
                        if fmt == 0 {
                            false
                        } else {
                            set(fmt, engine::cf_html(html).as_bytes())
                        }
                    }
                    None => true,
                };
                if !html_ok {
                    degraded.push("HTML".to_string());
                }
                Ok(FormatWrite {
                    effective: ClipboardPayload::Text {
                        text: text.clone(),
                        html: if html_ok { html.clone() } else { None },
                    },
                    degraded,
                })
            }
            ClipboardPayload::Image {
                png,
                rgba,
                width,
                height,
            } => {
                let fmt = format_id("PNG");
                if !image_payload_writable(png) || !set(fmt, png) {
                    return Err(AppError::Validation("写入剪贴板失败".into()));
                }
                let dib = match rgba {
                    Some(rgba) if rgba.len() >= (*width as usize * *height as usize * 4) => {
                        Some(image::rgba_to_dib(rgba, *width, *height))
                    }
                    _ => image::decode_png_rgba(png)
                        .ok()
                        .map(|(r, w, h)| image::rgba_to_dib(&r, w, h)),
                };
                let mut degraded = Vec::new();
                let mut dib_ok = false;
                if let Some(dib) = dib {
                    dib_ok = set(CF_DIB as u32, &dib);
                }
                if !dib_ok {
                    degraded.push("DIB".to_string());
                }
                Ok(FormatWrite {
                    effective: ClipboardPayload::Image {
                        png: png.clone(),
                        rgba: rgba.clone(),
                        width: *width,
                        height: *height,
                    },
                    degraded,
                })
            }
            ClipboardPayload::Files { paths } => {
                let valid = valid_file_paths(paths);
                if valid.is_empty() {
                    return Err(AppError::Validation("写入剪贴板失败".into()));
                }
                if !set(CF_HDROP as u32, &hdrop_bytes(&valid)) {
                    return Err(AppError::Validation("写入剪贴板失败".into()));
                }
                // 纯文本路径是辅助格式，失败不影响文件粘贴
                let mut degraded = Vec::new();
                if !set(
                    CF_UNICODETEXT as u32,
                    &text_utf16_bytes(&valid.join("\r\n")),
                ) {
                    degraded.push("纯文本".to_string());
                }
                Ok(FormatWrite {
                    effective: ClipboardPayload::Files { paths: valid },
                    degraded,
                })
            }
        }
    }

    /// 调用方必须已持有剪贴板锁；读取全部可比较格式并判断内容是否一致。
    ///
    /// 图片必须与快照走同一条语义：PNG 容器缺失时（剪贴板只有 CF_DIB/CF_DIBV5）
    /// 回退到 DIB 像素；两者都读不出可靠内容时返回 `None`（无法验证），
    /// 既不冒充 Same，也不谎报 Different。
    unsafe fn content_matches_open(expected: &ClipboardPayload) -> Option<bool> {
        let text = read_text();
        let html = read_html();
        let files = read_files();
        let png = read_png_bytes();
        // 只有图片载荷、且 PNG 容器字节不等于期望值时，才需要额外读取 DIB：
        // 自写后比对通常 PNG 字节完全一致（Windows/延迟格式只影响序列号），
        // 不必每次比较都复制一份几十 MB 的 32bpp DIB。
        let dib = match expected {
            ClipboardPayload::Image {
                png: expected_png, ..
            } if png.as_deref() != Some(expected_png.as_slice()) => read_dib_bytes(),
            _ => None,
        };
        let same = payload_matches_read(
            expected,
            text.as_deref(),
            html.as_deref(),
            png.as_deref(),
            dib.as_deref(),
            &files,
        );
        if same != Some(true) {
            // 只记录格式与字节数，绝不记录正文/路径/图片内容。
            tracing::debug!(
                "剪贴板内容不一致（{}）：{}",
                match same {
                    Some(_) => "已确认不同",
                    None => "无法验证",
                },
                payload_mismatch_detail(
                    expected,
                    text.as_deref(),
                    html.as_deref(),
                    png.as_deref(),
                    dib.as_deref(),
                    &files
                )
            );
        }
        same
    }

    pub fn write_guarded(
        payload: &ClipboardPayload,
        guard: WriteGuard<'_>,
    ) -> AppResult<WriteOutcome> {
        write_guarded_inner(payload, guard, None)
    }

    pub fn write_guarded_notifying(
        payload: &ClipboardPayload,
        guard: WriteGuard<'_>,
        self_write: &AtomicU32,
    ) -> AppResult<WriteOutcome> {
        write_guarded_inner(payload, guard, Some(self_write))
    }

    fn write_guarded_inner(
        payload: &ClipboardPayload,
        guard: WriteGuard<'_>,
        notify: Option<&AtomicU32>,
    ) -> AppResult<WriteOutcome> {
        let _access = lock_access();
        if !open_clipboard() {
            return Err(AppError::Validation(
                "剪贴板被其他程序占用，请稍后重试".into(),
            ));
        }
        // 守卫判定与 EmptyClipboard/写入全程持有剪贴板锁：
        // 其他进程无法在这两步之间插入，内容一致即可安全覆盖。
        let mut content_verdict: Option<Option<bool>> = None;
        let allowed = unsafe {
            let sequence = GetClipboardSequenceNumber();
            match &guard {
                WriteGuard::Content(expected) => {
                    let verdict = content_matches_open(expected);
                    content_verdict = Some(verdict);
                    verdict == Some(true)
                }
                _ => guard_allows(&guard, sequence, false),
            }
        };
        if !allowed {
            unsafe { CloseClipboard() };
            // Content 守卫「无法验证」时不能返回 SequenceChanged：那会让上层
            // 误报成「用户/其他程序接管」，实际只是当前图片格式读不出可靠内容。
            if content_verdict == Some(None) {
                return Ok(WriteOutcome::Unverifiable);
            }
            return Ok(WriteOutcome::SequenceChanged);
        }
        // EmptyClipboard 是不可逆动作：一旦清空成功、后续主格式写入失败，用户
        // 原来的剪贴板就直接丢了。所以清空前先准备好「万一失败要放回什么」——
        // Content 守卫自带这份内容；序列号守卫与无条件覆盖在锁内现场抓取原始
        // 格式即可，不需要为了「可能用不到」的恢复去解码图片、生成预览。
        let preserve = match &guard {
            WriteGuard::Content(expected) => Some(Preserved::Payload(*expected)),
            _ => unsafe { capture_fallback() }.map(Preserved::Raw),
        };
        let emptied = unsafe { EmptyClipboard() != 0 };
        let written = if emptied {
            unsafe { write_formats(payload) }
        } else {
            Err(AppError::Validation("写入剪贴板失败".into()))
        };
        if written.is_err() && emptied {
            // 写入失败已经发生在清空之后：尽力回写清空前的内容并如实记录。
            match &preserve {
                Some(Preserved::Payload(expected)) => {
                    let recovered =
                        unsafe { EmptyClipboard() != 0 && write_formats(expected).is_ok() };
                    if recovered {
                        // 回写的是清空前的内容，不是本次要写入的内容，因此**不得**
                        // 登记自写水位：否则会把用户此前复制、尚未采集的外部内容
                        // 当成“本进程写入”丢弃。失败的命令不应声称拥有剪贴板。
                        tracing::warn!("剪贴板写入失败，已恢复写入前内容");
                    } else {
                        tracing::warn!("剪贴板写入失败，且未能恢复写入前内容");
                    }
                }
                Some(Preserved::Raw(raw)) => {
                    if unsafe { raw.restore() } {
                        tracing::warn!("剪贴板写入失败，已按原始格式恢复写入前内容");
                    } else {
                        tracing::warn!("剪贴板写入失败，且未能恢复写入前内容");
                    }
                }
                None => {
                    // 清空前的内容不可比较（非文本/图片/文件形态或读取失败）：
                    // 没有可靠的重建依据，宁可留空也不猜写一份残缺内容。
                    tracing::warn!("剪贴板写入失败，且写入前内容无法比较，未能恢复用户剪贴板");
                }
            }
        }
        unsafe { CloseClipboard() };
        match written {
            // Windows 可能在 CloseClipboard 之后继续为合成/延迟渲染格式递增序列号，
            // 锁内读到的值不是最终值。必须返回关闭后的序列号，调用方仍需内容比较兜底。
            Ok(report) => {
                let final_seq = unsafe { GetClipboardSequenceNumber() };
                if let Some(sw) = notify {
                    // 仍在访问锁内：采集线程的锁内复核必然读到该值，
                    // 不会再为本次写入打开剪贴板。
                    note_self_write_watermark(sw, final_seq);
                }
                Ok(WriteOutcome::Written {
                    seq: final_seq,
                    effective: report.effective,
                    degraded: report.degraded,
                })
            }
            Err(e) => Err(e),
        }
    }

    pub fn restore_if_own_content(
        snapshot_payload: &ClipboardPayload,
        last_written: &ClipboardPayload,
        self_write: &AtomicU32,
    ) -> AppResult<RestoreOutcome> {
        let _access = lock_access();
        if !open_clipboard() {
            return Err(AppError::Validation(
                "剪贴板被其他程序占用，未能恢复原内容".into(),
            ));
        }
        // 只有内容仍是本进程最后一次写入时才恢复；序列号增长不作为恢复依据。
        // 「无法验证」同样不恢复：宁可保留用户可能已复制的新内容，也不覆盖。
        let matches = unsafe { content_matches_open(last_written) };
        if matches != Some(true) {
            unsafe { CloseClipboard() };
            return Ok(RestoreOutcome::KeepUserCopy);
        }
        let restored = unsafe { write_open(snapshot_payload) };
        let restored = match restored {
            Ok(seq) => Ok(seq),
            Err(e) => {
                // 快照写入失败时尽量把本次写入内容放回，避免「恢复」反而清空剪贴板。
                let recovered =
                    unsafe { EmptyClipboard() != 0 && write_formats(last_written).is_ok() };
                if recovered {
                    let seq = unsafe { GetClipboardSequenceNumber() };
                    note_self_write_watermark(self_write, seq);
                    tracing::warn!("恢复原剪贴板失败，已回退为本次写入内容");
                } else {
                    tracing::warn!("恢复原剪贴板失败，且未能保留本次写入内容");
                }
                Err(e)
            }
        };
        unsafe { CloseClipboard() };
        // 不读 final_seq、也不登记水位：恢复写回的是用户内容，登记会把它的
        // 通知判成自写而跳过（见 finish_restore 的说明）。
        finish_restore(restored.map(|_| ()))
    }

    pub fn clipboard_match(expected: &ClipboardPayload) -> ClipboardMatch {
        let _access = lock_access();
        if !open_clipboard() {
            tracing::debug!("剪贴板比较：无法打开剪贴板（可能被其他程序占用）");
            return ClipboardMatch::Unavailable;
        }
        let same = unsafe { content_matches_open(expected) };
        unsafe { close() };
        match same {
            Some(true) => ClipboardMatch::Same,
            Some(false) => ClipboardMatch::Different,
            // 读取不到可靠内容（例如只有损坏的图片格式）：如实返回无法确认，
            // 既不是 Same 也不是 Different。
            None => ClipboardMatch::Unavailable,
        }
    }

    pub fn send_ctrl_v() -> AppResult<()> {
        let key = |vk: u16, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [
            key(VK_CONTROL, false),
            key(VK_V, false),
            key(VK_V, true),
            key(VK_CONTROL, true),
        ];
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent != inputs.len() as u32 {
            return Err(AppError::Validation(
                "模拟按键被系统拦截（目标可能以管理员权限运行）".into(),
            ));
        }
        Ok(())
    }

    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    pub fn window_pid(hwnd: isize) -> Option<u32> {
        if hwnd == 0 {
            return None;
        }
        unsafe {
            if IsWindow(hwnd as HWND) == 0 {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd as HWND, &mut pid);
            if pid == 0 {
                None
            } else {
                Some(pid)
            }
        }
    }

    pub fn window_target(hwnd: isize) -> Option<TargetWindow> {
        let pid = window_pid(hwnd)?;
        let title = window_title(hwnd as HWND);
        let exe_path = crate::navigation::window_manager::exe_path_of(pid)?;
        if title.trim().is_empty() {
            return None;
        }
        Some(TargetWindow {
            hwnd,
            pid,
            title,
            exe_path,
        })
    }

    pub fn foreground_target() -> Option<TargetWindow> {
        unsafe { window_target(GetForegroundWindow() as isize) }
    }

    pub fn is_foreground(hwnd: isize) -> bool {
        hwnd != 0 && unsafe { GetForegroundWindow() as isize == hwnd }
    }

    fn process_elevated_handle(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut token: HANDLE = null_mut();
            let ok = OpenProcessToken(handle, TOKEN_QUERY, &mut token);
            CloseHandle(handle);
            if ok == 0 || token.is_null() {
                return false;
            }
            let mut elevation: TOKEN_ELEVATION = zeroed();
            let mut len: u32 = 0;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }

    pub fn process_elevated(pid: u32) -> bool {
        process_elevated_handle(pid)
    }

    pub fn current_elevated() -> bool {
        unsafe { process_elevated_handle(GetCurrentProcessId()) }
    }

    // ── 消息专用窗口监听 ────────────────────────────────────

    #[derive(Clone)]
    struct RawEvent {
        sequence: u32,
        /// 事件产生时的历史清空代数：清空之前的事件不得在清空之后入库。
        epoch: u64,
        seen: Instant,
        /// 剪贴板被其他程序短暂独占导致读取失败后的重排次数（有界，防热循环）。
        retries: u32,
    }

    struct EventHub {
        queue: Arc<BoundedQueue<RawEvent>>,
        epoch: Arc<AtomicU64>,
    }

    static EVENT_QUEUE: Mutex<Option<EventHub>> = Mutex::new(None);

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CLIPBOARDUPDATE => {
                // 消息线程只做一件事：记录序列号与当前清空代数并放入有界队列。
                // 图片解码、PNG 编码、SQLite 写入都在后台线程完成。
                let seq = GetClipboardSequenceNumber();
                if let Ok(guard) = EVENT_QUEUE.lock() {
                    if let Some(hub) = guard.as_ref() {
                        let epoch = hub.epoch.load(Ordering::SeqCst);
                        MONITOR_COUNTERS
                            .observed_events
                            .fetch_add(1, Ordering::Relaxed);
                        let (outcome, dropped) = hub.queue.push_counting(
                            RawEvent {
                                sequence: seq,
                                epoch,
                                seen: Instant::now(),
                                retries: 0,
                            },
                            1,
                        );
                        match outcome {
                            PushOutcome::Pushed => MonitorCounters::bump_peak(
                                &MONITOR_COUNTERS.peak_event_queue,
                                hub.queue.len(),
                            ),
                            PushOutcome::DroppedOldest => {
                                MONITOR_COUNTERS
                                    .dropped_events
                                    .fetch_add(dropped as u64, Ordering::Relaxed);
                                MonitorCounters::bump_peak(
                                    &MONITOR_COUNTERS.peak_event_queue,
                                    hub.queue.len(),
                                );
                            }
                            _ => {}
                        }
                    }
                } else {
                    // 监听实例尚未就绪（应用启动 / 看门狗重启间隙）：事件无法路由，
                    // 如实计数供诊断。这段窗口内用户复制的内容无法补偿——监听线程
                    // 死亡到重启之间没有事件会产生，此处计数是「盲区丢失」的唯一证据。
                    MONITOR_COUNTERS
                        .unobserved_events
                        .fetch_add(1, Ordering::Relaxed);
                }
                0
            }
            WM_CLOSE => {
                RemoveClipboardFormatListener(hwnd);
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub struct ClipboardMonitor {
        hwnd: isize,
        event_q: Arc<BoundedQueue<RawEvent>>,
        content_q: Arc<BoundedQueue<QueuedCapture>>,
        /// 监听线程的取消事件（manual-reset）：启动超时时置位，线程从可等待的
        /// 消息循环退出并自行摘掉监听，避免 JoinHandle 被丢弃后线程继续挂着。
        /// 存 isize 而不是 HANDLE，保持 ClipboardMonitor 可 Send。
        cancel: isize,
        thread: Option<std::thread::JoinHandle<()>>,
        capture: Option<std::thread::JoinHandle<()>>,
        worker: Option<std::thread::JoinHandle<()>>,
        /// `stop()` 已完整收尾；Drop 据此避免重复 CloseHandle（双重关闭）。
        stopped: bool,
        /// `begin_stop()` 已摘除全局事件槽：后续 finish/Drop 不能再次 reset_queue，
        /// 否则会误摘「暂停后立刻恢复」创建的新实例槽位。
        begun: bool,
    }

    impl ClipboardMonitor {
        pub fn start(sink: Arc<CaptureSink>) -> AppResult<Self> {
            let event_q = Arc::new(BoundedQueue::new(EVENT_QUEUE_CAPACITY, usize::MAX));
            {
                let mut guard = EVENT_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
                if guard.is_some() {
                    return Err(AppError::Validation("剪贴板监听已在运行".into()));
                }
                *guard = Some(EventHub {
                    queue: event_q.clone(),
                    epoch: sink.capture_epoch.clone(),
                });
            }
            let (ready_tx, ready_rx) = mpsc::channel::<Result<isize, String>>();
            // manual-reset 取消事件：启动超时时调用方置位即可让线程退出，
            // 不依赖调用方知道 HWND，也不会把仍在监听的线程留成孤儿。
            let cancel = unsafe { CreateEventW(null(), 1, 0, null()) };
            if cancel.is_null() {
                reset_queue();
                return Err(AppError::Validation("创建剪贴板监听取消事件失败".into()));
            }
            // 句柄本身不是 Send，按整数传给线程，避免 `*mut c_void` 进闭包。
            let cancel_thread = cancel as isize;
            let thread = match std::thread::Builder::new()
                .name("clipboard-monitor".into())
                .spawn(move || unsafe { run_message_loop(ready_tx, cancel_thread as HANDLE) })
            {
                Ok(h) => h,
                Err(e) => {
                    unsafe {
                        CloseHandle(cancel);
                    }
                    reset_queue();
                    return Err(AppError::Io(e));
                }
            };
            let hwnd = match ready_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(h)) => h,
                Ok(Err(e)) => {
                    let _ = thread.join();
                    unsafe {
                        CloseHandle(cancel);
                    }
                    reset_queue();
                    return Err(AppError::Validation(format!("剪贴板监听启动失败: {e}")));
                }
                Err(_) => {
                    unsafe {
                        SetEvent(cancel);
                    }
                    let _ = thread.join();
                    unsafe {
                        CloseHandle(cancel);
                    }
                    reset_queue();
                    return Err(AppError::Validation("剪贴板监听启动超时".into()));
                }
            };
            let content_q = Arc::new(BoundedQueue::new(
                CONTENT_QUEUE_CAPACITY,
                CONTENT_QUEUE_MAX_BYTES,
            ));
            let capture =
                match spawn_capture_thread(event_q.clone(), content_q.clone(), sink.clone()) {
                    Ok(h) => h,
                    Err(e) => {
                        reset_queue();
                        unsafe {
                            PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
                        }
                        let _ = thread.join();
                        unsafe {
                            CloseHandle(cancel);
                        }
                        return Err(AppError::Io(e));
                    }
                };
            let worker = match spawn_process_thread(content_q.clone(), sink) {
                Ok(h) => h,
                Err(e) => {
                    content_q.close();
                    reset_queue();
                    unsafe {
                        PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
                    }
                    let _ = thread.join();
                    let _ = capture.join();
                    unsafe {
                        CloseHandle(cancel);
                    }
                    return Err(AppError::Io(e));
                }
            };
            Ok(Self {
                hwnd,
                event_q,
                content_q,
                cancel: cancel as isize,
                thread: Some(thread),
                capture: Some(capture),
                worker: Some(worker),
                stopped: false,
                begun: false,
            })
        }

        /// 三个线程是否都还活着。监听线程可能因窗口/消息循环异常退出，
        /// 看门狗据此重新拉起；不能只看 `monitor.is_some()`。
        pub fn is_alive(&self) -> bool {
            self.thread.as_ref().is_some_and(|t| !t.is_finished())
                && self.capture.as_ref().is_some_and(|t| !t.is_finished())
                && self.worker.as_ref().is_some_and(|t| !t.is_finished())
        }

        /// 同步触发停止（不 join）：关闭事件队列、摘除全局事件槽、通知消息循环退出。
        ///
        /// 摘除槽位必须在调用方线程同步完成：否则「暂停 → 立刻恢复」会因
        /// EVENT_QUEUE 仍被旧实例占着而启动失败（表现为恢复后监听未运行）。
        /// 三个工作线程由 `finish_stop()`（或 Drop 兜底）回收。
        pub fn begin_stop(&mut self) {
            if self.begun {
                return;
            }
            self.begun = true;
            self.event_q.close();
            reset_queue();
            unsafe {
                PostMessageW(self.hwnd as HWND, WM_CLOSE, 0, 0);
            }
        }

        /// 回收三个线程并释放句柄；可安全地在 `begin_stop()` 之后异步调用。
        pub fn finish_stop(mut self) {
            self.begin_stop();
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
            unsafe {
                CloseHandle(self.cancel as HANDLE);
            }
            if let Some(c) = self.capture.take() {
                let _ = c.join();
            }
            self.content_q.close();
            if let Some(w) = self.worker.take() {
                let _ = w.join();
            }
            self.stopped = true;
        }

        pub fn stop(self) {
            self.finish_stop();
        }

        fn finish_in_place(&mut self) {
            if !self.begun {
                self.begin_stop();
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
            unsafe {
                CloseHandle(self.cancel as HANDLE);
            }
            if let Some(c) = self.capture.take() {
                let _ = c.join();
            }
            self.content_q.close();
            if let Some(w) = self.worker.take() {
                let _ = w.join();
            }
            self.stopped = true;
        }
    }

    impl Drop for ClipboardMonitor {
        /// 兜底收尾：异步回收线程创建失败等场景下，实例会在这里被丢弃。
        /// 绝不能只丢 JoinHandle 而不关监听/句柄，否则会留下仍在监听的孤儿线程。
        fn drop(&mut self) {
            if self.stopped {
                return;
            }
            self.finish_in_place();
        }
    }

    fn reset_queue() -> Option<EventHub> {
        EVENT_QUEUE.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn spawn_capture_thread(
        event_q: Arc<BoundedQueue<RawEvent>>,
        content_q: Arc<BoundedQueue<QueuedCapture>>,
        sink: Arc<CaptureSink>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        std::thread::Builder::new()
            .name("clipboard-capture".into())
            .spawn(move || {
                // 启动时已有的剪贴板不算新复制（self_write 已置为当前序列号）
                let mut last = sink.self_write.load(Ordering::SeqCst);
                while let Some(mut ev) = event_q.pop() {
                    // 队列中积压的旧事件直接合并：Windows 剪贴板不是可回放的历史，
                    // 只保证读取最新状态，绝不伪造中间版本。
                    while let Some(next) = event_q.try_pop() {
                        // 积压事件不逐条回放：被更新的覆盖，乱序的旧事件直接丢弃。
                        // 两者都算「合并」并统一计数，避免整批静默丢失。
                        MONITOR_COUNTERS
                            .merged_events
                            .fetch_add(1, Ordering::Relaxed);
                        if sequence_after(next.sequence, ev.sequence) {
                            ev = next;
                        }
                    }
                    // 事件发生在历史清空之前：剪贴板内容本身没变，但用户已经
                    // 明确清空历史，旧事件不得在清空之后把内容重新写回。
                    // 序列号晚于清空水位的事件是清空后的新复制（清空先记水位、
                    // 再推进代数，两步之间派发的事件带旧代数），不能因旧代数误杀。
                    if cleared_stale_gate(
                        ev.epoch,
                        sink.capture_epoch.load(Ordering::SeqCst),
                        ev.sequence,
                        sink.clear_seq.load(Ordering::SeqCst),
                    ) {
                        MONITOR_COUNTERS
                            .cleared_stale_events
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::debug!("剪贴板事件属于清空前的采集代数，已丢弃");
                        continue;
                    }
                    // 代数门只认「派发时刻」：清空前入队、清空后才派发的事件会拿到
                    // 新代数。序列号不晚于清空水位，说明内容仍是清空前的，必须拦下。
                    if clear_supersedes(ev.sequence, sink.clear_seq.load(Ordering::SeqCst)) {
                        MONITOR_COUNTERS
                            .cleared_stale_events
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::debug!("剪贴板事件早于清空水位，已丢弃");
                        continue;
                    }
                    match classify_event(ev.sequence, last, sink.self_write.load(Ordering::SeqCst))
                    {
                        EventDisposition::Superseded => {
                            MONITOR_COUNTERS
                                .superseded_events
                                .fetch_add(1, Ordering::Relaxed);
                            tracing::debug!(
                                "剪贴板事件已覆盖：序列 {} 不晚于已采集水位 {}",
                                ev.sequence,
                                last
                            );
                            continue;
                        }
                        EventDisposition::SelfWrite => {
                            MONITOR_COUNTERS
                                .self_write_events
                                .fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        EventDisposition::Read => {}
                    }
                    // fail-closed：缺失键只在初始化阶段处理（全新库写默认值、
                    // 旧库升级写默认但强制暂停），已初始化库的缺失键视为异常；
                    // 任一剪贴板键损坏/类型错误/越界或数据库读取失败都停止本次采集。
                    let config = Settings::load_clipboard(&sink.db);
                    if !config.capture_allowed() {
                        if let Some(error) = config.error.as_ref() {
                            log_config_error(error);
                        }
                        MONITOR_COUNTERS.skipped.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    match read_clipboard_for_event(false, ev.sequence, &sink.self_write) {
                        ClipboardRead::Content { sequence, content } => {
                            // 水位推进到「真正读到的状态」的序列号：同一份剪贴板
                            // 状态只记一次，随后的同内容事件不会重复入库。
                            last = sequence;
                            MONITOR_COUNTERS.captured.fetch_add(1, Ordering::Relaxed);
                            let latency = ev.seen.elapsed().as_millis() as u64;
                            MONITOR_COUNTERS
                                .max_capture_latency_ms
                                .fetch_max(latency, Ordering::Relaxed);
                            let mut content = *content;
                            let weight = queue_weight_for(&mut content);
                            let (outcome, dropped) = content_q.push_counting(
                                QueuedCapture {
                                    epoch: ev.epoch,
                                    sequence,
                                    content,
                                },
                                weight,
                            );
                            match outcome {
                                PushOutcome::Pushed => MonitorCounters::bump_peak(
                                    &MONITOR_COUNTERS.peak_content_queue,
                                    content_q.len(),
                                ),
                                PushOutcome::DroppedOldest => {
                                    MONITOR_COUNTERS
                                        .dropped_contents
                                        .fetch_add(dropped as u64, Ordering::Relaxed);
                                    MonitorCounters::bump_peak(
                                        &MONITOR_COUNTERS.peak_content_queue,
                                        content_q.len(),
                                    );
                                }
                                PushOutcome::RejectedTooLarge => {
                                    MONITOR_COUNTERS
                                        .dropped_contents
                                        .fetch_add(1, Ordering::Relaxed);
                                }
                                PushOutcome::Closed => break,
                            }
                        }
                        ClipboardRead::Skip(reason) => {
                            // 「读过但剪贴板被占用」不是策略性跳过，单独计数，
                            // 否则诊断里无法区分「配置不让记」和「想记但读不到」。
                            if reason == READ_BUSY_REASON {
                                // open_clipboard 内部已重试约 120ms 仍占用：有界重排
                                // （默认再试 3 次）等对方松开，避免 Office 延迟渲染、
                                // 剪贴板管理器等短暂独占让这一次复制永久丢失。
                                // 重排事件与新事件共用合并逻辑：期间来了新复制会
                                // 合并成最新一条，保最新语义不变；队列已关则退出。
                                if ev.retries < MAX_READ_BUSY_RETRIES {
                                    let mut retried = ev;
                                    retried.retries += 1;
                                    let attempt = retried.retries;
                                    let (outcome, _) = event_q.push_counting(retried, 1);
                                    if outcome == PushOutcome::Closed {
                                        break;
                                    }
                                    tracing::debug!(
                                        "剪贴板读取被占用，事件已重排（第 {} 次）",
                                        attempt
                                    );
                                    continue;
                                }
                                MONITOR_COUNTERS.read_failed.fetch_add(1, Ordering::Relaxed);
                            } else {
                                MONITOR_COUNTERS.skipped.fetch_add(1, Ordering::Relaxed);
                            }
                            tracing::debug!("剪贴板跳过：{}", reason);
                        }
                        ClipboardRead::Empty(reason) => {
                            // 复核窗口内的空读：先等待写入方完成 SetClipboardData 再读一次。
                            // 有界（至多 MAX_EMPTY_RECHECK 次），复核次数与重排都走同一事件队列，
                            // 若期间来了新复制会按既有合并逻辑收敛到最新事件。
                            if ev.retries < MAX_EMPTY_RECHECK {
                                let retry_no = ev.retries + 1;
                                let mut retried = ev;
                                retried.retries = retry_no;
                                std::thread::sleep(Duration::from_millis(EMPTY_RECHECK_DELAY_MS));
                                let (outcome, _) = event_q.push_counting(retried, 1);
                                if outcome == PushOutcome::Closed {
                                    break;
                                }
                                tracing::debug!(
                                    "剪贴板读空，等待写入完成后复核（第 {} 次）",
                                    retry_no
                                );
                                continue;
                            }
                            MONITOR_COUNTERS
                                .empty_events
                                .fetch_add(1, Ordering::Relaxed);
                            tracing::debug!("剪贴板丢弃：{}", reason);
                        }
                    }
                }
            })
    }

    fn spawn_process_thread(
        content_q: Arc<BoundedQueue<QueuedCapture>>,
        sink: Arc<CaptureSink>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        std::thread::Builder::new()
            .name("clipboard-worker".into())
            .spawn(move || {
                while let Some(queued) = content_q.pop() {
                    // 清空与入库必须互斥：拿到临界区后重新核对代数，
                    // 避免「核对了旧代数 → 清空删库 → 才写入」把旧内容复活。
                    // 与事件层同一合并判定：读取发生在清空之前的内容，其序列号
                    // 必然不晚于清空水位；清空后新复制（旧代数极小窗口内盖章）
                    // 靠序列号放行，不再被旧代数误杀。
                    let _gate = sink.capture_gate.lock().unwrap_or_else(|e| e.into_inner());
                    if cleared_stale_gate(
                        queued.epoch,
                        sink.capture_epoch.load(Ordering::SeqCst),
                        queued.sequence,
                        sink.clear_seq.load(Ordering::SeqCst),
                    ) {
                        MONITOR_COUNTERS
                            .cleared_stale_contents
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::debug!("剪贴板排队内容属于清空前的采集代数，已丢弃");
                        continue;
                    }
                    let started = Instant::now();
                    match process_catching_panic(|| sink.process(queued.content)) {
                        ProcessOutcome::Recorded { created } => {
                            MONITOR_COUNTERS.recorded.fetch_add(1, Ordering::Relaxed);
                            if !created {
                                MONITOR_COUNTERS.duplicates.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        ProcessOutcome::Skipped => {
                            MONITOR_COUNTERS.skipped.fetch_add(1, Ordering::Relaxed);
                        }
                        ProcessOutcome::Failed => {
                            MONITOR_COUNTERS.failed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    let latency = started.elapsed().as_millis() as u64;
                    MONITOR_COUNTERS
                        .max_process_latency_ms
                        .fetch_max(latency, Ordering::Relaxed);
                }
            })
    }

    unsafe fn run_message_loop(ready: mpsc::Sender<Result<isize, String>>, cancel: HANDLE) {
        let hinstance = GetModuleHandleW(null());
        if hinstance.is_null() {
            let _ = ready.send(Err("GetModuleHandleW 失败".into()));
            return;
        }
        let class_name = to_wide("TaskDockClipboardMonitor");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: null_mut(),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            null_mut(),
            hinstance,
            null(),
        );
        if hwnd.is_null() {
            let _ = ready.send(Err("创建消息窗口失败".into()));
            return;
        }
        if AddClipboardFormatListener(hwnd) == 0 {
            DestroyWindow(hwnd);
            let _ = ready.send(Err("AddClipboardFormatListener 失败".into()));
            return;
        }
        let _ = ready.send(Ok(hwnd as isize));
        let mut msg: MSG = zeroed();
        loop {
            // 可等待的消息循环：取消事件一置位就能退出并摘掉监听。
            // 不用裸 GetMessageW，否则启动超时后线程会永远挂在这里。
            let wait =
                MsgWaitForMultipleObjectsEx(1, &cancel, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            if wait == WAIT_OBJECT_0 {
                RemoveClipboardFormatListener(hwnd);
                DestroyWindow(hwnd);
                break;
            }
            if wait != WAIT_OBJECT_0 + 1 {
                break;
            }
            let r = GetMessageW(&mut msg, null_mut(), 0, 0);
            if r <= 0 {
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ── 非 Windows 占位（构建其他平台时保持可编译）────────────────

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn current_sequence() -> u32 {
        0
    }

    pub fn read_clipboard(_ignore_markers: bool) -> ClipboardRead {
        ClipboardRead::Empty("当前平台不支持剪贴板读取")
    }

    pub fn read_clipboard_for_event(
        _ignore_markers: bool,
        _event_sequence: u32,
        _self_write: &AtomicU32,
    ) -> ClipboardRead {
        ClipboardRead::Empty("当前平台不支持剪贴板读取")
    }

    pub fn clipboard_match(_expected: &ClipboardPayload) -> ClipboardMatch {
        ClipboardMatch::Unavailable
    }

    pub fn write_guarded(
        _payload: &ClipboardPayload,
        _guard: WriteGuard<'_>,
    ) -> AppResult<WriteOutcome> {
        Err(AppError::Validation("当前平台不支持剪贴板写入".into()))
    }

    pub fn write_guarded_notifying(
        _payload: &ClipboardPayload,
        _guard: WriteGuard<'_>,
        _self_write: &AtomicU32,
    ) -> AppResult<WriteOutcome> {
        Err(AppError::Validation("当前平台不支持剪贴板写入".into()))
    }

    pub fn restore_if_own_content(
        _snapshot_payload: &ClipboardPayload,
        _last_written: &ClipboardPayload,
        _self_write: &AtomicU32,
    ) -> AppResult<RestoreOutcome> {
        Err(AppError::Validation("当前平台不支持剪贴板恢复".into()))
    }

    pub fn snapshot() -> Snapshot {
        Snapshot {
            sequence: 0,
            payload: None,
            state: SnapshotState::Unreadable,
        }
    }

    pub fn snapshot_probe() -> SnapshotProbe {
        SnapshotProbe {
            snapshot: Some(snapshot()),
            unsupported_formats: Vec::new(),
            // 非 Windows 平台没有真实剪贴板语义，不能证明可恢复：fail-closed。
            reconstruction: Err("当前平台不支持剪贴板探测，无法确认可完整恢复".into()),
        }
    }

    pub fn send_ctrl_v() -> AppResult<()> {
        Err(AppError::Validation("当前平台不支持粘贴自动化".into()))
    }

    pub fn foreground_target() -> Option<TargetWindow> {
        None
    }

    pub fn is_foreground(_hwnd: isize) -> bool {
        false
    }

    pub fn window_target(_hwnd: isize) -> Option<TargetWindow> {
        None
    }

    pub fn window_pid(_hwnd: isize) -> Option<u32> {
        None
    }

    pub fn process_elevated(_pid: u32) -> bool {
        false
    }

    pub fn current_elevated() -> bool {
        false
    }

    pub struct ClipboardMonitor;

    impl ClipboardMonitor {
        pub fn start(_sink: Arc<CaptureSink>) -> AppResult<Self> {
            Err(AppError::Validation("当前平台不支持剪贴板监听".into()))
        }
        pub fn is_alive(&self) -> bool {
            false
        }
        pub fn stop(self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 部分格式写入的契约（§九-2）：
    /// - 必需格式写失败 → 整体失败，调用方负责回滚；
    /// - 辅助格式写失败 → 降级成功，实际形态里剔除该字段，
    ///   后续比对以实际形态为准，不会把自己少写的格式误判成用户接管。
    #[cfg(windows)]
    #[test]
    fn partial_format_write_reports_status_and_narrows_payload() {
        use super::imp::write_formats_with;

        // 第 n 次写入失败（n 从 1 计）
        fn failing_at(fail_at: usize) -> impl FnMut(u32, &[u8]) -> bool {
            let mut seen = 0usize;
            move |_fmt: u32, _data: &[u8]| {
                seen += 1;
                seen != fail_at
            }
        }

        // 纯文本 + HTML：CF_UNICODETEXT 是必需格式，HTML 是辅助格式。
        let rich = ClipboardPayload::Text {
            text: "正文".into(),
            html: Some("<b>正文</b>".into()),
        };
        let ok = write_formats_with(&rich, failing_at(0)).expect("全部格式写成功");
        assert!(ok.degraded.is_empty(), "全部成功不应有降级格式");
        assert!(matches!(
            &ok.effective,
            ClipboardPayload::Text { html: Some(_), .. }
        ));

        let html_failed = write_formats_with(&rich, failing_at(2)).expect("辅助格式失败应降级成功");
        assert_eq!(html_failed.degraded, vec!["HTML".to_string()]);
        assert!(
            matches!(
                &html_failed.effective,
                ClipboardPayload::Text { html: None, .. }
            ),
            "HTML 没写成时实际形态里不能还带着 HTML，否则比对必然失败"
        );

        // 必需格式失败：必须整体失败，不能报成功。
        let text_failed = write_formats_with(&rich, failing_at(1));
        assert!(
            text_failed.is_err(),
            "必需格式失败必须整体失败，实际 {:?}",
            text_failed.map(|r| r.degraded)
        );

        // 图片：PNG 是必需格式，DIB 是辅助格式。
        let rgba = vec![255u8; 2 * 2 * 4];
        let image = ClipboardPayload::Image {
            png: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
            rgba: Some(rgba.clone()),
            width: 2,
            height: 2,
        };
        let dib_failed = write_formats_with(&image, failing_at(2)).expect("DIB 失败应降级成功");
        assert_eq!(dib_failed.degraded, vec!["DIB".to_string()]);
        assert!(
            matches!(&dib_failed.effective, ClipboardPayload::Image { .. }),
            "PNG 写成功时实际形态仍是图片"
        );

        let png_failed = write_formats_with(&image, failing_at(1));
        assert!(
            png_failed.is_err(),
            "PNG 写失败必须整体失败（剪贴板里没有这份图片）"
        );
    }

    /// 降级后的实际形态必须与「剪贴板上真实存在的内容」判定为一致，
    /// 否则逐项粘贴会在自己少写一个格式时误判成用户接管并中止。
    #[cfg(windows)]
    #[test]
    fn degraded_payload_matches_what_is_actually_on_the_clipboard() {
        let expected = ClipboardPayload::Text {
            text: "正文".into(),
            html: None,
        };
        assert_eq!(
            payload_matches_read(&expected, Some("正文"), None, None, None, &[]),
            Some(true),
            "只写了纯文本时，按纯文本形态比对必须一致"
        );
        // 期望里有 HTML、实际没有 → 不一致（这正是降级要规避的误判来源）。
        let with_html = ClipboardPayload::Text {
            text: "正文".into(),
            html: Some("<b>正文</b>".into()),
        };
        assert_eq!(
            payload_matches_read(&with_html, Some("正文"), None, None, None, &[]),
            Some(false),
            "实际没有 HTML 时，带 HTML 的期望形态不该判为一致"
        );
    }

    /// P2 快照完整性：写入型真机测试只允许在「显式写回 + 系统合成」的格式集合上启动。
    ///
    /// RTF、Office 私有格式、第三方自定义格式与元文件都无法由 `ClipboardPayload`
    /// 无损重建；把它们当成可恢复会在恢复时静默丢掉原始格式，因此必须判为不可恢复。
    #[cfg(windows)]
    #[test]
    fn snapshot_integrity_allows_only_losslessly_recoverable_formats() {
        use super::imp::{describe_format, format_id, is_recoverable_format};
        use windows_sys::Win32::System::Ole::{
            CF_BITMAP, CF_DIB, CF_DIBV5, CF_HDROP, CF_LOCALE, CF_METAFILEPICT, CF_OEMTEXT,
            CF_PALETTE, CF_TEXT, CF_UNICODETEXT,
        };

        for fmt in [
            CF_TEXT as u32,
            CF_BITMAP as u32,
            CF_OEMTEXT as u32,
            CF_DIB as u32,
            CF_PALETTE as u32,
            CF_UNICODETEXT as u32,
            CF_HDROP as u32,
            CF_LOCALE as u32,
            // EnumClipboardFormats 会把系统合成格式一并枚举：只有 CF_DIB 的剪贴板
            // 也会看到 CF_DIBV5，因此它必须按可恢复处理，否则所有图片剪贴板都会被误拒。
            CF_DIBV5 as u32,
        ] {
            assert!(
                is_recoverable_format(fmt),
                "{} 是显式写回或系统合成格式，必须判为可恢复",
                describe_format(fmt)
            );
        }

        for name in ["HTML Format", "PNG"] {
            let fmt = format_id(name);
            assert_ne!(fmt, 0, "{name} 必须可注册");
            assert!(
                is_recoverable_format(fmt),
                "{name} 由本工具显式写回，必须判为可恢复"
            );
        }

        // 元文件无法由 ClipboardPayload 重建；RTF 等私有格式更不可能。
        assert!(!is_recoverable_format(CF_METAFILEPICT as u32));
        assert_eq!(describe_format(CF_METAFILEPICT as u32), "CF_METAFILEPICT");
        let rtf = format_id("Rich Text Format");
        assert_ne!(rtf, 0);
        assert!(
            !is_recoverable_format(rtf),
            "RTF 无法通过 ClipboardPayload 无损重建"
        );
        assert!(
            describe_format(rtf).contains("Rich Text Format"),
            "拒绝信息必须让用户看懂是哪种格式"
        );
        let private = format_id("Vendor.Private.Payload");
        assert!(!is_recoverable_format(private));
    }

    /// P1-1/P1-2：整份快照能否由读取到的单个载荷重建。
    ///
    /// 白名单只证明「每个格式单独受支持」；文本 + PNG 这类复合剪贴板在恢复时
    /// 只能保留一种表示，必须拒绝。HTML-only 能从读取侧得到载荷，但写入层要求
    /// 非空纯文本，也必须拒绝——否则会先清空剪贴板、再写回失败，丢掉用户内容。
    #[cfg(windows)]
    #[test]
    fn snapshot_reconstruction_requires_rebuilding_every_independent_format() {
        use super::imp::{
            format_id, payload_writable, snapshot_reconstruction, write_formats_with,
        };
        use windows_sys::Win32::System::Ole::{
            CF_BITMAP, CF_DIB, CF_DIBV5, CF_HDROP, CF_LOCALE, CF_OEMTEXT, CF_PALETTE, CF_TEXT,
            CF_UNICODETEXT,
        };

        fn formats(ids: &[u32]) -> Vec<(u32, String)> {
            ids.iter()
                .map(|id| (*id, imp::describe_format(*id)))
                .collect()
        }

        let text_formats = [
            CF_UNICODETEXT as u32,
            CF_TEXT as u32,
            CF_OEMTEXT as u32,
            CF_LOCALE as u32,
        ];
        // 2x2 图片：只用于验证写入层约束，避免 DIB 往返产生大块内存。
        let image = ClipboardPayload::Image {
            png: vec![1, 2, 3, 4],
            rgba: Some(vec![0u8; 2 * 2 * 4]),
            width: 2,
            height: 2,
        };
        let image_formats = [
            format_id("PNG"),
            CF_DIB as u32,
            CF_DIBV5 as u32,
            CF_BITMAP as u32,
            CF_PALETTE as u32,
        ];
        let html_format = format_id("HTML Format");
        assert_ne!(html_format, 0, "HTML Format 必须可注册");
        let body = ClipboardPayload::Text {
            text: "正文".into(),
            html: None,
        };

        // 纯文本 / 纯 PNG / PNG+DIB —— 单族格式必须放行，且载荷确实能写回。
        for (ids, payload, label) in [
            (&text_formats[..], &body, "纯文本"),
            (&image_formats[..], &image, "PNG+DIB 同源图片"),
        ] {
            assert!(
                snapshot_reconstruction(&formats(ids), payload).is_ok(),
                "{label} 必须允许启动"
            );
            assert!(payload_writable(payload), "{label} 载荷必须满足写入条件");
            assert!(
                write_formats_with(payload, |_, _| true).is_ok(),
                "{label} 放行载荷必须符合真实写入约束"
            );
        }

        // 文本 + HTML：同一 Text 载荷可同时重建两个格式，放行。
        let rich = ClipboardPayload::Text {
            text: "正文".into(),
            html: Some("<b>正文</b>".into()),
        };
        let mut text_html = text_formats.to_vec();
        text_html.push(html_format);
        assert!(
            snapshot_reconstruction(&formats(&text_html), &rich).is_ok(),
            "纯文本+HTML 在能正确重建时必须放行"
        );
        assert!(write_formats_with(&rich, |_, _| true).is_ok());

        // HTML-only：读取成功但写入层拒绝，探测必须提前拒绝。
        let html_only = ClipboardPayload::Text {
            text: String::new(),
            html: Some("<b>x</b>".into()),
        };
        let reason = snapshot_reconstruction(&formats(&[html_format]), &html_only)
            .expect_err("HTML-only 不可安全恢复");
        assert!(
            reason.contains("HTML") && reason.contains("纯文本"),
            "拒绝原因必须说明 HTML-only 的写入约束：{reason}"
        );
        assert!(
            write_formats_with(&html_only, |_, _| true).is_err(),
            "写入层必须同样拒绝 HTML-only，证明探测与写入判据一致"
        );

        // PNG + 独立文本：classify 只会保留图片，文本会丢失。
        let mut png_text = image_formats.to_vec();
        png_text.push(CF_UNICODETEXT as u32);
        png_text.push(CF_TEXT as u32);
        let reason = snapshot_reconstruction(&formats(&png_text), &image)
            .expect_err("图片+独立文本必须拒绝");
        assert!(reason.contains("文本"), "拒绝原因必须点名文本：{reason}");

        // 图片 + 独立 HTML：classify 只会保留图片，HTML 会丢失。
        let mut png_html = image_formats.to_vec();
        png_html.push(html_format);
        let reason = snapshot_reconstruction(&formats(&png_html), &image)
            .expect_err("图片+独立 HTML 必须拒绝");
        assert!(reason.contains("HTML"), "拒绝原因必须点名 HTML：{reason}");

        // 文件 + 文本：无法证明文本只是路径清单，保守拒绝。
        let existing = std::env::current_exe()
            .expect("测试进程路径")
            .to_string_lossy()
            .to_string();
        let files = ClipboardPayload::Files {
            paths: vec![existing.clone()],
        };
        let mut files_text = vec![CF_HDROP as u32, CF_UNICODETEXT as u32];
        let reason = snapshot_reconstruction(&formats(&files_text), &files)
            .expect_err("文件+独立文本必须拒绝");
        assert!(reason.contains("文件"), "拒绝原因必须点名文件：{reason}");
        files_text.clear();
        files_text.push(CF_HDROP as u32);
        assert!(
            snapshot_reconstruction(&formats(&files_text), &files).is_ok(),
            "纯文件路径必须允许启动"
        );

        // 路径失效：读得到却写不回，必须拒绝。
        let gone = ClipboardPayload::Files {
            paths: vec!["C:\\task-dock-nonexistent\\nope.txt".into()],
        };
        let reason = snapshot_reconstruction(&formats(&[CF_HDROP as u32]), &gone)
            .expect_err("失效路径必须拒绝");
        assert!(
            reason.contains("失效"),
            "拒绝原因必须说明路径失效：{reason}"
        );
        assert!(
            write_formats_with(&gone, |_, _| true).is_err(),
            "写入层同样不接受失效路径"
        );

        // 空格式集合 / 空载荷：无法确认，保守拒绝。
        assert!(snapshot_reconstruction(&[], &body).is_err());
        let empty = ClipboardPayload::Text {
            text: String::new(),
            html: None,
        };
        assert!(snapshot_reconstruction(&formats(&text_formats), &empty).is_err());

        // 未注册/私有格式混入：无论载荷多正常都必须拒绝。
        let rtf = format_id("Rich Text Format");
        assert_ne!(rtf, 0);
        let mut with_rtf = text_formats.to_vec();
        with_rtf.push(rtf);
        let reason =
            snapshot_reconstruction(&formats(&with_rtf), &body).expect_err("RTF 会永久丢失");
        assert!(
            reason.contains("Rich Text Format"),
            "拒绝原因必须点名 RTF：{reason}"
        );
        let office = format_id("Microsoft Office Word 2003 XML");
        let mut with_office = text_formats.to_vec();
        with_office.push(office);
        let reason = snapshot_reconstruction(&formats(&with_office), &body)
            .expect_err("Office 私有格式会丢失");
        assert!(
            reason.contains("Office"),
            "拒绝原因必须点名 Office 格式：{reason}"
        );
    }

    #[test]
    fn hdrop_parser_reads_wide_paths() {
        let paths = ["C:\\temp\\a.txt", "D:\\图片\\b.png"];
        let mut bytes = vec![0u8; 20];
        bytes[0..4].copy_from_slice(&20u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        for p in paths {
            for u in p.encode_utf16() {
                bytes.extend_from_slice(&u.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
        #[cfg(windows)]
        {
            let parsed = imp::parse_hdrop(&bytes);
            assert_eq!(parsed, paths);
        }
    }

    #[test]
    fn exclusion_list_matches_basename() {
        assert!(excluded("keepass.exe, 1password.exe", "keepass.exe"));
        assert!(excluded("KeePass.exe\r\nBitwarden.exe", "bitwarden.exe"));
        assert!(!excluded("keepass.exe", "chrome.exe"));
        assert!(!excluded("", "chrome.exe"));
    }

    #[test]
    fn write_guard_uses_content_for_own_writes() {
        let own = ClipboardPayload::Text {
            text: "自己的内容".into(),
            html: None,
        };
        // 内容一致时序列号因合成格式增长不影响写入
        assert!(guard_allows(&WriteGuard::Content(&own), 99, true));
        assert!(!guard_allows(&WriteGuard::Content(&own), 10, false));
    }

    #[test]
    fn write_guard_uses_sequence_only_for_uncomparable_baseline() {
        assert!(guard_allows(&WriteGuard::Sequence(5), 5, false));
        assert!(!guard_allows(&WriteGuard::Sequence(5), 6, false));
    }

    #[test]
    fn unconditional_write_has_no_guard_constraint() {
        assert!(guard_allows(&WriteGuard::Unconditional, 7, false));
    }

    #[test]
    fn self_write_gate_skips_only_covered_events() {
        // 本进程写入的最终序列（含 CloseClipboard 后递增）及更早的重复通知
        assert!(is_own_write_sequence(42, 42));
        assert!(is_own_write_sequence(41, 42), "延迟/重复通知不得再入库");
        assert!(is_own_write_sequence(0, 42));
        // 用户随后复制的新内容严格更晚，必须放行
        assert!(!is_own_write_sequence(43, 42));
        // 回绕感知：u32::MAX 在 42 之前（回绕后 0 才是最新），属于过去事件
        assert!(is_own_write_sequence(u32::MAX, 42));
        // 启动时未登记任何自写：所有事件都应被读取
        assert!(!is_own_write_sequence(1, 0));
    }

    /// 事件处置必须区分「读」「已覆盖」「自写」三条路径。
    ///
    /// 覆盖判定用的是**读取时刻**的序列号水位：事件序列号取自消息处理时刻，
    /// 可能晚于真正读到的内容，于是同一份剪贴板状态会被第二个事件再读一次。
    /// 这条测试锁住「一份状态只记一次」的去重语义。
    #[test]
    fn event_disposition_separates_read_superseded_and_self_write() {
        // 启动时 self_write 水位就是当时的剪贴板序列号（通常是几十以上）
        let sw = 50u32;

        // 用户复制，水位停在 100：更晚的事件要读
        assert_eq!(
            classify_event(101, 100, sw),
            EventDisposition::Read,
            "晚于水位且不是自写，必须读取"
        );

        // 同一份状态的通知再来一次：序列号不晚于水位，不得重复入库
        assert_eq!(
            classify_event(100, 100, sw),
            EventDisposition::Superseded,
            "不晚于水位的事件不得重复读取"
        );
        assert_eq!(
            classify_event(99, 100, sw),
            EventDisposition::Superseded,
            "早于水位的事件属于过去，不得读取"
        );

        // 关键回归：上一条事件读到的内容对应 105（水位推进到读取时刻），
        // 随后到达的 102 号通知属于同一份状态，必须判为覆盖而不是再次入库。
        assert_eq!(
            classify_event(102, 105, sw),
            EventDisposition::Superseded,
            "读取水位之后的旧通知不得把同一份内容记两遍"
        );

        // 自写事件即便晚于水位也必须先判为自写，便于单独归因
        assert_eq!(
            classify_event(110, 105, 110),
            EventDisposition::SelfWrite,
            "本进程写入的事件必须归因为自写"
        );
        assert_eq!(
            classify_event(105, 105, 110),
            EventDisposition::SelfWrite,
            "自写的重复/延迟通知同样归因为自写"
        );

        // 回绕：水位 u32::MAX 之后，序列号 0 是最新内容
        let sw_wrap = u32::MAX - 5;
        assert_eq!(
            classify_event(0, u32::MAX, sw_wrap),
            EventDisposition::Read,
            "回绕后的新内容必须放行"
        );
        assert_eq!(
            classify_event(u32::MAX, u32::MAX, sw_wrap),
            EventDisposition::Superseded,
            "回绕前的状态不得重复入库"
        );
    }

    /// 清空历史与在途采集的竞态：入队盖章、出队核对，两次之间发生清空也必须拦下。
    #[test]
    fn stale_capture_epoch_blocks_work_queued_before_clear() {
        let epoch = Arc::new(AtomicU64::new(7));

        // 未清空时，正常的新复制必须一路放行：代数门不得误杀常规采集
        let queued = epoch.load(Ordering::SeqCst);
        assert_eq!(classify_event(120, 119, 50), EventDisposition::Read);
        assert!(!epoch_is_stale(queued, epoch.load(Ordering::SeqCst)));

        // 命令侧清空历史的顺序是：持 capture_gate → 代数 +1 → 删库
        epoch.fetch_add(1, Ordering::SeqCst);

        // worker 此刻才取出「清空前」排队的事件与内容：必须拦下，
        // 否则旧内容会在删库之后重新出现在历史里。
        assert!(
            epoch_is_stale(queued, epoch.load(Ordering::SeqCst)),
            "清空前排队的事件不得在清空后入库"
        );

        // 清空之后用户新复制的内容盖的是新一代，采集不能被连带封死
        let after_clear = epoch.load(Ordering::SeqCst);
        assert!(!epoch_is_stale(after_clear, epoch.load(Ordering::SeqCst)));
    }

    #[test]
    fn sequence_wrap_does_not_pin_self_write_watermark() {
        assert!(sequence_after(0, u32::MAX), "回绕后 0 晚于 MAX");
        assert!(!sequence_after(u32::MAX, 0), "MAX 早于回绕后的 0");

        let sw = AtomicU32::new(u32::MAX - 2);
        note_self_write_watermark(&sw, 3);
        assert_eq!(sw.load(Ordering::SeqCst), 3, "回绕时必须更新水位");
        assert!(!is_own_write_sequence(4, 3), "回绕后的用户复制必须放行");
        assert!(is_own_write_sequence(3, 3));
        assert!(is_own_write_sequence(u32::MAX - 2, 3), "回绕前事件属于过去");

        note_self_write_watermark(&sw, u32::MAX - 10);
        assert_eq!(sw.load(Ordering::SeqCst), 3, "回绕前的旧通知不得把水位拉回");

        // 恢复写入不推进水位：内容相同，重复记录交给 store 去重。
        let before = sw.load(Ordering::SeqCst);
        finish_restore(Ok(())).unwrap();
        assert_eq!(
            sw.load(Ordering::SeqCst),
            before,
            "恢复写入不得推进自写水位"
        );
    }

    #[test]
    fn restore_does_not_advance_self_write_watermark() {
        let sw = AtomicU32::new(100);
        let failed = finish_restore(Err(AppError::Validation("写入失败".into())));
        assert!(failed.is_err());
        assert_eq!(
            sw.load(Ordering::SeqCst),
            100,
            "写入失败不得登记自写（否则会丢弃用户内容）"
        );

        let ok = finish_restore(Ok(())).unwrap();
        assert_eq!(ok, RestoreOutcome::Restored);
        assert_eq!(
            sw.load(Ordering::SeqCst),
            100,
            "恢复写入不得推进水位：恢复的是用户内容，不是本进程的新内容"
        );
    }

    #[test]
    fn payload_match_requires_same_text_and_html_presence() {
        let plain = ClipboardPayload::Text {
            text: "验收".into(),
            html: None,
        };
        assert_eq!(
            payload_matches_read(&plain, Some("验收"), None, None, None, &[]),
            Some(true)
        );
        assert_eq!(
            payload_matches_read(&plain, Some("别的"), None, None, None, &[]),
            Some(false)
        );
        assert_eq!(
            payload_matches_read(&plain, Some("验收"), Some("<b>验收</b>"), None, None, &[]),
            Some(false),
            "纯文本项遇到 HTML 必须视为内容已换"
        );
        let rich = ClipboardPayload::Text {
            text: "验收".into(),
            html: Some("<b>验收</b>".into()),
        };
        assert_eq!(
            payload_matches_read(&rich, Some("验收"), Some("<b>验收</b>"), None, None, &[]),
            Some(true)
        );
        assert_eq!(
            payload_matches_read(&rich, Some("验收"), Some("<i>验收</i>"), None, None, &[]),
            Some(false)
        );
    }

    #[test]
    fn payload_match_falls_back_to_pixels_when_png_container_changes() {
        // 不透明像素按 RGB 重新编码会得到字节完全不同的容器，但像素一致——
        // 这正是 Windows 用同源 CF_DIB 合成「PNG」时实际发生的事。
        let rgba: Vec<u8> = (0..4 * 4 * 4)
            .map(|i| {
                if i % 4 == 3 {
                    255
                } else {
                    (i as u8).wrapping_mul(37).wrapping_add(11)
                }
            })
            .collect();
        let expected_png = image::encode_png(&rgba, 4, 4).unwrap();
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 4, 4);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let rgb: Vec<u8> = rgba
                .chunks_exact(4)
                .flat_map(|px| [px[0], px[1], px[2]])
                .collect();
            writer.write_image_data(&rgb).unwrap();
        }
        assert_ne!(
            expected_png, out,
            "样例必须产生不同的容器字节，否则测不到像素回退"
        );
        let payload = ClipboardPayload::Image {
            png: expected_png.clone(),
            rgba: None,
            width: 4,
            height: 4,
        };
        assert_eq!(
            payload_matches_read(&payload, None, None, Some(&out), None, &[]),
            Some(true),
            "容器字节变了但像素同源，必须判定为同一份内容"
        );
        let with_rgba = ClipboardPayload::Image {
            png: expected_png.clone(),
            rgba: Some(rgba.clone()),
            width: 4,
            height: 4,
        };
        assert_eq!(
            payload_matches_read(&with_rgba, None, None, Some(&out), None, &[]),
            Some(true),
            "带像素缓存时同样按像素判定"
        );
        let mut changed = rgba.clone();
        changed[0] = changed[0].wrapping_add(1);
        let changed_png = image::encode_png(&changed, 4, 4).unwrap();
        assert_eq!(
            payload_matches_read(&payload, None, None, Some(&changed_png), None, &[]),
            Some(false),
            "像素真的变了必须判定为不同内容"
        );
        let resized_png = image::encode_png(&rgba[..4 * 3 * 4], 4, 3).unwrap();
        assert_eq!(
            payload_matches_read(&payload, None, None, Some(&resized_png), None, &[]),
            Some(false),
            "尺寸不同必须判定为不同内容"
        );
        assert_eq!(
            payload_matches_read(&payload, None, None, None, None, &[]),
            None,
            "读不到图片只能判定为无法验证，不能伪造 Same 或 Different"
        );
    }

    #[test]
    fn payload_match_treats_zero_alpha_png_container_as_unused() {
        // 真机 GUI 复现的形态：入库版本 Alpha=255，Windows 用 CF_DIB 合成出的
        // 「PNG」容器 Alpha 字节全 0。两侧像素必须按同一条 Alpha 规则归一后比较，
        // 否则本进程刚写入的图片永远匹配不上自己的粘贴前快照，
        // 逐项粘贴会在第 1 项停成「剪贴板已被其他程序更新」。
        let rgb: Vec<u8> = (0..3 * 4 * 4)
            .map(|i| (i as u8).wrapping_mul(53).wrapping_add(9))
            .collect();
        let encode_with_alpha = |alpha: u8| -> Vec<u8> {
            let rgba: Vec<u8> = rgb
                .chunks_exact(3)
                .flat_map(|px| [px[0], px[1], px[2], alpha])
                .collect();
            image::encode_png(&rgba, 4, 4).unwrap()
        };
        let opaque_png = encode_with_alpha(255);
        let zero_alpha_png = encode_with_alpha(0);
        assert_ne!(
            opaque_png, zero_alpha_png,
            "样例必须产生不同的容器字节，否则测不到 Alpha 归一"
        );

        let expected = ClipboardPayload::Image {
            png: opaque_png.clone(),
            rgba: None,
            width: 4,
            height: 4,
        };
        assert_eq!(
            payload_matches_read(&expected, None, None, Some(&zero_alpha_png), None, &[]),
            Some(true),
            "Alpha 全 0 的容器属于未使用通道，必须判定为同一份图片内容"
        );
        let expected_cached = ClipboardPayload::Image {
            png: opaque_png.clone(),
            rgba: Some(
                rgb.chunks_exact(3)
                    .flat_map(|px| [px[0], px[1], px[2], 255u8])
                    .collect(),
            ),
            width: 4,
            height: 4,
        };
        assert_eq!(
            payload_matches_read(
                &expected_cached,
                None,
                None,
                Some(&zero_alpha_png),
                None,
                &[]
            ),
            Some(true),
            "带像素缓存的期望侧同样要归一"
        );

        // 真实透明信息（Alpha 并非全 0）不能被归一成不透明。
        let transparent_png = encode_with_alpha(128);
        assert_eq!(
            payload_matches_read(&expected, None, None, Some(&transparent_png), None, &[]),
            Some(false),
            "半透明图片与不透明图片是不同内容，绝不因归一而判为相同"
        );
    }

    #[test]
    fn payload_match_ignores_empty_html_fragment() {
        let plain = ClipboardPayload::Text {
            text: "验收".into(),
            html: None,
        };
        assert_eq!(
            payload_matches_read(&plain, Some("验收"), Some(""), None, None, &[]),
            Some(true),
            "长度为 0 的 HTML 片段不是内容，不能把自写纯文本判成用户接管"
        );
        let rich = ClipboardPayload::Text {
            text: "验收".into(),
            html: Some("<b>验收</b>".into()),
        };
        assert_eq!(
            payload_matches_read(&rich, Some("验收"), Some(""), None, None, &[]),
            Some(false),
            "期望富文本却只读回空片段，必须判定为不同内容"
        );
        assert_eq!(
            payload_matches_read(&rich, Some("验收"), None, None, None, &[]),
            Some(false),
            "期望富文本却读不到 HTML，必须判定为不同内容"
        );
        let empty_rich = ClipboardPayload::Text {
            text: "验收".into(),
            html: Some(String::new()),
        };
        assert_eq!(
            payload_matches_read(&empty_rich, Some("验收"), None, None, None, &[]),
            Some(true),
            "期望侧的空 HTML 与实际侧同样按不存在处理"
        );
    }

    #[test]
    fn payload_match_compares_image_bytes_and_file_names() {
        let rgba: Vec<u8> = vec![
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 1, 2, 3, 255,
        ];
        let png = image::encode_png(&rgba, 2, 2).unwrap();
        let image = ClipboardPayload::Image {
            png: png.clone(),
            rgba: None,
            width: 2,
            height: 2,
        };
        assert_eq!(
            payload_matches_read(&image, None, None, Some(&png), None, &[]),
            Some(true),
            "PNG 原始字节完全一致时必须直接判 Same"
        );
        let changed_rgba: Vec<u8> = {
            let mut v = rgba.clone();
            v[0] = v[0].wrapping_add(1);
            v
        };
        let changed_png = image::encode_png(&changed_rgba, 2, 2).unwrap();
        assert_eq!(
            payload_matches_read(&image, None, None, Some(&changed_png), None, &[]),
            Some(false),
            "真实不同的图片必须判 Different，绝不能被算成相同"
        );
        assert_eq!(
            payload_matches_read(&image, None, None, None, None, &[]),
            None,
            "没有任何可解码的图片格式时只能判「无法验证」"
        );
        let files = ClipboardPayload::Files {
            paths: vec!["C:\\Temp\\a.txt".into()],
        };
        assert_eq!(
            payload_matches_read(&files, None, None, None, None, &["c:\\temp\\A.TXT".into()]),
            Some(true)
        );
        assert_eq!(
            payload_matches_read(&files, None, None, None, None, &["C:\\Temp\\b.txt".into()]),
            Some(false)
        );
    }

    /// 把自下而上 CF_DIB 的行序翻转成负高度（自上而下）的等价 DIB。
    fn top_down_dib(bottom_up: &[u8], width: usize, height: usize) -> Vec<u8> {
        let mut out = bottom_up.to_vec();
        out[8..12].copy_from_slice(&(-(height as i32)).to_le_bytes());
        for y in 0..height / 2 {
            let a = 40 + y * width * 4;
            let b = 40 + (height - 1 - y) * width * 4;
            for i in 0..width * 4 {
                out.swap(a + i, b + i);
            }
        }
        out
    }

    /// 构造 BITMAPV5HEADER（124 字节）形式的手工 DIB，用于验证 DIBV5-only 剪贴板。
    fn dib_v5_from_rgba(rgba: &[u8], width: u32, height: u32, alpha_mask: u32) -> Vec<u8> {
        let base = image::rgba_to_dib(rgba, width, height);
        let mut out = vec![0u8; 124 + (width * height * 4) as usize];
        out[0..4].copy_from_slice(&124u32.to_le_bytes());
        out[4..8].copy_from_slice(&width.to_le_bytes());
        out[8..12].copy_from_slice(&height.to_le_bytes());
        out[12..14].copy_from_slice(&1u16.to_le_bytes());
        out[14..16].copy_from_slice(&32u16.to_le_bytes());
        out[16..20].copy_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
        out[20..24].copy_from_slice(&(width * height * 4).to_le_bytes());
        out[40..44].copy_from_slice(&0x00FF0000u32.to_le_bytes());
        out[44..48].copy_from_slice(&0x0000FF00u32.to_le_bytes());
        out[48..52].copy_from_slice(&0x000000FFu32.to_le_bytes());
        out[52..56].copy_from_slice(&alpha_mask.to_le_bytes());
        out[124..].copy_from_slice(&base[40..]);
        out
    }

    /// 关键回归：Snipping Tool / Snipaste / 旧式应用只写 CF_DIB 时，Windows 不会
    /// 自动合成「PNG」。若写入前比较只认 PNG，快照（由 DIB 解码）与比较（读不到
    /// PNG）语义不一致，就把「没有变化」误判成「被其他程序更新」，逐项粘贴第 1 项
    /// 直接被守卫拒绝。
    #[test]
    fn payload_match_accepts_dib_only_clipboard() {
        let rgba: Vec<u8> = (0..4 * 4 * 4)
            .map(|i| {
                if i % 4 == 3 {
                    255
                } else {
                    (i as u8).wrapping_mul(31).wrapping_add(5)
                }
            })
            .collect();
        let png = image::encode_png(&rgba, 4, 4).unwrap();
        let expected = ClipboardPayload::Image {
            png,
            rgba: Some(rgba.clone()),
            width: 4,
            height: 4,
        };
        let bottom_up = image::rgba_to_dib(&rgba, 4, 4);
        assert_eq!(
            payload_matches_read(&expected, None, None, None, Some(&bottom_up), &[]),
            Some(true),
            "只有 CF_DIB 的剪贴板必须能与快照判为同一份内容"
        );
        assert_eq!(
            payload_matches_read(
                &expected,
                None,
                None,
                None,
                Some(&top_down_dib(&bottom_up, 4, 4)),
                &[]
            ),
            Some(true),
            "负高度/自上而下行序只是编码差异，像素相同必须判 Same"
        );
        // 32bpp BI_RGB 的 Alpha 字节全 0 表示未使用，不是全透明。
        let mut zero_alpha = bottom_up.clone();
        for px in zero_alpha[40..].chunks_exact_mut(4) {
            px[3] = 0;
        }
        assert_eq!(
            payload_matches_read(&expected, None, None, None, Some(&zero_alpha), &[]),
            Some(true),
            "Alpha 未使用的 DIB 必须按不透明处理，与入库版本一致"
        );
        // DIBV5（BI_BITFIELDS）形态同样可比较：有 Alpha 掩码/无 Alpha 掩码都覆盖。
        let v5 = dib_v5_from_rgba(&rgba, 4, 4, 0xFF00_0000);
        assert_eq!(
            payload_matches_read(&expected, None, None, None, Some(&v5), &[]),
            Some(true),
            "DIBV5-only 剪贴板必须可比较"
        );
        let v5_no_alpha = dib_v5_from_rgba(&rgba, 4, 4, 0);
        assert_eq!(
            payload_matches_read(&expected, None, None, None, Some(&v5_no_alpha), &[]),
            Some(true),
            "DIBV5 无 Alpha 掩码时不能把「未使用」当成全透明"
        );
    }

    /// 真正不同的图片绝不能因为「容器不是 PNG」而被放过（拒绝覆盖用户的图片）。
    #[test]
    fn payload_match_rejects_different_dib_only_image() {
        let rgba: Vec<u8> = (0..4 * 4 * 4)
            .map(|i| {
                if i % 4 == 3 {
                    255
                } else {
                    (i as u8).wrapping_mul(17)
                }
            })
            .collect();
        let expected = ClipboardPayload::Image {
            png: image::encode_png(&rgba, 4, 4).unwrap(),
            rgba: None,
            width: 4,
            height: 4,
        };
        let mut changed = rgba.clone();
        changed[0] = changed[0].wrapping_add(1);
        assert_eq!(
            payload_matches_read(
                &expected,
                None,
                None,
                None,
                Some(&image::rgba_to_dib(&changed, 4, 4)),
                &[]
            ),
            Some(false),
            "像素真的不同必须判 Different"
        );
        assert_eq!(
            payload_matches_read(
                &expected,
                None,
                None,
                None,
                Some(&image::rgba_to_dib(&rgba[..4 * 3 * 4], 4, 3)),
                &[]
            ),
            Some(false),
            "尺寸不同必须判 Different"
        );
    }

    /// 没有任何可解码图片来源（PNG 损坏且 DIB 缺失/截断）时只能返回「无法验证」：
    /// 既不能冒充 Same 去覆盖，也不能谎报 Different 去指控用户接管。
    #[test]
    fn payload_match_unverifiable_without_readable_image() {
        let rgba: Vec<u8> = vec![0, 0, 0, 255, 9, 9, 9, 255, 8, 8, 8, 255, 7, 7, 7, 255];
        let expected = ClipboardPayload::Image {
            png: image::encode_png(&rgba, 2, 2).unwrap(),
            rgba: None,
            width: 2,
            height: 2,
        };
        assert_eq!(
            payload_matches_read(&expected, None, None, None, None, &[]),
            None,
            "完全没有图片格式时必须判「无法验证」"
        );
        assert_eq!(
            payload_matches_read(&expected, None, None, Some(&[1, 2, 3]), None, &[]),
            None,
            "PNG 无法解码且无 DIB 时必须判「无法验证」"
        );
        assert_eq!(
            payload_matches_read(&expected, None, None, None, Some(&[0u8; 39]), &[]),
            None,
            "DIB 读取不完整/截断时必须判「无法验证」"
        );
        assert_eq!(
            payload_matches_read(&expected, Some("用户后来复制的文本"), None, None, None, &[]),
            Some(false),
            "期望是图片、实际只剩文本时必须判 Different（用户确实接管了）"
        );
    }

    #[test]
    fn bounded_queue_drops_oldest_and_keeps_latest() {
        let q = BoundedQueue::new(3, 1024);
        assert_eq!(q.push(1, 1), PushOutcome::Pushed);
        assert_eq!(q.push(2, 1), PushOutcome::Pushed);
        assert_eq!(q.push(3, 1), PushOutcome::Pushed);
        assert_eq!(q.push(4, 1), PushOutcome::DroppedOldest);
        assert_eq!(q.len(), 3);
        assert_eq!(q.try_pop(), Some(2));
        assert_eq!(q.try_pop(), Some(3));
        assert_eq!(q.try_pop(), Some(4));
        assert_eq!(q.try_pop(), None);
    }

    #[test]
    fn bounded_queue_respects_byte_budget() {
        let q = BoundedQueue::new(8, 100);
        assert_eq!(q.push("a", 60), PushOutcome::Pushed);
        assert_eq!(q.push("b", 60), PushOutcome::DroppedOldest);
        assert_eq!(q.try_pop(), Some("b"));
        assert_eq!(q.push("huge", 101), PushOutcome::RejectedTooLarge);
        q.close();
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn bounded_queue_push_counting_reports_every_evicted_item() {
        let q = BoundedQueue::new(8, 100);
        assert_eq!(q.push_counting("a", 30), (PushOutcome::Pushed, 0));
        assert_eq!(q.push_counting("b", 30), (PushOutcome::Pushed, 0));
        assert_eq!(q.push_counting("c", 30), (PushOutcome::Pushed, 0));
        // 90 + 50 超预算：只丢一条不够，必须连丢两条才放得下。
        assert_eq!(q.push_counting("d", 50), (PushOutcome::DroppedOldest, 2));
        assert_eq!(
            q.push_counting("huge", 101),
            (PushOutcome::RejectedTooLarge, 0)
        );
        q.close();
        assert_eq!(q.push_counting("e", 1), (PushOutcome::Closed, 0));
    }

    #[test]
    fn content_queue_estimates_image_and_text_bytes() {
        let mut c = CapturedContent {
            kind: "text".into(),
            text: "abc".into(),
            html: "defg".into(),
            preview: String::new(),
            file_paths: vec!["C:\\a".into()],
            image: None,
            source_app: "unknown".into(),
            source_title: String::new(),
            source_kind: "owner".into(),
            byte_size: 0,
        };
        assert_eq!(estimate_content_bytes(&c), 3 + 4 + 4 + 7);
        c.image = Some(CapturedImage {
            png: vec![0u8; 10],
            width: 1,
            height: 1,
            rgba: vec![],
        });
        assert_eq!(estimate_content_bytes(&c), 3 + 4 + 4 + 7 + 10);
        // 队列里保留的是 png + rgba 两份：只按 png 记账会让 128MB 预算
        // 实际占住数倍内存，截图会话尤其明显（纯色图容器极小、像素极大）。
        c.image = Some(CapturedImage {
            png: vec![0u8; 10],
            width: 2,
            height: 2,
            rgba: vec![0u8; 16],
        });
        assert_eq!(
            estimate_content_bytes(&c),
            3 + 4 + 4 + 7 + 10 + 16,
            "图片记账必须包含解码后的 RGBA"
        );
    }

    fn queue_content(png: usize, rgba: usize) -> CapturedContent {
        CapturedContent {
            kind: "image".into(),
            text: String::new(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: Some(CapturedImage {
                png: vec![0u8; png],
                width: 1,
                height: 1,
                rgba: vec![0u8; rgba],
            }),
            source_app: "snippingtool.exe".into(),
            source_title: String::new(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    #[test]
    fn oversized_capture_drops_rgba_to_stay_inside_queue_budget() {
        // 记账修正后，一张超大截图的 RGBA 可能比整条队列预算还大。
        // 这时必须释放像素（工作线程按 png 重新解码）而不是丢弃用户的截图，
        // 否则名义 128MB 的预算在实际驻留几倍内存和漏记内容之间二选一。
        let mut big = queue_content(4 * 1024 * 1024, CONTENT_QUEUE_MAX_BYTES + 1);
        let weight = queue_weight_for(&mut big);
        assert!(
            weight <= CONTENT_QUEUE_MAX_BYTES,
            "超预算条目必须收敛到预算内：{weight}"
        );
        let img = big.image.as_ref().unwrap();
        assert!(img.rgba.is_empty(), "只允许释放解码像素");
        assert_eq!(img.png.len(), 4 * 1024 * 1024, "原图字节必须完整保留");
        let q = BoundedQueue::new(CONTENT_QUEUE_CAPACITY, CONTENT_QUEUE_MAX_BYTES);
        assert_eq!(
            q.push(big, weight),
            PushOutcome::Pushed,
            "超大截图仍需入库，不得因预算被拒"
        );

        let mut normal = queue_content(2 * 1024 * 1024, 8 * 1024 * 1024);
        assert_eq!(
            queue_weight_for(&mut normal),
            10 * 1024 * 1024 + "snippingtool.exe".len()
        );
        assert_eq!(
            normal.image.as_ref().unwrap().rgba.len(),
            8 * 1024 * 1024,
            "预算内的常规截图不得被动过"
        );
    }

    #[test]
    fn event_burst_is_bounded_and_keeps_latest_sequence() {
        let q = BoundedQueue::new(EVENT_QUEUE_CAPACITY, usize::MAX);
        let mut dropped = 0;
        for seq in 1..=100u32 {
            if q.push(seq, 1) == PushOutcome::DroppedOldest {
                dropped += 1;
            }
            assert!(q.len() <= EVENT_QUEUE_CAPACITY);
        }
        assert_eq!(dropped, 100 - EVENT_QUEUE_CAPACITY);
        let mut latest = q.try_pop().expect("队列应有事件");
        while let Some(next) = q.try_pop() {
            latest = next;
        }
        assert_eq!(latest, 100, "积压时只保留最新序列，不能伪造中间历史");
    }

    #[test]
    fn mixed_content_backlog_respects_count_and_byte_budgets() {
        let q = BoundedQueue::new(CONTENT_QUEUE_CAPACITY, 8 * 1024 * 1024);
        let mut dropped = 0;
        for i in 0..100 {
            let weight = if i % 5 == 0 {
                2 * 1024 * 1024
            } else {
                64 * 1024
            };
            if q.push(i, weight) == PushOutcome::DroppedOldest {
                dropped += 1;
            }
            assert!(q.len() <= CONTENT_QUEUE_CAPACITY);
        }
        assert!(dropped > 0, "超出容量必须丢弃最旧内容");
        let mut latest = None;
        while let Some(item) = q.try_pop() {
            latest = Some(item);
        }
        assert_eq!(latest, Some(99));
    }

    #[test]
    fn monitor_queue_stress_keeps_backlog_bounded() {
        let q = BoundedQueue::new(EVENT_QUEUE_CAPACITY, usize::MAX);
        let mut push_us = Vec::with_capacity(1000);
        let mut dropped = 0u64;
        let mut peak = 0usize;
        // 消费者故意落后：模拟截图/编码导致工作线程繁忙时的 1000 次快速复制事件
        for seq in 1..=1000u32 {
            let t = Instant::now();
            if q.push(seq, 1) == PushOutcome::DroppedOldest {
                dropped += 1;
            }
            push_us.push(t.elapsed().as_nanos() as f64 / 1000.0);
            peak = peak.max(q.len());
        }
        assert_eq!(peak, EVENT_QUEUE_CAPACITY);
        assert_eq!(dropped, 1000 - EVENT_QUEUE_CAPACITY as u64);
        let mut latest = q.try_pop().unwrap();
        while let Some(next) = q.try_pop() {
            latest = next;
        }
        assert_eq!(
            latest, 1000,
            "只保留最新序列，符合 Windows 剪贴板不可回放语义"
        );

        push_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p50 = push_us[push_us.len() / 2];
        let p95 = push_us[(push_us.len() as f64 * 0.95) as usize];
        println!(
            "monitor_queue_stress events=1000 peak={peak} dropped={dropped} push_p50_us={p50:.3} push_p95_us={p95:.3}"
        );

        let cq = BoundedQueue::new(CONTENT_QUEUE_CAPACITY, 128 * 1024 * 1024);
        let mut content_dropped = 0u64;
        for i in 0..100 {
            let weight = if i % 5 == 0 {
                2 * 1024 * 1024
            } else {
                64 * 1024
            };
            if cq.push(i, weight) == PushOutcome::DroppedOldest {
                content_dropped += 1;
            }
        }
        assert_eq!(content_dropped, 100 - CONTENT_QUEUE_CAPACITY as u64);
        println!(
            "monitor_content_stress items=100 peak={} dropped={content_dropped}",
            cq.len()
        );
    }

    fn captured(kind: &str, text: &str, source: &str) -> CapturedContent {
        CapturedContent {
            kind: kind.into(),
            text: text.into(),
            html: String::new(),
            preview: text.chars().take(20).collect(),
            file_paths: Vec::new(),
            image: None,
            source_app: source.into(),
            source_title: String::new(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    #[test]
    fn capture_filter_honors_pause_and_kind_toggles() {
        let paused = Settings {
            clipboard_paused: true,
            ..Default::default()
        };
        assert_eq!(
            filter_capture(&mut captured("text", "hello", "notepad.exe"), &paused),
            CaptureDecision::Skip("监听已暂停")
        );

        let no_images = Settings {
            clipboard_capture_images: false,
            ..Default::default()
        };
        assert_eq!(
            filter_capture(&mut captured("image", "", "mspaint.exe"), &no_images),
            CaptureDecision::Skip("未开启图片采集")
        );

        let no_files = Settings {
            clipboard_capture_files: false,
            ..Default::default()
        };
        assert_eq!(
            filter_capture(&mut captured("files", "", "explorer.exe"), &no_files),
            CaptureDecision::Skip("未开启文件采集")
        );

        let no_html = Settings {
            clipboard_capture_html: false,
            ..Default::default()
        };
        let mut html_with_text = captured("html", "纯文本兜底", "chrome.exe");
        html_with_text.html = "<b>纯文本兜底</b>".into();
        assert_eq!(
            filter_capture(&mut html_with_text, &no_html),
            CaptureDecision::Accept
        );
        assert_eq!(html_with_text.kind, "text");
        assert!(html_with_text.html.is_empty());

        let mut html_only = captured("html", "", "chrome.exe");
        html_only.html = "<b>只有富文本</b>".into();
        assert_eq!(
            filter_capture(&mut html_only, &no_html),
            CaptureDecision::Skip("未开启富文本采集且无纯文本")
        );
    }

    #[test]
    fn capture_filter_excludes_configured_apps() {
        let settings = Settings {
            clipboard_exclude_apps: "keepass.exe, 1password.exe".into(),
            ..Default::default()
        };
        let mut content = captured("text", "secret", "C:\\Tools\\KeePass.exe");
        assert_eq!(
            filter_capture(&mut content, &settings),
            CaptureDecision::Skip("来源应用在排除名单")
        );
    }

    /// 回归：Snipaste 等截图工具复制后立即关闭覆盖层，采集线程读取时前台
    /// 已切回 Task Dock，前台推断出的 source_app 会等于本进程 exe 名。
    /// 自身写入由自写序列号水位识别，过滤层不得再按前台推断丢弃外部内容。
    #[test]
    fn capture_filter_accepts_external_content_even_if_source_infers_own_app() {
        let own = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "task-dock.exe".into());
        let settings = Settings::default();
        let mut image = captured("image", "", &own);
        assert_eq!(
            filter_capture(&mut image, &settings),
            CaptureDecision::Accept,
            "前台推断为本进程不能作为丢弃外部内容的依据"
        );
        let mut text = captured("text", "截图说明文字", "task-dock.exe");
        assert_eq!(
            filter_capture(&mut text, &settings),
            CaptureDecision::Accept,
        );
    }

    #[test]
    fn capture_filter_uses_conservative_sensitive_policy_for_unknown_source() {
        let settings = Settings::default();
        let mut unknown = captured("text", "password = hunter2xx", "unknown");
        assert_eq!(
            filter_capture(&mut unknown, &settings),
            CaptureDecision::Skip("来源未知且命中保守敏感模式")
        );

        let mut known = captured("text", "password = hunter2xx", "notepad.exe");
        assert_eq!(
            filter_capture(&mut known, &settings),
            CaptureDecision::Accept,
            "保守凭据策略只用于来源未知，避免误伤已知应用的正常文本"
        );

        let mut key = captured("text", "AKIAABCDEFGHIJKLMNOP", "notepad.exe");
        assert_eq!(
            filter_capture(&mut key, &settings),
            CaptureDecision::Skip("命中高置信敏感特征"),
            "高置信密钥格式无论来源都应过滤"
        );
    }

    #[test]
    fn process_catching_panic_converts_panic_to_failed() {
        let outcome = process_catching_panic(|| panic!("模拟工作线程异常"));
        assert_eq!(outcome, ProcessOutcome::Failed);
    }

    /// `EmptyClipboard` 之后写入失败时，只有可完整比较的形态才谈得上「放回原内容」。
    ///
    /// 判错方向的代价不对称：拿残缺内容猜写会伪造用户剪贴板，留空只是丢一次内容。
    /// 所以这里既断言「可恢复的要能恢复」，也断言「不可恢复的必须判 None」。
    #[cfg(windows)]
    #[test]
    fn only_comparable_forms_can_be_put_back_after_failed_write() {
        use super::imp::payload_from_read;
        use ClipboardPayload as P;

        let text = payload_from_read(ClipboardRead::Content {
            sequence: 0,
            content: Box::new(captured("text", "原文", "notepad.exe")),
        });
        assert!(
            matches!(text, Some(P::Text { ref text, html: None }) if text == "原文"),
            "纯文本必须可回写"
        );

        let mut rich = captured("html", "", "chrome.exe");
        rich.html = "<b>hi</b>".into();
        assert!(
            matches!(
                payload_from_read(ClipboardRead::Content {
                    sequence: 0,
                    content: Box::new(rich)
                }),
                Some(P::Text { html: Some(_), .. })
            ),
            "只有 HTML 时也必须能按原样回写"
        );

        let mut image = captured("image", "", "snipping.exe");
        image.image = Some(CapturedImage {
            png: vec![1, 2, 3],
            width: 4,
            height: 2,
            rgba: vec![0u8; 4 * 2 * 4],
        });
        assert!(
            matches!(
                payload_from_read(ClipboardRead::Content {
                    sequence: 0,
                    content: Box::new(image)
                }),
                Some(P::Image {
                    width: 4,
                    height: 2,
                    ..
                })
            ),
            "图片必须带回 PNG 与 RGBA，重贴才不丢像素"
        );

        // 以下形态无法重建为等价内容：必须判为不可恢复，绝不猜写。
        let mut kind_says_image = captured("image", "", "snipping.exe");
        kind_says_image.image = None;
        assert_eq!(
            payload_from_read(ClipboardRead::Content {
                sequence: 0,
                content: Box::new(kind_says_image)
            }),
            None,
            "声称是图片却没解出像素时不能假装可恢复"
        );

        let mut no_paths = captured("files", "", "explorer.exe");
        no_paths.file_paths.clear();
        assert_eq!(
            payload_from_read(ClipboardRead::Content {
                sequence: 0,
                content: Box::new(no_paths)
            }),
            None,
            "文件列表为空时没有任何可回写的信息"
        );

        let mut empty_text = captured("text", "", "unknown");
        empty_text.text.clear();
        assert_eq!(
            payload_from_read(ClipboardRead::Content {
                sequence: 0,
                content: Box::new(empty_text)
            }),
            None,
            "空文本不是用户的原内容"
        );

        assert_eq!(payload_from_read(ClipboardRead::Empty("剪贴板为空")), None);
        assert_eq!(payload_from_read(ClipboardRead::Skip("格式不支持")), None);
    }

    /// 复现 P2-1（2026-11-03 评审）：恢复写入不得吞掉恢复出来的用户内容。
    ///
    /// 时序：用户复制 X（seq 1000，事件可能还在队列）→ 逐项粘贴写入 P
    /// （seq 1001，自写水位 1001）→ 粘贴结束恢复 X（seq 1002）。采集线程会把
    /// 积压事件合并成最新一条（seq 1002）；若恢复也把水位推到 1002，这条事件
    /// 会被判成 SelfWrite 跳过，X 就再没有入库机会。
    ///
    /// 期望：恢复不推进水位（仍为 1001）、恢复事件 1002 必须放行；当前实现会失败。
    #[test]
    fn restore_must_not_swallow_restored_content_event() {
        let self_write = AtomicU32::new(0);
        note_self_write_watermark(&self_write, 1001);
        assert!(finish_restore(Ok(())).is_ok(), "恢复收尾不应失败");

        let watermark = self_write.load(Ordering::SeqCst);
        assert_eq!(
            watermark, 1001,
            "恢复写入不得推进自写水位（推进后恢复事件会被当成自写）"
        );
        assert_eq!(
            classify_event(1002, 999, watermark),
            EventDisposition::Read,
            "恢复后的内容事件被判成自写：用户这次复制的唯一补偿事件被丢弃"
        );
    }

    /// 复现 P2-2（2026-11-03 评审）：清空后，清空前的内容不得凭新代数复活。
    ///
    /// 代数只在消息派发时盖章：清空前入队的事件会拿到清空后的新代数，
    /// 只靠代数门拦不住。序列号不晚于清空水位才是「清空前内容」的证据。
    #[test]
    fn clear_watermark_drops_events_from_before_the_clear() {
        let clear_sequence = 500u32;
        assert!(
            clear_supersedes(clear_sequence, clear_sequence),
            "清空前的最后一份内容必须丢弃"
        );
        assert!(clear_supersedes(499, clear_sequence));
        assert!(
            !clear_supersedes(501, clear_sequence),
            "清空后的新复制必须放行"
        );
        assert!(!clear_supersedes(500, 0), "从未清空历史时不得丢弃任何事件");
    }

    /// P2-7（2026-11-03 评审）：写入失败兜底只搬运原始格式字节，
    /// 不再为了「可能用不到」的恢复现场解码 PNG（4K 图 RGBA 约 33MB）。
    #[cfg(windows)]
    #[test]
    fn fallback_restore_passes_original_format_bytes() {
        use super::imp::{format_id, FallbackFormats};
        use windows_sys::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};

        let raw = FallbackFormats {
            text: Some("hello".into()),
            html: Some("<b>hi</b>".into()),
            png: Some(vec![0x89, b'P', b'N', b'G']),
            dib: Some(vec![1, 2, 3, 4]),
            files: Vec::new(),
        };
        let mut seen: Vec<(u32, Vec<u8>)> = Vec::new();
        assert!(raw.restore_with(|fmt, bytes| {
            seen.push((fmt, bytes.to_vec()));
            true
        }));
        assert!(seen
            .iter()
            .any(|(fmt, bytes)| *fmt == CF_UNICODETEXT as u32 && !bytes.is_empty()));
        assert!(seen.iter().any(|(fmt, _)| *fmt == format_id("PNG")));
        assert!(seen
            .iter()
            .any(|(fmt, bytes)| *fmt == CF_DIB as u32 && bytes.as_slice() == [1u8, 2, 3, 4]));
        assert!(
            !seen.iter().any(|(fmt, _)| *fmt == CF_HDROP as u32),
            "没有文件时不得写 CF_HDROP"
        );

        let blank = FallbackFormats {
            text: Some(String::new()),
            html: None,
            png: None,
            dib: None,
            files: Vec::new(),
        };
        assert!(blank.is_empty(), "空文本不算可恢复内容");
        assert!(!blank.restore_with(|_, _| true));
    }

    /// 修复回归（2026-11-03，采集丢失定位）：清空指令「记水位 → 推进代数」两步
    /// 之间盖章派发的清空后新复制带旧代数，不能因旧代数丢弃——否则用户
    /// 「清空历史后立即复制」会偶发丢失（症状：复制了却没出现）。
    #[test]
    fn post_clear_copy_stamped_with_old_epoch_survives_the_gate() {
        // 清空已发生：水位 100、当前代数 1；事件在两步窗口内盖章（代数 0），
        // 但复制发生在清空之后（序列号 105 > 100）：必须放行。
        assert!(
            !cleared_stale_gate(0, 1, 105, 100),
            "清空后的新复制不得被旧代数误杀"
        );
        // 内容层同样放行（读取发生在清空后，序列号是权威证据）。
        assert!(!cleared_stale_gate(0, 1, 101, 100));
        // 清空前的旧事件照旧丢弃：序列号不晚于水位。
        assert!(cleared_stale_gate(0, 1, 100, 100));
        assert!(cleared_stale_gate(0, 1, 99, 100));
        // 代数相同（正常路径）不因序列号丢弃。
        assert!(!cleared_stale_gate(1, 1, 99, 100));
        // 从未清空（水位 0）且代数变旧：保守维持旧语义丢弃。
        assert!(cleared_stale_gate(0, 1, 105, 0));
        // 未清空且代数相同：不丢。
        assert!(!cleared_stale_gate(0, 0, 105, 0));
    }

    /// 清空水位与代数的回绕安全：序列号回绕后复制的内容按回绕差仍晚于水位。
    #[test]
    fn clear_gate_is_wraparound_safe() {
        // 水位接近 u32::MAX，复制发生在回绕后（序列号很小但严格更晚）。
        let clear_sequence = u32::MAX - 2;
        assert!(!cleared_stale_gate(0, 1, 3, clear_sequence));
        // 回绕前的事件仍被丢弃。
        assert!(cleared_stale_gate(0, 1, clear_sequence, clear_sequence));
        assert!(cleared_stale_gate(0, 1, clear_sequence - 1, clear_sequence));
    }

    /// 队列淘汰必须保最新：容量淘汰丢最旧，字节预算淘汰也丢最旧，
    /// 且多连丢时淘汰计数按实际条数累加。
    #[test]
    fn bounded_queue_evicts_oldest_and_keeps_newest() {
        let q: BoundedQueue<u32> = BoundedQueue::new(3, usize::MAX);
        for v in 1..=5u32 {
            let (outcome, dropped) = q.push_counting(v, 1);
            if v <= 3 {
                assert_eq!(outcome, PushOutcome::Pushed);
                assert_eq!(dropped, 0);
            } else {
                assert_eq!(outcome, PushOutcome::DroppedOldest);
                assert_eq!(dropped, 1, "容量淘汰一次只丢一条");
            }
        }
        let mut kept = Vec::new();
        while let Some(v) = q.try_pop() {
            kept.push(v);
        }
        assert_eq!(kept, vec![3, 4, 5], "必须保最新，丢最旧");

        // 字节预算：预算 10，权重 4 的条目 → 每次腾到装得下为止，计数按实际条数。
        let q: BoundedQueue<u32> = BoundedQueue::new(usize::MAX, 10);
        let (outcome, dropped) = q.push_counting(1, 4);
        assert_eq!((outcome, dropped), (PushOutcome::Pushed, 0));
        let (outcome, dropped) = q.push_counting(2, 4);
        assert_eq!((outcome, dropped), (PushOutcome::Pushed, 0));
        // 8+4 > 10 → 丢掉 1（4 字节，剩 4），3 入队。
        let (outcome, dropped) = q.push_counting(3, 4);
        assert_eq!(outcome, PushOutcome::DroppedOldest);
        assert_eq!(dropped, 1);
        // 8+4 > 10 → 再丢 1（剩 4），4 入队。
        let (outcome, dropped) = q.push_counting(4, 4);
        assert_eq!(outcome, PushOutcome::DroppedOldest);
        assert_eq!(dropped, 1);
        let mut kept = Vec::new();
        while let Some(v) = q.try_pop() {
            kept.push(v);
        }
        assert_eq!(kept, vec![3, 4], "字节预算下仍保最新，丢最旧");
        // 预算极紧时一次 push 连丢多条：计数必须按实际条数累加（不能低报）。
        let q: BoundedQueue<u32> = BoundedQueue::new(usize::MAX, 10);
        let _ = q.push_counting(1, 4);
        let _ = q.push_counting(2, 4);
        // 8+8 > 10 → 连丢 2 条后才装得下。
        let (outcome, dropped) = q.push_counting(3, 8);
        assert_eq!(outcome, PushOutcome::DroppedOldest);
        assert_eq!(dropped, 2, "一次 push 连丢多条时淘汰计数按实际条数累加");
    }

    /// 单条超过队列字节预算：拒绝入队而不是无限膨胀，也不得误伤队列内已有条目。
    #[test]
    fn bounded_queue_rejects_items_larger_than_budget() {
        let q: BoundedQueue<u32> = BoundedQueue::new(8, 10);
        let (outcome, dropped) = q.push_counting(1, 11);
        assert_eq!((outcome, dropped), (PushOutcome::RejectedTooLarge, 0));
        assert_eq!(q.len(), 0);
        // 预算内条目仍可正常入队。
        let (outcome, dropped) = q.push_counting(2, 10);
        assert_eq!((outcome, dropped), (PushOutcome::Pushed, 0));
    }

    /// 读取占用的有界重排常量：总等待必须收敛（每次重排内部还有约 120ms 重试）。
    #[test]
    fn read_busy_retry_bound_is_small() {
        assert!(
            MAX_READ_BUSY_RETRIES <= 5,
            "占用重试必须有界，不得用无限重试换成功率"
        );
    }
}
