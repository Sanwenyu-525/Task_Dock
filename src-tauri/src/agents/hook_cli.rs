//! 原生 Hook 上报 CLI（`task-dock --agent-hook --source <id> --event <Event>`）。
//!
//! 替代每个事件启动一次 PowerShell 的旧方案：PowerShell 冷启动约 300ms+，
//! 原生进程约 10ms。协议与旧脚本完全一致：
//! 1. 从 stdin 读取 Agent 的 Hook 载荷（只取会话 ID / 标题等元数据）；
//! 2. 优先 POST 本地 HTTP 接入端点；
//! 3. HTTP 不可用（未启动 / 超时 / 503）→ 原子写入文件投递目录（同一 event_id，
//!    服务端按 event_id 幂等，跨通道重复不会产生双份状态）。
//!
//! 任何失败都静默退出 0：Hook 是旁路观测，绝不能阻塞或中断第三方 Agent。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use sha2::Digest;

use crate::agents::inbox;
use crate::error::AppResult;

/// 传输参数文件（由主程序写入；与端口/令牌/启停同步）。
pub const TRANSPORT_FILE: &str = "hook-transport.json";
const MAX_STDIN_BYTES: u64 = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(700);
const IO_TIMEOUT: Duration = Duration::from_millis(1200);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HookTransport {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// 与 Tauri `app_data_dir()` 一致：%APPDATA%\com.taskdock.desktop；
/// 测试/便携模式（TASK_DOCK_DATA_DIR）下与主程序使用同一隔离目录。
pub fn app_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    std::env::var("APPDATA")
        .map(|a| PathBuf::from(a).join("com.taskdock.desktop"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn transport_path(app_data: &Path) -> PathBuf {
    app_data.join(TRANSPORT_FILE)
}

/// 主程序启动与设置变更时调用；原子替换，读到的永远是完整 JSON。
pub fn write_transport_config(
    app_data: &Path,
    port: u16,
    token: &str,
    enabled: bool,
) -> AppResult<()> {
    std::fs::create_dir_all(app_data)?;
    let path = transport_path(app_data);
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_string(&HookTransport {
        enabled,
        port,
        token: token.to_string(),
    })?;
    std::fs::write(&tmp, body)?;
    if std::fs::rename(&tmp, &path).is_err() {
        // Windows 上 rename 不覆盖既有文件
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&tmp, &path)?;
    }
    Ok(())
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned();
        }
    }
    None
}

/// Hook 事件 → 统一状态。保守映射：无法确认结束的工具事件按 running 处理；
/// Subagent 事件不单独上报（避免把子任务状态混入主轮次）。
pub fn map_event_state(event: &str) -> Option<&'static str> {
    if event.contains("Subagent") {
        return None;
    }
    let state = match event {
        "PermissionRequest" | "Notification" => "waiting",
        "Stop" | "SessionEnd" => "completed",
        "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact"
        | "PostCompact" => "running",
        _ => "running",
    };
    Some(state)
}

fn session_id_of(payload: &Value, source: &str) -> String {
    for key in [
        "session_id",
        "sessionId",
        "thread_id",
        "conversation_id",
        "conversationId",
    ] {
        if let Some(v) = payload.get(key).and_then(|v| v.as_str()) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    format!("{}-unknown-session", source)
}

fn title_of(payload: &Value) -> String {
    for key in ["task_title", "title", "prompt_title"] {
        if let Some(v) = payload.get(key).and_then(|v| v.as_str()) {
            let t: String = v.trim().chars().take(120).collect();
            if !t.is_empty() {
                return t;
            }
        }
    }
    String::new()
}

fn build_event(source: &str, event: &str, payload: &Value, occurred_at: &str) -> Option<Value> {
    let state = map_event_state(event)?;
    let session = session_id_of(payload, source);
    let mut hasher = sha2::Sha256::new();
    hasher.update(format!("{}|{}|{}|{}", source, event, session, occurred_at).as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    let event_id = format!("hook-{}", &hex[..40]);
    Some(serde_json::json!({
        "schema_version": 1,
        "event_id": event_id,
        "source_id": source,
        "session_id": session,
        "state": state,
        "task_title": title_of(payload),
        "message": format!("hook: {}", event),
        "occurred_at": occurred_at,
        "transport": "hook",
        "evidence_type": "observed",
    }))
}

fn read_stdin() -> String {
    let mut raw = String::new();
    let _ = std::io::stdin()
        .take(MAX_STDIN_BYTES)
        .read_to_string(&mut raw);
    raw
}

/// 最小 HTTP/1.1 POST（仅回环，无外部依赖）；只有 2xx 视为已交付。
fn post_event(cfg: &HookTransport, body: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let req = format!(
        "POST /api/v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        cfg.token,
        body.len(),
        body
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .map(|s| (200..300).contains(&s))
        .unwrap_or(false)
}

/// 文件回退：与扫描器共用容量预留（总数/总字节/单文件/关键预留），
/// 先写 `.tmp` 再改名，文件投递只认 `.json`，不会读到半写文件。
fn write_fallback_in(dir: &Path, body: &str, critical: bool) -> bool {
    let mut last_error = String::new();
    let mut attempts = 0u64;
    // 并发 Hook 下锁竞争与 Windows 瞬时共享冲突（杀毒/索引）可能让单次写入失败；
    // 有界重试，失败原因仍写入有界日志，绝不谎报成功。
    for attempt in 0..3u64 {
        attempts += 1;
        let name = format!(
            "hook-{}-{}.json",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        match inbox::write_reserved(
            dir,
            &name,
            body.as_bytes(),
            critical,
            inbox::QuotaLimits::default(),
        ) {
            Ok(_) => return true,
            Err(e @ (inbox::ReserveError::LockTimeout | inbox::ReserveError::Io(_))) => {
                last_error = e.to_string();
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(20 * (attempt + 1) * (attempt + 1)));
                }
            }
            Err(e) => {
                last_error = e.to_string();
                break;
            }
        }
    }
    // Hook 必须静默，但失败原因要留在有界日志里，便于诊断「关键事件为何没进来」。
    inbox::record_failure(
        dir,
        &format!("hook fallback: {}（尝试 {} 次）", last_error, attempts),
    );
    false
}

/// CLI 入口；始终返回 0（Hook 失败不改变 Agent 行为）。
pub fn run(args: &[String]) -> i32 {
    let (Some(source), Some(event)) = (arg_value(args, "--source"), arg_value(args, "--event"))
    else {
        return 0;
    };
    let payload: Value = serde_json::from_str(&read_stdin()).unwrap_or(Value::Null);
    let occurred_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let Some(body) = build_event(&source, &event, &payload, &occurred_at) else {
        return 0;
    };
    let text = body.to_string();
    let cfg = std::fs::read_to_string(transport_path(&app_data_dir()))
        .ok()
        .and_then(|raw| serde_json::from_str::<HookTransport>(&raw).ok());
    if let Some(cfg) = cfg {
        if cfg.enabled && post_event(&cfg, &text) {
            return 0;
        }
    }
    let critical = map_event_state(&event) != Some("running");
    write_fallback_in(&app_data_dir().join("agent-inbox"), &text, critical);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_events_conservatively() {
        assert_eq!(map_event_state("PermissionRequest"), Some("waiting"));
        assert_eq!(map_event_state("Stop"), Some("completed"));
        assert_eq!(map_event_state("PreToolUse"), Some("running"));
        assert_eq!(map_event_state("UnknownThing"), Some("running"));
        assert_eq!(map_event_state("SubagentStop"), None);
    }

    #[test]
    fn builds_stable_event_id_and_metadata() {
        let payload = json!({"session_id": "abc", "task_title": "  fix build  "});
        let a = build_event("codex", "Stop", &payload, "2026-01-01T00:00:00.000Z").unwrap();
        let b = build_event("codex", "Stop", &payload, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(a["event_id"], b["event_id"], "同一事件跨通道 ID 稳定");
        assert_eq!(a["session_id"], "abc");
        assert_eq!(a["state"], "completed");
        assert_eq!(a["task_title"], "fix build");
        assert_eq!(a["source_id"], "codex");
        let c = build_event("codex", "Stop", &payload, "2026-01-01T00:00:01.000Z").unwrap();
        assert_ne!(a["event_id"], c["event_id"], "不同时刻的事件不误合并");
    }

    #[test]
    fn unknown_session_falls_back() {
        let ev = build_event(
            "trae",
            "SessionStart",
            &json!({}),
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(ev["session_id"], "trae-unknown-session");
    }

    #[test]
    fn fallback_uses_shared_reservation_and_atomic_rename() {
        let dir = std::env::temp_dir().join(format!("td-hook-fallback-{}", uuid::Uuid::new_v4()));
        assert!(write_fallback_in(&dir, "{\"a\":1}", true));
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 1, "只应留下最终文件，不留 .tmp");
        assert!(names[0].starts_with("hook-") && names[0].ends_with(".json"));
        assert_eq!(
            std::fs::read_to_string(dir.join(&names[0])).unwrap(),
            "{\"a\":1}"
        );
        assert_eq!(inbox::measure(&dir).unwrap().files, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn transport_config_is_atomic_and_readable() {
        let dir = std::env::temp_dir().join(format!("td-hook-cli-{}", uuid::Uuid::new_v4()));
        write_transport_config(&dir, 47821, "tok", true).unwrap();
        let cfg: HookTransport =
            serde_json::from_str(&std::fs::read_to_string(transport_path(&dir)).unwrap()).unwrap();
        assert_eq!(cfg.port, 47821);
        assert!(cfg.enabled);
        assert_eq!(cfg.token, "tok");
        std::fs::remove_dir_all(&dir).ok();
    }
}
