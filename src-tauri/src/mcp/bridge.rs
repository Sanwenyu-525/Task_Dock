//! MCP loopback bridge：主进程内的 HTTP 服务（仅 127.0.0.1），
//! 复用 agents/http_ingest.rs 的 hyper + Bearer 常量时间比较模式。
//!
//! 安全约束（与 http_ingest 同级）：
//! - 仅绑定 127.0.0.1，端口由系统分配（bind :0，独立于 http_ingest 端口）；
//! - 双层凭据：bridge token（mcp-transport.json，保护端口本身）+
//!   agent token（header `X-TaskDock-Agent-Token`，确立身份与授权）；
//! - 请求体上限 256KB、头部/请求超时、并发上限（连接 32 / 在途请求 8）；
//! - 日志只记录方法/路径/状态/耗时，绝不记录请求体、token 或 agent 凭据；
//! - 仅在设置 mcp_server_enabled=true 时由生命周期适配器启动，关闭即释放端口。

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::auth::{self, McpAgentRow};
use crate::mcp::tools::{run_tool_call, ToolCtx};
use crate::mcp::{audit, ChangeEmitter, PlanningChanged, PLANNING_CHANGED_EVENT};

const MAX_BODY: usize = 256 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_INFLIGHT: usize = 8;
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// stdio → bridge 的 agent token 请求头（bridge token 走标准 Authorization: Bearer）。
pub const AGENT_TOKEN_HEADER: &str = "x-taskdock-agent-token";

/// 工具层授权失败时交协议层转 JSON-RPC error 的载体。
#[derive(Debug)]
pub struct ToolRpcError {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

/// stdio 侧传输失败分类（统一映射为 -32000，绝不挂死）。
#[derive(Debug)]
pub enum TransportFailure {
    Unreachable(String),
    Rejected { code: u16, detail: String },
}

// ── stdio 侧最小 HTTP 客户端（同步；与 hook_cli.rs post_event 同模式）──

fn http1_request(
    addr: SocketAddr,
    bridge_token: &str,
    agent_token: &str,
    body: &str,
) -> Result<(u16, String), TransportFailure> {
    use std::io::{Read, Write};
    const CONNECT_TIMEOUT: Duration = Duration::from_millis(900);
    const IO_TIMEOUT: Duration = Duration::from_secs(25);
    let mut stream = std::net::TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| TransportFailure::Unreachable(format!("connect: {e}")))?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {bridge_token}\r\n{AGENT_TOKEN_HEADER}: {agent_token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .map_err(|e| TransportFailure::Unreachable(format!("write: {e}")))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| TransportFailure::Unreachable(format!("read: {e}")))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| TransportFailure::Unreachable("malformed response".into()))?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| TransportFailure::Unreachable("bad status line".into()))?;
    Ok((status, body.to_string()))
}

/// stdio 子命令把一行 JSON-RPC POST 到 loopback bridge（每次读传输文件，
/// 保证 Task Dock 重启后立刻用新端口/新 token，不做陈旧缓存）。
pub fn post_json(body: &str) -> Result<String, TransportFailure> {
    let app_data = crate::mcp::stdio_app_data_dir();
    let path = crate::mcp::transport_path(&app_data);
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        TransportFailure::Unreachable("传输参数文件不存在（Task Dock 未运行或未启用 MCP）".into())
    })?;
    let cfg: crate::mcp::McpTransport = serde_json::from_str(&raw)
        .map_err(|e| TransportFailure::Unreachable(format!("传输参数文件损坏: {e}")))?;
    if !cfg.enabled {
        return Err(TransportFailure::Unreachable("MCP Server 未启用".into()));
    }
    let agent_token = std::env::var(crate::mcp::AGENT_TOKEN_ENV)
        .unwrap_or_default()
        .trim()
        .to_string();
    if agent_token.is_empty() {
        return Err(TransportFailure::Rejected {
            code: 401,
            detail: format!(
                "未配置 agent token（请在 MCP 客户端 env 设置 {}）",
                crate::mcp::AGENT_TOKEN_ENV
            ),
        });
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let (status, resp) = http1_request(addr, &cfg.token, &agent_token, body)?;
    match status {
        200..=299 => Ok(resp),
        code => Err(TransportFailure::Rejected {
            code,
            detail: format!("bridge 返回 HTTP {code}"),
        }),
    }
}

// ── 主进程侧 HTTP 服务 ───────────────────────────────────────────────

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

struct BridgeState {
    db: Arc<Db>,
    token: Arc<String>,
    emit: ChangeEmitter,
    request_sem: Arc<Semaphore>,
    requests: AtomicU64,
    rejected_auth: AtomicU64,
    rejected_overload: AtomicU64,
}

fn json_response(status: StatusCode, body: Value) -> Response<Full<Bytes>> {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(data)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

async fn read_body(req: Request<Incoming>) -> Result<Vec<u8>, Response<Full<Bytes>>> {
    if let Some(len) = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if len > MAX_BODY as u64 {
            return Err(json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": "payload too large" }),
            ));
        }
    }
    let limited = Limited::new(req.into_body(), MAX_BODY);
    match tokio::time::timeout(BODY_TIMEOUT, limited.collect()).await {
        Ok(Ok(collected)) => Ok(collected.to_bytes().to_vec()),
        Ok(Err(_)) => Err(json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({ "error": "payload too large or unreadable" }),
        )),
        Err(_) => Err(json_response(
            StatusCode::REQUEST_TIMEOUT,
            json!({ "error": "body read timeout", "retryable": true }),
        )),
    }
}

/// 未知身份的失败尝试也写审计（agent_row_id=NULL；绝不写 token 本身）。
fn audit_unknown_token(state: &BridgeState, detail: &str) {
    let entry = audit::AuditEntry {
        agent_row_id: None,
        agent_id: "",
        action: "bridge_request",
        entity_type: "",
        entity_id: "",
        request_id: "",
        success: false,
        authz: false,
        detail,
        result_json: "",
    };
    if let Err(e) = state.db.with_conn(|conn| audit::write(conn, &entry)) {
        tracing::warn!("MCP 未知身份审计失败: {e}");
    }
}

async fn handle_mcp_post(state: &BridgeState, req: Request<Incoming>) -> Response<Full<Bytes>> {
    // 先取 header（body 读取会消费 req）
    let agent_token = req
        .headers()
        .get(AGENT_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(StatusCode::BAD_REQUEST, json!({ "error": "invalid json" }))
        }
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);

    // agent token → 身份（失败返回 JSON-RPC -32001，HTTP 200 以便 stdio 原样转发）
    let Some(agent_token) = agent_token else {
        state.rejected_auth.fetch_add(1, Ordering::Relaxed);
        audit_unknown_token(state, "缺少 agent token 头");
        return json_response(
            StatusCode::OK,
            crate::mcp::protocol::error_with_data(
                id,
                crate::mcp::protocol::ERR_UNAUTHORIZED,
                &format!("缺少 agent token（{}）", crate::mcp::AGENT_TOKEN_ENV),
                Value::Null,
            ),
        );
    };
    let agent: McpAgentRow = match state
        .db
        .with_conn(|conn| auth::find_agent_by_token(conn, &agent_token))
    {
        Ok(Some(a)) => a,
        Ok(None) => {
            state.rejected_auth.fetch_add(1, Ordering::Relaxed);
            audit_unknown_token(state, "agent token 不被识别或已撤销");
            return json_response(
                StatusCode::OK,
                crate::mcp::protocol::error(
                    id,
                    crate::mcp::protocol::ERR_UNAUTHORIZED,
                    "agent token 不被识别或已撤销",
                ),
            );
        }
        Err(e) => {
            tracing::warn!("MCP 身份查询失败: {e}");
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "internal error", "retryable": true }),
            );
        }
    };
    state
        .db
        .with_conn(|conn| {
            auth::touch_last_seen(conn, &agent.row_id);
            Ok(())
        })
        .ok();

    let ctx = ToolCtx {
        db: state.db.clone(),
        agent,
        emit: state.emit.clone(),
    };
    let response = crate::mcp::protocol::handle_request_value(&value, &|name, args| {
        run_tool_call(&ctx, name, args)
    });
    match response {
        Some(resp) => json_response(StatusCode::OK, resp),
        // 通知：202 Accepted（MCP HTTP 传输约定），stdio 忽略响应
        None => Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Full::new(Bytes::new()))
            .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"")))),
    }
}

async fn handle_request(req: Request<Incoming>, state: Arc<BridgeState>) -> Response<Full<Bytes>> {
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    state.requests.fetch_add(1, Ordering::Relaxed);

    let response = match (method.as_str(), path.as_str()) {
        ("POST", "/mcp") => {
            // 第一层：bridge token（保护端口本身；失败不读 body、不留审计正文）
            let authorized = req
                .headers()
                .get(AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|v| constant_time_eq(v.trim(), &state.token))
                .unwrap_or(false);
            if !authorized {
                state.rejected_auth.fetch_add(1, Ordering::Relaxed);
                json_response(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }))
            } else {
                match state.request_sem.clone().try_acquire_owned() {
                    Ok(permit) => {
                        let resp = handle_mcp_post(&state, req).await;
                        drop(permit);
                        resp
                    }
                    Err(_) => {
                        state.rejected_overload.fetch_add(1, Ordering::Relaxed);
                        let mut resp = json_response(
                            StatusCode::TOO_MANY_REQUESTS,
                            json!({ "error": "too many concurrent requests", "retryable": true }),
                        );
                        resp.headers_mut()
                            .insert("Retry-After", hyper::header::HeaderValue::from_static("1"));
                        resp
                    }
                }
            }
        }
        _ => json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
    };
    // 脱敏日志：不含请求体与任何 token
    tracing::info!(
        "MCP bridge {} {} -> {} ({:?}ms)",
        method.as_str(),
        path,
        response.status().as_u16(),
        started.elapsed().as_millis()
    );
    response
}

fn http1_builder() -> hyper::server::conn::http1::Builder {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .keep_alive(true)
        .header_read_timeout(HEADER_TIMEOUT)
        .timer(TokioTimer::new());
    builder
}

async fn handle_conn(stream: tokio::net::TcpStream, state: Arc<BridgeState>) {
    let io = TokioIo::new(stream);
    let service = service_fn(move |req: Request<Incoming>| {
        let state = state.clone();
        async move {
            let resp = match tokio::time::timeout(REQUEST_TIMEOUT, handle_request(req, state)).await
            {
                Ok(r) => r,
                Err(_) => json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({ "error": "request timeout", "retryable": true }),
                ),
            };
            Ok::<_, Infallible>(resp)
        }
    });
    let conn = http1_builder().serve_connection(io, service);
    // 连接最长存活 120s：防止半开/慢连接占用连接配额
    let _ = tokio::time::timeout(Duration::from_secs(120), conn).await;
}

async fn run_listener(
    listener: TcpListener,
    state: Arc<BridgeState>,
    conn_sem: Arc<Semaphore>,
    shutdown: Arc<Notify>,
) {
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                tracing::info!("MCP bridge 停止监听");
                return;
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        match conn_sem.clone().try_acquire_owned() {
                            Ok(permit) => {
                                let st = state.clone();
                                tokio::spawn(async move {
                                    let _permit: OwnedSemaphorePermit = permit;
                                    handle_conn(stream, st).await;
                                });
                            }
                            Err(_) => {
                                // 连接配额耗尽：直接关闭
                                drop(stream);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("MCP bridge accept 失败: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    }
}

/// 正在运行的 bridge 实例（适配器与测试共用）。
pub struct RunningBridge {
    pub port: u16,
    pub token: String,
    shutdown: Arc<Notify>,
    join: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl RunningBridge {
    /// 停止监听并等待任务退出（最多 2s；超时放弃等待，任务随运行时结束）。
    pub async fn stop(mut self) {
        self.shutdown.notify_waiters();
        if let Some(join) = self.join.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), join).await;
        }
    }
}

/// 启动 bridge（绑定 127.0.0.1 随机端口）。由设置开关驱动的适配器与测试共用。
pub async fn start(db: Arc<Db>, emit: ChangeEmitter) -> AppResult<RunningBridge> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Io(std::io::Error::new(std::io::ErrorKind::AddrInUse, e)))?;
    let port = listener.local_addr().map_err(AppError::from)?.port();
    let token = auth::generate_token();
    let shutdown = Arc::new(Notify::new());
    let state = Arc::new(BridgeState {
        db,
        token: Arc::new(token.clone()),
        emit,
        request_sem: Arc::new(Semaphore::new(MAX_INFLIGHT)),
        requests: AtomicU64::new(0),
        rejected_auth: AtomicU64::new(0),
        rejected_overload: AtomicU64::new(0),
    });
    let join = tauri::async_runtime::spawn(run_listener(
        listener,
        state,
        Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        shutdown.clone(),
    ));
    tracing::info!("MCP bridge 监听 127.0.0.1:{port}");
    Ok(RunningBridge {
        port,
        token,
        shutdown,
        join: Some(join),
    })
}

// ── 生命周期适配器（主进程集成）────────────────────────────────────

/// bridge 运行态（mcp_status 命令读取；不含 token）。
#[derive(Default)]
pub struct McpRuntimeStatus {
    pub port: Mutex<Option<u16>>,
    pub running: AtomicBool,
    pub started_at: Mutex<Option<String>>,
    settings_changed: Notify,
}

impl McpRuntimeStatus {
    pub fn snapshot(&self) -> (bool, Option<u16>) {
        (
            self.running.load(Ordering::Relaxed),
            *self.port.lock().unwrap_or_else(|e| e.into_inner()),
        )
    }

    pub fn notify_settings_changed(&self) {
        // `notify_one` retains one permit if the adapter is between its settings read
        // and select, so a just-committed change cannot be lost.
        self.settings_changed.notify_one();
    }

    fn clear_running(&self) {
        self.running.store(false, Ordering::Relaxed);
        *self.port.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// 设置驱动的 bridge 生命周期：设置变更时读取 mcp_server_enabled，启用即绑定端口并
/// 写 mcp-transport.json，关闭即停服务并标记 enabled=false（stdio 侧明确报错）。
pub fn spawn_adapter(
    app: tauri::AppHandle,
    db: Arc<Db>,
    data_dir: std::path::PathBuf,
) -> Arc<McpRuntimeStatus> {
    let status = Arc::new(McpRuntimeStatus::default());
    let status_for_task = status.clone();
    tauri::async_runtime::spawn(async move {
        let mut current: Option<RunningBridge> = None;
        let mut wrote_disabled = false;
        let mut settings_dirty = true;
        let mut retry_start = false;
        loop {
            if crate::agents::shutdown_signal::is_set() {
                if let Some(b) = current.take() {
                    b.stop().await;
                }
                let _ = crate::mcp::write_transport_config(&data_dir, 0, "", false);
                status_for_task.clear_running();
                return;
            }

            // A listener task can finish unexpectedly (for example, after a panic).
            // Its port is then released, so clear the published state and re-evaluate
            // the setting before retrying.
            if current
                .as_ref()
                .and_then(|bridge| bridge.join.as_ref())
                .is_some_and(|join| join.inner().is_finished())
            {
                if let Some(b) = current.take() {
                    let _ = b.stop().await;
                }
                let _ = crate::mcp::write_transport_config(&data_dir, 0, "", false);
                status_for_task.clear_running();
                retry_start = true;
            }

            if settings_dirty || retry_start {
                let enabled = crate::db::Settings::load(&db)
                    .map(|s| s.mcp_server_enabled)
                    .unwrap_or(false);
                match (enabled, current.is_some()) {
                    (true, false) => {
                        let emit = make_emitter(&app);
                        match start(db.clone(), emit).await {
                            Ok(b) => {
                                let _ = crate::mcp::write_transport_config(
                                    &data_dir, b.port, &b.token, true,
                                );
                                *status_for_task
                                    .port
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner()) = Some(b.port);
                                *status_for_task
                                    .started_at
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner()) =
                                    Some(crate::agents::now_iso());
                                status_for_task.running.store(true, Ordering::Relaxed);
                                wrote_disabled = false;
                                retry_start = false;
                                current = Some(b);
                            }
                            Err(e) => {
                                tracing::error!("MCP bridge 启动失败: {e}");
                                let _ = crate::mcp::write_transport_config(&data_dir, 0, "", false);
                                status_for_task.clear_running();
                                retry_start = true;
                            }
                        }
                    }
                    (false, true) => {
                        if let Some(b) = current.take() {
                            b.stop().await;
                        }
                        let _ = crate::mcp::write_transport_config(&data_dir, 0, "", false);
                        status_for_task.clear_running();
                        retry_start = false;
                    }
                    (false, false) => {
                        if !wrote_disabled {
                            // 让 stdio 侧即使从未启用也能读到明确的 enabled=false
                            let _ = crate::mcp::write_transport_config(&data_dir, 0, "", false);
                            wrote_disabled = true;
                        }
                        retry_start = false;
                    }
                    (true, true) => retry_start = false,
                }
                settings_dirty = false;
            }
            tokio::select! {
                _ = crate::agents::shutdown_signal::wait() => {
                    if let Some(b) = current.take() {
                        b.stop().await;
                    }
                    let _ = crate::mcp::write_transport_config(&data_dir, 0, "", false);
                    status_for_task.clear_running();
                    return;
                }
                _ = status_for_task.settings_changed.notified() => {
                    settings_dirty = true;
                }
                _ = tokio::time::sleep(Duration::from_secs(1)), if current.is_some() || retry_start => {}
            }
        }
    });
    status
}

fn make_emitter(app: &tauri::AppHandle) -> ChangeEmitter {
    let app = app.clone();
    Arc::new(move |changed: PlanningChanged| {
        let _ = tauri::Emitter::emit(&app, PLANNING_CHANGED_EVENT, &changed);
    })
}
