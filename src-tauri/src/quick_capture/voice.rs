//! 快速捕获的语音输入（Windows.Media.SpeechRecognition · 听写模式）。
//!
//! 设计约束：
//! - **专用常驻工作线程**：MTA COM 只初始化一次（与 `audio::tts::TtsWorker` 同一
//!   理由：windows-core 的进程级激活工厂缓存会在最后一个套间拆除后失效）；任务
//!   队列有界，满载立即返回可重试的 busy，调用方带超时等待；
//! - **按需启动、按需释放**：首次 `start` 才创建线程；`stop`、捕获窗口隐藏/失焦、
//!   应用退出都会停止会话并关闭识别器，麦克风不在后台常驻占用；
//! - **事件只发捕获窗口**：partial（临时假设）/ final（定稿片段）/ status（会话
//!   结束或失败）；识别正文只进事件载荷，日志与错误文案都不回显正文；
//! - **语言**：优先中文听写语言，系统没有中文识别包时回退系统语音语言并如实上报
//!   （`VoiceStartResult.language`），不假装成功；
//! - **有界等待**：编译约束、启动、停止全部带超时轮询，命令层再包
//!   `spawn_blocking`，不阻塞 UI 线程。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::quick_capture::WINDOW_LABEL;

/// 后端 → 捕获窗口：临时识别结果（实时字幕，可能被下一帧替换）。
pub const PARTIAL_EVENT: &str = "capture-voice-partial";
/// 后端 → 捕获窗口：已定稿片段（前端追加进正文）。
pub const FINAL_EVENT: &str = "capture-voice-final";
/// 后端 → 捕获窗口：会话状态（idle = 自然结束/已停止；error = 需要用户处理）。
pub const STATUS_EVENT: &str = "capture-voice-status";

/// 任务队列上限：正常只有 start/stop 两类任务，满载说明调用方异常。
const JOB_QUEUE_LIMIT: usize = 8;
/// 编译约束 + 启动会话的总超时（首次加载识别引擎可能较慢）。
const START_TIMEOUT: Duration = Duration::from_secs(12);
/// 停止会话的超时：超时也继续清理，不无限等待引擎。
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
/// 调用方等待工作线程回包的上限。
const CALL_WAIT: Duration = Duration::from_secs(16);
/// 停止时最多补发多少条定稿片段（StopAsync 会送出最后一批结果；正常远小于此值）。
const STOP_PENDING_LIMIT: usize = 64;
/// 等用户开口的初始静音超时（秒）。
const INITIAL_SILENCE_SECS: i64 = 10;
/// 连续听写的自动停止静音时长（秒）：长时间无语音自动结束，避免无限占用麦克风。
const AUTO_STOP_SILENCE_SECS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartResult {
    /// 实际使用的识别语言（BCP-47，例如 zh-CN）；回退时为系统语音语言。
    pub language: String,
}

#[derive(Debug)]
pub enum VoiceError {
    Unsupported(String),
    /// 系统隐私/权限开关未开启，用户去设置页操作后即可重试。
    PermissionRequired(String),
    Busy,
    Timeout,
    Failed(String),
}

impl VoiceError {
    pub fn into_app_error(self) -> AppError {
        match self {
            VoiceError::Unsupported(message) | VoiceError::Failed(message) => {
                AppError::Unavailable(message)
            }
            VoiceError::PermissionRequired(message) => AppError::PermissionRequired(message),
            VoiceError::Busy => AppError::Overloaded("语音输入正在准备，请稍后重试".into()),
            VoiceError::Timeout => AppError::Unavailable("语音输入启动超时，请重试".into()),
        }
    }
}

/// 会话结束原因（纯数据，便于单测；映射自 WinRT 结果状态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEnd {
    Completed,
    Canceled,
    Timeout,
    Network,
    Microphone,
    AudioQuality,
    Language,
    Unknown,
}

impl SessionEnd {
    /// 前端状态：idle 只提示「已结束」；error 用错误色提示可操作的恢复方式。
    pub fn status(self) -> &'static str {
        match self {
            Self::Completed | Self::Canceled | Self::Timeout => "idle",
            _ => "error",
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Canceled => "canceled",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Microphone => "microphone",
            Self::AudioQuality => "audio_quality",
            Self::Language => "language",
            Self::Unknown => "unknown",
        }
    }

    pub fn message(self) -> Option<&'static str> {
        match self {
            Self::Completed | Self::Canceled => None,
            Self::Timeout => Some("较长时间未检测到语音，语音输入已结束"),
            Self::Network => {
                Some("语音识别需要网络连接，请检查网络或系统的在线语音识别设置")
            }
            Self::Microphone => Some("无法访问麦克风，请检查 Windows 隐私设置中的麦克风权限"),
            Self::AudioQuality => Some("音频质量不足，语音输入已结束"),
            Self::Language => Some("系统语音识别语言不可用，请在 Windows 设置中安装语音包"),
            Self::Unknown => Some("语音识别意外结束，请重试"),
        }
    }
}

/// 状态事件载荷（camelCase 对齐前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatusPayload {
    pub status: &'static str,
    pub code: &'static str,
    pub message: Option<&'static str>,
}

impl From<SessionEnd> for VoiceStatusPayload {
    fn from(end: SessionEnd) -> Self {
        Self {
            status: end.status(),
            code: end.code(),
            message: end.message(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct TextPayload {
    text: String,
}

/// 按需创建的语音输入服务（应用级单例，不创建线程、不碰 COM）。
pub struct VoiceInput {
    worker: Mutex<Option<Worker>>,
    stopping: AtomicBool,
}

struct Worker {
    tx: SyncSender<Job>,
    handle: Option<std::thread::JoinHandle<()>>,
    /// 工作线程 COM / 引擎初始化失败原因：非空时每次调用直接返回同名错误，
    /// 不反复重建线程（与 `TtsWorker` 同一策略）。
    init_error: Option<String>,
}

enum Job {
    Start {
        app: AppHandle,
        reply: std::sync::mpsc::Sender<Result<VoiceStartResult, VoiceError>>,
    },
    Stop {
        reply: Option<std::sync::mpsc::Sender<Result<Vec<String>, VoiceError>>>,
    },
}

impl VoiceInput {
    pub fn new() -> Self {
        Self {
            worker: Mutex::new(None),
            stopping: AtomicBool::new(false),
        }
    }

    /// 启动听写；已在进行中时复用同一会话（重复点击/状态竞态不重建引擎）。
    pub fn start(&self, app: &AppHandle) -> Result<VoiceStartResult, VoiceError> {
        let (sender, init_error) = self.worker_sender()?;
        if let Some(message) = init_error {
            return Err(VoiceError::Unsupported(message));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        sender
            .try_send(Job::Start {
                app: app.clone(),
                reply: tx,
            })
            .map_err(|e| match e {
                TrySendError::Full(_) => VoiceError::Busy,
                TrySendError::Disconnected(_) => {
                    VoiceError::Failed("语音输入线程已停止".into())
                }
            })?;
        // 不持锁等待：窗口隐藏时的 stop_async 不能被启动过程阻塞。
        rx.recv_timeout(CALL_WAIT).map_err(|_| VoiceError::Timeout)?
    }

    /// 停止听写并等待会话关闭；返回停止收尾期间才定稿的片段
    /// （`StopAsync` 会补发最后一批结果，未启动过时为空）。
    pub fn stop(&self) -> Result<Vec<String>, VoiceError> {
        let Some((sender, init_error)) = self.existing_sender() else {
            return Ok(Vec::new());
        };
        if let Some(message) = init_error {
            return Err(VoiceError::Unsupported(message));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        sender
            .try_send(Job::Stop { reply: Some(tx) })
            .map_err(|e| match e {
                TrySendError::Full(_) => VoiceError::Busy,
                TrySendError::Disconnected(_) => {
                    VoiceError::Failed("语音输入线程已停止".into())
                }
            })?;
        rx.recv_timeout(CALL_WAIT)
            .map_err(|_| VoiceError::Timeout)?
    }

    /// 非阻塞停止（窗口隐藏/失焦时调用）：不等待引擎收尾，但保证会话最终关闭。
    pub fn stop_async(&self) {
        let Some((sender, init_error)) = self.existing_sender() else {
            return;
        };
        if init_error.is_some() {
            return;
        }
        if let Err(TrySendError::Full(_)) = sender.try_send(Job::Stop { reply: None }) {
            tracing::warn!(window = WINDOW_LABEL, "语音输入停止任务队列已满，等待工作线程自行排空");
        }
    }

    /// 应用退出：取出工作线程并关闭会话（可重复调用；从未使用过时立即返回）。
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(mut worker) = worker else {
            return;
        };
        // 关闭队列：工作线程在退出前执行 stop_session 释放麦克风。
        drop(worker.tx);
        if let Some(handle) = worker.handle.take() {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !handle.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                tracing::warn!("语音输入线程 2 秒内未退出，已放弃等待（应用继续退出）");
            }
        }
    }

    fn existing_sender(&self) -> Option<(SyncSender<Job>, Option<String>)> {
        let guard = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .map(|worker| (worker.tx.clone(), worker.init_error.clone()))
    }

    /// 取常驻工作线程的发送端，首次调用时创建（锁内创建保证并发首次只初始化一次）。
    /// 只复制发送端与初始化状态，不把锁带出函数。
    fn worker_sender(&self) -> Result<(SyncSender<Job>, Option<String>), VoiceError> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(VoiceError::Unsupported("应用正在退出，无法启动语音输入".into()));
        }
        let mut guard = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.stopping.load(Ordering::SeqCst) {
            return Err(VoiceError::Unsupported("应用正在退出，无法启动语音输入".into()));
        }
        if guard.is_none() {
            *guard = Some(spawn_worker()?);
        }
        guard
            .as_ref()
            .map(|worker| (worker.tx.clone(), worker.init_error.clone()))
            .ok_or_else(|| VoiceError::Failed("语音输入工作线程不可用".into()))
    }
}

impl Default for VoiceInput {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for VoiceInput {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_worker() -> Result<Worker, VoiceError> {
    let (tx, rx) = sync_channel::<Job>(JOB_QUEUE_LIMIT);
    let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = std::thread::Builder::new()
        .name("taskdock-stt".into())
        .spawn(move || {
            #[cfg(windows)]
            let _com = match crate::audio::tts::com::ComGuard::init() {
                Ok(guard) => {
                    let _ = init_tx.send(Ok(()));
                    Some(guard)
                }
                Err(err) => {
                    let _ = init_tx.send(Err(err.message()));
                    None
                }
            };
            #[cfg(not(windows))]
            {
                let _ = init_tx.send(Err(
                    "当前平台暂未实现语音输入（仅支持 Windows）".into()
                ));
            }

            #[cfg(windows)]
            run_jobs(rx);
            #[cfg(not(windows))]
            {
                // 非 Windows：线程只承载初始化错误，等待发送端释放后退出。
                while let Ok(_job) = rx.recv() {}
            }
        })
        .map_err(|e| VoiceError::Failed(format!("无法创建语音输入线程: {e}")))?;

    match init_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(Worker {
            tx,
            handle: Some(handle),
            init_error: None,
        }),
        Ok(Err(message)) => Ok(Worker {
            tx,
            handle: Some(handle),
            init_error: Some(message),
        }),
        Err(_) => Err(VoiceError::Unsupported(
            "语音输入线程不可用（启动失败或初始化超时）".into(),
        )),
    }
}

#[cfg(windows)]
fn run_jobs(rx: std::sync::mpsc::Receiver<Job>) {
    let mut state: Option<ActiveSession> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Job::Start { app, reply }) => {
                let result = start_session(&mut state, &app);
                let _ = reply.send(result);
            }
            Ok(Job::Stop { reply }) => {
                let finals = stop_session(&mut state);
                if let Some(reply) = reply {
                    let _ = reply.send(Ok(finals));
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    // 发送端已释放（退出）：释放麦克风后再让线程结束。
    let _ = stop_session(&mut state);
}

// ── WinRT 实现（仅 Windows） ─────────────────────────────────

/// 系统语音隐私策略尚未接受（SpeechErrors.h: SPERR_PRIVACY_POLICY_NOT_ACCEPTED）。
/// 对应 Windows「在线语音识别」开关关闭；应用不能替用户接受隐私策略，只能引导去设置页。
#[cfg(windows)]
const SPERR_PRIVACY_POLICY_NOT_ACCEPTED: i32 = 0x8004_55A0u32 as i32;

/// 隐私判定按进程缓存：设置开启后旧进程仍可能返回同一错误，因此明确提示重启。
#[cfg(windows)]
const PRIVACY_REQUIRED_MESSAGE: &str =
    "Windows 在线语音识别未开启或尚未生效，请在系统设置中开启后重启 Task Dock 再试";

/// 引擎启动类错误：隐私策略单独映射为可操作错误，其余保留阶段与原因。
#[cfg(windows)]
fn engine_error(stage: &str, error: windows::core::Error) -> VoiceError {
    // 系统语言不同也保持英文错误消息，文案兜底与 HRESULT 判定互为保险。
    if error.code().0 == SPERR_PRIVACY_POLICY_NOT_ACCEPTED
        || error
            .message()
            .to_ascii_lowercase()
            .contains("privacy policy was not accepted")
    {
        return VoiceError::PermissionRequired(PRIVACY_REQUIRED_MESSAGE.into());
    }
    VoiceError::Unsupported(format!("{stage}: {error}"))
}

#[cfg(windows)]
struct ActiveSession {
    recognizer: windows::Media::SpeechRecognition::SpeechRecognizer,
    session: windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
    /// 本会话仍然有效：停止收尾完成后置 false，迟到的事件一律丢弃。
    active: Arc<AtomicBool>,
    /// 已进入停止收尾：定稿片段改写入 pending_finals，由停止命令回包补发。
    stopping: Arc<AtomicBool>,
    pending_finals: Arc<Mutex<Vec<String>>>,
    hypothesis_token: i64,
    result_token: i64,
    completed_token: i64,
    language: String,
}

#[cfg(windows)]
fn start_session(
    state: &mut Option<ActiveSession>,
    app: &AppHandle,
) -> Result<VoiceStartResult, VoiceError> {
    if let Some(existing) = state.as_ref() {
        if existing.active.load(Ordering::SeqCst) {
            return Ok(VoiceStartResult {
                language: existing.language.clone(),
            });
        }
    }
    // 清理已自然结束的旧会话，再新建引擎（自然结束的片段已走事件，无需补发）。
    let _ = stop_session(state);
    let (recognizer, language) = create_recognizer()?;
    match begin_recognition(recognizer, language.clone(), app) {
        Ok(active) => {
            *state = Some(active);
            Ok(VoiceStartResult { language })
        }
        Err(err) => Err(err),
    }
}

/// 听写语言：优先中文（产品中文优先），系统没有中文识别包时回退系统语音语言。
#[cfg(windows)]
fn create_recognizer() -> Result<
    (
        windows::Media::SpeechRecognition::SpeechRecognizer,
        String,
    ),
    VoiceError,
> {
    use windows::Media::SpeechRecognition::SpeechRecognizer;

    if let Ok(languages) = SpeechRecognizer::SupportedTopicLanguages() {
        let count = languages.Size().unwrap_or(0);
        for index in 0..count {
            let Ok(language) = languages.GetAt(index) else {
                continue;
            };
            let tag = language
                .LanguageTag()
                .map(|value| value.to_string())
                .unwrap_or_default();
            if tag.to_ascii_lowercase().starts_with("zh") {
                if let Ok(recognizer) = SpeechRecognizer::Create(&language) {
                    return Ok((recognizer, tag));
                }
            }
        }
    }
    let recognizer =
        SpeechRecognizer::new().map_err(|e| engine_error("系统语音识别不可用", e))?;
    let tag = recognizer
        .CurrentLanguage()
        .ok()
        .and_then(|language| language.LanguageTag().ok())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "system".into());
    Ok((recognizer, tag))
}

/// `start_engine` 的产物：会话句柄、事件开关/补发缓冲与订阅令牌。
#[cfg(windows)]
struct EngineStart {
    session: windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
    active: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    pending_finals: Arc<Mutex<Vec<String>>>,
    hypothesis_token: i64,
    result_token: i64,
    completed_token: i64,
}

/// 编译听写约束并启动连续识别；任何失败都关闭识别器（由调用方负责）。
#[cfg(windows)]
fn begin_recognition(
    recognizer: windows::Media::SpeechRecognition::SpeechRecognizer,
    language: String,
    app: &AppHandle,
) -> Result<ActiveSession, VoiceError> {
    match start_engine(&recognizer, app) {
        Ok(engine) => Ok(ActiveSession {
            recognizer,
            session: engine.session,
            active: engine.active,
            stopping: engine.stopping,
            pending_finals: engine.pending_finals,
            hypothesis_token: engine.hypothesis_token,
            result_token: engine.result_token,
            completed_token: engine.completed_token,
            language,
        }),
        Err(err) => {
            let _ = recognizer.Close();
            Err(err)
        }
    }
}

#[cfg(windows)]
fn start_engine(
    recognizer: &windows::Media::SpeechRecognition::SpeechRecognizer,
    app: &AppHandle,
) -> Result<EngineStart, VoiceError> {
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::SpeechRecognition::{
        ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs,
        SpeechContinuousRecognitionResultGeneratedEventArgs,
        SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus,
        SpeechRecognitionScenario, SpeechRecognitionTopicConstraint,
    };

    let constraints = recognizer
        .Constraints()
        .map_err(|e| VoiceError::Unsupported(format!("读取识别约束失败: {e}")))?;
    let dictation = SpeechRecognitionTopicConstraint::Create(
        SpeechRecognitionScenario::Dictation,
        &HSTRING::from("dictation"),
    )
    .map_err(|e| VoiceError::Unsupported(format!("创建听写约束失败: {e}")))?;
    let constraint: ISpeechRecognitionConstraint = dictation
        .cast()
        .map_err(|e| VoiceError::Unsupported(format!("转换听写约束失败: {e}")))?;
    constraints
        .Append(&constraint)
        .map_err(|e| VoiceError::Unsupported(format!("添加听写约束失败: {e}")))?;

    let compile = recognizer
        .CompileConstraintsAsync()
        .map_err(|e| engine_error("启动语音识别编译失败", e))?;
    wait_operation(&compile, START_TIMEOUT, "启动语音识别编译失败")?;
    let compiled = compile
        .GetResults()
        .map_err(|e| VoiceError::Unsupported(format!("语音识别编译未返回结果: {e}")))?;
    let compile_status = compiled
        .Status()
        .map_err(|e| VoiceError::Unsupported(format!("读取编译状态失败: {e}")))?;
    if compile_status != SpeechRecognitionResultStatus::Success {
        return Err(VoiceError::Unsupported(start_failure_message(compile_status)));
    }

    if let Ok(timeouts) = recognizer.Timeouts() {
        let _ = timeouts.SetInitialSilenceTimeout(TimeSpan {
            Duration: INITIAL_SILENCE_SECS * 10_000_000,
        });
    }

    let session = recognizer
        .ContinuousRecognitionSession()
        .map_err(|e| VoiceError::Unsupported(format!("创建连续识别会话失败: {e}")))?;
    let _ = session.SetAutoStopSilenceTimeout(TimeSpan {
        Duration: AUTO_STOP_SILENCE_SECS * 10_000_000,
    });

    let active = Arc::new(AtomicBool::new(true));
    let stopping = Arc::new(AtomicBool::new(false));
    let pending_finals: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let app_partial = app.clone();
    let active_partial = Arc::clone(&active);
    let hypothesis_token = recognizer
        .HypothesisGenerated(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechRecognizer,
            SpeechRecognitionHypothesisGeneratedEventArgs,
        >::new(move |_sender, args| {
            if !active_partial.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            if let Ok(hypothesis) = args.Hypothesis() {
                if let Ok(text) = hypothesis.Text() {
                    emit_text(&app_partial, PARTIAL_EVENT, &text.to_string());
                }
            }
            Ok(())
        }))
        .map_err(|e| VoiceError::Unsupported(format!("订阅临时结果失败: {e}")))?;

    let app_final = app.clone();
    let active_final = Arc::clone(&active);
    let stopping_final = Arc::clone(&stopping);
    let pending_final = Arc::clone(&pending_finals);
    let result_token = session
        .ResultGenerated(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >::new(move |_sender, args| {
            if !active_final.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            let Ok(result) = args.Result() else {
                return Ok(());
            };
            let succeeded = result
                .Status()
                .map(|status| status == SpeechRecognitionResultStatus::Success)
                .unwrap_or(false);
            let Ok(text) = result.Text() else {
                return Ok(());
            };
            let text = text.to_string();
            let trimmed = text.trim();
            if !succeeded || trimmed.is_empty() {
                return Ok(());
            }
            // StopAsync 会把待定音频作为最后一批结果送来：停止期间改道到回包，
            // 由停止命令确定性地交给前端，避免「说完立刻点停止」丢最后一句。
            if stopping_final.load(Ordering::SeqCst) {
                let mut pending = pending_final.lock().unwrap_or_else(|p| p.into_inner());
                if pending.len() < STOP_PENDING_LIMIT {
                    pending.push(trimmed.to_string());
                } else {
                    tracing::warn!(
                        window = WINDOW_LABEL,
                        "语音输入停止时待补发片段超过上限，丢弃最新一条"
                    );
                }
            } else {
                emit_text(&app_final, FINAL_EVENT, trimmed);
            }
            Ok(())
        }))
        .map_err(|e| VoiceError::Unsupported(format!("订阅识别结果失败: {e}")))?;

    let app_done = app.clone();
    let active_done = Arc::clone(&active);
    let stopping_done = Arc::clone(&stopping);
    let completed_token = session
        .Completed(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionCompletedEventArgs,
        >::new(move |_sender, args| {
            // 停止收尾由 stop_session 统一关闭结果通道并回包，Completed 不抢先把
            // active 置 false（否则 StopAsync 补发的结果会被吞）。
            if stopping_done.load(Ordering::SeqCst) {
                return Ok(());
            }
            // swap(false)：自然结束后的迟到 Completed 不再重复发状态。
            if !active_done.swap(false, Ordering::SeqCst) {
                return Ok(());
            }
            let status = args
                .as_ref()
                .and_then(|args| args.Status().ok())
                .unwrap_or(SpeechRecognitionResultStatus::Unknown);
            let payload: VoiceStatusPayload = classify_end(status).into();
            let _ = app_done.emit_to(WINDOW_LABEL, STATUS_EVENT, payload);
            Ok(())
        }))
        .map_err(|e| VoiceError::Unsupported(format!("订阅会话结束失败: {e}")))?;

    let start = session
        .StartAsync()
        .map_err(|e| engine_error("启动语音识别失败", e))?;
    wait_action(&start, START_TIMEOUT, "启动语音识别失败")?;

    Ok(EngineStart {
        session,
        active,
        stopping,
        pending_finals,
        hypothesis_token,
        result_token,
        completed_token,
    })
}

/// 停止会话并返回停止收尾期间才定稿的片段。
///
/// `StopAsync`（区别于 `CancelAsync`）会把尚未定稿的音频交给 `ResultGenerated`，
/// 因此这里先切到 stopping、保持 active，让结果改道到 pending 缓冲，停止完成后再
/// 取回随命令补发；提前关闭通道会吞掉用户说完立刻点停止的最后一句。
#[cfg(windows)]
fn stop_session(state: &mut Option<ActiveSession>) -> Vec<String> {
    let Some(active) = state.take() else {
        return Vec::new();
    };
    active.stopping.store(true, Ordering::SeqCst);
    if let Ok(stop) = active.session.StopAsync() {
        let _ = wait_action(&stop, STOP_TIMEOUT, "停止语音识别");
    }
    active.active.store(false, Ordering::SeqCst);
    let _ = active
        .recognizer
        .RemoveHypothesisGenerated(active.hypothesis_token);
    let _ = active.session.RemoveResultGenerated(active.result_token);
    let _ = active.session.RemoveCompleted(active.completed_token);
    let _ = active.recognizer.Close();
    let finals = std::mem::take(
        &mut *active
            .pending_finals
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    );
    finals
}

#[cfg(windows)]
fn emit_text(app: &AppHandle, event: &str, raw: &str) {
    let text = raw.trim();
    if text.is_empty() {
        return;
    }
    let _ = app.emit_to(
        WINDOW_LABEL,
        event,
        TextPayload {
            text: text.to_string(),
        },
    );
}

/// 编译失败的状态 → 可操作文案（不回显任何识别正文）。
#[cfg(windows)]
fn start_failure_message(
    status: windows::Media::SpeechRecognition::SpeechRecognitionResultStatus,
) -> String {
    use windows::Media::SpeechRecognition::SpeechRecognitionResultStatus as Status;
    if status == Status::MicrophoneUnavailable {
        "无法访问麦克风，请检查 Windows 隐私设置中的麦克风权限".into()
    } else if status == Status::NetworkFailure {
        "语音识别需要网络连接，请检查网络或系统的在线语音识别设置".into()
    } else if status == Status::TopicLanguageNotSupported
        || status == Status::GrammarLanguageMismatch
    {
        "系统未安装可用的语音识别语言，请在 Windows 设置中安装语音包".into()
    } else if status == Status::UserCanceled {
        "语音输入已取消".into()
    } else {
        format!("语音识别初始化失败（状态码 {}）", status.0)
    }
}

#[cfg(windows)]
fn classify_end(
    status: windows::Media::SpeechRecognition::SpeechRecognitionResultStatus,
) -> SessionEnd {
    use windows::Media::SpeechRecognition::SpeechRecognitionResultStatus as Status;
    if status == Status::Success {
        SessionEnd::Completed
    } else if status == Status::UserCanceled {
        SessionEnd::Canceled
    } else if status == Status::TimeoutExceeded || status == Status::PauseLimitExceeded {
        SessionEnd::Timeout
    } else if status == Status::NetworkFailure {
        SessionEnd::Network
    } else if status == Status::MicrophoneUnavailable {
        SessionEnd::Microphone
    } else if status == Status::AudioQualityFailure {
        SessionEnd::AudioQuality
    } else if status == Status::TopicLanguageNotSupported
        || status == Status::GrammarLanguageMismatch
        || status == Status::GrammarCompilationFailure
    {
        SessionEnd::Language
    } else {
        SessionEnd::Unknown
    }
}

#[cfg(windows)]
fn wait_operation<T: windows::core::RuntimeType>(
    operation: &windows_future::IAsyncOperation<T>,
    timeout: Duration,
    stage: &str,
) -> Result<(), VoiceError> {
    wait_status(
        timeout,
        || operation.Status(),
        || operation.Cancel(),
        || match operation.GetResults() {
            Err(error) => engine_error(stage, error),
            Ok(_) => VoiceError::Unsupported(format!("{stage}: 引擎返回错误")),
        },
    )
}

#[cfg(windows)]
fn wait_action(
    action: &windows_future::IAsyncAction,
    timeout: Duration,
    stage: &str,
) -> Result<(), VoiceError> {
    wait_status(
        timeout,
        || action.Status(),
        || action.Cancel(),
        || match action.GetResults() {
            Err(error) => engine_error(stage, error),
            Ok(()) => VoiceError::Unsupported(format!("{stage}: 引擎返回错误")),
        },
    )
}

/// 有超时的状态轮询：不阻塞 UI 线程，也不无限等待引擎。
/// 异步失败时读取真实 HRESULT（StartAsync 的隐私/权限错误只在这里可见）。
#[cfg(windows)]
fn wait_status(
    timeout: Duration,
    status: impl Fn() -> windows::core::Result<windows_future::AsyncStatus>,
    cancel: impl Fn() -> windows::core::Result<()>,
    on_error: impl FnOnce() -> VoiceError,
) -> Result<(), VoiceError> {
    let started = Instant::now();
    loop {
        match status() {
            Ok(windows_future::AsyncStatus::Completed) => return Ok(()),
            Ok(windows_future::AsyncStatus::Started) => {}
            Ok(windows_future::AsyncStatus::Canceled) => return Err(VoiceError::Timeout),
            Ok(windows_future::AsyncStatus::Error) => return Err(on_error()),
            Ok(_) => return Err(VoiceError::Failed("语音识别引擎返回未知状态".into())),
            Err(e) => return Err(VoiceError::Failed(format!("读取语音识别状态失败: {e}"))),
        }
        if started.elapsed() >= timeout {
            let _ = cancel();
            return Err(VoiceError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_failure_is_actionable_error() {
        let end = SessionEnd::Microphone;
        assert_eq!(end.status(), "error");
        assert_eq!(end.code(), "microphone");
        assert!(end.message().unwrap_or("").contains("麦克风"));
    }

    #[test]
    fn natural_completion_is_idle_without_error_copy() {
        for end in [SessionEnd::Completed, SessionEnd::Canceled] {
            assert_eq!(end.status(), "idle");
            assert!(end.message().is_none());
        }
        // 静音超时只是自然结束，不应显示成错误
        assert_eq!(SessionEnd::Timeout.status(), "idle");
        assert!(SessionEnd::Timeout.message().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn winrt_status_classification_covers_user_actions() {
        use windows::Media::SpeechRecognition::SpeechRecognitionResultStatus as Status;
        assert_eq!(classify_end(Status::Success), SessionEnd::Completed);
        assert_eq!(classify_end(Status::UserCanceled), SessionEnd::Canceled);
        assert_eq!(classify_end(Status::TimeoutExceeded), SessionEnd::Timeout);
        assert_eq!(classify_end(Status::PauseLimitExceeded), SessionEnd::Timeout);
        assert_eq!(classify_end(Status::NetworkFailure), SessionEnd::Network);
        assert_eq!(
            classify_end(Status::MicrophoneUnavailable),
            SessionEnd::Microphone
        );
        assert_eq!(classify_end(Status::Unknown), SessionEnd::Unknown);
    }

    #[cfg(windows)]
    #[test]
    fn privacy_policy_error_is_actionable_permission_error() {
        use windows::core::{Error, HRESULT};
        let error = Error::from_hresult(HRESULT(SPERR_PRIVACY_POLICY_NOT_ACCEPTED));
        let mapped = engine_error("启动语音识别失败", error);
        assert!(matches!(mapped, VoiceError::PermissionRequired(_)));
        let app = mapped.into_app_error();
        assert_eq!(app.code(), "PERMISSION_REQUIRED");
        assert_eq!(app.category().as_str(), "permission");
        assert!(app.user_message().contains("在线语音识别"));
    }

    #[cfg(windows)]
    #[test]
    fn other_engine_errors_keep_stage_context() {
        use windows::core::{Error, HRESULT};
        let error = Error::from_hresult(HRESULT(0x8000_4005u32 as i32));
        match engine_error("启动语音识别失败", error) {
            VoiceError::Unsupported(message) => {
                assert!(message.contains("启动语音识别失败"));
                assert!(message.contains("0x80004005"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn status_event_payload_is_camel_case_and_safe() {
        let payload: VoiceStatusPayload = SessionEnd::Network.into();
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["status"], "error");
        assert_eq!(json["code"], "network");
        assert!(json["message"].as_str().unwrap().contains("网络"));
    }
}
