//! 轻量本地 OCR：按需调用 Windows.Media.Ocr 识别剪贴板图片中的文字。
//!
//! 设计约束（见 docs/clipboard/OCR.md）：
//! - 不常驻、不预加载、不在启动时初始化引擎；每次请求在阻塞线程里临时创建。
//! - 同一时刻最多 1 个识别任务（命令层配额 + 本模块闸门双重保护），重复请求不会排队。
//! - 只接受现有剪贴板条目 id，由 Rust 侧读取图片缓存，不通过 IPC 传整张图。
//! - 缓存按「条目 id + 内容哈希」关联，只存文字与元信息，不存解码图。
//! - 日志只记录状态、尺寸、耗时，不记录识别文本。

use std::collections::{HashMap, VecDeque};
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
/// 解码前像素上限：超过直接拒绝，不启动 OCR 引擎。
///
/// 解码后的 RGBA 是 `像素数 ×4`：24M 像素对应 96 MB 输入缓冲。
/// 只按容器字节判断不可靠——纯色/低熵 PNG 可以只有几十 KB 却解出几百 MB。
pub const OCR_MAX_DECODE_PIXELS: u64 = 24_000_000;
/// 单次 OCR 输入内存预算（字节），覆盖：解码 RGBA、缩放输出、DataWriter 缓冲、
/// SoftwareBitmap 副本、引擎自身与可能的双语言识别。
///
/// 依据本机实测：3000×2000（600 万像素）峰值约 101 MB；
/// 按同一倍数放大到 24M 像素约 400 MB，这里取 448 MiB 作为闸门。
/// 这是本机定值，不宣称适用于所有设备。
pub const OCR_INPUT_BUDGET_BYTES: u64 = 448 * 1024 * 1024;
/// WinRT 引擎与双语言识别的固定开销估值（字节）。
const OCR_ENGINE_OVERHEAD_BYTES: u64 = 64 * 1024 * 1024;
/// 引擎单边上限的保守回退值（实际值在解码后由 `MaxImageDimension` 查询）。
const OCR_ENGINE_MAX_EDGE_FALLBACK: u64 = 10_000;
/// 会话内缓存条目上限（LRU）。
pub const OCR_CACHE_ENTRIES: usize = 16;

pub const STATUS_OK: &str = "ok";
pub const STATUS_EMPTY: &str = "empty";
pub const STATUS_UNAVAILABLE: &str = "unavailable";
pub const STATUS_BUSY: &str = "busy";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_ERROR: &str = "error";
/// 图片超过解码前预算：明确与「没有识别到文字」区分。
pub const STATUS_TOO_LARGE: &str = "too_large";

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

    /// 超过解码前预算：不启动引擎，也不写成「没有识别到文字」。
    fn too_large(width: u32, height: u32, estimated_bytes: u64) -> Self {
        let mut r = Self::base(STATUS_TOO_LARGE, "image_too_large");
        r.reason = Some(format!(
            "图片过大（{width}×{height}，预估占用约 {} MB），请截取需要的局部后再识别",
            estimated_bytes / (1024 * 1024)
        ));
        r.width = width;
        r.height = height;
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
///
/// `epoch` 是轻量失效代数：删除/清空/维护清理都会自增。识别开始时记录代数，
/// 结束时只有代数未变才写回缓存，避免「已删条目」被迟到的任务重新写回。
#[derive(Default)]
struct Cache {
    entries: VecDeque<CacheEntry>,
    epoch: u64,
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

    /// 识别结束时的写回：代数已变（期间发生过删除/清空/清理）则不写。
    fn put_if_epoch(&mut self, item_id: &str, hash: &str, report: &OcrReport, epoch: u64) -> bool {
        if self.epoch != epoch {
            return false;
        }
        self.put(item_id, hash, report);
        true
    }

    fn invalidate(&mut self, items: &[String]) {
        if items.is_empty() {
            return;
        }
        self.entries
            .retain(|e| !items.iter().any(|id| id == &e.item_id));
        self.bump_epoch();
    }

    fn clear(&mut self) {
        // 即使当前没有缓存条目也要自增代数：清空历史时可能正好有识别任务在跑，
        // 它的迟到结果必须被丢弃（不能因为缓存为空就不失效）。
        self.entries.clear();
        self.bump_epoch();
    }

    /// 按「条目仍存在且内容哈希未变」校正缓存，只做淘汰，不推进代数。
    ///
    /// `snapshot` 是本次校正开始时已有的条目 id；快照之后新加的条目不动。
    /// 返回是否真的淘汰了条目（内容哈希变化也需要让在跑的旧任务失效，
    /// 由调用方决定是否推进代数）。
    fn retain_existing(&mut self, snapshot: &[String], current: &HashMap<String, String>) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| {
            if !snapshot.iter().any(|id| id == &e.item_id) {
                return true;
            }
            current.get(&e.item_id) == Some(&e.hash)
        });
        self.entries.len() != before
    }

    /// 数据库不可读、无法确认旧内容安全时的保守处置：整体丢弃并推进代数。
    fn discard_all(&mut self) {
        self.entries.clear();
        self.bump_epoch();
    }

    fn bump_epoch(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
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

    /// 当前进行中的请求标识（诊断与取消并发测试用，不含正文）。
    pub fn active_request(&self) -> Option<String> {
        self.running
            .lock()
            .ok()?
            .as_ref()
            .map(|task| task.request_id.clone())
    }

    /// 条目删除后只失效这些条目，其余缓存保留。
    pub fn invalidate_items(&self, item_ids: &[String]) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.invalidate(item_ids);
        }
    }

    /// 清空历史后整体失效；迟到任务因代数变化不会再写回。
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.clear();
        }
    }

    /// 推进缓存失效代数：让已经开始、尚未结束的识别任务在结束时放弃写回。
    ///
    /// 与「缓存校正」分开：真实删除（单条 / 整组 / 清空 / 过期清理）即使缓存为空，
    /// 也必须调用它，否则在跑的旧任务会把已删条目的结果写进缓存。
    pub fn advance_epoch(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.bump_epoch();
        }
    }

    /// 自动过期/维护清理后校正缓存：条目已删除或内容哈希变化即淘汰。
    ///
    /// `deleted` 表示本次操作是否**实际删除了条目**；为真时先推进代数（不依赖下面的
    /// 数据库查询结果），保证缓存为空、或数据库随后不可读时，在跑的旧任务也不会写回。
    /// 先在锁外快照条目 id，再逐条做短查询（最多 `OCR_CACHE_ENTRIES` 条），
    /// 不长时间持有缓存锁或数据库锁。
    /// 数据库不可读时无法确认旧内容安全：整体丢弃并推进代数，不假定旧缓存仍有效。
    pub fn retain_existing(&self, db: &Db, deleted: bool) {
        if deleted {
            self.advance_epoch();
        }
        let snapshot: Vec<String> = match self.cache.lock() {
            Ok(cache) => cache.entries.iter().map(|e| e.item_id.clone()).collect(),
            Err(_) => return,
        };
        if snapshot.is_empty() {
            return;
        }
        let mut current: HashMap<String, String> = HashMap::new();
        for id in &snapshot {
            match store::content_hash(db, id) {
                Ok(Some(hash)) => {
                    current.insert(id.clone(), hash);
                }
                // 条目已删除：不放进 current，随后淘汰。
                Ok(None) => {}
                // 数据库不可读：不能假定旧内容安全。
                Err(_) => {
                    if let Ok(mut cache) = self.cache.lock() {
                        cache.discard_all();
                    }
                    return;
                }
            }
        }
        if let Ok(mut cache) = self.cache.lock() {
            // 内容哈希变化说明旧结果已不对应当前内容，同样推进代数让在跑的旧任务失效。
            if cache.retain_existing(&snapshot, &current) {
                cache.bump_epoch();
            }
        }
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
        // 先记录代数再查条目：识别尚未登记时发生的删除/清空/清理，也必须让结果不写回。
        let cache_epoch = self.cache.lock().map(|c| c.epoch).unwrap_or(0);
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
        // 解码前闸门：只读 IHDR 宽高，不分配像素缓冲。超限直接拒绝，不启动引擎。
        let (hdr_w, hdr_h) = match image::png_dimensions(&bytes) {
            Ok(dim) => dim,
            Err(e) => {
                return OcrReport::error(
                    "decode_failed",
                    &e.to_string(),
                    started.elapsed().as_millis() as u64,
                )
            }
        };
        if let Some(estimated) = exceeds_decode_budget(hdr_w, hdr_h) {
            tracing::debug!(
                width = hdr_w,
                height = hdr_h,
                estimated_bytes = estimated,
                "剪贴板 OCR 图片超过解码前预算"
            );
            return OcrReport::too_large(hdr_w, hdr_h, estimated);
        }
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
            // 期间发生过删除/清空/清理（代数变化）时不写回，避免已删条目“复活”。
            if !self.cache_put(item_id, &hash, &report, cache_epoch) {
                tracing::debug!("剪贴板 OCR 结果未写缓存：缓存已失效");
            }
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

    /// 写回缓存；代数已变（期间发生过删除/清空/清理）时返回 `false`，不写入。
    fn cache_put(&self, item_id: &str, hash: &str, report: &OcrReport, epoch: u64) -> bool {
        let Ok(mut cache) = self.cache.lock() else {
            return false;
        };
        cache.put_if_epoch(item_id, hash, report, epoch)
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
    let (w, h) = target_ocr_size(width, height, windows_ocr_max_dimension() as u64);
    if w == width && h == height {
        return (rgba, width, height);
    }
    (downscale_box(&rgba, width, height, w, h), w, h)
}

/// 估算一次 OCR 输入的内存峰值（字节）：解码 RGBA + 缩放输出 +
/// DataWriter 缓冲 + SoftwareBitmap 副本 + 引擎/双语言开销。
fn estimate_ocr_input_bytes(width: u32, height: u32) -> u64 {
    let pixels = (width as u64).saturating_mul(height as u64);
    let (out_w, out_h) = target_ocr_size(width, height, OCR_ENGINE_MAX_EDGE_FALLBACK);
    let out_pixels = (out_w as u64).saturating_mul(out_h as u64);
    pixels
        .saturating_mul(4)
        .saturating_add(out_pixels.saturating_mul(4 * 3))
        .saturating_add(OCR_ENGINE_OVERHEAD_BYTES)
}

/// 解码前预算判定：返回超限时的估算字节数，`None` 表示可进入解码。
///
/// 几何像素上限与内存预算同时检查：只按文件大小判断会被高压缩率 PNG 绕过。
fn exceeds_decode_budget(width: u32, height: u32) -> Option<u64> {
    let pixels = (width as u64).saturating_mul(height as u64);
    let estimated = estimate_ocr_input_bytes(width, height);
    if pixels > OCR_MAX_DECODE_PIXELS || estimated > OCR_INPUT_BUDGET_BYTES {
        Some(estimated)
    } else {
        None
    }
}

/// 计算 OCR 输入尺寸：像素与单边都在上限内时保持不变，否则按面积/边长取小等比缩小。
/// 纯尺寸计算单独抽出，便于在不需要分配巨大像素缓冲的情况下验证策略。
fn target_ocr_size(width: u32, height: u32, max_edge: u64) -> (u32, u32) {
    let pixels = width as u64 * height as u64;
    if pixels <= OCR_MAX_PIXELS && (width as u64) <= max_edge && (height as u64) <= max_edge {
        return (width, height);
    }
    let area_scale = (OCR_MAX_PIXELS as f64 / pixels as f64).sqrt();
    let edge_scale = max_edge as f64 / width.max(height) as f64;
    let scale = area_scale.min(edge_scale).min(1.0);
    let w = ((width as f64 * scale).round().max(1.0)) as u32;
    let h = ((height as f64 * scale).round().max(1.0)) as u32;
    (w, h)
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
            | '．'
            | '－'
            | '／'
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
    // COM 初始化失败时不得继续识别；失败路径未增加引用计数，ComGuard 不会反初始化。
    let _com = ComGuard::init().map_err(|e| RunError::Unavailable(e.message()))?;
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

/// COM 初始化失败的明确原因；这两种情况都不得调用 `CoUninitialize`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComInitError {
    /// 线程已用不兼容的套间模型初始化（例如 STA），本次调用未增加引用计数。
    ChangedMode,
    /// 其他失败（`E_OUTOFMEMORY`、`E_FAIL` 等），本次调用未增加引用计数。
    Failed(i32),
}

impl ComInitError {
    fn message(self) -> String {
        match self {
            Self::ChangedMode => {
                "线程 COM 套间模型不兼容（RPC_E_CHANGED_MODE），无法使用 Windows OCR".into()
            }
            Self::Failed(code) => format!("COM 初始化失败（HRESULT 0x{code:08X}）"),
        }
    }
}

/// `CoInitializeEx` 返回值的处置分类（纯函数，便于在无 COM 环境验证）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComDisposition {
    /// `S_OK`（本次初始化）或 `S_FALSE`（线程已初始化，本次调用仍增加引用计数）：
    /// 两种情况都必须配对一次 `CoUninitialize`。
    MustUninitialize,
    ChangedMode,
    Failed,
}

fn com_disposition(hr: windows::core::HRESULT) -> ComDisposition {
    use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
    if hr == S_OK || hr == S_FALSE {
        ComDisposition::MustUninitialize
    } else if hr == RPC_E_CHANGED_MODE {
        ComDisposition::ChangedMode
    } else {
        ComDisposition::Failed
    }
}

/// 当前线程的 COM 初始化作用域（RAII）。
///
/// 声明在引擎/位图对象之前，作用域退出时先释放 COM 对象、最后反初始化。
struct ComGuard {
    owns_reference: bool,
}

impl ComGuard {
    fn init() -> Result<Self, ComInitError> {
        let hr = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        let owns_reference = match com_disposition(hr) {
            ComDisposition::MustUninitialize => true,
            ComDisposition::ChangedMode => return Err(ComInitError::ChangedMode),
            ComDisposition::Failed => return Err(ComInitError::Failed(hr.0)),
        };
        Ok(Self { owns_reference })
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.owns_reference {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
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
        // 中文与数字之间保留一个空格（OCR 逐字空格只在 CJK-CJK / 数字-数字之间合并）。
        assert_eq!(normalize_ocr_text("共 1 2 条 记录"), "共 12 条记录");
        assert_eq!(
            normalize_ocr_text("Task Dock v0 ． 5 ． 0 已 发 布"),
            "Task Dock v0.5.0 已发布"
        );
        assert_eq!(normalize_ocr_text("时 间 8 ： 30"), "时间 8:30");
    }

    #[test]
    fn normalize_keeps_latin_word_spacing() {
        assert_eq!(
            normalize_ocr_text("OCR 320 ms, 共 18 行 文字"),
            "OCR 320 ms, 共 18 行文字"
        );
    }

    #[test]
    fn normalize_trims_and_drops_empty_lines() {
        // 段落间最多保留一个空行，首尾空行去掉。
        assert_eq!(
            normalize_ocr_text("\n  \n第一行\n\n第二行  \n\n"),
            "第一行\n\n第二行"
        );
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
            let epoch = service.cache.lock().unwrap().epoch;
            service.cache_put(&format!("id-{i}"), &format!("hash-{i}"), &report, epoch);
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
        let epoch = service.cache.lock().unwrap().epoch;
        assert!(service.cache_put("id-1", "hash-1", &report, epoch));
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
        assert_eq!(target_ocr_size(4, 4, 10_000), (4, 4));
        // 6000×4000 = 2400 万，刚好等于上限，不缩放
        assert_eq!(target_ocr_size(6000, 4000, 10_000), (6000, 4000));
        // 4K 截图原样保留
        assert_eq!(target_ocr_size(3840, 2160, 10_000), (3840, 2160));
    }

    #[test]
    fn scale_policy_downsizes_oversized_image() {
        // 9000×6000 = 5400 万，按面积收敛到 24M 像素以内
        let (w, h) = target_ocr_size(9000, 6000, 10_000);
        assert!((w as u64 * h as u64) <= OCR_MAX_PIXELS);
        assert!(w <= 9000 && h <= 6000);
        // 单边超过 10000 时按边长收敛
        let (w2, h2) = target_ocr_size(20_000, 500, 10_000);
        assert!(w2 <= 10_000 && h2 <= 500);
    }

    #[test]
    fn downscale_box_preserves_average_color() {
        let white = vec![255u8; 4 * 4 * 4];
        let out = downscale_box(&white, 4, 4, 2, 2);
        assert_eq!(out.len(), 2 * 2 * 4);
        assert!(out.chunks(4).all(|px| px == [255, 255, 255, 255]));
    }

    #[test]
    fn com_disposition_pairs_s_ok_and_s_false() {
        use windows::Win32::Foundation::{E_FAIL, E_OUTOFMEMORY, RPC_E_CHANGED_MODE, S_FALSE, S_OK};
        // S_OK 与 S_FALSE 都是「本次调用成功」，都必须配对一次 CoUninitialize。
        assert_eq!(com_disposition(S_OK), ComDisposition::MustUninitialize);
        assert_eq!(com_disposition(S_FALSE), ComDisposition::MustUninitialize);
        // 模式冲突与其他失败不得反初始化。
        assert_eq!(com_disposition(RPC_E_CHANGED_MODE), ComDisposition::ChangedMode);
        assert_eq!(com_disposition(E_OUTOFMEMORY), ComDisposition::Failed);
        assert_eq!(com_disposition(E_FAIL), ComDisposition::Failed);
        assert!(ComInitError::ChangedMode.message().contains("套间"));
        assert!(ComInitError::Failed(E_FAIL.0).message().contains("0x8000"));
    }

    #[test]
    fn com_guard_balances_second_init_returning_s_false() {
        // 在独立线程验证：两次成功初始化（第二次必然是 S_FALSE）都要配对反初始化。
        // 反初始化后引用计数归零，再次初始化必须返回 S_OK 而不是 S_FALSE。
        std::thread::spawn(|| {
            {
                let first = ComGuard::init().expect("首次初始化");
                let second = ComGuard::init().expect("重复初始化（S_FALSE）仍算成功");
                drop(second);
                drop(first);
            }
            let hr = unsafe {
                windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                )
            };
            assert_eq!(
                hr,
                windows::Win32::Foundation::S_OK,
                "COM 引用计数未归零：S_FALSE 说明有初始化没有配对反初始化"
            );
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        })
        .join()
        .expect("COM 生命周期线程不应 panic");
    }

    #[test]
    fn com_guard_rejects_incompatible_apartment() {
        std::thread::spawn(|| {
            let hr = unsafe {
                windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
                )
            };
            assert_eq!(hr, windows::Win32::Foundation::S_OK);
            let err = ComGuard::init().err().expect("STA 线程上 MTA 初始化应失败");
            assert_eq!(err, ComInitError::ChangedMode);
            // 失败路径未增加引用计数，只反初始化本线程自己那次 STA 初始化。
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        })
        .join()
        .expect("COM 套间冲突线程不应 panic");
    }

    #[test]
    fn decode_budget_rejects_oversized_before_decoding() {
        // 4K 在预算内
        assert!(exceeds_decode_budget(3840, 2160).is_none());
        // 6000×4000 = 2400 万，处于允许上限
        assert!(exceeds_decode_budget(6000, 4000).is_none());
        // 8000×6000 = 4800 万，超过几何像素上限
        assert!(exceeds_decode_budget(8000, 6000).is_some());
        // 30000×30000 = 9 亿像素，纯几何超限
        assert!(exceeds_decode_budget(30_000, 30_000).is_some());
        // 高而窄：像素不超但在单边缩放下估算仍可控
        assert!(exceeds_decode_budget(20_000, 600).is_none());
    }

    #[test]
    fn invalidate_items_only_touches_requested_entries() {
        let service = OcrService::new();
        for id in ["id-a", "id-b", "id-c"] {
            let report = OcrReport::base(STATUS_OK, "ok");
            let epoch = service.cache.lock().unwrap().epoch;
            assert!(service.cache_put(id, "hash-1", &report, epoch));
        }
        service.invalidate_items(&["id-b".into()]);
        assert!(service.cache_get("id-a", "hash-1").is_some());
        assert!(service.cache_get("id-b", "hash-1").is_none());
        assert!(service.cache_get("id-c", "hash-1").is_some());
    }

    #[test]
    fn clear_cache_removes_everything() {
        let service = OcrService::new();
        for id in ["id-a", "id-b"] {
            let report = OcrReport::base(STATUS_OK, "ok");
            let epoch = service.cache.lock().unwrap().epoch;
            assert!(service.cache_put(id, "hash-1", &report, epoch));
        }
        assert_eq!(service.cached_entries(), 2);
        service.clear_cache();
        assert_eq!(service.cached_entries(), 0);
    }

    #[test]
    fn late_result_is_not_written_back_after_invalidation() {
        let service = OcrService::new();
        let report = OcrReport::base(STATUS_OK, "ok");
        // 模拟一个识别任务开始时的代数
        let epoch = service.cache.lock().unwrap().epoch;
        // 期间条目被删除
        service.invalidate_items(&["id-late".into()]);
        // 迟到的结果不得写回
        assert!(!service.cache_put("id-late", "hash-1", &report, epoch));
        assert_eq!(service.cached_entries(), 0);
        // 无关条目同样不受影响（旧结果只是不缓存，不会写入已删条目）
        let fresh = service.cache.lock().unwrap().epoch;
        assert!(service.cache_put("id-other", "hash-1", &report, fresh));
        assert_eq!(service.cached_entries(), 1);
    }

    #[test]
    fn late_result_is_not_written_back_after_clear() {
        let service = OcrService::new();
        let report = OcrReport::base(STATUS_OK, "ok");
        let epoch = service.cache.lock().unwrap().epoch;
        service.clear_cache();
        assert!(!service.cache_put("id-late", "hash-1", &report, epoch));
        assert_eq!(service.cached_entries(), 0);
    }

    #[test]
    fn retain_existing_drops_missing_and_changed_entries() {
        let mut cache = Cache::default();
        let report = OcrReport::base(STATUS_OK, "ok");
        cache.put("id-keep", "hash-1", &report);
        cache.put("id-gone", "hash-1", &report);
        cache.put("id-changed", "hash-old", &report);
        let epoch = cache.epoch;
        let snapshot = vec![
            "id-keep".to_string(),
            "id-gone".to_string(),
            "id-changed".to_string(),
        ];
        let mut current = HashMap::new();
        current.insert("id-keep".to_string(), "hash-1".to_string());
        current.insert("id-changed".to_string(), "hash-new".to_string());
        // 校正只负责淘汰，不自己推进代数。
        assert!(cache.retain_existing(&snapshot, &current));
        assert_eq!(cache.len(), 1);
        assert!(cache.get("id-keep", "hash-1").is_some());
        assert_eq!(cache.epoch, epoch, "校正不得偷偷推进代数");
    }

    #[test]
    fn empty_cache_group_delete_still_invalidates_in_flight_task() {
        // 复现漏洞：缓存为空但识别在跑时删除整组，迟到的结果不能写进缓存。
        let db = Db::open_in_memory().unwrap();
        let service = OcrService::new();
        let report = OcrReport::base(STATUS_OK, "ok");
        let epoch = service.cache.lock().unwrap().epoch;
        assert_eq!(service.cached_entries(), 0);
        service.retain_existing(&db, true);
        assert!(!service.cache_put("id-group", "hash-1", &report, epoch));
        assert_eq!(service.cached_entries(), 0);
    }

    #[test]
    fn cleanup_without_deletion_keeps_in_flight_result_writable() {
        // 没有实际删除条目的清理周期不应丢弃在跑任务的结果。
        let db = Db::open_in_memory().unwrap();
        let service = OcrService::new();
        let report = OcrReport::base(STATUS_OK, "ok");
        let epoch = service.cache.lock().unwrap().epoch;
        service.retain_existing(&db, false);
        assert!(service.cache_put("id-keep", "hash-1", &report, epoch));
    }

    #[test]
    fn db_failure_discards_unverifiable_cache() {
        let db = Db::open_in_memory().unwrap();
        let service = OcrService::new();
        let report = OcrReport::base(STATUS_OK, "ok");
        let epoch = service.cache.lock().unwrap().epoch;
        assert!(service.cache_put("id-a", "hash-1", &report, epoch));
        // 让 content_hash 查询失败：仅内存测试库，直接删表。
        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE clipboard_items")
                .map_err(AppError::from)?;
            Ok(())
        })
        .unwrap();
        service.retain_existing(&db, false);
        assert_eq!(
            service.cached_entries(),
            0,
            "数据库不可读时不得假定旧缓存仍有效"
        );
        assert!(
            !service.cache_put("id-a", "hash-1", &report, epoch),
            "丢弃后旧任务的迟到结果也不得写回"
        );
    }

    #[test]
    fn too_large_report_is_not_empty_text() {
        let report = OcrReport::too_large(8000, 6000, 700 * 1024 * 1024);
        assert_eq!(report.status, STATUS_TOO_LARGE);
        assert_eq!(report.code, "image_too_large");
        assert_eq!((report.width, report.height), (8000, 6000));
        assert!(!report.text.contains("未识别"));
        let reason = report.reason.unwrap();
        assert!(reason.contains("截取"), "提示应建议截取局部：{reason}");
    }
}
