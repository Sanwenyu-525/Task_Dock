//! scrcpy 会话管理：状态机、进程生命周期、日志就绪探测、窗口操作与截图。
//!
//! 并发模型：
//! - 全局 `HashMap<session_id, Arc<SessionHandle>>` 只在增删/遍历时短暂加锁；
//! - 每个会话自己的 `Mutex<Inner>` 保护 Child 与状态；
//! - `stop` 标记 stopping 后立刻返回，收尾线程独立等待，读查询不被阻塞；
//! - 每个会话最多 3 个线程（日志读取、退出等待、停止收尾），会话上限 2。

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Local;
use uuid::Uuid;

use super::{
    remember_app_label, VdFocus, VdScreenshot, VdSession, VD_MAX_SESSIONS,
};
use crate::error::{AppError, AppResult};
use crate::winproc;

pub(crate) const STATUS_STARTING: &str = "starting";
pub(crate) const STATUS_RUNNING: &str = "running";
pub(crate) const STATUS_STOPPING: &str = "stopping";
pub(crate) const STATUS_STOPPED: &str = "stopped";
pub(crate) const STATUS_ERROR: &str = "error";
pub(crate) const STATUS_DISCONNECTED: &str = "disconnected";

const STAGE_PROCESS: &str = "process";
const STAGE_DISPLAY: &str = "display";
const STAGE_APP: &str = "app";
const STAGE_VIDEO: &str = "video";
const STAGE_READY: &str = "ready";

/// 启动就绪上限：超过仍未收到视频流即判定失败并回收。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
/// 停止：先 WM_CLOSE 等 5s，仍未退出才强杀。
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// 结束会话在列表中的保留时间：让前端看到失败原因后自然消失。
const ENDED_RETENTION: Duration = Duration::from_secs(12);

pub struct StartRequest {
    pub serial: String,
    pub device_uid: String,
    pub device_model: Option<String>,
    pub mode: &'static str,
    pub package: Option<String>,
    pub app_label: Option<String>,
    pub size: Option<String>,
    pub clipboard_sync: bool,
    pub allow_multi: bool,
    pub scrcpy: PathBuf,
    pub warning: Option<String>,
    pub title: String,
}

struct Inner {
    child: Child,
    info: VdSession,
    log_path: PathBuf,
    shot_path: Option<PathBuf>,
    last_lines: VecDeque<String>,
    finalized: bool,
    ended_instant: Option<Instant>,
    ready_instant: Option<Instant>,
    app_started: bool,
    ready_warning_added: bool,
    close_requested: bool,
}

struct SessionHandle {
    inner: Mutex<Inner>,
}

impl SessionHandle {
    fn snapshot(&self) -> VdSession {
        self.inner.lock().expect("vd session").info.clone()
    }
}

pub struct SessionManager {
    map: Mutex<std::collections::HashMap<String, Arc<SessionHandle>>>,
}

static MANAGER: OnceLock<SessionManager> = OnceLock::new();

pub fn manager() -> &'static SessionManager {
    MANAGER.get_or_init(|| SessionManager {
        map: Mutex::new(std::collections::HashMap::new()),
    })
}

fn now_stamp() -> String {
    Local::now().to_rfc3339()
}

fn status_is_active(status: &str) -> bool {
    matches!(status, STATUS_STARTING | STATUS_RUNNING | STATUS_STOPPING)
}

fn status_is_ended(status: &str) -> bool {
    matches!(status, STATUS_STOPPED | STATUS_ERROR | STATUS_DISCONNECTED)
}

/// 从 scrcpy stderr 行提取可核验事实。放在纯函数里便于单测。
#[derive(Debug, PartialEq, Eq)]
enum LogSignal {
    NewDisplay,
    StartingApp { package: String, label: Option<String> },
    Texture,
    DeviceDisconnected,
    Error(String),
    Warning(String),
}

fn parse_log_line(line: &str) -> Option<LogSignal> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let line = line.strip_prefix("[server] ").unwrap_or(line);
    if line.contains("Device disconnected") {
        return Some(LogSignal::DeviceDisconnected);
    }
    if let Some((_, message)) = line.split_once("ERROR:") {
        return Some(LogSignal::Error(message.trim().to_string()));
    }
    if let Some((_, message)) = line.split_once("WARN:") {
        return Some(LogSignal::Warning(message.trim().to_string()));
    }
    if line.contains("New display:") {
        return Some(LogSignal::NewDisplay);
    }
    if line.contains("Starting app") {
        let label = line
            .split('"')
            .nth(1)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let package = line
            .split_once('[')
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(pkg, _)| pkg.trim().to_string())
            .filter(|pkg| super::is_package_name(pkg));
        if let Some(package) = package {
            return Some(LogSignal::StartingApp { package, label });
        }
    }
    if line.contains("Texture") {
        return Some(LogSignal::Texture);
    }
    None
}

impl SessionManager {
    pub fn start(&self, req: StartRequest) -> AppResult<VdSession> {
        // 先构造参数（可能读缓存的 scrcpy --help），不要把外部命令放进会话锁内。
        let args = build_args(&req);
        let mut map = self.map.lock().expect("vd sessions");
        let active: Vec<VdSession> = map
            .values()
            .map(|handle| handle.snapshot())
            .filter(|info| status_is_active(&info.status))
            .collect();

        // 重复点击/重复请求：同一设备同一模式同一应用只允许一个活动会话。
        if let Some(existing) = active.iter().find(|info| {
            info.serial == req.serial && info.mode == req.mode && info.package == req.package
        }) {
            let what = if existing.mode == super::MODE_MIRROR {
                "该设备已有屏幕镜像窗口"
            } else {
                "该应用已在虚拟屏中运行"
            };
            return Err(AppError::Conflict(what.into()));
        }

        let limit = if req.allow_multi { VD_MAX_SESSIONS } else { 1 };
        if active.len() >= limit {
            return Err(AppError::Conflict(format!(
                "并发投屏会话已达上限（{limit}）。请先关闭现有窗口{}",
                if req.allow_multi {
                    ""
                } else {
                    "，或在高级选项中开启多屏实验模式"
                }
            )));
        }

        let id = Uuid::new_v4().to_string();
        let log_path = std::env::temp_dir()
            .join("task-dock-vd")
            .join(format!("scrcpy-{id}.log"));
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        File::create(&log_path)?;

        let mut cmd = winproc::hidden(&req.scrcpy);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|err| {
            AppError::Unavailable(format!("启动 scrcpy 失败：{err}"))
        })?;
        let pid = child.id();
        // scrcpy 5.x 把 INFO/Texture/New display/Starting app 写在 stdout，错误写在 stderr；
        // 两路都必须读，否则「进程活着但没就绪」会被误判为成功或超时。
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let mut warnings: Vec<String> = Vec::new();
        if let Some(warning) = req.warning.clone() {
            warnings.push(warning);
        }
        if !win::assign(pid) {
            warnings.push(
                "未能把 scrcpy 加入 Job Object：task_dock 被强制结束时可能残留窗口，请手动关闭"
                    .to_string(),
            );
        }

        let info = VdSession {
            id: id.clone(),
            pid,
            serial: req.serial.clone(),
            device_uid: req.device_uid.clone(),
            device_model: req.device_model.clone(),
            mode: req.mode.to_string(),
            package: req.package.clone(),
            app_label: req.app_label.clone(),
            status: STATUS_STARTING.to_string(),
            stage: STAGE_PROCESS.to_string(),
            title: req.title.clone(),
            started_at: now_stamp(),
            ready_at: None,
            ended_at: None,
            alive: true,
            error: None,
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join("；"))
            },
            size: req.size.clone(),
        };

        let handle = Arc::new(SessionHandle {
            inner: Mutex::new(Inner {
                child,
                info: info.clone(),
                log_path: log_path.clone(),
                shot_path: None,
                last_lines: VecDeque::new(),
                finalized: false,
                ended_instant: None,
                ready_instant: None,
                app_started: false,
                ready_warning_added: false,
                close_requested: false,
            }),
        });
        map.insert(id.clone(), Arc::clone(&handle));
        drop(map);

        let log_serial_err = req.serial.clone();
        let log_serial_out = req.serial.clone();
        let log_path_err = log_path.clone();
        let log_path_out = log_path.clone();
        if let Some(stderr) = stderr {
            let log_handle = Arc::clone(&handle);
            std::thread::Builder::new()
                .name(format!("vd-log-err-{pid}"))
                .spawn(move || {
                    read_logs(
                        log_handle,
                        BufReader::new(stderr),
                        log_path_err,
                        log_serial_err,
                    )
                })
                .ok();
        }
        if let Some(stdout) = stdout {
            let log_handle = Arc::clone(&handle);
            std::thread::Builder::new()
                .name(format!("vd-log-out-{pid}"))
                .spawn(move || {
                    read_logs(
                        log_handle,
                        BufReader::new(stdout),
                        log_path_out,
                        log_serial_out,
                    )
                })
                .ok();
        }
        let wait_handle = Arc::clone(&handle);
        std::thread::Builder::new()
            .name(format!("vd-wait-{pid}"))
            .spawn(move || wait_loop(wait_handle))
            .ok();
        Ok(info)
    }

    pub fn stop(&self, session_id: &str) -> AppResult<bool> {
        let handle = {
            let map = self.map.lock().expect("vd sessions");
            map.get(session_id).cloned()
        };
        let Some(handle) = handle else {
            return Ok(false);
        };
        let (alive, pid, ended) = {
            let mut inner = handle.inner.lock().expect("vd session");
            if inner.finalized || status_is_ended(&inner.info.status) {
                (false, inner.info.pid, true)
            } else {
                inner.info.status = STATUS_STOPPING.to_string();
                (true, inner.info.pid, false)
            }
        };
        if !alive || ended {
            return Ok(true);
        }
        std::thread::Builder::new()
            .name(format!("vd-stop-{pid}"))
            .spawn(move || stop_loop(handle, pid))
            .ok();
        Ok(true)
    }

    pub fn sessions(&self) -> AppResult<Vec<VdSession>> {
        let handles: Vec<Arc<SessionHandle>> = {
            let map = self.map.lock().expect("vd sessions");
            map.values().cloned().collect()
        };
        let mut out: Vec<VdSession> = handles
            .iter()
            .map(|handle| handle.snapshot())
            .collect();
        out.sort_by(|a, b| a.started_at.cmp(&b.started_at));

        // 清理保留期已过的结束会话及其临时截图。
        let mut map = self.map.lock().expect("vd sessions");
        let expired: Vec<String> = map
            .iter()
            .filter_map(|(id, handle)| {
                let inner = handle.inner.lock().expect("vd session");
                match inner.ended_instant {
                    Some(at) if at.elapsed() >= ENDED_RETENTION => Some(id.clone()),
                    _ => None,
                }
            })
            .collect();
        for id in expired {
            if let Some(handle) = map.remove(&id) {
                let inner = handle.inner.lock().expect("vd session");
                remove_file(&inner.log_path);
                if let Some(shot) = &inner.shot_path {
                    remove_file(shot);
                }
            }
        }
        drop(map);
        Ok(out)
    }

    pub fn active_count_for_serial(&self, serial: &str) -> usize {
        let map = self.map.lock().expect("vd sessions");
        map.values()
            .filter(|handle| {
                let info = handle.snapshot();
                info.serial == serial && status_is_active(&info.status)
            })
            .count()
    }

    pub fn focus(&self, session_id: &str) -> AppResult<VdFocus> {
        let handle = self.handle(session_id)?;
        let (alive, pid, status) = {
            let inner = handle.inner.lock().expect("vd session");
            (
                inner.info.alive,
                inner.info.pid,
                inner.info.status.clone(),
            )
        };
        if !alive || status_is_ended(&status) {
            return Err(AppError::Conflict("会话已结束，无法定位窗口".into()));
        }
        let focus = win::focus_window(pid);
        if !focus.found {
            return Err(AppError::NotFound("未找到 scrcpy 窗口".into()));
        }
        Ok(focus)
    }

    pub fn screenshot(&self, session_id: &str) -> AppResult<VdScreenshot> {
        let handle = self.handle(session_id)?;
        let (pid, status) = {
            let inner = handle.inner.lock().expect("vd session");
            (inner.info.pid, inner.info.status.clone())
        };
        if status != STATUS_RUNNING {
            return Err(AppError::Conflict("会话尚未就绪或已结束，无法截图".into()));
        }
        let (png, width, height) = win::capture_window_png(pid)
            .map_err(|err| AppError::Unavailable(format!("截取画面失败：{err}")))?;
        let dir = std::env::temp_dir().join("task-dock-vd").join("shots");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!(
            "shot-{}-{}.png",
            session_id,
            Local::now().timestamp_millis()
        ));
        std::fs::write(&path, png)?;

        let mut inner = handle.inner.lock().expect("vd session");
        if let Some(previous) = inner.shot_path.replace(path.clone()) {
            remove_file(&previous);
        }
        Ok(VdScreenshot {
            path: path.to_string_lossy().to_string(),
            width,
            height,
            captured_at: now_stamp(),
        })
    }

    pub fn export_screenshot(&self, session_id: &str, target: &str) -> AppResult<bool> {
        let target = target.trim();
        let target_path = Path::new(target);
        if target.is_empty() || !target_path.is_absolute() {
            return Err(AppError::Validation("保存路径必须是绝对路径".into()));
        }
        if target_path.is_dir() {
            return Err(AppError::Validation("保存路径不能是文件夹".into()));
        }
        let handle = self.handle(session_id)?;
        let source = {
            let inner = handle.inner.lock().expect("vd session");
            inner.shot_path.clone()
        };
        let Some(source) = source else {
            return Err(AppError::NotFound("还没有截图，请先截屏".into()));
        };
        if !source.is_file() {
            return Err(AppError::NotFound("截图临时文件已不存在".into()));
        }
        std::fs::copy(&source, target_path)?;
        Ok(true)
    }

    pub fn shutdown_all(&self) {
        let handles: Vec<Arc<SessionHandle>> = {
            let map = self.map.lock().expect("vd sessions");
            map.values().cloned().collect()
        };
        for handle in handles {
            let (pid, alive) = {
                let inner = handle.inner.lock().expect("vd session");
                (inner.info.pid, !inner.finalized)
            };
            if !alive {
                continue;
            }
            win::close_windows(pid);
            let deadline = Instant::now() + Duration::from_millis(1500);
            loop {
                let exited = {
                    let mut inner = handle.inner.lock().expect("vd session");
                    matches!(inner.child.try_wait(), Ok(Some(_)))
                };
                if exited || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            {
                let mut inner = handle.inner.lock().expect("vd session");
                if matches!(inner.child.try_wait(), Ok(None)) {
                    let _ = inner.child.kill();
                    let _ = inner.child.wait();
                }
                finalize_locked(&mut inner, STATUS_STOPPED, None, Some("task_dock 退出，已结束会话".into()));
            }
        }
    }

    fn handle(&self, session_id: &str) -> AppResult<Arc<SessionHandle>> {
        let map = self.map.lock().expect("vd sessions");
        map.get(session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("会话不存在或已结束".into()))
    }
}

fn build_args(req: &StartRequest) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-s".into(),
        req.serial.clone(),
        "--no-audio".into(),
    ];
    if !req.clipboard_sync {
        args.push("--no-clipboard-autosync".into());
    }
    if req.mode == super::MODE_VIRTUAL {
        args.push(format!(
            "--new-display={}",
            req.size.as_deref().unwrap_or(super::VD_DEFAULT_SIZE)
        ));
        if super::scrcpy_supports(&req.scrcpy, "--display-ime-policy") {
            args.push("--display-ime-policy=local".into());
        }
        if let Some(package) = &req.package {
            args.push(format!("--start-app={package}"));
        }
    }
    args.push(format!("--window-title={}", req.title));
    args
}

/// 日志脱敏：设备 serial（可能是硬件序列号或 IP:port）不进入诊断尾行/临时日志。
fn redact_line(line: &str, serial: &str) -> String {
    if serial.is_empty() {
        line.to_string()
    } else {
        line.replace(serial, "<设备>")
    }
}

fn read_logs<R: BufRead>(
    handle: Arc<SessionHandle>,
    reader: R,
    log_path: PathBuf,
    serial: String,
) {
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();
    for line in reader.lines().map_while(Result::ok) {
        let line = redact_line(&line, &serial);
        if let Some(file) = log.as_mut() {
            let _ = writeln!(file, "{line}");
        }
        apply_line(&handle, &line);
    }
}

fn apply_line(handle: &SessionHandle, line: &str) {
    let mut inner = handle.inner.lock().expect("vd session");
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if inner.last_lines.len() >= 24 {
        inner.last_lines.pop_front();
    }
    inner.last_lines.push_back(trimmed.chars().take(240).collect());
    if inner.finalized || status_is_ended(&inner.info.status) {
        return;
    }
    match parse_log_line(trimmed) {
        Some(LogSignal::NewDisplay) => {
            if inner.info.status == STATUS_STARTING {
                inner.info.stage = STAGE_DISPLAY.to_string();
            }
        }
        Some(LogSignal::StartingApp { package, label }) => {
            inner.app_started = true;
            inner.info.stage = if inner.info.status == STATUS_RUNNING {
                STAGE_READY.to_string()
            } else {
                STAGE_APP.to_string()
            };
            if inner.info.package.is_none() {
                inner.info.package = Some(package.clone());
            }
            if let Some(label) = label {
                remember_app_label(&inner.info.device_uid, &package, &label);
                inner.info.app_label = Some(label);
            }
        }
        Some(LogSignal::Texture) => {
            if inner.info.status == STATUS_STARTING {
                inner.info.status = STATUS_RUNNING.to_string();
                inner.info.ready_at = Some(now_stamp());
                inner.ready_instant = Some(Instant::now());
            }
            inner.info.stage = if inner.app_started {
                STAGE_READY.to_string()
            } else {
                STAGE_VIDEO.to_string()
            };
        }
        Some(LogSignal::DeviceDisconnected) => {
            inner.info.status = STATUS_DISCONNECTED.to_string();
            inner.info.ended_at = Some(now_stamp());
            inner.ended_instant = Some(Instant::now());
            inner.info.error = Some("设备连接已断开".to_string());
        }
        Some(LogSignal::Error(message)) => {
            if !message.is_empty() {
                inner.info.error = Some(message.clone());
            }
            let fatal = message.contains("Could not start app")
                || message.contains("Unable to start app")
                || message.contains("Could not create display")
                || message.contains("Could not open video stream");
            if fatal {
                inner.info.status = STATUS_ERROR.to_string();
                inner.info.ended_at = Some(now_stamp());
                inner.ended_instant = Some(Instant::now());
            }
        }
        Some(LogSignal::Warning(message)) => {
            if !message.is_empty() {
                let next = match inner.info.warning.take() {
                    Some(previous) if !previous.is_empty() => format!("{previous}；{message}"),
                    _ => message,
                };
                inner.info.warning = Some(next.chars().take(400).collect());
            }
        }
        None => {}
    }
}

fn wait_loop(handle: Arc<SessionHandle>) {
    let started = Instant::now();
    let mut startup_timed_out = false;
    let mut kill_at: Option<Instant> = None;
    loop {
        let (exited, exit_code, pid, status, should_close) = {
            let mut inner = handle.inner.lock().expect("vd session");
            let (exited, exit_code) = match inner.child.try_wait() {
                Ok(Some(exit)) => (true, exit.code()),
                Ok(None) => (false, None),
                Err(_) => (true, None),
            };
            let should_close = status_is_ended(&inner.info.status) && !inner.close_requested;
            if should_close {
                inner.close_requested = true;
            }
            (
                exited,
                exit_code,
                inner.info.pid,
                inner.info.status.clone(),
                should_close,
            )
        };

        if exited {
            let mut inner = handle.inner.lock().expect("vd session");
            let final_status: &'static str = if inner.info.status == STATUS_STOPPING {
                STATUS_STOPPED
            } else if status_is_ended(&inner.info.status) {
                match inner.info.status.as_str() {
                    STATUS_ERROR => STATUS_ERROR,
                    STATUS_DISCONNECTED => STATUS_DISCONNECTED,
                    _ => STATUS_STOPPED,
                }
            } else if inner.info.status == STATUS_RUNNING {
                if exit_code == Some(0) {
                    STATUS_STOPPED
                } else {
                    STATUS_DISCONNECTED
                }
            } else {
                STATUS_ERROR
            };
            let detail = if final_status == STATUS_ERROR
                && inner.info.error.is_none()
            {
                let tail = inner
                    .last_lines
                    .iter()
                    .filter(|line| !line.is_empty())
                    .rev()
                    .take(4)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
                Some(if tail.is_empty() {
                    format!(
                        "scrcpy 在就绪前退出（code {}），该应用可能没有可启动入口",
                        exit_code.unwrap_or(-1)
                    )
                } else {
                    format!("scrcpy 已退出：{tail}")
                })
            } else if final_status == STATUS_DISCONNECTED && inner.info.error.is_none() {
                Some(format!(
                    "scrcpy 异常退出（code {}）",
                    exit_code.unwrap_or(-1)
                ))
            } else {
                None
            };
            finalize_locked(&mut inner, final_status, detail, None);
            break;
        }

        let now = Instant::now();
        if !startup_timed_out && status == STATUS_STARTING && now.duration_since(started) >= STARTUP_TIMEOUT
        {
            startup_timed_out = true;
            {
                let mut inner = handle.inner.lock().expect("vd session");
                if inner.info.status == STATUS_STARTING && !inner.finalized {
                    inner.info.status = STATUS_ERROR.to_string();
                    inner.info.ended_at = Some(now_stamp());
                    inner.ended_instant = Some(now);
                    inner.info.error = Some(format!(
                        "启动超时（{}s）：未收到 scrcpy 视频流，请检查 ADB 连接与应用启动入口",
                        STARTUP_TIMEOUT.as_secs()
                    ));
                }
            }
            win::close_windows(pid);
            kill_at = Some(now + Duration::from_secs(3));
        }

        // 应用启动失败/设备断开时会话已结束：主动收掉仍在运行的 scrcpy。
        if should_close {
            win::close_windows(pid);
            kill_at = Some(now + Duration::from_secs(3));
        }
        if let Some(at) = kill_at {
            if now >= at {
                let mut inner = handle.inner.lock().expect("vd session");
                if matches!(inner.child.try_wait(), Ok(None)) {
                    let _ = inner.child.kill();
                }
            }
        }

        // 虚拟屏已出画面但仍未确认应用启动：追加一条可解释的警告，不改状态。
        if status == STATUS_RUNNING {
            let should_warn = {
                let mut inner = handle.inner.lock().expect("vd session");
                let ready_long_ago = inner
                    .ready_instant
                    .map(|at| at.elapsed() >= Duration::from_secs(4))
                    .unwrap_or(false);
                if inner.info.mode == super::MODE_VIRTUAL
                    && !inner.app_started
                    && !inner.ready_warning_added
                    && ready_long_ago
                {
                    inner.ready_warning_added = true;
                    true
                } else {
                    false
                }
            };
            if should_warn {
                let mut inner = handle.inner.lock().expect("vd session");
                let next = match inner.info.warning.take() {
                    Some(previous) if !previous.is_empty() => format!(
                        "{previous}；已收到视频流，但未能确认应用已启动，画面可能为空"
                    ),
                    _ => "已收到视频流，但未能确认应用已启动，画面可能为空".to_string(),
                };
                inner.info.warning = Some(next);
            }
        }

        std::thread::sleep(Duration::from_millis(120));
    }
}

fn stop_loop(handle: Arc<SessionHandle>, pid: u32) {
    win::close_windows(pid);
    let deadline = Instant::now() + STOP_TIMEOUT;
    let mut forced = false;
    loop {
        let (exited, finalized) = {
            let mut inner = handle.inner.lock().expect("vd session");
            let exited = matches!(inner.child.try_wait(), Ok(Some(_)) | Err(_));
            (exited, inner.finalized)
        };
        if exited || finalized {
            break;
        }
        if Instant::now() >= deadline {
            let mut inner = handle.inner.lock().expect("vd session");
            if matches!(inner.child.try_wait(), Ok(None)) {
                let _ = inner.child.kill();
                let _ = inner.child.wait();
                forced = true;
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut inner = handle.inner.lock().expect("vd session");
    let warning = if forced {
        Some("窗口未在 5 秒内退出，已强制结束进程".to_string())
    } else {
        None
    };
    finalize_locked(&mut inner, STATUS_STOPPED, None, warning);
}

fn finalize_locked(
    inner: &mut Inner,
    status: &str,
    error: Option<String>,
    warning: Option<String>,
) {
    if inner.finalized {
        return;
    }
    inner.finalized = true;
    inner.info.alive = false;
    inner.info.status = status.to_string();
    if inner.info.ended_at.is_none() {
        inner.info.ended_at = Some(now_stamp());
    }
    // 用户关闭窗口属于正常结束，不留下误导性的「错误」。
    if status == STATUS_STOPPED && error.is_none() {
        inner.info.error = None;
    } else if error.is_some() {
        inner.info.error = error;
    }
    if let Some(warning) = warning {
        let next = match inner.info.warning.take() {
            Some(previous) if !previous.is_empty() => format!("{previous}；{warning}"),
            _ => warning,
        };
        inner.info.warning = Some(next);
    }
    inner.ended_instant = Some(Instant::now());
    remove_file(&inner.log_path);
}

fn remove_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

// ── Windows 进程/窗口/截图 ─────────────────────────────────

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows_sys::Win32::Storage::Xps::{PrintWindow, PW_CLIENTONLY};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetClientRect, GetWindow, GetWindowLongW,
        GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW,
        SetForegroundWindow, ShowWindow, GWL_EXSTYLE, GW_OWNER, PW_RENDERFULLCONTENT,
        SW_RESTORE, SW_SHOW, WM_CLOSE, WS_EX_TOOLWINDOW,
    };

    static JOB: OnceLock<isize> = OnceLock::new();

    /// 首次使用时创建 Job；进程退出时 OS 关闭句柄并回收所有子进程。
    /// 返回值是「是否真的加入成功」，调用方必须据此给出警告。
    pub fn assign(pid: u32) -> bool {
        unsafe {
            let job = *JOB.get_or_init(|| {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return 0;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let _ = CloseHandle(handle);
                    return 0;
                }
                handle as isize
            });
            if job == 0 {
                return false;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
            if process.is_null() {
                return false;
            }
            let assigned = AssignProcessToJobObject(job as HANDLE, process) != 0;
            let _ = CloseHandle(process);
            assigned
        }
    }

    struct CloseCtx {
        pid: u32,
        count: usize,
    }

    unsafe extern "system" fn close_cb(hwnd: HWND, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut CloseCtx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == ctx.pid && IsWindowVisible(hwnd) != 0 {
            if PostMessageW(hwnd, WM_CLOSE, 0, 0) != 0 {
                ctx.count += 1;
            }
        }
        1
    }

    /// 只给指定 PID 的可见顶层窗口发 WM_CLOSE（scrcpy 收到后正常销毁虚拟屏）。
    pub fn close_windows(pid: u32) -> usize {
        let mut ctx = CloseCtx { pid, count: 0 };
        unsafe {
            EnumWindows(Some(close_cb), &mut ctx as *mut _ as isize);
        }
        ctx.count
    }

    struct FindCtx {
        pid: u32,
        best: HWND,
        area: i64,
    }

    unsafe extern "system" fn find_cb(hwnd: HWND, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut FindCtx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != ctx.pid || IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        if !GetWindow(hwnd, GW_OWNER).is_null() {
            return 1;
        }
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex_style & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return 1;
        }
        let area = (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64;
        if area > ctx.area {
            ctx.area = area;
            ctx.best = hwnd;
        }
        1
    }

    fn find_window(pid: u32) -> Option<HWND> {
        let mut ctx = FindCtx {
            pid,
            best: std::ptr::null_mut(),
            area: 0,
        };
        unsafe {
            EnumWindows(Some(find_cb), &mut ctx as *mut _ as isize);
        }
        if ctx.best.is_null() {
            None
        } else {
            Some(ctx.best)
        }
    }

    pub fn focus_window(pid: u32) -> super::VdFocus {
        let Some(hwnd) = find_window(pid) else {
            return super::VdFocus {
                found: false,
                focused: false,
            };
        };
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            } else {
                ShowWindow(hwnd, SW_SHOW);
            }
            BringWindowToTop(hwnd);
            let focused = SetForegroundWindow(hwnd) != 0;
            super::VdFocus {
                found: true,
                focused,
            }
        }
    }

    /// 截取 scrcpy 窗口客户区（PW_CLIENTONLY | PW_RENDERFULLCONTENT）。
    /// 返回 (PNG 字节, 宽, 高)；最小化窗口会先恢复再截取。
    pub fn capture_window_png(pid: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let Some(hwnd) = find_window(pid) else {
            return Err("未找到 scrcpy 窗口".to_string());
        };
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
                std::thread::sleep(Duration::from_millis(400));
            }
            let mut rect: RECT = std::mem::zeroed();
            if GetClientRect(hwnd, &mut rect) == 0 {
                return Err("读取窗口客户区失败".to_string());
            }
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0 || height <= 0 {
                return Err("窗口客户区为空，无法截图".to_string());
            }

            let screen_dc = GetDC(hwnd);
            if screen_dc.is_null() {
                return Err("获取窗口 DC 失败".to_string());
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc.is_null() {
                ReleaseDC(hwnd, screen_dc);
                return Err("创建截图 DC 失败".to_string());
            }
            let bitmap: HBITMAP = CreateCompatibleBitmap(screen_dc, width, height);
            if bitmap.is_null() {
                DeleteDC(mem_dc);
                ReleaseDC(hwnd, screen_dc);
                return Err("创建截图位图失败".to_string());
            }
            let old: HGDIOBJ = SelectObject(mem_dc, bitmap as HGDIOBJ);

            let printed = PrintWindow(
                hwnd,
                mem_dc,
                PW_CLIENTONLY | PW_RENDERFULLCONTENT,
            );
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize = std::mem::size_of_val(&info.bmiHeader) as u32;
            info.bmiHeader.biWidth = width;
            // 负高度 = 自上而下，省一次翻转。
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            let lines = if printed != 0 {
                GetDIBits(
                    mem_dc,
                    bitmap,
                    0,
                    height as u32,
                    pixels.as_mut_ptr() as *mut c_void,
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };

            SelectObject(mem_dc, old);
            DeleteObject(bitmap as HGDIOBJ);
            DeleteDC(mem_dc);
            ReleaseDC(hwnd, screen_dc);

            if printed == 0 {
                return Err("PrintWindow 失败（窗口可能受保护或已最小化）".to_string());
            }
            if lines == 0 {
                return Err("读取窗口像素失败".to_string());
            }

            // PrintWindow 不保证 alpha；这里只检查 RGB 是否完全一致（空白/黑屏）。
            let first = [pixels[0], pixels[1], pixels[2]];
            let mut uniform = true;
            for chunk in pixels.chunks_exact(4) {
                if chunk[0] != first[0] || chunk[1] != first[1] || chunk[2] != first[2] {
                    uniform = false;
                    break;
                }
            }
            if uniform {
                return Err("窗口画面为空白，截图失败（请先恢复窗口后重试）".to_string());
            }

            let mut rgba = Vec::with_capacity(pixels.len());
            for chunk in pixels.chunks_exact(4) {
                rgba.extend_from_slice(&[chunk[2], chunk[1], chunk[0], 255]);
            }
            let mut png = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder
                    .write_header()
                    .map_err(|err| format!("PNG 编码失败：{err}"))?;
                writer
                    .write_image_data(&rgba)
                    .map_err(|err| format!("PNG 写入失败：{err}"))?;
            }
            Ok((png, width as u32, height as u32))
        }
    }

    #[allow(dead_code)]
    fn _assert_types(_: PathBuf) {}
}

#[cfg(not(windows))]
mod win {
    pub fn assign(_pid: u32) -> bool {
        false
    }

    pub fn close_windows(_pid: u32) -> usize {
        0
    }

    pub fn focus_window(_pid: u32) -> super::VdFocus {
        super::VdFocus {
            found: false,
            focused: false,
        }
    }

    pub fn capture_window_png(_pid: u32) -> Result<(Vec<u8>, u32, u32), String> {
        Err("当前平台不支持窗口截图".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_signals_cover_display_app_texture_and_errors() {
        assert_eq!(
            parse_log_line("[server] INFO: New display: 1080x1920/384 (id=17)"),
            Some(LogSignal::NewDisplay)
        );
        assert_eq!(
            parse_log_line(
                "[server] INFO: Starting app \"设置\" [com.android.settings] on display 17..."
            ),
            Some(LogSignal::StartingApp {
                package: "com.android.settings".to_string(),
                label: Some("设置".to_string()),
            })
        );
        assert_eq!(
            parse_log_line("INFO: Texture (D3D11VA): 1088x1920"),
            Some(LogSignal::Texture)
        );
        assert_eq!(
            parse_log_line("ERROR: Device disconnected"),
            Some(LogSignal::DeviceDisconnected)
        );
        assert_eq!(
            parse_log_line("ERROR: Could not start app"),
            Some(LogSignal::Error("Could not start app".to_string()))
        );
        assert_eq!(
            parse_log_line("WARN: Could not set clipboard"),
            Some(LogSignal::Warning("Could not set clipboard".to_string()))
        );
        assert_eq!(parse_log_line("scrcpy 5.0.1 <https://github.com/Genymobile/scrcpy>"), None);
    }

    #[test]
    fn build_args_include_mode_specific_flags() {
        let req = StartRequest {
            serial: "192.168.1.5:5555".into(),
            device_uid: "UID".into(),
            device_model: Some("V2323A".into()),
            mode: super::super::MODE_VIRTUAL,
            package: Some("com.android.settings".into()),
            app_label: None,
            size: Some("1080x1920/384".into()),
            clipboard_sync: false,
            allow_multi: false,
            scrcpy: PathBuf::from("scrcpy.exe"),
            warning: None,
            title: "Task Dock · 虚拟屏".into(),
        };
        let args = build_args(&req);
        assert!(args.contains(&"--new-display=1080x1920/384".to_string()));
        assert!(args.contains(&"--start-app=com.android.settings".to_string()));
        assert!(args.contains(&"--no-clipboard-autosync".to_string()));
        assert!(!args.iter().any(|arg| arg == "--display-ime-policy=local"));
    }

    #[test]
    fn build_args_mirror_has_no_virtual_display_flags() {
        let req = StartRequest {
            serial: "10CE1P063L0017L".into(),
            device_uid: "UID".into(),
            device_model: None,
            mode: super::super::MODE_MIRROR,
            package: None,
            app_label: None,
            size: None,
            clipboard_sync: true,
            allow_multi: false,
            scrcpy: PathBuf::from("scrcpy.exe"),
            warning: None,
            title: "Task Dock · 手机屏幕".into(),
        };
        let args = build_args(&req);
        assert!(!args.iter().any(|arg| arg.starts_with("--new-display")));
        assert!(!args.iter().any(|arg| arg.starts_with("--start-app")));
        assert!(!args.iter().any(|arg| arg == "--no-clipboard-autosync"));
    }

    #[test]
    fn status_helpers_are_consistent() {
        assert!(status_is_active(STATUS_STARTING));
        assert!(status_is_active(STATUS_RUNNING));
        assert!(status_is_active(STATUS_STOPPING));
        assert!(status_is_ended(STATUS_STOPPED));
        assert!(status_is_ended(STATUS_ERROR));
        assert!(status_is_ended(STATUS_DISCONNECTED));
        assert!(!status_is_active(STATUS_ERROR));
    }
}
