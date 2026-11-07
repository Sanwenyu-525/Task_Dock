//! 本地 HTTP 接入 Adapter（异步、有界、可超时）。
//!
//! 安全约束（对应需求）：
//! - 仅绑定 127.0.0.1 回环地址；
//! - Bearer 令牌鉴权（常量时间比较）；
//! - 请求体大小上限 64KB、头部读取超时、请求处理超时；
//! - 全局并发上限：连接 64 / 活跃请求 32，超出返回 429 + Retry-After；
//! - 队列容量耗尽返回 503 + Retry-After（关键事件绝不静默成功）；
//! - 日志只记录方法/路径/状态/对端/耗时，绝不记录请求体内容（脱敏）；
//! - 401 鉴权失败按 10s 窗口聚合为一条 WARN（含累计次数），不逐请求打 INFO；
//!   安全审计计数仍保留在 `stats().rejected_auth`。
//!
//! 单事件（running）快速入队后立即 200（`queued=true`）；关键状态与批量请求
//! 等待事务提交后返回，保持「批量全成功/全失败」语义。

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::agents::pipeline::IngestPipeline;
use crate::agents::{AgentAdapter, AgentEvent, AgentHub, AgentState, Transport};
use crate::db::Settings;
use crate::error::AppError;

const MAX_BODY: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_INFLIGHT: usize = 32;
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// 401 鉴权失败的日志聚合窗口长度（每窗口最多输出一条 WARN）。
const AUTH_REJECT_WINDOW: Duration = Duration::from_secs(10);

/// 端口绑定失败的日志节流：10s 重试周期下只记首次与每 30 次（约 5 分钟）一次。
fn should_log_bind_failure(attempt: u32) -> bool {
    attempt == 1 || attempt % 30 == 0
}

/// hyper 1.x 在设置 `header_read_timeout` 时必须同时提供 timer，否则每个连接都会 panic。
fn http1_builder() -> hyper::server::conn::http1::Builder {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .keep_alive(true)
        .header_read_timeout(HEADER_TIMEOUT)
        .timer(TokioTimer::new());
    builder
}

#[derive(Default)]
struct HttpStats {
    requests: AtomicU64,
    accepted: AtomicU64,
    rejected_auth: AtomicU64,
    rejected_parse: AtomicU64,
    rejected_overload: AtomicU64,
    rejected_concurrency: AtomicU64,
    internal_errors: AtomicU64,
    active_requests: AtomicUsize,
    active_connections: AtomicUsize,
    max_active_requests: AtomicUsize,
    last_request_at: Mutex<Option<String>>,
}

static STATS: OnceLock<Arc<HttpStats>> = OnceLock::new();

fn stats() -> &'static Arc<HttpStats> {
    STATS.get_or_init(|| Arc::new(HttpStats::default()))
}

/// 诊断快照（不含令牌等敏感信息）。
pub fn stats_snapshot() -> serde_json::Value {
    let s = stats();
    json!({
        "requests": s.requests.load(Ordering::Relaxed),
        "accepted": s.accepted.load(Ordering::Relaxed),
        "rejected_auth": s.rejected_auth.load(Ordering::Relaxed),
        "rejected_parse": s.rejected_parse.load(Ordering::Relaxed),
        "rejected_overload": s.rejected_overload.load(Ordering::Relaxed),
        "rejected_concurrency": s.rejected_concurrency.load(Ordering::Relaxed),
        "internal_errors": s.internal_errors.load(Ordering::Relaxed),
        "active_requests": s.active_requests.load(Ordering::Relaxed),
        "active_connections": s.active_connections.load(Ordering::Relaxed),
        "max_active_requests": s.max_active_requests.load(Ordering::Relaxed),
        "last_request_at": s.last_request_at.lock().ok().and_then(|v| v.clone()),
        "max_concurrency": MAX_INFLIGHT,
        "max_body_bytes": MAX_BODY,
    })
}

/// 401 鉴权失败的**有界日志聚合**（纯逻辑，可单测）。
///
/// 旧实例/错误令牌客户端会持续轮询同一端口，逐请求 INFO 会在日志里堆出数百条
/// 401（历史约 438 条）。这里按固定窗口聚合：
/// - `observe` 每条 401 调用一次；返回 `Some(n)` 表示应输出一条包含本窗口累计
///   `n` 次的审计（含窗口内首条）；
/// - 返回 `None` 表示本窗口已输出过审计，本条只计数、不落日志；
/// - 窗口到期后输出**整个窗口**的累计次数，然后重新计数。
///
/// 只保存单调时钟与计数，不含 method/path/token 等任何请求内容；调用方在输出
/// 时才附加本次请求的 method/path（绝不记录 Authorization、请求体、peer 端口）。
/// 与 `stats().rejected_auth` 相互独立：日志限流不影响安全审计计数。
#[derive(Debug, Default)]
struct AuthRejectWindow {
    last_emit: Option<Instant>,
    suppressed: u64,
}

impl AuthRejectWindow {
    fn observe(&mut self, now: Instant) -> Option<u64> {
        self.suppressed = self.suppressed.saturating_add(1);
        match self.last_emit {
            Some(last) if now.duration_since(last) < AUTH_REJECT_WINDOW => None,
            _ => {
                let count = self.suppressed;
                self.suppressed = 0;
                self.last_emit = Some(now);
                Some(count)
            }
        }
    }
}

static AUTH_REJECTS: LazyLock<Mutex<AuthRejectWindow>> =
    LazyLock::new(|| Mutex::new(AuthRejectWindow::default()));

/// 记录一次 401：每 `AUTH_REJECT_WINDOW` 至多输出一条 WARN（含窗口累计次数）。
fn record_auth_reject(method: &str, path: &str) {
    let emitted = AUTH_REJECTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .observe(Instant::now());
    if let Some(count) = emitted {
        tracing::warn!(
            "HTTP 接入鉴权失败 {} 次/{}s（method={}, path={}）",
            count,
            AUTH_REJECT_WINDOW.as_secs(),
            method,
            path
        );
    }
}

pub struct HttpIngestAdapter {
    pipeline: Arc<IngestPipeline>,
}

impl HttpIngestAdapter {
    pub fn new(pipeline: Arc<IngestPipeline>) -> Self {
        Self { pipeline }
    }
}

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

fn json_response(
    status: StatusCode,
    body: serde_json::Value,
    retry_after_secs: Option<u64>,
) -> Response<Full<Bytes>> {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json");
    if let Some(secs) = retry_after_secs {
        builder = builder.header("Retry-After", secs.to_string());
    }
    builder
        .body(Full::new(Bytes::from(data)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

fn error_response(err: AppError) -> Response<Full<Bytes>> {
    match err {
        AppError::Validation(msg) => {
            stats().rejected_parse.fetch_add(1, Ordering::Relaxed);
            json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": msg, "accepted": 0, "rejected": 1, "retryable": false}),
                None,
            )
        }
        AppError::Overloaded(msg) => {
            stats().rejected_overload.fetch_add(1, Ordering::Relaxed);
            json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": msg, "accepted": 0, "rejected": 1, "retryable": true}),
                Some(1),
            )
        }
        AppError::Unavailable(msg) => {
            stats().rejected_overload.fetch_add(1, Ordering::Relaxed);
            json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": msg, "accepted": 0, "rejected": 1, "retryable": true}),
                Some(1),
            )
        }
        other => {
            // 内部错误细节只写日志，不回传（避免泄露 SQL/路径）
            tracing::warn!("HTTP 接入内部错误: {}", other);
            stats().internal_errors.fetch_add(1, Ordering::Relaxed);
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": "internal error", "accepted": 0, "rejected": 1, "retryable": true}),
                Some(1),
            )
        }
    }
}

struct HttpState {
    pipeline: Arc<IngestPipeline>,
    token: Arc<String>,
    request_sem: Arc<Semaphore>,
    db: Arc<crate::db::Db>,
    #[allow(dead_code)]
    port: u16,
}

fn runtime_stats() -> serde_json::Value {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            let metrics = handle.metrics();
            json!({
                "alive_tasks": metrics.num_alive_tasks(),
            })
        }
        Err(_) => json!({ "alive_tasks": null }),
    }
}

fn authorized(req: &Request<Incoming>, token: &str) -> bool {
    req.headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| constant_time_eq(v.trim(), token))
        .unwrap_or(false)
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
                json!({"error": "payload too large"}),
                None,
            ));
        }
    }
    let limited = Limited::new(req.into_body(), MAX_BODY);
    match tokio::time::timeout(BODY_TIMEOUT, limited.collect()).await {
        Ok(Ok(collected)) => Ok(collected.to_bytes().to_vec()),
        Ok(Err(_)) => Err(json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error": "payload too large or unreadable"}),
            None,
        )),
        Err(_) => Err(json_response(
            StatusCode::REQUEST_TIMEOUT,
            json!({"error": "body read timeout", "retryable": true}),
            Some(1),
        )),
    }
}

/// 在途请求计数守卫：客户端中断时 future 会被丢弃，Drop 仍会执行，
/// 不会像手工 fetch_sub 那样让诊断值单调泄漏（超过并发上限）。
struct ActiveRequestGuard;

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        stats().active_requests.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn handle_events(req: Request<Incoming>, state: Arc<HttpState>) -> Response<Full<Bytes>> {
    let _permit = match state.request_sem.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            stats().rejected_concurrency.fetch_add(1, Ordering::Relaxed);
            return json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": "too many concurrent requests", "retryable": true}),
                Some(1),
            );
        }
    };
    let active = stats().active_requests.fetch_add(1, Ordering::Relaxed) + 1;
    stats()
        .max_active_requests
        .fetch_max(active, Ordering::Relaxed);
    let _active_guard = ActiveRequestGuard;

    process_events(req, &state).await
}

async fn process_events(req: Request<Incoming>, state: &HttpState) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let value: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            stats().rejected_parse.fetch_add(1, Ordering::Relaxed);
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid json"}),
                None,
            );
        }
    };
    match value {
        serde_json::Value::Object(_) => {
            let ev: AgentEvent = match serde_json::from_value(value) {
                Ok(ev) => ev,
                Err(_) => {
                    stats().rejected_parse.fetch_add(1, Ordering::Relaxed);
                    return json_response(
                        StatusCode::BAD_REQUEST,
                        json!({"error": "invalid event"}),
                        None,
                    );
                }
            };
            // running 等高频非关键事件快速入队（200 queued）；关键状态等待提交确认
            let wait = AgentState::parse(&ev.state) != Some(AgentState::Running);
            match state
                .pipeline
                .submit(vec![ev], Transport::Http, "http", wait)
                .await
            {
                Ok(r) => {
                    stats()
                        .accepted
                        .fetch_add(r.accepted as u64, Ordering::Relaxed);
                    if r.sampled {
                        return json_response(
                            StatusCode::OK,
                            json!({
                                "accepted": 0, "merged": 0, "sampled": 1, "rejected": 0,
                                "queued": true, "note": "overload sampling of non-critical event"
                            }),
                            None,
                        );
                    }
                    json_response(
                        StatusCode::OK,
                        json!({
                            "accepted": r.accepted,
                            "merged": if r.merged { 1 } else { 0 },
                            "sampled": 0,
                            "rejected": 0,
                            "queued": !wait || r.outcomes.is_none(),
                        }),
                        None,
                    )
                }
                Err(e) => error_response(e),
            }
        }
        serde_json::Value::Array(items) => {
            if items.is_empty() {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "empty batch"}),
                    None,
                );
            }
            let total = items.len();
            let mut events = Vec::with_capacity(total);
            for item in items {
                match serde_json::from_value::<AgentEvent>(item) {
                    Ok(ev) => events.push(ev),
                    Err(_) => {
                        stats().rejected_parse.fetch_add(1, Ordering::Relaxed);
                        return json_response(
                            StatusCode::BAD_REQUEST,
                            json!({"error": "invalid event in batch", "accepted": 0, "rejected": total}),
                            None,
                        );
                    }
                }
            }
            // 批量保持「全成功/全失败」：等待单事务提交
            match state
                .pipeline
                .submit(events, Transport::Http, "http", true)
                .await
            {
                Ok(r) => {
                    stats()
                        .accepted
                        .fetch_add(r.accepted as u64, Ordering::Relaxed);
                    json_response(
                        StatusCode::OK,
                        json!({
                            "accepted": r.accepted,
                            "merged": if r.merged { 1 } else { 0 },
                            "rejected": 0,
                            "queued": false,
                        }),
                        None,
                    )
                }
                Err(e) => error_response(e),
            }
        }
        _ => {
            stats().rejected_parse.fetch_add(1, Ordering::Relaxed);
            json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid json"}),
                None,
            )
        }
    }
}

async fn handle_request(
    req: Request<Incoming>,
    state: Arc<HttpState>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    stats().requests.fetch_add(1, Ordering::Relaxed);
    *stats()
        .last_request_at
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(crate::agents::now_iso());

    let response = match (method.as_str(), path.as_str()) {
        ("GET", "/api/v1/health") => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "service": "task-dock",
                "queue": {
                    "depth_events": state.pipeline.stats().queue_depth_events,
                    "capacity": state.pipeline.stats().queue_capacity,
                }
            }),
            None,
        ),
        ("GET", "/api/v1/stats") => {
            if !authorized(&req, &state.token) {
                stats().rejected_auth.fetch_add(1, Ordering::Relaxed);
                json_response(
                    StatusCode::UNAUTHORIZED,
                    json!({"error": "unauthorized"}),
                    None,
                )
            } else {
                json_response(
                    StatusCode::OK,
                    json!({
                        "pipeline": state.pipeline.stats(),
                        "http": stats_snapshot(),
                        "process": crate::alloc_stats::snapshot(),
                        "runtime": runtime_stats(),
                        "notifications": crate::agents::notification_stats(),
                        "db": state.db.storage_stats(),
                    }),
                    None,
                )
            }
        }
        ("POST", "/api/v1/events") => {
            if !authorized(&req, &state.token) {
                stats().rejected_auth.fetch_add(1, Ordering::Relaxed);
                json_response(
                    StatusCode::UNAUTHORIZED,
                    json!({"error": "unauthorized"}),
                    None,
                )
            } else {
                handle_events(req, state.clone()).await
            }
        }
        _ => json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}), None),
    };
    // 脱敏日志：不含请求体/令牌/peer 端口。
    // 401 是旧实例/错误令牌轮询的稳定噪声源：按窗口聚合为 WARN，计数仍由
    // `stats().rejected_auth` 保留；其余请求只在详细模式（DEBUG）落盘。
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        record_auth_reject(method.as_str(), path.as_str());
    } else {
        tracing::debug!(
            "HTTP 接入 {} {} -> {} ({:?}, {:?}ms)",
            method.as_str(),
            path,
            status.as_u16(),
            peer,
            started.elapsed().as_millis()
        );
    }
    response
}

async fn handle_conn(stream: TcpStream, peer: SocketAddr, state: Arc<HttpState>) {
    let io = TokioIo::new(stream);
    let service = service_fn(move |req| {
        let state = state.clone();
        async move {
            let resp = match tokio::time::timeout(REQUEST_TIMEOUT, handle_request(req, state, peer))
                .await
            {
                Ok(r) => r,
                Err(_) => json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error": "request timeout", "retryable": true}),
                    Some(1),
                ),
            };
            Ok::<_, Infallible>(resp)
        }
    });
    let conn = http1_builder().serve_connection(io, service);
    // 连接最长存活 120s：防止半开/慢连接长期占用连接配额
    let _ = tokio::time::timeout(Duration::from_secs(120), conn).await;
}

/// 连接配额耗尽：直接回 429（不读取请求体，快速释放）。
async fn reject_busy(mut stream: TcpStream) {
    let body = br#"{"error":"too many connections","retryable":true}"#;
    let head = format!(
        "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 1\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn run_listener(
    listener: TcpListener,
    hub: Arc<AgentHub>,
    pipeline: Arc<IngestPipeline>,
    port: u16,
    token: String,
    conn_sem: Arc<Semaphore>,
) {
    let state = Arc::new(HttpState {
        pipeline,
        token: Arc::new(token.clone()),
        request_sem: Arc::new(Semaphore::new(MAX_INFLIGHT)),
        db: hub.db_arc(),
        port,
    });
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = crate::agents::shutdown_signal::wait() => {
                tracing::info!("应用退出：关闭 HTTP 接入监听，不再接受新事件");
                return;
            }
            _ = tick.tick() => {
                let s = Settings::load(hub.db()).unwrap_or_default();
                if !s.http_enabled || s.http_port != port || s.http_token != token {
                    tracing::info!("HTTP 接入配置变更，重新绑定监听");
                    return;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        match conn_sem.clone().try_acquire_owned() {
                            Ok(permit) => {
                                stats().active_connections.fetch_add(1, Ordering::Relaxed);
                                let st = state.clone();
                                tokio::spawn(async move {
                                    let _permit: OwnedSemaphorePermit = permit;
                                    handle_conn(stream, peer, st).await;
                                    stats().active_connections.fetch_sub(1, Ordering::Relaxed);
                                });
                            }
                            Err(_) => {
                                stats().rejected_concurrency.fetch_add(1, Ordering::Relaxed);
                                tokio::spawn(reject_busy(stream));
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("HTTP accept 失败: {}", e);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    }
}

impl AgentAdapter for HttpIngestAdapter {
    fn id(&self) -> &'static str {
        "http_ingest"
    }

    fn spawn(
        self: Box<Self>,
        hub: std::sync::Arc<AgentHub>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let pipeline = self.pipeline.clone();
        tauri::async_runtime::spawn(async move {
            let conn_sem = Arc::new(Semaphore::new(MAX_CONNECTIONS));
            let mut current: Option<(u16, String)> = None;
            // 端口占用时每 10s 重试：只记首次与每 30 次（约 5 分钟）一次，避免日志洪水。
            let mut bind_failures: u32 = 0;
            loop {
                if crate::agents::shutdown_signal::is_set() {
                    tracing::info!("应用退出：HTTP 接入适配器停止");
                    return;
                }
                let settings = Settings::load(hub.db()).unwrap_or_default();
                let desired = if settings.http_enabled {
                    Some((settings.http_port, settings.http_token.clone()))
                } else {
                    None
                };
                if desired.is_none() {
                    if current.take().is_some() {
                        tracing::info!("HTTP 接入已关闭");
                    }
                    tokio::select! {
                        _ = crate::agents::shutdown_signal::wait() => return,
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                    continue;
                }
                let (port, token) = desired.unwrap();
                if current.as_ref() == Some(&(port, token.clone())) {
                    tokio::select! {
                        _ = crate::agents::shutdown_signal::wait() => return,
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                    continue;
                }
                match TcpListener::bind(("127.0.0.1", port)).await {
                    Ok(listener) => {
                        bind_failures = 0;
                        tracing::info!("本地 HTTP 接入监听 127.0.0.1:{}", port);
                        current = Some((port, token.clone()));
                        run_listener(
                            listener,
                            hub.clone(),
                            pipeline.clone(),
                            port,
                            token,
                            conn_sem.clone(),
                        )
                        .await;
                    }
                    Err(e) => {
                        // 真机实测：端口被占用时适配器每 10s 重试一次，逐次 ERROR 会堆出
                        // 每小时 360 条噪声。只记首次与每 30 次（约 5 分钟）一次累计尝试。
                        bind_failures = bind_failures.saturating_add(1);
                        if should_log_bind_failure(bind_failures) {
                            tracing::error!(
                                "绑定 127.0.0.1:{} 失败（第 {} 次尝试，继续重试）: {}",
                                port,
                                bind_failures,
                                e
                            );
                        }
                        tokio::select! {
                            _ = crate::agents::shutdown_signal::wait() => return,
                            _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                        }
                    }
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_exact_only() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }

    /// 401 审计有界聚合：首条立即输出、窗口内只计数、到期输出窗口累计。
    #[test]
    fn auth_reject_window_emits_at_most_once_per_ten_seconds() {
        let start = Instant::now();
        let mut window = AuthRejectWindow::default();

        assert_eq!(window.observe(start), Some(1), "首条 401 必须立即审计");
        for i in 0..5 {
            assert_eq!(
                window.observe(start + Duration::from_secs(i + 1)),
                None,
                "窗口内第 {} 条必须被聚合抑制",
                i + 2
            );
        }
        // 10s 到期：输出本窗口累计 6 次（含首条），而不是仅被抑制的 5 条。
        assert_eq!(
            window.observe(start + AUTH_REJECT_WINDOW),
            Some(6),
            "10s 后输出本窗口累计次数"
        );
        // 同一时刻的后续 401 属于新窗口：重新计数，不再立即输出。
        assert_eq!(
            window.observe(start + AUTH_REJECT_WINDOW + Duration::from_millis(1)),
            None,
            "输出后新窗口必须重新聚合"
        );
        assert_eq!(
            window.observe(start + AUTH_REJECT_WINDOW * 2 + Duration::from_millis(2)),
            Some(2),
            "第二个窗口累计 2 次（重新计数）"
        );
    }

    /// 端口占用会每 10s 重试：只在首次与每 30 次记录，避免每小时 360 条 ERROR。
    #[test]
    fn bind_failure_logging_is_rate_limited() {
        assert!(should_log_bind_failure(1), "首次失败必须记录");
        for attempt in 2..30 {
            assert!(
                !should_log_bind_failure(attempt),
                "第 {attempt} 次尝试不应逐次记录"
            );
        }
        assert!(should_log_bind_failure(30), "每 30 次（约 5 分钟）记录一次");
        assert!(!should_log_bind_failure(31));
        assert!(should_log_bind_failure(60));
    }

    /// 聚合状态必须按实例隔离：测试与多监听器不得共享全局窗口状态。
    #[test]
    fn auth_reject_windows_are_independent_instances() {
        let now = Instant::now();
        let mut a = AuthRejectWindow::default();
        let mut b = AuthRejectWindow::default();
        assert_eq!(a.observe(now), Some(1));
        assert_eq!(b.observe(now), Some(1), "独立实例不得共享窗口状态");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn http1_connection_with_header_timeout_answers_instead_of_panicking() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt as _};

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let io = TokioIo::new(stream);
            let service = service_fn(|_req: Request<Incoming>| async {
                Ok::<_, Infallible>(json_response(StatusCode::OK, json!({"ok": true}), None))
            });
            let _ = http1_builder().serve_connection(io, service).await;
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut buf = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut buf)).await;
        let n = read
            .expect("连接超时：header_read_timeout 缺少 timer 时会 panic")
            .unwrap();
        assert!(n > 0, "服务器返回空响应");
        let text = String::from_utf8_lossy(&buf);
        assert!(
            text.starts_with("HTTP/1.1 200"),
            "unexpected response: {text}"
        );
        assert!(text.contains("\"ok\":true"), "unexpected body: {text}");
        server.await.unwrap();
    }
}
