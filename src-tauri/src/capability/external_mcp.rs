//! 外部 MCP Server 管理：TaskDock 作为 MCP **Client**（v1 仅 stdio）。
//!
//! 与 `src-tauri/src/mcp/`（TaskDock 作为 Server）严格区分：
//! - 本模块不注册任何对外工具，不触碰 Agent 身份/token；
//! - 连接与调用使用短生命周期子进程：initialize → 能力发现 / tools/call → 关闭；
//! - 超时强制 kill + wait，绝不留下孤儿进程；
//! - 环境变量值用 Windows DPAPI（当前用户）加密后落库，列表/日志只返回值掩码；
//! - 工具返回内容一律视为不可信数据，只回传展示。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{check_text, now_iso, truncate_chars};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// 现代协议发现阶段的独立超时：不响应的 Server 立即回退 legacy，不无限等待。
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_ARGS_JSON: usize = 64 * 1024;
const MAX_ENV_VALUE: usize = 4096;
const MAX_STDERR_LINES: usize = 20;
/// 列表分页上限（防恶意 Server 无限 nextCursor）。
const MAX_PAGES: usize = 64;
/// 现代 MCP 协议版本（server/discover + per-request metadata）。
const MODERN_PROTOCOL: &str = "2026-07-28";
/// 客户端 legacy 协商版本；Server 可以返回 2025-11-25 等兼容版本。
const LEGACY_PROTOCOL: &str = "2025-06-18";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolMode {
    Modern,
    Legacy,
}

// ── 类型 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntryInfo {
    pub key: String,
    /// 只表达是否已保存值；值本身永不返回。
    pub has_value: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// 兼容字段：等价于 `risk_level == "high"`。
    pub high_risk: bool,
    /// low | medium | high | unknown
    pub risk_level: String,
    /// 为什么危险（可展示给用户，不只显示 High Risk）。
    pub risk_reasons: Vec<String>,
    /// Server 声明的 ToolAnnotations；**不可信提示**，不是安全边界。
    pub annotations: Value,
    /// 用户是否已显式信任该 Server（`allow_high_risk`）。
    pub trusted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceInfo {
    pub uri: String,
    pub name: String,
    pub description: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptInfo {
    pub name: String,
    pub description: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvEntryInfo>,
    pub enabled: bool,
    pub allow_high_risk: bool,
    pub status: String,
    pub last_error: String,
    pub server_info: Value,
    pub tools: Vec<McpToolInfo>,
    pub resources: Vec<McpResourceInfo>,
    pub prompts: Vec<McpPromptInfo>,
    pub last_connected_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionReport {
    pub ok: bool,
    pub duration_ms: i64,
    pub protocol_version: String,
    pub server_info: Value,
    pub tools: Vec<McpToolInfo>,
    pub resources: Vec<McpResourceInfo>,
    pub prompts: Vec<McpPromptInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallReport {
    pub ok: bool,
    pub duration_ms: i64,
    pub is_error: bool,
    pub content: Value,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallRecord {
    pub id: String,
    pub server_id: String,
    pub tool_name: String,
    pub success: bool,
    pub duration_ms: i64,
    pub error: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallPage {
    pub items: Vec<McpCallRecord>,
    pub total: i64,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntryInput {
    pub key: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvEntryInput>,
}

// ── DPAPI ─────────────────────────────────────────────────────────

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        )
    };
    if ok == 0 {
        return Err("DPAPI 加密失败，未保存环境变量".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out.pbData as _);
    }
    Ok(bytes)
}

#[cfg(windows)]
fn dpapi_unprotect(protected: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(
            "无法解密已保存的环境变量（可能由其他 Windows 用户或另一台机器写入）".into(),
        );
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out.pbData as _);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn dpapi_protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("外部 MCP 环境变量加密仅支持 Windows".into())
}

#[cfg(not(windows))]
fn dpapi_unprotect(_protected: &[u8]) -> Result<Vec<u8>, String> {
    Err("外部 MCP 环境变量加密仅支持 Windows".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEnv {
    key: String,
    /// `dpapi:<base64>`；保留字段名 value 以便旧数据迁移时识别。
    value: String,
}

fn encode_env(pairs: Vec<(String, String)>) -> AppResult<String> {
    use base64::Engine as _;
    let mut out = Vec::new();
    for (key, value) in pairs {
        if value.is_empty() {
            out.push(StoredEnv {
                key,
                value: String::new(),
            });
            continue;
        }
        let protected = dpapi_protect(value.as_bytes()).map_err(AppError::Validation)?;
        out.push(StoredEnv {
            key,
            value: format!(
                "dpapi:{}",
                base64::engine::general_purpose::STANDARD.encode(protected)
            ),
        });
    }
    Ok(serde_json::to_string(&out)?)
}

fn decode_env(raw: &str) -> AppResult<Vec<(String, String)>> {
    let stored: Vec<StoredEnv> = serde_json::from_str(raw).unwrap_or_default();
    let mut out = Vec::new();
    for item in stored {
        let Some(b64) = item.value.strip_prefix("dpapi:") else {
            if item.value.is_empty() {
                out.push((item.key, String::new()));
                continue;
            }
            return Err(AppError::Validation(format!(
                "环境变量 {} 不是受支持的加密格式，请重新保存该 Server",
                item.key
            )));
        };
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| AppError::Validation(format!("环境变量 {} 密文损坏", item.key)))?;
        let plain = dpapi_unprotect(&bytes).map_err(AppError::Validation)?;
        let value = String::from_utf8(plain)
            .map_err(|_| AppError::Validation(format!("环境变量 {} 不是 UTF-8 文本", item.key)))?;
        out.push((item.key, value));
    }
    Ok(out)
}

fn mask_env(raw: &str) -> Vec<EnvEntryInfo> {
    let stored: Vec<StoredEnv> = serde_json::from_str(raw).unwrap_or_default();
    stored
        .into_iter()
        .map(|item| EnvEntryInfo {
            has_value: !item.value.is_empty(),
            key: item.key,
        })
        .collect()
}

fn check_env_key(key: &str) -> AppResult<String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 64 {
        return Err(AppError::Validation("环境变量名长度必须为 1~64".into()));
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_')
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(AppError::Validation(format!(
            "环境变量名非法: {key}（只允许字母/数字/下划线，且不以数字开头）"
        )));
    }
    Ok(key.to_string())
}

// ── stdio 会话 ─────────────────────────────────────────────────────

struct Session {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    deadline: Instant,
    /// 当前阶段单次请求超时（连接阶段 / 调用阶段）。
    timeout: Duration,
    mode: ProtocolMode,
    protocol: String,
    next_id: i64,
}

impl Session {
    fn start(
        command: &str,
        args: &[String],
        env: &[(String, String)],
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut cmd: Command = crate::winproc::hidden(command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            cmd.env(key, value);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 MCP Server 失败: {e}"))?;
        let stdin = child.stdin.take().ok_or("无法写入 MCP Server 标准输入")?;
        let stdout = child.stdout.take().ok_or("无法读取 MCP Server 标准输出")?;
        let stderr = child.stderr.take().ok_or("无法读取 MCP Server 标准错误")?;

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let stderr_buf = Arc::new(Mutex::new(VecDeque::new()));
        let stderr_sink = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut buf = stderr_sink.lock().unwrap_or_else(|e| e.into_inner());
                if buf.len() >= MAX_STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(truncate_chars(&line, 300));
            }
        });

        Ok(Self {
            child,
            stdin,
            rx,
            stderr: stderr_buf,
            deadline: Instant::now() + timeout,
            timeout,
            mode: ProtocolMode::Legacy,
            protocol: String::new(),
            next_id: 1,
        })
    }

    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn send(&mut self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value).map_err(|e| format!("序列化请求失败: {e}"))?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("写入 MCP Server 失败: {e}"))
    }

    fn recv_for(&mut self, id: i64) -> Result<Value, String> {
        loop {
            let now = Instant::now();
            if now >= self.deadline {
                return Err(self.timeout_error());
            }
            let wait = self.deadline.saturating_duration_since(now);
            match self.rx.recv_timeout(wait) {
                Ok(line) => {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        // 某些 Server 会把日志写到 stdout：忽略非 JSON 行。
                        continue;
                    };
                    if value.get("method").is_some() && value.get("id").is_some() {
                        // Server → Client 请求：本客户端不支持，明确回错误避免对端等待。
                        let reply = json!({
                            "jsonrpc": "2.0",
                            "id": value.get("id").cloned().unwrap_or(Value::Null),
                            "error": { "code": -32601, "message": "TaskDock MCP Client 不支持该方法" }
                        });
                        let _ = self.send(&reply);
                        continue;
                    }
                    if value.get("id").and_then(Value::as_i64) == Some(id) {
                        return Ok(value);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(self.timeout_error()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let exit = self
                        .child
                        .try_wait()
                        .ok()
                        .flatten()
                        .and_then(|status| status.code());
                    return Err(self.exit_error(&format!(
                        "MCP Server 已关闭标准输出（exit={exit:?}）"
                    )));
                }
            }
        }
    }

    fn timeout_error(&self) -> String {
        let stderr = self.stderr_snapshot();
        if stderr.is_empty() {
            "MCP Server 响应超时".into()
        } else {
            format!("MCP Server 响应超时；stderr: {stderr}")
        }
    }

    fn exit_error(&self, prefix: &str) -> String {
        // 子进程可能刚退出、stderr 读取线程尚未把最后一行放进缓冲。
        std::thread::sleep(Duration::from_millis(80));
        let stderr = self.stderr_snapshot();
        if stderr.is_empty() {
            prefix.to_string()
        } else {
            format!("{prefix}；stderr: {stderr}")
        }
    }

    fn stderr_snapshot(&self) -> String {
        let buf = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        buf.iter().cloned().collect::<Vec<_>>().join(" | ")
    }

    fn request_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id();
        self.deadline = Instant::now() + timeout;
        let mut params = params;
        if self.mode == ProtocolMode::Modern {
            // 现代协议不使用 initialize 生命周期，改为每个请求携带客户端元数据。
            let meta = json!({
                "protocolVersion": MODERN_PROTOCOL,
                "clientInfo": { "name": "task-dock", "version": env!("CARGO_PKG_VERSION") }
            });
            match &mut params {
                Value::Object(map) => {
                    map.insert("_meta".into(), meta);
                }
                other => {
                    *other = json!({ "_meta": meta, "value": other.clone() });
                }
            }
        }
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;
        let response = self.recv_for(id)?;
        if let Some(error) = response.get("error") {
            return Err(jsonrpc_error_text(error));
        }
        Ok(response.get("result").cloned().unwrap_or(json!({})))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, self.timeout)
    }

    /// 协议协商：先 `server/discover`，支持 2026-07-28 走 modern；
    /// 不支持/不响应/方法不存在则回退 legacy `initialize`（有界等待，不无限挂起）。
    fn negotiate(&mut self) -> Result<(Value, String), String> {
        if let Ok(result) = self.request_with_timeout("server/discover", json!({}), DISCOVER_TIMEOUT) {
            if let Some(version) = modern_version(&result) {
                self.mode = ProtocolMode::Modern;
                self.protocol = version.clone();
                return Ok((
                    result.get("serverInfo").cloned().unwrap_or(json!({})),
                    version,
                ));
            }
        }
        self.mode = ProtocolMode::Legacy;
        let result = self.request(
            "initialize",
            json!({
                "protocolVersion": LEGACY_PROTOCOL,
                "capabilities": {},
                "clientInfo": { "name": "task-dock", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        let protocol = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(LEGACY_PROTOCOL)
            .to_string();
        self.protocol = protocol.clone();
        Ok((result, protocol))
    }

    /// 完整拉取分页列表（tools/resources/prompts 通用）。
    fn list_all(&mut self, method: &str, key: &str) -> Result<Vec<Value>, String> {
        let mut out: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        for page in 0..MAX_PAGES {
            let params = match &cursor {
                Some(value) => json!({ "cursor": value }),
                None => json!({}),
            };
            let result = match self.request(method, params) {
                Ok(value) => value,
                Err(error) if page == 0 && is_method_not_found(&error) => {
                    // 未实现该方法不是连接失败：按空能力处理。
                    return Ok(Vec::new());
                }
                Err(error) => return Err(error),
            };
            if let Some(items) = result.get(key).and_then(Value::as_array) {
                out.extend(items.iter().cloned());
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            if cursor.is_none() {
                return Ok(out);
            }
        }
        Err(format!("MCP pagination limit exceeded（{MAX_PAGES} 页）"))
    }
}

fn is_method_not_found(error: &str) -> bool {
    error.contains("-32601") || error.to_ascii_lowercase().contains("method not found")
}

fn modern_version(result: &Value) -> Option<String> {
    if result.get("protocolVersion").and_then(Value::as_str) == Some(MODERN_PROTOCOL) {
        return Some(MODERN_PROTOCOL.to_string());
    }
    for key in ["supportedVersions", "protocolVersions", "versions"] {
        if let Some(items) = result.get(key).and_then(Value::as_array) {
            if items.iter().any(|v| v.as_str() == Some(MODERN_PROTOCOL)) {
                return Some(MODERN_PROTOCOL.to_string());
            }
        }
    }
    None
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn jsonrpc_error_text(error: &Value) -> String {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("未知错误");
    truncate_chars(&format!("MCP 错误 {code}: {message}"), 400)
}

fn parse_tools(raw: Vec<Value>, trusted: bool) -> Vec<McpToolInfo> {
    raw.into_iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(Value::as_str)?.to_string();
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let input_schema = tool
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object" }));
            let annotations = tool.get("annotations").cloned().unwrap_or(Value::Null);
            let (risk_level, risk_reasons) = assess_tool_risk(&name, &description, &annotations);
            let high_risk = risk_level == "high";
            Some(McpToolInfo {
                name,
                description,
                input_schema,
                high_risk,
                risk_level,
                risk_reasons,
                annotations,
                trusted,
            })
        })
        .collect()
}

fn parse_resources(raw: Vec<Value>) -> Vec<McpResourceInfo> {
    raw.into_iter()
        .filter_map(|item| {
            let uri = item.get("uri").and_then(Value::as_str)?.to_string();
            Some(McpResourceInfo {
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                mime_type: item
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                uri,
            })
        })
        .collect()
}

fn parse_prompts(raw: Vec<Value>) -> Vec<McpPromptInfo> {
    raw.into_iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?.to_string();
            Some(McpPromptInfo {
                name,
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                arguments: item.get("arguments").cloned().unwrap_or(json!([])),
            })
        })
        .collect()
}

/// 工具风险分级（名称/描述静态分析 + ToolAnnotations + 用户信任策略）。
///
/// **annotations 是不可信 Server 的自述，不是安全边界**：
/// - `destructiveHint=true` 直接按 high；
/// - `readOnlyHint=true` 只有在没有静态危险信号时才降为 low；
/// - 没有 annotation 且名称/描述无信号的未知工具为 `unknown`，首次调用必须人工确认。
pub fn assess_tool_risk(
    name: &str,
    description: &str,
    annotations: &Value,
) -> (String, Vec<String>) {
    let text = format!("{} {}", name, description).to_ascii_lowercase();
    let mut reasons: Vec<String> = Vec::new();
    let mut high = false;
    let mut medium = false;

    let flag = |key: &str| annotations.get(key).and_then(Value::as_bool);
    if flag("destructiveHint") == Some(true) {
        high = true;
        reasons.push("annotations.destructiveHint=true（Server 声明可能破坏数据）".into());
    }
    let read_only = flag("readOnlyHint") == Some(true);
    if read_only {
        reasons.push("annotations.readOnlyHint=true（Server 自述，不能作为安全保证）".into());
    }
    if flag("idempotentHint") == Some(false) {
        medium = true;
        reasons.push("annotations.idempotentHint=false（重复调用可能产生副作用）".into());
    }
    if flag("openWorldHint") == Some(true) {
        medium = true;
        reasons.push("annotations.openWorldHint=true（可能访问外部世界）".into());
    }

    const HIGH_KEYWORDS: &[(&str, &str)] = &[
        ("delete", "名称/描述包含 delete"),
        ("remove", "名称/描述包含 remove"),
        ("drop", "名称/描述包含 drop"),
        ("kill", "名称/描述包含 kill"),
        ("exec", "名称/描述包含 exec"),
        ("shell", "名称/描述包含 shell"),
        ("spawn", "名称/描述包含 spawn"),
        ("run_", "名称/描述包含 run_"),
        ("write", "名称/描述包含 write"),
        ("format", "名称/描述包含 format"),
    ];
    const MEDIUM_KEYWORDS: &[(&str, &str)] = &[
        ("create", "名称/描述包含 create"),
        ("update", "名称/描述包含 update"),
        ("insert", "名称/描述包含 insert"),
        ("upload", "名称/描述包含 upload"),
        ("rename", "名称/描述包含 rename"),
        ("move", "名称/描述包含 move"),
        ("save", "名称/描述包含 save"),
        ("set_", "名称/描述包含 set_"),
        ("put_", "名称/描述包含 put_"),
        ("patch", "名称/描述包含 patch"),
    ];
    for (needle, reason) in HIGH_KEYWORDS {
        if text.contains(needle) {
            high = true;
            reasons.push((*reason).to_string());
        }
    }
    for (needle, reason) in MEDIUM_KEYWORDS {
        if text.contains(needle) {
            medium = true;
            reasons.push((*reason).to_string());
        }
    }

    let level = if high {
        "high"
    } else if medium {
        "medium"
    } else if read_only {
        "low"
    } else if annotations.is_null() {
        "unknown"
    } else {
        "medium"
    };
    (level.to_string(), reasons)
}

/// 兼容旧调用：只按名称/描述判断是否高风险。
pub fn is_high_risk(name: &str, description: &str) -> bool {
    assess_tool_risk(name, description, &Value::Null).0 == "high"
}

// ── 持久化 ─────────────────────────────────────────────────────────

const SERVER_COLUMNS: &str = "id, name, transport, command, args_json, env_json, enabled, \
    allow_high_risk, status, last_error, server_info_json, tools_json, resources_json, \
    prompts_json, last_connected_at, created_at, updated_at";

fn read_server(conn: &Connection, id: &str) -> AppResult<ExternalMcpServer> {
    let row = conn
        .query_row(
            &format!("SELECT {SERVER_COLUMNS} FROM external_mcp_servers WHERE id=?1"),
            [id],
            |r| {
                let args: Vec<String> =
                    serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default();
                let env_raw: String = r.get(5)?;
                let tools_raw: String = r.get(11)?;
                let resources_raw: String = r.get(12)?;
                let prompts_raw: String = r.get(13)?;
                let trusted = r.get::<_, i64>(7)? != 0;
                let tool_values: Vec<Value> = serde_json::from_str(&tools_raw).unwrap_or_default();
                let resource_values: Vec<Value> =
                    serde_json::from_str(&resources_raw).unwrap_or_default();
                let prompt_values: Vec<Value> = serde_json::from_str(&prompts_raw).unwrap_or_default();
                Ok(ExternalMcpServer {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    transport: r.get(2)?,
                    command: r.get(3)?,
                    args,
                    env: mask_env(&env_raw),
                    enabled: r.get::<_, i64>(6)? != 0,
                    allow_high_risk: trusted,
                    status: r.get(8)?,
                    last_error: r.get(9)?,
                    server_info: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or(json!({})),
                    tools: parse_tools(tool_values, trusted),
                    resources: parse_resources(resource_values),
                    prompts: parse_prompts(prompt_values),
                    last_connected_at: r.get(14)?,
                    created_at: r.get(15)?,
                    updated_at: r.get(16)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("外部 MCP Server 不存在: {id}")))?;
    Ok(row)
}

pub fn list_servers_impl(db: &Db) -> AppResult<Vec<ExternalMcpServer>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {SERVER_COLUMNS} FROM external_mcp_servers ORDER BY updated_at DESC, name"
        ))?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| read_server(conn, id))
            .collect::<AppResult<Vec<_>>>()
    })
}

/// 保存：环境变量值合并语义——输入值为空且键已存在时保留旧密文；
/// 配置变更（命令/参数/env）会清空旧能力快照，避免展示过期工具。
pub fn save_server_impl(db: &Db, input: McpServerInput) -> AppResult<ExternalMcpServer> {
    let name = check_text(&input.name, "Server 名称", 80)?;
    let command = check_text(&input.command, "启动命令", 1024)?;
    if input.args.len() > 32 {
        return Err(AppError::Validation("启动参数最多 32 个".into()));
    }
    for arg in &input.args {
        if arg.chars().count() > 512 || arg.contains('\0') {
            return Err(AppError::Validation("启动参数过长或含非法字符".into()));
        }
    }
    if input.env.len() > 32 {
        return Err(AppError::Validation("环境变量最多 32 个".into()));
    }
    let now = now_iso();
    db.with_conn(|conn| {
        let existing = match &input.id {
            Some(id) => Some(read_server(conn, id)?),
            None => None,
        };
        let old_env: Vec<(String, String)> = match &existing {
            Some(server) => {
                let raw: String = conn.query_row(
                    "SELECT env_json FROM external_mcp_servers WHERE id=?1",
                    [&server.id],
                    |r| r.get(0),
                )?;
                decode_env(&raw).unwrap_or_default()
            }
            None => Vec::new(),
        };
        let mut pairs: Vec<(String, String)> = Vec::new();
        for entry in &input.env {
            let key = check_env_key(&entry.key)?;
            if entry.value.chars().count() > MAX_ENV_VALUE {
                return Err(AppError::Validation(format!(
                    "环境变量 {key} 的值超过 {MAX_ENV_VALUE} 字符"
                )));
            }
            let value = if entry.value.is_empty() {
                old_env
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default()
            } else {
                entry.value.clone()
            };
            pairs.push((key, value));
        }
        let env_json = encode_env(pairs)?;
        let args_json = serde_json::to_string(&input.args)?;
        let config_changed = existing.as_ref().is_none_or(|server| {
            server.command != command
                || server.args != input.args
                || server.env.len() != input.env.len()
                || server.env.iter().any(|e| {
                    !input
                        .env
                        .iter()
                        .any(|i| i.key == e.key && !i.value.is_empty())
                })
        });
        if let Some(server) = &existing {
            conn.execute(
                "UPDATE external_mcp_servers SET name=?2, command=?3, args_json=?4, env_json=?5, \
                 status=CASE WHEN ?6 THEN 'unknown' ELSE status END, \
                 last_error=CASE WHEN ?6 THEN '' ELSE last_error END, \
                 tools_json=CASE WHEN ?6 THEN '[]' ELSE tools_json END, \
                 resources_json=CASE WHEN ?6 THEN '[]' ELSE resources_json END, \
                 prompts_json=CASE WHEN ?6 THEN '[]' ELSE prompts_json END, \
                 server_info_json=CASE WHEN ?6 THEN '{}' ELSE server_info_json END, \
                 updated_at=?7 WHERE id=?1",
                params![
                    server.id,
                    name,
                    command,
                    args_json,
                    env_json,
                    i64::from(config_changed),
                    now
                ],
            )?;
            read_server(conn, &server.id)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO external_mcp_servers(id,name,transport,command,args_json,env_json,enabled,allow_high_risk,status,last_error,server_info_json,tools_json,resources_json,prompts_json,last_connected_at,created_at,updated_at)
                 VALUES (?1,?2,'stdio',?3,?4,?5,1,0,'unknown','','{}','[]','[]','[]',NULL,?6,?6)",
                params![id, name, command, args_json, env_json, now],
            )?;
            read_server(conn, &id)
        }
    })
}

pub fn delete_server_impl(db: &Db, id: &str) -> AppResult<bool> {
    db.with_conn(|conn| {
        let n = conn.execute("DELETE FROM external_mcp_servers WHERE id=?1", [id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("外部 MCP Server 不存在: {id}")));
        }
        Ok(true)
    })
}

pub fn set_enabled_impl(db: &Db, id: &str, enabled: bool) -> AppResult<ExternalMcpServer> {
    db.with_conn(|conn| {
        read_server(conn, id)?;
        conn.execute(
            "UPDATE external_mcp_servers SET enabled=?2, status=?3, updated_at=?4 WHERE id=?1",
            params![
                id,
                i64::from(enabled),
                if enabled { "unknown" } else { "disabled" },
                now_iso()
            ],
        )?;
        read_server(conn, id)
    })
}

pub fn set_allow_high_risk_impl(db: &Db, id: &str, allow: bool) -> AppResult<ExternalMcpServer> {
    db.with_conn(|conn| {
        read_server(conn, id)?;
        conn.execute(
            "UPDATE external_mcp_servers SET allow_high_risk=?2, updated_at=?3 WHERE id=?1",
            params![id, i64::from(allow), now_iso()],
        )?;
        read_server(conn, id)
    })
}

fn connect_with_db(
    db: &Db,
    server: &ExternalMcpServer,
    connect_timeout: Duration,
) -> AppResult<(
    Session,
    Value,
    String,
    Vec<McpToolInfo>,
    Vec<McpResourceInfo>,
    Vec<McpPromptInfo>,
)> {
    if !server.enabled {
        return Err(AppError::Validation(
            "Server 已禁用；请先启用再测试连接".into(),
        ));
    }
    let env = db.with_read(|conn| {
        let raw: String = conn.query_row(
            "SELECT env_json FROM external_mcp_servers WHERE id=?1",
            [&server.id],
            |r| r.get(0),
        )?;
        decode_env(&raw)
    })?;
    let mut session = Session::start(&server.command, &server.args, &env, connect_timeout)
        .map_err(AppError::Validation)?;
    let (server_info, protocol) = session
        .negotiate()
        .map_err(|e| AppError::Validation(format!("MCP 初始化失败: {e}")))?;
    let tools_raw = session
        .list_all("tools/list", "tools")
        .map_err(|e| AppError::Validation(format!("读取工具列表失败: {e}")))?;
    let resources_raw = session
        .list_all("resources/list", "resources")
        .map_err(|e| AppError::Validation(format!("读取资源列表失败: {e}")))?;
    let prompts_raw = session
        .list_all("prompts/list", "prompts")
        .map_err(|e| AppError::Validation(format!("读取提示词列表失败: {e}")))?;
    Ok((
        session,
        server_info,
        protocol,
        parse_tools(tools_raw, server.allow_high_risk),
        parse_resources(resources_raw),
        parse_prompts(prompts_raw),
    ))
}

pub fn test_server_impl(db: &Db, id: &str) -> AppResult<McpConnectionReport> {
    test_server_with_timeout(db, id, CONNECT_TIMEOUT)
}

/// 测试专用入口：允许缩短连接超时（超时/强杀用例）。
pub fn test_server_with_timeout(
    db: &Db,
    id: &str,
    connect_timeout: Duration,
) -> AppResult<McpConnectionReport> {
    let started = Instant::now();
    let server = db.with_read(|conn| read_server(conn, id))?;
    let result = connect_with_db(db, &server, connect_timeout);
    let duration_ms = started.elapsed().as_millis() as i64;
    match result {
        Ok((session, server_info, protocol, tools, resources, prompts)) => {
            drop(session);
            let now = now_iso();
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE external_mcp_servers SET status='ok', last_error='', \
                     server_info_json=?2, tools_json=?3, resources_json=?4, prompts_json=?5, \
                     last_connected_at=?6, updated_at=?6 WHERE id=?1",
                    params![
                        id,
                        serde_json::to_string(&server_info)?,
                        serde_json::to_string(&tools)?,
                        serde_json::to_string(&resources)?,
                        serde_json::to_string(&prompts)?,
                        now
                    ],
                )?;
                Ok::<_, AppError>(())
            })?;
            Ok(McpConnectionReport {
                ok: true,
                duration_ms,
                protocol_version: protocol,
                server_info,
                tools,
                resources,
                prompts,
                error: None,
            })
        }
        Err(error) => {
            let message = truncate_chars(&error.to_string(), 500);
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE external_mcp_servers SET status='failed', last_error=?2, \
                     server_info_json='{}', tools_json='[]', resources_json='[]', \
                     prompts_json='[]', updated_at=?3 WHERE id=?1",
                    params![id, message, now_iso()],
                )?;
                Ok::<_, AppError>(())
            })?;
            Ok(McpConnectionReport {
                ok: false,
                duration_ms,
                protocol_version: String::new(),
                server_info: json!({}),
                tools: Vec::new(),
                resources: Vec::new(),
                prompts: Vec::new(),
                error: Some(message),
            })
        }
    }
}

/// 调用工具：每次新建短连接；高风险每次确认，未知/中风险首次确认，低风险直接执行。
pub fn call_tool_impl(
    db: &Db,
    id: &str,
    tool_name: &str,
    args_json: &str,
    confirmed: bool,
) -> AppResult<McpCallReport> {
    call_tool_with_timeout(db, id, tool_name, args_json, confirmed, CALL_TIMEOUT)
}

/// 测试专用入口：允许缩短调用超时（超时/强杀用例）。
pub fn call_tool_with_timeout(
    db: &Db,
    id: &str,
    tool_name: &str,
    args_json: &str,
    confirmed: bool,
    timeout: Duration,
) -> AppResult<McpCallReport> {
    let tool_name = check_text(tool_name, "工具名称", 200)?;
    if args_json.len() > MAX_ARGS_JSON {
        return Err(AppError::Validation(format!(
            "参数 JSON 超过 {} KiB",
            MAX_ARGS_JSON / 1024
        )));
    }
    let args: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_json)
            .map_err(|e| AppError::Validation(format!("参数不是合法 JSON: {e}")))?
    };
    if !args.is_object() {
        return Err(AppError::Validation("工具参数必须是 JSON 对象".into()));
    }
    let server = db.with_read(|conn| read_server(conn, id))?;
    let tool = server.tools.iter().find(|t| t.name == tool_name);
    let risk_level = tool
        .map(|t| t.risk_level.clone())
        .unwrap_or_else(|| assess_tool_risk(&tool_name, "", &Value::Null).0);
    let previously_confirmed: bool = db.with_read(|conn| {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM external_mcp_confirmed_tools WHERE server_id=?1 AND tool_name=?2",
            params![id, tool_name],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    })?;
    let needs_confirmation = match risk_level.as_str() {
        "high" => true,
        "medium" | "unknown" => !previously_confirmed,
        _ => false,
    };
    if needs_confirmation && !confirmed && !server.allow_high_risk {
        let reason = if risk_level == "high" {
            "该工具可能修改数据或执行命令，需要显式确认后再调用"
        } else {
            "该工具风险未知或可能产生副作用，首次调用需要显式确认"
        };
        return Err(AppError::Validation(reason.into()));
    }

    let started = Instant::now();
    let mut report = McpCallReport {
        ok: false,
        duration_ms: 0,
        is_error: false,
        content: Value::Null,
        error: None,
    };
    let call_result = (|| -> Result<Value, AppError> {
        let env = db.with_read(|conn| {
            let raw: String = conn.query_row(
                "SELECT env_json FROM external_mcp_servers WHERE id=?1",
                [id],
                |r| r.get(0),
            )?;
            decode_env(&raw)
        })?;
        let mut session = Session::start(&server.command, &server.args, &env, timeout)
            .map_err(AppError::Validation)?;
        session
            .negotiate()
            .map_err(|e| AppError::Validation(format!("MCP 初始化失败: {e}")))?;
        let result = session
            .request(
                "tools/call",
                json!({ "name": tool_name, "arguments": args }),
            )
            .map_err(|e| AppError::Validation(format!("工具调用失败: {e}")))?;
        drop(session);
        Ok(result)
    })();

    report.duration_ms = started.elapsed().as_millis() as i64;
    match call_result {
        Ok(result) => {
            report.ok = true;
            report.is_error = result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            report.content = result.get("content").cloned().unwrap_or(result);
            if !report.is_error {
                // 成功调用后才记录「首次确认」，失败不得消耗确认额度。
                let _ = db.with_conn(|conn| {
                    conn.execute(
                        "INSERT OR REPLACE INTO external_mcp_confirmed_tools(server_id,tool_name,confirmed_at) \
                         VALUES (?1,?2,?3)",
                        params![id, tool_name, now_iso()],
                    )?;
                    Ok::<_, AppError>(())
                });
            }
        }
        Err(error) => report.error = Some(truncate_chars(&error.to_string(), 500)),
    }

    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO external_mcp_calls(id,server_id,tool_name,success,duration_ms,error,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                uuid::Uuid::new_v4().to_string(),
                id,
                tool_name,
                i64::from(report.ok && !report.is_error),
                report.duration_ms,
                report.error.clone().unwrap_or_default(),
                now
            ],
        )?;
        let status = if report.error.is_some() { "failed" } else { "ok" };
        let last_error = report.error.clone().unwrap_or_default();
        conn.execute(
            "UPDATE external_mcp_servers SET status=?2, last_error=?3, updated_at=?4 WHERE id=?1",
            params![id, status, last_error, now],
        )?;
        Ok::<_, AppError>(())
    })?;
    Ok(report)
}

pub fn list_calls_impl(
    db: &Db,
    server_id: Option<&str>,
    offset: usize,
    limit: usize,
) -> AppResult<McpCallPage> {
    let limit = limit.clamp(1, 200);
    let server_id = server_id.map(str::trim).filter(|v| !v.is_empty());
    db.with_read(|conn| {
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM external_mcp_calls WHERE (?1 IS NULL OR server_id=?1)",
            params![server_id],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, server_id, tool_name, success, duration_ms, error, created_at \
             FROM external_mcp_calls WHERE (?1 IS NULL OR server_id=?1) \
             ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![server_id, limit as i64, offset as i64], |r| {
            Ok(McpCallRecord {
                id: r.get(0)?,
                server_id: r.get(1)?,
                tool_name: r.get(2)?,
                success: r.get::<_, i64>(3)? != 0,
                duration_ms: r.get(4)?,
                error: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        let items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = offset.saturating_add(items.len()) < total as usize;
        Ok(McpCallPage {
            items,
            total,
            offset,
            limit,
            has_more,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn server(db: &Db, command: &str) -> String {
        save_server_impl(
            db,
            McpServerInput {
                id: None,
                name: "fixture".into(),
                command: command.into(),
                args: Vec::new(),
                env: Vec::new(),
            },
        )
        .unwrap()
        .id
    }

    fn stdio_fixture(db: &Db, mode: &str, pid_file: Option<&Path>) -> String {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("mcp-server.mjs");
        let mut args = vec![script.to_string_lossy().to_string(), mode.to_string()];
        if let Some(path) = pid_file {
            args.push(path.to_string_lossy().to_string());
        }
        save_server_impl(
            db,
            McpServerInput {
                id: None,
                name: format!("fixture-{mode}"),
                command: "node".into(),
                args,
                env: Vec::new(),
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn high_risk_detection_covers_write_and_read() {
        assert!(is_high_risk("write_file", "写入文件"));
        assert!(is_high_risk("delete_rows", ""));
        assert!(is_high_risk("run_command", "执行命令"));
        assert!(!is_high_risk("search", "只读搜索"));
        assert!(!is_high_risk("list_projects", "列出项目"));
    }

    #[test]
    fn env_values_are_encrypted_and_masked() {
        let db = Db::open_in_memory().unwrap();
        let created = save_server_impl(
            &db,
            McpServerInput {
                id: None,
                name: "env".into(),
                command: "cmd".into(),
                args: vec!["/C".into(), "echo ok".into()],
                env: vec![EnvEntryInput {
                    key: "API_KEY".into(),
                    value: "secret-value".into(),
                }],
            },
        )
        .unwrap();
        assert_eq!(created.env.len(), 1);
        assert!(created.env[0].has_value);
        let raw: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT env_json FROM external_mcp_servers WHERE id=?1",
                    [&created.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(!raw.contains("secret-value"), "明文不得落库");
        let decrypted = decode_env(&raw).unwrap();
        assert_eq!(decrypted[0].1, "secret-value");
        // 掩码保存（空值）保留旧密文
        let updated = save_server_impl(
            &db,
            McpServerInput {
                id: Some(created.id.clone()),
                name: "env".into(),
                command: "cmd".into(),
                args: vec!["/C".into(), "echo ok".into()],
                env: vec![EnvEntryInput {
                    key: "API_KEY".into(),
                    value: String::new(),
                }],
            },
        )
        .unwrap();
        assert!(updated.env[0].has_value);
        let raw2: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT env_json FROM external_mcp_servers WHERE id=?1",
                    [&created.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(decode_env(&raw2).unwrap()[0].1, "secret-value");
    }

    #[test]
    fn missing_command_reports_failure_without_panicking() {
        let db = Db::open_in_memory().unwrap();
        let id = server(&db, "taskdock-definitely-not-a-command");
        let report = test_server_impl(&db, &id).unwrap();
        assert!(!report.ok);
        assert!(report.error.is_some());
        let saved: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT status FROM external_mcp_servers WHERE id=?1",
                    [&id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(saved, "failed");
    }

    #[test]
    fn call_requires_confirmation_for_high_risk_tools() {
        let db = Db::open_in_memory().unwrap();
        let id = server(&db, "cmd");
        // 没有已发现工具快照时，按名称判定为高风险。
        let err = call_tool_impl(&db, &id, "write_file", "{}", false).unwrap_err();
        assert!(err.to_string().contains("确认"));
        // 非法 JSON 在启动前被拒绝。
        assert!(call_tool_impl(&db, &id, "search", "{bad", true).is_err());
        // 非对象参数被拒绝。
        assert!(call_tool_impl(&db, &id, "search", "[]", true).is_err());
    }

    #[test]
    fn disabled_server_cannot_be_tested() {
        let db = Db::open_in_memory().unwrap();
        let id = server(&db, "cmd");
        set_enabled_impl(&db, &id, false).unwrap();
        let report = test_server_impl(&db, &id).unwrap();
        assert!(!report.ok);
        assert!(report.error.unwrap().contains("禁用"));
    }

    #[test]
    fn saved_args_survive_read_back() {
        let db = Db::open_in_memory().unwrap();
        let created = save_server_impl(
            &db,
            McpServerInput {
                id: None,
                name: "args".into(),
                command: "node".into(),
                args: vec!["server.mjs".into(), "modern".into(), "C:\\tmp\\pid".into()],
                env: Vec::new(),
            },
        )
        .unwrap();
        let listed = list_servers_impl(&db).unwrap();
        let found = listed.iter().find(|s| s.id == created.id).unwrap();
        assert_eq!(found.args, created.args);
        assert_eq!(found.args.len(), 3);
        assert_eq!(found.args[1], "modern");
    }

    #[test]
    fn modern_discovery_and_pagination() {
        let db = Db::open_in_memory().unwrap();
        let id = stdio_fixture(&db, "modern", None);
        let report = test_server_impl(&db, &id).unwrap();
        assert!(report.ok, "modern 连接失败: {:?}", report.error);
        assert_eq!(report.protocol_version, "2026-07-28");
        assert_eq!(report.tools.len(), 5, "tools 应跨两页完整拉取");
        assert_eq!(report.resources.len(), 2, "resources 应跨两页完整拉取");
        assert_eq!(report.prompts.len(), 1);

        let echo = report.tools.iter().find(|t| t.name == "echo").unwrap();
        assert_eq!(echo.risk_level, "low");
        assert!(echo.annotations.get("readOnlyHint").is_some());

        let search = report.tools.iter().find(|t| t.name == "search").unwrap();
        assert_eq!(search.risk_level, "unknown");

        let write = report.tools.iter().find(|t| t.name == "write_file").unwrap();
        assert_eq!(write.risk_level, "high");
        assert!(write.high_risk);
        assert!(write
            .risk_reasons
            .iter()
            .any(|reason| reason.contains("destructiveHint")));
    }

    #[test]
    fn legacy_server_falls_back_to_initialize() {
        let db = Db::open_in_memory().unwrap();
        let id = stdio_fixture(&db, "legacy", None);
        let report = test_server_impl(&db, &id).unwrap();
        assert!(report.ok, "legacy 连接失败: {:?}", report.error);
        assert_eq!(report.protocol_version, "2025-11-25");
        assert_eq!(report.tools.len(), 5);
    }

    #[test]
    fn pagination_limit_is_enforced() {
        let db = Db::open_in_memory().unwrap();
        let id = stdio_fixture(&db, "pagination_limit", None);
        let report = test_server_impl(&db, &id).unwrap();
        assert!(!report.ok);
        let error = report.error.unwrap_or_default();
        assert!(error.contains("pagination limit exceeded"), "{error}");
    }

    #[test]
    fn tool_call_confirmation_risk_and_errors() {
        let db = Db::open_in_memory().unwrap();
        let id = stdio_fixture(&db, "modern", None);
        assert!(test_server_impl(&db, &id).unwrap().ok);

        // 未知风险首次必须确认；确认成功后被记住。
        let err = call_tool_impl(&db, &id, "search", "{}", false).unwrap_err();
        assert!(err.to_string().contains("首次调用"), "{err}");
        assert!(call_tool_impl(&db, &id, "search", "{}", true).unwrap().ok);
        assert!(call_tool_impl(&db, &id, "search", "{}", false).unwrap().ok);

        // 高风险每次都要确认。
        let err = call_tool_impl(&db, &id, "write_file", "{}", false).unwrap_err();
        assert!(err.to_string().contains("确认"), "{err}");
        assert!(call_tool_impl(&db, &id, "write_file", "{}", true).unwrap().ok);

        // 非法 JSON 在启动前被拒绝。
        assert!(call_tool_impl(&db, &id, "echo", "{bad", true).is_err());
        assert!(call_tool_impl(&db, &id, "echo", "[]", true).is_err());

        // 真实调用与 isError 透传。
        let echo = call_tool_impl(&db, &id, "echo", r#"{"text":"hello"}"#, true).unwrap();
        assert!(echo.ok && !echo.is_error);
        assert!(echo.content.to_string().contains("hello"));
        let failed = call_tool_impl(&db, &id, "fail", "{}", true).unwrap();
        assert!(failed.ok && failed.is_error);
    }

    #[test]
    fn slow_tool_times_out_kills_and_reconnects() {
        let db = Db::open_in_memory().unwrap();
        let pid_file = std::env::temp_dir().join(format!(
            "taskdock-mcp-pid-{}",
            uuid::Uuid::new_v4()
        ));
        let id = stdio_fixture(&db, "modern", Some(&pid_file));
        assert!(test_server_impl(&db, &id).unwrap().ok);

        let started = Instant::now();
        let report =
            call_tool_with_timeout(&db, &id, "slow", "{}", true, Duration::from_millis(1500))
                .unwrap();
        let elapsed = started.elapsed();
        assert!(!report.ok);
        assert!(report
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("超时"));
        assert!(elapsed < Duration::from_secs(8), "超时应在有界时间内返回");

        // 超时后子进程必须被回收（不残留慢工具进程）。
        #[cfg(windows)]
        {
            std::thread::sleep(Duration::from_millis(300));
            if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                let pid = pid.trim();
                if !pid.is_empty() {
                    let output = std::process::Command::new("tasklist")
                        .args(["/NH", "/FI", &format!("PID eq {pid}")])
                        .output()
                        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                        .unwrap_or_default();
                    assert!(
                        !output.contains(pid),
                        "超时后进程仍在运行: {pid} / {output}"
                    );
                }
            }
        }

        // 重新连接仍可正常调用。
        let echo = call_tool_impl(&db, &id, "echo", r#"{"text":"again"}"#, true).unwrap();
        assert!(echo.ok, "{:?}", echo.error);
        std::fs::remove_file(pid_file).ok();
    }
}
