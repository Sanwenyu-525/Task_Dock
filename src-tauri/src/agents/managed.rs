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

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use rusqlite::OptionalExtension;

use super::hooks_install;

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
    /// 可逆卸载。
    fn uninstall(&self, app_data: &std::path::Path) -> AppResult<Value>;
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
    if let Ok(output) = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
    {
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

/// 运行 exe --version 并截取首行。
pub fn probe_version(exe: &PathBuf, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(exe).args(args).output().ok()?;
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
        // where 命令（Windows）
        if let Ok(out) = std::process::Command::new("where").arg(n).output() {
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

/// 在二进制文件中扫描 Hook 事件名（P0-1 能力检查：只注册当前版本真正支持的事件）。
/// 用 regex（memchr 优化）做字面量搜索：Agent 二进制动辄 200MB+，
/// 逐字节滑窗在未优化构建下不可接受。
pub fn scan_events_in_binary(exe: &PathBuf, candidates: &[&str]) -> Vec<String> {
    const MAX_SCAN: u64 = 512 * 1024 * 1024;
    let Ok(meta) = std::fs::metadata(exe) else {
        return Vec::new();
    };
    if meta.len() > MAX_SCAN {
        return Vec::new();
    }
    let Ok(data) = std::fs::read(exe) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for c in candidates {
        if let Ok(re) = regex::bytes::RegexBuilder::new(&regex::escape(c))
            .case_insensitive(true)
            .build()
        {
            if re.is_match(&data) {
                found.push(c.to_string());
            }
        }
    }
    found
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
    if let Ok(raw) = std::fs::read_to_string(&cache_file) {
        if let Ok(cached) = serde_json::from_str::<serde_json::Value>(&raw) {
            if cached.get("stamp").and_then(|v| v.as_str()) == Some(stamp.as_str()) {
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
        serde_json::to_string(&json!({ "stamp": stamp, "events": found })).unwrap_or_default(),
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
    pub limitations: Vec<String>,
    pub timeout_secs: u64,
}

impl HooksAdapter {
    fn script_path(&self, app_data: &std::path::Path) -> PathBuf {
        app_data
            .join("hooks")
            .join(format!("task-dock-agent-hook-{}.ps1", self.source_id))
    }

    fn specs(&self, script: &std::path::Path, events: &[String]) -> Vec<hooks_install::HookSpec> {
        events
            .iter()
            .map(|e| hooks_install::HookSpec {
                event: e.clone(),
                matcher: None,
                command: hooks_install::hook_command(script, self.source_id, e),
                timeout_secs: Some(self.timeout_secs),
            })
            .collect()
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
        Ok(json!({
            "adapter": self.id(),
            "kind": "hooks",
            "hook_files": files,
            "events": events,
            "format": {
                "example": { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "<预览>", "timeout": 10 } ] } ] } }
            },
            "script_path": self.script_path(app_data).to_string_lossy(),
            "script_sample": hooks_install::hook_script_content(self.source_id, 47821, "<令牌在安装时写入>"),
            "safety": [
                "写入前自动备份（保留最近 5 份）",
                "原子写入，失败自动回滚",
                "第三方 hooks 条目原样保留",
                "可随时在 Task Dock 一键卸载（仅移除 Task Dock 条目）",
            ],
            "limitations": self.limitations(),
        }))
    }

    fn install(&self, app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        let settings = crate::db::Settings::load(db)?;
        let script = hooks_install::write_hook_script(
            app_data,
            self.source_id,
            settings.http_port,
            &settings.http_token,
        )?;
        let events = (self.events)();
        if events.is_empty() {
            return Err(AppError::Agent(format!(
                "{}：未检测到任何可用的 Hook 事件（能力检查未通过）",
                self.display_name
            )));
        }
        let specs = self.specs(&script, &events);
        let mut reports = Vec::new();
        for file in (self.hooks_files)() {
            let report = hooks_install::install_hooks(&file, &specs)?;
            reports.push(report);
        }
        // 记录安装元数据（供卸载与健康检查）
        let config = json!({
            "adapter": self.id(),
            "hook_files": (self.hooks_files)().iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
            "script": script.to_string_lossy(),
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

    fn uninstall(&self, app_data: &std::path::Path) -> AppResult<Value> {
        let mut reports = Vec::new();
        for file in (self.hooks_files)() {
            let report = hooks_install::uninstall_hooks(&file)?;
            reports.push(report);
        }
        let script = self.script_path(app_data);
        let _ = std::fs::remove_file(&script);
        Ok(json!({ "adapter": self.id(), "reports": reports }))
    }

    fn config_status(&self, app_data: &std::path::Path) -> AppResult<Value> {
        let events = (self.events)();
        let events_ref: Vec<&str> = events.iter().map(|s| s.as_str()).collect();
        let files: Vec<Value> = (self.hooks_files)()
            .iter()
            .map(|f| hooks_install::status_hooks(f, &events_ref).unwrap_or(Value::Null))
            .collect();
        let script_exists = self.script_path(app_data).exists();
        Ok(json!({
            "adapter": self.id(),
            "script_exists": script_exists,
            "files": files,
        }))
    }
}

// ── 真实链路验证（第 4 层）─────────────────────────────────

/// 以与 Agent 完全相同的方式调用 Hook 脚本（stdin JSON + 事件参数），
/// 然后轮询数据库确认事件真实抵达。配置文件存在不算数——必须有事件证据。
pub fn verify_hook_pipeline(
    app_data: &std::path::Path,
    db: &Db,
    source_id: &str,
) -> AppResult<Value> {
    let script = app_data
        .join("hooks")
        .join(format!("task-dock-agent-hook-{}.ps1", source_id));
    if !script.exists() {
        return Ok(json!({
            "ok": false,
            "reason": "脚本未安装",
            "hint": "请先执行接入安装"
        }));
    }
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
    let run = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.to_string_lossy(),
            "-Source",
            source_id,
            "-Event",
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
        return Ok(json!({ "ok": false, "reason": "无法启动 PowerShell 执行 Hook 脚本" }));
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
    vec![
        Box::new(super::codex::adapter()),
        Box::new(super::trae::adapter()),
        Box::new(super::workbuddy::adapter()),
        Box::new(super::qoder::adapter()),
        Box::new(super::opencode::adapter()),
        Box::new(super::dsh::adapter()),
        Box::new(super::zcode::adapter()),
    ]
}

pub fn find_adapter(id: &str) -> Option<Box<dyn ManagedAdapter>> {
    all_adapters().into_iter().find(|a| a.id() == id)
}

/// 来源健康：严格区分 已配置 / 已收到事件 / 实时有效 / 过期 / 失联。
pub fn source_health(db: &Db, source_id: &str) -> Value {
    let row: Option<(i64, i64, Option<String>, Option<String>)> = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT enabled, verified, last_event_at, config FROM agent_sources WHERE id = ?1",
                rusqlite::params![source_id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(AppError::from)
        })
        .ok()
        .flatten();
    let Some((enabled, verified, last_event_at, config)) = row else {
        return json!({ "state": "unregistered" });
    };
    let stale = crate::db::Settings::load(db)
        .map(|s| s.stale_run_minutes.max(1) as i64)
        .unwrap_or(15);
    let configured = config
        .as_deref()
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .map(|c| c.get("installed_at").is_some())
        .unwrap_or(false);
    let (state, has_recent_event) = match last_event_at {
        Some(ref ts) => {
            let fresh = chrono::DateTime::parse_from_rfc3339(ts)
                .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes() < stale)
                .unwrap_or(false);
            (
                if verified == 0 {
                    "awaiting-first-event"
                } else if fresh {
                    "live"
                } else {
                    "stale"
                },
                fresh,
            )
        }
        None => ("no-events", false),
    };
    json!({
        "enabled": enabled != 0,
        "configured": configured,
        "verified": verified != 0,
        "last_event_at": last_event_at,
        "recent_event": has_recent_event,
        "state": state,
    })
}
