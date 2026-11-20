//! 手机接入 HTTPS 监听（局域网 IPv4：配对、探测与加密同步；v2 起 TLS-only）。
//!
//! 与 `agents/http_ingest` 的相同点：hyper 1.x、头部读取超时、请求体上限、
//! 连接/在途并发上限、退出信号驱动关闭。不同点：
//! - 绑定 `0.0.0.0`（由设置开关控制），不绑定回环；
//! - 每条连接先经 `mobile_sync::tls` 的自签证书 acceptor 完成 TLS 握手，
//!   **不存在明文回退**：明文客户端在握手处被拒绝（fail-closed）；
//! - 路由：`/v1/health`、`/v1/pair`、`/v1/ping`、同步的 `/v1/changes`、`/v1/ops`，
//!   以及文件互传的 `/v1/files`、`/v1/files/{id}/chunk/{index}`、`.../complete`、`.../delete`；
//! - 配对接口无鉴权（凭一次性码），其余接口用 Bearer 设备令牌；
//! - 同步与文件载荷用设备令牌哈希派生的密钥做 XSalsa20-Poly1305 加密，业务数据不明文上线。

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::db::Db;
use crate::error::AppError;
use crate::mobile_sync::files;
use crate::shelf;
use crate::mobile_sync::sync::{
    apply_push_with_trace, decrypt_envelope, derive_key, encrypt_envelope, pull_with_trace,
    PushRequest, AAD_PULL, AAD_PUSH, MAX_PULL_LIMIT, MAX_PUSH_OPS, SYNC_MAX_BODY,
};
use crate::mobile_sync::{
    authenticate_device, complete_pairing, hash_token, MobileDevice, MobileSyncState, PairFailure,
    PairRequest, API_VERSION,
};
use crate::mobile_sync::tls::TlsIdentity;

/// 配对/探测请求体上限：只接受很小的 JSON，杜绝大包占用内存。
const MAX_BODY: usize = 4 * 1024;
/// 同时存活连接上限；手机端只会有一个配对/心跳连接。
const MAX_CONNECTIONS: usize = 16;
/// 同时处理中的请求上限；超出返回 429 + Retry-After。
const MAX_INFLIGHT: usize = 8;
/// TLS 握手独立超时：TCP 已建立但不发送握手数据的客户端（扫描器、半开连接、
/// 断网但未 RST 的客户端）必须在有限时间内被释放，否则 16 个连接额度会被
/// 慢慢占满，正常手机再也连不上。5 秒覆盖局域网与移动网络的正常握手。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 单个分块请求体上限：192KB 明文 base64 后约 256KB，信封 JSON 再留一倍余量。
const FILE_CHUNK_BODY_MAX: usize = 512 * 1024;

pub struct ServerCtx {
    db: Arc<Db>,
    state: MobileSyncState,
    request_sem: Arc<Semaphore>,
    /// TLS-only 身份：所有连接必须先过这一关，没有明文路径。
    tls: TlsIdentity,
    /// 按设备会话关联的链路 ID：同一设备一次同步周期内的分页 pull / push /
    /// 后续 pull 共用同一 trace_id。只用于诊断事件关联，**不参与鉴权**；
    /// 进程内有界 Map，撤销设备后不主动清理（条目数受配对设备数约束）。
    trace_sessions: Arc<Mutex<HashMap<String, String>>>,
}

/// 会话 trace 映射的条目上限：配对设备数量很少，超限后淘汰一个任意旧条目兜底。
const MAX_TRACE_SESSIONS: usize = 32;

/// 解析本次同步请求应使用的链路 ID（按设备会话关联）：
///
/// - 外部传入合法（16 位小写 hex）→ 采用并记入会话，后续请求沿用；
/// - 非法 / 缺失 → 沿用本设备已有会话 trace；仍无则新生成；
/// - 非法值静默丢弃，**不拒绝请求、不透传原值**；trace 绝不进入鉴权判断。
///
/// 显式传参：返回值随 pull/push 参数与诊断事件携带，跨 `.await` 不依赖线程局部上下文。
fn resolve_session_trace(
    sessions: &Mutex<HashMap<String, String>>,
    device_id: &str,
    incoming: Option<&str>,
) -> String {
    let validated = incoming.and_then(|raw| crate::diagnostics::trace::validate_external_id(raw));
    let mut map = sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(trace) = validated {
        map.insert(device_id.to_string(), trace.clone());
        return trace;
    }
    if let Some(existing) = map.get(device_id) {
        return existing.clone();
    }
    let trace = crate::diagnostics::trace::new_trace_id();
    if map.len() >= MAX_TRACE_SESSIONS {
        if let Some(oldest) = map.keys().next().cloned() {
            map.remove(&oldest);
        }
    }
    map.insert(device_id.to_string(), trace.clone());
    trace
}

/// 绑定局域网全部 IPv4 接口。Windows 防火墙首次可能弹窗询问，属预期行为。
pub async fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(("0.0.0.0", port)).await
}

/// hyper 1.x 设置 header_read_timeout 时必须提供 timer，否则连接会 panic。
fn http1_builder() -> hyper::server::conn::http1::Builder {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .keep_alive(true)
        .header_read_timeout(HEADER_TIMEOUT)
        .timer(TokioTimer::new());
    builder
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from(data)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response<Full<Bytes>> {
    json_response(status, json!({ "error": code, "message": message }))
}

async fn read_body(
    req: Request<Incoming>,
    max: usize,
) -> Result<Vec<u8>, Response<Full<Bytes>>> {
    if let Some(len) = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if len > max as u64 {
            return Err(api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "请求体超过上限",
            ));
        }
    }
    let limited = Limited::new(req.into_body(), max);
    match tokio::time::timeout(BODY_TIMEOUT, limited.collect()).await {
        Ok(Ok(collected)) => Ok(collected.to_bytes().to_vec()),
        Ok(Err(_)) => Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "请求体超过上限或无法读取",
        )),
        Err(_) => Err(api_error(
            StatusCode::REQUEST_TIMEOUT,
            "body_timeout",
            "读取请求体超时",
        )),
    }
}

fn bearer_token(req: &Request<Incoming>) -> Option<String> {
    req.headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

async fn acquire_inflight(ctx: &ServerCtx) -> Result<OwnedSemaphorePermit, Response<Full<Bytes>>> {
    ctx.request_sem.clone().try_acquire_owned().map_err(|_| {
        let mut resp = api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_requests",
            "请求过多，请稍后重试",
        );
        resp.headers_mut()
            .insert("Retry-After", hyper::header::HeaderValue::from_static("1"));
        resp
    })
}

async fn handle_pair(req: Request<Incoming>, ctx: Arc<ServerCtx>, peer: SocketAddr) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    let body = match read_body(req, MAX_BODY).await {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let request: PairRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "请求必须是 JSON，且包含 code / device_name / platform",
            )
        }
    };
    if request.code.trim().len() != 6 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "配对码必须是 6 位数字");
    }

    let db = ctx.db.clone();
    let state = ctx.state.clone();
    let peer_ip = Some(peer.ip().to_string());
    let result = tokio::task::spawn_blocking(move || {
        complete_pairing(&db, &state, request, peer_ip)
    })
    .await;

    match result {
        Ok(Ok(outcome)) => json_response(
            StatusCode::OK,
            json!({
                "token": outcome.token,
                "device_id": outcome.device_id,
                "server_name": outcome.server_name,
                "api_version": outcome.api_version,
                "paired_at": outcome.paired_at,
            }),
        ),
        Ok(Err(PairFailure::InvalidCode)) => {
            tracing::info!("手机配对失败：配对码错误");
            api_error(StatusCode::UNAUTHORIZED, "invalid_code", "配对码错误，请核对桌面端显示")
        }
        Ok(Err(PairFailure::TooManyAttempts)) => {
            tracing::warn!("手机配对失败：尝试次数过多");
            let mut resp = api_error(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_attempts",
                "尝试次数过多，请在桌面端重新生成配对码",
            );
            resp.headers_mut()
                .insert("Retry-After", hyper::header::HeaderValue::from_static("1"));
            resp
        }
        Ok(Err(PairFailure::Closed)) => api_error(
            StatusCode::CONFLICT,
            "pairing_closed",
            "配对已结束或已过期，请在桌面端重新生成配对码",
        ),
        Err(join_error) => {
            tracing::warn!("手机配对任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "配对处理失败，请重试",
            )
        }
    }
}

async fn handle_ping(req: Request<Incoming>, ctx: Arc<ServerCtx>, peer: SocketAddr) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let Some(token) = bearer_token(&req) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthorized", "缺少设备令牌");
    };
    let db = ctx.db.clone();
    let ip = Some(peer.ip().to_string());
    let device = tokio::task::spawn_blocking(move || authenticate_device(&db, &token, ip.as_deref()))
        .await;

    match device {
        Ok(Ok(Some(device))) => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "api_version": API_VERSION,
                "server_name": ctx.state.server_name(),
                "device_id": device.id,
                "device_name": device.name,
                "now": chrono::Utc::now().to_rfc3339(),
            }),
        ),
        Ok(Ok(None)) => api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "设备令牌无效或已被撤销",
        ),
        Ok(Err(e)) => {
            tracing::warn!("手机心跳鉴权失败: {e}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "服务器处理失败，请重试",
            )
        }
        Err(join_error) => {
            tracing::warn!("手机心跳任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "服务器处理失败，请重试",
            )
        }
    }
}

/// Bearer 鉴权：成功时同时返回设备与令牌哈希（后者用于派生同步密钥）。
///
/// 令牌哈希只在本进程内用于 KDF，不回写响应、不写日志。
async fn authenticate_request(
    req: &Request<Incoming>,
    ctx: &Arc<ServerCtx>,
    peer: SocketAddr,
) -> Result<(MobileDevice, String), Response<Full<Bytes>>> {
    let Some(token) = bearer_token(req) else {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "缺少设备令牌",
        ));
    };
    let token_hash = hash_token(&token);
    let db = ctx.db.clone();
    let ip = Some(peer.ip().to_string());
    let result =
        tokio::task::spawn_blocking(move || authenticate_device(&db, &token, ip.as_deref())).await;
    match result {
        Ok(Ok(Some(device))) => Ok((device, token_hash)),
        Ok(Ok(None)) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "设备令牌无效或已被撤销",
        )),
        Ok(Err(error)) => {
            tracing::warn!("手机同步鉴权失败: {error}");
            Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "服务器处理失败，请重试",
            ))
        }
        Err(join_error) => {
            tracing::warn!("手机同步鉴权任务异常: {join_error}");
            Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "服务器处理失败，请重试",
            ))
        }
    }
}

/// 解析 `since` / `limit`；非法值按默认值处理，不把解析细节回给客户端。
fn parse_pull_query(query: Option<&str>) -> (i64, usize) {
    let mut since = 0i64;
    let mut limit = MAX_PULL_LIMIT;
    if let Some(raw) = query {
        for pair in raw.split('&') {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next().unwrap_or("");
            let value = parts.next().unwrap_or("");
            match key {
                "since" => since = value.parse::<i64>().unwrap_or(0).max(0),
                "limit" => {
                    limit = value
                        .parse::<usize>()
                        .unwrap_or(MAX_PULL_LIMIT)
                        .clamp(1, MAX_PULL_LIMIT)
                }
                _ => {}
            }
        }
    }
    (since, limit)
}

/// GET /v1/changes：响应为加密信封，游标在查询参数里（不含业务数据）。
async fn handle_changes(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    // 链路 trace 在鉴权之后解析：trace 不参与设备信任判断，只做诊断关联。
    let trace = resolve_session_trace(&ctx.trace_sessions, &device.id, None);
    let (since, limit) = parse_pull_query(req.uri().query());
    let db = ctx.db.clone();
    let trace_for_task = trace.clone();
    let result =
        tokio::task::spawn_blocking(move || pull_with_trace(&db, since, limit, Some(&trace_for_task)))
            .await;
    let key = derive_key(&token_hash);

    match result {
        Ok(Ok(page)) => {
            let changes_len = page.changes.len();
            crate::diagnostics::event(
                crate::diagnostics::DiagLevel::Info,
                "mobile_sync",
                "pull",
                "success",
            )
            .trace(&trace)
            .metadata("changes", serde_json::json!(changes_len))
            .emit();
            match serde_json::to_value(page) {
                Ok(value) => match encrypt_envelope(&key, AAD_PULL, &value) {
                    Ok(envelope) => json_response(StatusCode::OK, envelope),
                    Err(error) => {
                        tracing::warn!("手机同步响应加密失败: {error}");
                        api_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal_error",
                            "同步处理失败，请重试",
                        )
                    }
                },
                Err(error) => {
                    tracing::warn!("手机同步响应序列化失败: {error}");
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "同步处理失败，请重试",
                    )
                }
            }
        }
        Ok(Err(error)) => {
            crate::diagnostics::event(
                crate::diagnostics::DiagLevel::Warn,
                "mobile_sync",
                "pull",
                "failed",
            )
            .trace(&trace)
            .from_error(&error)
            .emit();
            tracing::warn!("手机同步拉取失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "同步处理失败，请重试",
            )
        }
        Err(join_error) => {
            crate::diagnostics::event(
                crate::diagnostics::DiagLevel::Error,
                "mobile_sync",
                "pull",
                "failed",
            )
            .trace(&trace)
            .metadata("join", serde_json::json!(join_error.to_string()))
            .emit();
            tracing::warn!("手机同步拉取任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "同步处理失败，请重试",
            )
        }
    }
}

/// POST /v1/ops：请求与响应都是加密信封；op_id 幂等，冲突不覆盖。
async fn handle_ops(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match read_body(req, SYNC_MAX_BODY).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let envelope: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "请求必须是加密信封 JSON",
            )
        }
    };
    let data = match decrypt_envelope(&key, AAD_PUSH, &envelope) {
        Ok(value) => value,
        Err(reason) => {
            // 不把解密失败细节回给客户端，只保留诊断日志（不含密文/密钥）。
            tracing::warn!("手机同步载荷解密失败: {reason}");
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "同步载荷无效",
            );
        }
    };
    let request: PushRequest = match serde_json::from_value(data) {
        Ok(value) => value,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "同步载荷字段不完整",
            )
        }
    };
    if request.device_id != device.id {
        return api_error(
            StatusCode::FORBIDDEN,
            "permission_denied",
            "设备身份与令牌不匹配",
        );
    }
    if request.ops.len() > MAX_PUSH_OPS {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "单批操作过多",
        );
    }

    // 鉴权与设备身份确认后才解析链路 trace：外部传入值经 validate_external_id
    // 校验，非法丢弃并沿用/生成会话 trace；trace 不参与任何鉴权判断。
    let incoming_trace = request.trace_id.clone();
    let trace = resolve_session_trace(&ctx.trace_sessions, &device.id, incoming_trace.as_deref());
    let db = ctx.db.clone();
    let device_id = device.id.clone();
    let ops = request.ops;
    let trace_for_task = trace.clone();
    let result = tokio::task::spawn_blocking(move || {
        apply_push_with_trace(&db, &device_id, &ops, Some(&trace_for_task))
    })
    .await;
    match result {
        Ok(Ok(mut response)) => {
            // 回传会话解析后的合法 trace；非法请求值已在 resolve 阶段丢弃，不原样回显。
            response.trace_id = Some(trace.clone());
            let ack_len = response.ack.len();
            let conflict_len = response.conflicts.len();
            crate::diagnostics::event(
                crate::diagnostics::DiagLevel::Info,
                "mobile_sync",
                "push",
                "success",
            )
            .trace(&trace)
            .metadata("ack", serde_json::json!(ack_len))
            .metadata("conflicts", serde_json::json!(conflict_len))
            .emit();
            match serde_json::to_value(response) {
                Ok(value) => match encrypt_envelope(&key, AAD_PUSH, &value) {
                    Ok(envelope) => json_response(StatusCode::OK, envelope),
                    Err(error) => {
                        tracing::warn!("手机同步响应加密失败: {error}");
                        api_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal_error",
                            "同步处理失败，请重试",
                        )
                    }
                },
                Err(error) => {
                    tracing::warn!("手机同步响应序列化失败: {error}");
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "同步处理失败，请重试",
                    )
                }
            }
        }
        Ok(Err(error)) => {
            crate::diagnostics::event(
                crate::diagnostics::DiagLevel::Warn,
                "mobile_sync",
                "push",
                "failed",
            )
            .trace(&trace)
            .from_error(&error)
            .emit();
            tracing::warn!("手机同步写入失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "同步处理失败，请重试",
            )
        }
        Err(join_error) => {
            crate::diagnostics::event(
                crate::diagnostics::DiagLevel::Error,
                "mobile_sync",
                "push",
                "failed",
            )
            .trace(&trace)
            .metadata("join", serde_json::json!(join_error.to_string()))
            .emit();
            tracing::warn!("手机同步写入任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "同步处理失败，请重试",
            )
        }
    }
}

/// 文件互传子路由：与同步接口共用 Bearer 鉴权与加密信封。
enum FileRoute {
    List,
    Create,
    DownloadChunk { id: String, index: u64 },
    UploadChunk { id: String, index: u64 },
    Complete { id: String },
    Delete { id: String },
    /// 把本设备已上传完成的文件以托管副本导入桌面暂存架。
    Shelf { id: String },
}

enum FileRouteMatch {
    Route(FileRoute),
    NotFound,
    MethodNotAllowed,
}

fn is_file_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 解析文件路由；`None` 表示不是文件路径，交回通用路由。
fn parse_file_route(method: &str, path: &str) -> Option<FileRouteMatch> {
    if path == "/v1/files" {
        return Some(match method {
            "GET" => FileRouteMatch::Route(FileRoute::List),
            "POST" => FileRouteMatch::Route(FileRoute::Create),
            _ => FileRouteMatch::MethodNotAllowed,
        });
    }
    let rest = path.strip_prefix("/v1/files/")?;
    let segments: Vec<&str> = rest.split('/').collect();
    let id = segments.first().copied().unwrap_or("");
    if !is_file_id(id) {
        return Some(FileRouteMatch::NotFound);
    }
    let route = match (method, segments.as_slice()) {
        ("GET", [_, "chunk", index]) => index
            .parse::<u64>()
            .ok()
            .map(|index| FileRoute::DownloadChunk { id: id.to_string(), index }),
        ("POST", [_, "chunk", index]) => index
            .parse::<u64>()
            .ok()
            .map(|index| FileRoute::UploadChunk { id: id.to_string(), index }),
        ("POST", [_, "complete"]) => Some(FileRoute::Complete { id: id.to_string() }),
        ("POST", [_, "delete"]) => Some(FileRoute::Delete { id: id.to_string() }),
        ("POST", [_, "shelf"]) => Some(FileRoute::Shelf { id: id.to_string() }),
        _ => None,
    };
    Some(match route {
        Some(route) => FileRouteMatch::Route(route),
        None => FileRouteMatch::MethodNotAllowed,
    })
}

async fn dispatch_file_route(
    route: FileRoute,
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    match route {
        FileRoute::List => handle_files_list(req, ctx, peer).await,
        FileRoute::Create => handle_file_create(req, ctx, peer).await,
        FileRoute::DownloadChunk { id, index } => {
            handle_file_chunk_download(req, ctx, peer, id, index).await
        }
        FileRoute::UploadChunk { id, index } => {
            handle_file_chunk_upload(req, ctx, peer, id, index).await
        }
        FileRoute::Complete { id } => handle_file_complete(req, ctx, peer, id).await,
        FileRoute::Delete { id } => handle_file_delete(req, ctx, peer, id).await,
        FileRoute::Shelf { id } => handle_file_shelf(req, ctx, peer, id).await,
    }
}

/// 加密 JSON 响应：文件接口与同步接口一样，业务字段不进明文。
fn encrypted_response(key: &[u8; 32], aad: &str, value: Value) -> Response<Full<Bytes>> {
    match encrypt_envelope(key, aad, &value) {
        Ok(envelope) => json_response(StatusCode::OK, envelope),
        Err(error) => {
            tracing::warn!("手机文件互传响应加密失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

fn file_error(error: AppError) -> Response<Full<Bytes>> {
    match error {
        AppError::NotFound(message) => api_error(StatusCode::NOT_FOUND, "not_found", &message),
        AppError::Conflict(message) => api_error(StatusCode::CONFLICT, "conflict", &message),
        AppError::Validation(message) => {
            api_error(StatusCode::BAD_REQUEST, "invalid_request", &message)
        }
        other => {
            tracing::warn!("手机文件互传失败: {other}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

fn parse_envelope(body: &[u8]) -> Result<Value, Response<Full<Bytes>>> {
    serde_json::from_slice(body).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "请求必须是加密信封 JSON",
        )
    })
}

#[derive(serde::Deserialize)]
struct CreateFileRequest {
    name: String,
    size: u64,
}

#[derive(serde::Deserialize)]
struct ChunkPayload {
    data: String,
}

/// GET /v1/files：可下载的 `to_phone` 文件 + 本机上传记录。
async fn handle_files_list(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let db = ctx.db.clone();
    let device_id = device.id.clone();
    let result = tokio::task::spawn_blocking(move || files::list_for_device(&db, &device_id)).await;
    let key = derive_key(&token_hash);
    match result {
        Ok(Ok(list)) => encrypted_response(&key, files::AAD_FILES_LIST, json!({ "files": list })),
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机文件列表任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// POST /v1/files：手机创建上传记录，返回分块参数。
async fn handle_file_create(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match read_body(req, SYNC_MAX_BODY).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let envelope = match parse_envelope(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let data = match decrypt_envelope(&key, files::AAD_FILE_CREATE, &envelope) {
        Ok(value) => value,
        Err(reason) => {
            tracing::warn!("手机文件创建载荷解密失败: {reason}");
            return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件载荷无效");
        }
    };
    let request: CreateFileRequest = match serde_json::from_value(data) {
        Ok(value) => value,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "文件载荷字段不完整",
            )
        }
    };

    let db = ctx.db.clone();
    let root = ctx.state.files_root().to_path_buf();
    let device_id = device.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        files::create_upload(&db, &root, &device_id, &request.name, request.size)
    })
    .await;
    match result {
        Ok(Ok(file)) => {
            encrypted_response(&key, files::AAD_FILE_CREATE, json!({ "file": file }))
        }
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机文件创建任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// GET /v1/files/{id}/chunk/{index}：下载一个分块（base64 放进加密信封）。
async fn handle_file_chunk_download(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
    id: String,
    index: u64,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let aad = files::aad_file_chunk("GET", &id, index);
    let db = ctx.db.clone();
    let root = ctx.state.files_root().to_path_buf();
    let device_id = device.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        files::read_chunk(&db, &root, Some(&device_id), &id, index)
    })
    .await;
    let key = derive_key(&token_hash);
    match result {
        Ok(Ok(bytes)) => encrypted_response(
            &key,
            &aad,
            json!({ "index": index, "data": STANDARD.encode(bytes) }),
        ),
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机文件分块读取任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// POST /v1/files/{id}/chunk/{index}：上传一个分块。
async fn handle_file_chunk_upload(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
    id: String,
    index: u64,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match read_body(req, FILE_CHUNK_BODY_MAX).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let aad = files::aad_file_chunk("POST", &id, index);
    let envelope = match parse_envelope(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let data = match decrypt_envelope(&key, &aad, &envelope) {
        Ok(value) => value,
        Err(reason) => {
            tracing::warn!("手机文件分块载荷解密失败: {reason}");
            return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件载荷无效");
        }
    };
    let payload: ChunkPayload = match serde_json::from_value(data) {
        Ok(value) => value,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "文件分块字段不完整",
            )
        }
    };
    let bytes = match STANDARD.decode(payload.data) {
        Ok(bytes) => bytes,
        Err(_) => {
            return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件分块不是合法 base64")
        }
    };
    if bytes.is_empty() || bytes.len() as u64 > files::CHUNK_BYTES {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件分块长度非法");
    }

    let db = ctx.db.clone();
    let device_id = device.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        files::write_chunk(&db, &device_id, &id, index, &bytes)
    })
    .await;
    match result {
        Ok(Ok(file)) => encrypted_response(&key, &aad, json!({ "file": file })),
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机文件分块写入任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// POST /v1/files/{id}/complete：校验并落盘到 inbox。
async fn handle_file_complete(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
    id: String,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match read_body(req, MAX_BODY).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let aad = files::aad_file_complete(&id);
    let envelope = match parse_envelope(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Err(reason) = decrypt_envelope(&key, &aad, &envelope) {
        tracing::warn!("手机文件完成载荷解密失败: {reason}");
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件载荷无效");
    }

    let db = ctx.db.clone();
    let root = ctx.state.files_root().to_path_buf();
    let device_id = device.id.clone();
    let result =
        tokio::task::spawn_blocking(move || files::complete_upload(&db, &root, &device_id, &id))
            .await;
    match result {
        Ok(Ok(file)) => encrypted_response(&key, &aad, json!({ "file": file })),
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机文件完成落盘任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// POST /v1/files/{id}/delete：删除记录与磁盘副本（手机可删自己的上传/已下载文件）。
async fn handle_file_delete(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
    id: String,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match read_body(req, MAX_BODY).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let aad = files::aad_file_delete(&id);
    let envelope = match parse_envelope(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Err(reason) = decrypt_envelope(&key, &aad, &envelope) {
        tracing::warn!("手机文件删除载荷解密失败: {reason}");
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件载荷无效");
    }

    let db = ctx.db.clone();
    let root = ctx.state.files_root().to_path_buf();
    let device_id = device.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        files::delete_file(&db, &root, Some(&device_id), &id)
    })
    .await;
    match result {
        Ok(Ok(deleted)) => encrypted_response(&key, &aad, json!({ "deleted": deleted })),
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机文件删除任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// POST /v1/files/{id}/shelf：把本设备已上传完成的文件以托管副本导入桌面暂存架。
///
/// 与删除接口同一套鉴权：记录方向/归属/状态由 `files::import_to_shelf` 再校验，
/// 手机端只能引用传输记录 ID，不能指定任何桌面路径。`group_id` 缺省表示默认分组；
/// 传入不存在的分组会在复制前失败，不留下条目。
async fn handle_file_shelf(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
    id: String,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match read_body(req, MAX_BODY).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let aad = files::aad_file_shelf(&id);
    let envelope = match parse_envelope(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let payload = match decrypt_envelope(&key, &aad, &envelope) {
        Ok(value) => value,
        Err(reason) => {
            tracing::warn!("手机暂存架导入载荷解密失败: {reason}");
            return api_error(StatusCode::BAD_REQUEST, "invalid_request", "文件载荷无效");
        }
    };
    let group_id = match payload.get("group_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.chars().count() > 128 {
                return api_error(StatusCode::BAD_REQUEST, "invalid_request", "暂存分组不合法");
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(_) => {
            return api_error(StatusCode::BAD_REQUEST, "invalid_request", "暂存分组不合法");
        }
    };

    let db = ctx.db.clone();
    let files_root = ctx.state.files_root().to_path_buf();
    let shelf_root = ctx.state.data_dir().join("shelf");
    let device_id = device.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        files::import_to_shelf(&db, &files_root, &shelf_root, &device_id, &id, group_id.as_deref())
    })
    .await;
    match result {
        Ok(Ok(file)) => encrypted_response(&key, &aad, json!({ "file": file })),
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机暂存架导入任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "文件处理失败，请重试",
            )
        }
    }
}

/// GET /v1/shelf/groups：已配对设备读取有效暂存分组（只读，用于手机选择导入位置）。
///
/// 只回分组元数据（id/name/builtin），不回条目数/排序/路径；与同步/文件接口
/// 共用 Bearer 鉴权与加密信封。
async fn handle_shelf_groups(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Response<Full<Bytes>> {
    let _permit = match acquire_inflight(&ctx).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let (_device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let key = derive_key(&token_hash);
    let db = ctx.db.clone();
    let result = tokio::task::spawn_blocking(move || shelf::list_groups(&db)).await;
    match result {
        Ok(Ok(groups)) => {
            // 契约 2.2：只回 id/name/builtin；不下发 item_count（暂存架条目总数）与 sort_order。
            let payload = json!({
                "groups": groups
                    .iter()
                    .map(|g| json!({ "id": g.id, "name": g.name, "builtin": g.builtin }))
                    .collect::<Vec<_>>()
            });
            encrypted_response(&key, files::AAD_SHELF_GROUPS, payload)
        }
        Ok(Err(error)) => file_error(error),
        Err(join_error) => {
            tracing::warn!("手机暂存分组读取任务异常: {join_error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "读取暂存分组失败，请重试",
            )
        }
    }
}

async fn handle_health() -> Response<Full<Bytes>> {
    json_response(
        StatusCode::OK,
        json!({ "ok": true, "service": "taskdock-mobile-sync", "api_version": API_VERSION }),
    )
}

async fn route(
    req: Request<Incoming>,
    ctx: Arc<ServerCtx>,
    peer: SocketAddr,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // 文件互传子路由先于通用路由解析：路径带 id/分块序号，不能走精确匹配。
    if let Some(parsed) = parse_file_route(method.as_str(), &path) {
        let response = match parsed {
            FileRouteMatch::Route(route) => dispatch_file_route(route, req, ctx, peer).await,
            FileRouteMatch::NotFound => {
                api_error(StatusCode::NOT_FOUND, "not_found", "文件不存在")
            }
            FileRouteMatch::MethodNotAllowed => {
                let mut resp = api_error(
                    StatusCode::METHOD_NOT_ALLOWED,
                    "method_not_allowed",
                    "方法不允许",
                );
                resp.headers_mut()
                    .insert(ALLOW, hyper::header::HeaderValue::from_static("GET, POST"));
                resp
            }
        };
        tracing::debug!("手机接入 {} {} -> {}", method, path, response.status());
        return Ok(response);
    }

    let response = match (method.as_str(), path.as_str()) {
        ("GET", "/v1/health") => handle_health().await,
        ("POST", "/v1/pair") => handle_pair(req, ctx, peer).await,
        ("GET", "/v1/ping") => handle_ping(req, ctx, peer).await,
        ("GET", "/v1/changes") => handle_changes(req, ctx, peer).await,
        ("POST", "/v1/ops") => handle_ops(req, ctx, peer).await,
        ("GET", "/v1/shelf/groups") => handle_shelf_groups(req, ctx, peer).await,
        ("GET" | "POST", "/v1/health" | "/v1/pair" | "/v1/ping" | "/v1/changes" | "/v1/ops") => {
            let mut resp = api_error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "方法不允许");
            resp.headers_mut()
                .insert(ALLOW, hyper::header::HeaderValue::from_static("GET, POST"));
            resp
        }
        _ => api_error(StatusCode::NOT_FOUND, "not_found", "接口不存在"),
    };
    // 端口与路由信息可用于诊断，但不记录 Authorization / 请求体 / 设备名。
    tracing::debug!("手机接入 {} {} -> {}", method, path, response.status());
    Ok(response)
}

async fn handle_conn(stream: TcpStream, peer: SocketAddr, ctx: Arc<ServerCtx>) {
    // v2 起 TLS-only：握手失败（明文 HTTP、端口扫描、协议不匹配）直接断开，
    // 不发送任何 HTTP 响应，也不回退明文。
    // 握手必须有自己的超时：`accept()` 在客户端不发数据时会一直等待，
    // 而连接信号量是在这里持有时才释放——没有超时等于把额度交给对端控制。
    let tls_stream = match tokio::time::timeout(HANDSHAKE_TIMEOUT, ctx.tls.acceptor().accept(stream))
        .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            // 只记错误分类，不记对端提供的任何证书/主机名细节。
            tracing::debug!("手机接入 TLS 握手失败（可能为明文客户端或扫描）: {error}");
            return;
        }
        Err(_) => {
            tracing::debug!("手机接入 TLS 握手超时（客户端未在限期内发送握手数据），已释放连接");
            return;
        }
    };
    let service = service_fn(move |req: Request<Incoming>| {
        let ctx = ctx.clone();
        async move { route(req, ctx, peer).await }
    });
    let conn = http1_builder().serve_connection(TokioIo::new(tls_stream), service);
    if tokio::time::timeout(REQUEST_TIMEOUT, conn).await.is_err() {
        tracing::debug!("手机接入连接处理超时（peer 已连接）");
    }
}

/// TLS 端口上不能写明文 HTTP 响应：连接满时直接断开 TCP，
/// 客户端表现为握手失败/连接重置，与本端口「无明文」的硬约束一致。
async fn reject_busy(mut stream: TcpStream) {
    let _ = stream.shutdown().await;
}

/// 监听循环：跟随设置启停/端口变更与应用退出信号。`tls` 由主管在绑定前加载。
pub async fn serve(
    listener: TcpListener,
    db: Arc<Db>,
    state: MobileSyncState,
    port: u16,
    tls: TlsIdentity,
) {
    let ctx = Arc::new(ServerCtx {
        db: db.clone(),
        state,
        request_sem: Arc::new(Semaphore::new(MAX_INFLIGHT)),
        tls,
        trace_sessions: Arc::new(Mutex::new(HashMap::new())),
    });
    let conn_sem = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    // 在途连接任务台账：监听器退出（关服务/换端口/应用退出）时必须把它们一起
    // 收掉，否则旧端口上的请求会在监听关闭后继续跑，任务与连接会累积。
    let mut conns: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        // 已完成任务及时出账（台账本身受 MAX_CONNECTIONS 约束，不会无界增长）。
        conns.retain(|handle| !handle.is_finished());
        tokio::select! {
            _ = crate::agents::shutdown_signal::wait() => {
                tracing::info!("应用退出：关闭手机接入监听");
                break;
            }
            _ = tick.tick() => {
                let settings = crate::db::Settings::load(&db).unwrap_or_default();
                if !settings.mobile_sync_enabled || settings.mobile_sync_port != port {
                    tracing::info!("手机接入配置变更，重新绑定监听");
                    break;
                }
                if !ctx.state.is_running() {
                    // 状态被外部重置（例如启停竞态）：退出让主管重新评估，
                    // 避免出现「监听在跑但状态显示已停」的分裂。
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        match conn_sem.clone().try_acquire_owned() {
                            Ok(permit) => {
                                let ctx = ctx.clone();
                                conns.push(tokio::spawn(async move {
                                    let _permit: OwnedSemaphorePermit = permit;
                                    handle_conn(stream, peer, ctx).await;
                                }));
                            }
                            Err(_) => {
                                conns.push(tokio::spawn(reject_busy(stream)));
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("手机接入 accept 失败: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    }

    // 监听器已停止：中止遗留连接任务，保证端口与连接额度随服务关闭一起回收。
    drop(listener);
    let leftover = conns.len();
    for handle in conns.drain(..) {
        handle.abort();
    }
    if leftover > 0 {
        tracing::info!("手机接入关闭：已中止 {leftover} 个在途连接任务");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_sync::{hash_token, tls, PairRequest};
    use std::path::PathBuf;
    use std::sync::OnceLock;

    /// 全测试共享一份 TLS 身份：RSA-3072 生成需要数秒，避免每个用例重复生成。
    fn shared_tls() -> &'static tls::TlsIdentity {
        static TLS: OnceLock<tls::TlsIdentity> = OnceLock::new();
        TLS.get_or_init(|| {
            let dir = std::env::temp_dir().join("taskdock-mobile-server-test");
            tls::load_or_create(&dir).expect("测试 TLS 身份")
        })
    }

    fn shared_cert_pem() -> &'static String {
        static PEM: OnceLock<String> = OnceLock::new();
        PEM.get_or_init(|| {
            let dir = std::env::temp_dir().join("taskdock-mobile-server-test");
            std::fs::read_to_string(dir.join(tls::TLS_DIR_NAME).join(tls::CERT_FILE))
                .expect("读取测试证书")
        })
    }

    /// 启动一个真实的 TLS-only 监听（随机端口），返回端口。
    async fn spawn_server(db: &Arc<Db>, state: &MobileSyncState) -> u16 {
        let listener = bind(0).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        db.set_setting("mobile_sync_enabled", serde_json::json!(true))
            .unwrap();
        db.set_setting("mobile_sync_port", serde_json::json!(port))
            .unwrap();
        state.set_running(port);
        let db = db.clone();
        let state = state.clone();
        let tls = shared_tls().clone();
        tokio::spawn(async move {
            serve(listener, db, state, port, tls).await;
        });
        port
    }

    fn test_state() -> MobileSyncState {
        let db = crate::db::Db::open_in_memory().unwrap();
        MobileSyncState::new(&db, std::env::temp_dir().join("taskdock-mobile-server-test-files"))
    }

    fn connector() -> tokio_native_tls::TlsConnector {
        let pem = shared_cert_pem();
        let mut builder = native_tls::TlsConnector::builder();
        builder
            .add_root_certificate(
                native_tls::Certificate::from_pem(pem.as_bytes()).expect("解析测试证书"),
            )
            // 自签证书只有 CN，不含 IP SAN；身份由根证书链承担（与手机端
            // SPKI 指纹固定同级的验证强度），主机名校验在此明确关闭。
            .danger_accept_invalid_hostnames(true);
        tokio_native_tls::TlsConnector::from(builder.build().unwrap())
    }

    /// 发起一次 HTTPS 请求并返回 (status, body)。
    async fn tls_request(
        port: u16,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut tls = connector()
            .connect("localhost", tcp)
            .await
            .expect("TLS 握手应成功");
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
        if let Some(token) = token {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        if let Some(body) = body {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ));
        }
        request.push_str("\r\n");
        if let Some(body) = body {
            request.push_str(body);
        }
        tls.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        tls.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let status: u16 = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        (status, body)
    }

    /// 直接用明文 TCP 请求（v1 旧客户端行为）：不得得到任何 HTTP 响应。
    async fn plaintext_request(port: u16, request: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tcp.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        // 握手失败后服务端断开：读端要么 EOF 要么报错，都不该出现 200。
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            let _ = tcp.read_to_end(&mut raw).await;
        })
        .await;
        String::from_utf8_lossy(&raw).to_string()
    }

    fn device_token_fixture() -> String {
        "ab".repeat(32)
    }

    fn insert_device(db: &Arc<Db>, device_id: &str, token: &str) {
        let hash = hash_token(token);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mobile_devices (id, name, platform, token_hash, created_at)
                 VALUES (?1, '测试手机', 'android', ?2, '2026-11-12T00:00:00Z')",
                rusqlite::params![device_id, hash],
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn tls_handshake_succeeds_and_health_reports_v2() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let (status, body) = tls_request(port, "GET", "/v1/health", None, None).await;
        assert_eq!(status, 200);
        assert!(body.contains("\"api_version\":2"), "{body}");
        assert!(body.contains("taskdock-mobile-sync"), "{body}");
    }

    #[tokio::test]
    async fn plaintext_clients_get_no_http_response() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let text =
            plaintext_request(port, "GET /v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
        assert!(
            !text.contains("200"),
            "明文请求不应得到任何 HTTP 响应：{text}"
        );
    }

    #[tokio::test]
    async fn untrusted_root_fails_handshake() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // 用另一份自签证书做客户端根：不应信任服务端证书。
        let other_dir = std::env::temp_dir().join("taskdock-mobile-server-test-other");
        let _ = tls::load_or_create(&other_dir).unwrap();
        let other_pem =
            std::fs::read_to_string(other_dir.join(tls::TLS_DIR_NAME).join(tls::CERT_FILE))
                .unwrap();
        let builder = native_tls::TlsConnector::builder()
            .add_root_certificate(
                native_tls::Certificate::from_pem(other_pem.as_bytes()).unwrap(),
            )
            .danger_accept_invalid_hostnames(true)
            .build()
            .unwrap();
        let other_connector = tokio_native_tls::TlsConnector::from(builder);
        let result = other_connector.connect("localhost", tcp).await;
        assert!(result.is_err(), "陌生根证书的 TLS 握手必须失败");
    }

    #[tokio::test]
    async fn changes_with_invalid_token_returns_401() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = "a".repeat(64);
        let (status, body) =
            tls_request(port, "GET", "/v1/changes?since=0", Some(&token), None).await;
        assert_eq!(status, 401, "{body}");
        assert!(body.contains("unauthorized"), "{body}");
    }

    #[tokio::test]
    async fn changes_with_revoked_device_returns_401() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-revoked", &token);
        assert!(crate::mobile_sync::revoke_device(&db, "device-revoked").unwrap());
        let (status, body) =
            tls_request(port, "GET", "/v1/changes?since=0", Some(&token), None).await;
        assert_eq!(status, 401, "{body}");
    }

    #[tokio::test]
    async fn pair_wrong_code_locks_after_max_attempts() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        state.start_session_for_test("123456");

        let body = r#"{"code":"999999","device_name":"Pixel","platform":"android"}"#;
        for attempt in 1..=5 {
            let (status, resp) = tls_request(port, "POST", "/v1/pair", None, Some(body)).await;
            if attempt < 5 {
                assert_eq!(status, 401, "第 {attempt} 次: {resp}");
            } else {
                assert_eq!(status, 429, "第 {attempt} 次: {resp}");
                assert!(resp.contains("too_many_attempts"), "{resp}");
            }
        }
    }

    #[tokio::test]
    async fn ops_replay_is_idempotent_and_wrong_key_rejected() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-ops", &token);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags,
                                    advance_minutes, created_at, updated_at)
                 VALUES ('task-1', '旧标题', '', 1, 'pending', '', '[]', 0,
                         '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        // v43 触发器在 INSERT 时已写一条变更日志：以真实最新 seq 作为 base_rev。
        let base_rev: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT MAX(seq) FROM sync_changes WHERE entity='task' AND id='task-1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();

        let key = derive_key(&hash_token(&token));
        let envelope = encrypt_envelope(
            &key,
            AAD_PUSH,
            &serde_json::json!({
                "device_id": "device-ops",
                "ops": [{
                    "op_id": "op-replay-1",
                    "entity": "task",
                    "id": "task-1",
                    "base_rev": base_rev,
                    "patch": { "title": "新标题" }
                }]
            }),
        )
        .unwrap();
        let body = serde_json::to_string(&envelope).unwrap();

        for round in 1..=2 {
            let (status, resp) =
                tls_request(port, "POST", "/v1/ops", Some(&token), Some(&body)).await;
            assert_eq!(status, 200, "第 {round} 轮: {resp}");
            let data = decrypt_envelope(&key, AAD_PUSH, &serde_json::from_str(&resp).unwrap())
                .expect("响应应可用正确密钥解密");
            assert_eq!(
                data["ack"],
                serde_json::json!(["op-replay-1"]),
                "第 {round} 轮 conflicts={:?}",
                data["conflicts"]
            );
        }

        // 幂等：重放不产生第二条 sync_ops；变更日志 = INSERT 基线 + 一次 UPDATE，
        // 重放不产生第三条。
        let (ops_count, changes_count, title): (i64, i64, String) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM sync_ops", [], |r| r.get(0))?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM sync_changes WHERE entity='task' AND id='task-1'",
                        [],
                        |r| r.get(0),
                    )?,
                    conn.query_row("SELECT title FROM tasks WHERE id='task-1'", [], |r| {
                        r.get(0)
                    })?,
                ))
            })
            .unwrap();
        assert_eq!(ops_count, 1);
        assert_eq!(changes_count, 2);
        assert_eq!(title, "新标题");

        // 错误密钥：解密失败 → 400，不落库。
        let other_key = derive_key(&"ff".repeat(32));
        let bad = serde_json::to_string(
            &encrypt_envelope(
                &other_key,
                AAD_PUSH,
                &serde_json::json!({"device_id": "device-ops", "ops": []}),
            )
            .unwrap(),
        )
        .unwrap();
        let (status, _) = tls_request(port, "POST", "/v1/ops", Some(&token), Some(&bad)).await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn changes_returns_encrypted_envelope_for_paired_device() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-pull", &token);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags,
                                    advance_minutes, created_at, updated_at)
                 VALUES ('task-pull', '机密任务', '', 1, 'pending', '', '[]', 0,
                         '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO sync_changes (entity, id, deleted, changed_at)
                 VALUES ('task', 'task-pull', 0, '2026-11-12T00:00:00Z')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let (status, resp) =
            tls_request(port, "GET", "/v1/changes?since=0", Some(&token), None).await;
        assert_eq!(status, 200);
        // 传输层之上仍是加密信封：明文里不应出现任务标题。
        assert!(!resp.contains("机密任务"), "pull 响应必须加密：{resp}");
        let key = derive_key(&hash_token(&token));
        let data = decrypt_envelope(&key, AAD_PULL, &serde_json::from_str(&resp).unwrap()).unwrap();
        assert_eq!(data["changes"][0]["fields"]["title"], "机密任务");
    }

    /// 构造一个加密 push 信封；`trace_id` 为 None 时字段整个省略（旧客户端形态）。
    fn push_envelope(device_id: &str, token: &str, trace_id: Option<&str>) -> String {
        let key = derive_key(&hash_token(token));
        let mut payload = json!({ "device_id": device_id, "ops": [] });
        if let Some(trace) = trace_id {
            payload["traceId"] = json!(trace);
        }
        let envelope = encrypt_envelope(&key, AAD_PUSH, &payload).unwrap();
        serde_json::to_string(&envelope).unwrap()
    }

    fn decrypt_push(token: &str, resp: &str) -> Value {
        let key = derive_key(&hash_token(token));
        decrypt_envelope(&key, AAD_PUSH, &serde_json::from_str(resp).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn pull_issues_session_trace_shared_across_subsequent_pulls() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-trace-pull", &token);

        async fn pull_trace(port: u16, token: &str) -> String {
            let (status, resp) =
                tls_request(port, "GET", "/v1/changes?since=0", Some(token), None).await;
            assert_eq!(status, 200, "{resp}");
            let key = derive_key(&hash_token(token));
            let data =
                decrypt_envelope(&key, AAD_PULL, &serde_json::from_str(&resp).unwrap()).unwrap();
            data["traceId"]
                .as_str()
                .expect("pull 必须下发会话 traceId")
                .to_string()
        }

        let first = pull_trace(port, &token).await;
        let second = pull_trace(port, &token).await;
        assert_eq!(first, second, "同一设备的后续 pull 必须共享同一 trace_id");
        assert!(crate::diagnostics::trace::validate_external_id(&first).is_some());
    }

    #[tokio::test]
    async fn push_adopts_valid_trace_discards_invalid_and_reuses_session() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-trace-push", &token);

        // 合法外部 trace：采用并回传。
        let body1 = push_envelope("device-trace-push", &token, Some("0123456789abcdef"));
        let (status, resp) = tls_request(port, "POST", "/v1/ops", Some(&token), Some(&body1)).await;
        assert_eq!(status, 200, "{resp}");
        assert_eq!(decrypt_push(&token, &resp)["traceId"], "0123456789abcdef");

        // 非法 trace（大写/非 hex）：静默丢弃，沿用会话 trace，请求不被拒绝。
        let body2 = push_envelope("device-trace-push", &token, Some("NOT-HEX!!"));
        let (status, resp) = tls_request(port, "POST", "/v1/ops", Some(&token), Some(&body2)).await;
        assert_eq!(status, 200, "{resp}");
        assert_eq!(decrypt_push(&token, &resp)["traceId"], "0123456789abcdef");

        // 旧客户端不传 traceId：仍沿用会话 trace，字段不缺失。
        let body3 = push_envelope("device-trace-push", &token, None);
        let (status, resp) = tls_request(port, "POST", "/v1/ops", Some(&token), Some(&body3)).await;
        assert_eq!(status, 200, "{resp}");
        assert_eq!(decrypt_push(&token, &resp)["traceId"], "0123456789abcdef");
    }

    #[tokio::test]
    async fn trace_value_does_not_change_authentication_outcome() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-trace-auth", &token);

        // 无效令牌：即使请求体携带 traceId，认证路径不读 trace，仍返回 401。
        let bad_token = "c".repeat(64);
        let bad_body = push_envelope("device-trace-auth", &bad_token, Some("0123456789abcdef"));
        let (status, _) =
            tls_request(port, "POST", "/v1/ops", Some(&bad_token), Some(&bad_body)).await;
        assert_eq!(status, 401);

        // 有效令牌 + 畸形 trace：鉴权通过（200），trace 不影响信任判断。
        let body = push_envelope("device-trace-auth", &token, Some("zzz-garbage-value"));
        let (status, resp) = tls_request(port, "POST", "/v1/ops", Some(&token), Some(&body)).await;
        assert_eq!(status, 200, "{resp}");
    }

    #[test]
    fn pair_request_deserializes_v2_clients() {
        let request: PairRequest = serde_json::from_str(
            r#"{"code":"482913","device_name":"Android 手机","platform":"android","device_uid":"0f8fad5b-d9cb-469f-a165-70867728950e"}"#,
        )
        .unwrap();
        assert_eq!(request.code, "482913");
        assert_eq!(request.device_uid.len(), 36);
    }

    #[tokio::test]
    async fn shelf_endpoint_import_is_owned_encrypted_and_idempotent() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let base = std::env::temp_dir().join(format!(
            "taskdock-shelf-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let files_root = base.join("mobile_files");
        let state = MobileSyncState::new(&db, files_root.clone());
        let port = spawn_server(&db, &state).await;

        let token = device_token_fixture();
        insert_device(&db, "device-shelf", &token);
        let token_other = "b".repeat(64);
        insert_device(&db, "device-shelf-2", &token_other);

        let bytes = vec![7u8; 64];
        let file = files::create_upload(&db, &files_root, "device-shelf", "photo.bin", 64).unwrap();
        files::write_chunk(&db, "device-shelf", &file.id, 0, &bytes).unwrap();
        files::complete_upload(&db, &files_root, "device-shelf", &file.id).unwrap();

        let key = derive_key(&hash_token(&token));
        let aad = files::aad_file_shelf(&file.id);
        let envelope = encrypt_envelope(
            &key,
            &aad,
            &json!({ "group_id": Value::Null }),
        )
        .unwrap();
        let body = serde_json::to_string(&envelope).unwrap();

        // 第一次导入：200，响应回传 shelf 三字段。
        let (status, resp) = tls_request(
            port,
            "POST",
            &format!("/v1/files/{}/shelf", file.id),
            Some(&token),
            Some(&body),
        )
        .await;
        assert_eq!(status, 200, "{resp}");
        let data = decrypt_envelope(&key, &aad, &serde_json::from_str(&resp).unwrap()).unwrap();
        let item_id = data["file"]["shelf_item_id"]
            .as_str()
            .expect("响应应带 ShelfItem.id");
        assert_eq!(item_id, format!("mf-{}", file.id));
        assert!(data["file"]["shelf_imported_at"].is_string());
        assert!(data["file"]["device_id"].as_str() == Some("device-shelf"));
        // 落盘路径绝不下发。
        assert!(data["file"].get("stored_path").is_none());

        // 幂等：第二次导入返回同一 ShelfItem.id，暂存架仍只有一条。
        let (status, resp) = tls_request(
            port,
            "POST",
            &format!("/v1/files/{}/shelf", file.id),
            Some(&token),
            Some(&body),
        )
        .await;
        assert_eq!(status, 200, "{resp}");
        let again = decrypt_envelope(&key, &aad, &serde_json::from_str(&resp).unwrap()).unwrap();
        assert_eq!(again["file"]["shelf_item_id"].as_str(), Some(item_id));
        let item_count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM shelf_items", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(item_count, 1);
        let origin: Option<String> = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT origin FROM shelf_items WHERE id = ?1", [item_id], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(origin.as_deref(), Some(files::SHELF_ORIGIN_MOBILE_CAPTURE));

        // 其他设备：用其他设备的密钥加密，服务端解密后按归属返回 404，不泄露存在性，也不建条目。
        let key_other = derive_key(&hash_token(&token_other));
        let body_other = serde_json::to_string(
            &encrypt_envelope(&key_other, &aad, &json!({ "group_id": Value::Null })).unwrap(),
        )
        .unwrap();
        let (status, resp) = tls_request(
            port,
            "POST",
            &format!("/v1/files/{}/shelf", file.id),
            Some(&token_other),
            Some(&body_other),
        )
        .await;
        assert_eq!(status, 404, "{resp}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn shelf_groups_endpoint_requires_auth_and_returns_encrypted_list() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let state = test_state();
        let port = spawn_server(&db, &state).await;
        let token = device_token_fixture();
        insert_device(&db, "device-groups", &token);

        // 未携带令牌：401。
        let (status, resp) = tls_request(port, "GET", "/v1/shelf/groups", None, None).await;
        assert_eq!(status, 401, "{resp}");

        // 已配对设备：200，响应为加密信封，解出分组列表。
        let (status, resp) = tls_request(port, "GET", "/v1/shelf/groups", Some(&token), None).await;
        assert_eq!(status, 200, "{resp}");
        let key = derive_key(&hash_token(&token));
        let data = decrypt_envelope(
            &key,
            files::AAD_SHELF_GROUPS,
            &serde_json::from_str(&resp).unwrap(),
        )
        .unwrap();
        let groups = data["groups"].as_array().expect("应返回 groups 数组");
        assert!(!groups.is_empty(), "默认分组应存在");
        for group in groups {
            assert!(group["id"].is_string());
            assert!(group["name"].is_string());
            assert!(group["builtin"].is_boolean());
            // 契约 2.2：不下发条目总数与排序字段。
            assert!(group.get("item_count").is_none());
            assert!(group.get("sort_order").is_none());
        }
    }
}
