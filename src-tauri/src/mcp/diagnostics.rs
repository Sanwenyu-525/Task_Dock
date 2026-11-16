//! MCP 连接诊断：真实执行，不把「开关已打开」当成「连接可用」。
//!
//! 每一步都可复核，并明确区分四种结果：
//! - `ok`：真实执行且通过；
//! - `failed`：真实执行且失败（附原因与修复建议）；
//! - `not_run`：前置条件不满足，未执行（例如服务未启用）；
//! - `unverified`：环境无法验证（例如没有明文 Agent token，不能代替客户端握手）。
//!
//! 诊断不会修改任何状态，也不读取/回显 Agent token 明文。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;

use crate::db::Db;
use crate::error::AppResult;
use crate::mcp::bridge::McpRuntimeStatus;
use crate::mcp::{transport_path, McpTransport};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStep {
    pub id: &'static str,
    pub label: &'static str,
    /// ok | failed | not_run | unverified
    pub status: &'static str,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub generated_at: String,
    /// ok | degraded | failed | not_run
    pub overall: &'static str,
    pub steps: Vec<DiagnosticStep>,
    pub tool_count: usize,
    pub original_tool_count: usize,
}

fn step(
    id: &'static str,
    label: &'static str,
    status: &'static str,
    detail: impl Into<String>,
    hint: Option<&str>,
) -> DiagnosticStep {
    DiagnosticStep {
        id,
        label,
        status,
        detail: detail.into(),
        hint: hint.map(str::to_string),
    }
}

fn read_enabled(conn: &Connection) -> AppResult<bool> {
    let raw: Option<String> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT value FROM application_settings WHERE key = 'mcp_server_enabled'",
        [],
        |r| r.get(0),
    ))
    .map_err(crate::error::AppError::from)?;
    Ok(raw
        .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// 直接连 loopback 并发送 `initialize`（**不带** Agent token）。
/// 期望：HTTP 200 + JSON-RPC 响应（缺少凭据时返回鉴权错误），证明 bridge 已到达
/// 协议/鉴权层；这比裸 TCP connect 更能说明「服务真的在工作」。
fn probe_bridge(port: u16, bridge_token: &str) -> Result<(u16, String), String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1200))
        .map_err(|e| format!("连接 127.0.0.1:{port} 失败: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("设置读超时失败: {e}"))?;
    let body = r#"{"jsonrpc":"2.0","id":"diagnostics","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"taskdock-diagnostics","version":"0"}}}"#;
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Authorization: Bearer {bridge_token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("发送诊断请求失败: {e}"))?;
    let mut buffer = String::new();
    stream
        .read_to_string(&mut buffer)
        .map_err(|e| format!("读取诊断响应失败: {e}"))?;
    let (head, response_body) = buffer
        .split_once("\r\n\r\n")
        .ok_or_else(|| "bridge 响应缺少 HTTP 头分隔符".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "无法解析 HTTP 状态码".to_string())?;
    Ok((status, response_body.to_string()))
}

fn check_tools() -> Vec<DiagnosticStep> {
    let defs = crate::mcp::tools::tool_defs();
    let mut names = std::collections::HashSet::new();
    let mut duplicates = Vec::new();
    let mut bad_schema = Vec::new();
    for def in defs {
        if !names.insert(def.name) {
            duplicates.push(def.name);
        }
        if !def.input_schema.is_object() || def.input_schema["type"] != "object" {
            bad_schema.push(def.name);
        }
    }
    let mut steps = Vec::new();
    if duplicates.is_empty() && bad_schema.is_empty() {
        steps.push(step(
            "tool_registry",
            "工具注册表",
            "ok",
            format!("共 {} 个工具，名称唯一、Schema 均为 object", defs.len()),
            None,
        ));
    } else {
        steps.push(step(
            "tool_registry",
            "工具注册表",
            "failed",
            format!("重复名称: {duplicates:?}；Schema 异常: {bad_schema:?}"),
            Some("检查 tools.rs 与各 *_tools.rs 的 defs()"),
        ));
    }
    steps
}

fn check_database(conn: &Connection) -> Vec<DiagnosticStep> {
    let quick: Result<String, _> = conn.query_row("PRAGMA quick_check", [], |r| r.get(0));
    let agents: Result<i64, _> =
        conn.query_row("SELECT COUNT(*) FROM mcp_agents", [], |r| r.get(0));
    let mut steps = Vec::new();
    match (quick, agents) {
        (Ok(quick), Ok(count)) if quick == "ok" => steps.push(step(
            "database",
            "数据库",
            "ok",
            format!("quick_check=ok；已登记 Agent {count} 个"),
            None,
        )),
        (Ok(quick), Ok(count)) => steps.push(step(
            "database",
            "数据库",
            "failed",
            format!("quick_check={quick}；已登记 Agent {count} 个"),
            Some("备份数据库后运行完整性检查，见 docs/ARCHITECTURE.md"),
        )),
        (Err(e), _) => steps.push(step(
            "database",
            "数据库",
            "failed",
            format!("数据库完整性检查失败: {e}"),
            Some("确认数据目录可写、磁盘未满"),
        )),
        (Ok(_), Err(e)) => steps.push(step(
            "database",
            "数据库",
            "failed",
            format!("读取 Agent 表失败: {e}"),
            Some("数据库迁移可能未完成，重启应用后重试"),
        )),
    }
    steps
}

fn check_agent(conn: &Connection, agent_id: &str) -> DiagnosticStep {
    let row: Result<Option<(String, String, Option<String>)>, _> =
        rusqlite::OptionalExtension::optional(conn.query_row(
            "SELECT agent_id, scope, revoked_at FROM mcp_agents WHERE id = ?1",
            rusqlite::params![agent_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ));
    match row {
        Ok(Some((id, scope, revoked_at))) => {
            if revoked_at.is_some() {
                return step(
                    "agent_identity",
                    "Agent 身份",
                    "failed",
                    format!("Agent {id}（scope={scope}）已撤销，所有调用都会被拒绝"),
                    Some("如需继续使用，请创建新 Agent 或轮换 token 后重新启用"),
                );
            }
            let caps: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mcp_agent_capabilities WHERE agent_row_id = ?1",
                    rusqlite::params![agent_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let roots: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mcp_workspace_roots WHERE agent_row_id = ?1",
                    rusqlite::params![agent_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            step(
                "agent_identity",
                "Agent 身份",
                "ok",
                format!(
                    "Agent {id}（scope={scope}）有效；资源能力 {caps} 条，工作区根目录 {roots} 个"
                ),
                Some("token 明文无法从库中恢复；如需验证真实调用，请在实际客户端发起 tools/list"),
            )
        }
        Ok(None) => step(
            "agent_identity",
            "Agent 身份",
            "failed",
            format!("Agent 记录不存在: {agent_id}"),
            Some("先在 Agent 管理中创建或选择正确的 Agent"),
        ),
        Err(e) => step(
            "agent_identity",
            "Agent 身份",
            "failed",
            format!("查询 Agent 失败: {e}"),
            None,
        ),
    }
}

pub fn run(
    db: &Db,
    runtime: &McpRuntimeStatus,
    app_data: &Path,
    agent_id: Option<&str>,
) -> AppResult<DiagnosticsReport> {
    let mut steps = Vec::new();
    let enabled = db.with_read(read_enabled)?;
    steps.push(if enabled {
        step(
            "setting_enabled",
            "服务开关",
            "ok",
            "mcp_server_enabled = true",
            None,
        )
    } else {
        step(
            "setting_enabled",
            "服务开关",
            "failed",
            "mcp_server_enabled = false，服务不会启动",
            Some("在设置 → Agent 接入中启用 MCP Server"),
        )
    });

    let (running, port) = runtime.snapshot();
    steps.push(match (running, port) {
        (true, Some(port)) => step(
            "service_runtime",
            "服务运行状态",
            "ok",
            format!("bridge 正在监听 127.0.0.1:{port}"),
            None,
        ),
        (true, None) => step(
            "service_runtime",
            "服务运行状态",
            "failed",
            "运行标记为 true 但没有端口",
            Some("查看日志中的 bridge 启动失败原因后重启应用"),
        ),
        _ => step(
            "service_runtime",
            "服务运行状态",
            if enabled { "failed" } else { "not_run" },
            "bridge 未运行",
            Some("确认开关已启用；若刚切换开关，等待适配器完成重启"),
        ),
    });

    let transport = transport_path(app_data);
    let parsed: Result<McpTransport, _> =
        std::fs::read_to_string(&transport)
            .map_err(|e| e.to_string())
            .and_then(|body| serde_json::from_str(&body).map_err(|e| e.to_string()));
    match &parsed {
        Ok(cfg) => {
            if !cfg.enabled {
                steps.push(step(
                    "transport_file",
                    "stdio 传输文件",
                    "failed",
                    format!("{} 存在但 enabled=false", transport.display()),
                    Some("切换服务开关会重写该文件；若持续为 false，检查适配器是否运行"),
                ));
            } else if cfg.port == 0 || cfg.token.is_empty() {
                steps.push(step(
                    "transport_file",
                    "stdio 传输文件",
                    "failed",
                    "传输文件缺少端口或 bridge token",
                    Some("重启 Task Dock 以重新生成传输文件"),
                ));
            } else {
                steps.push(step(
                    "transport_file",
                    "stdio 传输文件",
                    "ok",
                    format!("{}：enabled，port={}", transport.display(), cfg.port),
                    None,
                ));
            }
        }
        Err(e) => steps.push(step(
            "transport_file",
            "stdio 传输文件",
            if enabled { "failed" } else { "not_run" },
            format!("{} 不可用: {e}", transport.display()),
            Some("确认应用数据目录可写；服务启用后会原子写入该文件"),
        )),
    }

    if let Ok(cfg) = &parsed {
        if cfg.enabled && cfg.port > 0 && !cfg.token.is_empty() {
            match probe_bridge(cfg.port, &cfg.token) {
                Ok((status, body)) => {
                    let looks_json = body.trim_start().starts_with('{');
                    if status == 200 && looks_json {
                        let unauthorized = body.contains("-32001");
                        steps.push(step(
                            "bridge_http",
                            "本机通信",
                            "ok",
                            format!(
                                "HTTP 200 + JSON-RPC 响应（未携带 Agent token，鉴权层{}）",
                                if unauthorized { "按预期拒绝" } else { "已进入协议处理" }
                            ),
                            None,
                        ));
                    } else {
                        steps.push(step(
                            "bridge_http",
                            "本机通信",
                            "failed",
                            format!("HTTP {status}，响应不是 JSON-RPC: {}", truncate(&body, 160)),
                            Some("检查 bridge 端口是否被其他程序占用，或查看应用日志"),
                        ));
                    }
                }
                Err(e) => steps.push(step(
                    "bridge_http",
                    "本机通信",
                    "failed",
                    e,
                    Some("确认 127.0.0.1 可连通、防火墙未阻止本机回环"),
                )),
            }
        } else {
            steps.push(step(
                "bridge_http",
                "本机通信",
                "not_run",
                "传输文件未就绪，未执行 HTTP 探测",
                None,
            ));
        }
    } else {
        steps.push(step(
            "bridge_http",
            "本机通信",
            "not_run",
            "传输文件不可读，未执行 HTTP 探测",
            None,
        ));
    }

    steps.extend(check_tools());
    steps.extend(db.with_read(|conn| Ok(check_database(conn)))?);

    steps.push(match agent_id {
        Some(id) if !id.trim().is_empty() => db.with_read(|conn| Ok(check_agent(conn, id)))?,
        _ => step(
            "agent_identity",
            "Agent 身份",
            "not_run",
            "未选择 Agent，跳过凭据状态检查",
            Some("在 Agent 管理中选择一个身份后重新诊断"),
        ),
    });

    let overall = if steps.iter().any(|s| s.status == "failed") {
        if steps.iter().any(|s| s.status == "ok") {
            "degraded"
        } else {
            "failed"
        }
    } else if steps.iter().all(|s| s.status == "not_run") {
        "not_run"
    } else {
        "ok"
    };

    let tool_count = crate::mcp::tools::tool_defs().len();
    let original_tool_count = 18;
    Ok(DiagnosticsReport {
        generated_at: crate::agents::now_iso(),
        overall,
        steps,
        tool_count,
        original_tool_count,
    })
}

fn truncate(raw: &str, max: usize) -> String {
    let mut chars = raw.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_registry_check_passes_for_current_defs() {
        let steps = check_tools();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].status, "ok");
    }

    #[test]
    fn bridge_probe_rejects_closed_port_without_panicking() {
        // 端口 9 (discard) 在测试机上通常没有监听；只验证失败被包装成可读错误。
        let result = probe_bridge(9, "token");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("失败"));
    }
}
