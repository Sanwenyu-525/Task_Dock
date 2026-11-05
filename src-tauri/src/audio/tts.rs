//! WinRT 本地 TTS 引擎（Windows.Media.SpeechSynthesis）。
//!
//! 设计约束：
//! - 只使用仓库已有的 `windows 0.62` 绑定，不引入第二套 WinRT/COM 封装；
//! - 所有 WinRT 调用都在同一条常驻工作线程（`TtsWorker`）上执行，该线程只初始化一次
//!   MTA COM，线程结束（应用退出）时配对释放；**不要**在每次调用后 `CoUninitialize`；
//! - 异步合成采用有超时的状态轮询，不阻塞 UI 主线程（命令层再包一层 spawn_blocking）；
//! - 只返回音频字节，不在这里播放；播放由主窗口统一音频服务负责（避免多窗口重复播放）。
//!
//! 为什么必须保持单一长期套间（真机取证 2026-11-04）：
//! `windows-core` 的 `FactoryCache` 是进程级静态，会把激活工厂指针 `forget` 后缓存复用。
//! 若进程内最后一个 COM 套间被 `CoUninitialize` 拆除，WinRT 运行时随之卸载，缓存指针失效；
//! 之后再次初始化并调用 `AllVoices` 会直接 `STATUS_ACCESS_VIOLATION`（同一线程连续两次枚举
//! 第二次必崩，`keep COM initialized` 则两次都正常）。因此这里用专用线程只初始化一次，
//! 顺带保证任意时刻只有一次合成在跑。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

/// 合成超时：正常固定短语 1 秒内完成；20 秒足够覆盖首次引擎加载。
const SYNTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 工作线程待处理任务上限。请求方是阻塞等待结果的调用方，
/// 正常并发（播报 + 试听 + 语音枚举）远低于该值；满载时立即返回 busy，绝不无限排队。
pub const TTS_JOB_QUEUE_LIMIT: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    /// Windows 提供的稳定语音 ID（跨会话可用）。
    pub id: String,
    pub name: String,
    /// BCP-47，例如 zh-CN。
    pub language: String,
    /// male | female | unknown（由系统 API 提供，不推测、不变调伪装）。
    pub gender: String,
    pub available: bool,
}

#[derive(Debug, Clone)]
pub struct SynthOutput {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub voice: VoiceInfo,
    /// 用户请求的语音 ID；自动选择时为空。
    pub requested_voice_id: Option<String>,
    /// 请求的语音不可用、实际回退到其他系统语音时为 true。
    pub fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtsError {
    /// 非 Windows 平台或 WinRT 组件缺失。
    Unsupported(String),
    /// 系统未安装任何语音。
    NoVoice,
    /// 合成期间超时/取消。
    Timeout,
    /// 工作线程待处理队列已满：调用方应稍后重试，不进入排队。
    Busy,
    /// 其他合成失败（含流读取失败）。
    Failed(String),
}

impl TtsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported(_) => "unsupported_platform",
            Self::NoVoice => "no_voice",
            Self::Timeout => "timeout",
            Self::Busy => "busy",
            Self::Failed(_) => "synthesis_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Unsupported(m) => m.clone(),
            Self::NoVoice => "系统未安装可用的语音，请在 Windows 设置中安装中文语音".into(),
            Self::Timeout => "语音合成超时，请稍后重试".into(),
            Self::Busy => "语音合成繁忙，请稍后重试".into(),
            Self::Failed(m) => format!("语音合成失败: {m}"),
        }
    }
}

/// 只解析实际会使用的系统语音（不合成），用于缓存 Key 与 UI 一致性。
/// 调用方必须已处于 `TtsWorker` 线程（COM 已初始化），本函数不再自行 Init/Uninit。
#[cfg(windows)]
pub fn resolve_voice(
    requested_voice_id: Option<&str>,
    gender_preference: &str,
) -> Result<(VoiceInfo, bool), TtsError> {
    let voices = enumerate_voices()?;
    if voices.is_empty() {
        return Err(TtsError::NoVoice);
    }
    let infos: Vec<VoiceInfo> = voices.into_iter().map(|(info, _)| info).collect();
    let (idx, fallback) = pick_voice_index(&infos, requested_voice_id, gender_preference)
        .ok_or(TtsError::NoVoice)?;
    Ok((infos[idx].clone(), fallback))
}

#[cfg(not(windows))]
pub fn resolve_voice(
    _requested_voice_id: Option<&str>,
    _gender_preference: &str,
) -> Result<(VoiceInfo, bool), TtsError> {
    Err(TtsError::Unsupported(
        "当前平台暂未实现本地语音播报（仅支持 Windows）".into(),
    ))
}

/// 枚举系统语音。返回的顺序保持 Windows 的稳定顺序，便于 UI 选择。
#[cfg(windows)]
pub fn list_voices() -> Result<Vec<VoiceInfo>, TtsError> {
    let voices = enumerate_voices()?;
    Ok(voices.into_iter().map(|(info, _)| info).collect())
}

#[cfg(not(windows))]
pub fn list_voices() -> Result<Vec<VoiceInfo>, TtsError> {
    Err(TtsError::Unsupported(
        "当前平台暂未实现本地语音播报（仅支持 Windows）".into(),
    ))
}

/// 按请求语音/性别偏好合成一段 WAV（或系统返回的其他音频流）。
#[cfg(windows)]
pub fn synthesize(
    text: &str,
    requested_voice_id: Option<&str>,
    gender_preference: &str,
    rate_percent: u32,
    cancel: &AtomicBool,
) -> Result<SynthOutput, TtsError> {
    use windows::Media::SpeechSynthesis::SpeechSynthesizer;
    use windows::core::HSTRING;

    if text.trim().is_empty() {
        return Err(TtsError::Failed("播报文本为空".into()));
    }
    let voices = enumerate_voices()?;
    let (voice_info, voice, fallback) =
        resolve_voice_with_handle(&voices, requested_voice_id, gender_preference, rate_percent)?;

    let synth = SpeechSynthesizer::new()
        .map_err(|e| TtsError::Unsupported(format!("无法创建语音合成器: {e}")))?;
    synth
        .SetVoice(&voice)
        .map_err(|e| TtsError::Failed(format!("切换系统语音失败: {e}")))?;
    if let Ok(options) = synth.Options() {
        // 语速由合成阶段决定，因此参与缓存 Key；音量只影响播放。
        let rate = (rate_percent as f64 / 100.0).clamp(0.5, 2.0);
        let _ = options.SetSpeakingRate(rate);
    }

    let operation = synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))
        .map_err(|e| TtsError::Failed(format!("无法启动语音合成: {e}")))?;
    wait_async(&operation, cancel)?;
    let stream = operation
        .GetResults()
        .map_err(|e| TtsError::Failed(format!("语音合成未返回音频流: {e}")))?;
    let content_type = stream
        .ContentType()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "audio/wav".into());
    let bytes = read_stream(&stream, cancel)?;
    let _ = stream.Close();
    let _ = synth.Close();

    if bytes.is_empty() {
        return Err(TtsError::Failed("合成音频为空".into()));
    }
    Ok(SynthOutput {
        bytes,
        content_type,
        voice: voice_info,
        requested_voice_id: requested_voice_id.map(|s| s.to_string()),
        fallback,
    })
}

#[cfg(not(windows))]
pub fn synthesize(
    _text: &str,
    _requested_voice_id: Option<&str>,
    _gender_preference: &str,
    _rate_percent: u32,
    _cancel: &AtomicBool,
) -> Result<SynthOutput, TtsError> {
    Err(TtsError::Unsupported(
        "当前平台暂未实现本地语音播报（仅支持 Windows）".into(),
    ))
}

/// 纯函数：按「精确 ID → 性别偏好 → 中文任一 → 系统默认」解析语音。
/// 找不到对应性别的中文语音时绝不伪造，只会如实回退并标记 `fallback`。
pub fn pick_voice_index(
    voices: &[VoiceInfo],
    requested_voice_id: Option<&str>,
    gender_preference: &str,
) -> Option<(usize, bool)> {
    let requested = requested_voice_id.unwrap_or("").trim();
    if !requested.is_empty() {
        if let Some(pos) = voices.iter().position(|v| v.id == requested) {
            return Some((pos, false));
        }
        // 选中的语音在系统更新后消失：回退到自动选择，并标记 fallback。
        let pos = auto_voice_index(voices, gender_preference)?;
        return Some((pos, true));
    }
    let pos = auto_voice_index(voices, gender_preference)?;
    // 自动选择时若性别偏好未能满足，同样标记 fallback，供 UI 如实提示。
    let fallback = match gender_preference {
        "male" | "female" => !voices[pos].gender.eq_ignore_ascii_case(gender_preference),
        _ => false,
    };
    Some((pos, fallback))
}

fn auto_voice_index(voices: &[VoiceInfo], gender_preference: &str) -> Option<usize> {
    let zh = |v: &VoiceInfo| v.language.to_ascii_lowercase().starts_with("zh");
    if matches!(gender_preference, "male" | "female") {
        if let Some(pos) = voices.iter().position(|v| {
            zh(v) && v.gender.eq_ignore_ascii_case(gender_preference)
        }) {
            return Some(pos);
        }
    }
    // 任意中文语音（避免在只能英文播报的系统上直接失败）。
    if let Some(pos) = voices.iter().position(zh) {
        return Some(pos);
    }
    // 最后回退到系统枚举的第一个语音；不伪装成中文/目标性别。
    if voices.is_empty() {
        None
    } else {
        Some(0)
    }
}

#[cfg(windows)]
fn resolve_voice_with_handle(
    voices: &[(VoiceInfo, windows::Media::SpeechSynthesis::VoiceInformation)],
    requested_voice_id: Option<&str>,
    gender_preference: &str,
    _rate_percent: u32,
) -> Result<
    (
        VoiceInfo,
        windows::Media::SpeechSynthesis::VoiceInformation,
        bool,
    ),
    TtsError,
> {
    if voices.is_empty() {
        return Err(TtsError::NoVoice);
    }
    let infos: Vec<VoiceInfo> = voices.iter().map(|(i, _)| i.clone()).collect();
    let (idx, fallback) = pick_voice_index(&infos, requested_voice_id, gender_preference)
        .ok_or(TtsError::NoVoice)?;
    let (info, voice) = voices[idx].clone();
    Ok((info, voice, fallback))
}

#[cfg(windows)]
fn enumerate_voices(
) -> Result<Vec<(VoiceInfo, windows::Media::SpeechSynthesis::VoiceInformation)>, TtsError> {
    use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceGender};

    let list = SpeechSynthesizer::AllVoices()
        .map_err(|e| TtsError::Unsupported(format!("读取系统语音列表失败: {e}")))?;
    let mut out = Vec::new();
    for i in 0..list.Size().unwrap_or(0) {
        let Ok(voice) = list.GetAt(i) else {
            continue;
        };
        let id = voice.Id().map(|s| s.to_string()).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let name = voice.DisplayName().map(|s| s.to_string()).unwrap_or_default();
        let language = voice.Language().map(|s| s.to_string()).unwrap_or_default();
        let gender = {
            let g = voice.Gender().unwrap_or(VoiceGender::Male);
            if g == VoiceGender::Female {
                "female"
            } else if g == VoiceGender::Male {
                "male"
            } else {
                "unknown"
            }
        };
        out.push((
            VoiceInfo {
                id,
                name,
                language,
                gender: gender.into(),
                available: true,
            },
            voice,
        ));
    }
    Ok(out)
}

#[cfg(windows)]
fn wait_async<T>(
    operation: &windows_future::IAsyncOperation<T>,
    cancel: &AtomicBool,
) -> Result<(), TtsError>
where
    T: windows::core::RuntimeType,
{
    let started = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = operation.Cancel();
            return Err(TtsError::Timeout);
        }
        match operation.Status() {
            Ok(windows_future::AsyncStatus::Completed) => return Ok(()),
            Ok(windows_future::AsyncStatus::Started) => {}
            Ok(windows_future::AsyncStatus::Canceled) => return Err(TtsError::Timeout),
            Ok(windows_future::AsyncStatus::Error) => {
                return Err(TtsError::Failed("系统语音引擎返回错误".into()))
            }
            Ok(_) => return Err(TtsError::Failed("系统语音引擎返回未知状态".into())),
            Err(e) => return Err(TtsError::Failed(format!("读取合成状态失败: {e}"))),
        }
        if started.elapsed() >= SYNTH_TIMEOUT {
            let _ = operation.Cancel();
            return Err(TtsError::Timeout);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(windows)]
fn read_stream(
    stream: &windows::Media::SpeechSynthesis::SpeechSynthesisStream,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, TtsError> {
    use windows::Storage::Streams::{DataReader, IInputStream};
    use windows::core::Interface;

    let size = stream
        .Size()
        .map_err(|e| TtsError::Failed(format!("读取音频流大小失败: {e}")))?;
    if size == 0 {
        return Ok(Vec::new());
    }
    if size > 32 * 1024 * 1024 {
        return Err(TtsError::Failed("合成音频异常过大（超过 32MB）".into()));
    }
    let input: IInputStream = stream
        .cast()
        .map_err(|e| TtsError::Failed(format!("转换音频流接口失败: {e}")))?;
    let reader = DataReader::CreateDataReader(&input)
        .map_err(|e| TtsError::Failed(format!("创建音频读取器失败: {e}")))?;
    let load = reader
        .LoadAsync(size as u32)
        .map_err(|e| TtsError::Failed(format!("读取音频流失败: {e}")))?;
    let started = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = load.Cancel();
            return Err(TtsError::Timeout);
        }
        match load.Status() {
            Ok(windows_future::AsyncStatus::Completed) => break,
            Ok(windows_future::AsyncStatus::Started) => {}
            Ok(windows_future::AsyncStatus::Canceled) => return Err(TtsError::Timeout),
            Ok(windows_future::AsyncStatus::Error) => {
                return Err(TtsError::Failed("读取音频流返回错误".into()))
            }
            Ok(_) => return Err(TtsError::Failed("读取音频流返回未知状态".into())),
            Err(e) => return Err(TtsError::Failed(format!("读取音频流状态失败: {e}"))),
        }
        if started.elapsed() >= SYNTH_TIMEOUT {
            let _ = load.Cancel();
            return Err(TtsError::Timeout);
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let _ = load.GetResults();
    let available = reader
        .UnconsumedBufferLength()
        .map_err(|e| TtsError::Failed(format!("读取音频缓冲长度失败: {e}")))?;
    let mut bytes = vec![0u8; available as usize];
    reader
        .ReadBytes(&mut bytes)
        .map_err(|e| TtsError::Failed(format!("读取音频字节失败: {e}")))?;
    let _ = reader.Close();
    Ok(bytes)
}

#[cfg(windows)]
mod com {
    use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum InitError {
        ChangedMode,
        Failed(i32),
    }

    impl InitError {
        pub fn message(self) -> String {
            match self {
                Self::ChangedMode => {
                    "线程 COM 套间模型不兼容（RPC_E_CHANGED_MODE），无法使用 Windows 语音".into()
                }
                Self::Failed(code) => format!("COM 初始化失败（HRESULT 0x{code:08X}）"),
            }
        }
    }

    /// 与 `clipboard::ocr` 的 ComGuard 同型：S_OK/S_FALSE 都配对一次 CoUninitialize。
    pub struct ComGuard {
        owns_reference: bool,
    }

    impl ComGuard {
        pub fn init() -> Result<Self, InitError> {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr == S_OK || hr == S_FALSE {
                return Ok(Self {
                    owns_reference: true,
                });
            }
            if hr == RPC_E_CHANGED_MODE {
                return Err(InitError::ChangedMode);
            }
            Err(InitError::Failed(hr.0))
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owns_reference {
                unsafe { CoUninitialize() };
            }
        }
    }
}

#[cfg(windows)]
use com::ComGuard;

/// 常驻 WinRT 执行线程：初始化一次 MTA COM，串行执行所有语音枚举/解析/合成任务。
///
/// 不要改成「每次调用 Init/Uninit」：`windows-core` 的进程级激活工厂缓存会在
/// 最后一个套间被拆除后失效，再次使用即触发访问冲突（见文件顶部取证说明）。
pub struct TtsWorker {
    /// 有界队列：满载时 `call` 立即返回 `busy`，调用方不会无声排队。
    tx: Mutex<Option<std::sync::mpsc::SyncSender<Job>>>,
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    cancel: Arc<AtomicBool>,
    init_error: Option<(String, String)>,
}

type Job = Box<dyn FnOnce() + Send + 'static>;

impl TtsWorker {
    pub fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Job>(TTS_JOB_QUEUE_LIMIT);
        let (init_tx, init_rx) =
            std::sync::mpsc::channel::<Result<(), (String, String)>>();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_for_worker = Arc::clone(&cancel);
        let handle = std::thread::Builder::new()
            .name("taskdock-tts".into())
            .spawn(move || {
                #[cfg(windows)]
                let _com = match ComGuard::init() {
                    Ok(guard) => {
                        let _ = init_tx.send(Ok(()));
                        Some(guard)
                    }
                    Err(err) => {
                        let _ =
                            init_tx.send(Err(("unsupported_platform".into(), err.message())));
                        None
                    }
                };
                #[cfg(not(windows))]
                {
                    let _ = init_tx.send(Err((
                        "unsupported_platform".into(),
                        "当前平台暂未实现本地语音播报（仅支持 Windows）".into(),
                    )));
                }
                // 发送端被释放（`shutdown`/`Drop`）即退出循环，线程结束时配对释放 COM。
                // 带超时 recv：即使调用方还有临时 Sender 克隆，退出标志也能在 200ms 内生效。
                loop {
                    match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(job) => job(),
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if cancel_for_worker.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                    }
                }
            })
            .ok();
        let init_error = match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => None,
            Ok(Err(err)) => Some(err),
            Err(_) => Some((
                "unsupported_platform".into(),
                "语音工作线程不可用（启动失败或初始化超时）".into(),
            )),
        };
        Self {
            tx: Mutex::new(Some(tx)),
            handle: Mutex::new(handle),
            cancel,
            init_error,
        }
    }

    /// 把闭包投递到语音线程并等待结果（有上限，防止异常时永久阻塞调用方）。
    pub fn call<R, F>(&self, job: F) -> Result<R, TtsError>
    where
        R: Send + 'static,
        F: FnOnce() -> R + Send + 'static,
    {
        if let Some((_code, message)) = &self.init_error {
            return Err(TtsError::Unsupported(message.clone()));
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let sender = self
            .tx
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned());
        let Some(sender) = sender else {
            return Err(TtsError::Failed("语音工作线程已停止".into()));
        };
        // 有界队列：用 try_send 而不是阻塞 send，满载时立刻返回可重试的 busy。
        match sender.try_send(Box::new(move || {
            let _ = reply_tx.send(job());
        })) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(_)) => return Err(TtsError::Busy),
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                return Err(TtsError::Failed("语音工作线程已停止".into()))
            }
        }
        reply_rx
            .recv_timeout(Duration::from_secs(25))
            .map_err(|_| TtsError::Timeout)
    }

    /// 退出标志：合成轮询与音频流读取会据此尽快中止。
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// 停止接收新任务并等待线程结束（可重复调用）。
    pub fn shutdown(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.tx.lock() {
            guard.take();
        }
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for TtsWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    fn voice(id: &str, lang: &str, gender: &str) -> VoiceInfo {
        VoiceInfo {
            id: id.into(),
            name: id.into(),
            language: lang.into(),
            gender: gender.into(),
            available: true,
        }
    }

    #[test]
    fn prefers_chinese_voice_of_requested_gender() {
        let list = vec![
            voice("en-f", "en-US", "female"),
            voice("zh-m", "zh-CN", "male"),
            voice("zh-f", "zh-CN", "female"),
        ];
        let (idx, fallback) = pick_voice_index(&list, None, "female").unwrap();
        assert_eq!(list[idx].id, "zh-f");
        assert!(!fallback);
        let (idx, fallback) = pick_voice_index(&list, None, "male").unwrap();
        assert_eq!(list[idx].id, "zh-m");
        assert!(!fallback);
    }

    #[test]
    fn explicit_voice_id_wins_and_falls_back_when_missing() {
        let list = vec![voice("zh-f", "zh-CN", "female"), voice("zh-m", "zh-CN", "male")];
        let (idx, fallback) = pick_voice_index(&list, Some("zh-m"), "female").unwrap();
        assert_eq!(list[idx].id, "zh-m");
        assert!(!fallback);
        let (idx, fallback) = pick_voice_index(&list, Some("gone"), "female").unwrap();
        assert_eq!(list[idx].id, "zh-f");
        assert!(fallback, "请求语音不存在时必须如实标记回退");
    }

    #[test]
    fn missing_gender_does_not_fake_another_voice() {
        let list = vec![voice("zh-m", "zh-CN", "male")];
        let (idx, fallback) = pick_voice_index(&list, None, "female").unwrap();
        assert_eq!(list[idx].id, "zh-m");
        assert!(fallback, "缺中文女声时应回退并标记，而不是伪装成女声");
    }

    #[test]
    fn falls_back_to_any_voice_when_no_chinese_installed() {
        let list = vec![voice("en-f", "en-US", "female")];
        let (idx, fallback) = pick_voice_index(&list, None, "male").unwrap();
        assert_eq!(list[idx].id, "en-f");
        assert!(fallback);
    }

    #[test]
    fn empty_voice_list_is_explicit_error() {
        assert!(pick_voice_index(&[], None, "female").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn job_queue_is_bounded_and_reports_busy_instead_of_queuing() {
        let worker = TtsWorker::new();
        if worker.init_error.is_some() {
            // 引擎/平台不可用时该用例不适用。
            return;
        }
        let release = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicUsize::new(0));
        let tx = {
            let guard = worker.tx.lock().expect("工作线程队列锁");
            guard.as_ref().expect("工作线程已启动").clone()
        };
        // 先让一个任务真正进入执行并阻塞，再填满缓冲：此后不会再被消费，Full 可稳定复现。
        let prime = {
            let flag = Arc::clone(&release);
            let started = Arc::clone(&started);
            Box::new(move || {
                started.fetch_add(1, Ordering::SeqCst);
                while !flag.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }) as Job
        };
        tx.try_send(prime).expect("空闲队列应接受首个任务");
        let wait_started = Instant::now();
        while started.load(Ordering::SeqCst) == 0 {
            assert!(
                wait_started.elapsed() < Duration::from_secs(10),
                "工作线程未开始执行任务"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        let mut filled = 0usize;
        loop {
            let flag = Arc::clone(&release);
            let job: Job = Box::new(move || {
                while !flag.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
            });
            match tx.try_send(job) {
                Ok(()) => {
                    filled += 1;
                    assert!(
                        filled <= TTS_JOB_QUEUE_LIMIT,
                        "队列缓冲不得超过上限"
                    );
                }
                Err(std::sync::mpsc::TrySendError::Full(_)) => break,
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    panic!("工作线程不应在测试中退出")
                }
            }
        }
        assert_eq!(filled, TTS_JOB_QUEUE_LIMIT, "缓冲应恰好填满上限");
        let result = worker.call(|| ());
        // 先释放阻塞任务，避免断言失败时 join 悬挂。
        release.store(true, Ordering::SeqCst);
        let err = result.expect_err("满载时应立即返回错误而不是排队");
        assert_eq!(err.code(), "busy");
        assert!(err.message().contains("繁忙"));
        // 释放测试持有的临时 Sender 克隆，否则工作线程仍会等待新任务。
        drop(tx);
        worker.shutdown();
    }
}
