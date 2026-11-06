//! MCP 最小协议子集（手写，不引入 SDK）：JSON-RPC 2.0 封套 + stdio 运行器。
//!
//! 协议覆盖（够用即可，理由见交付报告「为何不引入 rmcp SDK」）：
//! - `initialize`：协议版本协商（支持 2024-11-05 / 2025-06-18，未知版本回退）
//! - `notifications/initialized` 等通知：静默接收，不回包
//! - `ping`：返回 `{}`
//! - `tools/list`：返回 18 个工具定义
//! - `tools/call`：经 bridge 鉴权执行；业务失败以 `isError:true` 的 result 返回
//!   （MCP 约定），身份/授权失败以 JSON-RPC error 返回（见错误码）。
//!
//! stdio 运行器（`--mcp-server` 子命令）每行一个 JSON-RPC 消息，把请求原样
//! POST 到 loopback bridge 并把响应原样写回 stdout。Task Dock 未运行 / 未启用
//! MCP / 连接失败时，对每个带 id 的请求返回明确的 -32000 错误，绝不挂死，
//! 也绝不降级为无认证。

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::mcp::bridge;

// ── JSON-RPC / MCP 错误码 ────────────────────────────────────────────

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
/// Task Dock 未运行 / MCP 未启用 / bridge 连接失败（可重试）
pub const ERR_SERVER_UNAVAILABLE: i64 = -32000;
/// agent token 缺失 / 不被识别 / 已撤销
pub const ERR_UNAUTHORIZED: i64 = -32001;
/// scope 或项目授权不足
pub const ERR_FORBIDDEN: i64 = -32002;

/// 支持的 MCP 协议版本（客户端传入其它版本时回退到最老支持版）。
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-06-18"];

pub fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error(id: Value, code: i64, message: &str) -> Value {
    error_with_data(id, code, message, Value::Null)
}

pub fn error_with_data(id: Value, code: i64, message: &str, data: Value) -> Value {
    let mut err = json!({ "code": code, "message": message });
    if !data.is_null() {
        err["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": err })
}

fn negotiated_version(client: &str) -> &'static str {
    for v in SUPPORTED_PROTOCOL_VERSIONS {
        if *v == client {
            return v;
        }
    }
    "2024-11-05"
}

/// 单个已解析请求 → 响应 Value；通知（无 id 字段）返回 None。
/// `call_tool` 由调用方注入：bridge 进程内接鉴权+审计+工具执行；
/// 测试可注入桩实现。
pub fn handle_request_value(
    body: &Value,
    call_tool: &dyn Fn(&str, &Value) -> Result<Value, bridge::ToolRpcError>,
) -> Option<Value> {
    let obj = match body.as_object() {
        Some(o) => o,
        None => return Some(error(Value::Null, INVALID_REQUEST, "请求必须是 JSON 对象")),
    };
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    let method = obj.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = obj.get("params").cloned().unwrap_or(json!({}));

    if method.starts_with("notifications/") {
        // 通知：按 spec 不回包（连错误也不回）
        return None;
    }
    match method {
        "initialize" => {
            let client_version = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Some(success(
                id,
                json!({
                    "protocolVersion": negotiated_version(client_version),
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "task-dock",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "instructions": "Task Dock 规划中心：list/get 工具只读；写工具需要项目授权并强制 expected_revision 乐观并发。",
                }),
            ))
        }
        "ping" => Some(success(id, json!({}))),
        "tools/list" => {
            let tools: Vec<Value> = crate::mcp::tools::tool_defs()
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.input_schema,
                    })
                })
                .collect();
            Some(success(id, json!({ "tools": tools })))
        }
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Some(match call_tool(name, &args) {
                Ok(result) => success(id, result),
                Err(e) => error_with_data(id, e.code, &e.message, e.data),
            })
        }
        "" => Some(error(id, INVALID_REQUEST, "缺少 method")),
        other => Some(error(
            id,
            METHOD_NOT_FOUND,
            &format!("不支持的方法: {other}"),
        )),
    }
}

// ── stdio 运行器（--mcp-server 子命令）────────────────────────────

/// 传输层失败 → JSON-RPC 错误封套。
fn unavailable(id: &Value, detail: &str) -> Value {
    error_with_data(
        id.clone(),
        ERR_SERVER_UNAVAILABLE,
        &format!("Task Dock MCP 服务不可用（{detail}）。请确认 Task Dock 正在运行且已在设置中启用 MCP Server。"),
        json!({ "retryable": true }),
    )
}

/// 提取请求 id 与「是否响应」判定：解析失败 → id=null（回 parse error）；
/// 解析成功但无 id 字段 → 通知（不回包）。
fn classify(line: &str) -> (Value, bool) {
    match serde_json::from_str::<Value>(line) {
        Ok(v) => {
            let is_notification = !v.as_object().map(|o| o.contains_key("id")).unwrap_or(false);
            let id = v.get("id").cloned().unwrap_or(Value::Null);
            (id, is_notification)
        }
        Err(_) => (Value::Null, false),
    }
}

fn answer(line: &str, out: &mut impl Write) -> std::io::Result<()> {
    let (id, is_notification) = classify(line);
    if serde_json::from_str::<Value>(line).is_err() {
        // 无法解析：无法判断是否通知，按 spec 回 id=null 的 parse error
        return writeln!(out, "{}", error(Value::Null, PARSE_ERROR, "invalid JSON"));
    }
    if is_notification {
        // 通知不回包；bridge 侧失败也保持静默（状态同步非关键路径）
        let _ = bridge::post_json(line);
        return Ok(());
    }
    let body = match bridge::post_json(line) {
        Ok(resp) => resp,
        Err(bridge::TransportFailure::Unreachable(detail)) => unavailable(&id, &detail).to_string(),
        Err(bridge::TransportFailure::Rejected { code: _, detail }) => {
            unavailable(&id, &detail).to_string()
        }
    };
    writeln!(out, "{body}")
}

/// `taskdock.exe --mcp-server` 入口：逐行读 stdin，转发 loopback，写 stdout。
/// stdin EOF 或 stdout 写失败时退出；bridge 不可用只影响单个请求的应答，
/// 绝不挂死、绝不退出非零中断宿主 Agent。
pub fn run_stdio() -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        match line {
            Ok(line) => {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                if answer(&line, &mut out).is_err() {
                    return 0;
                }
                let _ = out.flush();
            }
            Err(_) => return 0,
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn negotiated_version_falls_back_for_unknown() {
        assert_eq!(negotiated_version("2025-06-18"), "2025-06-18");
        assert_eq!(negotiated_version("2024-11-05"), "2024-11-05");
        assert_eq!(negotiated_version("1999-01-01"), "2024-11-05");
        assert_eq!(negotiated_version(""), "2024-11-05");
    }

    #[test]
    fn notifications_never_answer() {
        let payload = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        assert!(
            handle_request_value(&payload, &|_, _| unreachable!("通知不得进入工具层")).is_none()
        );
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let payload = json!({"jsonrpc":"2.0","id":7,"method":"resources/list"});
        let resp = handle_request_value(&payload, &|_, _| unreachable!()).unwrap();
        assert_eq!(resp["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(resp["id"], 7);
    }

    #[test]
    fn initialize_echoes_supported_version() {
        let payload = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}});
        let resp = handle_request_value(&payload, &|_, _| unreachable!()).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(resp["result"]["serverInfo"]["name"], "task-dock");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn tools_list_exposes_all_defs() {
        let payload = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        let resp = handle_request_value(&payload, &|_, _| unreachable!()).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 18, "应暴露全部 18 个工具");
        assert!(tools.iter().all(|t| t["inputSchema"].is_object()));
    }
}
