//! DeepSeek Harness（DSH）适配器（宿主插件桥接）。
//!
//! DSH 的宿主插件不是「放进目录就自动加载」的：`~/.dsh/plugins/` 只是客户端插件位，
//! 宿主侧插件必须以 **profile bundle** 形式安装——即一个声明了
//! `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包，
//! 放在 profile 目录的 `node_modules/` 下，并登记进该 profile 的
//! `package.json` → `dsh.profile.bundles`，宿主启动时才会挂载它。
//!
//! 本适配器写入 `~/.dsh/plugins/task-dock-bridge/`（插件本体），
//! 并把它安装进 `~/.dsh/profiles/<profile>/`（每个已初始化的 profile），
//! 监听官方插件事件：
//! - agent/status（status=idle → completed；error → failed；其余 → running）
//! - agent/error → failed
//! - approval/request → waiting
//! - subagent/start / subagent/end → 子任务开始/结束（带 parent 关联）

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, ManagedAdapter};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// DSH 主目录：优先 `$DSH_HOME`（与宿主 `@deepseek-ai/dsh-home-paths` 的优先级一致），
/// 否则 `~/.dsh`。
pub fn dsh_home() -> PathBuf {
    if let Ok(v) = std::env::var("DSH_HOME") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    home_dir().join(".dsh")
}

pub fn plugins_root() -> PathBuf {
    dsh_home().join("plugins")
}

pub fn plugin_dir() -> PathBuf {
    plugins_root().join("task-dock-bridge")
}

/// profile 根目录：`~/.dsh/profiles/<name>/`。
pub fn profiles_root() -> PathBuf {
    dsh_home().join("profiles")
}

pub const PLUGIN_MARKER: &str = "task-dock-bridge";

/// bundle 的 cordis patch：把插件插入 profile 组合树。
pub const BUNDLE_PATCH: &str =
    "- insert:\n    - id: task-dock-bridge\n      name: 'task-dock-bridge'\n      inject: []\n";

/// bundle 的 package.json：声明 `dsh.bundle.patch` 才会被宿主当作 profile bundle 装载。
fn bundle_manifest() -> Value {
    json!({
        "name": PLUGIN_MARKER,
        "version": "0.3.0",
        "private": true,
        "description": "Task Dock bridge: report DSH agent lifecycle to Task Dock (auto-uninstallable)",
        "type": "module",
        "main": "lib/index.js",
        "exports": {
            ".": "./lib/index.js",
            "./package.json": "./package.json"
        },
        "dsh": {
            "bundle": {
                "patch": "./cordis.patch.yml"
            }
        },
        "license": "MIT"
    })
}

fn plugin_content(port: u16, token: &str) -> String {
    let template = r#"// task-dock-bridge — Task Dock bridge for DeepSeek Harness（由 Task Dock 生成，可一键卸载）
// 只上报状态元数据（agent id + 状态 + 时间），不读取任务正文。
// 保护：2.5s 超时、单并发、running 事件合并、失败指数退避、关键事件文件回退；
// Task Dock 不可用时绝不影响 Harness 本身（队列有界、定时器 unref）。
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export const name = '__MARKER__'
export const inject = []

const URL = 'http://127.0.0.1:__PORT__/api/v1/events'
const TOKEN = '__TOKEN__'
const MAX_QUEUE = 200
const REQUEST_TIMEOUT_MS = 2500

const queue = []
let timer = null
let inFlight = false
let failures = 0
let retryAt = 0
let seq = 0

function inboxDir() {
  // 与 Rust 侧 app_data_dir() 保持一致：便携/测试模式（TASK_DOCK_DATA_DIR）下
  // 投递目录必须跟随数据目录，否则文件回退会落到应用读不到的地方，关键事件静默丢失。
  const custom = process.env.TASK_DOCK_DATA_DIR
  if (custom) return path.join(custom, 'agent-inbox')
  return path.join(process.env.APPDATA || os.homedir(), 'com.taskdock.desktop', 'agent-inbox')
}

function fileFallback(body) {
  try {
    const dir = inboxDir()
    fs.mkdirSync(dir, { recursive: true })
    const name = 'plugin-' + Date.now() + '-' + (seq++).toString(36) + '.json'
    const finalPath = path.join(dir, name)
    fs.writeFileSync(finalPath + '.tmp', JSON.stringify(body), 'utf8')
    fs.renameSync(finalPath + '.tmp', finalPath)
    return true
  } catch {
    return false
  }
}

function schedule() {
  if (timer || inFlight) return
  const wait = Math.max(0, retryAt - Date.now())
  timer = setTimeout(() => { timer = null; void flush() }, wait)
  if (timer && typeof timer.unref === 'function') timer.unref()
}

async function flush() {
  if (inFlight || queue.length === 0) return
  if (Date.now() < retryAt) return schedule()
  const item = queue.shift()
  inFlight = true
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    let res
    try {
      res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify(item.body),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(to)
    }
    if (res.status === 429 || res.status === 503) throw new Error('busy ' + res.status)
    if (!res.ok) console.log('[task-dock-bridge] http ' + res.status)
    failures = 0
    retryAt = 0
  } catch (e) {
    failures += 1
    if (item.critical) {
      const saved = fileFallback(item.body)
      if (!saved) queue.unshift(item)
      console.log('[task-dock-bridge] critical report failed (' + (e?.message || e) + '), fallback=' + saved)
    }
    retryAt = Date.now() + Math.min(30000, 1000 * Math.pow(2, Math.min(failures, 5)))
  } finally {
    inFlight = false
    if (queue.length > 0) schedule()
  }
}

function enqueue(body, critical) {
  if (critical) {
    queue.unshift({ body, critical })
  } else {
    const i = queue.findIndex((q) => !q.critical && q.body.session_id === body.session_id && q.body.state === body.state)
    if (i >= 0) queue[i] = { body, critical }
    else queue.push({ body, critical })
  }
  while (queue.length > MAX_QUEUE) {
    const idx = queue.findIndex((q) => !q.critical)
    if (idx < 0) break
    queue.splice(idx, 1)
  }
  schedule()
}

function report(state, agentId, message, extra) {
  if (!agentId) return
  const critical = state !== 'running'
  enqueue(Object.assign({
    schema_version: 1,
    event_id: 'dsh-' + Date.now().toString(36) + '-' + (seq++).toString(36),
    source_id: 'deepseek-harness',
    session_id: String(agentId),
    state,
    message,
    occurred_at: new Date().toISOString(),
    transport: 'plugin',
    evidence_type: 'observed',
  }, extra || {}), critical)
}

export function apply(ctx) {
  ctx.on('agent/status', (p) => {
    const id = p && p.agent ? p.agent.id : undefined
    if (p.status === 'idle') report('completed', id, 'dsh: turn finished')
    else if (p.status === 'error') report('failed', id, 'dsh: agent error')
    else report('running', id, 'dsh: ' + (p.status || 'running'))
  })
  ctx.on('agent/error', (p) => {
    const id = p && p.agent ? p.agent.id : p.id
    report('failed', id, 'dsh: agent error')
  })
  ctx.on('approval/request', (p) => {
    const id = p && p.agent ? p.agent.id : p.id
    report('waiting', id, 'dsh: approval requested')
  })
  ctx.on('subagent/start', (info) => {
    const id = info && info.parent ? info.parent : undefined
    report('running', id, 'dsh: subagent started', { instance_id: 'subagent-' + String(info && info.id) })
  })
  ctx.on('subagent/end', (info) => {
    const id = info && info.parent ? info.parent : undefined
    const ok = info && info.stopReason === 'completed'
    report(ok ? 'completed' : 'failed', id, 'dsh: subagent ended (' + ((info && info.stopReason) || 'unknown') + ')')
  })
  console.log('[__MARKER__] loaded')
}
"#;
    template
        .replace("__MARKER__", PLUGIN_MARKER)
        .replace("__PORT__", &port.to_string())
        .replace("__TOKEN__", token)
}

#[derive(Clone)]
pub struct DshAdapter;

pub fn adapter() -> DshAdapter {
    DshAdapter
}

/// 已初始化的 profile 目录（`~/.dsh/profiles/<name>/`，含 package.json）。
pub fn initialized_profiles() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(profiles_root()) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("package.json").is_file() {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// 把 bundle 包写进 profile 的 `node_modules/`。
fn write_bundle_package(dir: &Path, port: u16, token: &str) -> AppResult<()> {
    std::fs::create_dir_all(dir.join("lib"))?;
    std::fs::write(
        dir.join("package.json"),
        serde_json::to_string_pretty(&bundle_manifest())?,
    )?;
    std::fs::write(dir.join("cordis.patch.yml"), BUNDLE_PATCH)?;
    std::fs::write(
        dir.join("lib").join("index.js"),
        plugin_content(port, token),
    )?;
    Ok(())
}

/// profile 清单里登记/摘除 bundle；只动 Task Dock 自己的两个字段，其余原样保留。
fn update_profile_manifest(profile_dir: &Path, install: bool) -> AppResult<bool> {
    let path = profile_dir.join("package.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };
    let mut root: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Agent(format!("profile 清单不是合法 JSON: {}", e)))?;
    if !root.is_object() {
        return Ok(false);
    }
    let obj = root.as_object_mut().expect("已是对象");

    // dependencies
    let deps = obj
        .entry("dependencies")
        .or_insert_with(|| Value::Object(Default::default()));
    if deps.is_object() {
        let d = deps.as_object_mut().expect("已确保是对象");
        if install {
            d.insert(
                PLUGIN_MARKER.to_string(),
                Value::String(format!("file:./node_modules/{}", PLUGIN_MARKER)),
            );
        } else {
            d.remove(PLUGIN_MARKER);
        }
    }

    // dsh.profile.bundles
    if let Some(profile) = obj.get_mut("dsh").and_then(|v| v.get_mut("profile")) {
        if profile.is_object() {
            let p = profile.as_object_mut().expect("已确保是对象");
            let bundles = p
                .entry("bundles")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(arr) = bundles.as_array_mut() {
                arr.retain(|v| v.as_str() != Some(PLUGIN_MARKER));
                if install {
                    arr.push(Value::String(PLUGIN_MARKER.to_string()));
                }
            }
        }
    }

    std::fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(true)
}

/// 把插件装进某个 profile（bundle 包 + 清单登记）。
pub fn install_into_profile(profile_dir: &Path, port: u16, token: &str) -> AppResult<bool> {
    if !profile_dir.join("package.json").is_file() {
        return Ok(false);
    }
    write_bundle_package(
        &profile_dir.join("node_modules").join(PLUGIN_MARKER),
        port,
        token,
    )?;
    update_profile_manifest(profile_dir, true)
}

/// 从某个 profile 摘除插件。
pub fn uninstall_from_profile(profile_dir: &Path) -> AppResult<bool> {
    let pkg_dir = profile_dir.join("node_modules").join(PLUGIN_MARKER);
    if pkg_dir.exists() {
        // 只删 Task Dock 自己生成的包
        let ours = std::fs::read_to_string(pkg_dir.join("lib").join("index.js"))
            .map(|c| c.contains(PLUGIN_MARKER))
            .unwrap_or(false);
        if ours {
            std::fs::remove_dir_all(&pkg_dir)?;
        }
    }
    update_profile_manifest(profile_dir, false)
}

/// 各 profile 的装载状态。
pub fn profile_status() -> Vec<Value> {
    initialized_profiles()
        .into_iter()
        .map(|dir| {
            let pkg = dir.join("node_modules").join(PLUGIN_MARKER);
            let listed = std::fs::read_to_string(dir.join("package.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| {
                    v.get("dsh")?
                        .get("profile")?
                        .get("bundles")?
                        .as_array()
                        .map(|a| a.iter().any(|x| x.as_str() == Some(PLUGIN_MARKER)))
                })
                .unwrap_or(false);
            json!({
                "profile": dir.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                "package_installed": pkg.join("lib").join("index.js").is_file(),
                "listed_in_bundles": listed,
                "active": listed && pkg.join("lib").join("index.js").is_file(),
            })
        })
        .collect()
}

impl ManagedAdapter for DshAdapter {
    fn id(&self) -> &'static str {
        "dsh"
    }
    fn display_name(&self) -> &'static str {
        "DeepSeek Harness"
    }
    fn transport_kind(&self) -> &'static str {
        "plugin"
    }
    fn docs_url(&self) -> &'static str {
        "https://github.com/libukai/awesome-deepseek-harness"
    }
    fn limitations(&self) -> Vec<String> {
        vec![
            "DSH 插件机制无正式稳定性承诺，事件字段以本机 dsh-task-chime 参考实现为准".into(),
            "宿主插件必须以 profile bundle 形式安装；安装后需重启对应 profile 的 DSH 进程".into(),
        ]
    }

    fn detect(&self) -> DetectionReport {
        let mut r = DetectionReport {
            adapter: "dsh".into(),
            source_id: "deepseek-harness".into(),
            display_name: "DeepSeek Harness".into(),
            installed: false,
            version: None,
            install_paths: vec![],
            config_homes: vec![],
            install_method: String::new(),
            running_instances: vec![],
            capabilities: vec!["host-plugin-events".into()],
            supported_events: vec![
                "agent/status".into(),
                "agent/error".into(),
                "approval/request".into(),
                "subagent/start".into(),
                "subagent/end".into(),
            ],
            docs_url: self.docs_url().into(),
            limitations: self.limitations(),
        };
        let home = dsh_home();
        let app = std::env::var("LOCALAPPDATA")
            .ok()
            .map(|l| PathBuf::from(l).join("Programs").join("DeepSeek Harness"))
            .filter(|p| p.exists());
        r.installed = home.exists() || app.is_some();
        if home.exists() {
            r.config_homes.push(home.to_string_lossy().to_string());
        }
        if let Some(a) = &app {
            r.install_paths.push(a.to_string_lossy().to_string());
        }
        r.install_method = "config-home-or-program-dir".into();
        r.running_instances = managed::find_processes(&["DeepSeek Harness", "dsh", "dsh-desktop"]);
        r
    }

    fn preview(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({
            "adapter": "dsh",
            "kind": "plugin",
            "plugin_dir": plugin_dir().to_string_lossy(),
            "profiles_root": profiles_root().to_string_lossy(),
            "profiles": profile_status(),
            "files": [
                plugin_dir().join("package.json").to_string_lossy(),
                plugin_dir().join("cordis.patch.yml").to_string_lossy(),
                plugin_dir().join("lib").join("index.js").to_string_lossy()
            ],
            "plugin_sample": plugin_content(47821, "<令牌在安装时写入>"),
            "events": ["agent/status", "agent/error", "approval/request", "subagent/start", "subagent/end"],
            "mechanism": "宿主插件必须是 profile bundle：package.json 声明 dsh.bundle.patch + 登记进 profile 的 dsh.profile.bundles",
            "safety": [
                "只新增 task-dock-bridge 插件目录与 profile bundle 条目，不动 settings.yaml 与其他插件",
                "profile 清单只增删 Task Dock 自己的两个字段，其余条目原样保留",
                "卸载 = 删除插件目录并摘除 profile 登记项"
            ],
            "limitations": self.limitations(),
        }))
    }

    fn install(&self, _app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        let settings = crate::db::Settings::load(db)?;
        let dir = plugin_dir();
        if dir.exists() {
            // 已存在：只允许覆盖我们自己的
            let existing =
                std::fs::read_to_string(dir.join("lib").join("index.js")).unwrap_or_default();
            if !existing.contains(PLUGIN_MARKER) {
                return Err(AppError::Agent(format!(
                    "{} 已存在且非 Task Dock 生成，拒绝覆盖",
                    dir.display()
                )));
            }
        }
        write_bundle_package(&dir, settings.http_port, &settings.http_token)?;

        // 装进每个已初始化的 profile：宿主只在 profile 的 bundles 列表里装载 bundle。
        let mut installed = Vec::new();
        let mut failed = Vec::new();
        for profile in initialized_profiles() {
            match install_into_profile(&profile, settings.http_port, &settings.http_token) {
                Ok(true) => installed.push(
                    profile
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string(),
                ),
                Ok(false) => {}
                Err(e) => failed.push(format!(
                    "{}: {}",
                    profile.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                    e
                )),
            }
        }

        let config = json!({
            "adapter": "dsh",
            "plugin_dir": dir.to_string_lossy(),
            "profiles": installed,
            "installed_at": crate::agents::now_iso(),
        });
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_sources SET config = ?1, enabled = 1, kind = 'plugin', adapter = 'dsh', updated_at = ?2 WHERE id = 'deepseek-harness'",
                rusqlite::params![config.to_string(), crate::agents::now_iso()],
            )?;
            Ok::<_, crate::error::AppError>(())
        })?;
        let note = if installed.is_empty() {
            "插件已写入，但未发现已初始化的 dsh profile；宿主只从 profile 的 bundles 装载插件，请先运行一次 dsh（如 `dsh --profile headless`）再重新安装"
        } else {
            "插件已写入并登记进 profile；重启 DSH 后生效"
        };
        Ok(json!({
            "adapter": "dsh",
            "plugin_dir": dir.to_string_lossy(),
            "profiles_installed": installed,
            "profiles_failed": failed,
            "note": note,
        }))
    }

    fn verify(&self, _app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        let settings = crate::db::Settings::load(db)?;
        let res = super::opencode::reqwest_like_post(
            &format!("http://127.0.0.1:{}/api/v1/events", settings.http_port),
            &settings.http_token,
            &json!({
                "source_id": "deepseek-harness",
                "session_id": "taskdock-selftest-dsh",
                "state": "running",
                "message": "plugin bridge self-test",
                "transport": "plugin",
            }),
        );
        match res {
            Ok(200) => {
                let _ = db.with_conn(|conn| {
                    conn.execute(
                        // 自测只证明插件→HTTP→DB 通道可用；真实会话验证必须等自然事件。
                        "UPDATE agent_sources SET transport_verified = 1, last_event_at = ?1 WHERE id = 'deepseek-harness'",
                        rusqlite::params![crate::agents::now_iso()],
                    )?;
                    Ok::<_, crate::error::AppError>(())
                });
                Ok(
                    json!({ "ok": true, "note": "插件上报链路（plugin → HTTP ingest → DB）已验证；真实会话验证需等待自然事件" }),
                )
            }
            Ok(s) => Ok(json!({ "ok": false, "reason": format!("HTTP {}", s) })),
            Err(e) => Ok(json!({ "ok": false, "reason": e })),
        }
    }

    fn uninstall(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        let dir = plugin_dir();
        if dir.exists() {
            let existing =
                std::fs::read_to_string(dir.join("lib").join("index.js")).unwrap_or_default();
            if !existing.contains(PLUGIN_MARKER) {
                return Err(AppError::Agent(
                    "插件目录非 Task Dock 生成，拒绝删除".into(),
                ));
            }
            std::fs::remove_dir_all(&dir)?;
        }
        let mut cleaned = Vec::new();
        for profile in initialized_profiles() {
            match uninstall_from_profile(&profile) {
                Ok(_) => cleaned.push(
                    profile
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string(),
                ),
                Err(e) => tracing::warn!("从 profile {} 摘除插件失败: {}", profile.display(), e),
            }
        }
        Ok(json!({
            "adapter": "dsh",
            "removed": dir.to_string_lossy(),
            "profiles_cleaned": cleaned,
        }))
    }

    fn config_status(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        let dir = plugin_dir();
        let installed = dir.join("lib").join("index.js").exists()
            && std::fs::read_to_string(dir.join("lib").join("index.js"))
                .map(|c| c.contains(PLUGIN_MARKER))
                .unwrap_or(false);
        Ok(json!({
            "adapter": "dsh",
            "plugin_installed": installed,
            "plugin_dir": dir.to_string_lossy(),
            "profiles": profile_status(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-dsh-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个「有第三方内容」的 profile 清单：第三方依赖、第三方 bundle、
    /// 其它 dsh 字段都必须原样保留。
    fn write_profile(profile_dir: &Path) {
        std::fs::create_dir_all(profile_dir).unwrap();
        std::fs::write(
            profile_dir.join("package.json"),
            serde_json::to_string_pretty(&json!({
                "name": "headless",
                "private": true,
                "dependencies": { "third-party-pkg": "1.2.3" },
                "dsh": {
                    "profile": {
                        "bundles": ["third-party-bundle"],
                        "other": "keep-me"
                    }
                },
                "customTopLevel": { "keep": true }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn manifest_of(profile_dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(profile_dir.join("package.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn bundle_manifest_declares_profile_bundle_entry() {
        let m = bundle_manifest();
        assert_eq!(m["name"], PLUGIN_MARKER);
        assert_eq!(
            m["dsh"]["bundle"]["patch"], "./cordis.patch.yml",
            "缺少 dsh.bundle.patch 声明 → 宿主不会把它当 bundle 装载"
        );
        assert!(
            BUNDLE_PATCH.contains("- insert:"),
            "patch 必须是 insert 指令"
        );
        assert!(BUNDLE_PATCH.contains("id: task-dock-bridge"));
    }

    #[test]
    fn install_into_profile_registers_bundle_and_keeps_third_party_entries() {
        let dir = tmp_dir("install");
        let profile = dir.join("headless");
        write_profile(&profile);

        assert!(install_into_profile(&profile, 47821, "tok").unwrap());

        // bundle 包已落盘
        let pkg = profile.join("node_modules").join(PLUGIN_MARKER);
        assert!(pkg.join("package.json").is_file());
        assert!(pkg.join("cordis.patch.yml").is_file());
        let js = std::fs::read_to_string(pkg.join("lib").join("index.js")).unwrap();
        assert!(js.contains(PLUGIN_MARKER));
        assert!(js.contains("47821"), "插件必须写入当前 HTTP 端口");

        let m = manifest_of(&profile);
        assert_eq!(
            m["dependencies"]["third-party-pkg"], "1.2.3",
            "第三方依赖不得被动"
        );
        assert_eq!(
            m["dependencies"][PLUGIN_MARKER],
            format!("file:./node_modules/{}", PLUGIN_MARKER)
        );
        let bundles = m["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert!(bundles.iter().any(|b| b == PLUGIN_MARKER));
        assert!(
            bundles.iter().any(|b| b == "third-party-bundle"),
            "第三方 bundle 不得丢"
        );
        assert_eq!(m["dsh"]["profile"]["other"], "keep-me");
        assert_eq!(m["customTopLevel"]["keep"], true);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_into_profile_is_idempotent() {
        let dir = tmp_dir("idem");
        let profile = dir.join("headless");
        write_profile(&profile);

        install_into_profile(&profile, 47821, "tok").unwrap();
        install_into_profile(&profile, 47821, "tok").unwrap();

        let m = manifest_of(&profile);
        let bundles = m["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert_eq!(
            bundles.iter().filter(|b| *b == PLUGIN_MARKER).count(),
            1,
            "重复安装不得产生重复 bundle 条目"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_into_profile_skips_profile_without_manifest() {
        let dir = tmp_dir("nomanifest");
        let profile = dir.join("empty");
        std::fs::create_dir_all(&profile).unwrap();
        assert!(
            !install_into_profile(&profile, 47821, "tok").unwrap(),
            "未初始化的 profile 不应被写入"
        );
        assert!(!profile.join("node_modules").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn uninstall_from_profile_removes_only_task_dock_entries() {
        let dir = tmp_dir("uninstall");
        let profile = dir.join("headless");
        write_profile(&profile);
        install_into_profile(&profile, 47821, "tok").unwrap();

        assert!(uninstall_from_profile(&profile).unwrap());

        let m = manifest_of(&profile);
        assert!(
            m["dependencies"].get(PLUGIN_MARKER).is_none(),
            "自有依赖应被摘除"
        );
        assert_eq!(m["dependencies"]["third-party-pkg"], "1.2.3");
        let bundles = m["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert!(!bundles.iter().any(|b| b == PLUGIN_MARKER));
        assert!(bundles.iter().any(|b| b == "third-party-bundle"));
        assert_eq!(m["dsh"]["profile"]["other"], "keep-me");
        assert!(
            !profile.join("node_modules").join(PLUGIN_MARKER).exists(),
            "插件包目录应被删除"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn uninstall_keeps_foreign_package_in_node_modules() {
        let dir = tmp_dir("foreign");
        let profile = dir.join("headless");
        write_profile(&profile);
        install_into_profile(&profile, 47821, "tok").unwrap();
        // 模拟 node_modules 下出现非 Task Dock 生成的同名目录
        let foreign = profile.join("node_modules").join(PLUGIN_MARKER);
        std::fs::write(foreign.join("lib").join("index.js"), "// someone else").unwrap();

        uninstall_from_profile(&profile).unwrap();
        assert!(
            foreign.join("lib").join("index.js").is_file(),
            "非 Task Dock 生成的目录不得删除"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
