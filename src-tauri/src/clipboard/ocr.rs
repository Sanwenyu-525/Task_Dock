//! 轻量本地 OCR：按需调用 Windows.Media.Ocr 识别剪贴板图片中的文字。
//!
//! 设计约束（见 docs/clipboard/OCR.md）：
//! - 不常驻、不预加载、不在启动时初始化引擎；每次请求在阻塞线程里临时创建。
//! - 同一时刻最多 1 个识别任务（命令层配额 + 本模块闸门双重保护），重复请求不会排队。
//! - 只接受现有剪贴板条目 id，由 Rust 侧读取图片缓存，不通过 IPC 传整张图。
//! - 缓存按「条目 id + 内容哈希」关联，只存文字与元信息，不存解码图。
//! - 日志只记录状态、尺寸、耗时，不记录识别文本。

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{image, store, KIND_IMAGE};
use crate::db::Db;
use crate::error::AppError;

/// 单次识别超时（含排队后的纯识别时间）。
pub const OCR_TIMEOUT: Duration = Duration::from_secs(20);
/// 结果文本上限（字符）：超出只截断展示文本，行数照实记录。
pub const MAX_OCR_TEXT_CHARS: usize = 20_000;
/// 输入像素上限（超过则等比缩小后识别）。4K（约 830 万）原样保留，
/// 超宽拼接截图按面积收敛，避免 WinRT 侧再复制一份超大位图。
pub const OCR_MAX_PIXELS: u64 = 24_000_000;
/// 会话内缓存条目上限（LRU）。
pub const OCR_CACHE_ENTRIES: usize = 16;

pub const STATUS_OK: &str = "ok";
pub const STATUS_EMPTY: &str = "empty";
pub const STATUS_UNAVAILABLE: &str = "unavailable";
pub const STATUS_BUSY: &str = "busy";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_ERROR: &str = "error";

/// 引擎失败原因（不包含图片内容）。
enum RunError {
    Cancelled,
    Timeout,
    Unavailable(String),
    Failed(String),
}

/// 一次识别返回给前端的结构。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrReport {
    /// ok / empty / unavailable / busy / cancelled / error
    pub status: String,
    /// 机器可读原因：not_image / missing_image / engine_unavailable / busy /
    /// cancelled / timeout / read_failed / decode_failed / recognize_failed / internal
    pub code: String,
    pub text: String,
    pub reason: Option<String>,
    pub duration_ms: u64,
    pub cached: bool,
    pub lines: u32,
    pub chars: u32,
    pub width: u32,
    pub height: u32,
    pub engine: Option<String>,
    /// 确定性规则生成的建议标题（前端「设为标题」按钮直接使用，不自动写入）。
    pub suggested_title: Option<String>,
}

impl OcrReport {
    fn base(status: &str, code: &str) -> Self {
        Self {
            status: status.into(),
            code: code.into(),
            text: String::new(),
            reason: None,
            duration_ms: 0,
            cached: false,
            lines: 0,
            chars: 0,
            width: 0,
            height: 0,
            engine: None,
            suggested_title: None,
        }
    }

    pub fn busy(reason: &str) -> Self {
        let mut r = Self::base(STATUS_BUSY, "busy");
        r.reason = Some(reason.into());
        r
    }

    pub fn unavailable(code: &str, reason: &str) -> Self {
        let mut r = Self::base(STATUS_UNAVAILABLE, code);
        r.reason = Some(reason.into());
        r
    }

    pub fn error(code: &str, reason: &str, duration_ms: u64) -> Self {
        let mut r = Self::base(STATUS_ERROR, code);
        r.reason = Some(reason.into());
        r.duration_ms = duration_ms;
        r
    }

    fn cancelled(duration_ms: u64) -> Self {
        let mut r = Self::base(STATUS_CANCELLED, "cancelled");
        r.reason = Some("识别已取消".into());
        r.duration_ms = duration_ms;
        r
    }
}

struct CacheEntry {
    item_id: String,
    hash: String,
    report: OcrReport,
}

impl CacheEntry {
    fn matches(&self, item_id: &str, hash: &str) -> bool {
        self.item_id == item_id && self.hash == hash
    }
}

/// 有界 LRU：新条目在尾部，命中后移到尾部，超限从头部淘汰。
#[derive(Default)]
struct Cache {
    entries: VecDeque<CacheEntry>,
}

impl Cache {
    fn get(&mut self, item_id: &str, hash: &str) -> Option<OcrReport> {
        let pos = self.entries.iter().position(|e| e.matches(item_id, hash))?;
        let entry = self.entries.remove(pos)?;
        let mut report = entry.report.clone();
        report.cached = true;
        report.duration_ms = 0;
        let keep = entry;
        self.entries.push_back(keep);
        Some(report)
    }

    fn put(&mut self, item_id: &str, hash: &str, report: &OcrReport) {
        self.entries.retain(|e| !e.matches(item_id, hash));
        self.entries.push_back(CacheEntry {
            item_id: item_id.into(),
            hash: hash.into(),
            report: report.clone(),
        });
        while self.entries.len() > OCR_CACHE_ENTRIES {
            self.entries.pop_front();
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

struct RunningTask {
    request_id: String,
    cancel: Arc<AtomicBool>,
}

/// OCR 会话服务：闸门 + 缓存 + 取消登记。挂在 `ClipboardRuntime` 上，进程内单例。
pub struct OcrService {
    busy: AtomicBool,
    running: Mutex<Option<RunningTask>>,
    cache: Mutex<Cache>,
}

impl Default for OcrService {
    fn default() -> Self {
        Self::new()
    }
}

impl OcrService {
    pub fn new() -> Self {
        Self {
            busy: AtomicBool::new(false),
            running: Mutex::new(None),
            cache: Mutex::new(Cache::default()),
        }
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// 只取消匹配的请求，避免切换条目后旧页面的取消误伤新请求。
    pub fn cancel(&self, request_id: &str) -> bool {
        let Ok(guard) = self.running.lock() else {
            return false;
        };
        match guard.as_ref() {
            Some(task) if task.request_id == request_id => {
                task.cancel.store(true, Ordering::Release);
                true
            }
            _ => false,
        }
    }

    /// 冷缓存时记录缓存条目数（测试与诊断用）。
    pub fn cached_entries(&self) -> usize {
        self.cache.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// 同步执行一次识别。调用方必须在阻塞线程上运行，不得在 UI 线程直接调用。
    pub fn recognize(
        &self,
        db: &Db,
        root: &Path,
        item_id: &str,
        request_id: &str,
    ) -> OcrReport {
        let started = Instant::now();
        let item = match store::get_item(db, item_id) {
            Ok(item) => item,
            Err(AppError::NotFound(msg)) => return OcrReport::unavailable("missing_image", &msg),
            Err(e) => return OcrReport::error("internal", &e.to_string(), 0),
        };
        if item.kind != KIND_IMAGE || !item.has_image {
            return OcrReport::unavailable("not_image", "该条目没有可识别的图片");
        }
        let hash = match store::content_hash(db, item_id) {
            Ok(Some(hash)) => hash,
            Ok(None) => return OcrReport::unavailable("missing_image", "图片记录不存在"),
            Err(e) => return OcrReport::error("internal", &e.to_string(), 0),
        };

        if let Some(hit) = self.cache_get(item_id, &hash) {
            return hit;
        }

        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return OcrReport::busy("另一张图片正在识别，请稍后重试");
        }
        let _lease = BusyLease { service: self };

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let Ok(mut slot) = self.running.lock() else {
                return OcrReport::error("internal", "识别任务状态不可用", 0);
            };
            *slot = Some(RunningTask {
                request_id: request_id.into(),
                cancel: cancel.clone(),
            });
        }

        let path = match store::image_abs_path(db, root, item_id) {
            Some(path) => path,
            None => return OcrReport::unavailable("missing_image", "图片文件不存在"),
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return OcrReport::unavailable("missing_image", "图片文件无法读取"),
        };
        let (rgba, width, height) = match image::decode_png_rgba(&bytes) {
            Ok(decoded) => decoded,
            Err(e) => {
                return OcrReport::error(
                    "decode_failed",
                    &e.to_string(),
                    started.elapsed().as_millis() as u64,
                )
            }
        };
        drop(bytes);

        let (pixels, scaled_w, scaled_h) = scale_for_ocr(rgba, width, height);

        let result = recognize_pixels(pixels, scaled_w, scaled_h, &cancel, started);
        let duration_ms = started.elapsed().as_millis() as u64;
        let report = match result {
            Err(RunError::Cancelled) => OcrReport::cancelled(duration_ms),
            Err(RunError::Timeout) => {
                OcrReport::error("timeout", "识别超时，请稍后重试或用更小的图片", duration_ms)
            }
            Err(RunError::Unavailable(msg)) => {
                OcrReport::unavailable("engine_unavailable", &msg)
            }
            Err(RunError::Failed(msg)) => {
                OcrReport::error("recognize_failed", &msg, duration_ms)
            }
            Ok(out) => {
                let text = normalize_ocr_text(&out.text);
                let chars = text.chars().count() as u32;
                let mut report = OcrReport::base(
                    if text.is_empty() { STATUS_EMPTY } else { STATUS_OK },
                    if text.is_empty() { "no_text" } else { "ok" },
                );
                if text.is_empty() {
                    report.reason = Some("未识别到文字".into());
                }
                report.text = truncate_text(text);
                report.lines = out.lines;
                report.chars = chars.min(MAX_OCR_TEXT_CHARS as u32);
                report.width = width;
                report.height = height;
                report.engine = Some(out.engine);
                report.duration_ms = duration_ms;
                report.suggested_title = crate::clipboard::engine::title_from_ocr(&report.text);
                report
            }
        };

        if matches!(report.status.as_str(), STATUS_OK | STATUS_EMPTY) {
            self.cache_put(item_id, &hash, &report);
        }
        tracing::debug!(
            status = report.status,
            code = report.code,
            width = report.width,
            height = report.height,
            duration_ms = report.duration_ms,
            cached = report.cached,
            "剪贴板 OCR"
        );
        report
    }

    fn cache_get(&self, item_id: &str, hash: &str) -> Option<OcrReport> {
        self.cache.lock().ok()?.get(item_id, hash)
    }

    fn cache_put(&self, item_id: &str, hash: &str, report: &OcrReport) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.put(item_id, hash, report);
        }
    }
}

/// 退出作用域时释放闸门与进行中登记（正常返回、提前返回、panic 都覆盖）。
struct BusyLease<'a> {
    service: &'a OcrService,
}

impl Drop for BusyLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.service.running.lock() {
            *slot = None;
        }
        self.service.busy.store(false, Ordering::Release);
    }
}

/// 超过单边/像素上限时等比缩小；返回最终像素与尺寸。
fn scale_for_ocr(rgba: Vec<u8>, width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let max_edge = windows_ocr_max_dimension() as u64;
    let pixels = width as u64 * height as u64;
    if pixels <= OCR_MAX_PIXELS && (width as u64) <= max_edge && (height as u64) <= max_edge {
        return (rgba, width, height);
    }
    let area_scale = (OCR_MAX_PIXELS as f64 / pixels as f64).sqrt();
    let edge_scale = max_edge as f64 / width.max(height) as f64;
    let scale = area_scale.min(edge_scale).min(1.0);
    let w = ((width as f64 * scale).round().max(1.0)) as u32;
    let h = ((height as f64 * scale).round().max(1.0)) as u32;
    (downscale_box(&rgba, width, height, w, h), w, h)
}

/// 区域平均缩小（只用于超出上限的超大截图）。
fn downscale_box(rgba: &[u8], w: u32, h: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dw as usize) * (dh as usize) * 4];
    if w == 0 || h == 0 || dw == 0 || dh == 0 {
        return out;
    }
    for dy in 0..dh {
        let sy0 = (dy as u64 * h as u64 / dh as u64) as u32;
        let sy1 = (((dy + 1) as u64 * h as u64 / dh as u64) as u32)
            .max(sy0 + 1)
            .min(h);
        for dx in 0..dw {
            let sx0 = (dx as u64 * w as u64 / dw as u64) as u32;
            let sx1 = (((dx + 1) as u64 * w as u64 / dw as u64) as u32)
                .max(sx0 + 1)
                .min(w);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy as usize) * (w as usize) + sx as usize) * 4;
                    r += rgba[i] as u32;
                    g += rgba[i + 1] as u32;
                    b += rgba[i + 2] as u32;
                    n += 1;
                }
            }
            let o = ((dy as usize) * (dw as usize) + dx as usize) * 4;
            out[o] = (r / n.max(1)) as u8;
            out[o + 1] = (g / n.max(1)) as u8;
            out[o + 2] = (b / n.max(1)) as u8;
            out[o + 3] = 255;
        }
    }
    out
}

fn truncate_text(text: String) -> String {
    if text.chars().count() <= MAX_OCR_TEXT_CHARS {
        return text;
    }
    let mut out: String = text.chars().take(MAX_OCR_TEXT_CHARS).collect();
    out.push('…');
    out
}

/// Windows OCR 单边尺寸上限（Win10/11 为 10000）。
fn windows_ocr_max_dimension() -> u32 {
    windows::Media::Ocr::OcrEngine::MaxImageDimension().unwrap_or(10_000)
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
    )
}

fn is_full_width_punct(c: char) -> bool {
    matches!(
        c,
        '，' | '。'
            | '、'
            | '；'
            | '：'
            | '？'
            | '！'
            | '（'
            | '）'
            | '「'
            | '」'
            | '『'
            | '』'
            | '《'
            | '》'
            | '【'
            | '】'
            | '…'
            | '·'
    )
}

pub fn contains_cjk(text: &str) -> bool {
    text.chars().any(is_cjk)
}

fn contains_latin_or_digit(text: &str) -> bool {
    text.chars().any(|c| c.is_ascii_alphanumeric())
}

/// 清理 Windows OCR 输出：中文逐字空格、数字间空格、全角标点两侧空格，
/// 以及数字语境下的全角 `．：－／`。只做确定性规则，不猜测内容。
pub fn normalize_ocr_text(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.replace("\r\n", "\n").split('\n') {
        let tightened = tighten_line(line);
        let trimmed = tightened.trim();
        if trimmed.is_empty() && lines.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        lines.push(trimmed.to_string());
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

fn tighten_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        if c != ' ' && c != '\u{00A0}' {
            out.push(c);
            continue;
        }
        let prev = out.iter().rev().find(|c| **c != ' ');
        let next = chars[i + 1..].iter().find(|c| **c != ' ' && **c != '\u{00A0}');
        let join = match (prev, next) {
            (Some(&p), Some(&n)) => {
                (is_cjk(p) && is_cjk(n))
                    || (p.is_ascii_digit() && n.is_ascii_digit())
                    || is_full_width_punct(p)
                    || is_full_width_punct(n)
            }
            _ => false,
        };
        if !join {
            out.push(' ');
        }
    }
    let mut fixed: String = out.iter().copied().collect();
    for (full, half) in [('．', '.'), ('：', ':'), ('－', '-'), ('／', '/')] {
        fixed = fix_full_width_in_ascii_context(&fixed, full, half);
    }
    fixed
}

fn fix_full_width_in_ascii_context(s: &str, full: char, half: char) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c != full {
            out.push(c);
            continue;
        }
        let prev = i.checked_sub(1).and_then(|j| chars.get(j)).copied();
        let next = chars.get(i + 1).copied();
        match (prev, next) {
            (Some(p), Some(n)) if p.is_ascii_alphanumeric() && n.is_ascii_alphanumeric() => {
                out.push(half)
            }
            _ => out.push(c),
        }
    }
    out
}

struct Recognized {
    lines: u32,
    text: String,
    engine: String,
}

/// 引擎选择：中文优先（本机中文用户的中英混排截图更常见），
/// 纯拉丁/数字结果再补一次英文引擎（中文引擎会把数字与半角符号识别成近似字形）。
fn recognize_pixels(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    cancel: &AtomicBool,
    started: Instant,
) -> Result<Recognized, RunError> {
    let _com = ComGuard::init();
    let languages = available_languages();
    if languages.is_empty() {
        return Err(RunError::Unavailable(
            "本机未安装 Windows OCR 语言包（系统设置 > 时间和语言 > 语言中添加中文或英文）".into(),
        ));
    }
    let primary = pick_engine_tag(&languages, "zh")
        .or_else(|| pick_engine_tag(&languages, "en"))
        .or_else(|| languages.first().cloned())
        .ok_or_else(|| RunError::Unavailable("没有可用的 OCR 语言".into()))?;
    let (first_text, first_lines) =
        run_engine(&primary, &pixels, width, height, cancel, started)?;
    let normalized = normalize_ocr_text(&first_text);
    if !normalized.is_empty()
        && !contains_cjk(&normalized)
        && contains_latin_or_digit(&normalized)
        && !primary.starts_with("en")
    {
        if let Some(en) = pick_engine_tag(&languages, "en") {
            if let Ok((text, lines)) =
                run_engine(&en, &pixels, width, height, cancel, started)
            {
                let normalized_en = normalize_ocr_text(&text);
                if !normalized_en.is_empty() {
                    return Ok(Recognized {
                        lines,
                        text: normalized_en,
                        engine: en,
                    });
                }
            }
        }
    }
    Ok(Recognized {
        lines: first_lines,
        text: normalized,
        engine: primary,
    })
}

fn available_languages() -> Vec<String> {
    let Ok(langs) = windows::Media::Ocr::OcrEngine::AvailableRecognizerLanguages() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for i in 0..langs.Size().unwrap_or(0) {
        if let Ok(lang) = langs.GetAt(i) {
            if let Ok(tag) = lang.LanguageTag() {
                out.push(tag.to_string());
            }
        }
    }
    out
}

fn pick_engine_tag(languages: &[String], prefix: &str) -> Option<String> {
    languages
        .iter()
        .find(|tag| tag.to_lowercase().starts_with(prefix))
        .cloned()
}

fn run_engine(
    tag: &str,
    pixels: &[u8],
    width: u32,
    height: u32,
    cancel: &AtomicBool,
    started: Instant,
) -> Result<(String, u32), RunError> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Storage::Streams::DataWriter;

    let language = Language::CreateLanguage(&HSTRING::from(tag))
        .map_err(|e| RunError::Failed(format!("OCR 语言不可用: {e}")))?;
    let engine = windows::Media::Ocr::OcrEngine::TryCreateFromLanguage(&language)
        .map_err(|_| RunError::Failed("无法创建 OCR 引擎".into()))?;

    let writer =
        DataWriter::new().map_err(|e| RunError::Failed(format!("OCR 位图准备失败: {e}")))?;
    writer
        .WriteBytes(pixels)
        .map_err(|e| RunError::Failed(format!("OCR 位图写入失败: {e}")))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|e| RunError::Failed(format!("OCR 位图缓冲失败: {e}")))?;
    // OCR 引擎接受 Rgba8，省去一次 RGBA→BGRA 全量转换。
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Rgba8,
        width as i32,
        height as i32,
    )
    .map_err(|e| RunError::Failed(format!("OCR 位图创建失败: {e}")))?;
    drop(buffer);
    drop(writer);

    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| RunError::Failed(format!("OCR 启动失败: {e}")))?;

    loop {
        if cancel.load(Ordering::Acquire) {
            let _ = operation.Cancel();
            let _ = bitmap.Close();
            return Err(RunError::Cancelled);
        }
        match operation.Status() {
            Ok(status) => {
                use windows_future::AsyncStatus;
                match status {
                    AsyncStatus::Started => {}
                    AsyncStatus::Completed => break,
                    AsyncStatus::Canceled => {
                        let _ = bitmap.Close();
                        return Err(RunError::Cancelled);
                    }
                    AsyncStatus::Error => {
                        let _ = bitmap.Close();
                        return Err(RunError::Failed("OCR 引擎返回错误".into()));
                    }
                    // 未定义状态视为引擎异常，不猜测成功。
                    _ => {
                        let _ = bitmap.Close();
                        return Err(RunError::Failed("OCR 引擎返回未知状态".into()));
                    }
                }
            }
            Err(e) => {
                let _ = bitmap.Close();
                return Err(RunError::Failed(format!("OCR 状态读取失败: {e}")));
            }
        }
        if started.elapsed() >= OCR_TIMEOUT {
            let _ = operation.Cancel();
            let _ = bitmap.Close();
            return Err(RunError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(3));
    }
    let result = operation
        .GetResults()
        .map_err(|e| RunError::Failed(format!("OCR 结果读取失败: {e}")))?;
    let mut text = String::new();
    let mut lines = 0u32;
    if let Ok(list) = result.Lines() {
        lines = list.Size().unwrap_or(0);
        for i in 0..lines {
            if let Ok(line) = list.GetAt(i) {
                if !text.is_empty() {
                    text.push('\n');
                }
                if let Ok(t) = line.Text() {
                    text.push_str(&t.to_string());
                }
            }
        }
    }
    let _ = bitmap.Close();
    Ok((text, lines))
}

/// 当前线程的 COM 初始化作用域；S_FALSE（已初始化）不负责反初始化。
struct ComGuard(bool);

impl ComGuard {
    fn init() -> Self {
        let hr = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        Self(hr.is_ok() && hr.0 != 1)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                let _ = windows::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_removes_spaces_between_cjk() {
        assert_eq!(
            normalize_ocr_text("智 能 剪 贴 板 已 保 存"),
            "智能剪贴板已保存"
        );
    }

    #[test]
    fn normalize_joins_spaced_digits_and_fixes_full_width_punct() {
        assert_eq!(normalize_ocr_text("共 1 2 条 记录"), "共12条记录");
        assert_eq!(
            normalize_ocr_text("Task Dock v0 ． 5 ． 0 已 发 布"),
            "Task Dock v0.5.0 已发布"
        );
        assert_eq!(normalize_ocr_text("时 间 8 ： 30"), "时间8:30");
    }

    #[test]
    fn normalize_keeps_latin_word_spacing() {
        assert_eq!(
            normalize_ocr_text("OCR 320 ms, 共 18 行 文字"),
            "OCR 320 ms, 共18行文字"
        );
    }

    #[test]
    fn normalize_trims_and_drops_empty_lines() {
        assert_eq!(normalize_ocr_text("\n  \n第一行\n\n第二行  \n\n"), "第一行\n第二行");
    }

    #[test]
    fn cjk_detection() {
        assert!(contains_cjk("中文"));
        assert!(!contains_cjk("123 abc"));
    }

    #[test]
    fn cache_is_bounded_and_lru() {
        let service = OcrService::new();
        for i in 0..(OCR_CACHE_ENTRIES + 4) {
            let report = OcrReport::base(STATUS_OK, "ok");
            service.cache_put(&format!("id-{i}"), &format!("hash-{i}"), &report);
        }
        assert_eq!(service.cached_entries(), OCR_CACHE_ENTRIES);
        assert!(service.cache_get("id-0", "hash-0").is_none());
        assert!(service
            .cache_get(
                &format!("id-{}", OCR_CACHE_ENTRIES + 3),
                &format!("hash-{}", OCR_CACHE_ENTRIES + 3)
            )
            .is_some());
    }

    #[test]
    fn cache_hit_requires_same_content_hash() {
        let service = OcrService::new();
        let report = OcrReport::base(STATUS_OK, "ok");
        service.cache_put("id-1", "hash-1", &report);
        let hit = service.cache_get("id-1", "hash-1").expect("命中");
        assert!(hit.cached);
        assert!(service.cache_get("id-1", "hash-2").is_none());
        assert!(service.cache_get("id-2", "hash-1").is_none());
    }

    #[test]
    fn second_request_gets_busy_until_lease_released() {
        let service = OcrService::new();
        assert!(service
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok());
        {
            let lease = BusyLease { service: &service };
            assert!(service.is_busy());
            drop(lease);
        }
        assert!(!service.is_busy());
    }

    #[test]
    fn cancel_only_matches_current_request() {
        let service = OcrService::new();
        let cancel = Arc::new(AtomicBool::new(false));
        *service.running.lock().unwrap() = Some(RunningTask {
            request_id: "req-a".into(),
            cancel: cancel.clone(),
        });
        assert!(service.cancel("req-a"));
        assert!(cancel.load(Ordering::Acquire));
        assert!(!service.cancel("req-b"));
        assert!(!service.cancel(""));
    }

    #[test]
    fn scale_policy_keeps_normal_screenshot() {
        let rgba = vec![0u8; 4 * 4 * 4];
        let (pixels, w, h) = scale_for_ocr(rgba, 4, 4);
        assert_eq!((w, h), (4, 4));
        assert_eq!(pixels.len(), 4 * 4 * 4);
    }

    #[test]
    fn scale_policy_downsizes_oversized_image() {
        // 6000×4000 = 2400 万，刚好等于上限，不缩放
        let (_, w, h) = scale_for_ocr(vec![0u8; 4], 6000, 4000);
        assert_eq!((w, h), (6000, 4000));
        // 9000×6000 = 5400 万，按面积收敛
        let (_, w, h) = scale_for_ocr(vec![0u8; 4], 9000, 6000);
        assert!((w as u64 * h as u64) <= OCR_MAX_PIXELS);
        assert!(w <= 9000 && h <= 6000);
    }

    #[test]
    fn downscale_box_preserves_average_color() {
        let white = vec![255u8; 4 * 4 * 4];
        let out = downscale_box(&white, 4, 4, 2, 2);
        assert_eq!(out.len(), 2 * 2 * 4);
        assert!(out.chunks(4).all(|px| px == [255, 255, 255, 255]));
    }
}
