//! 通用软件发现：开始菜单快捷方式、卸载注册表、UWP 应用与常用软件路径。
//!
//! 原则：
//! - 只扫明确位置，绝不全盘搜索；
//! - 浏览器渲染进程等子进程绝不当作独立软件（进程仅参与「运行状态」判定，
//!   窗口层只枚举顶层可交互窗口）；
//! - 扫描结果只作「发现建议」，落库为导航目标时才成为可信配置；
//! - 扫描带进程内缓存（TTL 5 分钟），UI 打开选择器不重复全量扫描。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::validate_exe_path;

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredApp {
    /// 稳定应用身份：exe 绝对路径（小写）或 UWP AUMID
    pub app_key: String,
    pub display_name: String,
    /// browser | im | music | dev | file | uwp | other
    pub category: String,
    pub exe_path: String,
    pub launch_args: String,
    pub working_dir: String,
    pub app_user_model_id: String,
    /// 窗口标题提示（exe 无法唯一判定时的窗口匹配辅助，如「微信」）
    pub window_title_hint: String,
    /// startmenu | registry | uwp | known | app_paths
    pub source: String,
    /// normal（默认展示）| advanced（默认折叠，可在「显示高级项」查看）。
    /// 无效候选（卸载/安装例程等）不会进入扫描结果。
    #[serde(default)]
    pub tier: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppScanResult {
    pub apps: Vec<DiscoveredApp>,
    pub scanned_at: String,
    pub duration_ms: u64,
    pub counts: HashMap<String, usize>,
    /// 来源级诊断（如 startmenu_truncated / uwp_scan_failed）：
    /// 用于区分「没有匹配」与「发现不完整」，不把扫描失败说成没有结果。
    #[serde(default)]
    pub diagnostics: HashMap<String, u32>,
    /// 本次扫描被取消（前端不再需要结果）。取消既不是完成也不是失败：
    /// `apps` 只含取消前已发现的部分结果，结果不写入扫描缓存。
    #[serde(default)]
    pub cancelled: bool,
}

/// 扫描进度的渐进事件负载（由 nav_scan_apps 分批推送，前端按 scan_id 过滤过期批次）。
#[derive(Debug, Clone, Serialize)]
pub struct AppScanBatch {
    pub scan_id: String,
    /// startmenu | known | app_paths | registry | uwp
    pub source: String,
    /// 本批新增（已按 app_key 去重）的应用
    pub apps: Vec<DiscoveredApp>,
    /// 含本批在内的累计发现数
    pub discovered: usize,
    /// 已**完成**的来源数：同一来源内的中间批次不会推进该计数
    pub sources_done: usize,
    pub sources_total: usize,
}

/// 真机扫描的来源总数（缓存命中不推送批次）；用于前端展示「已扫描来源 x/y」而非虚假百分比。
pub const SCAN_SOURCES_TOTAL: usize = 5;

/// 单个渐进批次最多携带的条目数：避免来源内大量应用一次性涌入导致整块渲染。
const SCAN_BATCH_CHUNK: usize = 60;

// ── 扫描取消 ────────────────────────────────────────────────

/// 一次扫描请求的取消标志。只置位、不阻塞，扫描线程在自己的检查点读取。
#[derive(Debug, Default)]
pub struct ScanCancel {
    flag: AtomicBool,
}

impl ScanCancel {
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
}

/// 取消注册表：在途扫描的令牌 + 先于扫描命令到达的取消意图。
///
/// 前端可能在同一帧里「发起扫描 → 立刻关闭页面」，此时 `nav_cancel_scan` 可能
/// 先于 `nav_scan_apps` 到达后端。丢弃这条取消会让后台白跑完 5 个来源，
/// 因此这里按 `scan_id`（每次请求唯一）暂存取消意图，扫描注册时立即生效。
struct CancelRegistry {
    active: HashMap<String, Arc<ScanCancel>>,
    pending: std::collections::VecDeque<String>,
}

/// 待取消意图上限：scan_id 每次唯一，真正的未消费意图只在「关闭得比扫描还快」时出现，
/// 正常路径会立刻被注册消费；上限只用于兜住异常调用方，防止无界增长。
const MAX_PENDING_CANCELS: usize = 64;

fn cancel_registry() -> &'static Mutex<CancelRegistry> {
    static CELL: OnceLock<Mutex<CancelRegistry>> = OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(CancelRegistry {
            active: HashMap::new(),
            pending: std::collections::VecDeque::new(),
        })
    })
}

/// 扫描请求的取消令牌守卫：注册后可被 `nav_cancel_scan` 命中，Drop 时注销。
///
/// 注册表以 `scan_id` 为键，一个请求一个令牌；扫描结束（成功/失败/取消）即移除，
/// 不产生常驻条目。空 `scan_id`（旧调用方未传）不注册，行为与改造前一致。
pub struct ScanGuard {
    scan_id: String,
    token: Arc<ScanCancel>,
}

impl ScanGuard {
    pub fn register(scan_id: &str) -> Option<Self> {
        let id = scan_id.trim();
        if id.is_empty() {
            return None;
        }
        let token = Arc::new(ScanCancel::default());
        let mut reg = cancel_registry().lock().unwrap();
        // 取消先到：注册即视为已取消，扫描在第一个检查点退出。
        if let Some(pos) = reg.pending.iter().position(|x| x == id) {
            reg.pending.remove(pos);
            token.cancel();
        }
        reg.active.insert(id.to_string(), token.clone());
        Some(Self {
            scan_id: id.to_string(),
            token,
        })
    }

    pub fn token(&self) -> &ScanCancel {
        &self.token
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        if let Ok(mut reg) = cancel_registry().lock() {
            reg.active.remove(&self.scan_id);
        }
    }
}

/// 当前正在执行的扫描数量（生命周期探针；只读内存注册表，不扫描进程）。
pub fn active_scan_count() -> usize {
    cancel_registry()
        .lock()
        .map(|reg| reg.active.len())
        .unwrap_or(0)
}

/// 请求取消某次扫描：只置标志并立即返回，不在 IPC 线程等待扫描退出。
/// 返回 false 仅当 `scan_id` 为空；未知/已完成请求也会返回 true（记为待取消，
/// 由上限兜底），调用方仍必须以后端扫描结果的 `cancelled` 字段为准。
pub fn request_cancel(scan_id: &str) -> bool {
    let id = scan_id.trim();
    if id.is_empty() {
        return false;
    }
    let mut reg = cancel_registry().lock().unwrap();
    if let Some(token) = reg.active.get(id) {
        token.cancel();
        return true;
    }
    if !reg.pending.iter().any(|x| x == id) {
        if reg.pending.len() >= MAX_PENDING_CANCELS {
            reg.pending.pop_front();
        }
        reg.pending.push_back(id.to_string());
    }
    true
}

/// 应用运行状态（区分「进程在」与「有窗口」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunningState {
    NotRunning,
    /// 有进程但无可交互窗口（后台/托盘）
    ProcessOnly,
    /// 存在可交互窗口
    HasWindow,
}

const SCAN_CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_LNK_FILES: usize = 600;
const MAX_LNK_DEPTH: usize = 4;

fn cache_cell() -> &'static std::sync::Mutex<Option<(Instant, AppScanResult)>> {
    use std::sync::{Mutex, OnceLock};
    static CELL: OnceLock<Mutex<Option<(Instant, AppScanResult)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// 扫描已安装软件（TTL 内直接返回缓存；force 绕过）。
pub fn scan_installed_apps(force: bool) -> AppScanResult {
    scan_installed_apps_streaming(force, None, |_, _, _, _| {})
}

/// 渐进扫描：按来源推进，每完成一个来源（或来源内达到分块上限）就回调一批新增应用。
///
/// - `cancel` 为 `None` 时行为与旧版一致（不可取消）；
/// - 回调参数：`(本批新增, 来源, 累计发现数, 本来源是否已完成)`；
/// - 取消只停止后续来源与子进程，不 panic、不阻塞；取消结果 `cancelled = true`
///   且**不写入扫描缓存**，避免把半截结果当成完整扫描在 TTL 内复用。
/// - 缓存命中即时返回完整结果，不推送批次（也避免「来源 1/5」的误导性进度）。
pub fn scan_installed_apps_streaming<F>(
    force: bool,
    cancel: Option<&ScanCancel>,
    mut on_batch: F,
) -> AppScanResult
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    if cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
        // 尚未开始就已被取消：不读缓存、不写缓存，也不推送任何批次。
        let mut diagnostics = HashMap::new();
        diagnostics.insert("scan_cancelled".to_string(), 1);
        return AppScanResult {
            apps: Vec::new(),
            scanned_at: crate::agents::now_iso(),
            duration_ms: 0,
            counts: HashMap::new(),
            diagnostics,
            cancelled: true,
        };
    }
    let cached = {
        let guard = cache_cell().lock().unwrap();
        match guard.as_ref() {
            Some((at, r)) if !force && at.elapsed() < SCAN_CACHE_TTL => Some(r.clone()),
            _ => None,
        }
    };
    if let Some(r) = cached {
        super::app_icons::register_discovered(&r.apps);
        return r;
    }
    let started = Instant::now();
    let mut result = scan_now_streaming(cancel, &mut on_batch);
    result.duration_ms = started.elapsed().as_millis() as u64;
    result.scanned_at = crate::agents::now_iso();
    if result.cancelled {
        result.diagnostics.insert("scan_cancelled".into(), 1);
        // 取消：只追加登记，不清空旧登记，取消前已显示的图标仍可复用；
        // 也不写扫描缓存（下一次扫描必须重新执行，不能把半截结果当完整结果）。
        super::app_icons::register_discovered_batch(&result.apps);
    } else {
        // 扫描结束后整体收敛身份登记（清掉已卸载应用），并用最终结果刷新缓存。
        super::app_icons::register_discovered(&result.apps);
        *cache_cell().lock().unwrap() = Some((Instant::now(), result.clone()));
    }
    result
}

// ── 分类知识 ────────────────────────────────────────────────

/// exe 文件名（小写、不含 .exe）→ 分类。
fn category_for_exe(exe_lower: &str) -> &'static str {
    let stem = Path::new(exe_lower)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let contains = |names: &[&str]| names.iter().any(|n| stem.contains(n));
    if contains(&[
        "chrome", "msedge", "firefox", "opera", "brave", "vivaldi", "browser",
    ]) {
        "browser"
    } else if contains(&[
        "wechat", "weixin", "qq", "dingtalk", "feishu", "lark", "telegram", "whatsapp", "tim",
        "discord", "slack",
    ]) {
        "im"
    } else if contains(&[
        "kugou",
        "cloudmusic",
        "qqmusic",
        "kwmusic",
        "spotify",
        "foobar",
        "potplayer",
        "vlc",
    ]) {
        "music"
    } else if contains(&[
        "code",
        "trae",
        "qoder",
        "cursor",
        "idea",
        "pycharm",
        "webstorm",
        "goland",
        "rustrover",
        "clion",
        "rider",
        "datagrip",
        "studio64",
        "sublime",
        "notepad++",
        "vim",
        "neovim",
        "emacs",
        "windsurf",
    ]) {
        "dev"
    } else if contains(&["explorer"]) {
        "file"
    } else {
        "other"
    }
}

/// 常用软件的窗口标题提示（中文应用 exe 名与显示名差异大，标题匹配更可靠）。
fn title_hint_for_exe(exe_lower: &str) -> &'static str {
    let stem = Path::new(exe_lower)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if stem.contains("wechat") || stem.contains("weixin") {
        "微信"
    } else if stem == "qq" || stem.contains("tim") {
        "QQ"
    } else if stem.contains("kugou") {
        "酷狗"
    } else if stem.contains("cloudmusic") {
        "网易云音乐"
    } else if stem.contains("qqmusic") {
        "QQ音乐"
    } else if stem.contains("dingtalk") {
        "钉钉"
    } else if stem.contains("feishu") || stem.contains("lark") {
        "飞书"
    } else {
        ""
    }
}

/// 常用软件的常见安装位置（开始菜单缺失时的补充；只探测，不搜索）。
#[cfg(windows)]
fn known_app_candidates() -> Vec<(String, String)> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| pf.clone());
    let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut v: Vec<(String, String)> = vec![
        (
            format!("{}\\Google\\Chrome\\Application\\chrome.exe", pf),
            "Google Chrome".into(),
        ),
        (
            format!("{}\\Google\\Chrome\\Application\\chrome.exe", pf86),
            "Google Chrome".into(),
        ),
        (
            format!("{}\\Google\\Chrome\\Application\\chrome.exe", la),
            "Google Chrome".into(),
        ),
        (
            format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", pf),
            "Microsoft Edge".into(),
        ),
        (
            format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", pf86),
            "Microsoft Edge".into(),
        ),
        (
            format!("{}\\Mozilla Firefox\\firefox.exe", pf),
            "Firefox".into(),
        ),
        (
            format!("{}\\Microsoft VS Code\\Code.exe", pf),
            "Visual Studio Code".into(),
        ),
        (
            format!("{}\\Programs\\Microsoft VS Code\\Code.exe", la),
            "Visual Studio Code".into(),
        ),
    ];
    if let Some(p) = crate::agents::managed::find_exe(&["code", "code.cmd"]) {
        v.push((p.to_string_lossy().to_string(), "Visual Studio Code".into()));
    }
    v
}

// ── 各来源扫描 ──────────────────────────────────────────────

// ── 渐进采集器 ──────────────────────────────────────────────

/// 扫描期间的应用集合 + 分批推送。
///
/// 分块规则：跨来源按「来源完成」推进进度；来源内部每累积 [`SCAN_BATCH_CHUNK`] 条
/// 就先推送一批（`source_done = false`），避免某个来源一次涌入数百条。
/// 每批只含本批新增（全局按 app_key 去重），`discovered` 是本批为止的累计数。
struct ScanCollector<'a, F>
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    apps: Vec<DiscoveredApp>,
    source: &'static str,
    /// 当前来源第一条应用的下标（用于统计本来源新增数）。
    source_from: usize,
    /// 已推送到前端的条目数（`apps[..published]`）。
    published: usize,
    on_batch: &'a mut F,
    cancel: Option<&'a ScanCancel>,
}

impl<'a, F> ScanCollector<'a, F>
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    fn new(on_batch: &'a mut F, cancel: Option<&'a ScanCancel>) -> Self {
        Self {
            apps: Vec::new(),
            source: "startmenu",
            source_from: 0,
            published: 0,
            on_batch,
            cancel,
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.map(|c| c.is_cancelled()).unwrap_or(false)
    }

    fn cancel_token(&self) -> Option<&'a ScanCancel> {
        self.cancel
    }

    fn begin_source(&mut self, source: &'static str) {
        self.source = source;
        self.source_from = self.apps.len();
    }

    /// 推入一条候选（按 app_key 去重）；达到分块上限时先推送已有条目。
    fn push(&mut self, app: DiscoveredApp) {
        let before = self.apps.len();
        push_unique(&mut self.apps, app);
        if self.apps.len() > before && self.apps.len() - self.published >= SCAN_BATCH_CHUNK {
            self.flush(false);
        }
    }

    /// 结束当前来源：推送剩余条目；返回本来源新增数。
    ///
    /// `completed = false`（扫描中途被取消）时只把已发现的真实条目推出去，
    /// **不发送完成片**，因此不会推进前端的 `sources_done`。
    /// `completed = true` 时最后一片标记完成；若来源没有新增（或恰好整批完成），
    /// 补发一个空的完成片让进度前进。
    fn end_source(&mut self, completed: bool) -> usize {
        let added = self.apps.len() - self.source_from;
        self.flush(completed);
        self.source_from = self.apps.len();
        added
    }

    fn flush(&mut self, complete: bool) {
        let total = self.apps.len();
        let mut emitted_done = false;
        while self.published < total {
            let end = (self.published + SCAN_BATCH_CHUNK).min(total);
            // 先登记身份，保证前端收到批次后立即请求图标不会因「尚未登记」失败；
            // 扫描完成前不清空旧登记，避免重扫期间已有图标失效。
            super::app_icons::register_discovered_batch(&self.apps[self.published..end]);
            let done = complete && end == total;
            (self.on_batch)(&self.apps[self.published..end], self.source, end, done);
            self.published = end;
            if done {
                emitted_done = true;
            }
        }
        if complete && !emitted_done {
            // 来源没有新增（或恰好整批完成）也要推送一次「来源完成」，
            // 让进度 sources_done 前进；批次可以为空。
            (self.on_batch)(&[], self.source, total, true);
        }
    }
}

/// 逐来源扫描：每完成一个来源（或来源内达到分块上限）即回调，
/// 最终按应用名（同名前缀按身份兜底）稳定排序返回权威结果。
#[cfg(windows)]
fn scan_now_streaming<F>(cancel: Option<&ScanCancel>, on_batch: &mut F) -> AppScanResult
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    let mut counts = HashMap::new();
    let mut diagnostics: HashMap<String, u32> = HashMap::new();
    let mut c = ScanCollector::new(on_batch, cancel);

    c.begin_source("startmenu");
    scan_start_menu(&mut c, &mut diagnostics);
    counts.insert("startmenu".into(), c.end_source(!c.cancelled()));

    // 每个来源开始前检查取消：取消后不再启动后续来源（尤其不再拉起 PowerShell）。
    if !c.cancelled() {
        c.begin_source("known");
        scan_known(&mut c);
        counts.insert("known".into(), c.end_source(!c.cancelled()));
    }
    if !c.cancelled() {
        c.begin_source("app_paths");
        scan_app_paths(&mut c, &mut diagnostics);
        counts.insert("app_paths".into(), c.end_source(!c.cancelled()));
    }
    if !c.cancelled() {
        c.begin_source("registry");
        scan_registry(&mut c, &mut diagnostics);
        counts.insert("registry".into(), c.end_source(!c.cancelled()));
    }
    if !c.cancelled() {
        c.begin_source("uwp");
        scan_uwp(&mut c, &mut diagnostics);
        counts.insert("uwp".into(), c.end_source(!c.cancelled()));
    }

    let cancelled = c.cancelled();
    let mut apps = c.apps;
    // 稳定顺序：名称（忽略大小写）优先，同名时按应用身份兜底，
    // 避免同名条目在不同扫描间顺序漂移。
    apps.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
            .then_with(|| a.app_key.cmp(&b.app_key))
    });
    AppScanResult {
        apps,
        scanned_at: String::new(),
        duration_ms: 0,
        counts,
        diagnostics,
        cancelled,
    }
}

#[cfg(not(windows))]
fn scan_now_streaming<F>(cancel: Option<&ScanCancel>, _on_batch: &mut F) -> AppScanResult
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    AppScanResult {
        apps: Vec::new(),
        scanned_at: String::new(),
        duration_ms: 0,
        counts: HashMap::new(),
        diagnostics: HashMap::new(),
        cancelled: cancel.map(|c| c.is_cancelled()).unwrap_or(false),
    }
}

/// 按 app_key 去重。同一身份下「普通项」优先于先到的「高级项」：
/// 例如开始菜单里先遍历到指向主程序的「卸载 Foo」快捷方式时，
/// 不能被它遮蔽随后发现的同名普通入口（否则应用在默认列表里直接消失）。
fn push_unique(apps: &mut Vec<DiscoveredApp>, a: DiscoveredApp) {
    if a.app_key.is_empty() {
        return;
    }
    if let Some(existing) = apps.iter_mut().find(|x| x.app_key == a.app_key) {
        if existing.tier == "advanced" && a.tier == "normal" {
            *existing = a;
        }
        return;
    }
    apps.push(a);
}

/// 可选来源读取失败的分类：`NotFound` 表示该项本来就不存在（例如从未安装过
/// 32 位应用、HKCU 下没有 App Paths、某台机器没有公共开始菜单目录），
/// 属于**正常缺失**，不说明本次发现不完整。
///
/// 权限拒绝、I/O 错误、注册表损坏等才是真实失败，必须计入诊断：
/// 把「读不到」伪装成「没有应用」会让用户以为本机确实没装。
#[cfg(windows)]
fn is_optional_source_missing(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}

/// 记录一次来源读取失败：正常缺失返回 `false` 且不写诊断；
/// 真实失败按 `diag_key` 计数并返回 `true`。枚举迭代中途的错误同样走这里。
#[cfg(windows)]
fn note_source_read_error(
    diags: &mut HashMap<String, u32>,
    diag_key: &str,
    err: &std::io::Error,
) -> bool {
    if is_optional_source_missing(err) {
        return false;
    }
    *diags.entry(diag_key.to_string()).or_insert(0) += 1;
    true
}

/// 开始菜单快捷方式（用户 + 所有用户）。
/// 目录不可读、快捷方式无法解析都记入来源诊断，不静默当成「没有安装应用」；
/// 目录本身不存在属于正常缺失，不计入诊断。
#[cfg(windows)]
fn scan_start_menu<F>(c: &mut ScanCollector<'_, F>, diags: &mut HashMap<String, u32>)
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Ok(pd) = std::env::var("ProgramData") {
        dirs.push(PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    let mut budget = MAX_LNK_FILES;
    let mut truncated = false;
    for dir in dirs {
        if c.cancelled() {
            return;
        }
        if budget == 0 {
            // 还有未遍历的根目录：预算确实被耗尽，不能只看 budget==0 就报截断。
            truncated = true;
            break;
        }
        walk_lnk_dir(&dir, 0, &mut budget, c, &mut truncated, diags);
    }
    if truncated {
        diags.insert("startmenu_truncated".into(), 1);
    }
}

#[cfg(windows)]
fn walk_lnk_dir<F>(
    dir: &Path,
    depth: usize,
    budget: &mut usize,
    c: &mut ScanCollector<'_, F>,
    truncated: &mut bool,
    diags: &mut HashMap<String, u32>,
) where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    if c.cancelled() {
        return;
    }
    if depth > MAX_LNK_DEPTH {
        // 深度上限：只有目录里确实还有内容时才标记「发现不完整」，空目录不算截断。
        // 读取失败（权限/I/O）不能当作空目录：真实错误计入诊断，正常缺失才是无内容。
        match std::fs::read_dir(dir) {
            Ok(mut it) => {
                if it.next().is_some() {
                    *truncated = true;
                }
            }
            Err(e) => {
                note_source_read_error(diags, "startmenu_dir_unreadable", &e);
            }
        }
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            // 目录不存在 = 可选来源正常缺失（如精简系统没有公共开始菜单）；
            // 权限/I/O 错误 = 真实读取失败，如实计入诊断。
            note_source_read_error(diags, "startmenu_dir_unreadable", &e);
            return;
        }
    };
    for entry in entries {
        if c.cancelled() {
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                // 目录遍历中途失败的条目不能静默跳过，否则结果会无故变少。
                note_source_read_error(diags, "startmenu_dir_unreadable", &e);
                continue;
            }
        };
        if *budget == 0 {
            // 仍有未处理条目 → 预算截断；恰好处理完最后一条则不会走到这里。
            *truncated = true;
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_lnk_dir(&path, depth + 1, budget, c, truncated, diags);
        } else if path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            *budget -= 1;
            match parse_lnk(&path) {
                Ok(Some(app)) => c.push(app),
                // 命中卸载/安装例程等过滤规则：正常忽略，不是错误。
                Ok(None) => {}
                // 快捷方式存在但无法解析/目标已失效：计入诊断，不当成扫描失败。
                Err(()) => {
                    *diags.entry("startmenu_lnk_unreadable".into()).or_insert(0) += 1;
                }
            }
        }
    }
}

/// 解析单个 .lnk：目标必须是通过安全校验的本地 exe。
/// 外部文件按不可信数据处理：解析库 panic（畸形 lnk）也被拦下，绝不让扫描崩掉。
///
/// 返回 `Err(())` 表示快捷方式本身无法解析或目标已失效（诊断用）；
/// `Ok(None)` 表示按候选规则主动过滤（卸载/安装例程），不是错误。
#[cfg(windows)]
fn parse_lnk(path: &Path) -> Result<Option<DiscoveredApp>, ()> {
    let display_name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // 优先走 Windows Shell（IShellLinkW）：快捷方式的 LinkInfo 可能是历史遗留路径，
    // 真实目标在 LinkTargetIDList 中（例：微信的 .lnk 里 LinkInfo 仍指向已删除的
    // D:\微信\WeChat\WeChat.exe，而实际安装位置是 D:\微信\Weixin\Weixin.exe）。
    let mut resolved = super::app_icons::resolve_shortcut(&path.to_string_lossy());
    if !matches!(&resolved, Some((t, _, _)) if validate_exe_path(t).is_ok()) {
        // COM 不可用或目标失效时回退到纯 Rust 解析（不因单一来源失败丢掉全部快捷方式）
        resolved = std::panic::catch_unwind(|| lnk::ShellLink::open(path).ok())
            .ok()
            .flatten()
            .and_then(|sl| {
                let target = sl
                    .link_info()
                    .as_ref()
                    .and_then(|li| li.local_base_path().clone())
                    .unwrap_or_default();
                if target.is_empty() {
                    return None;
                }
                Some((
                    target,
                    sl.arguments().clone().unwrap_or_default(),
                    sl.working_dir().clone().unwrap_or_default(),
                ))
            });
    }
    let (target, launch_args, raw_wd) = resolved.ok_or(())?;
    // 目标校验：绝对路径 + .exe + 存在 + 非解释器（复用导航安全校验）
    if validate_exe_path(&target).is_err() {
        return Err(());
    }
    let lower = target.to_ascii_lowercase();
    let tier = candidate_tier(&display_name, &lower);
    if tier == CandidateTier::Invalid {
        // 卸载/安装例程不进入候选；高级项保留，由前端默认折叠、可展开。
        return Ok(None);
    }
    let working_dir = {
        let t = raw_wd.trim();
        if !t.is_empty() && Path::new(t).is_dir() {
            t.to_string()
        } else {
            String::new()
        }
    };
    Ok(Some(DiscoveredApp {
        app_key: lower.clone(),
        display_name: display_name.trim().to_string(),
        category: category_for_exe(&lower).to_string(),
        window_title_hint: title_hint_for_exe(&lower).to_string(),
        exe_path: target,
        launch_args: launch_args.trim().to_string(),
        working_dir,
        app_user_model_id: String::new(),
        source: "startmenu".into(),
        tier: tier.as_str().to_string(),
    }))
}

/// 常用软件路径补充探测。
#[cfg(windows)]
fn scan_known<F>(c: &mut ScanCollector<'_, F>)
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    for (exe, name) in known_app_candidates() {
        if c.cancelled() {
            return;
        }
        let lower = exe.to_ascii_lowercase();
        if validate_exe_path(&exe).is_err() {
            continue;
        }
        c.push(DiscoveredApp {
            app_key: lower.clone(),
            display_name: name,
            category: category_for_exe(&lower).to_string(),
            window_title_hint: title_hint_for_exe(&lower).to_string(),
            exe_path: exe,
            launch_args: String::new(),
            working_dir: String::new(),
            app_user_model_id: String::new(),
            source: "known".into(),
            tier: CandidateTier::Normal.as_str().to_string(),
        });
    }
}

/// 候选分层：普通 / 高级（默认折叠、可展开）/ 无效（不进扫描结果）。
/// 所有来源共用同一套判定，避免各扫描函数各自维护一份不一致的字符串黑名单。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateTier {
    Normal,
    Advanced,
    Invalid,
}

impl CandidateTier {
    fn as_str(self) -> &'static str {
        match self {
            CandidateTier::Normal => "normal",
            CandidateTier::Advanced => "advanced",
            CandidateTier::Invalid => "invalid",
        }
    }
}

fn exe_stem(exe_lower: &str) -> String {
    Path::new(exe_lower)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 卸载/安装例程：只有精确的文件名形态才判无效，避免把
/// `uninstall-tool.exe`（合法卸载管理器）或路径含 setup 的开发工具误杀。
fn is_uninstaller_stem(stem: &str) -> bool {
    if matches!(stem, "uninstall" | "uninstaller" | "uninst") {
        return true;
    }
    // unins000.exe / unins001.exe 等 Inno Setup 卸载器
    stem.strip_prefix("unins")
        .map(|rest| rest.is_empty() || rest.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

fn is_installer_stem(stem: &str) -> bool {
    if matches!(
        stem,
        "setup"
            | "installer"
            | "install"
            | "installshield"
            | "dpinst"
            | "dpinst64"
            | "driverinstall"
    ) {
        return true;
    }
    // setup64.exe / setup_x64.exe 等安装包，不把 setup-tool 之类的合法工具算进来
    stem.strip_prefix("setup")
        .map(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '_' || c == '-' || c == 'x')
        })
        .unwrap_or(false)
}

/// 高级项：可启动但对日常使用没有意义的组件（更新器 / 崩溃报告 / 后台服务 / 维护工具）。
/// 只按「文件名独立语义 + 显示名完整短语」匹配，不做任意子串删除，
/// 因此开发工具、终端、软件管理器里的 update/service/setup 不会被误折叠。
fn is_advanced_candidate(display_name: &str, stem: &str) -> bool {
    let name = display_name.trim().to_ascii_lowercase();
    const NAME_MARKERS: &[&str] = &[
        "update service",
        "crash reporter",
        "crashpad",
        "background service",
        "maintenance tool",
        "uninstall helper",
    ];
    if NAME_MARKERS.iter().any(|m| name.contains(m)) {
        return true;
    }
    // 完整词尾：避免把 `CodeUpdater 调试工具` 这类名字里的子串当成更新器
    if name == "updater" || name.ends_with(" updater") {
        return true;
    }
    // 名称明确是卸载入口（快捷方式可能指向主程序+卸载参数），默认折叠但仍可展开
    if name.starts_with("uninstall") || display_name.starts_with("卸载") {
        return true;
    }
    // 中文短语（完整词，不做单字匹配）
    const CN_MARKERS: &[&str] = &[
        "更新服务",
        "更新程序",
        "后台服务",
        "崩溃报告",
        "维护工具",
        "卸载辅助",
        "驱动安装",
    ];
    if CN_MARKERS.iter().any(|m| display_name.contains(m)) {
        return true;
    }
    // 文件名级：只认独立后缀/精确名，`service-hub`、`update-checker` 之类开发工具不受影响。
    const STEM_SUFFIXES: &[&str] = &[
        "updater",
        "crashpad_handler",
        "crashreporter",
        "dismhost",
        "maintenancetool",
    ];
    if STEM_SUFFIXES.iter().any(|m| {
        stem == *m || stem.ends_with(&format!("_{}", m)) || stem.ends_with(&format!("-{}", m))
    }) {
        return true;
    }
    stem == "service" || stem.ends_with("_service") || stem.ends_with("-service")
}

/// 统一候选判定：各来源只负责收集，不再各自写一套卸载/更新过滤。
fn candidate_tier(display_name: &str, exe_lower: &str) -> CandidateTier {
    let stem = exe_stem(exe_lower);
    if is_uninstaller_stem(&stem) || is_installer_stem(&stem) {
        return CandidateTier::Invalid;
    }
    if is_advanced_candidate(display_name, &stem) {
        return CandidateTier::Advanced;
    }
    CandidateTier::Normal
}

/// Uninstall 注册表的 DisplayIcon 常写成 `"C:\App\app.exe",0`，也可能只是图标资源
///（.ico/.dll）。只有 .exe 才能当作可启动应用，其余一律不猜。
fn exe_from_display_icon(icon: &str) -> Option<String> {
    let raw = icon.split(',').next()?.trim().trim_matches('"').trim();
    if raw.is_empty() || !raw.to_ascii_lowercase().ends_with(".exe") {
        return None;
    }
    Some(raw.to_string())
}

/// App Paths：软件自己注册的启动入口（HKCU / HKLM 64 位与 32 位视图）。
/// 这是可靠系统来源，不猜测安装目录；与开始菜单/注册表按 app_key 去重。
#[cfg(windows)]
fn scan_app_paths<F>(c: &mut ScanCollector<'_, F>, diags: &mut HashMap<String, u32>)
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ),
        (
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ),
    ];
    for (root, sub) in roots {
        if c.cancelled() {
            return;
        }
        let key = match RegKey::predef(root).open_subkey(sub) {
            Ok(key) => key,
            Err(e) => {
                // 可选来源正常不存在（如系统从未登记 App Paths）不算发现不完整；
                // 权限拒绝/I/O 错误才是真实失败，不能伪装成「本机没有软件」。
                note_source_read_error(diags, "app_paths_unreadable", &e);
                continue;
            }
        };
        for name in key.enum_keys() {
            if c.cancelled() {
                return;
            }
            let name = match name {
                Ok(name) => name,
                Err(e) => {
                    // 枚举中途失败会漏掉所有后续子键，必须计入诊断。
                    note_source_read_error(diags, "app_paths_unreadable", &e);
                    continue;
                }
            };
            let sk = match key.open_subkey(&name) {
                Ok(sk) => sk,
                Err(e) => {
                    // 枚举与打开之间子键被卸载（NotFound）属正常竞态，不是读取失败。
                    note_source_read_error(diags, "app_paths_unreadable", &e);
                    continue;
                }
            };
            let exe: String = match sk.get_value("") {
                Ok(exe) => exe,
                Err(e) => {
                    // 默认值缺失 = 该项没有可启动路径，正常跳过；
                    // 权限/类型/IO 错误不能靠 unwrap_or_default 静默吞掉。
                    note_source_read_error(diags, "app_paths_unreadable", &e);
                    continue;
                }
            };
            let exe = exe.trim().trim_matches('"').to_string();
            // 含环境变量或空值无法可靠定位（不做猜测展开）
            if exe.is_empty() || exe.contains('%') || validate_exe_path(&exe).is_err() {
                continue;
            }
            let lower = exe.to_ascii_lowercase();
            let display_name = name
                .strip_suffix(".exe")
                .or_else(|| name.strip_suffix(".EXE"))
                .unwrap_or(&name)
                .trim()
                .to_string();
            if display_name.is_empty() {
                continue;
            }
            let tier = candidate_tier(&display_name, &lower);
            if tier == CandidateTier::Invalid {
                continue;
            }
            c.push(DiscoveredApp {
                app_key: lower.clone(),
                display_name,
                category: category_for_exe(&lower).to_string(),
                window_title_hint: title_hint_for_exe(&lower).to_string(),
                exe_path: exe,
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                source: "app_paths".into(),
                tier: tier.as_str().to_string(),
            });
        }
    }
}

/// 卸载注册表（HKLM 64/32 + HKCU）。
#[cfg(windows)]
fn scan_registry<F>(c: &mut ScanCollector<'_, F>, diags: &mut HashMap<String, u32>)
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
    ];
    for (root, sub) in roots {
        if c.cancelled() {
            return;
        }
        let key = match RegKey::predef(root).open_subkey(sub) {
            Ok(key) => key,
            Err(e) => {
                // 根路径不存在是正常缺失（例如 HKCU 下从未写过 Uninstall 项）；
                // 权限拒绝/I/O 错误必须保留为诊断。
                note_source_read_error(diags, "registry_unreadable", &e);
                continue;
            }
        };
        // enum_keys 只给子键名；逐个打开读取（winreg 0.55 语义）
        for name in key.enum_keys() {
            if c.cancelled() {
                return;
            }
            let name = match name {
                Ok(name) => name,
                Err(e) => {
                    // 枚举失败会中断后续子键的读取，不能静默丢弃。
                    note_source_read_error(diags, "registry_unreadable", &e);
                    continue;
                }
            };
            let sk = match key.open_subkey(&name) {
                Ok(sk) => sk,
                Err(e) => {
                    // 子键在枚举与打开之间被卸载（NotFound）属正常竞态。
                    note_source_read_error(diags, "registry_unreadable", &e);
                    continue;
                }
            };
            let display: String = sk.get_value("DisplayName").unwrap_or_default();
            if display.trim().is_empty() {
                continue;
            }
            // 系统组件 / 纯 MSI 登记项不作为可启动应用
            let sys_comp: u32 = sk.get_value("SystemComponent").unwrap_or(0);
            if sys_comp == 1 {
                continue;
            }
            // 更新补丁 / 父级条目不是独立应用
            let parent: String = sk.get_value("ParentKeyName").unwrap_or_default();
            if !parent.trim().is_empty() {
                continue;
            }
            let release: String = sk.get_value("ReleaseType").unwrap_or_default();
            let rel = release.to_ascii_lowercase();
            if rel.contains("update") || rel.contains("hotfix") || rel.contains("patch") {
                continue;
            }
            let icon: String = sk.get_value("DisplayIcon").unwrap_or_default();
            // DisplayIcon 常见写法：`"C:\App\app.exe",0`；也可能是 .ico/.dll，
            // 只有 exe 才能作为启动目标（图标文件不是可执行程序）。
            let Some(exe) = exe_from_display_icon(&icon) else {
                continue;
            };
            if validate_exe_path(&exe).is_err() {
                continue;
            }
            let lower = exe.to_ascii_lowercase();
            // 卸载程序不是可启动应用；更新/崩溃报告等归为高级项（默认折叠、可展开）。
            let tier = candidate_tier(display.trim(), &lower);
            if tier == CandidateTier::Invalid {
                continue;
            }
            c.push(DiscoveredApp {
                app_key: lower.clone(),
                display_name: display.trim().to_string(),
                category: category_for_exe(&lower).to_string(),
                window_title_hint: title_hint_for_exe(&lower).to_string(),
                exe_path: exe,
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                source: "registry".into(),
                tier: tier.as_str().to_string(),
            });
        }
    }
}

/// UWP / MSIX：Get-StartApps 中带「!」的应用身份（单次 PowerShell 调用，限时 8s）。
#[cfg(windows)]
fn scan_uwp<F>(c: &mut ScanCollector<'_, F>, diags: &mut HashMap<String, u32>)
where
    F: FnMut(&[DiscoveredApp], &str, usize, bool),
{
    // 输出统一 UTF-8：默认控制台编码会把中文应用名变成乱码（搜索与展示都会失效）
    let out = run_powershell_with_timeout(
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ConvertTo-Csv -NoTypeInformation",
        ],
        Duration::from_secs(8),
        c.cancel_token(),
    );
    let out = match out {
        PsOutcome::Output(out) => out,
        // 超时 / 启动失败 / 取消是三种不同结果：前两种计入诊断，
        // 取消由整体 cancelled 标志表达，不额外当成来源故障。
        PsOutcome::Timeout => {
            diags.insert("uwp_scan_timeout".into(), 1);
            return;
        }
        PsOutcome::Failed => {
            diags.insert("uwp_scan_failed".into(), 1);
            return;
        }
        PsOutcome::Cancelled => return,
    };
    let mut apps = Vec::new();
    let mut truncated = false;
    for line in out.lines().skip(1) {
        if c.cancelled() {
            return;
        }
        let line = line.trim();
        if line.is_empty() || line == "\"Name\",\"AppID\"" {
            continue;
        }
        // CSV："名称","AUMID"
        let parts: Vec<&str> = line.split("\",\"").collect();
        if parts.len() != 2 {
            continue;
        }
        let name = parts[0].trim_start_matches('"').to_string();
        let aumid = parts[1].trim_end_matches('"').to_string();
        if name.is_empty() || super::validate_aumid(&aumid).is_err() {
            continue;
        }
        if apps.len() >= 200 {
            // 继续遍历只为准确判定「是否真的还有更多条目」，不产生假截断诊断。
            truncated = true;
            continue;
        }
        apps.push(DiscoveredApp {
            app_key: aumid.clone(),
            display_name: name,
            category: "uwp".into(),
            exe_path: String::new(),
            launch_args: String::new(),
            working_dir: String::new(),
            app_user_model_id: aumid,
            window_title_hint: String::new(),
            source: "uwp".into(),
            tier: CandidateTier::Normal.as_str().to_string(),
        });
    }
    if truncated {
        diags.insert("uwp_truncated".into(), 1);
    }
    for app in apps {
        c.push(app);
    }
}

/// PowerShell 调用结果：超时、启动/退出失败、被取消必须区分开，
/// 否则「扫描超时」会被误报成「本机没有商店应用」。
#[cfg(windows)]
enum PsOutcome {
    Output(String),
    Timeout,
    Cancelled,
    Failed,
}

/// 带超时与取消的子进程执行（防止 PowerShell 挂起阻塞扫描，也允许扫描中途取消）。
#[cfg(windows)]
fn run_powershell_with_timeout(
    args: &[&str],
    timeout: Duration,
    cancel: Option<&ScanCancel>,
) -> PsOutcome {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = match crate::winproc::hidden("powershell.exe")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return PsOutcome::Failed,
    };
    // 必须并发消费 stdout：等进程退出后才读管道，大输出会把管道写满并死锁，
    // 直到超时才被杀死。这里先起读线程，再轮询退出状态。
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return PsOutcome::Failed;
    };
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let mut s = stdout;
        let _ = s.read_to_string(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let outcome = loop {
        // 取消检查放在轮询循环里：扫描取消后立即结束子进程，而不是等它自然退出。
        if cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
            let _ = child.kill();
            let _ = child.wait();
            break PsOutcome::Cancelled;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    PsOutcome::Output(String::new())
                } else {
                    PsOutcome::Failed
                };
            }
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break PsOutcome::Timeout;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break PsOutcome::Failed;
            }
        }
    };
    let buf = reader.join().unwrap_or_default();
    // 超时/取消/非零退出都视为「本次扫描不可用」，不得把半截或错误输出当结果。
    match outcome {
        PsOutcome::Output(_) => PsOutcome::Output(buf),
        other => other,
    }
}

// ── 运行状态判定 ────────────────────────────────────────────

/// 计算一批 app_key 的运行状态：有窗口 > 仅进程 > 未运行。
/// app_key 为 exe 路径（小写）或 AUMID（AUMID 只能判窗口标题）。
pub fn running_states(app_keys: &[String]) -> HashMap<String, RunningState> {
    let mut out: HashMap<String, RunningState> = HashMap::new();
    // 窗口身份判定：exe 直接命中或窗口 PID 祖先链命中（多进程宿主的子进程窗口），
    // 与 close/kill 的 windows_for_identity 同一套口径——否则酷狗类应用窗口明明
    // 开着，检测却报未运行，徽标与「关闭窗口」入口一起丢失。
    let has_window = super::window_manager::identity_has_window(app_keys);
    // 进程快照（含后台/托盘进程）
    let procs = crate::agents::managed::process_snapshot_names();
    let mut proc_stems: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &procs {
        proc_stems.insert(name.to_ascii_lowercase());
    }
    for key in app_keys {
        let state = if has_window.get(key).copied().unwrap_or(false) {
            RunningState::HasWindow
        } else if key.contains('!') {
            // UWP：无 exe 身份，窗口匹配按标题提示；这里无提示则按未运行处理（不猜）
            RunningState::NotRunning
        } else if let Some(stem) = Path::new(key).file_stem() {
            let stem = stem.to_string_lossy().to_string();
            if proc_stems.contains(&stem) {
                RunningState::ProcessOnly
            } else {
                RunningState::NotRunning
            }
        } else {
            RunningState::NotRunning
        };
        out.insert(key.clone(), state);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机取消时序：开始菜单首个分块到达后取消——
    /// 该来源不得被标记完成，后续来源（注册表/UWP）不得启动，结果必须是 cancelled。
    #[cfg(windows)]
    #[test]
    #[ignore = "真机扫描（取消时序，访问开始菜单）"]
    fn cancelling_inside_source_keeps_source_incomplete() {
        let cancel = ScanCancel::default();
        let mut done_sources: Vec<String> = Vec::new();
        let mut saw_startmenu_chunk = false;
        let result = scan_installed_apps_streaming(true, Some(&cancel), |apps, source, _d, done| {
            if source == "startmenu" && !apps.is_empty() && !saw_startmenu_chunk {
                saw_startmenu_chunk = true;
                cancel.cancel();
            }
            if done {
                done_sources.push(source.to_string());
            }
        });
        if !saw_startmenu_chunk {
            eprintln!("skip: 本机开始菜单首个分块无应用，无法复现中途取消");
            return;
        }
        assert!(result.cancelled, "中途取消必须标记 cancelled");
        assert!(
            !done_sources.iter().any(|s| s == "startmenu"),
            "取消中的来源不得推进 sources_done：{:?}",
            done_sources
        );
        assert!(
            !result.counts.contains_key("known")
                && !result.counts.contains_key("registry")
                && !result.counts.contains_key("uwp"),
            "取消后不得启动后续来源：{:?}",
            result.counts
        );
        assert!(!result.apps.is_empty(), "取消前已发现的应用不得丢失");
    }

    /// 真机取消时序：一个来源完整结束后取消——
    /// 已完成的来源仍计一次，后续来源不得启动，结果 cancelled。
    #[cfg(windows)]
    #[test]
    #[ignore = "真机扫描（来源间取消时序）"]
    fn cancelling_between_sources_keeps_completed_source_count() {
        let cancel = ScanCancel::default();
        let mut done_sources: Vec<String> = Vec::new();
        let result = scan_installed_apps_streaming(true, Some(&cancel), |_apps, source, _d, done| {
            if done {
                done_sources.push(source.to_string());
                if source == "startmenu" {
                    cancel.cancel();
                }
            }
        });
        assert!(result.cancelled, "来源间取消必须标记 cancelled");
        assert_eq!(
            done_sources,
            vec!["startmenu".to_string()],
            "已完成来源保留完成事件，后续来源不得出现"
        );
        assert!(result.counts.contains_key("startmenu"));
        assert!(!result.counts.contains_key("registry"));
    }

    /// 真机验证渐进扫描：来源批次按顺序到达、批间 app_key 不重复、累计数单调且等于最终结果；
    /// 同一来源内的中间批次不得推进 sources_done。
    #[cfg(windows)]
    #[test]
    #[ignore = "真机扫描（访问开始菜单/注册表/应用商店，耗时数秒）"]
    fn streaming_scan_emits_source_batches_and_final_result() {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = HashSet::new();
        let mut batches = 0usize;
        let mut last_discovered = 0usize;
        let mut monotonic = true;
        let mut no_cross_batch_dupes = true;
        let mut last_done_source = String::new();
        let mut sources_done = 0usize;
        let started = std::time::Instant::now();
        let result =
            scan_installed_apps_streaming(true, None, |apps, source, discovered, source_done| {
                batches += 1;
                println!(
                    "batch {} source={} new={} discovered={} done={} at {:?}",
                    batches,
                    source,
                    apps.len(),
                    discovered,
                    source_done,
                    started.elapsed()
                );
                for a in apps {
                    if !seen.insert(a.app_key.clone()) {
                        no_cross_batch_dupes = false;
                    }
                }
                if discovered < last_discovered {
                    monotonic = false;
                }
                last_discovered = discovered;
                if source_done {
                    assert_ne!(
                        last_done_source, source,
                        "同一来源不能重复推送完成事件"
                    );
                    last_done_source = source.to_string();
                    sources_done += 1;
                }
            });
        assert!(batches > 0, "至少应有来源批次");
        assert!(no_cross_batch_dupes, "同一 app_key 不得跨批重复推送");
        assert!(monotonic, "累计发现数必须单调不减");
        assert_eq!(
            result.apps.len(),
            last_discovered,
            "最终结果与累计数应一致"
        );
        assert_eq!(
            sources_done, SCAN_SOURCES_TOTAL,
            "完整扫描应完成全部来源"
        );
        assert!(!result.cancelled, "未取消的扫描不得标记取消");
    }

    /// 测试用候选构造器。
    fn test_app(key: &str, name: &str, tier: &str) -> DiscoveredApp {
        DiscoveredApp {
            app_key: key.into(),
            display_name: name.into(),
            category: "other".into(),
            exe_path: key.into(),
            launch_args: String::new(),
            working_dir: String::new(),
            app_user_model_id: String::new(),
            window_title_hint: String::new(),
            source: "startmenu".into(),
            tier: tier.into(),
        }
    }

    /// 分块：来源内超过上限时按 60 条一片推送，最后一片才标记来源完成。
    #[test]
    fn collector_chunks_large_sources_and_marks_only_last_chunk_done() {
        let mut emitted: Vec<(usize, bool, usize)> = Vec::new();
        {
            let mut on_batch =
                |apps: &[DiscoveredApp], _source: &str, discovered: usize, done: bool| {
                    emitted.push((apps.len(), done, discovered));
                };
            let mut c = ScanCollector::new(&mut on_batch, None);
            c.begin_source("startmenu");
            for i in 0..130 {
                c.push(test_app(&format!("k{}", i), &format!("App {}", i), "normal"));
            }
            assert_eq!(c.end_source(true), 130);
        }
        let sizes: Vec<usize> = emitted.iter().map(|(n, _, _)| *n).collect();
        assert_eq!(sizes, vec![60, 60, 10], "大批次必须按上限切片");
        assert_eq!(
            emitted.iter().filter(|(_, done, _)| *done).count(),
            1,
            "只有最后一片标记来源完成"
        );
        assert!(emitted.last().unwrap().1, "最后一片必须是完成片");
        assert_eq!(emitted.last().unwrap().2, 130, "累计发现数等于总数");
    }

    /// 空来源也要推送一次完成事件，否则前端进度停在 x/y 不动。
    #[test]
    fn collector_emits_completion_for_empty_source() {
        let mut calls: Vec<(usize, bool)> = Vec::new();
        {
            let mut on_batch = |apps: &[DiscoveredApp], _s: &str, _d: usize, done: bool| {
                calls.push((apps.len(), done));
            };
            let mut c = ScanCollector::new(&mut on_batch, None);
            c.begin_source("known");
            assert_eq!(c.end_source(true), 0);
        }
        assert_eq!(calls, vec![(0, true)]);
    }

    /// 取消中的来源：已发现的真实条目照常分批推送，但**任何一片都不得标记完成**。
    #[test]
    fn cancelled_source_publishes_discovered_apps_without_completion() {
        let cancel = ScanCancel::default();
        let mut emitted: Vec<(usize, usize, bool)> = Vec::new();
        {
            let mut on_batch = |apps: &[DiscoveredApp], _s: &str, discovered: usize, done: bool| {
                emitted.push((apps.len(), discovered, done));
            };
            let mut c = ScanCollector::new(&mut on_batch, Some(&cancel));
            c.begin_source("startmenu");
            for i in 0..65 {
                c.push(test_app(&format!("k{}", i), &format!("App {}", i), "normal"));
            }
            cancel.cancel();
            assert_eq!(c.end_source(!c.cancelled()), 65);
            assert_eq!(c.apps.len(), 65, "取消不得丢失已发现的应用");
        }
        assert_eq!(
            emitted,
            vec![(60, 60, false), (5, 65, false)],
            "取消来源只推送数据，不发送完成片；剩余 5 条必须补发"
        );
        assert!(
            emitted.iter().all(|(_, _, done)| !done),
            "取消来源不得推进 sources_done"
        );
    }

    /// 恰好整批（60 条）后取消：不产生任何空完成片。
    #[test]
    fn cancelled_source_at_exact_chunk_boundary_emits_no_completion() {
        let cancel = ScanCancel::default();
        let mut emitted: Vec<(usize, bool)> = Vec::new();
        {
            let mut on_batch = |apps: &[DiscoveredApp], _s: &str, _d: usize, done: bool| {
                emitted.push((apps.len(), done));
            };
            let mut c = ScanCollector::new(&mut on_batch, Some(&cancel));
            c.begin_source("known");
            for i in 0..60 {
                c.push(test_app(&format!("b{}", i), &format!("B {}", i), "normal"));
            }
            cancel.cancel();
            assert_eq!(c.end_source(!c.cancelled()), 60);
        }
        assert_eq!(
            emitted,
            vec![(60, false)],
            "边界取消不得补发空完成片，也不得把已满的一批标成完成"
        );
    }

    /// 取消后没有任何新增：不推送任何批次（避免无意义的空事件）。
    #[test]
    fn cancelled_source_without_apps_emits_nothing() {
        let cancel = ScanCancel::default();
        cancel.cancel();
        let mut batches = 0usize;
        {
            let mut on_batch = |_: &[DiscoveredApp], _: &str, _: usize, _: bool| batches += 1;
            let mut c = ScanCollector::new(&mut on_batch, Some(&cancel));
            c.begin_source("app_paths");
            assert_eq!(c.end_source(!c.cancelled()), 0);
        }
        assert_eq!(batches, 0, "取消的空来源不得发送完成片");
    }

    /// 正常完成且恰好整批：补发一个空完成片推进进度，且只补一次。
    #[test]
    fn completed_source_at_exact_chunk_boundary_emits_one_completion() {
        let mut emitted: Vec<(usize, bool)> = Vec::new();
        {
            let mut on_batch = |apps: &[DiscoveredApp], _s: &str, _d: usize, done: bool| {
                emitted.push((apps.len(), done));
            };
            let mut c = ScanCollector::new(&mut on_batch, None);
            c.begin_source("registry");
            for i in 0..120 {
                c.push(test_app(&format!("r{}", i), &format!("R {}", i), "normal"));
            }
            assert_eq!(c.end_source(true), 120);
        }
        assert_eq!(
            emitted,
            vec![(60, false), (60, false), (0, true)],
            "正好整批完成时只需一个空完成片"
        );
    }

    /// 取消令牌：在途请求可取消、Drop 注销；取消先到扫描后到时注册即生效；
    /// 待取消意图只消费一次，不会污染同 id 的后续注册（实际 id 每次唯一）。
    #[test]
    fn cancel_token_lifecycle_and_pre_cancel() {
        let guard = ScanGuard::register("scan-cancel-test").expect("合法 scan_id 应注册");
        assert!(request_cancel("scan-cancel-test"), "在途请求应可取消");
        assert!(guard.token().is_cancelled());
        drop(guard);

        assert!(
            request_cancel("scan-early-cancel"),
            "扫描尚未注册时取消也必须被记录"
        );
        let guard = ScanGuard::register("scan-early-cancel").expect("合法 scan_id 应注册");
        assert!(
            guard.token().is_cancelled(),
            "先到的取消必须在注册时立即生效"
        );
        drop(guard);
        let late = ScanGuard::register("scan-early-cancel").expect("合法 scan_id 应注册");
        assert!(
            !late.token().is_cancelled(),
            "待取消意图只能消费一次"
        );

        assert!(!request_cancel("  "), "空 scan_id 不接受取消");
        assert!(ScanGuard::register("   ").is_none(), "空 scan_id 不注册");
    }

    #[test]
    fn pre_cancelled_scan_reports_cancelled_without_batches() {
        let cancel = ScanCancel::default();
        cancel.cancel();
        let mut batches = 0usize;
        let result = scan_installed_apps_streaming(true, Some(&cancel), |_, _, _, _| batches += 1);
        assert!(result.cancelled);
        assert_eq!(batches, 0, "已取消的扫描不得推送批次");
        assert_eq!(result.diagnostics.get("scan_cancelled"), Some(&1));
        assert!(result.apps.is_empty());
    }

    /// 同 exe 去重时普通项必须顶替先到的高级项（例如「卸载 Foo」先被遍历到）。
    #[test]
    fn normal_tier_replaces_earlier_advanced_entry() {
        let mut apps = Vec::new();
        push_unique(&mut apps, test_app("c:\\app\\foo.exe", "卸载 Foo", "advanced"));
        push_unique(&mut apps, test_app("c:\\app\\foo.exe", "Foo", "normal"));
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].tier, "normal");
        assert_eq!(apps[0].display_name, "Foo");
        // 反向顺序：普通项先到，后续高级项不得覆盖。
        let mut apps = Vec::new();
        push_unique(&mut apps, test_app("c:\\app\\bar.exe", "Bar", "normal"));
        push_unique(&mut apps, test_app("c:\\app\\bar.exe", "卸载 Bar", "advanced"));
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].display_name, "Bar");
    }

    /// 同名不同程序必须保持两条（不按显示名合并）。
    #[test]
    fn same_display_name_different_exe_stays_separate() {
        let mut apps = Vec::new();
        push_unique(&mut apps, test_app("c:\\a\\wechat.exe", "微信", "normal"));
        push_unique(&mut apps, test_app("c:\\b\\wechat.exe", "微信", "normal"));
        push_unique(&mut apps, test_app("c:\\c\\devtools.exe", "微信开发者工具", "normal"));
        assert_eq!(apps.len(), 3);
    }

    #[test]
    fn categories_match_common_apps() {
        assert_eq!(category_for_exe("c:\\chrome\\chrome.exe"), "browser");
        assert_eq!(category_for_exe("c:\\edge\\msedge.exe"), "browser");
        assert_eq!(category_for_exe("c:\\tencent\\wechat\\wechat.exe"), "im");
        assert_eq!(category_for_exe("c:\\kugou\\kugou.exe"), "music");
        assert_eq!(category_for_exe("c:\\cloud music\\cloudmusic.exe"), "music");
        assert_eq!(category_for_exe("c:\\ide\\code.exe"), "dev");
        assert_eq!(category_for_exe("c:\\something\\weird.exe"), "other");
    }

    #[test]
    fn title_hints_for_cn_apps() {
        assert_eq!(
            title_hint_for_exe("c:\\tencent\\wechat\\wechat.exe"),
            "微信"
        );
        assert_eq!(title_hint_for_exe("c:\\kugou\\kugou.exe"), "酷狗");
        assert_eq!(title_hint_for_exe("c:\\app\\unknown.exe"), "");
    }

    #[test]
    fn push_unique_dedupes_by_app_key() {
        let mut apps = Vec::new();
        push_unique(
            &mut apps,
            DiscoveredApp {
                app_key: "a".into(),
                display_name: "A".into(),
                category: "other".into(),
                exe_path: String::new(),
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                window_title_hint: String::new(),
                source: "startmenu".into(),
                tier: "normal".into(),
            },
        );
        push_unique(
            &mut apps,
            DiscoveredApp {
                app_key: "a".into(),
                display_name: "A dup".into(),
                category: "other".into(),
                exe_path: String::new(),
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                window_title_hint: String::new(),
                source: "registry".into(),
                tier: "normal".into(),
            },
        );
        push_unique(
            &mut apps,
            DiscoveredApp {
                app_key: String::new(),
                display_name: "empty key".into(),
                category: "other".into(),
                exe_path: String::new(),
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: String::new(),
                window_title_hint: String::new(),
                source: "startmenu".into(),
                tier: "normal".into(),
            },
        );
        assert_eq!(apps.len(), 1, "同 key 与空 key 不得重复入库");
        assert_eq!(
            apps[0].display_name, "A",
            "先到者保留（来源优先级由调用顺序决定）"
        );
    }

    #[cfg(windows)]
    #[test]
    fn scan_returns_only_valid_targets() {
        let r = scan_installed_apps(true);
        for a in &r.apps {
            if a.source == "uwp" {
                assert!(!a.app_user_model_id.is_empty());
                assert!(super::super::validate_aumid(&a.app_user_model_id).is_ok());
            } else {
                assert!(
                    !a.exe_path.is_empty(),
                    "非 UWP 发现项必须有 exe：{:?}",
                    a.display_name
                );
                assert!(
                    super::super::validate_exe_path(&a.exe_path).is_ok(),
                    "发现项必须通过安全校验：{} -> {}",
                    a.display_name,
                    a.exe_path
                );
            }
            assert!(!a.display_name.trim().is_empty());
            assert!(
                a.tier == "normal" || a.tier == "advanced",
                "扫描候选只能是普通项或高级项：{} -> {}",
                a.display_name,
                a.tier
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn running_states_distinguish_levels() {
        // 本测试进程自身：exe 在运行（进程存在），但无顶层窗口
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();
        let map = running_states(&[exe]);
        let s = map.values().next().unwrap();
        assert!(
            *s == RunningState::ProcessOnly || *s == RunningState::NotRunning,
            "测试进程无 GUI 窗口，不得报 HasWindow"
        );
    }

    #[test]
    fn display_icon_only_accepts_exe_without_arguments() {
        // 带引号 + 图标索引：取 exe 本身
        assert_eq!(
            exe_from_display_icon("\"C:\\Program Files\\App\\app.exe\",0"),
            Some("C:\\Program Files\\App\\app.exe".to_string())
        );
        assert_eq!(
            exe_from_display_icon("C:\\App\\app.exe,-1"),
            Some("C:\\App\\app.exe".to_string())
        );
        // 图标资源 / DLL / 空值不能当启动目标
        assert_eq!(exe_from_display_icon("C:\\App\\icon.ico"), None);
        assert_eq!(exe_from_display_icon("C:\\App\\res.dll,2"), None);
        assert_eq!(exe_from_display_icon("   "), None);
    }

    #[test]
    fn uninstallers_and_setup_helpers_are_invalid() {
        // 无效：卸载/安装例程本身不是可交互应用，不进候选
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\unins000.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\uninstall.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\setup.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\setup64.exe"),
            CandidateTier::Invalid
        );
        assert_eq!(
            candidate_tier("Foo", "c:\\app\\installer.exe"),
            CandidateTier::Invalid
        );
        // 正常应用不能被误杀（开发工具、通讯、便携程序）
        assert_eq!(
            candidate_tier(
                "Visual Studio Code",
                "c:\\program files\\microsoft vs code\\code.exe"
            ),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("企业微信", "c:\\tencent\\wxwork\\wxwork.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("便携工具", "d:\\portable\\tool.exe"),
            CandidateTier::Normal
        );
    }

    #[test]
    fn updater_and_service_components_are_advanced_not_deleted() {
        // 高级项：可展开查看，不能被当作无效直接删除
        assert_eq!(
            candidate_tier("Google Update", "c:\\app\\updater.exe"),
            CandidateTier::Advanced
        );
        assert_eq!(
            candidate_tier("Acme 更新服务", "c:\\app\\acme_service.exe"),
            CandidateTier::Advanced
        );
        assert_eq!(
            candidate_tier("Crash Reporter", "c:\\app\\crashpad_handler.exe"),
            CandidateTier::Advanced
        );
        assert_eq!(
            candidate_tier("Background Service", "c:\\app\\agent.exe"),
            CandidateTier::Advanced
        );
        // 卸载入口指向主程序时（名称而非安装器文件）默认折叠，仍可展开
        assert_eq!(
            candidate_tier("Uninstall Foo", "c:\\app\\foo.exe"),
            CandidateTier::Advanced
        );
        // 开发工具文件名含 update/service 但语义独立，不得误折叠
        assert_eq!(
            candidate_tier("CodeUpdater 调试工具", "c:\\dev\\update-checker.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("ServiceHub", "c:\\jetbrains\\servicehub.exe"),
            CandidateTier::Normal
        );
        assert_eq!(
            candidate_tier("Windows Terminal", "c:\\terminal\\windows-terminal.exe"),
            CandidateTier::Normal
        );
    }

    #[cfg(windows)]
    #[test]
    fn lnk_budget_truncation_is_accurate() {
        let dir = std::env::temp_dir().join(format!("task-dock-lnk-budget-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        for name in ["a.lnk", "b.lnk"] {
            std::fs::write(dir.join(name), b"broken").unwrap();
        }
        let mut diags = HashMap::new();
        let mut truncated = false;
        let mut budget = 2usize;
        {
            let mut on_batch = |_: &[DiscoveredApp], _: &str, _: usize, _: bool| {};
            let mut c = ScanCollector::new(&mut on_batch, None);
            walk_lnk_dir(&dir, 0, &mut budget, &mut c, &mut truncated, &mut diags);
        }
        assert!(!truncated, "预算恰好覆盖全部条目时不得报截断");
        assert_eq!(
            diags.get("startmenu_lnk_unreadable"),
            Some(&2),
            "无法解析的快捷方式必须计入诊断，不能当成「没有应用」"
        );
        let mut diags = HashMap::new();
        let mut truncated = false;
        let mut budget = 1usize;
        {
            let mut on_batch = |_: &[DiscoveredApp], _: &str, _: usize, _: bool| {};
            let mut c = ScanCollector::new(&mut on_batch, None);
            walk_lnk_dir(&dir, 0, &mut budget, &mut c, &mut truncated, &mut diags);
        }
        assert!(truncated, "仍有未处理条目时必须报截断");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 开始菜单目录不存在：属于可选来源正常缺失，不能误报「发现不完整」。
    #[cfg(windows)]
    #[test]
    fn missing_start_menu_dir_is_not_diagnosed() {
        let dir = std::env::temp_dir().join(format!(
            "task-dock-lnk-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut diags = HashMap::new();
        let mut truncated = false;
        let mut budget = 10usize;
        {
            let mut on_batch = |_: &[DiscoveredApp], _: &str, _: usize, _: bool| {};
            let mut c = ScanCollector::new(&mut on_batch, None);
            walk_lnk_dir(&dir, 0, &mut budget, &mut c, &mut truncated, &mut diags);
        }
        assert!(
            diags.is_empty(),
            "目录正常不存在是可选来源缺失，不得计入来源诊断: {diags:?}"
        );
        assert!(!truncated, "目录不存在不是预算截断");
    }

    /// 路径存在但无法按目录读取（这里是「文件占位」）：真实读取失败仍要进入诊断。
    #[cfg(windows)]
    #[test]
    fn unreadable_start_menu_path_is_diagnosed() {
        let file = std::env::temp_dir().join(format!(
            "task-dock-lnk-not-a-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&file, b"not a directory").unwrap();
        let mut diags = HashMap::new();
        let mut truncated = false;
        let mut budget = 10usize;
        {
            let mut on_batch = |_: &[DiscoveredApp], _: &str, _: usize, _: bool| {};
            let mut c = ScanCollector::new(&mut on_batch, None);
            walk_lnk_dir(&file, 0, &mut budget, &mut c, &mut truncated, &mut diags);
        }
        let _ = std::fs::remove_file(&file);
        assert_eq!(
            diags.get("startmenu_dir_unreadable"),
            Some(&1),
            "非 NotFound 的读取错误必须计入诊断，不能伪装成空目录"
        );
    }

    /// 来源错误分类：正常缺失不计诊断；权限拒绝 / I/O 错误必须计数。
    /// 使用真实 Win32 错误码构造错误，验证 `io::ErrorKind` 映射与诊断键。
    #[cfg(windows)]
    #[test]
    fn optional_source_errors_are_classified_by_cause() {
        let mut diags = HashMap::new();
        // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND：可选来源正常缺失。
        for code in [2, 3] {
            let missing = std::io::Error::from_raw_os_error(code);
            assert!(!note_source_read_error(&mut diags, "registry_unreadable", &missing));
        }
        assert!(diags.is_empty(), "正常缺失不得产生诊断: {diags:?}");

        // ERROR_ACCESS_DENIED：真实权限失败。
        let denied = std::io::Error::from_raw_os_error(5);
        assert!(note_source_read_error(&mut diags, "registry_unreadable", &denied));
        assert_eq!(diags.get("registry_unreadable"), Some(&1));

        // 枚举中途再次失败：同一诊断累加，不被覆盖。
        assert!(note_source_read_error(&mut diags, "registry_unreadable", &denied));
        assert_eq!(diags.get("registry_unreadable"), Some(&2));

        // 其他 I/O 错误：同样必须可见。
        let io_err = std::io::Error::from(std::io::ErrorKind::Other);
        assert!(note_source_read_error(&mut diags, "app_paths_unreadable", &io_err));
        assert_eq!(diags.get("app_paths_unreadable"), Some(&1));
    }

    /// 真实注册表读取：不存在的可选根路径必须被 winreg 映射为 NotFound。
    /// 只读取一个必然不存在的测试路径，不修改用户注册表。
    #[cfg(windows)]
    #[test]
    fn real_missing_registry_source_maps_to_not_found() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let sub = format!(
            "Software\\TaskDock-Acceptance-{}-not-installed\\Uninstall",
            std::process::id()
        );
        let err = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&sub).unwrap_err();
        assert!(
            is_optional_source_missing(&err),
            "不存在的可选注册表路径必须归类为正常缺失（实际: {err:?}）"
        );
    }

    /// 真机权限边界（只读）：非管理员会话读取 HKLM\SECURITY 应得到 ACCESS_DENIED，
    /// 该错误不得被归类为「可选来源正常缺失」。管理员会话下无法稳定复现，跳过并如实说明。
    #[cfg(windows)]
    #[test]
    #[ignore = "真机权限边界：需要非管理员会话"]
    fn real_access_denied_registry_is_not_optional_missing() {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        match RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SECURITY") {
            Ok(_) => eprintln!("当前会话可读取 HKLM\\SECURITY（管理员），未复现权限拒绝，跳过断言"),
            Err(e) => {
                assert!(
                    !is_optional_source_missing(&e),
                    "权限拒绝不得当作正常缺失: {e:?}"
                );
                let mut diags = HashMap::new();
                assert!(note_source_read_error(&mut diags, "registry_unreadable", &e));
                assert_eq!(diags.get("registry_unreadable"), Some(&1));
            }
        }
    }

    /// 真机扫描（只读）：APPDATA 指向不存在的开始菜单目录时，该可选来源属于正常缺失，
    /// 不得产生 `startmenu_dir_unreadable`；公共开始菜单仍按真实情况扫描。
    /// 必须单独运行（会临时改写进程环境变量，测试结束恢复）。
    #[cfg(windows)]
    #[test]
    #[ignore = "真机扫描：临时 APPDATA + 真实公共开始菜单（单独运行）"]
    fn real_missing_optional_start_menu_dir_is_not_diagnosed() {
        let saved = std::env::var_os("APPDATA");
        let fake = std::env::temp_dir().join(format!(
            "task-dock-missing-appdata-{}",
            std::process::id()
        ));
        std::env::set_var("APPDATA", &fake);
        let mut diags = HashMap::new();
        {
            let mut on_batch = |_: &[DiscoveredApp], _: &str, _: usize, _: bool| {};
            let mut c = ScanCollector::new(&mut on_batch, None);
            scan_start_menu(&mut c, &mut diags);
        }
        match saved {
            Some(v) => std::env::set_var("APPDATA", v),
            None => std::env::remove_var("APPDATA"),
        }
        assert!(
            diags.get("startmenu_dir_unreadable").is_none(),
            "可选开始菜单目录正常缺失不得计入诊断: {diags:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn invalid_shortcut_is_ignored_without_panic() {
        let dir = std::env::temp_dir().join(format!("task-dock-lnk-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("broken.lnk");
        std::fs::write(&path, b"not a real shortcut").unwrap();
        let parsed = parse_lnk(&path);
        assert!(
            parsed.is_err(),
            "非法快捷方式必须被忽略并标记为不可读，且不能 panic"
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// 真机可复现样本：微信的 .lnk 的 LinkInfo 指向已删除的旧路径，
    /// 真实目标在 LinkTargetIDList 中。未安装微信时跳过（不伪造结果）。
    #[cfg(windows)]
    #[test]
    fn stale_link_info_shortcut_resolves_to_existing_target() {
        let lnk =
            Path::new("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\微信\\微信.lnk");
        if !lnk.exists() {
            eprintln!("skip: 本机未安装微信（{} 不存在）", lnk.display());
            return;
        }
        let resolved = super::super::app_icons::resolve_shortcut(&lnk.to_string_lossy())
            .expect("Shell 应能解析 IDList 中的真实目标");
        assert!(
            super::super::validate_exe_path(&resolved.0).is_ok(),
            "解析出的目标必须是现有 exe：{}",
            resolved.0
        );
    }
}
