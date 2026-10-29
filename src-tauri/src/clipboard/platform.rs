//! Windows 剪贴板读写与监听（唯一触碰 Win32 剪贴板的模块）。
//!
//! 监听使用 `AddClipboardFormatListener` + 消息专用窗口；读取只识别
//! 文本 / HTML / PNG / DIB / 文件列表，无法安全解析的格式不记录。
//! 写入后记录剪贴板序列号，监听侧跳过 <= 该序列号的事件（自我写入隔离）。

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
use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

/// 监听数据汇：去重/设置检查/落库/广播都在这里，监听线程只负责读取。
pub struct CaptureSink {
    pub db: Arc<Db>,
    pub root: PathBuf,
    pub app: AppHandle,
    pub self_write: Arc<AtomicU32>,
}

#[derive(Debug)]
pub enum ClipboardRead {
    Content(Box<CapturedContent>),
    Skip(&'static str),
    Empty,
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

    /// 非阻塞入队：满时丢弃最旧的一条，保证最新事件一定能进入队列。
    pub(crate) fn push(&self, item: T, weight: usize) -> PushOutcome {
        if self.closed.load(Ordering::SeqCst) {
            return PushOutcome::Closed;
        }
        if weight > self.max_bytes {
            return PushOutcome::RejectedTooLarge;
        }
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut dropped = false;
        while st.items.len() >= self.capacity
            || (st.bytes.saturating_add(weight) > self.max_bytes && !st.items.is_empty())
        {
            let Some((_, w)) = st.items.pop_front() else {
                break;
            };
            st.bytes = st.bytes.saturating_sub(w);
            dropped = true;
        }
        st.items.push_back((item, weight));
        st.bytes = st.bytes.saturating_add(weight);
        self.cv.notify_one();
        if dropped {
            PushOutcome::DroppedOldest
        } else {
            PushOutcome::Pushed
        }
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

struct MonitorCounters {
    observed_events: AtomicU64,
    merged_events: AtomicU64,
    captured: AtomicU64,
    recorded: AtomicU64,
    duplicates: AtomicU64,
    skipped: AtomicU64,
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
            merged_events: AtomicU64::new(0),
            captured: AtomicU64::new(0),
            recorded: AtomicU64::new(0),
            duplicates: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
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
    pub merged_events: u64,
    pub captured: u64,
    pub recorded: u64,
    pub duplicates: u64,
    pub skipped: u64,
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
        merged_events: c.merged_events.load(Ordering::Relaxed),
        captured: c.captured.load(Ordering::Relaxed),
        recorded: c.recorded.load(Ordering::Relaxed),
        duplicates: c.duplicates.load(Ordering::Relaxed),
        skipped: c.skipped.load(Ordering::Relaxed),
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

fn estimate_content_bytes(c: &CapturedContent) -> usize {
    c.text.len()
        + c.html.len()
        + c.preview.len()
        + c.source_app.len()
        + c.source_title.len()
        + c.file_paths.iter().map(|p| p.len()).sum::<usize>()
        + c.image.as_ref().map(|i| i.png.len()).unwrap_or(0)
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
    if is_own_app(&content.source_app) {
        return CaptureDecision::Skip("来源是 Task Dock 自身");
    }
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

impl CaptureSink {
    /// 设置过滤 + 入库；只允许在工作线程调用，日志绝不包含正文。
    pub fn process(&self, mut content: CapturedContent) -> ProcessOutcome {
        let settings = Settings::load(&self.db).unwrap_or_default();
        if let CaptureDecision::Skip(reason) = filter_capture(&mut content, &settings) {
            tracing::debug!("剪贴板跳过：{}", reason);
            return ProcessOutcome::Skipped;
        }
        match store::record_capture(&self.db, &self.root, &content, &settings) {
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

fn is_own_app(source_app: &str) -> bool {
    let own = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    !own.is_empty() && source_app.eq_ignore_ascii_case(&own)
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

#[derive(Debug)]
pub struct Snapshot {
    pub sequence: u32,
    pub payload: Option<ClipboardPayload>,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// 写入成功，返回 CloseClipboard 之后读取的最终序列号
    /// （锁内读到的值可能因合成格式的延迟渲染而偏小）。
    Written(u32),
    /// 守卫拒绝：剪贴板内容或序列号已变化，本次没有执行 EmptyClipboard。
    SequenceChanged,
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

/// 当前剪贴板内容是否仍等于本进程写入的载荷。
///
/// Windows 会在 `CloseClipboard` 之后继续为合成/延迟渲染格式递增序列号，
/// 因此「序列号变化」不等于「用户换了内容」。粘贴前必须用内容比较兜底，
/// 既不能误停正常粘贴，也不能把用户后来复制的内容当成自己的。
pub(crate) fn payload_matches_read(
    expected: &ClipboardPayload,
    text: Option<&str>,
    html: Option<&str>,
    png: Option<&[u8]>,
    files: &[String],
) -> bool {
    match expected {
        ClipboardPayload::Text {
            text: expected_text,
            html: expected_html,
        } => {
            if !expected_text.is_empty() && text != Some(expected_text.as_str()) {
                return false;
            }
            match expected_html {
                Some(expected_html) => html == Some(expected_html.as_str()),
                // 纯文本写入不应带 HTML；若出现 HTML，说明剪贴板已是别处的内容
                None => html.is_none(),
            }
        }
        ClipboardPayload::Image {
            png: expected_png, ..
        } => !expected_png.is_empty() && png == Some(expected_png.as_slice()),
        ClipboardPayload::Files { paths } => {
            paths.len() == files.len()
                && paths
                    .iter()
                    .zip(files)
                    .all(|(a, b)| a.eq_ignore_ascii_case(b))
        }
    }
}

/// 内容不一致的诊断信息：只含格式名与字节数，绝不含正文、路径或图片内容。
pub(crate) fn payload_mismatch_detail(
    expected: &ClipboardPayload,
    text: Option<&str>,
    html: Option<&str>,
    png: Option<&[u8]>,
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
            "期望 png={}B；实际 png={:?}B",
            expected_png.len(),
            png.map(|p| p.len())
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
        WriteOutcome::Written(seq) => Ok(seq),
        WriteOutcome::SequenceChanged => {
            Err(AppError::Validation("剪贴板状态已变化，写入已取消".into()))
        }
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

/// 只有剪贴板内容仍是本进程最后一次写入时才恢复，绝不覆盖用户后来复制的内容。
///
/// 以内容而不是序列号为准：Windows 会在 CloseClipboard 后继续为合成格式递增序列号，
/// 序列号相等/不等都不能单独证明剪贴板属于谁。
pub fn restore_if_own_content(
    snapshot: &Snapshot,
    last_written: &ClipboardPayload,
) -> AppResult<RestoreOutcome> {
    let Some(payload) = snapshot.payload.as_ref() else {
        return Ok(RestoreOutcome::NoSnapshot);
    };
    imp::restore_if_own_content(payload, last_written)
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
        CloseHandle, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData,
        GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, RemoveClipboardFormatListener, SetClipboardData,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
        GetMessageW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        PostMessageW, PostQuitMessage, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG,
        WM_CLIPBOARDUPDATE, WM_CLOSE, WM_DESTROY, WNDCLASSW,
    };

    /// HTML / PNG 是注册格式，必须运行时获取 ID。
    fn format_id(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn current_sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

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

    unsafe fn read_png() -> Option<CapturedImage> {
        let fmt = format_id("PNG");
        if fmt == 0 {
            return None;
        }
        let bytes = get_bytes_format(fmt)?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return None;
        }
        let (rgba, w, h) = image::decode_png_rgba(&bytes).ok()?;
        Some(CapturedImage {
            png: bytes,
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

    unsafe fn read_dib() -> Option<CapturedImage> {
        let candidates = [CF_DIBV5 as u32, CF_DIB as u32];
        for fmt in candidates {
            if let Some(bytes) = get_bytes_format(fmt) {
                if bytes.len() > MAX_IMAGE_BYTES {
                    return None;
                }
                if let Some((rgba, w, h)) = image::dib_to_rgba(&bytes) {
                    let png = image::encode_png(&rgba, w, h).ok()?;
                    return Some(CapturedImage {
                        png,
                        width: w,
                        height: h,
                        rgba,
                    });
                }
            }
        }
        None
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

    fn foreground_source() -> (String, String) {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return ("unknown".into(), String::new());
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let title = window_title(hwnd);
            let exe = crate::navigation::window_manager::exe_path_of(pid).unwrap_or_default();
            let app = Path::new(&exe)
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if app.is_empty() {
                // 无法确认来源时显式标记 unknown，后续采用保守敏感策略。
                ("unknown".into(), title)
            } else {
                (app, title)
            }
        }
    }

    pub fn read_clipboard(ignore_markers: bool) -> ClipboardRead {
        let _access = lock_access();
        read_locked(ignore_markers)
    }

    fn read_locked(ignore_markers: bool) -> ClipboardRead {
        if !open_clipboard() {
            return ClipboardRead::Skip("剪贴板被其他程序占用");
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
        if event_sequence <= self_write.load(Ordering::SeqCst) {
            return ClipboardRead::Skip("本应用自身写入");
        }
        read_locked(ignore_markers)
    }

    /// 调用方必须已持有剪贴板锁；返回前不关闭。
    unsafe fn read_open(ignore_markers: bool) -> ClipboardRead {
        if !ignore_markers {
            if let Some(reason) = os_marker() {
                return ClipboardRead::Skip(reason);
            }
        }
        let text = read_text().unwrap_or_default();
        let html = read_html().unwrap_or_default();
        let files = read_files();
        let image = read_png().or_else(|| read_dib());

        let kind = match super::super::engine::classify(&text, &html, image.is_some(), &files) {
            Some(k) => k,
            None => return ClipboardRead::Empty,
        };
        if matches!(
            kind,
            super::super::KIND_TEXT | super::super::KIND_HTML | super::super::KIND_URL
        ) && text.len() > MAX_TEXT_BYTES
        {
            return ClipboardRead::Skip("文本超过采集上限");
        }
        let (source_app, source_title) = foreground_source();
        let preview = super::super::engine::make_preview(
            kind,
            &text,
            &html,
            &files,
            image.as_ref().map(|i| i.width),
            image.as_ref().map(|i| i.height),
        );
        ClipboardRead::Content(Box::new(CapturedContent {
            kind: kind.into(),
            text,
            html,
            preview,
            file_paths: files,
            image,
            source_app,
            source_title,
            byte_size: 0,
        }))
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
            };
        }
        let read = unsafe { read_open(true) };
        unsafe { close() };
        // 序列号必须在 CloseClipboard 之后读取：关闭时可能因合成格式继续递增，
        // 锁内读到的值会偏小，导致后续守卫误判“剪贴板已被其他程序更新”。
        let sequence = unsafe { GetClipboardSequenceNumber() };
        let payload = match read {
            ClipboardRead::Content(c) => match c.kind.as_str() {
                super::super::KIND_IMAGE => c.image.map(|i| ClipboardPayload::Image {
                    png: i.png,
                    rgba: Some(i.rgba),
                    width: i.width,
                    height: i.height,
                }),
                super::super::KIND_FILES if !c.file_paths.is_empty() => {
                    Some(ClipboardPayload::Files {
                        paths: c.file_paths,
                    })
                }
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
            },
            _ => None,
        };
        Snapshot { sequence, payload }
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
        let mut ok = true;
        if EmptyClipboard() == 0 {
            ok = false;
        }
        match payload {
            ClipboardPayload::Text { text, html } => {
                let mut primary_ok = false;
                if !text.is_empty() {
                    primary_ok |= set_bytes(CF_UNICODETEXT as u32, &text_utf16_bytes(text));
                }
                if let Some(html) = html {
                    let fmt = format_id("HTML Format");
                    if fmt != 0 {
                        // HTML 为目标所需时也视为主要格式；任一成功即可
                        primary_ok |= set_bytes(fmt, engine::cf_html(html).as_bytes());
                    }
                }
                ok &= primary_ok;
            }
            ClipboardPayload::Image {
                png,
                rgba,
                width,
                height,
            } => {
                let fmt = format_id("PNG");
                let mut primary_ok = false;
                if fmt != 0 && !png.is_empty() {
                    primary_ok |= set_bytes(fmt, png);
                }
                let dib = match rgba {
                    Some(rgba) if rgba.len() >= (*width as usize * *height as usize * 4) => {
                        Some(image::rgba_to_dib(rgba, *width, *height))
                    }
                    _ => image::decode_png_rgba(png)
                        .ok()
                        .map(|(r, w, h)| image::rgba_to_dib(&r, w, h)),
                };
                if let Some(dib) = dib {
                    primary_ok |= set_bytes(CF_DIB as u32, &dib);
                }
                ok &= primary_ok;
            }
            ClipboardPayload::Files { paths } => {
                let valid: Vec<String> = paths
                    .iter()
                    .filter(|p| {
                        let path = Path::new(p);
                        path.is_absolute() && path.exists()
                    })
                    .take(MAX_FILE_COUNT)
                    .cloned()
                    .collect();
                if valid.is_empty() {
                    ok = false;
                } else {
                    ok &= set_bytes(CF_HDROP as u32, &hdrop_bytes(&valid));
                    // 纯文本路径是辅助格式，失败不影响文件粘贴
                    let _ = set_bytes(
                        CF_UNICODETEXT as u32,
                        &text_utf16_bytes(&valid.join("\r\n")),
                    );
                }
            }
        }
        if !ok {
            return Err(AppError::Validation("写入剪贴板失败".into()));
        }
        Ok(GetClipboardSequenceNumber())
    }

    /// 调用方必须已持有剪贴板锁；读取全部可比较格式并判断内容是否一致。
    unsafe fn content_matches_open(expected: &ClipboardPayload) -> bool {
        let text = read_text();
        let html = read_html();
        let png = read_png_bytes();
        let files = read_files();
        let same = payload_matches_read(
            expected,
            text.as_deref(),
            html.as_deref(),
            png.as_deref(),
            &files,
        );
        if !same {
            // 只记录格式与字节数，绝不记录正文/路径/图片内容。
            tracing::debug!(
                "剪贴板内容不一致：{}",
                payload_mismatch_detail(
                    expected,
                    text.as_deref(),
                    html.as_deref(),
                    png.as_deref(),
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
        let allowed = unsafe {
            let sequence = GetClipboardSequenceNumber();
            match &guard {
                WriteGuard::Content(expected) => {
                    guard_allows(&guard, sequence, content_matches_open(expected))
                }
                _ => guard_allows(&guard, sequence, false),
            }
        };
        if !allowed {
            unsafe { CloseClipboard() };
            return Ok(WriteOutcome::SequenceChanged);
        }
        let written = unsafe { write_open(payload) };
        unsafe { CloseClipboard() };
        match written {
            // Windows 可能在 CloseClipboard 之后继续为合成/延迟渲染格式递增序列号，
            // 锁内读到的值不是最终值。必须返回关闭后的序列号，调用方仍需内容比较兜底。
            Ok(_) => {
                let final_seq = unsafe { GetClipboardSequenceNumber() };
                if let Some(sw) = notify {
                    // 仍在访问锁内：采集线程的锁内复核必然读到该值，
                    // 不会再为本次写入打开剪贴板。
                    sw.fetch_max(final_seq, Ordering::SeqCst);
                }
                Ok(WriteOutcome::Written(final_seq))
            }
            Err(e) => Err(e),
        }
    }

    pub fn restore_if_own_content(
        snapshot_payload: &ClipboardPayload,
        last_written: &ClipboardPayload,
    ) -> AppResult<RestoreOutcome> {
        let _access = lock_access();
        if !open_clipboard() {
            return Err(AppError::Validation(
                "剪贴板被其他程序占用，未能恢复原内容".into(),
            ));
        }
        // 只有内容仍是本进程最后一次写入时才恢复；序列号增长不作为恢复依据。
        let matches = unsafe { content_matches_open(last_written) };
        if !matches {
            unsafe { CloseClipboard() };
            return Ok(RestoreOutcome::KeepUserCopy);
        }
        let restored = unsafe { write_open(snapshot_payload) };
        unsafe { CloseClipboard() };
        match restored {
            Ok(_) => Ok(RestoreOutcome::Restored),
            Err(e) => Err(e),
        }
    }

    pub fn clipboard_match(expected: &ClipboardPayload) -> ClipboardMatch {
        let _access = lock_access();
        if !open_clipboard() {
            tracing::debug!("剪贴板比较：无法打开剪贴板（可能被其他程序占用）");
            return ClipboardMatch::Unavailable;
        }
        let same = unsafe { content_matches_open(expected) };
        unsafe { close() };
        if same {
            ClipboardMatch::Same
        } else {
            ClipboardMatch::Different
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
        seen: Instant,
    }

    static EVENT_QUEUE: Mutex<Option<Arc<BoundedQueue<RawEvent>>>> = Mutex::new(None);

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CLIPBOARDUPDATE => {
                // 消息线程只做一件事：记录序列号并放入有界队列。
                // 图片解码、PNG 编码、SQLite 写入都在后台线程完成。
                let seq = GetClipboardSequenceNumber();
                if let Ok(guard) = EVENT_QUEUE.lock() {
                    if let Some(q) = guard.as_ref() {
                        MONITOR_COUNTERS
                            .observed_events
                            .fetch_add(1, Ordering::Relaxed);
                        match q.push(
                            RawEvent {
                                sequence: seq,
                                seen: Instant::now(),
                            },
                            1,
                        ) {
                            PushOutcome::Pushed => MonitorCounters::bump_peak(
                                &MONITOR_COUNTERS.peak_event_queue,
                                q.len(),
                            ),
                            PushOutcome::DroppedOldest => {
                                MONITOR_COUNTERS
                                    .dropped_events
                                    .fetch_add(1, Ordering::Relaxed);
                                MonitorCounters::bump_peak(
                                    &MONITOR_COUNTERS.peak_event_queue,
                                    q.len(),
                                );
                            }
                            _ => {}
                        }
                    }
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
        content_q: Arc<BoundedQueue<CapturedContent>>,
        thread: Option<std::thread::JoinHandle<()>>,
        capture: Option<std::thread::JoinHandle<()>>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl ClipboardMonitor {
        pub fn start(sink: Arc<CaptureSink>) -> AppResult<Self> {
            let event_q = Arc::new(BoundedQueue::new(EVENT_QUEUE_CAPACITY, usize::MAX));
            {
                let mut guard = EVENT_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
                if guard.is_some() {
                    return Err(AppError::Validation("剪贴板监听已在运行".into()));
                }
                *guard = Some(event_q.clone());
            }
            let (ready_tx, ready_rx) = mpsc::channel::<Result<isize, String>>();
            let thread = std::thread::Builder::new()
                .name("clipboard-monitor".into())
                .spawn(move || unsafe { run_message_loop(ready_tx) })
                .map_err(AppError::Io)?;
            let hwnd = match ready_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(h)) => h,
                Ok(Err(e)) => {
                    let _ = thread.join();
                    reset_queue();
                    return Err(AppError::Validation(format!("剪贴板监听启动失败: {e}")));
                }
                Err(_) => {
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
                    return Err(AppError::Io(e));
                }
            };
            Ok(Self {
                hwnd,
                event_q,
                content_q,
                thread: Some(thread),
                capture: Some(capture),
                worker: Some(worker),
            })
        }

        pub fn stop(mut self) {
            self.event_q.close();
            reset_queue();
            unsafe {
                PostMessageW(self.hwnd as HWND, WM_CLOSE, 0, 0);
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
            if let Some(c) = self.capture.take() {
                let _ = c.join();
            }
            self.content_q.close();
            if let Some(w) = self.worker.take() {
                let _ = w.join();
            }
        }
    }

    fn reset_queue() -> Option<Arc<BoundedQueue<RawEvent>>> {
        EVENT_QUEUE.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn spawn_capture_thread(
        event_q: Arc<BoundedQueue<RawEvent>>,
        content_q: Arc<BoundedQueue<CapturedContent>>,
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
                        if next.sequence > ev.sequence {
                            ev = next;
                            MONITOR_COUNTERS
                                .merged_events
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    if ev.sequence <= last {
                        continue;
                    }
                    last = ev.sequence;
                    if ev.sequence <= sink.self_write.load(Ordering::SeqCst) {
                        continue;
                    }
                    let settings = Settings::load(&sink.db).unwrap_or_default();
                    if !settings.clipboard_enabled || settings.clipboard_paused {
                        continue;
                    }
                    match read_clipboard_for_event(false, ev.sequence, &sink.self_write) {
                        ClipboardRead::Content(c) => {
                            MONITOR_COUNTERS.captured.fetch_add(1, Ordering::Relaxed);
                            let latency = ev.seen.elapsed().as_millis() as u64;
                            MONITOR_COUNTERS
                                .max_capture_latency_ms
                                .fetch_max(latency, Ordering::Relaxed);
                            let weight = estimate_content_bytes(&c);
                            match content_q.push(*c, weight) {
                                PushOutcome::Pushed => MonitorCounters::bump_peak(
                                    &MONITOR_COUNTERS.peak_content_queue,
                                    content_q.len(),
                                ),
                                PushOutcome::DroppedOldest => {
                                    MONITOR_COUNTERS
                                        .dropped_contents
                                        .fetch_add(1, Ordering::Relaxed);
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
                            MONITOR_COUNTERS.skipped.fetch_add(1, Ordering::Relaxed);
                            tracing::debug!("剪贴板跳过：{}", reason);
                        }
                        ClipboardRead::Empty => {}
                    }
                }
            })
    }

    fn spawn_process_thread(
        content_q: Arc<BoundedQueue<CapturedContent>>,
        sink: Arc<CaptureSink>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        std::thread::Builder::new()
            .name("clipboard-worker".into())
            .spawn(move || {
                while let Some(content) = content_q.pop() {
                    let started = Instant::now();
                    match process_catching_panic(|| sink.process(content)) {
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

    unsafe fn run_message_loop(ready: mpsc::Sender<Result<isize, String>>) {
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
        ClipboardRead::Empty
    }

    pub fn read_clipboard_for_event(
        _ignore_markers: bool,
        _event_sequence: u32,
        _self_write: &AtomicU32,
    ) -> ClipboardRead {
        ClipboardRead::Empty
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
    ) -> AppResult<RestoreOutcome> {
        Err(AppError::Validation("当前平台不支持剪贴板恢复".into()))
    }

    pub fn snapshot() -> Snapshot {
        Snapshot {
            sequence: 0,
            payload: None,
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
        pub fn stop(self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn payload_match_requires_same_text_and_html_presence() {
        let plain = ClipboardPayload::Text {
            text: "验收".into(),
            html: None,
        };
        assert!(payload_matches_read(&plain, Some("验收"), None, None, &[]));
        assert!(!payload_matches_read(&plain, Some("别的"), None, None, &[]));
        assert!(
            !payload_matches_read(&plain, Some("验收"), Some("<b>验收</b>"), None, &[]),
            "纯文本项遇到 HTML 必须视为内容已换"
        );
        let rich = ClipboardPayload::Text {
            text: "验收".into(),
            html: Some("<b>验收</b>".into()),
        };
        assert!(payload_matches_read(
            &rich,
            Some("验收"),
            Some("<b>验收</b>"),
            None,
            &[]
        ));
        assert!(!payload_matches_read(
            &rich,
            Some("验收"),
            Some("<i>验收</i>"),
            None,
            &[]
        ));
    }

    #[test]
    fn payload_match_compares_image_bytes_and_file_names() {
        let image = ClipboardPayload::Image {
            png: vec![1, 2, 3],
            rgba: None,
            width: 1,
            height: 1,
        };
        assert!(payload_matches_read(
            &image,
            None,
            None,
            Some(&[1, 2, 3]),
            &[]
        ));
        assert!(!payload_matches_read(
            &image,
            None,
            None,
            Some(&[1, 2, 4]),
            &[]
        ));
        assert!(!payload_matches_read(&image, None, None, None, &[]));
        let files = ClipboardPayload::Files {
            paths: vec!["C:\\Temp\\a.txt".into()],
        };
        assert!(payload_matches_read(
            &files,
            None,
            None,
            None,
            &["c:\\temp\\A.TXT".into()]
        ));
        assert!(!payload_matches_read(
            &files,
            None,
            None,
            None,
            &["C:\\Temp\\b.txt".into()]
        ));
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
}
