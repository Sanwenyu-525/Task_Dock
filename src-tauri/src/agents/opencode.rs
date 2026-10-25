//! OpenCode 适配器（TS 插件桥接）。
//!
//! 官方插件系统：`~/.config/opencode/plugins/*.ts` 启动时自动加载。
//! 插件通过通用 `event` 钩子订阅会话/权限/工具事件，映射为 Task Dock 状态：
//! - session.created / tool.execute.before / tool.execute.after → running
//! - session.idle → completed（一轮回复结束）
//! - session.error → failed
//! - permission.asked → waiting
//!
//! 插件只上报状态元数据（会话 ID + 状态 + 时间），不读取消息正文。

use std::path::PathBuf;

use serde_json::{json, Value};

use super::hooks_install::home_dir;
use super::managed::{self, DetectionReport, ManagedAdapter};
use crate::db::Db;
use crate::error::{AppError, AppResult};

pub fn plugin_dir() -> PathBuf {
    home_dir().join(".config").join("opencode").join("plugins")
}

pub fn plugin_file() -> PathBuf {
    plugin_dir().join("task-dock-bridge.ts")
}

pub const PLUGIN_MARKER: &str = "task-dock-bridge";

fn plugin_content(port: u16, token: &str) -> String {
    format!(
        r#"// Task Dock bridge for OpenCode（由 Task Dock 生成；可在 Task Dock 中一键卸载）
// 只上报状态元数据（会话 ID + 状态），不读取消息正文/Prompt。
const TASK_DOCK_URL = "http://127.0.0.1:{port}/api/v1/events";
const TASK_DOCK_TOKEN = "{token}";

async function report(state: string, sessionID: string, message: string) {{
  try {{
    await fetch(TASK_DOCK_URL, {{
      method: "POST",
      headers: {{
        "Content-Type": "application/json",
        Authorization: `Bearer ${{TASK_DOCK_TOKEN}}`,
      }},
      body: JSON.stringify({{
        source_id: "opencode",
        session_id: sessionID || "opencode-unknown",
        state,
        message,
        occurred_at: new Date().toISOString(),
        transport: "plugin",
      }}),
    }});
  }} catch {{
    // Task Dock 未运行时静默失败，绝不影响 OpenCode 本身
  }}
}}

export const TaskDockBridge = async () => {{
  return {{
    event: async ({{ event }}: {{ event: any }}) => {{
      try {{
        const t: string = event.type ?? "";
        if (!t) return;
        const sid: string = (event.properties?.sessionID ?? event.properties?.session?.id ?? "") + "";
        if (t === "session.created") return report("running", sid, "opencode: session created");
        if (t === "session.idle") return report("completed", sid, "opencode: turn finished");
        if (t === "session.error") return report("failed", sid, "opencode: session error");
        if (t === "permission.asked") return report("waiting", sid, "opencode: permission asked");
        if (t === "tool.execute.before") return report("running", sid, "opencode: tool executing");
      }} catch {{
        // 任何解析异常都不影响宿主
      }}
    }},
  }};
}};
"#,
        port = port,
        token = token
    )
}

#[derive(Clone)]
pub struct OpencodeAdapter;

pub fn adapter() -> OpencodeAdapter {
    OpencodeAdapter
}

impl ManagedAdapter for OpencodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn display_name(&self) -> &'static str {
        "OpenCode"
    }
    fn transport_kind(&self) -> &'static str {
        "plugin"
    }
    fn docs_url(&self) -> &'static str {
        "https://opencode.ai/docs/plugins"
    }
    fn limitations(&self) -> Vec<String> {
        vec![
            "插件在 OpenCode 启动时自动加载；安装后需重启 OpenCode 会话".into(),
            "session.idle 表示一轮回复结束（映射为本轮完成），不代表整个任务完成".into(),
        ]
    }

    fn detect(&self) -> DetectionReport {
        let mut r = DetectionReport {
            adapter: "opencode".into(),
            source_id: "opencode".into(),
            display_name: "OpenCode".into(),
            installed: false,
            version: None,
            install_paths: vec![],
            config_homes: vec![],
            install_method: String::new(),
            running_instances: vec![],
            capabilities: vec!["official-plugin-events".into()],
            supported_events: vec![
                "session.created".into(),
                "session.idle".into(),
                "session.error".into(),
                "permission.asked".into(),
                "tool.execute.before".into(),
            ],
            docs_url: self.docs_url().into(),
            limitations: self.limitations(),
        };
        let home = home_dir().join(".config").join("opencode");
        r.installed = home.exists() || managed::find_exe(&["opencode", "opencode.exe"]).is_some();
        if home.exists() {
            r.config_homes.push(home.to_string_lossy().to_string());
        }
        if let Some(e) = managed::find_exe(&["opencode", "opencode.exe"]) {
            r.install_paths.push(e.to_string_lossy().to_string());
            r.version = managed::probe_version(&e, &["--version"]);
        }
        r.install_method = "npm-global-or-config-home".into();
        r.running_instances = managed::find_processes(&["opencode-cli", "opencode"]);
        r
    }

    fn preview(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        Ok(json!({
            "adapter": "opencode",
            "kind": "plugin",
            "plugin_file": plugin_file().to_string_lossy(),
            "plugin_sample": plugin_content(47821, "<令牌在安装时写入>"),
            "events": ["session.created", "session.idle", "session.error", "permission.asked", "tool.execute.before"],
            "safety": ["只新增一个插件文件，不动 opencode.json 主配置", "卸载 = 删除该插件文件"],
            "limitations": self.limitations(),
        }))
    }

    fn install(&self, _app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        let settings = crate::db::Settings::load(db)?;
        let dir = plugin_dir();
        std::fs::create_dir_all(&dir)?;
        // 若已存在第三方同名文件则拒绝（不覆盖任何非 Task Dock 文件）
        let file = plugin_file();
        if file.exists() {
            let existing = std::fs::read_to_string(&file).unwrap_or_default();
            if !existing.contains(PLUGIN_MARKER) && !existing.contains("Task Dock") {
                return Err(AppError::Agent(format!(
                    "{} 已存在且不是 Task Dock 生成的文件，拒绝覆盖",
                    file.display()
                )));
            }
        }
        std::fs::write(
            &file,
            plugin_content(settings.http_port, &settings.http_token),
        )?;
        let config = json!({
            "adapter": "opencode",
            "plugin_file": file.to_string_lossy(),
            "installed_at": crate::agents::now_iso(),
        });
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_sources SET config = ?1, enabled = 1, kind = 'plugin', adapter = 'opencode', updated_at = ?2 WHERE id = 'opencode'",
                rusqlite::params![config.to_string(), crate::agents::now_iso()],
            )?;
            Ok::<_, crate::error::AppError>(())
        })?;
        Ok(json!({
            "adapter": "opencode",
            "plugin_file": file.to_string_lossy(),
            "note": "插件已写入；重启 OpenCode 会话后生效",
        }))
    }

    fn verify(&self, _app_data: &std::path::Path, db: &Db) -> AppResult<Value> {
        // 插件通道验证：直接以插件相同的方式上报一次测试事件（真实 HTTP 链路）
        let settings = crate::db::Settings::load(db)?;
        let client = reqwest_like_post(
            &format!("http://127.0.0.1:{}/api/v1/events", settings.http_port),
            &settings.http_token,
            &json!({
                "source_id": "opencode",
                "session_id": "taskdock-selftest-opencode",
                "state": "running",
                "message": "plugin bridge self-test",
                "transport": "plugin",
            }),
        );
        match client {
            Ok(status) if status == 200 => {
                let _ = db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE agent_sources SET verified = 1, last_event_at = ?1 WHERE id = 'opencode'",
                        rusqlite::params![crate::agents::now_iso()],
                    )?;
                    Ok::<_, crate::error::AppError>(())
                });
                Ok(
                    json!({ "ok": true, "http_status": status, "note": "插件上报链路（plugin → HTTP ingest → DB）已验证" }),
                )
            }
            Ok(status) => Ok(json!({ "ok": false, "reason": format!("HTTP {}", status) })),
            Err(e) => Ok(json!({ "ok": false, "reason": e })),
        }
    }

    fn uninstall(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        let file = plugin_file();
        if file.exists() {
            let existing = std::fs::read_to_string(&file).unwrap_or_default();
            if !existing.contains(PLUGIN_MARKER) && !existing.contains("Task Dock") {
                return Err(AppError::Agent(
                    "插件文件非 Task Dock 生成，拒绝删除".into(),
                ));
            }
            std::fs::remove_file(&file)?;
        }
        Ok(json!({ "adapter": "opencode", "removed": file.to_string_lossy() }))
    }

    fn config_status(&self, _app_data: &std::path::Path) -> AppResult<Value> {
        let file = plugin_file();
        let installed = file.exists()
            && std::fs::read_to_string(&file)
                .map(|c| c.contains("Task Dock") || c.contains(PLUGIN_MARKER))
                .unwrap_or(false);
        Ok(
            json!({ "adapter": "opencode", "plugin_installed": installed, "plugin_file": file.to_string_lossy() }),
        )
    }
}

/// 轻量 HTTP POST（仅用于本机回环自测；无外部依赖）。
pub fn reqwest_like_post(url: &str, token: &str, body: &Value) -> Result<u16, String> {
    use std::io::Write;
    let payload = body.to_string();
    let addr = url
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let host_port = addr.split('/').next().unwrap_or("");
    let (host, port_str) = host_port.split_once(':').ok_or("bad url")?;
    let port: u16 = port_str
        .parse::<u16>()
        .map_err(|e: std::num::ParseIntError| e.to_string())?;
    let stream =
        std::net::TcpStream::connect((host, port)).map_err(|e| format!("connect: {}", e))?;
    let mut stream = stream;
    let path = addr
        .strip_prefix(host_port)
        .filter(|p| !p.is_empty())
        .unwrap_or("/");
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path, host, token, payload.len(), payload
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {}", e))?;
    let mut buf = String::new();
    use std::io::Read;
    let _ = stream.read_to_string(&mut buf);
    buf.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| "no status".to_string())
}
