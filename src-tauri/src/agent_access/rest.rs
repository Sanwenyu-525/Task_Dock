//! 本地 REST API（默认关闭，仅监听 127.0.0.1）。
//!
//! 安全约束：
//! - 远程访问本轮不实现：只绑定环回地址，设置项里只有「未开放」；
//! - 必须携带 `Authorization: Bearer tdm_...`（Agent Token，库内只存 SHA-256）；
//! - 拒绝带 `Origin` 的请求，不返回 CORS 头（浏览器页面无法直接调用）；
//! - body ≤ 1MiB、请求 ≤ 20s、限流 120 次/分（固定窗口）、POST 支持 `Idempotency-Key` 24h。
//!
//! 路由与 `ROUTES` 常量共用，`/api/v1/openapi.json` 由同一份数据生成，避免文档漂移。

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};
use crate::mcp::auth::{self, McpAgentRow};

use super::{
    context, error_code, handoff, http_status, service, store, sync as file_sync, workspace,
    Envelope, Meta, Page, Principal, Source,
};

pub const MAX_BODY: usize = 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
pub const RATE_LIMIT_PER_MIN: u32 = 120;
pub const BASE_PATH: &str = "/api/v1";

/// 路由表：`(method, path, summary)`。openapi 与 dispatch 都以此为真源。
pub const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/api/v1/status", "系统与工作空间状态"),
    ("GET", "/api/v1/manifest", "Agent 工作空间 manifest"),
    ("GET", "/api/v1/openapi.json", "本 API 的 OpenAPI 描述"),
    ("GET", "/api/v1/projects", "项目列表（规划项目 + 工作空间项目）"),
    ("GET", "/api/v1/projects/{id}", "项目详情"),
    ("GET", "/api/v1/projects/{id}/status", "项目状态与下一步"),
    ("GET", "/api/v1/tasks", "任务列表（支持 status/search/limit/offset）"),
    ("GET", "/api/v1/tasks/{id}", "任务详情"),
    ("POST", "/api/v1/tasks", "创建任务"),
    ("PATCH", "/api/v1/tasks/{id}", "更新任务（需 base_revision）"),
    ("POST", "/api/v1/tasks/{id}/complete", "完成任务"),
    ("GET", "/api/v1/plans", "规划列表"),
    ("GET", "/api/v1/plans/current", "当前规划"),
    ("GET", "/api/v1/plans/{id}", "规划详情"),
    ("GET", "/api/v1/knowledge/search", "知识检索"),
    ("GET", "/api/v1/knowledge/{id}", "知识文档"),
    ("POST", "/api/v1/knowledge", "写入知识"),
    ("PATCH", "/api/v1/knowledge/{id}", "更新知识（需 base_revision）"),
    ("GET", "/api/v1/decisions", "决策列表"),
    ("GET", "/api/v1/decisions/{id}", "决策详情"),
    ("POST", "/api/v1/decisions", "记录决策"),
    ("GET", "/api/v1/context", "上下文（Markdown 或 JSON）"),
    ("GET", "/api/v1/context/search", "上下文关键词过滤"),
    ("GET", "/api/v1/agents/handoffs", "交接列表"),
    ("POST", "/api/v1/agents/handoffs", "创建交接"),
    ("GET", "/api/v1/agents/handoffs/{id}", "交接详情"),
    ("POST", "/api/v1/agents/handoffs/{id}/accept", "接收交接"),
    ("POST", "/api/v1/agents/handoffs/{id}/reject", "拒绝交接"),
    ("POST", "/api/v1/agents/handoffs/{id}/complete", "完成交接"),
    ("GET", "/api/v1/agents/reports", "工作报告列表"),
    ("POST", "/api/v1/agents/reports", "提交工作报告"),
    ("GET", "/api/v1/agents/activity", "Agent 活动记录"),
    ("GET", "/api/v1/sync/status", "同步状态"),
    ("GET", "/api/v1/sync/conflicts", "冲突列表"),
    ("POST", "/api/v1/sync/conflicts/{id}/resolve", "解决冲突"),
    ("POST", "/api/v1/sync/scan", "立即扫描导入目录"),
];

/// 真实运行状态。与「配置期望运行」分开：`enabled=true` 不代表正在监听。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestRuntimeStatus {
    Stopped,
    Starting,
    Listening,
    Failed,
    Stopping,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct RestStatus {
    pub enabled: bool,
    pub running: bool,
    pub state: RestRuntimeStatus,
    /// 实际生效端口；未监听时回退为配置端口。
    pub port: u16,
    pub configured_port: u16,
    pub bound_port: Option<u16>,
    pub base_url: String,
    pub openapi_url: String,
    pub last_error: Option<String>,
    pub started_at: Option<String>,
    pub request_count: u64,
    pub rejected_count: u64,
    pub remote_allowed: bool,
}

struct RateState {
    window: Instant,
    count: u32,
}

struct RestState {
    db: Arc<Db>,
    port: u16,
    shutdown: Arc<Notify>,
    rate: Mutex<RateState>,
}

struct RunningRest {
    port: u16,
    shutdown: Arc<Notify>,
    task: tauri::async_runtime::JoinHandle<()>,
    /// 监听任务退出标记（任务被 abort 时由 Drop 兜底置位）。
    finished: Arc<AtomicU64>,
}

/// 监听任务的生命周期标记：无论正常退出还是被 abort，Drop 都会置位，
/// 让 `stop()` 不必依赖 `JoinHandle::is_finished`（Tauri 的句柄没有该方法）。
struct ListenerDone(Arc<AtomicU64>);

impl Drop for ListenerDone {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Debug)]
struct RuntimeState {
    status: RestRuntimeStatus,
    configured_port: u16,
    bound_port: Option<u16>,
    last_error: Option<String>,
    started_at: Option<String>,
}

fn slot() -> &'static Mutex<Option<RunningRest>> {
    static SLOT: OnceLock<Mutex<Option<RunningRest>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn runtime() -> &'static Mutex<RuntimeState> {
    static RUNTIME: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Mutex::new(RuntimeState {
            status: RestRuntimeStatus::Stopped,
            configured_port: 0,
            bound_port: None,
            last_error: None,
            started_at: None,
        })
    })
}

fn counters() -> &'static (AtomicU64, AtomicU64) {
    static COUNTERS: OnceLock<(AtomicU64, AtomicU64)> = OnceLock::new();
    COUNTERS.get_or_init(|| (AtomicU64::new(0), AtomicU64::new(0)))
}

fn runtime_snapshot() -> RuntimeState {
    runtime()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(RuntimeState {
            status: RestRuntimeStatus::Failed,
            configured_port: 0,
            bound_port: None,
            last_error: Some("REST 运行时状态锁不可用".into()),
            started_at: None,
        })
}

pub fn status(db: &Db) -> RestStatus {
    let settings = Settings::load(db).ok();
    let enabled = settings.as_ref().map(|s| s.agent_api_enabled).unwrap_or(false);
    let configured_port = settings.map(|s| s.agent_api_port).unwrap_or(47911);
    let runtime = runtime_snapshot();
    // 真实监听必须以「持有任务句柄 + 状态为 listening」同时成立。
    let listening = runtime.status == RestRuntimeStatus::Listening
        && runtime.bound_port.is_some()
        && slot().lock().map(|g| g.is_some()).unwrap_or(false);
    let port = if listening {
        runtime.bound_port.unwrap_or(configured_port)
    } else {
        configured_port
    };
    RestStatus {
        enabled,
        running: listening,
        state: if listening {
            RestRuntimeStatus::Listening
        } else {
            runtime.status
        },
        port,
        configured_port: runtime.configured_port.max(configured_port),
        bound_port: if listening { runtime.bound_port } else { None },
        base_url: format!("http://127.0.0.1:{port}{BASE_PATH}"),
        openapi_url: format!("http://127.0.0.1:{port}{BASE_PATH}/openapi.json"),
        last_error: runtime.last_error,
        started_at: if listening { runtime.started_at } else { None },
        request_count: counters().0.load(Ordering::Relaxed),
        rejected_count: counters().1.load(Ordering::Relaxed),
        remote_allowed: false,
    }
}

/// 按设置应用启停（设置保存、启动恢复时调用）。
/// - 关闭 → stopped；
/// - 开启且未运行 → start；
/// - 开启且端口变化 → 先停旧监听，再绑新端口；
/// - 绑定失败 → 返回明确错误，同时把真实状态置为 failed（配置保持原样）。
pub fn apply(db: Arc<Db>) -> AppResult<RestStatus> {
    let settings = Settings::load(&db)?;
    let desired = settings.agent_api_port;
    let running = slot().lock().map(|g| g.is_some()).unwrap_or(false);
    if !settings.agent_api_enabled {
        if running {
            stop();
        } else if let Ok(mut rt) = runtime().lock() {
            rt.status = RestRuntimeStatus::Stopped;
            rt.bound_port = None;
            rt.started_at = None;
        }
        return Ok(status(&db));
    }
    if running {
        let bound = runtime_snapshot().bound_port;
        if bound == Some(desired) {
            return Ok(status(&db));
        }
        stop();
    }
    start(db.clone(), desired)
}

/// 启动：**先同步绑定端口**，成功后才登记 listening。
/// 并发 start 由 slot 锁串行化；重复 start 同一端口直接返回当前状态。
pub fn start(db: Arc<Db>, port: u16) -> AppResult<RestStatus> {
    if port == 0 {
        return Err(AppError::Validation("REST 端口不能为 0".into()));
    }
    if slot().lock().map(|g| g.is_some()).unwrap_or(false) {
        let bound = runtime_snapshot().bound_port;
        if bound == Some(port) {
            return Ok(status(&db));
        }
        return Err(AppError::Conflict(format!(
            "REST 已在端口 {} 监听；请先停止再切换端口",
            bound.unwrap_or(0)
        )));
    }
    let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
        Ok(listener) => listener,
        Err(err) => {
            if let Ok(mut rt) = runtime().lock() {
                rt.status = RestRuntimeStatus::Failed;
                rt.configured_port = port;
                rt.bound_port = None;
                rt.last_error = Some(format!("端口 {port} 绑定失败: {err}"));
                rt.started_at = None;
            }
            return Err(AppError::Unavailable(format!(
                "Agent REST 端口 {port} 绑定失败: {err}"
            )));
        }
    };
    listener.set_nonblocking(true).map_err(|err| {
        AppError::Unavailable(format!("设置监听非阻塞失败: {err}"))
    })?;
    if let Ok(mut rt) = runtime().lock() {
        rt.status = RestRuntimeStatus::Starting;
        rt.configured_port = port;
        rt.bound_port = None;
        rt.last_error = None;
        rt.started_at = None;
    }
    let shutdown = Arc::new(Notify::new());
    let finished = Arc::new(AtomicU64::new(0));
    let state = Arc::new(RestState {
        db: db.clone(),
        port,
        shutdown: shutdown.clone(),
        rate: Mutex::new(RateState {
            window: Instant::now(),
            count: 0,
        }),
    });
    // `from_std` 必须在运行时内调用，因此转换放在任务内部；绑定已在上面完成。
    let task = tauri::async_runtime::spawn(run_listener(listener, state, finished.clone()));
    {
        let mut guard = slot()
            .lock()
            .map_err(|_| AppError::Unavailable("REST 监听锁不可用".into()))?;
        *guard = Some(RunningRest {
            port,
            shutdown,
            task,
            finished,
        });
    }
    if let Ok(mut rt) = runtime().lock() {
        rt.status = RestRuntimeStatus::Listening;
        rt.bound_port = Some(port);
        rt.last_error = None;
        rt.started_at = Some(crate::agents::now_iso());
    }
    tracing::info!("Agent REST 监听 127.0.0.1:{port}{BASE_PATH}");
    Ok(status(&db))
}

/// 停止：发起关闭 → 等待任务结束（有界）→ 释放端口 → 清理状态。
pub fn stop() {
    let handle = slot().lock().ok().and_then(|mut g| g.take());
    let Some(handle) = handle else {
        if let Ok(mut rt) = runtime().lock() {
            if rt.status != RestRuntimeStatus::Failed {
                rt.status = RestRuntimeStatus::Stopped;
            }
            rt.bound_port = None;
            rt.started_at = None;
        }
        return;
    };
    if let Ok(mut rt) = runtime().lock() {
        rt.status = RestRuntimeStatus::Stopping;
    }
    handle.shutdown.notify_waiters();
    handle.task.abort();
    // tauri 2 的 async_runtime::JoinHandle 没有 is_finished()：
    // 用「监听端口是否已释放」作为任务真正结束的信号，仍保持 2 秒有界等待。
    let port = runtime().lock().ok().and_then(|rt| rt.bound_port);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
        if let Some(port) = port {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                break;
            }
        }
    }
    if let Ok(mut rt) = runtime().lock() {
        rt.status = RestRuntimeStatus::Stopped;
        rt.bound_port = None;
        rt.started_at = None;
    }
}

async fn run_listener(
    listener: std::net::TcpListener,
    state: Arc<RestState>,
    finished: Arc<AtomicU64>,
) {
    let _done = ListenerDone(finished);
    let listener = match TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("Agent REST 监听句柄转换失败: {err}");
            if let Ok(mut rt) = runtime().lock() {
                rt.status = RestRuntimeStatus::Failed;
                rt.last_error = Some(format!("监听句柄转换失败: {err}"));
                rt.bound_port = None;
            }
            return;
        }
    };
    loop {
        tokio::select! {
            _ = state.shutdown.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let io = TokioIo::new(stream);
                let state = state.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let state = state.clone();
                        async move { Ok::<_, Infallible>(handle(req, state).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .timer(hyper_util::rt::TokioTimer::new())
                        .serve_connection(io, service)
                        .await;
                });
            }
        }
    }
}

fn plain(status: StatusCode, body: Value, request_id: &str) -> Response<Full<Bytes>> {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header("cache-control", "no-store")
        .header("x-request-id", request_id)
        .body(Full::new(Bytes::from(data)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

fn meta_of(principal: &Principal, request_id: &str, page: Option<Page>) -> Meta {
    let meta = Meta::new(principal, request_id);
    match page {
        Some(page) => meta.with_page(page),
        None => meta,
    }
}

fn unauthorized(request_id: &str, detail: &str) -> Response<Full<Bytes>> {
    let principal = Principal::local(Source::Rest);
    let meta = Meta::new(&principal, request_id);
    plain(
        StatusCode::UNAUTHORIZED,
        json!({
            "success": false,
            "data": null,
            "error": { "code": "UNAUTHORIZED", "message": detail, "details": null, "retryable": false },
            "meta": serde_json::to_value(meta).unwrap_or(Value::Null),
        }),
        request_id,
    )
}

fn bearer(req: &Request<Incoming>) -> Option<String> {
    let raw = req.headers().get(AUTHORIZATION)?.to_str().ok()?.trim();
    raw.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}

fn authenticate(state: &RestState, req: &Request<Incoming>) -> Result<Principal, Response<Full<Bytes>>> {
    let request_id = format!("rest-{}", uuid::Uuid::new_v4().simple());
    let Some(token) = bearer(req) else {
        return Err(unauthorized(&request_id, "缺少 Authorization: Bearer <agent token>"));
    };
    if token.len() < 8 || token.chars().any(|c| c.is_control()) {
        return Err(unauthorized(&request_id, "token 格式非法"));
    }
    let row: Option<McpAgentRow> = state
        .db
        .with_read(|conn| auth::find_agent_by_token(conn, &token))
        .map_err(|_| unauthorized(&request_id, "数据库不可用"))?;
    match row {
        Some(row) => Ok(Principal::agent(row.row_id, row.agent_id, Source::Rest)),
        None => Err(unauthorized(&request_id, "token 无效或已撤销")),
    }
}

fn rate_check(state: &RestState) -> bool {
    let Ok(mut rate) = state.rate.lock() else {
        return false;
    };
    if rate.window.elapsed() >= Duration::from_secs(60) {
        rate.window = Instant::now();
        rate.count = 0;
    }
    rate.count += 1;
    rate.count <= RATE_LIMIT_PER_MIN
}

async fn handle(req: Request<Incoming>, state: Arc<RestState>) -> Response<Full<Bytes>> {
    let request_id = format!("rest-{}", uuid::Uuid::new_v4().simple());
    counters().0.fetch_add(1, Ordering::Relaxed);
    if req.headers().contains_key("origin") {
        counters().1.fetch_add(1, Ordering::Relaxed);
        return plain(
            StatusCode::FORBIDDEN,
            json!({ "success": false, "error": { "code": "FORBIDDEN", "message": "浏览器跨域请求被拒绝（本地 API 仅允许命令行 Agent）" } }),
            &request_id,
        );
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = parse_query(req.uri().query().unwrap_or(""));
    let principal = match authenticate(&state, &req) {
        Ok(p) => p,
        Err(resp) => {
            counters().1.fetch_add(1, Ordering::Relaxed);
            return resp;
        }
    };
    if !rate_check(&state) {
        counters().1.fetch_add(1, Ordering::Relaxed);
        return plain(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "success": false, "error": { "code": "RATE_LIMITED", "message": "超过每分钟 120 次限制", "retryable": true } }),
            &request_id,
        );
    }

    // 幂等：POST 且带 Idempotency-Key。
    let idempotency_key = req
        .headers()
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v.len() <= 128);
    let body = match read_body(req).await {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let body_hash = {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(&body);
        digest.iter().map(|b| format!("{:02x}", b)).collect::<String>()
    };
    if method == hyper::Method::POST {
        if let (Some(key), Some(row_id)) = (&idempotency_key, principal.agent_row_id.as_deref()) {
            if let Ok(Some((text, code))) = store::cache_lookup(&state.db, row_id, "rest", key) {
                if let Ok(mut value) = serde_json::from_str::<Value>(&text) {
                    if let Some(meta) = value.get_mut("meta") {
                        meta["replayed"] = json!(true);
                    }
                    return plain(
                        StatusCode::from_u16(code).unwrap_or(StatusCode::OK),
                        value,
                        &request_id,
                    );
                }
            }
        }
    }

    let result = tokio::time::timeout(
        REQUEST_TIMEOUT,
        dispatch(&state, &principal, &method, &path, &query, &body),
    )
    .await;
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(_) => {
            let meta = meta_of(&principal, &request_id, None);
            return plain(
                StatusCode::REQUEST_TIMEOUT,
                serde_json::to_value(Envelope::fail(
                    &AppError::Unavailable("请求超过 20 秒".into()),
                    meta,
                ))
                .unwrap_or(Value::Null),
                &request_id,
            );
        }
    };
    match outcome {
        Ok((data, page)) => {
            let meta = meta_of(&principal, &request_id, page);
            let envelope = Envelope::ok(data, meta);
            let value = serde_json::to_value(&envelope).unwrap_or(Value::Null);
            let status = if method == hyper::Method::POST {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            if method == hyper::Method::POST {
                if let (Some(key), Some(row_id)) = (&idempotency_key, principal.agent_row_id.as_deref()) {
                    let text = serde_json::to_string(&value).unwrap_or_default();
                    let _ = store::cache_store(
                        &state.db,
                        row_id,
                        "rest",
                        key,
                        &body_hash,
                        &text,
                        status.as_u16(),
                    );
                }
            }
            plain(status, value, &request_id)
        }
        Err(err) => {
            let code = error_code(&err);
            let status = StatusCode::from_u16(http_status(code)).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let meta = meta_of(&principal, &request_id, None);
            let envelope = Envelope::fail(&err, meta);
            let value = serde_json::to_value(&envelope).unwrap_or(Value::Null);
            store::log_activity(
                &state.db,
                &store::ActivityEntry {
                    principal: &principal,
                    action: "rest.failed",
                    resource_kind: "",
                    resource_id: "",
                    project_id: "",
                    request_id: &request_id,
                    success: false,
                    error_code: code,
                    detail: &err.user_message(),
                    revision: None,
                    duration_ms: 0,
                },
            );
            plain(status, value, &request_id)
        }
    }
}

async fn read_body(req: Request<Incoming>) -> Result<Vec<u8>, Response<Full<Bytes>>> {
    let request_id = format!("rest-{}", uuid::Uuid::new_v4().simple());
    if let Some(len) = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if len > MAX_BODY as u64 {
            return Err(plain(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "success": false, "error": { "code": "VALIDATION", "message": "body 超过 1MiB" } }),
                &request_id,
            ));
        }
    }
    let limited = Limited::new(req.into_body(), MAX_BODY);
    match limited.collect().await {
        Ok(collected) => Ok(collected.to_bytes().to_vec()),
        Err(_) => Err(plain(
            StatusCode::BAD_REQUEST,
            json!({ "success": false, "error": { "code": "VALIDATION", "message": "请求体不可读或超过 1MiB" } }),
            &request_id,
        )),
    }
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = url_decode(k);
        let value = url_decode(v);
        out.insert(key, value);
    }
    out
}

fn url_decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        match c {
            '%' => {
                let a = chars.next();
                let b = chars.next();
                if let (Some(a), Some(b)) = (a, b) {
                    if let Ok(byte) = u8::from_str_radix(&format!("{a}{b}"), 16) {
                        out.push(byte as char);
                        continue;
                    }
                }
            }
            '+' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

fn q_num(query: &HashMap<String, String>, key: &str, default: u32) -> u32 {
    query
        .get(key)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(1, 200)
}

fn q_off(query: &HashMap<String, String>) -> u32 {
    query
        .get("offset")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
}

fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> AppResult<T> {
    serde_json::from_slice(body)
        .map_err(|e| AppError::Validation(format!("请求体 JSON 非法: {e}")))
}

async fn dispatch(
    state: &RestState,
    principal: &Principal,
    method: &hyper::Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
) -> AppResult<(Value, Option<Page>)> {
    let db = state.db.as_ref();
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segments.first() != Some(&"api") || segments.get(1) != Some(&"v1") {
        return Err(AppError::NotFound(format!("未知路径 {path}")));
    }
    let rest = &segments[2..];
    let m = method.as_str();
    let seg = |i: usize| rest.get(i).copied().unwrap_or("");
    match (m, rest) {
        ("GET", ["status"]) => Ok((service::status_snapshot(db, principal)?, None)),
        ("GET", ["manifest"]) => Ok((workspace::manifest(db)?, None)),
        ("GET", ["openapi.json"]) => Ok((openapi(), None)),
        ("GET", ["projects"]) => {
            let (items, page) = service::list_projects(
                db,
                principal,
                query.get("kind").map(String::as_str),
                query.get("q").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["projects", _, "status"]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::project_status(db, principal, id)?)?, None))
        }
        ("GET", ["projects", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_project(db, principal, id)?)?, None))
        }
        ("GET", ["tasks"]) => {
            let filter = crate::commands::tasks::TaskFilter {
                view: query.get("view").cloned(),
                status: query.get("status").cloned(),
                category: query.get("category").cloned(),
                tag: query.get("tag").cloned(),
                priority: query.get("priority").and_then(|v| v.parse().ok()),
                search: query.get("q").or_else(|| query.get("search")).cloned(),
                sort: query.get("sort").cloned(),
                limit: None,
            };
            let (items, page) =
                service::list_tasks(db, principal, filter, q_num(query, "limit", 50), q_off(query))?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["tasks"]) => {
            let task = service::create_task(db, principal, parse_body(body)?)?;
            Ok((serde_json::to_value(task)?, None))
        }
        ("GET", ["tasks", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::fetch_task(db, principal, id)?)?, None))
        }
        ("PATCH", ["tasks", _]) => {
            let id = seg(1);
            let value: Value = parse_body(body)?;
            let base = value
                .get("base_revision")
                .and_then(Value::as_i64)
                .or_else(|| query.get("base_revision").and_then(|v| v.parse().ok()));
            let patch: service::TaskPatch = serde_json::from_value(value)
                .map_err(|e| AppError::Validation(format!("请求体字段非法: {e}")))?;
            Ok((
                serde_json::to_value(service::update_task(db, principal, id, patch, base)?)?,
                None,
            ))
        }
        ("POST", ["tasks", _, "complete"]) => {
            let id = seg(1);
            let base = query.get("base_revision").and_then(|v| v.parse().ok());
            Ok((
                serde_json::to_value(service::complete_task(db, principal, id, base)?)?,
                None,
            ))
        }
        ("GET", ["plans", "current"]) => {
            Ok((serde_json::to_value(service::current_plan(db, principal)?)?, None))
        }
        ("GET", ["plans"]) => {
            let project = query.get("project").map(String::as_str);
            let (items, page) =
                service::list_plans(db, principal, project, q_num(query, "limit", 50), q_off(query))?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["plans", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_plan(db, principal, id)?)?, None))
        }
        ("GET", ["knowledge", "search"]) => {
            let q = query.get("q").cloned().unwrap_or_default();
            if q.trim().is_empty() {
                return Err(AppError::Validation("缺少 q 查询参数".into()));
            }
            let kb_ids: Vec<String> = query
                .get("kb")
                .map(|v| vec![v.clone()])
                .unwrap_or_default();
            let (items, page) =
                service::search_knowledge(db, principal, &q, &kb_ids, q_num(query, "limit", 20), q_off(query))?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["knowledge", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(service::get_knowledge(db, principal, id)?)?, None))
        }
        ("POST", ["knowledge"]) => {
            let doc = service::create_knowledge(db, principal, parse_body(body)?)?;
            Ok((serde_json::to_value(doc)?, None))
        }
        ("PATCH", ["knowledge", _]) => {
            let id = seg(1);
            let patch: service::KnowledgePatch = parse_body(body)?;
            let base = query.get("base_revision").and_then(|v| v.parse().ok());
            Ok((
                serde_json::to_value(service::update_knowledge(db, principal, id, patch, base)?)?,
                None,
            ))
        }
        ("GET", ["decisions"]) => {
            let project = query.get("project").map(String::as_str);
            let status = query.get("status").map(String::as_str);
            let (items, page) = store::list_decisions(
                db,
                project,
                status,
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["decisions"]) => {
            super::permissions::require(
                db,
                principal,
                crate::mcp::permissions::Capability::DecisionsWrite,
                "",
            )?;
            let created = store::create_decision(db, principal, parse_body(body)?)?;
            Ok((serde_json::to_value(created)?, None))
        }
        ("GET", ["decisions", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(store::get_decision(db, id)?)?, None))
        }
        ("GET", ["context"]) => {
            let req = context::ContextRequest {
                task: query.get("task").cloned(),
                task_id: query.get("task_id").cloned(),
                project_id: query.get("project").cloned(),
                budget_tokens: query.get("budget").and_then(|v| v.parse().ok()),
                format: query.get("format").cloned(),
                ..Default::default()
            };
            let ctx = context::build(db, principal, req)?;
            if query.get("format").map(String::as_str) == Some("markdown") {
                Ok((json!({ "markdown": ctx.markdown }), None))
            } else {
                Ok((context::to_json(&ctx)?, None))
            }
        }
        ("GET", ["context", "search"]) => {
            let q = query.get("q").cloned().unwrap_or_default();
            let items = context::recent(db, principal, q_num(query, "limit", 20))?;
            let keywords: Vec<String> = q.split_whitespace().map(str::to_string).collect();
            let filtered: Vec<_> = items
                .into_iter()
                .filter(|i| {
                    let hay = format!("{} {}", i.title, i.summary).to_lowercase();
                    keywords.iter().any(|k| hay.contains(&k.to_lowercase()))
                })
                .collect();
            Ok((serde_json::to_value(filtered)?, None))
        }
        ("GET", ["agents", "handoffs"]) => {
            let (items, page) = handoff::list_handoffs(
                db,
                principal,
                query.get("status").map(String::as_str),
                query.get("project").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["agents", "handoffs"]) => {
            let created = handoff::create_handoff(db, principal, parse_body(body)?)?;
            Ok((serde_json::to_value(created)?, None))
        }
        ("GET", ["agents", "handoffs", _]) => {
            let id = seg(1);
            Ok((serde_json::to_value(handoff::get_handoff(db, principal, id)?)?, None))
        }
        ("POST", ["agents", "handoffs", _, "accept"]) => {
            let id = seg(1);
            let base = query
                .get("base_revision")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| AppError::Validation("需要 base_revision 查询参数".into()))?;
            Ok((serde_json::to_value(handoff::accept_handoff(db, principal, id, base)?)?, None))
        }
        ("POST", ["agents", "handoffs", _, "reject"]) => {
            let id = seg(1);
            let base = query
                .get("base_revision")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| AppError::Validation("需要 base_revision 查询参数".into()))?;
            let reason = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
                .unwrap_or_default();
            Ok((serde_json::to_value(handoff::reject_handoff(db, principal, id, base, &reason)?)?, None))
        }
        ("POST", ["agents", "handoffs", _, "complete"]) => {
            let id = seg(1);
            let base = query
                .get("base_revision")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| AppError::Validation("需要 base_revision 查询参数".into()))?;
            Ok((serde_json::to_value(handoff::complete_handoff(db, principal, id, base)?)?, None))
        }
        ("GET", ["agents", "reports"]) => {
            let (items, page) = handoff::list_reports(
                db,
                principal,
                query.get("agent").map(String::as_str),
                query.get("handoff").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("POST", ["agents", "reports"]) => {
            let out = handoff::create_report(db, principal, parse_body(body)?)?;
            Ok((serde_json::to_value(out)?, None))
        }
        ("GET", ["agents", "activity"]) => {
            let (items, page) = handoff::activity(
                db,
                principal,
                query.get("agent").map(String::as_str),
                query.get("interface").map(String::as_str),
                query.get("since").map(String::as_str),
                q_num(query, "limit", 50),
                q_off(query),
            )?;
            Ok((serde_json::to_value(items)?, Some(page)))
        }
        ("GET", ["sync", "status"]) => {
            Ok((serde_json::to_value(file_sync::status(db)?)?, None))
        }
        ("GET", ["sync", "conflicts"]) => {
            Ok((serde_json::to_value(file_sync::list_conflicts(db)?)?, None))
        }
        ("POST", ["sync", "conflicts", _, "resolve"]) => {
            let id = seg(1);
            let resolution = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("resolution").and_then(|r| r.as_str()).map(str::to_string))
                .or_else(|| query.get("resolution").cloned())
                .ok_or_else(|| AppError::Validation("需要 resolution: db|file|dismiss".into()))?;
            Ok((
                serde_json::to_value(file_sync::resolve_conflict(db, principal, id, &resolution)?)?,
                None,
            ))
        }
        ("POST", ["sync", "scan"]) => {
            let row = workspace::active(db)?
                .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
            // 调用者身份原样传入：REST 都是已认证 Agent，会被扫描入口拒绝。
            // 文件导入只能由本机用户/后台监听触发，避免「Agent 授权自己」。
            Ok((serde_json::to_value(file_sync::scan(db, principal, &row)?)?, None))
        }
        _ => Err(AppError::NotFound(format!("未知路由 {method} {path}"))),
    }
}

fn openapi() -> Value {
    let paths = ROUTES
        .iter()
        .map(|(method, path, summary)| {
            (
                path.to_string(),
                json!({
                    method.to_lowercase(): {
                        "summary": summary,
                        "responses": { "200": { "description": "统一 JSON 信封" } }
                    }
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "Task Dock Agent API",
            "version": super::SCHEMA_VERSION,
            "description": "本地 Agent 访问接口；仅监听 127.0.0.1，需 Bearer token；请求/响应均为统一信封。"
        },
        "servers": [{ "url": "http://127.0.0.1:<agent_api_port>/api/v1" }],
        "security": [{ "bearerAuth": [] }],
        "components": {
            "securitySchemes": {
                "bearerAuth": { "type": "http", "scheme": "bearer" }
            }
        },
        "paths": Value::Object(paths),
    })
}
