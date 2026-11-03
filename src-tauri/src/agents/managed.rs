//! 通用 Adapter 架构（第五阶段）：统一 `Agent → Instance → Session → Run → Event`。
//!
//! 每个 Adapter 负责：
//! - detect：发现安装与运行实例（第 1/2 层）
//! - capabilities / supported_events：声明并核实观测能力（第 3 层）
//! - preview：接入向导的配置预览（用户确认前可见全部改动）
//! - install：安装 Hooks / 插件（获得用户授权后）
//! - verify：真实链路验证（触发一次低风险测试事件并确认抵达数据库）
//! - uninstall：可逆卸载（只删自己的配置，第三方原样保留）
//! - health：连接健康状态（结合 DB 中的最近事件证据）

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use rusqlite::OptionalExtension;

use super::{hook_cli, hooks_install};

// ── 数据结构 ────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub exe: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DetectionReport {
    pub adapter: String,
    pub source_id: String,
    pub display_name: String,
    /// 第 1 层：安装识别
    pub installed: bool,
    pub version: Option<String>,
    pub install_paths: Vec<String>,
    pub config_homes: Vec<String>,
    pub install_method: String,
    /// 第 2 层：运行实例（运行 ≠ 执行任务）
    pub running_instances: Vec<ProcessInfo>,
    /// 第 3 层：接口能力
    pub capabilities: Vec<String>,
    pub supported_events: Vec<String>,
    /// 接入状态（第 4 层证据在 DB：verified / last_event_at）
    pub docs_url: String,
    pub limitations: Vec<String>,
}

pub trait ManagedAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    /// 事件来源 ID（默认与适配器 id 相同）。两者不一致时必须覆盖，
    /// 否则健康状态/证据查询会落到未注册来源，被误判为「未接入」。
    fn source_id(&self) -> &'static str {
        self.id()
    }
    fn display_name(&self) -> &'static str;
    /// hooks | plugin | discovery | manual
    fn transport_kind(&self) -> &'static str;
    fn docs_url(&self) -> &'static str;
    fn limitations(&self) -> Vec<String> {
        Vec::new()
    }

    fn detect(&self) -> DetectionReport;
    /// 向导第 2 步：展示将要写入的配置（不写盘）。app_data = 应用数据目录。
    fn preview(&self, app_data: &std::path::Path) -> AppResult<Value>;
    /// 向导第 4 步：安装（幂等；保留第三方配置）。
    fn install(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value>;
    /// 向导第 5 步：真实链路验证（测试事件必须真实抵达数据库）。
    fn verify(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value>;
    /// 可逆卸载；`db` 用于同步来源配置状态（安装元数据不得残留为「已配置」）。
    fn uninstall(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value>;
    /// 配置存在性检查（结构级，不代表事件可达）。
    fn config_status(&self, app_data: &std::path::Path) -> AppResult<Value>;
}

// ── 进程检测（第 2 层）──────────────────────────────────────

/// 进程快照（TTL 缓存：一次扫描内多个适配器共享一次 tasklist 枚举，约 1.3s → 只跑一次）。
fn process_snapshot() -> Vec<ProcessInfo> {
    use std::sync::{Mutex, OnceLock};
    static SNAP: OnceLock<Mutex<(std::time::Instant, Vec<ProcessInfo>)>> = OnceLock::new();
    let cell = SNAP.get_or_init(|| {
        Mutex::new((
            std::time::Instant::now() - std::time::Duration::from_secs(60),
            Vec::new(),
        ))
    });
    let mut guard = cell.lock().unwrap();
    if guard.0.elapsed() < std::time::Duration::from_secs(3) {
        return guard.1.clone();
    }
    let mut out = Vec::new();
    if let Some(output) = crate::winproc::run_with_timeout(
        "tasklist",
        ["/FO", "CSV", "/NH"],
        std::time::Duration::from_secs(5),
    ) {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let parts: Vec<&str> = line.split("\",\"").collect();
            if parts.is_empty() {
                continue;
            }
            let name = parts[0].trim_matches('"');
            let pid = parts
                .get(1)
                .and_then(|p| p.trim_matches('"').parse::<u32>().ok())
                .unwrap_or(0);
            out.push(ProcessInfo {
                pid,
                name: name.to_string(),
                exe: None,
            });
        }
    }
    *guard = (std::time::Instant::now(), out.clone());
    out
}

/// 按进程名（不区分大小写，不含 .exe 后缀）枚举运行实例。
pub fn find_processes(names: &[&str]) -> Vec<ProcessInfo> {
    process_snapshot()
        .iter()
        .filter(|p| {
            names
                .iter()
                .any(|n| p.name.to_ascii_lowercase() == format!("{}.exe", n.to_ascii_lowercase()))
        })
        .cloned()
        .collect()
}

/// 进程名快照（含 .exe 后缀，原样大小写）：导航系统判定「进程存在」用，
/// 复用 process_snapshot 的 TTL 缓存，不额外发起 tasklist。
pub fn process_snapshot_names() -> Vec<String> {
    process_snapshot().into_iter().map(|p| p.name).collect()
}

/// 运行 exe --version 并截取首行（超时 4s；第三方 CLI 卡死不得拖住扫描）。
pub fn probe_version(exe: &PathBuf, args: &[&str]) -> Option<String> {
    let out = crate::winproc::run_with_timeout(exe, args, std::time::Duration::from_secs(4))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.chars().take(80).collect())
    }
}

/// 在 PATH 与常见目录中查找可执行文件。
pub fn find_exe(names: &[&str]) -> Option<PathBuf> {
    for n in names {
        // where 命令（Windows），超时 5s
        if let Some(out) =
            crate::winproc::run_with_timeout("where", [n], std::time::Duration::from_secs(5))
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = text.lines().next() {
                let p = PathBuf::from(first.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// 在二进制文件中扫描 Hook 事件名（能力线索：只注册当前版本可能支持的事件）。
///
/// 分块流式扫描（4 MiB/块，块间保留最大模式长度-1 的重叠），
/// 不再把 200MB+ 二进制整体读进内存；命中全部候选后提前结束。
/// 注意：二进制里出现事件名只是「能力线索」，不代表官方支持或真实执行成功。
pub fn scan_events_in_binary(exe: &PathBuf, candidates: &[&str]) -> Vec<String> {
    use std::io::Read;

    const MAX_SCAN: u64 = 512 * 1024 * 1024;
    const CHUNK: usize = 4 * 1024 * 1024;
    let Ok(meta) = std::fs::metadata(exe) else {
        return Vec::new();
    };
    if meta.len() > MAX_SCAN {
        return Vec::new();
    }
    let regexes: Vec<(String, regex::bytes::Regex)> = candidates
        .iter()
        .filter_map(|c| {
            regex::bytes::RegexBuilder::new(&regex::escape(c))
                .case_insensitive(true)
                .build()
                .ok()
                .map(|re| (c.to_string(), re))
        })
        .collect();
    if regexes.is_empty() {
        return Vec::new();
    }
    let max_pattern = candidates.iter().map(|c| c.len()).max().unwrap_or(1);
    let Ok(mut file) = std::fs::File::open(exe) else {
        return Vec::new();
    };
    let mut findings: Vec<String> = Vec::new();
    let mut carry: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; CHUNK];
    while let Ok(n) = file.read(&mut chunk) {
        if n == 0 {
            break;
        }
        let mut window = Vec::with_capacity(carry.len() + n);
        window.extend_from_slice(&carry);
        window.extend_from_slice(&chunk[..n]);
        for (name, re) in &regexes {
            if !findings.iter().any(|f| f == name) && re.is_match(&window) {
                findings.push(name.clone());
            }
        }
        if findings.len() == regexes.len() {
            break;
        }
        let keep = max_pattern.saturating_sub(1).min(window.len());
        carry.clear();
        carry.extend_from_slice(&window[window.len() - keep..]);
    }
    findings
}

/// 带文件缓存的能力扫描：Agent 二进制动辄 200MB+，结果按 (路径, 大小, mtime) 缓存
/// 到应用数据目录，扫描一次后后续调用为纳秒级。
pub fn scan_events_cached(exe: &PathBuf, candidates: &[&str], cache_key: &str) -> Vec<String> {
    let Ok(meta) = std::fs::metadata(exe) else {
        return Vec::new();
    };
    use std::sync::{LazyLock, Mutex};
    static MEMO: LazyLock<Mutex<std::collections::HashMap<String, Vec<String>>>> =
        LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
    let stamp = format!("{}|{}|{}", exe.to_string_lossy(), meta.len(), {
        use std::time::SystemTime;
        meta.modified()
            .map(|m| {
                m.duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    });
    let cache_id = format!("{}@{}", cache_key, stamp);
    if let Ok(m) = MEMO.lock() {
        if let Some(v) = m.get(&cache_id) {
            return v.clone();
        }
    }
    // 文件缓存
    let cache_dir = std::env::var("APPDATA")
        .map(|a| {
            PathBuf::from(a)
                .join("com.taskdock.desktop")
                .join("adapter-cache")
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let cache_file = cache_dir.join(format!("{}.json", cache_key));
    // TTL：超过 7 天的缓存视为失效；二进制 mtime/大小变化由 stamp 立即失效。
    const CACHE_TTL_SECS: u64 = 7 * 24 * 60 * 60;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(raw) = std::fs::read_to_string(&cache_file) {
        if let Ok(cached) = serde_json::from_str::<serde_json::Value>(&raw) {
            let fresh = cached
                .get("fetched_at")
                .and_then(|v| v.as_u64())
                .map(|t| now_secs.saturating_sub(t) <= CACHE_TTL_SECS)
                .unwrap_or(false);
            if fresh && cached.get("stamp").and_then(|v| v.as_str()) == Some(stamp.as_str()) {
                let events: Vec<String> = cached
                    .get("events")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Ok(mut m) = MEMO.lock() {
                    m.insert(cache_id.clone(), events.clone());
                }
                return events;
            }
        }
    }
    let found = scan_events_in_binary(exe, candidates);
    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::write(
        &cache_file,
        serde_json::to_string(&json!({ "stamp": stamp, "events": found, "fetched_at": now_secs }))
            .unwrap_or_default(),
    );
    if let Ok(mut m) = MEMO.lock() {
        m.insert(cache_id, found.clone());
    }
    found
}

// ── Claude 兼容 Hooks 型 Adapter（codex / trae / workbuddy / qoder）────────

pub struct HooksAdapter {
    pub source_id: &'static str,
    pub display_name: &'static str,
    pub docs_url: &'static str,
    /// 目标 hooks 配置文件（可多个：如 Trae 国际版 + CN 版）
    pub hooks_files: fn() -> Vec<PathBuf>,
    /// 能力检查后的支持事件
    pub events: fn() -> Vec<String>,
    /// 安装探测（第 1/2 层）
    pub detect_impl: fn(&mut DetectionReport),
    /// hook 命令行构造（各产品对引号的处理不同，Codex 需要 cmd /c call 包裹）
    pub hook_command: fn(&Path, &str, &str) -> String,
    pub limitations: Vec<String>,
    pub timeout_secs: u64,
}

impl HooksAdapter {
    fn specs(&self, events: &[String]) -> AppResult<Vec<hooks_install::HookSpec>> {
        let exe = std::env::current_exe()
            .map_err(|e| AppError::Agent(format!("无法定位 Task Dock 可执行文件: {}", e)))?;
        Ok(events
            .iter()
            .map(|e| hooks_install::HookSpec {
                event: e.clone(),
                matcher: None,
                command: (self.hook_command)(&exe, self.source_id, e),
                timeout_secs: Some(self.timeout_secs),
            })
            .collect())
    }
}

impl ManagedAdapter for HooksAdapter {
    fn id(&self) -> &'static str {
        self.source_id
    }
    fn display_name(&self) -> &'static str {
        self.display_name
    }
    fn transport_kind(&self) -> &'static str {
        "hooks"
    }
    fn docs_url(&self) -> &'static str {
        self.docs_url
    }
    fn limitations(&self) -> Vec<String> {
        self.limitations.clone()
    }

    fn detect(&self) -> DetectionReport {
        let mut r = DetectionReport {
            adapter: self.id().into(),
            source_id: self.source_id.into(),
            display_name: self.display_name.into(),
            installed: false,
            version: None,
            install_paths: vec![],
            config_homes: vec![],
            install_method: String::new(),
            running_instances: vec![],
            capabilities: vec!["official-hooks".into()],
            supported_events: (self.events)(),
            docs_url: self.docs_url.into(),
            limitations: self.limitations(),
        };
        (self.detect_impl)(&mut r);
        r
    }

    fn preview(&self, app_data: &std::path::Path) -> AppResult<Value> {
        let files: Vec<String> = (self.hooks_files)()
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let events = (self.events)();
        let exe = std::env::current_exe()
            .map_err(|e| AppError::Agent(format!("无法定位 Task Dock 可执行文件: {}", e)))?;
        let sample = events
            .first()
            .map(|e| hooks_install::hook_command(&exe, self.source_id, e))
            .unwrap_or_default();
        Ok(json!({
            "adapter": self.id(),
            "kind": "hooks",
            "hook_files": files,
            "events": events,
            "format": {
                "example": { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "<预览>", "timeout": 10 } ] } ] } }
            },
            "transport_config": hook_cli::transport_path(app_data).to_string_lossy(),
            "command_sample": sample,
            "reporter": "native-cli",
            "safety": [
                "写入前自动备份（保留最近 5 份）",
                "原子写入，失败自动回滚",
                "第三方 hooks 条目原样保留",
                "Hook 由原生 CLI 上报（约 10ms/事件，不启动 PowerShell）",
                "可随时在 Task Dock 一键卸载（仅移除 Task Dock 条目）",
            ],
            "limitations": self.limitations(),
        }))
    }

    fn install(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        let settings = crate::db::Settings::load(db)?;
        hook_cli::write_transport_config(
            app_data,
            settings.http_port,
            &settings.http_token,
            settings.http_enabled,
        )?;
        let events = (self.events)();
        if events.is_empty() {
            return Err(AppError::Agent(format!(
                "{}：未检测到任何可用的 Hook 事件（能力检查未通过）",
                self.display_name
            )));
        }
        let specs = self.specs(&events)?;
        let files = (self.hooks_files)();
        // 多配置目录（Trae 国际/CN、WorkBuddy 多根）：全部预检查 + 统一快照，
        // 任一失败按快照恢复全部文件，不会只写一半。
        let reports = hooks_install::install_hooks_set(&files, &specs)?;
        // 记录安装元数据（供卸载与健康检查）
        let config = json!({
            "adapter": self.id(),
            "hook_files": files.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
            "reporter": "native-cli",
            "events": events,
            "installed_at": crate::agents::now_iso(),
        });
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_sources SET config = ?1, enabled = 1, kind = 'transport', adapter = ?2, updated_at = ?3 WHERE id = ?4",
                rusqlite::params![config.to_string(), self.id(), crate::agents::now_iso(), self.source_id],
            )?;
            Ok::<_, crate::error::AppError>(())
        })?;
        Ok(json!({
            "adapter": self.id(),
            "reports": reports,
            "note": "配置已写入；首次真实事件到达前，接入状态为「已配置，待事件验证」",
            "limitations": self.limitations(),
        }))
    }

    fn verify(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        verify_hook_pipeline(app_data, db, self.source_id)
    }

    fn uninstall(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        let files = (self.hooks_files)();
        let mut reports = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        let mut remaining: Vec<String> = Vec::new();
        for file in &files {
            match hooks_install::uninstall_hooks(file) {
                Ok(report) => reports.push(report),
                Err(e) => {
                    errors.push(format!("{}: {}", file.display(), e));
                    // 该文件仍可能保留 Task Dock 条目 → 未完全卸载
                    remaining.push(file.to_string_lossy().to_string());
                }
            }
        }
        // 清理旧版 PowerShell 脚本（如有）
        let legacy = hooks_install::legacy_script_path(app_data, self.source_id);
        let _ = std::fs::remove_file(&legacy);

        let complete = errors.is_empty();
        sync_uninstall_state(db, self.source_id, complete, &remaining)?;
        Ok(json!({
            "adapter": self.id(),
            "complete": complete,
            "reports": reports,
            "errors": errors,
            // 部分成功时如实报告：仍有文件可能保留 Task Dock 配置，需重试或人工检查
            "remaining_hook_files": remaining,
        }))
    }

    fn config_status(&self, app_data: &std::path::Path) -> AppResult<Value> {
        let events = (self.events)();
        let events_ref: Vec<&str> = events.iter().map(|s| s.as_str()).collect();
        let files: Vec<Value> = (self.hooks_files)()
            .iter()
            .map(|f| hooks_install::status_hooks(f, &events_ref).unwrap_or(Value::Null))
            .collect();
        let legacy = hooks_install::legacy_script_path(app_data, self.source_id);
        Ok(json!({
            "adapter": self.id(),
            "transport_config": hook_cli::transport_path(app_data).to_string_lossy(),
            "transport_config_exists": hook_cli::transport_path(app_data).exists(),
            "legacy_script_exists": legacy.exists(),
            "files": files,
        }))
    }
}

// ── 真实链路验证（第 4 层）─────────────────────────────────

/// 以与 Agent 完全相同的方式调用 Hook 上报命令（原生 CLI + stdin JSON），
/// 然后轮询数据库确认事件真实抵达。配置文件存在不算数——必须有事件证据。
pub fn verify_hook_pipeline(
    app_data: &std::path::Path,
    db: &Db,
    source_id: &str,
) -> AppResult<Value> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Agent(format!("无法定位 Task Dock 可执行文件: {}", e)))?;
    let settings = crate::db::Settings::load(db)?;
    // 确保 CLI 能读到最新传输参数（幂等；设置变更由 update_settings 同步）
    let _ = hook_cli::write_transport_config(
        app_data,
        settings.http_port,
        &settings.http_token,
        settings.http_enabled,
    );
    // 每次验证生成唯一 nonce 会话：精确匹配本次验证产生的事件，
    // 不与历史自测事件或真实会话混淆（自测会话在 ingest 侧被隔离为 selftest 证据）
    let verify_session = format!(
        "taskdock-selftest-{}-{}",
        source_id,
        &uuid::Uuid::new_v4().to_string()[..12]
    );
    let stdin_payload = json!({
        "session_id": verify_session,
        "hook_event_name": "Verify",
    })
    .to_string();
    let started = std::time::Instant::now();
    let run = std::process::Command::new(&exe)
        .args([
            hooks_install::MARKER,
            "--source",
            source_id,
            "--event",
            "SessionStart",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Ok(mut child) = run {
        use std::io::Write;
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(stdin_payload.as_bytes());
        }
        let _ = child.wait();
    } else {
        return Ok(json!({ "ok": false, "reason": "无法启动 Task Dock Hook 上报进程" }));
    }

    // 轮询数据库（HTTP 通道即时；文件回退通道最长 ~3s）：按 nonce 精确匹配
    let deadline = std::time::Duration::from_secs(8);
    while started.elapsed() < deadline {
        let hit: Option<String> = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT received_at FROM agent_events WHERE source_id = ?1 AND session_external_id = ?2 ORDER BY received_at DESC LIMIT 1",
                    rusqlite::params![source_id, verify_session],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(AppError::from)
            })
            .ok()
            .flatten();
        if let Some(received_at) = hit {
            return Ok(json!({
                "ok": true,
                "method": "hook-script → Task Dock ingest（真实链路）",
                "session": verify_session,
                "received_at": received_at,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "note": "Hook 通道已验证（transport_verified）。真实会话接入仍以非自测事件为准（verified 由真实事件置位）。",
            }));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    Ok(json!({
        "ok": false,
        "reason": "8 秒内未在数据库收到本次验证（nonce）的测试事件",
        "session": verify_session,
        "hint": "请确认 Task Dock HTTP 接入已开启（设置 → HTTP 接入），且端口未被占用；文件回退通道需 Task Dock 正在运行",
    }))
}

// ── 注册表 ─────────────────────────────────────────────────

pub fn all_adapters() -> Vec<Box<dyn ManagedAdapter>> {
    let mut out: Vec<Box<dyn ManagedAdapter>> = vec![
        Box::new(super::codex::adapter()),
        Box::new(super::trae::adapter()),
        Box::new(super::workbuddy::adapter()),
        Box::new(super::qoder::adapter()),
        Box::new(super::opencode::adapter()),
        Box::new(super::dsh::adapter()),
        Box::new(super::zcode::adapter()),
        // 第二组：官方 Hooks 明确的产品
        Box::new(super::claude::adapter()),
        Box::new(super::cursor::adapter()),
        Box::new(super::gemini::adapter()),
    ];
    out.extend(super::discovery_only::adapters());
    out
}

pub fn find_adapter(id: &str) -> Option<Box<dyn ManagedAdapter>> {
    all_adapters().into_iter().find(|a| a.id() == id)
}

/// 同步卸载后的来源配置状态。
///
/// - 完全卸载：移除 `installed_at`（不再是「已配置」），保留 `last_installed_at` 与
///   全部历史事件/`verified`/`transport_verified`，不抹除真实接入证据。
/// - 部分卸载：写入 `uninstall_partial_at` 与 `remaining_hook_files`，如实反映
///   仍有配置文件保留 Task Dock 条目，不伪装成成功。
pub fn sync_uninstall_state(
    db: &Db,
    source_id: &str,
    complete: bool,
    remaining: &[String],
) -> AppResult<()> {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT config FROM agent_sources WHERE id = ?1",
                rusqlite::params![source_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(AppError::from)?
            .flatten();
        let mut cfg = existing
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or_else(|| json!({}));
        let Some(obj) = cfg.as_object_mut() else {
            return Err(AppError::Agent(format!(
                "来源 {} 的配置不是 JSON 对象，拒绝同步卸载状态",
                source_id
            )));
        };
        if complete {
            if let Some(installed) = obj.remove("installed_at") {
                obj.insert("last_installed_at".into(), installed);
            }
            obj.insert("uninstalled_at".into(), Value::String(now.clone()));
            obj.remove("uninstall_partial_at");
            obj.remove("remaining_hook_files");
        } else {
            obj.insert("uninstall_partial_at".into(), Value::String(now.clone()));
            obj.insert("remaining_hook_files".into(), json!(remaining));
        }
        conn.execute(
            "UPDATE agent_sources SET config = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![cfg.to_string(), now.clone(), source_id],
        )?;
        Ok::<_, AppError>(())
    })
}

/// 来源健康查询返回的原始证据列（enabled/verified/transport_verified/last_event_at/config）。
type HealthRow = (i64, i64, i64, Option<String>, Option<String>);

/// 来源健康：严格区分
/// 已禁用 / 已配置 / 通道已验证 / 曾经真实接入 / 最近真实事件 / 过期 / 未知。
///
/// 历史会话与「最近完成事件」都不等于连接仍活跃；`state` 只描述证据强度，
/// 不断言实时在线。执行中的运行/等待状态由 run 表单独提供。
pub fn source_health(db: &Db, source_id: &str) -> Value {
    let row: Option<HealthRow> = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT enabled, verified, transport_verified, last_event_at, config FROM agent_sources WHERE id = ?1",
                rusqlite::params![source_id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(AppError::from)
        })
        .ok()
        .flatten();
    let Some((enabled, verified, transport_verified, last_event_at, config)) = row else {
        return json!({ "state": "unregistered", "connection_state": "unknown" });
    };
    let stale = crate::db::Settings::load(db)
        .map(|s| s.stale_run_minutes.max(1) as i64)
        .unwrap_or(15);
    let cfg = config
        .as_deref()
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .unwrap_or_else(|| json!({}));
    let configured = cfg.get("installed_at").is_some();
    let uninstall_partial = cfg.get("uninstall_partial_at").is_some();
    let recent_event = last_event_at
        .as_deref()
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes() < stale)
        .unwrap_or(false);
    let real_event_seen = last_event_at.is_some() || verified != 0;

    let state = if enabled == 0 {
        "disabled"
    } else if verified != 0 && recent_event && configured {
        "recent-event"
    } else if verified != 0 && recent_event {
        "recent-unconfigured"
    } else if verified != 0 {
        "stale"
    } else if transport_verified != 0 {
        "transport-verified"
    } else if configured {
        "awaiting-first-event"
    } else if real_event_seen {
        "history-only"
    } else {
        "no-events"
    };
    let connection_state = if enabled == 0 {
        "disabled"
    } else if recent_event {
        "recent-event"
    } else if configured || transport_verified != 0 {
        "channel-verified"
    } else {
        "unknown"
    };
    json!({
        "enabled": enabled != 0,
        "configured": configured,
        "verified": verified != 0,
        "transport_verified": transport_verified != 0,
        "real_event_seen": real_event_seen,
        "last_event_at": last_event_at,
        "recent_event": recent_event,
        "installed_at": cfg.get("installed_at").cloned(),
        "uninstalled_at": cfg.get("uninstalled_at").cloned(),
        "uninstall_partial": uninstall_partial,
        "remaining_hook_files": cfg.get("remaining_hook_files").cloned(),
        "state": state,
        "connection_state": connection_state,
    })
}
