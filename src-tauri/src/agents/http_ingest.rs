//! 本地 HTTP 接入 Adapter。
//!
//! 安全约束（对应需求）：
//! - 仅绑定 127.0.0.1 回环地址；
//! - Bearer 令牌鉴权（令牌首次启动自动生成，保存在本地设置中）；
//! - 请求体大小上限 64KB；
//! - 日志只记录方法/路径/状态/对端/耗时，绝不记录请求体内容（脱敏）。

use std::io::Read;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server};

use crate::agents::{AgentAdapter, AgentEvent, AgentHub, Transport};
use crate::db::Settings;

const MAX_BODY: usize = 64 * 1024;

#[derive(Default)]
pub struct HttpIngestAdapter;

impl HttpIngestAdapter {
    pub fn new() -> Self {
        Self
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

fn json_response(status: u16, body: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_data(data)
        .with_status_code(status)
        .with_header(header)
}

fn handle_request(hub: &AgentHub, mut request: tiny_http::Request, token: &str) {
    let started = std::time::Instant::now();
    let method = request.method().clone();
    let path = request.url().to_string();
    let peer = request.remote_addr().copied();
    let status: u16;

    match (&method, path.as_str()) {
        (Method::Get, "/api/v1/health") => {
            let _ = request.respond(json_response(
                200,
                serde_json::json!({"ok": true, "service": "task-dock"}),
            ));
            status = 200;
        }
        (Method::Post, "/api/v1/events") => {
            // 鉴权
            let authorized = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .and_then(|h| {
                    h.value
                        .as_str()
                        .strip_prefix("Bearer ")
                        .map(|v| v.trim().to_string())
                })
                .map(|v| constant_time_eq(&v, token))
                .unwrap_or(false);
            if !authorized {
                let _ = request.respond(json_response(
                    401,
                    serde_json::json!({"error": "unauthorized"}),
                ));
                status = 401;
            } else {
                let mut body = String::new();
                let too_large = request
                    .body_length()
                    .map(|len| len > MAX_BODY)
                    .unwrap_or(false);
                if too_large {
                    status = 413;
                    let _ = request.respond(json_response(
                        413,
                        serde_json::json!({"error": "payload too large"}),
                    ));
                } else {
                    let read = std::io::Read::take(request.as_reader(), (MAX_BODY + 1) as u64)
                        .read_to_string(&mut body);
                    match read {
                        Ok(_) if body.len() <= MAX_BODY => {
                            let value: Result<serde_json::Value, _> = serde_json::from_str(&body);
                            match value {
                                // 单事件：transport 由服务端按入口判定为 http（载荷声明不采信）
                                Ok(serde_json::Value::Object(_)) => {
                                    match serde_json::from_str::<AgentEvent>(&body) {
                                        Ok(ev) => match hub.ingest(&ev, Transport::Http) {
                                            Ok(_) => {
                                                let _ = request.respond(json_response(200, serde_json::json!({"accepted": 1, "rejected": 0})));
                                                status = 200;
                                            }
                                            Err(e) => {
                                                let _ = request.respond(json_response(422, serde_json::json!({"error": "event rejected", "accepted": 0, "rejected": 1})));
                                                status = 422;
                                                tracing::info!("HTTP 事件被拒绝: {}", e);
                                            }
                                        },
                                        Err(_) => {
                                            let _ = request.respond(json_response(
                                                400,
                                                serde_json::json!({"error": "invalid event"}),
                                            ));
                                            status = 400;
                                        }
                                    }
                                }
                                // 批量：全成功/全失败 —— 任一事件非法或被拒，整批一个都不写入
                                Ok(serde_json::Value::Array(arr)) => {
                                    let total = arr.len();
                                    let mut events = Vec::with_capacity(total);
                                    let mut parse_failed = false;
                                    for item in arr {
                                        match serde_json::from_value::<AgentEvent>(item) {
                                            Ok(ev) => events.push(ev),
                                            Err(_) => {
                                                parse_failed = true;
                                                break;
                                            }
                                        }
                                    }
                                    if parse_failed {
                                        let _ = request.respond(json_response(400, serde_json::json!({"error": "invalid event in batch", "accepted": 0, "rejected": total})));
                                        status = 400;
                                    } else {
                                        let total = events.len();
                                        match hub.ingest_batch(&events, Transport::Http) {
                                            Ok(outs) => {
                                                let _ = request.respond(json_response(200, serde_json::json!({"accepted": outs.len(), "rejected": 0})));
                                                status = 200;
                                            }
                                            Err(e) => {
                                                let _ = request.respond(json_response(422, serde_json::json!({"error": "batch rejected", "accepted": 0, "rejected": total})));
                                                status = 422;
                                                tracing::info!("HTTP 批量事件被整体拒绝: {}", e);
                                            }
                                        }
                                    }
                                }
                                _ => {
                                    let _ = request.respond(json_response(
                                        400,
                                        serde_json::json!({"error": "invalid json"}),
                                    ));
                                    status = 400;
                                }
                            }
                        }
                        _ => {
                            let _ = request.respond(json_response(
                                400,
                                serde_json::json!({"error": "invalid json"}),
                            ));
                            status = 400;
                        }
                    }
                }
            }
        }
        _ => {
            let _ = request.respond(json_response(
                404,
                serde_json::json!({"error": "not found"}),
            ));
            status = 404;
        }
    }
    // 脱敏日志：不含请求体
    tracing::info!(
        "HTTP 接入 {} {} -> {} ({:?}, {:?}ms)",
        method.as_str(),
        path,
        status,
        peer,
        started.elapsed().as_millis()
    );
}

impl AgentAdapter for HttpIngestAdapter {
    fn id(&self) -> &'static str {
        "http_ingest"
    }

    fn spawn(
        self: Box<Self>,
        hub: std::sync::Arc<AgentHub>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        // tiny_http 为同步 IO：先在 async 上下文中落地，再移入 blocking 线程，
        // 避免阻塞 Tauri 的 async worker。
        tauri::async_runtime::spawn(async move {
            let handle = tokio::task::spawn_blocking(move || {
                let mut current: Option<(u16, String, Server)> = None;
                loop {
                    let settings = Settings::load(hub.db()).unwrap_or_default();
                    let desired = if settings.http_enabled {
                        Some((settings.http_port, settings.http_token.clone()))
                    } else {
                        None
                    };
                    let keep =
                        matches!(&current, Some((p, t, _)) if Some((*p, t.clone())) == desired);
                    if !keep {
                        current = None;
                        if let Some((port, token)) = desired {
                            match Server::http(format!("127.0.0.1:{}", port)) {
                                Ok(server) => {
                                    tracing::info!("本地 HTTP 接入监听 127.0.0.1:{}", port);
                                    current = Some((port, token, server));
                                }
                                Err(e) => {
                                    tracing::error!("绑定 127.0.0.1:{} 失败: {}", port, e);
                                    std::thread::sleep(Duration::from_secs(10));
                                }
                            }
                        }
                    }
                    if let Some((_, token, server)) = &current {
                        if let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(500)) {
                            let hub = hub.clone();
                            let token = token.clone();
                            handle_request(&hub, request, &token);
                        }
                    } else {
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            });
            let _ = handle.await;
        })
    }
}
