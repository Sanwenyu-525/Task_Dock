//! 统一音频通知服务的后端部分：WinRT TTS 合成 + 本地缓存 + 缓存治理。
//!
//! 前端只负责「事件 → 队列 → 播放」，这里负责「文本 → 音频字节」：
//! - 固定短语允许持久化到 `app_cache_dir/audio/tts/`；动态文本（含任务标题/Agent 自由文本）
//!   即使前端误传 `persist=true` 也不会落盘，只在短生命周期内存缓存中复用。
//! - 相同缓存 Key 的并发请求由全局合成闸门串行化，后到请求在锁内二次查缓存，不会重复合成。
//! - 合成/缓存失败都返回结构化报告，业务事件入库与 UI 不受影响。
//! - TTS 引擎按需初始化：服务构造只准备缓存，首次真正需要合成/枚举/试听时才启动常驻
//!   WinRT 线程；从未启用 TTS 的用户不为启动付出 COM 初始化成本。

pub mod cache;
pub mod tts;

pub use tts::VoiceInfo;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;

use cache::{cache_key, extension_for_content_type, CacheStats, TtsCache};

/// 允许持久化的固定播报短语白名单。新增固定语音时必须同步这里与前端常量，
/// 否则只会进入内存缓存（不落盘），不会误把动态敏感文本写入磁盘。
pub const FIXED_PHRASES: &[&str] = &[
    "任务已完成",
    "多个任务已完成",
    "需要你的操作",
    "执行失败",
    "任务提醒时间到",
    "日程提醒时间到",
];

pub const MAX_TEXT_CHARS: usize = 300;

/// 动态语音内存缓存：容量/TTL 都有上限，退出即释放，不落盘。
const MEM_MAX_ENTRIES: usize = 16;
const MEM_MAX_BYTES: usize = 8 * 1024 * 1024;
const MEM_TTL: Duration = Duration::from_secs(5 * 60);

pub fn is_fixed_phrase(text: &str) -> bool {
    FIXED_PHRASES.contains(&text)
}

/// 仅「固定短语 + 请求持久化 + 缓存启用 + 容量允许」才允许写磁盘。
pub fn should_persist(text: &str, persist_requested: bool) -> bool {
    persist_requested && is_fixed_phrase(text.trim())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicesReport {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub voices: Vec<VoiceInfo>,
    pub has_chinese_male: bool,
    pub has_chinese_female: bool,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisReport {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub data_url: Option<String>,
    pub content_type: Option<String>,
    pub voice_id: Option<String>,
    pub voice_name: Option<String>,
    pub language: Option<String>,
    pub gender: Option<String>,
    pub requested_voice_id: Option<String>,
    pub voice_fallback: bool,
    pub cached: bool,
    pub persisted: bool,
    pub bytes: u64,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheReport {
    pub ok: bool,
    pub enabled: bool,
    pub bytes: u64,
    pub files: u32,
    pub max_bytes: u64,
    pub hits: u64,
    pub misses: u64,
    pub writes: u64,
    pub evictions: u64,
    pub memory_hits: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub ok: bool,
    pub freed_bytes: u64,
    pub removed_files: u32,
}

struct MemEntry {
    bytes: Arc<Vec<u8>>,
    content_type: String,
    voice: VoiceInfo,
    inserted: Instant,
}

#[derive(Default)]
struct MemCache {
    entries: HashMap<String, MemEntry>,
    total: usize,
}

impl MemCache {
    fn get(&mut self, key: &str) -> Option<(Arc<Vec<u8>>, String, VoiceInfo)> {
        let now = Instant::now();
        self.entries.retain(|_, e| now.duration_since(e.inserted) <= MEM_TTL);
        self.total = self.entries.values().map(|e| e.bytes.len()).sum();
        self.entries
            .get(key)
            .map(|e| (Arc::clone(&e.bytes), e.content_type.clone(), e.voice.clone()))
    }

    fn put(&mut self, key: String, bytes: Vec<u8>, content_type: String, voice: VoiceInfo) {
        self.entries.remove(&key);
        self.entries.insert(
            key,
            MemEntry {
                bytes: Arc::new(bytes),
                content_type,
                voice,
                inserted: Instant::now(),
            },
        );
        self.total = self.entries.values().map(|e| e.bytes.len()).sum();
        // 先删最旧，再按总字节裁剪；两者都有上限，避免长期运行累积音频缓冲。
        while self.entries.len() > MEM_MAX_ENTRIES {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.inserted)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.entries.remove(&k);
            } else {
                break;
            }
        }
        while self.total > MEM_MAX_BYTES && self.entries.len() > 1 {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.inserted)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                if let Some(removed) = self.entries.remove(&k) {
                    self.total = self.total.saturating_sub(removed.bytes.len());
                }
            } else {
                break;
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.total = 0;
    }
}

pub struct AudioService {
    cache: Mutex<TtsCache>,
    /// 全局合成闸门：同一时刻只允许一次 WinRT 合成，避免并行占用 CPU/内存，
    /// 也保证同 Key 的并发请求在锁内二次查缓存后共享结果。
    synth_gate: Mutex<()>,
    /// 常驻 WinRT 执行线程（COM 只初始化一次，见 `tts::TtsWorker`）。
    /// **按需创建**：未启用 TTS 且无试听/枚举请求时，启动路径不创建线程、不初始化 COM。
    worker: Mutex<Option<Arc<tts::TtsWorker>>>,
    /// 退出标志：置位后不再创建/复用语音线程，退出中的新请求立即返回结构化错误。
    stopping: AtomicBool,
    mem: Mutex<MemCache>,
    memory_hits: AtomicU64,
    synth_errors: AtomicU64,
}

impl AudioService {
    pub fn new(cache_dir: Option<PathBuf>) -> Self {
        let mut cache = TtsCache::new(cache_dir);
        let _ = cache.ensure_dir();
        Self {
            cache: Mutex::new(cache),
            synth_gate: Mutex::new(()),
            worker: Mutex::new(None),
            stopping: AtomicBool::new(false),
            mem: Mutex::new(MemCache::default()),
            memory_hits: AtomicU64::new(0),
            synth_errors: AtomicU64::new(0),
        }
    }

    /// 取常驻语音线程，首次调用时创建（锁内创建保证并发首次只初始化一次）。
    /// 创建后即使 COM 初始化失败也保留实例，错误在每次 `call` 上以结构化结果返回，
    /// 不会反复重建线程。常驻线程的单次 `CoInitializeEx` 不变（真机稳定性必需）。
    fn worker(&self) -> Result<Arc<tts::TtsWorker>, tts::TtsError> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(tts::TtsError::Failed("音频服务正在退出".into()));
        }
        let mut guard = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 锁内二次检查：避免 shutdown 在等待锁期间置位后又被重建线程。
        if self.stopping.load(Ordering::SeqCst) {
            return Err(tts::TtsError::Failed("音频服务正在退出".into()));
        }
        if guard.is_none() {
            *guard = Some(Arc::new(tts::TtsWorker::new()));
        }
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| tts::TtsError::Failed("语音工作线程不可用".into()))
    }

    /// 语音线程是否已按需创建（启动路径应为 false；真机取证与诊断使用）。
    pub fn is_worker_initialized(&self) -> bool {
        self.worker
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// 应用退出时调用：取消在途合成并等待语音线程结束（可重复调用）。
    /// 从未初始化过时不做任何事，不会为退出而启动线程。
    pub fn shutdown(&self) {
        // 先置退出标志，再取线程：退出中到达的合成/枚举请求不会重新创建 WinRT 线程。
        self.stopping.store(true, Ordering::SeqCst);
        let worker = self
            .worker
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Some(worker) = worker {
            worker.shutdown();
        }
    }

    pub fn voices(&self) -> VoicesReport {
        let worker = match self.worker() {
            Ok(worker) => worker,
            Err(err) => {
                return VoicesReport {
                    ok: false,
                    code: err.code().into(),
                    message: err.message(),
                    voices: Vec::new(),
                    has_chinese_male: false,
                    has_chinese_female: false,
                    platform: platform_name().into(),
                };
            }
        };
        match worker.call(tts::list_voices).and_then(|inner| inner) {
            Ok(voices) => {
                let report = VoicesReport {
                    ok: true,
                    code: "ok".into(),
                    message: String::new(),
                    has_chinese_male: voices
                        .iter()
                        .any(|v| is_chinese(v) && v.gender == "male"),
                    has_chinese_female: voices
                        .iter()
                        .any(|v| is_chinese(v) && v.gender == "female"),
                    platform: platform_name().into(),
                    voices,
                };
                report
            }
            Err(err) => VoicesReport {
                ok: false,
                code: err.code().into(),
                message: err.message(),
                voices: Vec::new(),
                has_chinese_male: false,
                has_chinese_female: false,
                platform: platform_name().into(),
            },
        }
    }

    /// 合成入口。返回值始终是结构化报告（错误不抛出），由前端决定是否提示。
    #[allow(clippy::too_many_arguments)]
    pub fn synthesize(
        &self,
        text: &str,
        requested_voice_id: Option<&str>,
        gender_preference: &str,
        rate_percent: u32,
        persist_requested: bool,
        cache_enabled: bool,
        max_bytes: u64,
    ) -> SynthesisReport {
        let started = Instant::now();
        let text = text.trim();
        if text.is_empty() {
            return SynthesisReport::err("text_empty", "播报文本为空", started);
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return SynthesisReport::err(
                "text_too_long",
                &format!("播报文本超过 {MAX_TEXT_CHARS} 字符"),
                started,
            );
        }
        let rate = rate_percent.clamp(50, 200);
        let allow_persist = should_persist(text, persist_requested) && cache_enabled;

        // 0) 先解析实际语音（系统可能回退）：Key 必须使用「实际语音 ID + 语言」，
        //    否则「自动选择」缓存会与显式语音缓存串用。
        //    首次真正需要时才创建常驻语音线程（此处及之后，启动路径不再付出初始化成本）。
        let worker = match self.worker() {
            Ok(worker) => worker,
            Err(err) => {
                self.synth_errors.fetch_add(1, Ordering::Relaxed);
                return SynthesisReport::err(err.code(), &err.message(), started);
            }
        };
        let requested_for_resolve = requested_voice_id.map(|s| s.to_string());
        let gender_for_resolve = gender_preference.to_string();
        let resolved = worker
            .call(move || {
                tts::resolve_voice(
                    requested_for_resolve.as_deref(),
                    &gender_for_resolve,
                )
            })
            .and_then(|inner| inner);
        let (voice, resolved_fallback) = match resolved {
            Ok(v) => v,
            Err(err) => {
                self.synth_errors.fetch_add(1, Ordering::Relaxed);
                return SynthesisReport::err(err.code(), &err.message(), started);
            }
        };
        let key = cache_key(text, &voice.id, &voice.language, rate);

        // 1) 先查持久化缓存。
        if allow_persist {
            if let Some((bytes, content_type)) =
                self.cache.lock().ok().and_then(|mut c| c.get(&key))
            {
                return SynthesisReport::ok_cached(
                    &bytes,
                    &content_type,
                    voice,
                    resolved_fallback,
                    requested_voice_id,
                    started,
                );
            }
        }
        // 2) 内存缓存（动态语音即使禁止落盘也可短周期复用）。命中前先查，避免等待闸门。
        if let Some((bytes, content_type, cached_voice)) =
            self.mem.lock().ok().and_then(|mut m| m.get(&key))
        {
            self.memory_hits.fetch_add(1, Ordering::Relaxed);
            return SynthesisReport::ok_memory(
                &bytes,
                &content_type,
                cached_voice,
                resolved_fallback,
                requested_voice_id,
                started,
            );
        }

        // 3) 串行合成；拿到闸门后再查一次（同 Key 的并发请求在此共享结果）。
        let _gate = self
            .synth_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if allow_persist {
            if let Some((bytes, content_type)) =
                self.cache.lock().ok().and_then(|mut c| c.get(&key))
            {
                return SynthesisReport::ok_cached(
                    &bytes,
                    &content_type,
                    voice.clone(),
                    resolved_fallback,
                    requested_voice_id,
                    started,
                );
            }
        }
        if let Some((bytes, content_type, cached_voice)) =
            self.mem.lock().ok().and_then(|mut m| m.get(&key))
        {
            self.memory_hits.fetch_add(1, Ordering::Relaxed);
            return SynthesisReport::ok_memory(
                &bytes,
                &content_type,
                cached_voice,
                resolved_fallback,
                requested_voice_id,
                started,
            );
        }

        // 使用已解析的实际语音 ID，避免合成阶段再次按偏好漂移到另一声音。
        // 合成在常驻语音线程执行；退出标志可让长时间合成尽快中止。
        let cancel = worker.cancel_flag();
        let synth_text = text.to_string();
        let synth_voice_id = voice.id.clone();
        let synth_gender = gender_preference.to_string();
        let output = match worker
            .call(move || {
                tts::synthesize(
                    &synth_text,
                    Some(synth_voice_id.as_str()),
                    &synth_gender,
                    rate,
                    &cancel,
                )
            })
            .and_then(|inner| inner)
        {
            Ok(output) => output,
            Err(err) => {
                self.synth_errors.fetch_add(1, Ordering::Relaxed);
                return SynthesisReport::err(err.code(), &err.message(), started);
            }
        };
        let ext = extension_for_content_type(&output.content_type);
        let persisted = if allow_persist {
            self.cache.lock().map_or(false, |mut c| {
                c.put(&key, ext, &output.bytes, max_bytes)
            })
        } else {
            false
        };
        if let Ok(mut mem) = self.mem.lock() {
            mem.put(
                key.clone(),
                output.bytes.clone(),
                output.content_type.clone(),
                output.voice.clone(),
            );
        }
        SynthesisReport::ok_synthesized(
            &output.bytes,
            &output.content_type,
            output.voice,
            output.requested_voice_id,
            resolved_fallback,
            persisted,
            started,
        )
    }

    pub fn cache_report(&self, enabled: bool, max_mb: u32) -> CacheReport {
        let stats: CacheStats = self
            .cache
            .lock()
            .map(|c| c.stats())
            .unwrap_or_default();
        CacheReport {
            ok: true,
            enabled,
            bytes: stats.bytes,
            files: stats.files,
            max_bytes: max_mb as u64 * 1024 * 1024,
            hits: stats.hits,
            misses: stats.misses,
            writes: stats.writes,
            evictions: stats.evictions,
            memory_hits: self.memory_hits.load(Ordering::Relaxed),
        }
    }

    pub fn clear_cache(&self) -> ClearReport {
        if let Ok(mut mem) = self.mem.lock() {
            mem.clear();
        }
        let (freed, removed) = self
            .cache
            .lock()
            .map(|mut c| c.clear())
            .unwrap_or((0, 0));
        ClearReport {
            ok: true,
            freed_bytes: freed,
            removed_files: removed,
        }
    }

    /// 设置变更时应用缓存策略：容量下调时立即按 LRU 收敛，避免等下次写入才清理。
    pub fn apply_policy(&self, max_mb: u32) {
        let max_bytes = max_mb as u64 * 1024 * 1024;
        if let Ok(mut cache) = self.cache.lock() {
            let _ = cache.ensure_dir();
            cache.evict_to(max_bytes);
        }
    }
}

impl SynthesisReport {
    fn err(code: &str, message: &str, started: Instant) -> Self {
        Self {
            ok: false,
            code: code.into(),
            message: message.into(),
            data_url: None,
            content_type: None,
            voice_id: None,
            voice_name: None,
            language: None,
            gender: None,
            requested_voice_id: None,
            voice_fallback: false,
            cached: false,
            persisted: false,
            bytes: 0,
            latency_ms: started.elapsed().as_millis() as u64,
        }
    }

    fn ok_cached(
        bytes: &[u8],
        content_type: &str,
        voice: VoiceInfo,
        fallback: bool,
        requested_voice_id: Option<&str>,
        started: Instant,
    ) -> Self {
        Self {
            ok: true,
            code: "ok".into(),
            message: String::new(),
            data_url: Some(data_url(content_type, bytes)),
            content_type: Some(content_type.to_string()),
            voice_id: Some(voice.id),
            voice_name: Some(voice.name),
            language: Some(voice.language),
            gender: Some(voice.gender),
            requested_voice_id: requested_voice_id.map(|s| s.to_string()),
            voice_fallback: fallback,
            cached: true,
            persisted: true,
            bytes: bytes.len() as u64,
            latency_ms: started.elapsed().as_millis() as u64,
        }
    }

    fn ok_memory(
        bytes: &[u8],
        content_type: &str,
        voice: VoiceInfo,
        fallback: bool,
        requested_voice_id: Option<&str>,
        started: Instant,
    ) -> Self {
        Self {
            ok: true,
            code: "ok".into(),
            message: String::new(),
            data_url: Some(data_url(content_type, bytes)),
            content_type: Some(content_type.to_string()),
            voice_id: Some(voice.id),
            voice_name: Some(voice.name),
            language: Some(voice.language),
            gender: Some(voice.gender),
            requested_voice_id: requested_voice_id.map(|s| s.to_string()),
            voice_fallback: fallback,
            cached: true,
            persisted: false,
            bytes: bytes.len() as u64,
            latency_ms: started.elapsed().as_millis() as u64,
        }
    }

    fn ok_synthesized(
        bytes: &[u8],
        content_type: &str,
        voice: VoiceInfo,
        requested_voice_id: Option<String>,
        fallback: bool,
        persisted: bool,
        started: Instant,
    ) -> Self {
        Self {
            ok: true,
            code: "ok".into(),
            message: String::new(),
            data_url: Some(data_url(content_type, bytes)),
            content_type: Some(content_type.to_string()),
            voice_id: Some(voice.id),
            voice_name: Some(voice.name),
            language: Some(voice.language),
            gender: Some(voice.gender),
            requested_voice_id,
            voice_fallback: fallback,
            cached: false,
            persisted,
            bytes: bytes.len() as u64,
            latency_ms: started.elapsed().as_millis() as u64,
        }
    }
}

fn data_url(content_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn is_chinese(voice: &VoiceInfo) -> bool {
    voice.language.to_ascii_lowercase().starts_with("zh")
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_fixed_phrases_persist() {
        assert!(should_persist("任务已完成", true));
        assert!(!should_persist("任务已完成", false));
        // 动态文本即使前端请求持久化也必须拒绝落盘。
        assert!(!should_persist("张三提交了包含密钥的任务", true));
        assert!(!should_persist("剪贴板内容：password=hunter2", true));
    }

    #[test]
    fn text_bounds_are_enforced() {
        let service = AudioService::new(None);
        let empty = service.synthesize("   ", None, "auto", 100, true, true, 50);
        assert_eq!(empty.code, "text_empty");
        let long = "a".repeat(MAX_TEXT_CHARS + 1);
        let report = service.synthesize(&long, None, "auto", 100, false, true, 50);
        assert_eq!(report.code, "text_too_long");
    }

    #[test]
    fn cache_report_uses_settings_limits() {
        let service = AudioService::new(None);
        let report = service.cache_report(true, 50);
        assert_eq!(report.max_bytes, 50 * 1024 * 1024);
        assert_eq!(report.files, 0);
    }

    #[test]
    fn tts_worker_is_not_started_by_construction_or_validation() {
        let service = AudioService::new(None);
        assert!(!service.is_worker_initialized(), "构造服务不得启动 WinRT 线程");
        // 参数校验在触碰语音线程之前完成：不应为一次非法请求初始化 COM。
        let empty = service.synthesize("   ", None, "auto", 100, true, true, 50);
        assert_eq!(empty.code, "text_empty");
        assert!(!service.is_worker_initialized());
        // 未初始化过就退出：不创建线程，也不阻塞。
        service.shutdown();
        assert!(!service.is_worker_initialized());
        // 退出中到达的新请求：结构化失败，不得重新拉起 WinRT 线程。
        let late = service.voices();
        assert!(!late.ok);
        assert!(!service.is_worker_initialized(), "退出后不得重建语音线程");
    }

    #[test]
    fn concurrent_first_use_creates_worker_once_and_reuses_it() {
        let service = Arc::new(AudioService::new(None));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let service = Arc::clone(&service);
            handles.push(std::thread::spawn(move || {
                let report = service.voices();
                // 平台不支持时也只是结构化错误，不得 panic。
                assert!(!report.code.is_empty());
            }));
        }
        for handle in handles {
            handle.join().expect("并发首次调用不得 panic");
        }
        assert!(service.is_worker_initialized(), "首次真正需要时才创建语音线程");
        // 再次调用复用同一常驻线程（COM 不会被拆掉重建）。
        let _ = service.voices();
        assert!(service.is_worker_initialized());
        service.shutdown();
        assert!(!service.is_worker_initialized(), "退出后应释放语音线程");
    }
}
