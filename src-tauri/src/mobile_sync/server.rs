//! 手机接入 HTTP 监听（局域网 IPv4：配对、探测与加密同步）。
//!
//! 与 `agents/http_ingest` 的相同点：hyper 1.x、头部读取超时、请求体上限、
//! 连接/在途并发上限、退出信号驱动关闭。不同点：
//! - 绑定 `0.0.0.0`（由设置开关控制），不绑定回环；
//! - 路由：`/v1/health`、`/v1/pair`、`/v1/ping`、同步的 `/v1/changes`、`/v1/ops`，
//!   以及文件互传的 `/v1/files`、`/v1/files/{id}/chunk/{index}`、`.../complete`、`.../delete`；
//! - 配对接口无鉴权（凭一次性码），其余接口用 Bearer 设备令牌；
//! - 同步与文件载荷用设备令牌哈希派生的密钥做 XSalsa20-Poly1305 加密，业务数据不明文上线。

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
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
use crate::mobile_sync::sync::{
    apply_push, decrypt_envelope, derive_key, encrypt_envelope, pull, PushRequest, AAD_PULL,
    AAD_PUSH, MAX_PULL_LIMIT, MAX_PUSH_OPS, SYNC_MAX_BODY,
};
use crate::mobile_sync::{
    authenticate_device, complete_pairing, hash_token, MobileDevice, MobileSyncState, PairFailure,
    PairRequest, API_VERSION,
};

/// 配对/探测请求体上限：只接受很小的 JSON，杜绝大包占用内存。
const MAX_BODY: usize = 4 * 1024;
/// 同时存活连接上限；手机端只会有一个配对/心跳连接。
const MAX_CONNECTIONS: usize = 16;
/// 同时处理中的请求上限；超出返回 429 + Retry-After。
const MAX_INFLIGHT: usize = 8;
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 单个分块请求体上限：192KB 明文 base64 后约 256KB，信封 JSON 再留一倍余量。
const FILE_CHUNK_BODY_MAX: usize = 512 * 1024;

pub struct ServerCtx {
    db: Arc<Db>,
    state: MobileSyncState,
    request_sem: Arc<Semaphore>,
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
    let (_device, token_hash) = match authenticate_request(&req, &ctx, peer).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (since, limit) = parse_pull_query(req.uri().query());
    let db = ctx.db.clone();
    let result = tokio::task::spawn_blocking(move || pull(&db, since, limit)).await;
    let key = derive_key(&token_hash);

    match result {
        Ok(Ok(page)) => match serde_json::to_value(page) {
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
        },
        Ok(Err(error)) => {
            tracing::warn!("手机同步拉取失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "同步处理失败，请重试",
            )
        }
        Err(join_error) => {
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

    let db = ctx.db.clone();
    let device_id = device.id.clone();
    let ops = request.ops;
    let result =
        tokio::task::spawn_blocking(move || apply_push(&db, &device_id, &ops)).await;
    match result {
        Ok(Ok(response)) => match serde_json::to_value(response) {
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
        },
        Ok(Err(error)) => {
            tracing::warn!("手机同步写入失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "同步处理失败，请重试",
            )
        }
        Err(join_error) => {
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
    let service = service_fn(move |req: Request<Incoming>| {
        let ctx = ctx.clone();
        async move { route(req, ctx, peer).await }
    });
    let conn = http1_builder().serve_connection(TokioIo::new(stream), service);
    if tokio::time::timeout(REQUEST_TIMEOUT, conn).await.is_err() {
        tracing::debug!("手机接入连接处理超时（peer 已连接）");
    }
}

async fn reject_busy(mut stream: TcpStream) {
    let body = r#"{"error":"too_many_connections","message":"连接数已满，请稍后重试"}"#.as_bytes();
    let head = format!(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\n\
         Cache-Control: no-store\r\nRetry-After: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

/// 监听循环：跟随设置启停/端口变更与应用退出信号。
pub async fn serve(
    listener: TcpListener,
    db: Arc<Db>,
    state: MobileSyncState,
    port: u16,
) {
    let ctx = Arc::new(ServerCtx {
        db: db.clone(),
        state,
        request_sem: Arc::new(Semaphore::new(MAX_INFLIGHT)),
    });
    let conn_sem = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = crate::agents::shutdown_signal::wait() => {
                tracing::info!("应用退出：关闭手机接入监听");
                return;
            }
            _ = tick.tick() => {
                let settings = crate::db::Settings::load(&db).unwrap_or_default();
                if !settings.mobile_sync_enabled || settings.mobile_sync_port != port {
                    tracing::info!("手机接入配置变更，重新绑定监听");
                    return;
                }
                if !ctx.state.is_running() {
                    // 状态被外部重置（例如启停竞态）：退出让主管重新评估，
                    // 避免出现「监听在跑但状态显示已停」的分裂。
                    return;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        match conn_sem.clone().try_acquire_owned() {
                            Ok(permit) => {
                                let ctx = ctx.clone();
                                tokio::spawn(async move {
                                    let _permit: OwnedSemaphorePermit = permit;
                                    handle_conn(stream, peer, ctx).await;
                                });
                            }
                            Err(_) => {
                                tokio::spawn(reject_busy(stream));
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
}
