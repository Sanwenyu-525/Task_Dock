//! Android 虚拟屏 MVP：托管 scrcpy 进程，不实现自有投屏窗口。
//!
//! 设计边界（与 `docs/validation/ANDROID_VIRTUAL_DISPLAY_POC.md` 一致）：
//! - 设备发现与控制全部走本机 `adb`，虚拟屏由 `scrcpy --new-display` 创建；
//! - scrcpy 自己开窗口，本模块只负责启动、记录、优雅关闭与异常回收；
//! - 不把设备序列号/包名写入数据库：均为一次性运行时参数；
//! - 子进程加入 Job Object（KILL_ON_JOB_CLOSE），task_dock 退出时由系统回收，
//!   避免出现 POC 中观测到的「ADB 断开后 scrcpy 进程无窗口残留」。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::winproc;

/// 虚拟屏默认参数：与真机 PoC 验证过的组合一致。
const VD_SIZE: &str = "1080x1920/384";

#[derive(Debug, Clone, Serialize)]
pub struct VdDevice {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdApp {
    pub package: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdSession {
    pub id: String,
    pub pid: u32,
    pub serial: String,
    pub package: String,
    pub started_at: String,
    pub alive: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdDeviceList {
    pub devices: Vec<VdDevice>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdProbe {
    pub adb_path: Option<String>,
    pub adb_version: Option<String>,
    pub scrcpy_path: Option<String>,
    pub scrcpy_version: Option<String>,
    pub devices: Vec<VdDevice>,
    /// ADB 可执行但命令失败时的可读原因（未找到工具时也给出提示）。
    pub error: Option<String>,
}

struct SessionRecord {
    child: Child,
    session: VdSession,
    log_path: PathBuf,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, SessionRecord>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, SessionRecord>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── 可执行文件定位 ────────────────────────────────────────────

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

fn walk_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn find_adb() -> Option<PathBuf> {
    if let Some(p) = env_path("TASK_DOCK_ADB") {
        return Some(p);
    }
    if let Some(p) = walk_path("adb.exe") {
        return Some(p);
    }
    let base = local_app_data()?;
    for candidate in [
        base.join("Android").join("Sdk").join("platform-tools").join("adb.exe"),
        base.join("Android").join("platform-tools").join("adb.exe"),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_scrcpy() -> Option<PathBuf> {
    if let Some(p) = env_path("TASK_DOCK_SCRCPY") {
        return Some(p);
    }
    if let Some(p) = walk_path("scrcpy.exe") {
        return Some(p);
    }
    let base = local_app_data()?;
    let links = base.join("Microsoft").join("WinGet").join("Links").join("scrcpy.exe");
    if links.is_file() {
        return Some(links);
    }
    // winget 包目录：Genymobile.scrcpy_* / scrcpy-win64-v*/scrcpy.exe
    let packages = base.join("Microsoft").join("WinGet").join("Packages");
    let entries = std::fs::read_dir(&packages).ok()?;
    let mut best: Option<(PathBuf, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("Genymobile.scrcpy") {
            continue;
        }
        let dir = entry.path();
        let Ok(inner) = std::fs::read_dir(&dir) else { continue };
        for sub in inner.flatten() {
            let exe = sub.path().join("scrcpy.exe");
            if exe.is_file() {
                let version = sub.file_name().to_string_lossy().to_string();
                if best.as_ref().map(|(_, v)| version > *v).unwrap_or(true) {
                    best = Some((exe, version));
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn run_quiet(program: &Path, args: &[&str], timeout: Duration) -> Option<std::process::Output> {
    let mut cmd = winproc::hidden(program);
    cmd.args(args);
    winproc::output_with_timeout(&mut cmd, timeout)
}

// ── ADB 查询 ────────────────────────────────────────────────

const DEVICE_STATES: &[&str] = &[
    "device",
    "offline",
    "unauthorized",
    "authorizing",
    "connecting",
    "bootloader",
    "recovery",
    "sideload",
    "rescue",
    "host",
];

fn parse_devices(stdout: &str) -> Vec<VdDevice> {
    let mut out = Vec::new();
    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line.starts_with("List of devices")
            || line.starts_with('*')
            || line.starts_with("adb server")
        {
            continue;
        }
        // 序列号可能包含空格（mDNS 传输名），因此先定位状态词再拼回序列号。
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(state_idx) = tokens
            .iter()
            .position(|token| DEVICE_STATES.contains(token))
        else {
            continue;
        };
        let serial = tokens[..state_idx].join(" ");
        if serial.is_empty() {
            continue;
        }
        let mut device = VdDevice {
            serial,
            state: tokens[state_idx].to_string(),
            model: None,
            product: None,
            device: None,
            transport_id: None,
        };
        for token in &tokens[state_idx + 1..] {
            if let Some((key, value)) = token.split_once(':') {
                match key {
                    "model" => device.model = Some(value.to_string()),
                    "product" => device.product = Some(value.to_string()),
                    "device" => device.device = Some(value.to_string()),
                    "transport_id" => device.transport_id = Some(value.to_string()),
                    _ => {}
                }
            }
        }
        out.push(device);
    }
    out
}

fn adb_devices(adb: &Path) -> Result<Vec<VdDevice>, String> {
    let output = run_quiet(adb, &["devices", "-l"], Duration::from_secs(8))
        .ok_or_else(|| "adb devices 超时或启动失败".to_string())?;
    if !output.status.success() {
        return Err(format!(
            "adb devices 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse_devices(&String::from_utf8_lossy(&output.stdout)))
}

fn check_serial(serial: &str) -> AppResult<String> {
    let serial = serial.trim();
    if serial.is_empty() || serial.len() > 200 {
        return Err(AppError::Validation("设备序列号无效".into()));
    }
    if serial.contains(['\n', '\r', '\0']) {
        return Err(AppError::Validation("设备序列号包含非法字符".into()));
    }
    Ok(serial.to_string())
}

fn check_package(package: &str) -> AppResult<String> {
    let package = package.trim();
    let valid = !package.is_empty()
        && package.len() <= 255
        && !package.starts_with('-')
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    if !valid {
        return Err(AppError::Validation("应用包名无效".into()));
    }
    Ok(package.to_string())
}

// ── 命令 ────────────────────────────────────────────────────

/// 环境探测：工具链版本 + 当前 ADB 设备。页面轮询调用，不写任何状态。
#[tauri::command]
pub fn vd_probe() -> AppResult<VdProbe> {
    let adb = find_adb();
    let scrcpy = find_scrcpy();
    let mut probe = VdProbe {
        adb_path: adb.as_ref().map(|p| p.to_string_lossy().to_string()),
        adb_version: None,
        scrcpy_path: scrcpy.as_ref().map(|p| p.to_string_lossy().to_string()),
        scrcpy_version: None,
        devices: Vec::new(),
        error: None,
    };
    if let Some(adb) = adb.as_deref() {
        probe.adb_version = run_quiet(adb, &["version"], Duration::from_secs(3))
            .and_then(|out| first_line(&out.stdout));
        match adb_devices(adb) {
            Ok(devices) => probe.devices = devices,
            Err(err) => probe.error = Some(err),
        }
    } else {
        probe.error = Some("未找到 adb（可设置 TASK_DOCK_ADB 指向 platform-tools）".into());
    }
    if let Some(scrcpy) = scrcpy.as_deref() {
        probe.scrcpy_version = run_quiet(scrcpy, &["--version"], Duration::from_secs(4))
            .and_then(|out| first_line(&out.stdout));
    }
    Ok(probe)
}

/// 轻量轮询：只查 ADB 设备状态，不重复执行版本命令。
#[tauri::command]
pub fn vd_devices() -> AppResult<VdDeviceList> {
    let Some(adb) = find_adb() else {
        return Ok(VdDeviceList {
            devices: Vec::new(),
            error: Some("未找到 adb".into()),
        });
    };
    match adb_devices(&adb) {
        Ok(devices) => Ok(VdDeviceList {
            devices,
            error: None,
        }),
        Err(err) => Ok(VdDeviceList {
            devices: Vec::new(),
            error: Some(err),
        }),
    }
}

/// 设备上可启动的包名列表（系统 + 第三方，前端按关键字过滤）。
#[tauri::command]
pub fn vd_list_apps(serial: String) -> AppResult<Vec<VdApp>> {
    let serial = check_serial(&serial)?;
    let adb = find_adb().ok_or_else(|| AppError::Unavailable("未找到 adb".into()))?;
    let output = run_quiet(
        &adb,
        &["-s", &serial, "shell", "pm", "list", "packages"],
        Duration::from_secs(15),
    )
    .ok_or_else(|| AppError::Unavailable("读取应用列表超时".into()))?;
    if !output.status.success() {
        return Err(AppError::Unavailable(format!(
            "读取应用列表失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let mut packages: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(str::to_string)
        .collect();
    packages.sort();
    packages.dedup();
    Ok(packages
        .into_iter()
        .map(|package| VdApp { package })
        .collect())
}

/// 在指定设备上创建虚拟屏并启动应用（scrcpy 独立窗口）。
#[tauri::command]
pub fn vd_start(serial: String, package: String) -> AppResult<VdSession> {
    let serial = check_serial(&serial)?;
    let package = check_package(&package)?;
    let scrcpy = find_scrcpy().ok_or_else(|| {
        AppError::Unavailable("未找到 scrcpy（可设置 TASK_DOCK_SCRCPY 指向 scrcpy.exe）".into())
    })?;

    let id = uuid::Uuid::new_v4().to_string();
    let log_path = std::env::temp_dir().join(format!("task-dock-vd-{id}.log"));
    let log = std::fs::File::create(&log_path)?;
    let log_err = log.try_clone()?;

    let title = format!("Task Dock · 虚拟屏 · {package}");
    let mut cmd = winproc::hidden(&scrcpy);
    cmd.args([
        "-s",
        serial.as_str(),
        "--no-audio",
        &format!("--new-display={VD_SIZE}"),
        "--display-ime-policy=local",
        &format!("--start-app={package}"),
        &format!("--window-title={title}"),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::from(log_err));

    let mut child = cmd.spawn().map_err(|err| {
        AppError::Unavailable(format!("启动 scrcpy 失败：{err}"))
    })?;
    let pid = child.id();
    job::assign(pid);

    // 参数错误/应用无启动入口时 scrcpy 会在 1-2 秒内退出，提前暴露为可读错误。
    let deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                let detail = std::fs::read_to_string(&log_path).unwrap_or_default();
                let tail = detail
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
                let _ = std::fs::remove_file(&log_path);
                return Err(AppError::Unavailable(if tail.is_empty() {
                    "scrcpy 已退出（该应用可能没有可启动的入口）".into()
                } else {
                    format!("scrcpy 已退出：{tail}")
                }));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(150)),
            Err(err) => {
                let _ = std::fs::remove_file(&log_path);
                return Err(AppError::Io(err));
            }
        }
    }

    let session = VdSession {
        id: id.clone(),
        pid,
        serial,
        package,
        started_at: chrono::Local::now().to_rfc3339(),
        alive: true,
    };
    sessions().lock().expect("vd sessions").insert(
        id,
        SessionRecord {
            child,
            session: session.clone(),
            log_path,
        },
    );
    Ok(session)
}

/// 关闭虚拟屏：先 WM_CLOSE 让 scrcpy 正常销毁虚拟屏，超时才强杀。
#[tauri::command]
pub fn vd_stop(session_id: String) -> AppResult<bool> {
    let mut map = sessions().lock().expect("vd sessions");
    let Some(mut record) = map.remove(&session_id) else {
        return Ok(false);
    };
    let pid = record.session.pid;
    if matches!(record.child.try_wait(), Ok(None)) {
        job::close_windows(pid);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match record.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                _ => {
                    let _ = record.child.kill();
                    let _ = record.child.wait();
                    break;
                }
            }
        }
    }
    let _ = std::fs::remove_file(&record.log_path);
    Ok(true)
}

/// 运行中的虚拟屏会话。已退出的会话在这里被回收，不在前端残留。
#[tauri::command]
pub fn vd_sessions() -> AppResult<Vec<VdSession>> {
    let mut map = sessions().lock().expect("vd sessions");
    let mut out = Vec::new();
    let mut dead = Vec::new();
    for (id, record) in map.iter_mut() {
        match record.child.try_wait() {
            Ok(None) => {
                let mut session = record.session.clone();
                session.alive = true;
                out.push(session);
            }
            _ => {
                dead.push(id.clone());
                let _ = std::fs::remove_file(&record.log_path);
            }
        }
    }
    for id in dead {
        map.remove(&id);
    }
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    Ok(out)
}

// ── Windows 进程/窗口收尾 ───────────────────────────────────

#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
    };

    static JOB: OnceLock<isize> = OnceLock::new();

    /// 首次使用时创建 Job，进程退出时 OS 关闭句柄并回收所有子进程。
    pub fn assign(pid: u32) {
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
                return;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
            if process.is_null() {
                return;
            }
            let _ = AssignProcessToJobObject(job as HANDLE, process);
            let _ = CloseHandle(process);
        }
    }

    unsafe extern "system" fn close_cb(hwnd: *mut c_void, lparam: isize) -> i32 {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == lparam as u32 {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        1
    }

    /// 给指定进程的全部顶层窗口发 WM_CLOSE（scrcpy 收到后正常销毁虚拟屏）。
    pub fn close_windows(pid: u32) {
        unsafe {
            EnumWindows(Some(close_cb), pid as isize);
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub fn assign(_pid: u32) {}
    pub fn close_windows(_pid: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_devices_handles_plain_and_mdns_serials() {
        let output = "List of devices attached\n\
192.168.5.7:38585      device product:PD2323 model:V2323A device:PD2323 transport_id:1\n\
adb-10CE1P063L0017L-MA7LCw (2)._adb-tls-connect._tcp device transport_id:2\n\
emulator-5554          offline\n";
        let devices = parse_devices(output);
        assert_eq!(devices.len(), 3);
        assert_eq!(devices[0].serial, "192.168.5.7:38585");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model.as_deref(), Some("V2323A"));
        assert_eq!(
            devices[1].serial,
            "adb-10CE1P063L0017L-MA7LCw (2)._adb-tls-connect._tcp"
        );
        assert_eq!(devices[2].state, "offline");
    }

    #[test]
    fn package_validation_rejects_argv_injection() {
        assert!(check_package("com.android.settings").is_ok());
        assert!(check_package("--help").is_err());
        assert!(check_package("com.foo bar").is_err());
        assert!(check_package("").is_err());
    }
}
