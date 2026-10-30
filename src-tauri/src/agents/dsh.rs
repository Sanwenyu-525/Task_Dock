//! DeepSeek Harness（DSH）适配器（宿主插件桥接）。
//!
//! DSH 是「一切皆插件」的自进化 Harness：`~/.dsh/plugins/<name>/` 下的插件随宿主自动加载
//! （本机 dsh-task-chime 即为该机制的现成参考实现）。
//! 本适配器写入 `~/.dsh/plugins/task-dock-bridge/`，监听官方插件事件：
//! - agent/status（status=idle → completed；error → failed；其余 → running）
//! - agent/error → failed
//! - approval/request → waiting
//! - subagent/start / subagent/end → 子任务开始/结束（带 parent 关联）

use std::path::PathBuf;

use serde_json::{json, Value};

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, ManagedAdapter};
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub fn plugins_root() -> PathBuf {
    home_dir().join(".dsh").join("plugins")
}

pub fn plugin_dir() -> PathBuf {
    plugins_root().join("task-dock-bridge")
}

pub const PLUGIN_MARKER: &str = "task-dock-bridge";

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
            "插件随 Harness 启动自动加载；安装后需重启 DSH".into(),
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
        let home = home_dir().join(".dsh");
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
            "files": [plugin_dir().join("package.json").to_string_lossy(), plugin_dir().join("lib").join("index.js").to_string_lossy()],
            "plugin_sample": plugin_content(47821, "<令牌在安装时写入>"),
            "events": ["agent/status", "agent/error", "approval/request", "subagent/start", "subagent/end"],
            "safety": ["只新增 task-dock-bridge 插件目录，不动 settings.yaml 与其他插件", "卸载 = 删除该插件目录"],
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
        std::fs::create_dir_all(dir.join("lib"))?;
        let pkg = json!({
            "name": PLUGIN_MARKER,
            "version": "0.2.0",
            "private": true,
            "description": "Task Dock bridge: report DSH agent lifecycle to Task Dock (auto-uninstallable)",
            "type": "module",
            "main": "lib/index.js",
            "license": "MIT"
        });
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&pkg)?,
        )?;
        std::fs::write(
            dir.join("lib").join("index.js"),
            plugin_content(settings.http_port, &settings.http_token),
        )?;
        let config = json!({
            "adapter": "dsh",
            "plugin_dir": dir.to_string_lossy(),
            "installed_at": crate::agents::now_iso(),
        });
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_sources SET config = ?1, enabled = 1, kind = 'plugin', adapter = 'dsh', updated_at = ?2 WHERE id = 'deepseek-harness'",
                rusqlite::params![config.to_string(), crate::agents::now_iso()],
            )?;
            Ok::<_, crate::error::AppError>(())
        })?;
        Ok(json!({
            "adapter": "dsh",
            "plugin_dir": dir.to_string_lossy(),
            "note": "插件已写入；重启 DSH 后生效",
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
        Ok(json!({ "adapter": "dsh", "removed": dir.to_string_lossy() }))
    }

    fn config_status(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        let dir = plugin_dir();
        let installed = dir.join("lib").join("index.js").exists()
            && std::fs::read_to_string(dir.join("lib").join("index.js"))
                .map(|c| c.contains(PLUGIN_MARKER))
                .unwrap_or(false);
        Ok(
            json!({ "adapter": "dsh", "plugin_installed": installed, "plugin_dir": dir.to_string_lossy() }),
        )
    }
}
