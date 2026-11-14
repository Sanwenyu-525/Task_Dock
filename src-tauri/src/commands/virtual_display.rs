//! Android 屏幕镜像与独立虚拟屏（ADB + scrcpy）。
//!
//! 两种模式：
//! - `mirror`：镜像手机实体屏（scrcpy 默认显示）；
//! - `virtual`：用 `--new-display` 创建私有虚拟屏，并在其中启动一个应用。
//!
//! 边界：
//! - 画面、输入法、鼠标键盘全部由 scrcpy 独立窗口提供，本模块不自建渲染管线；
//! - 设备/应用/会话都只存在运行期内存，不写 SQLite、不记录设备地址；
//! - 只操作本进程创建的 scrcpy：进程加入 Job Object，关闭走 WM_CLOSE，超时才强杀；
//! - 启动成功不只看 PID：就绪状态由 scrcpy 日志中的虚拟屏/应用/视频流事实驱动。
//!
//! 会话生命周期在 `process` 子模块中统一管理（SessionManager），命令层只做参数校验
//! 与 ADB 查询。该拆分保证「停止等待」不占用全局会话锁，读查询始终可响应。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::winproc;

pub mod process;
use process::StartRequest;

/// 虚拟屏默认参数：与真机 PoC 验证过的组合一致（竖屏 1080×1920 / 384dpi）。
pub const VD_DEFAULT_SIZE: &str = "1080x1920/384";
/// 单会话模式下的并发上限；实验多屏模式放宽到 2（PoC 真机验证过双虚拟屏）。
pub const VD_MAX_SESSIONS: usize = 2;

const MODE_MIRROR: &str = "mirror";
const MODE_VIRTUAL: &str = "virtual";

// ── IPC 类型 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct VdDevice {
    /// 本次操作应使用的 transport（优先直连/USB）。
    pub serial: String,
    /// 物理设备身份：用于识别同一台手机的多个 ADB transport，不作为展示主信息。
    pub uid: String,
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<String>,
    /// usb | wifi | mdns | other
    pub connection: String,
    /// 同一物理设备的全部 transport（运行时信息，不落库）。
    pub transports: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdDeviceList {
    pub devices: Vec<VdDevice>,
    pub adb_ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdApp {
    pub package: String,
    /// 已解析到的应用名；解析不到时为 null，前端回退显示包名。
    pub label: Option<String>,
    pub system: bool,
    /// true=确认有启动入口；false=确认没有；null=当前设备无法判定。
    pub launchable: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdAppList {
    pub device_uid: String,
    pub serial: String,
    pub apps: Vec<VdApp>,
    pub launchable_known: bool,
    pub include_all: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdSession {
    pub id: String,
    pub pid: u32,
    pub serial: String,
    pub device_uid: String,
    pub device_model: Option<String>,
    /// mirror | virtual
    pub mode: String,
    pub package: Option<String>,
    pub app_label: Option<String>,
    /// starting | running | stopping | stopped | error | disconnected
    pub status: String,
    /// process | display | app | video | ready（后端可核验的阶段性事实）
    pub stage: String,
    pub title: String,
    pub started_at: String,
    pub ready_at: Option<String>,
    pub ended_at: Option<String>,
    pub alive: bool,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub size: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdProbe {
    pub adb_path: Option<String>,
    pub adb_version: Option<String>,
    pub scrcpy_path: Option<String>,
    pub scrcpy_version: Option<String>,
    /// 当前 scrcpy 是否支持 `--new-display`（虚拟屏必需，3.0+）。
    pub supports_new_display: bool,
    /// 是否支持 `--display-ime-policy`（虚拟屏本地输入法）。
    pub supports_ime_local: bool,
    pub devices: Vec<VdDevice>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdFocus {
    pub found: bool,
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdScreenshot {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VdDiagnostics {
    pub owned_sessions: usize,
    /// 设备侧由 scrcpy/com.android.shell 创建的虚拟显示（最多 8 条，已截断）。
    pub stale_displays: Vec<String>,
    pub note: String,
}

// ── 设备身份与去重 ──────────────────────────────────────────

#[derive(Debug, Clone)]
struct RawDevice {
    serial: String,
    state: String,
    model: Option<String>,
    product: Option<String>,
    device: Option<String>,
    transport_id: Option<String>,
}

impl RawDevice {
    fn kind(&self) -> &'static str {
        if self.serial.contains("._adb-tls-connect._tcp")
            || self.serial.contains("._adb-tls-pairing._tcp")
        {
            "mdns"
        } else if self.serial.contains(':') {
            "tcp"
        } else {
            "usb"
        }
    }
}

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

fn parse_devices(stdout: &str) -> Vec<RawDevice> {
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
        let mut device = RawDevice {
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

/// mDNS 服务名里带硬件序列号：`adb-<serial>-<random> (2)._adb-tls-connect._tcp`。
fn mdns_uid(serial: &str) -> Option<String> {
    let base = serial.split("._adb").next()?.trim();
    let base = base.split(" (").next()?.trim();
    let rest = base.strip_prefix("adb-")?;
    let (uid, _random) = rest.rsplit_once('-')?;
    if uid.is_empty() {
        return None;
    }
    Some(uid.to_string())
}

/// 合并同一物理设备的多条 transport。
///
/// `tcp_uid`：直连 IP transport → `ro.serialno`（由调用方按需查询并缓存）。
/// 身份未知的 transport 不参与合并：宁可多显示一项，也不能把两台同型号手机并成一台。
fn dedupe_devices(raw: Vec<RawDevice>, tcp_uid: &HashMap<String, String>) -> Vec<VdDevice> {
    let mut groups: Vec<(String, Vec<RawDevice>)> = Vec::new();
    for device in raw {
        let uid = match device.kind() {
            "mdns" => mdns_uid(&device.serial),
            "tcp" => tcp_uid
                .get(&device.serial)
                .cloned()
                .or_else(|| Some(format!("transport:{}", device.serial))),
            _ => Some(device.serial.clone()),
        };
        let Some(uid) = uid else {
            // 解析不出 mDNS 身份：独立成组，避免错误合并。
            groups.push((format!("transport:{}", device.serial), vec![device]));
            continue;
        };
        if let Some((_, list)) = groups.iter_mut().find(|(key, _)| *key == uid) {
            list.push(device);
        } else {
            groups.push((uid, vec![device]));
        }
    }

    let kind_rank = |kind: &str| match kind {
        "usb" => 0,
        "tcp" => 1,
        "mdns" => 2,
        _ => 3,
    };
    let state_rank = |state: &str| match state {
        "device" => 0,
        "authorizing" => 1,
        "connecting" => 2,
        "unauthorized" => 3,
        "offline" => 4,
        _ => 5,
    };

    let mut out = Vec::new();
    for (uid, mut list) in groups {
        list.sort_by_key(|d| (state_rank(&d.state), kind_rank(d.kind())));
        let chosen = &list[0];
        let model = list.iter().find_map(|d| d.model.clone());
        let product = list.iter().find_map(|d| d.product.clone());
        let device = list.iter().find_map(|d| d.device.clone());
        let transport_id = chosen.transport_id.clone();
        let connection = match chosen.kind() {
            "usb" => "usb",
            "tcp" => "wifi",
            "mdns" => "mdns",
            _ => "other",
        };
        let mut transports: Vec<String> = list.iter().map(|d| d.serial.clone()).collect();
        transports.sort();
        // 同一物理设备只要有一条在线，整体即在线（其余 transport 可能是陈旧连接）。
        let state = if list.iter().any(|d| d.state == "device") {
            "device".to_string()
        } else {
            chosen.state.clone()
        };
        out.push(VdDevice {
            serial: chosen.serial.clone(),
            uid,
            state,
            model,
            product,
            device,
            transport_id,
            connection: connection.to_string(),
            transports,
        });
    }
    out.sort_by(|a, b| {
        let online = |d: &VdDevice| (d.state != "device") as u8;
        online(a)
            .cmp(&online(b))
            .then_with(|| a.model.cmp(&b.model))
            .then_with(|| a.serial.cmp(&b.serial))
    });
    out
}

// ── 可执行文件与版本 ────────────────────────────────────────

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

/// `scrcpy --help` 一次缓存 10 分钟：用于判断 `--new-display` 等参数是否受支持。
fn scrcpy_help(scrcpy: &Path) -> Option<String> {
    struct Cache {
        key: PathBuf,
        at: Instant,
        help: Option<String>,
    }
    static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    const TTL: Duration = Duration::from_secs(600);
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut slot = cache.lock().expect("vd help cache");
    if let Some(entry) = slot.as_ref() {
        if entry.key == scrcpy && entry.at.elapsed() < TTL {
            return entry.help.clone();
        }
    }
    let help = run_quiet(scrcpy, &["--help"], Duration::from_secs(5))
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
        .filter(|text| !text.trim().is_empty());
    *slot = Some(Cache {
        key: scrcpy.to_path_buf(),
        at: Instant::now(),
        help: help.clone(),
    });
    help
}

fn scrcpy_supports(scrcpy: &Path, flag: &str) -> bool {
    scrcpy_help(scrcpy)
        .map(|help| help.contains(flag))
        .unwrap_or(false)
}

// ── ADB 查询 ────────────────────────────────────────────────

fn adb_output(adb: &Path, args: &[&str], timeout: Duration) -> Result<std::process::Output, String> {
    let mut cmd = winproc::hidden(adb);
    cmd.args(args);
    winproc::output_with_timeout(&mut cmd, timeout)
        .ok_or_else(|| "adb 命令超时或启动失败".to_string())
}

fn adb_shell(adb: &Path, serial: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut full: Vec<&str> = vec!["-s", serial, "shell"];
    full.extend_from_slice(args);
    let output = adb_output(adb, &full, timeout)?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "adb shell 命令失败".to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 直连 IP transport → 硬件序列号缓存：轮询不重复执行 getprop。
fn tcp_serial_cache() -> &'static Mutex<HashMap<String, (Option<String>, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Option<String>, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tcp_uid(adb: &Path, serial: &str) -> Option<String> {
    const TTL: Duration = Duration::from_secs(300);
    {
        let cache = tcp_serial_cache().lock().expect("vd tcp cache");
        if let Some((value, at)) = cache.get(serial) {
            if at.elapsed() < TTL {
                return value.clone();
            }
        }
    }
    let value = adb_shell(adb, serial, &["getprop", "ro.serialno"], Duration::from_secs(5))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty() && text.len() <= 64);
    let mut cache = tcp_serial_cache().lock().expect("vd tcp cache");
    if cache.len() > 32 {
        cache.clear();
    }
    cache.insert(serial.to_string(), (value.clone(), Instant::now()));
    value
}

fn adb_devices(adb: &Path) -> Result<Vec<VdDevice>, String> {
    let output = adb_output(adb, &["devices", "-l"], Duration::from_secs(8))?;
    if !output.status.success() {
        return Err(format!(
            "adb devices 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw = parse_devices(&String::from_utf8_lossy(&output.stdout));
    let mut uid_map = HashMap::new();
    for device in &raw {
        if device.kind() == "tcp" {
            if let Some(uid) = tcp_uid(adb, &device.serial) {
                uid_map.insert(device.serial.clone(), uid);
            }
        }
    }
    Ok(dedupe_devices(raw, &uid_map))
}

fn device_uid_for_serial(adb: &Path, serial: &str) -> Option<String> {
    let raw = adb_output(adb, &["devices", "-l"], Duration::from_secs(8)).ok()?;
    let raw = parse_devices(&String::from_utf8_lossy(&raw.stdout));
    let entry = raw.iter().find(|d| d.serial == serial)?;
    match entry.kind() {
        "mdns" => mdns_uid(&entry.serial),
        "tcp" => tcp_uid(adb, &entry.serial),
        _ => Some(entry.serial.clone()),
    }
}

// ── 应用枚举 ────────────────────────────────────────────────

fn parse_pm_packages(stdout: &str) -> HashSet<String> {
    stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(str::trim)
        .filter(|pkg| is_package_name(pkg))
        .map(str::to_string)
        .collect()
}

/// `cmd package query-activities --brief` 的组件行 → 包名集合。
fn parse_launchable(stdout: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        for token in line.split_whitespace() {
            let Some((pkg, component)) = token.split_once('/') else {
                continue;
            };
            if component.is_empty() || !is_package_name(pkg) || !pkg.contains('.') {
                continue;
            }
            out.insert(pkg.to_string());
        }
    }
    out
}

fn query_launchable(adb: &Path, serial: &str) -> Option<HashSet<String>> {
    let attempts: [&[&str]; 2] = [
        &[
            "cmd",
            "package",
            "query-activities",
            "--brief",
            "--user",
            "0",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LAUNCHER",
        ],
        &[
            "cmd",
            "package",
            "query-activities",
            "--brief",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LAUNCHER",
        ],
    ];
    for args in attempts {
        let Ok(stdout) = adb_shell(adb, serial, args, Duration::from_secs(12)) else {
            continue;
        };
        let packages = parse_launchable(&stdout);
        if !packages.is_empty() {
            return Some(packages);
        }
        // 命令成功但没有组件：确认不是「命令不存在」的静默输出。
        let lower = stdout.to_lowercase();
        if lower.contains("no activities") || lower.contains("0 activities") {
            return Some(HashSet::new());
        }
    }
    None
}

struct AppCacheEntry {
    fetched_at: Instant,
    uid: String,
    apps: Vec<VdApp>,
    launchable_known: bool,
}

fn app_cache() -> &'static Mutex<HashMap<String, AppCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, AppCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

static APP_LABELS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

/// scrcpy 在启动应用时会输出本地化应用名；记住它，供会话与后续应用列表展示。
pub(crate) fn remember_app_label(device_uid: &str, package: &str, label: &str) {
    let label = label.trim();
    if label.is_empty() || label == package {
        return;
    }
    let mut labels = APP_LABELS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("vd labels");
    if labels.len() > 128 {
        labels.clear();
    }
    labels.insert(format!("{device_uid}\u{0}{package}"), label.to_string());
}

fn known_app_label(device_uid: &str, package: &str) -> Option<String> {
    APP_LABELS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("vd labels")
        .get(&format!("{device_uid}\u{0}{package}"))
        .cloned()
}

fn fetch_apps(adb: &Path, serial: &str) -> Result<(Vec<VdApp>, bool), String> {
    let user = adb_shell(adb, serial, &["pm", "list", "packages", "-3"], Duration::from_secs(20))
        .map(|out| parse_pm_packages(&out))
        .unwrap_or_default();
    let system = adb_shell(adb, serial, &["pm", "list", "packages", "-s"], Duration::from_secs(20))
        .map(|out| parse_pm_packages(&out))
        .unwrap_or_default();
    let mut all: HashSet<String> = HashSet::new();
    all.extend(user.iter().cloned());
    all.extend(system.iter().cloned());
    if all.is_empty() {
        // 兼容极老设备：不带过滤的列表至少能给出包名。
        let plain = adb_shell(adb, serial, &["pm", "list", "packages"], Duration::from_secs(20))
            .map(|out| parse_pm_packages(&out))?;
        if plain.is_empty() {
            return Err("设备未返回任何应用包名".to_string());
        }
        all.extend(plain);
    }
    let launchable = query_launchable(adb, serial);
    let launchable_known = launchable.is_some();
    let mut apps: Vec<VdApp> = all
        .into_iter()
        .map(|package| {
            let is_launchable = launchable
                .as_ref()
                .map(|set| set.contains(&package));
            VdApp {
                label: None,
                system: system.contains(&package),
                launchable: is_launchable,
                reason: match is_launchable {
                    Some(false) => Some("该应用没有启动入口".to_string()),
                    _ => None,
                },
                package,
            }
        })
        .collect();
    apps.sort_by(|a, b| {
        let rank = |app: &VdApp| (app.launchable != Some(true), app.system);
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.package.cmp(&b.package))
    });
    Ok((apps, launchable_known))
}

fn cached_apps(
    adb: &Path,
    serial: &str,
    uid: &str,
) -> Result<(Vec<VdApp>, bool), String> {
    const TTL: Duration = Duration::from_secs(60);
    {
        let cache = app_cache().lock().expect("vd app cache");
        if let Some(entry) = cache.get(serial) {
            if entry.uid == uid && entry.fetched_at.elapsed() < TTL {
                return Ok((entry.apps.clone(), entry.launchable_known));
            }
        }
    }
    let (apps, launchable_known) = fetch_apps(adb, serial)?;
    let mut cache = app_cache().lock().expect("vd app cache");
    if cache.len() > 8 {
        cache.clear();
    }
    cache.insert(
        serial.to_string(),
        AppCacheEntry {
            fetched_at: Instant::now(),
            uid: uid.to_string(),
            apps: apps.clone(),
            launchable_known,
        },
    );
    Ok((apps, launchable_known))
}

fn with_labels(mut apps: Vec<VdApp>, uid: &str) -> Vec<VdApp> {
    for app in &mut apps {
        if app.label.is_none() {
            app.label = known_app_label(uid, &app.package);
        }
    }
    apps
}

// ── 参数校验 ────────────────────────────────────────────────

fn is_package_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
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
    if !is_package_name(package) {
        return Err(AppError::Validation("应用包名无效".into()));
    }
    Ok(package.to_string())
}

fn check_mode(mode: &str) -> AppResult<&'static str> {
    match mode.trim() {
        MODE_MIRROR => Ok(MODE_MIRROR),
        MODE_VIRTUAL => Ok(MODE_VIRTUAL),
        _ => Err(AppError::Validation("投屏模式无效（应为 mirror 或 virtual）".into())),
    }
}

/// `--new-display` 规格校验：`宽x高[/DPI]`，限制在真实可用的范围内。
fn check_size(size: Option<&str>) -> AppResult<String> {
    let raw = size.unwrap_or(VD_DEFAULT_SIZE).trim();
    let (dims, dpi) = match raw.split_once('/') {
        Some((dims, dpi)) => (dims, Some(dpi)),
        None => (raw, None),
    };
    let (width, height) = dims
        .split_once('x')
        .or_else(|| dims.split_once('X'))
        .ok_or_else(|| AppError::Validation("虚拟屏尺寸格式应为 宽x高[/DPI]".into()))?;
    let width: u32 = width
        .parse()
        .map_err(|_| AppError::Validation("虚拟屏宽度无效".into()))?;
    let height: u32 = height
        .parse()
        .map_err(|_| AppError::Validation("虚拟屏高度无效".into()))?;
    let dpi: u32 = match dpi {
        Some(value) => value
            .parse()
            .map_err(|_| AppError::Validation("虚拟屏 DPI 无效".into()))?,
        None => 384,
    };
    if !(200..=4096).contains(&width) || !(200..=4096).contains(&height) {
        return Err(AppError::Validation("虚拟屏分辨率需在 200–4096 之间".into()));
    }
    if !(120..=640).contains(&dpi) {
        return Err(AppError::Validation("虚拟屏 DPI 需在 120–640 之间".into()));
    }
    Ok(format!("{width}x{height}/{dpi}"))
}

fn device_state_message(state: &str) -> &'static str {
    match state {
        "unauthorized" => "设备未授权：请在手机上确认 USB 调试授权",
        "offline" => "设备已离线：请检查无线调试连接后刷新",
        "authorizing" => "设备正在授权，请稍候",
        "connecting" => "设备正在连接，请稍候",
        _ => "设备当前不可用",
    }
}

// ── 命令 ────────────────────────────────────────────────────

/// 环境探测：工具链版本/参数支持 + 当前 ADB 设备。页面打开与手动刷新时调用。
#[tauri::command]
pub fn vd_probe() -> AppResult<VdProbe> {
    let adb = find_adb();
    let scrcpy = find_scrcpy();
    let mut probe = VdProbe {
        adb_path: adb.as_ref().map(|p| p.to_string_lossy().to_string()),
        adb_version: None,
        scrcpy_path: scrcpy.as_ref().map(|p| p.to_string_lossy().to_string()),
        scrcpy_version: None,
        supports_new_display: false,
        supports_ime_local: false,
        devices: Vec::new(),
        error: None,
    };
    if let Some(adb) = adb.as_deref() {
        probe.adb_version = run_quiet(adb, &["version"], Duration::from_secs(4))
            .and_then(|out| first_line(&out.stdout));
        match adb_devices(adb) {
            Ok(devices) => probe.devices = devices,
            Err(err) => probe.error = Some(err),
        }
    } else {
        probe.error = Some("未找到 adb（可设置 TASK_DOCK_ADB 指向 platform-tools）".into());
    }
    if let Some(scrcpy) = scrcpy.as_deref() {
        probe.scrcpy_version = run_quiet(scrcpy, &["--version"], Duration::from_secs(5))
            .and_then(|out| first_line(&out.stdout));
        if let Some(help) = scrcpy_help(scrcpy) {
            probe.supports_new_display = help.contains("--new-display");
            probe.supports_ime_local = help.contains("--display-ime-policy");
        }
    }
    Ok(probe)
}

/// 轻量轮询：只查 ADB 设备状态，不重复执行版本/帮助命令。
#[tauri::command]
pub fn vd_devices() -> AppResult<VdDeviceList> {
    let Some(adb) = find_adb() else {
        return Ok(VdDeviceList {
            devices: Vec::new(),
            adb_ok: false,
            error: Some("未找到 adb".into()),
        });
    };
    match adb_devices(&adb) {
        Ok(devices) => Ok(VdDeviceList {
            devices,
            adb_ok: true,
            error: None,
        }),
        Err(err) => Ok(VdDeviceList {
            devices: Vec::new(),
            adb_ok: true,
            error: Some(err),
        }),
    }
}

/// 设备上具备启动入口的应用（默认）；`include_all` 时附带无入口应用及原因。
#[tauri::command]
pub fn vd_list_apps(serial: String, include_all: Option<bool>) -> AppResult<VdAppList> {
    let serial = check_serial(&serial)?;
    let include_all = include_all.unwrap_or(false);
    let adb = find_adb().ok_or_else(|| AppError::Unavailable("未找到 adb".into()))?;
    let uid = device_uid_for_serial(&adb, &serial)
        .ok_or_else(|| AppError::Unavailable("设备已离线，请刷新设备列表".into()))?;
    let (apps, launchable_known) = cached_apps(&adb, &serial, &uid)
        .map_err(|err| AppError::Unavailable(format!("读取应用列表失败：{err}")))?;
    let apps = with_labels(apps, &uid);
    let apps = if include_all {
        apps
    } else {
        apps.into_iter()
            .filter(|app| app.launchable != Some(false))
            .collect()
    };
    Ok(VdAppList {
        device_uid: uid,
        serial,
        apps,
        launchable_known,
        include_all,
        error: None,
    })
}

/// 创建投屏会话（镜像或独立虚拟屏）。返回后由前端轮询状态直到 running。
#[tauri::command]
pub fn vd_start(
    serial: String,
    mode: String,
    package: Option<String>,
    size: Option<String>,
    clipboard_sync: Option<bool>,
    allow_multi: Option<bool>,
) -> AppResult<VdSession> {
    let serial = check_serial(&serial)?;
    let mode = check_mode(&mode)?;
    let adb = find_adb().ok_or_else(|| {
        AppError::Unavailable("未找到 adb（可设置 TASK_DOCK_ADB 指向 platform-tools）".into())
    })?;
    let scrcpy = find_scrcpy().ok_or_else(|| {
        AppError::Unavailable("未找到 scrcpy（可设置 TASK_DOCK_SCRCPY 指向 scrcpy.exe）".into())
    })?;

    let (package, size, warning) = match mode {
        MODE_VIRTUAL => {
            if !scrcpy_supports(&scrcpy, "--new-display") {
                return Err(AppError::Unavailable(
                    "当前 scrcpy 不支持 --new-display（需要 3.0+），无法创建虚拟屏".into(),
                ));
            }
            let package = check_package(package.as_deref().unwrap_or_default())?;
            let size = check_size(size.as_deref())?;
            let warning = if scrcpy_supports(&scrcpy, "--display-ime-policy") {
                None
            } else {
                Some("当前 scrcpy 不支持 --display-ime-policy：虚拟屏输入法可能出现在手机实体屏".to_string())
            };
            (Some(package), Some(size), warning)
        }
        _ => {
            if package.as_deref().is_some_and(|value| !value.trim().is_empty()) {
                return Err(AppError::Validation("屏幕镜像模式不接受应用包名".into()));
            }
            (None, None, None)
        }
    };

    let devices = adb_devices(&adb).map_err(AppError::Unavailable)?;
    let device = devices
        .iter()
        .find(|device| device.serial == serial || device.transports.iter().any(|t| t == &serial))
        .ok_or_else(|| AppError::Unavailable("设备已离线，请刷新设备列表".into()))?;
    if device.state != "device" {
        return Err(AppError::Unavailable(device_state_message(&device.state).into()));
    }
    // 固定使用后端选定的 transport，避免 mDNS/直连重复 transport 导致 scrcpy 报多设备。
    let transport = device.serial.clone();

    if let Some(package) = package.as_deref() {
        let (apps, launchable_known) = cached_apps(&adb, &transport, &device.uid)
            .map_err(|err| AppError::Unavailable(format!("检查应用启动入口失败：{err}")))?;
        if launchable_known {
            let entry = apps.iter().find(|app| app.package == package);
            match entry.and_then(|app| app.launchable) {
                Some(false) | None => {
                    return Err(AppError::Validation(
                        "该应用没有可启动的入口，无法在虚拟屏中打开".into(),
                    ));
                }
                Some(true) => {}
            }
        }
    }

    let title = match mode {
        MODE_VIRTUAL => format!(
            "Task Dock · 虚拟屏 · {}",
            package.as_deref().unwrap_or("Android")
        ),
        _ => format!(
            "Task Dock · 手机屏幕 · {}",
            device.model.as_deref().unwrap_or("Android")
        ),
    };

    process::manager().start(StartRequest {
        serial: transport,
        device_uid: device.uid.clone(),
        device_model: device.model.clone(),
        mode,
        package: package.clone(),
        app_label: package
            .as_deref()
            .and_then(|pkg| known_app_label(&device.uid, pkg)),
        size,
        clipboard_sync: clipboard_sync.unwrap_or(false),
        allow_multi: allow_multi.unwrap_or(false),
        scrcpy,
        warning,
        title,
    })
}

/// 关闭会话：标记 stopping 后立即返回，后台完成 WM_CLOSE → 有界等待 → 强杀。
#[tauri::command]
pub fn vd_stop(session_id: String) -> AppResult<bool> {
    process::manager().stop(&session_id)
}

/// 会话列表（含刚结束的短保留窗口，便于前端展示错误原因）。
#[tauri::command]
pub fn vd_sessions() -> AppResult<Vec<VdSession>> {
    process::manager().sessions()
}

/// 将 scrcpy 窗口恢复并带到前台。只按本进程记录的 PID 查找，不碰其他 scrcpy。
#[tauri::command]
pub fn vd_focus(session_id: String) -> AppResult<VdFocus> {
    process::manager().focus(&session_id)
}

/// 截取当前会话的 scrcpy 窗口画面（仅用户主动触发；不后台周期截图）。
#[tauri::command]
pub fn vd_screenshot(session_id: String) -> AppResult<VdScreenshot> {
    process::manager().screenshot(&session_id)
}

/// 把最近一次截图另存到用户选择的路径。
#[tauri::command]
pub fn vd_screenshot_export(session_id: String, target_path: String) -> AppResult<bool> {
    process::manager().export_screenshot(&session_id, &target_path)
}

/// 诊断设备侧由 scrcpy 创建的虚拟显示（异常退出后的残留可见性）。
#[tauri::command]
pub fn vd_diagnostics(serial: String) -> AppResult<VdDiagnostics> {
    let serial = check_serial(&serial)?;
    let adb = find_adb().ok_or_else(|| AppError::Unavailable("未找到 adb".into()))?;
    let owned = process::manager().active_count_for_serial(&serial);
    let mut stale = Vec::new();
    if let Ok(stdout) = adb_shell(&adb, &serial, &["dumpsys", "display"], Duration::from_secs(10)) {
        let mut seen = HashSet::new();
        for line in stdout.lines() {
            let line = line.trim();
            if !(line.contains("virtual:com.android.shell") && line.contains("scrcpy")) {
                continue;
            }
            let clipped: String = line.chars().take(160).collect();
            if seen.insert(clipped.clone()) {
                stale.push(clipped);
            }
            if stale.len() >= 8 {
                break;
            }
        }
    }
    let note = if stale.is_empty() {
        "未发现 scrcpy 创建的虚拟显示残留。".to_string()
    } else if owned > 0 {
        format!(
            "发现 {} 个 scrcpy 虚拟显示，其中包含当前运行中的会话；请先关闭会话再判断残留。",
            stale.len()
        )
    } else {
        "发现 scrcpy 虚拟显示但当前没有 Task Dock 会话，可能是异常退出残留。可尝试「重连 ADB」让系统回收；不会自动结束其他 scrcpy 实例。".to_string()
    };
    Ok(VdDiagnostics {
        owned_sessions: owned,
        stale_displays: stale,
        note,
    })
}

/// 重连指定设备的 ADB 连接（仅在无本模块会话时允许），用于清理异常残留。
#[tauri::command]
pub fn vd_reconnect(serial: String) -> AppResult<bool> {
    let serial = check_serial(&serial)?;
    if process::manager().active_count_for_serial(&serial) > 0 {
        return Err(AppError::Conflict(
            "请先关闭该设备上由 Task Dock 管理的投屏会话".into(),
        ));
    }
    let adb = find_adb().ok_or_else(|| AppError::Unavailable("未找到 adb".into()))?;
    let output = adb_output(&adb, &["-s", &serial, "reconnect"], Duration::from_secs(8))
        .map_err(AppError::Unavailable)?;
    if !output.status.success() {
        return Err(AppError::Unavailable(format!(
            "重连 ADB 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(true)
}

/// task_dock 退出时回收本进程创建的全部 scrcpy（Job Object 之外的显式兜底）。
pub fn shutdown_all() {
    process::manager().shutdown_all();
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
    fn mdns_uid_is_extracted_from_service_name() {
        assert_eq!(
            mdns_uid("adb-10CE1P063L0017L-MA7LCw (2)._adb-tls-connect._tcp").as_deref(),
            Some("10CE1P063L0017L")
        );
        assert_eq!(mdns_uid("192.168.1.5:5555"), None);
    }

    #[test]
    fn dedupe_merges_same_phone_transports_but_not_same_model() {
        let raw = parse_devices(
            "List of devices attached\n\
192.168.5.7:38585 device model:V2323A transport_id:1\n\
adb-10CE1P063L0017L-MA7LCw._adb-tls-connect._tcp device model:V2323A transport_id:2\n\
192.168.5.8:39001 device model:V2323A transport_id:3\n",
        );
        let mut uid_map = HashMap::new();
        uid_map.insert("192.168.5.7:38585".to_string(), "10CE1P063L0017L".to_string());
        uid_map.insert("192.168.5.8:39001".to_string(), "OTHERDEVICE0001".to_string());
        let devices = dedupe_devices(raw, &uid_map);
        assert_eq!(devices.len(), 2);
        let merged = devices
            .iter()
            .find(|d| d.uid == "10CE1P063L0017L")
            .expect("merged device");
        assert_eq!(merged.serial, "192.168.5.7:38585");
        assert_eq!(merged.connection, "wifi");
        assert_eq!(merged.transports.len(), 2);
        // 同型号不同设备不能被合并
        assert!(devices.iter().any(|d| d.uid == "OTHERDEVICE0001"));
    }

    #[test]
    fn dedupe_prefers_usb_over_wireless() {
        let raw = parse_devices(
            "List of devices attached\n\
192.168.5.7:38585 device model:V2323A transport_id:1\n\
10CE1P063L0017L device model:V2323A transport_id:2\n",
        );
        let mut uid_map = HashMap::new();
        uid_map.insert("192.168.5.7:38585".to_string(), "10CE1P063L0017L".to_string());
        let devices = dedupe_devices(raw, &uid_map);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].serial, "10CE1P063L0017L");
        assert_eq!(devices[0].connection, "usb");
    }

    #[test]
    fn package_validation_rejects_argv_injection() {
        assert!(check_package("com.android.settings").is_ok());
        assert!(check_package("--help").is_err());
        assert!(check_package("com.foo bar").is_err());
        assert!(check_package("").is_err());
    }

    #[test]
    fn size_validation_bounds_and_canonicalizes() {
        assert_eq!(check_size(None).unwrap(), VD_DEFAULT_SIZE);
        assert_eq!(check_size(Some("1920x1080")).unwrap(), "1920x1080/384");
        assert_eq!(check_size(Some("1080X1920/420")).unwrap(), "1080x1920/420");
        assert!(check_size(Some("100x100")).is_err());
        assert!(check_size(Some("1080x1920/1000")).is_err());
        assert!(check_size(Some("abc")).is_err());
    }

    #[test]
    fn mode_validation_is_closed() {
        assert_eq!(check_mode("mirror").unwrap(), MODE_MIRROR);
        assert_eq!(check_mode("virtual").unwrap(), MODE_VIRTUAL);
        assert!(check_mode("--new-display").is_err());
    }

    #[test]
    fn launchable_parser_reads_brief_components() {
        let output = "com.android.settings/.Settings\n\
com.android.chrome/com.google.android.apps.chrome.Main\n\
  com.example/.Launcher extra-token\n\
not a component\n";
        let set = parse_launchable(output);
        assert!(set.contains("com.android.settings"));
        assert!(set.contains("com.android.chrome"));
        assert!(set.contains("com.example"));
        assert_eq!(set.len(), 3);
    }

    #[test]
    fn pm_packages_parser_ignores_malformed_lines() {
        let set = parse_pm_packages(
            "package:com.android.settings\npackage:dev.taskdock.mobile\nWARNING: something\npackage:-bad\n",
        );
        assert_eq!(set.len(), 2);
        assert!(set.contains("com.android.settings"));
    }
}
