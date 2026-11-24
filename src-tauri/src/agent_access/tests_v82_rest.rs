//! v82 REST 回归测试：请求预算（P1-3）、幂等指纹（P1-4）、生命周期竞态（P1-5）。
//!
//! 生命周期用例会真实绑定 127.0.0.1 端口，且 `rest` 的 slot/runtime 是进程级单例，
//! 因此用进程内互斥锁串行执行；每个用例结束都调用 `stop()` 清理。
//! 端口一律由 `free_port()` 动态取得，避免与真实服务冲突。
//!
//! v82-B 增补：统一任务登记表（连接任务 / 迟到完成后台任务）、超时「迟到完成」
//! 幂等模型（超时保留占位、后台宽限期内写缓存、重试只重放不重写）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::AppError;
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions as mcp_perm;

use super::rest::{self, RestRuntimeStatus};
use super::store::{self, CacheClaim};
use super::{Principal, Source};

/// 进程级串行锁：slot/runtime 是全局单例，多测试并行会互相覆盖。
static SERIAL: Mutex<()> = Mutex::new(());

pub(super) fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn db() -> Db {
    Db::open_in_memory().expect("内存库")
}

/// 取一个当前空闲的本地端口（立刻释放，交由 rest 重新绑定）。
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("临时端口");
    listener.local_addr().expect("地址").port()
}

/// 启动 REST 并返回实际端口。整套测试并行运行时端口可能被其它用例瞬间抢走，
/// 这里对「绑定失败」重试几次；其它错误直接失败。
pub(super) fn start_rest(db: &Arc<Db>) -> u16 {
    for _ in 0..5 {
        let port = free_port();
        match rest::start(db.clone(), port) {
            Ok(_) => return port,
            Err(AppError::Unavailable(_)) => continue,
            Err(err) => panic!("启动 REST 失败: {err:?}"),
        }
    }
    panic!("连续 5 次未能绑定 REST 端口");
}

/// 创建可写 Agent，返回 (row_id, agent_id, token 明文)。
fn writable_agent(db: &Db, suffix: &str) -> (String, String, String) {
    let created = mcp_auth::create_agent(db, &format!("rest-v82-{suffix}"), "REST 测试 Agent")
        .expect("创建 Agent");
    mcp_auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
    mcp_perm::grant(db, &created.info.id, "tasks.write", "").expect("授权 tasks.write");
    mcp_perm::grant(db, &created.info.id, "tasks.read", "").expect("授权 tasks.read");
    (created.info.id, created.info.agent_id, created.token)
}

fn task_count(db: &Db) -> i64 {
    db.with_read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?))
        .expect("统计任务")
}

fn cache_rows(db: &Db, key: &str) -> i64 {
    db.with_read(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM agent_request_cache WHERE idempotency_key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )?)
    })
    .expect("统计幂等缓存")
}

/// 幂等占位状态：`inflight`（执行中）/ `done`（已完成）/ `None`（无行）。
fn cache_state(db: &Db, key: &str) -> Option<String> {
    db.with_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT state FROM agent_request_cache WHERE idempotency_key = ?1",
                rusqlite::params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
    .expect("读取幂等占位状态")
}

/// 某个 `agent_row_id` 名下的幂等缓存行数。
fn cache_rows_of_agent(db: &Db, key: &str, row_id: &str) -> i64 {
    db.with_read(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM agent_request_cache WHERE idempotency_key = ?1 AND agent_row_id = ?2",
            rusqlite::params![key, row_id],
            |r| r.get(0),
        )?)
    })
    .expect("统计指定 Agent 的幂等缓存")
}

fn wait_port_released(port: u16) {
    // 监听 socket 关闭是即时的；这里只容忍任务 drop 的极短窗口，不做 TIMEWAIT 轮询。
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                drop(listener);
                return;
            }
            Err(err) if Instant::now() < deadline => {
                let _ = err;
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(err) => panic!("端口 {port} 未被释放: {err}"),
        }
    }
}

// ── 生命周期（P1-5）────────────────────────────────────────────

#[test]
fn lifecycle_concurrent_start_same_port_single_listener() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = free_port();

    let mut joins = Vec::new();
    for _ in 0..2 {
        let db = db.clone();
        joins.push(std::thread::spawn(move || rest::start(db, port)));
    }
    let results: Vec<_> = joins.into_iter().map(|j| j.join().expect("线程")).collect();

    let ok = results.iter().filter(|r| r.is_ok()).count();
    assert!(ok >= 1, "至少一个 start 成功: {results:?}");
    for result in &results {
        if let Err(err) = result {
            assert!(
                matches!(err, AppError::Conflict(_)),
                "并发 start 的失败只能是 Conflict: {err:?}"
            );
        }
    }
    let status = rest::status(&db);
    assert!(status.running, "应处于监听状态");
    assert_eq!(status.bound_port, Some(port));
    assert_eq!(status.state, RestRuntimeStatus::Listening);
    // 若出现两个监听，第二个 bind 一定会失败；能 bind 说明没有占用。
    assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_err());
    let _ = rest::stop();
}

#[test]
fn lifecycle_repeat_start_same_port_returns_current_status() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = start_rest(&db);
    let first = rest::status(&db);
    assert!(first.running);
    let second = rest::start(db.clone(), port).expect("重复启动返回现状");
    assert!(second.running, "重复 start 不应改变监听状态");
    assert_eq!(second.bound_port, Some(port));
    assert_eq!(second.state, RestRuntimeStatus::Listening);
    // configured_port 只来自设置，不被运行端口污染。
    assert_eq!(second.configured_port, crate::db::Settings::load(&db).unwrap().agent_api_port);
    let _ = rest::stop();
}

#[test]
fn lifecycle_stop_releases_port() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = start_rest(&db);
    rest::stop().expect("停止");
    let status = rest::status(&db);
    assert!(!status.running);
    assert_eq!(status.bound_port, None);
    assert_eq!(status.state, RestRuntimeStatus::Stopped);
    wait_port_released(port);
}

#[test]
fn lifecycle_restart_after_stop() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = start_rest(&db);
    rest::stop().expect("停止");
    let again = rest::start(db.clone(), port).expect("停止后立即重启");
    assert!(again.running);
    assert_eq!(again.bound_port, Some(port));
    let _ = rest::stop();
}

#[test]
fn lifecycle_apply_switches_port_and_reports_failure() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port_a = free_port();
    let port_b = free_port();

    db.set_setting("agent_api_enabled", json!(true)).unwrap();
    db.set_setting("agent_api_port", json!(port_a)).unwrap();
    let started = rest::apply(db.clone()).expect("apply 启动");
    assert!(started.running);
    assert_eq!(started.bound_port, Some(port_a));
    assert_eq!(started.configured_port, port_a);

    db.set_setting("agent_api_port", json!(port_b)).unwrap();
    let switched = rest::apply(db.clone()).expect("apply 切端口");
    assert!(switched.running);
    assert_eq!(switched.bound_port, Some(port_b));
    assert_eq!(switched.configured_port, port_b);
    wait_port_released(port_a);

    // 已知被占用的端口：apply 返回错误，状态 Failed，配置端口不变。
    let blocker = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("占位监听");
    let busy = blocker.local_addr().unwrap().port();
    db.set_setting("agent_api_port", json!(busy)).unwrap();
    let err = rest::apply(db.clone()).expect_err("端口被占用应失败");
    assert!(matches!(err, AppError::Unavailable(_)), "err={err:?}");
    let failed = rest::status(&db);
    assert!(!failed.running);
    assert_eq!(failed.state, RestRuntimeStatus::Failed);
    assert_eq!(failed.bound_port, None);
    assert_eq!(failed.configured_port, busy);
    assert!(failed.last_error.is_some());
    drop(blocker);

    let _ = rest::stop();
    db.set_setting("agent_api_enabled", json!(false)).unwrap();
}

#[test]
fn lifecycle_five_cycles_leave_no_orphan() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = free_port();

    for round in 1..=5 {
        let started = rest::start(db.clone(), port).unwrap_or_else(|e| panic!("第 {round} 轮启动: {e:?}"));
        assert!(started.running, "第 {round} 轮应监听");
        assert_eq!(started.bound_port, Some(port));
        rest::stop().expect("停止");
        let status = rest::status(&db);
        assert!(!status.running, "第 {round} 轮停止后不应 running");
        assert_eq!(status.bound_port, None);
        wait_port_released(port);
    }
    assert_eq!(rest::status(&db).state, RestRuntimeStatus::Stopped);
}

#[test]
fn lifecycle_repeat_stop_is_safe() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = start_rest(&db);

    rest::stop().expect("第一次停止");
    // 重复停止必须安全：既不 panic，也不把已停止的状态改坏。
    rest::stop().expect("第二次停止");
    rest::stop().expect("第三次停止");
    let status = rest::status(&db);
    assert!(!status.running);
    assert_eq!(status.state, RestRuntimeStatus::Stopped);
    assert_eq!(status.bound_port, None);
    wait_port_released(port);
}

#[test]
fn lifecycle_stop_cancels_active_request_tasks() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "stop-cancel");
    let port = start_rest(&db);

    // 发一个长时间挂起的请求：连接任务会一直占着，stop() 必须能取消它。
    let body = r#"{"title":"停止时应被取消"}"#.as_bytes();
    let head = request_head(
        "POST /api/v1/__test/slow-create-task?delay_ms=30000",
        &token,
        &[("Content-Length", &body.len().to_string())],
    );
    let mut stream = connect(port);
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();

    // 等请求真正进入 handler（连接任务已登记进任务表）。
    let deadline = Instant::now() + Duration::from_secs(3);
    while rest::active_task_count() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        rest::active_task_count() >= 1,
        "请求任务必须已登记进统一任务表"
    );

    rest::stop().expect("停止");
    // stop 之后不得留下孤儿请求任务。
    let deadline = Instant::now() + Duration::from_secs(3);
    while rest::active_task_count() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(rest::active_task_count(), 0, "stop 后不得留下孤儿请求任务");
    assert_eq!(task_count(&db), 0, "被取消的请求不得留下业务数据");
    wait_port_released(port);
}

#[test]
fn lifecycle_start_on_occupied_port_reports_failed_and_recovers() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let blocker = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("占位监听");
    let busy = blocker.local_addr().unwrap().port();

    let err = rest::start(db.clone(), busy).expect_err("端口被占用必须失败");
    assert!(matches!(err, AppError::Unavailable(_)), "err={err:?}");
    let failed = rest::status(&db);
    assert!(!failed.running, "失败后不得谎报运行中");
    assert_eq!(failed.state, RestRuntimeStatus::Failed);
    assert_eq!(failed.bound_port, None, "失败后不得有真实监听端口");
    assert!(failed.last_error.is_some(), "失败必须留下 last_error");
    // configured_port 只反映设置值：绝不被「真实尝试绑定的端口」补值。
    assert_eq!(
        failed.configured_port,
        crate::db::Settings::load(&db).unwrap().agent_api_port
    );
    assert_ne!(failed.configured_port, busy, "configured_port 不得被真实端口污染");

    // 失败路径必须可恢复：换一个空闲端口能正常起来。
    let good = free_port();
    let started = rest::start(db.clone(), good).expect("失败后必须能恢复");
    assert!(started.running);
    assert_eq!(started.bound_port, Some(good));
    assert_eq!(started.state, RestRuntimeStatus::Listening);
    drop(blocker);
    let _ = rest::stop();
}

#[test]
fn lifecycle_start_with_zero_port_is_rejected() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let err = rest::start(db.clone(), 0).expect_err("端口 0 必须被拒绝");
    assert!(matches!(err, AppError::Validation(_)), "err={err:?}");
    let status = rest::status(&db);
    assert!(!status.running);
    assert_eq!(status.bound_port, None);
    let _ = rest::stop();
}

// ── 超时（P1-3）────────────────────────────────────────────────

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 读一个完整 HTTP 响应（Content-Length 定界；服务端响应体是 `Full`，一定有长度）。
fn read_http(stream: &mut TcpStream) -> (u16, HashMap<String, String>, String) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut tmp).expect("读取响应头");
        assert!(n > 0, "响应头未结束连接即关闭");
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("状态行");
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut tmp).expect("读取响应体");
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    (status, headers, String::from_utf8_lossy(&body).to_string())
}

fn connect(port: u16) -> TcpStream {
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("连接 REST");
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    stream
}

fn request_head(method_path: &str, token: &str, extra: &[(&str, &str)]) -> String {
    let mut head = format!(
        "{method_path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\n"
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    head
}

/// 发起一次带 body 的 POST（可带 Idempotency-Key），返回 (状态, 头, 正文)。
pub(super) fn post(
    port: u16,
    path: &str,
    token: &str,
    body: &[u8],
    idem: Option<&str>,
) -> (u16, HashMap<String, String>, String) {
    let mut extra: Vec<(String, String)> = vec![("Content-Length".into(), body.len().to_string())];
    if let Some(key) = idem {
        extra.push(("Idempotency-Key".into(), key.to_string()));
    }
    let extra_refs: Vec<(&str, &str)> = extra
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let mut stream = connect(port);
    let head = request_head(&format!("POST {path}"), token, &extra_refs);
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    read_http(&mut stream)
}

/// 发起一次 GET（可带自定义头），返回 (状态, 头, 正文)。
pub(super) fn get(
    port: u16,
    path: &str,
    token: Option<&str>,
    extra: &[(&str, &str)],
) -> (u16, HashMap<String, String>, String) {
    let mut head = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut stream = connect(port);
    stream.write_all(head.as_bytes()).unwrap();
    read_http(&mut stream)
}

#[test]
fn get_field_projection_keeps_pagination_and_respects_authentication() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "fields");
    let port = start_rest(&db);
    let (created, _, _) = post(
        port,
        "/api/v1/tasks",
        &token,
        br#"{"title":"task for projection","description":"only in full response"}"#,
        None,
    );
    let (status, _, body) = get(
        port,
        "/api/v1/tasks?limit=1&fields=id,title,revision",
        Some(&token),
        &[],
    );
    let (unknown, _, _) = get(port, "/api/v1/tasks?fields=unknown", Some(&token), &[]);
    let (unauthorized, _, _) = get(port, "/api/v1/tasks?fields=id", None, &[]);
    let _ = rest::stop();

    assert_eq!(created, 201);
    assert_eq!(status, 200, "{body}");
    let value: Value = serde_json::from_str(&body).unwrap();
    let task = value["data"][0].as_object().unwrap();
    assert_eq!(task.len(), 3);
    assert!(task.contains_key("id"));
    assert_eq!(task["title"], "task for projection");
    assert_eq!(task["revision"], 1);
    assert_eq!(value["meta"]["pagination"]["total"], 1);
    assert_eq!(unknown, 400);
    assert_eq!(unauthorized, 401);
}

#[test]
fn timeout_slow_body_returns_408_with_matching_request_id() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "slow-body");
    let port = start_rest(&db);

    let mut stream = connect(port);
    // 声明 200 字节 body，但一个字节都不发：旧实现会一直挂住连接。
    let head = request_head(
        "POST /api/v1/tasks",
        &token,
        &[("Content-Length", "200"), ("Idempotency-Key", "slow-body-1")],
    );
    let started = Instant::now();
    stream.write_all(head.as_bytes()).unwrap();
    let (status, headers, body) = read_http(&mut stream);
    let elapsed = started.elapsed();

    assert_eq!(status, 408, "慢速 body 必须超时: {body}");
    assert!(
        elapsed >= rest::REQUEST_TIMEOUT_EFFECTIVE / 2,
        "不应提前超时: {elapsed:?}"
    );
    assert!(elapsed < Duration::from_secs(10), "超时无界: {elapsed:?}");
    let value: Value = serde_json::from_str(&body).expect("JSON 信封");
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("UNAVAILABLE"));
    assert_eq!(
        headers.get("x-request-id"),
        Some(&value["meta"]["request_id"].as_str().unwrap().to_string()),
        "X-Request-Id 必须与 body.meta.request_id 一致"
    );
    let _ = rest::stop();
}

#[test]
fn timeout_keeps_placeholder_and_rolls_back_business_write() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "slow-write");
    let port = start_rest(&db);

    let before = task_count(&db);
    let body = r#"{"title":"超时不应落库"}"#.as_bytes();
    // delay 30s > 宽限期(10s)：后台在宽限期内跑不完，业务写入不会落地。
    let (status, _, text) = post(
        port,
        "/api/v1/__test/slow-create-task?delay_ms=30000",
        &token,
        body,
        Some("slow-write-1"),
    );
    assert_eq!(status, 408, "慢业务必须超时: {text}");
    assert_eq!(task_count(&db), before, "超时不得写入半条数据");
    // 关键语义：超时**不等于**业务事务已回滚，占位必须保留，
    // 否则客户端用同一个 Key 重试会把业务写入执行两次。
    assert_eq!(
        cache_state(&db, "slow-write-1").as_deref(),
        Some("inflight"),
        "超时后必须保留幂等占位，不得释放"
    );
    assert_eq!(cache_rows(&db, "slow-write-1"), 1, "占位行必须还在");
    let _ = rest::stop();
}

#[test]
fn chunked_body_over_limit_returns_413() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "chunked");
    let port = start_rest(&db);

    let head = request_head(
        "POST /api/v1/tasks",
        &token,
        &[("Transfer-Encoding", "chunked")],
    );
    let mut stream = connect(port);
    stream.write_all(head.as_bytes()).unwrap();
    // 缺 Content-Length 也必须受限：累计 1.125MiB > MAX_BODY。
    let chunk = vec![b'x'; 64 * 1024];
    let mut write_failed = false;
    for _ in 0..18 {
        if stream.write_all(b"10000\r\n").is_err()
            || stream.write_all(&chunk).is_err()
            || stream.write_all(b"\r\n").is_err()
        {
            write_failed = true;
            break;
        }
    }
    if !write_failed {
        let _ = stream.write_all(b"0\r\n\r\n");
    }
    let (status, _, text) = read_http(&mut stream);
    assert_eq!(status, 413, "chunked 超限必须 413: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["error"]["code"], json!("VALIDATION"));
    let _ = rest::stop();
}

#[test]
fn content_length_over_limit_returns_413_without_reading_body() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "content-length");
    let port = start_rest(&db);

    // 声明超过上限的 Content-Length：一个字节都不发也必须立刻 413。
    let mut stream = connect(port);
    let head = request_head(
        "POST /api/v1/tasks",
        &token,
        &[("Content-Length", &(rest::MAX_BODY as u64 + 1).to_string())],
    );
    stream.write_all(head.as_bytes()).unwrap();
    let (status, headers, text) = read_http(&mut stream);
    assert_eq!(status, 413, "Content-Length 超限必须 413: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("VALIDATION"));
    assert_eq!(value["data"], Value::Null);
    assert_eq!(
        headers.get("x-request-id"),
        Some(&value["meta"]["request_id"].as_str().unwrap().to_string()),
        "413 也必须走统一信封且 request_id 一致"
    );
    assert_eq!(task_count(&db), 0, "超限请求不得写入业务数据");
    let _ = rest::stop();
}

#[test]
fn timeout_error_uses_unified_envelope_shape() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "envelope");
    let port = start_rest(&db);

    let mut stream = connect(port);
    let head = request_head(
        "POST /api/v1/tasks",
        &token,
        &[("Content-Length", "64")],
    );
    stream.write_all(head.as_bytes()).unwrap();
    let (status, headers, text) = read_http(&mut stream);
    assert_eq!(status, 408, "慢 body 必须 408: {text}");

    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    // 统一信封：四个字段齐备、类型正确。
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["data"], Value::Null);
    assert!(value["error"].is_object(), "必须有 error 对象");
    assert_eq!(value["error"]["code"], json!("UNAVAILABLE"));
    assert!(
        !value["error"]["message"].as_str().unwrap_or_default().is_empty(),
        "错误必须有可读文案"
    );
    assert!(value["error"]["retryable"].is_boolean());
    assert!(value["meta"].is_object(), "必须有 meta 对象");
    assert_eq!(value["meta"]["interface"], json!("rest"));
    assert!(!value["meta"]["request_id"].as_str().unwrap_or_default().is_empty());
    // 头与信封必须同源。
    assert_eq!(
        headers.get("x-request-id"),
        Some(&value["meta"]["request_id"].as_str().unwrap().to_string())
    );
    assert_eq!(
        headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(
        headers.get("cache-control").map(String::as_str),
        Some("no-store")
    );
    let _ = rest::stop();
}

// ── 认证 ───────────────────────────────────────────────────────

#[test]
fn origin_header_request_is_rejected() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "origin");
    let port = start_rest(&db);

    let (status, headers, text) = get(
        port,
        "/api/v1/tasks",
        Some(&token),
        &[("Origin", "http://evil.example")],
    );
    assert_eq!(status, 403, "带 Origin 必须 403: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("FORBIDDEN"));
    assert_eq!(value["data"], Value::Null);
    assert_eq!(
        headers.get("x-request-id"),
        Some(&value["meta"]["request_id"].as_str().unwrap().to_string())
    );
    // 绝不返回 CORS 头：浏览器页面无法直接调用。
    assert!(!headers.contains_key("access-control-allow-origin"));
    assert_eq!(task_count(&db), 0);
    let _ = rest::stop();
}

#[test]
fn missing_token_returns_401() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = start_rest(&db);

    let (status, headers, text) = get(port, "/api/v1/tasks", None, &[]);
    assert_eq!(status, 401, "缺 Token 必须 401: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("UNAUTHORIZED"));
    assert_eq!(
        headers.get("x-request-id"),
        Some(&value["meta"]["request_id"].as_str().unwrap().to_string())
    );
    let _ = rest::stop();
}

#[test]
fn invalid_token_returns_401() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let port = start_rest(&db);

    let (status, _, text) = get(
        port,
        "/api/v1/tasks",
        Some("tdm_totally_invalid_token_0001"),
        &[],
    );
    assert_eq!(status, 401, "无效 Token 必须 401: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("UNAUTHORIZED"));
    let _ = rest::stop();
}

#[test]
fn valid_token_reaches_business_handler() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, agent_id, token) = writable_agent(&db, "valid");
    let port = start_rest(&db);

    let body = r#"{"title":"有效 Token 任务"}"#.as_bytes();
    let (status, _, text) = post(port, "/api/v1/tasks", &token, body, None);
    assert_eq!(status, 201, "有效 Token 必须走到业务处理: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(true));
    assert_eq!(value["data"]["title"], json!("有效 Token 任务"));
    assert!(!value["data"]["id"].as_str().unwrap_or_default().is_empty());
    // meta 必须带上由 Token 解析出的真实身份。
    assert_eq!(value["meta"]["agent_id"], json!(agent_id));
    assert_eq!(value["meta"]["interface"], json!("rest"));
    assert_eq!(value["meta"]["actor"], json!("agent"));
    assert_eq!(task_count(&db), 1, "有效 Token 必须真的写入了业务数据");
    let _ = rest::stop();
}

// ── 幂等（P1-4）────────────────────────────────────────────────

#[test]
fn idempotency_store_claim_compares_fingerprints_and_expiry() {
    let db = db();
    let (row_id, _, _) = writable_agent(&db, "store");
    let fp_a = "a".repeat(64);
    let fp_b = "b".repeat(64);
    let key = "store-key-1";

    let attempt = match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key,
        &fp_a,
        "POST",
        "/api/v1/tasks",
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Acquired { attempt } => attempt,
        other => panic!("首次必须抢到占位: {other:?}"),
    };
    assert_eq!(attempt, 1, "首次占位的 fencing token 从 1 起");
    assert!(store::cache_complete(
        &db,
        &row_id,
        "rest",
        key,
        &fp_a,
        attempt,
        r#"{"success":true}"#,
        201
    )
    .unwrap());

    match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key,
        &fp_a,
        "POST",
        "/api/v1/tasks",
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Done {
            fingerprint,
            response_json,
            status_code,
        } => {
            assert_eq!(fingerprint, fp_a);
            assert_eq!(status_code, 201);
            assert_eq!(response_json, r#"{"success":true}"#);
        }
        other => panic!("相同指纹应命中 Done: {other:?}"),
    }
    // 不同指纹：仍然是 Done，但指纹不同 —— 由 rest 转 409，绝不重放。
    match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key,
        &fp_b,
        "POST",
        "/api/v1/other",
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Done { fingerprint, .. } => assert_eq!(fingerprint, fp_a),
        other => panic!("不同指纹也应读到旧行: {other:?}"),
    }

    // inflight 占位：不完成就再抢，必须 InProgress。
    let key2 = "store-key-2";
    let attempt2 = match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key2,
        &fp_b,
        "POST",
        "/api/v1/tasks",
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Acquired { attempt } => attempt,
        other => panic!("第二个 Key 必须抢到占位: {other:?}"),
    };
    assert!(matches!(
        store::cache_claim(
            &db,
            &row_id,
            "rest",
            key2,
            &fp_b,
            "POST",
            "/api/v1/tasks",
            300,
            24
        )
        .unwrap(),
        CacheClaim::InProgress { .. }
    ));
    assert!(store::cache_fail(&db, &row_id, "rest", key2, &fp_b, attempt2).unwrap());
    assert_eq!(cache_rows(&db, key2), 0, "失败必须删除占位，绝不缓存");

    // 过期的 done 行可被重新执行。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_request_cache SET expires_at = '2000-01-01T00:00:00'
             WHERE idempotency_key = ?1",
            rusqlite::params![key],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(matches!(
        store::cache_claim(
            &db,
            &row_id,
            "rest",
            key,
            &fp_b,
            "POST",
            "/api/v1/other",
            300,
            24
        )
        .unwrap(),
        CacheClaim::Acquired { .. }
    ));
}

#[test]
fn idempotency_http_replays_and_conflicts() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "http");
    let port = start_rest(&db);

    let body = r#"{"title":"幂等任务"}"#.as_bytes();

    let (first_status, _, first_body) = post(port, "/api/v1/tasks", &token, body, Some("http-idem-1"));
    assert_eq!(first_status, 201, "首次应创建: {first_body}");
    let first: Value = serde_json::from_str(&first_body).unwrap();
    assert_eq!(task_count(&db), 1);
    assert!(
        first["meta"].get("replayed").is_none(),
        "首次不应标记重放"
    );

    let (replay_status, _, replay_body) = post(port, "/api/v1/tasks", &token, body, Some("http-idem-1"));
    assert_eq!(replay_status, 201);
    let replay: Value = serde_json::from_str(&replay_body).unwrap();
    assert_eq!(replay["meta"]["replayed"], json!(true));
    assert_eq!(replay["data"]["id"], first["data"]["id"], "重放必须是同一响应");
    assert_eq!(task_count(&db), 1, "重放不得重复写入");

    let (conflict_status, _, conflict_body) = post(
        port,
        "/api/v1/tasks",
        &token,
        r#"{"title":"另一个任务"}"#.as_bytes(),
        Some("http-idem-1"),
    );
    assert_eq!(conflict_status, 409, "同 Key 不同 body 必须 409: {conflict_body}");
    let conflict: Value = serde_json::from_str(&conflict_body).unwrap();
    assert_eq!(conflict["error"]["code"], json!("CONFLICT"));
    assert!(
        conflict["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("IDEMPOTENCY_CONFLICT"),
        "冲突必须标明 IDEMPOTENCY_CONFLICT: {conflict_body}"
    );
    assert_eq!(task_count(&db), 1, "409 不得写入");
    let _ = rest::stop();
}

#[test]
fn idempotency_concurrent_same_key_writes_business_once() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "conc");
    let port = start_rest(&db);

    let body = r#"{"title":"并发幂等任务"}"#.as_bytes().to_vec();
    let runtime = tokio::runtime::Runtime::new().expect("测试运行时");
    // 真并发：两个请求都连上后，在屏障处同时放行，绝不顺序调用冒充并发。
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let barrier = Arc::clone(&barrier);
        let token = token.clone();
        let body = body.clone();
        handles.push(runtime.spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .expect("连接 REST");
            let head = format!(
                "POST /api/v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\n\
                 Authorization: Bearer {token}\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nIdempotency-Key: conc-1\r\nConnection: close\r\n\r\n",
                body.len()
            );
            barrier.wait().await;
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            stream.flush().await.unwrap();
            let mut raw = Vec::new();
            stream.read_to_end(&mut raw).await.unwrap();
            let text = String::from_utf8_lossy(&raw).to_string();
            let status: u16 = text
                .split_whitespace()
                .nth(1)
                .and_then(|code| code.parse().ok())
                .unwrap_or(0);
            (status, text)
        }));
    }
    runtime.block_on(barrier.wait());
    let results: Vec<(u16, String)> = handles
        .into_iter()
        .map(|handle| runtime.block_on(handle).expect("并发任务"))
        .collect();

    assert_eq!(results.len(), 2);
    for (status, text) in &results {
        assert_eq!(*status, 201, "并发同 Key 必须都拿到成功响应: {text}");
    }
    // 核心断言：并发同 Key 绝不能把业务写入执行两次。
    assert_eq!(task_count(&db), 1, "并发同 Key 只能写一条业务数据");
    let replayed = results
        .iter()
        .filter(|(_, text)| {
            let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
            serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v["meta"]["replayed"].as_bool())
                .unwrap_or(false)
        })
        .count();
    assert_eq!(replayed, 1, "必须恰好一个请求是重放: {results:?}");
    let _ = rest::stop();
}

#[test]
fn idempotency_fencing_blocks_stale_owner_from_touching_new_claim() {
    let db = db();
    let (row_id, _, _) = writable_agent(&db, "fence");
    let fp = "a".repeat(64);
    let key = "fence-1";

    let first = match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key,
        &fp,
        "POST",
        "/api/v1/tasks",
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Acquired { attempt } => attempt,
        other => panic!("首次必须抢到占位: {other:?}"),
    };
    assert_eq!(first, 1);

    // 租约过期 → 允许抢占，fencing token 自增。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_request_cache SET expires_at = '2000-01-01T00:00:00'
             WHERE idempotency_key = ?1",
            rusqlite::params![key],
        )?;
        Ok(())
    })
    .unwrap();
    let second = match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key,
        &fp,
        "POST",
        "/api/v1/tasks",
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Acquired { attempt } => attempt,
        other => panic!("过期占位必须可抢占: {other:?}"),
    };
    assert_eq!(second, 2, "抢占后 fencing token 必须自增");

    // 旧 owner 不得完成新请求的占位。
    assert!(
        !store::cache_complete(
            &db,
            &row_id,
            "rest",
            key,
            &fp,
            first,
            r#"{"success":true}"#,
            201
        )
        .unwrap(),
        "旧 owner 不得完成新请求的占位"
    );
    // 旧 owner 也不得删除新请求的占位。
    assert!(
        !store::cache_fail(&db, &row_id, "rest", key, &fp, first).unwrap(),
        "旧 owner 不得删除新请求的占位"
    );
    assert_eq!(cache_rows(&db, key), 1, "占位必须仍在，不得被旧 owner 删除");
    assert_eq!(
        cache_state(&db, key).as_deref(),
        Some("inflight"),
        "占位必须仍是新 owner 的进行中状态"
    );

    // 新 owner 可以完成。
    assert!(store::cache_complete(
        &db,
        &row_id,
        "rest",
        key,
        &fp,
        second,
        r#"{"success":true}"#,
        201
    )
    .unwrap());
    assert_eq!(cache_state(&db, key).as_deref(), Some("done"));
}

#[test]
fn idempotency_failure_is_not_cached() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "fail");
    let port = start_rest(&db);

    // 空标题 → 业务校验失败。
    let (status, _, text) = post(
        port,
        "/api/v1/tasks",
        &token,
        r#"{"title":""}"#.as_bytes(),
        Some("fail-1"),
    );
    assert_eq!(status, 400, "非法 body 必须 400: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("VALIDATION"));
    // 失败绝不缓存成成功：占位必须被释放。
    assert_eq!(cache_rows(&db, "fail-1"), 0, "失败响应不得留在幂等缓存里");
    assert_eq!(task_count(&db), 0, "失败请求不得写入业务数据");

    // 占位已释放 → 同一个 Key 可以重新执行（而不是重放失败结果）。
    let (status, _, text) = post(
        port,
        "/api/v1/tasks",
        &token,
        r#"{"title":"失败后重试"}"#.as_bytes(),
        Some("fail-1"),
    );
    assert_eq!(status, 201, "占位释放后必须允许重试: {text}");
    assert_eq!(task_count(&db), 1);
    let _ = rest::stop();
}

#[test]
fn idempotency_unavailable_cache_fails_closed() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "cache-down");
    let port = start_rest(&db);

    // 幂等缓存表不可用：必须失败关闭（503），绝不能降级成「无幂等执行」。
    db.with_conn(|conn| {
        conn.execute("DROP TABLE agent_request_cache", [])?;
        Ok(())
    })
    .unwrap();

    let (status, _, text) = post(
        port,
        "/api/v1/tasks",
        &token,
        r#"{"title":"缓存不可用"}"#.as_bytes(),
        Some("down-1"),
    );
    assert_eq!(status, 503, "缓存不可用必须 503 失败关闭: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["data"], Value::Null);
    assert_eq!(
        task_count(&db),
        0,
        "缓存不可用时不得降级执行业务写入"
    );
    let _ = rest::stop();
}

#[test]
fn idempotency_records_are_isolated_per_agent() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (row_a, _, token_a) = writable_agent(&db, "iso-a");
    let (row_b, _, token_b) = writable_agent(&db, "iso-b");
    let port = start_rest(&db);

    let body = r#"{"title":"跨 Agent 同 Key"}"#.as_bytes().to_vec();
    // 完全相同的 Key + 完全相同的 body，但属于不同 Agent。
    let (status_a, _, text_a) = post(port, "/api/v1/tasks", &token_a, &body, Some("shared-key"));
    assert_eq!(status_a, 201, "Agent A 必须正常创建: {text_a}");
    let (status_b, _, text_b) = post(port, "/api/v1/tasks", &token_b, &body, Some("shared-key"));
    assert_eq!(status_b, 201, "Agent B 必须正常创建，不得被 Agent A 的记录挡住: {text_b}");

    let value_a: Value = serde_json::from_str(&text_a).unwrap();
    let value_b: Value = serde_json::from_str(&text_b).unwrap();
    assert!(
        value_a["meta"].get("replayed").is_none(),
        "Agent A 不是重放"
    );
    assert!(
        value_b["meta"].get("replayed").is_none(),
        "Agent B 不得重放 Agent A 的结果"
    );
    assert_ne!(value_a["data"]["id"], value_b["data"]["id"], "两个 Agent 各写一条");
    assert_eq!(task_count(&db), 2, "不同 Agent 的同 Key 必须各自落库");

    // 隔离靠唯一键里的 agent_row_id。
    let rows = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM agent_request_cache WHERE idempotency_key = ?1",
                rusqlite::params!["shared-key"],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .expect("统计缓存行");
    assert_eq!(rows, 2, "两个 Agent 必须各有一条幂等记录");
    assert_eq!(
        cache_rows_of_agent(&db, "shared-key", &row_a),
        1,
        "Agent A 拥有自己的记录"
    );
    assert_eq!(
        cache_rows_of_agent(&db, "shared-key", &row_b),
        1,
        "Agent B 拥有自己的记录"
    );
    let _ = rest::stop();
}

#[test]
fn idempotency_scope_skips_local_and_non_post() {
    let agent = Principal::agent("row-1".into(), "agent-x".into(), Source::Rest);
    let local = Principal::local(Source::Rest);
    let system = Principal::system(Source::Rest);

    assert_eq!(
        rest::idempotency_scope(&agent, &hyper::Method::POST, Some("k")),
        Some(("k".to_string(), "row-1".to_string())),
        "已注册 Agent + POST + Key 才走幂等"
    );
    // 本机用户 / 系统身份没有 agent_row_id → 完全跳过幂等逻辑，
    // 绝不与 Agent 共用幂等记录。
    assert!(
        rest::idempotency_scope(&local, &hyper::Method::POST, Some("k")).is_none(),
        "本机身份不得走幂等"
    );
    assert!(
        rest::idempotency_scope(&system, &hyper::Method::POST, Some("k")).is_none(),
        "系统身份不得走幂等"
    );
    // 非 POST / 无 Key / 空 Key / 超长 Key 都不得走幂等。
    assert!(rest::idempotency_scope(&agent, &hyper::Method::GET, Some("k")).is_none());
    assert!(rest::idempotency_scope(&agent, &hyper::Method::PATCH, Some("k")).is_none());
    assert!(rest::idempotency_scope(&agent, &hyper::Method::POST, None).is_none());
    assert!(rest::idempotency_scope(&agent, &hyper::Method::POST, Some("   ")).is_none());
    assert!(rest::idempotency_scope(&agent, &hyper::Method::POST, Some(&"x".repeat(129))).is_none());
}

#[test]
fn idempotency_retry_after_timeout_does_not_duplicate_write() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "late");
    let port = start_rest(&db);

    let body = r#"{"title":"迟到完成任务"}"#.as_bytes().to_vec();
    // delay 4s：大于请求预算（测试构建 2s），小于宽限期（10s）。
    // → 第一次必然超时；后台在宽限期内跑完并写缓存。
    let path = "/api/v1/__test/slow-create-task?delay_ms=4000";
    let (status, _, text) = post(port, path, &token, &body, Some("late-1"));
    assert_eq!(status, 408, "第一次必须超时: {text}");
    assert_eq!(task_count(&db), 0, "超时时后台还在等待，表里不应有数据");
    assert_eq!(
        cache_state(&db, "late-1").as_deref(),
        Some("inflight"),
        "超时后必须保留占位"
    );

    // 等后台在宽限期内跑完。
    let deadline = Instant::now() + Duration::from_secs(12);
    while task_count(&db) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(task_count(&db), 1, "后台迟到完成必须写入业务数据");
    let deadline = Instant::now() + Duration::from_secs(3);
    while cache_state(&db, "late-1").as_deref() != Some("done") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        cache_state(&db, "late-1").as_deref(),
        Some("done"),
        "迟到完成必须写幂等缓存，供重试重放"
    );

    // 客户端用同一个 Key 重试 → 只能重放首次结果，绝不重复写业务数据。
    let (status, _, text) = post(port, path, &token, &body, Some("late-1"));
    assert_eq!(status, 201, "重试必须拿到成功响应: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        value["meta"]["replayed"],
        json!(true),
        "重试必须是重放，不得重新执行"
    );
    assert_eq!(
        task_count(&db),
        1,
        "超时后重试不得把业务写入执行第二次"
    );
    let _ = rest::stop();
}

#[test]
fn idempotency_retry_while_inflight_returns_409() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "inflight");
    let port = start_rest(&db);

    let body = r#"{"title":"进行中的请求"}"#.as_bytes().to_vec();
    // delay 25s 远大于宽限期(10s)：后台在整个测试窗口内都跑不完。
    let path = "/api/v1/__test/slow-create-task?delay_ms=25000";
    let (status, _, text) = post(port, path, &token, &body, Some("inflight-1"));
    assert_eq!(status, 408, "第一次必须超时: {text}");
    assert_eq!(
        cache_state(&db, "inflight-1").as_deref(),
        Some("inflight"),
        "超时后占位必须仍在处理中"
    );

    // 立刻重试同一个 Key：占位仍在处理中 → 409 IDEMPOTENCY_IN_PROGRESS。
    let (status, _, text) = post(port, path, &token, &body, Some("inflight-1"));
    assert_eq!(status, 409, "占位处理中必须 409: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("CONFLICT"));
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("IDEMPOTENCY_IN_PROGRESS"),
        "必须标明 IDEMPOTENCY_IN_PROGRESS: {text}"
    );
    assert_eq!(
        task_count(&db),
        0,
        "409 期间不得重复写业务数据"
    );
    let _ = rest::stop();
}

// ── v82-B Task C：committed 恢复（业务已提交、响应未缓存）──────────────

/// 与 `rest::fingerprint` 完全同源的请求指纹，避免测试自造公式漂移。
fn request_fingerprint(method: &hyper::Method, path: &str, body: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(body);
    let body_hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    rest::fingerprint(method, path, &HashMap::new(), &body_hash)
}

/// 建一个可解析的项目：项目根（workspace_projects）+ 关联计划。
/// v92 统一项目身份后，授权与归属都锚定项目根；只建无根的历史计划行
/// 会被 `resolve_project_root` 判为不存在。
fn seed_project(db: &Db, id: &str) {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO workspace_projects
               (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
             VALUES (?1, ?1, 'general', 'active', '', NULL, '', ?2, ?2)",
            rusqlite::params![id, now],
        )?;
        conn.execute(
            "INSERT INTO planning_projects
               (id, name, workspace_project_id, is_active, created_at, updated_at)
             VALUES (?1, ?1, ?1, 1, ?2, ?2)",
            rusqlite::params![id, now],
        )?;
        Ok(())
    })
    .expect("写入项目根与计划");
}

/// 授予项目根授权（v92 统一授权第三层：`mcp_agent_grants`）。
fn grant_project(db: &Db, row_id: &str, project: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                row_id,
                project,
                crate::agents::now_iso()
            ],
        )?;
        Ok(())
    })
    .expect("授予项目授权");
}

#[test]
fn project_tasks_use_both_grants_and_keep_link_writes_atomic() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    seed_project(&db, "task-project-a");
    seed_project(&db, "task-project-b");
    let (row, _, writer) = writable_agent(&db, "project-task-writer");
    for cap in ["projects.read", "projects.write"] {
        mcp_perm::grant(&db, &row, cap, "").unwrap();
    }
    grant_project(&db, &row, "task-project-a");
    let reader = mcp_auth::create_agent(&db, "project-task-reader", "reader").unwrap();
    mcp_auth::set_agent_scope(&db, &reader.info.id, "project_rw").unwrap();
    grant_project(&db, &reader.info.id, "task-project-a");
    mcp_perm::grant(&db, &reader.info.id, "projects.read", "task-project-a").unwrap();

    let port = start_rest(&db);
    let run_post = |path: &str, body: &Value, key: Option<&str>| {
        let (status, _, text) = post(port, path, &writer, body.to_string().as_bytes(), key);
        (status, serde_json::from_str::<Value>(&text).unwrap())
    };
    let (denied, _) = run_post("/api/v1/tasks", &json!({
        "title": "cross-project", "project_id": "task-project-b",
    }), None);
    assert_eq!(denied, 403);
    assert_eq!(task_count(&db), 0);
    let in_project = json!({"title": "visible", "project_id": "task-project-a"});
    let (status, response) = run_post("/api/v1/tasks", &in_project, Some("project-create"));
    assert_eq!(status, 201, "{response}");
    let task = response["data"]["id"].as_str().unwrap();
    let (status, response) = run_post("/api/v1/tasks", &json!({"title": "peer"}), None);
    assert_eq!(status, 201, "{response}");
    let peer = response["data"]["id"].as_str().unwrap();
    let (missing_cap, _, _) = get(port, "/api/v1/tasks?project=task-project-a", Some(&reader.token), &[]);
    assert_eq!(missing_cap, 403);
    mcp_perm::grant(&db, &reader.info.id, "tasks.read", task).unwrap();

    let project = json!({"project_id": "task-project-a"});
    for _ in 0..2 {
        let (status, response) = run_post(&format!("/api/v1/tasks/{peer}/link"), &project, None);
        assert_eq!(status, 201, "{response}");
        assert_eq!(response["data"]["linked"], true);
    }
    let list = |token: &str, offset: u32| {
        let (status, _, text) = get(port, &format!("/api/v1/tasks?project=task-project-a&limit=1&offset={offset}"), Some(token), &[]);
        assert_eq!(status, 200, "{text}");
        serde_json::from_str::<Value>(&text).unwrap()
    };
    let first = list(&reader.token, 0);
    assert_eq!(first["data"][0]["id"], task);
    assert_eq!(first["meta"]["pagination"]["total"], 1);
    assert_eq!(list(&reader.token, 1)["data"], json!([]));
    assert_eq!(list(&writer, 0)["meta"]["pagination"]["total"], 2);
    let (denied, _, _) = get(port, "/api/v1/tasks?project=task-project-b", Some(&writer), &[]);
    assert_eq!(denied, 403);

    for _ in 0..2 {
        let (status, response) = run_post(&format!("/api/v1/tasks/{peer}/unlink"), &project, None);
        assert_eq!(status, 201, "{response}");
        assert_eq!(response["data"]["linked"], false);
    }
    assert_eq!(list(&writer, 0)["meta"]["pagination"]["total"], 1);
    assert_eq!(task_count(&db), 2);
    mcp_auth::revoke_project(&db, &row, "task-project-a").unwrap();
    let (denied, _) = run_post("/api/v1/tasks", &in_project, Some("project-create"));
    assert_eq!(denied, 403);
    assert_eq!(task_count(&db), 2);
    let _ = rest::stop();
}

fn handoff_count(db: &Db) -> i64 {
    db.with_read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM agent_handoffs", [], |r| r.get(0))?))
        .expect("统计交接")
}

#[test]
fn idempotency_committed_recovery_rebuilds_task_without_rewrite() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (row_id, agent_id, token) = writable_agent(&db, "commit-recover");
    let principal = Principal::agent(row_id.clone(), agent_id.clone(), Source::Rest);
    let key = "commit-recover-1";
    let path = "/api/v1/tasks";
    let body = r#"{"title":"提交后崩溃"}"#.as_bytes();
    let fp = request_fingerprint(&hyper::Method::POST, path, body);

    let attempt = match store::cache_claim(
        &db,
        &row_id,
        "rest",
        key,
        &fp,
        "POST",
        path,
        300,
        24,
    )
    .unwrap()
    {
        CacheClaim::Acquired { attempt } => attempt,
        other => panic!("首次必须抢到占位: {other:?}"),
    };
    let guard = store::RequestCacheGuard::new(&row_id, "rest", key, &fp, attempt);
    let input: crate::agent_access::service::TaskCreateInput =
        serde_json::from_slice(body).expect("解析任务输入");
    let task = crate::agent_access::service::create_task_guarded(&db, &principal, input, &guard, "")
        .expect("业务事务提交");
    assert_eq!(task_count(&db), 1, "业务只写一条");
    // 模拟「业务已提交、响应未写缓存」：不调用 cache_complete。
    assert_eq!(
        cache_state(&db, key).as_deref(),
        Some("committed"),
        "提交后必须处于 committed"
    );

    // 再次 claim：committed 行不可抢占，只给出恢复指针。
    match store::cache_claim(&db, &row_id, "rest", key, &fp, "POST", path, 300, 24).unwrap() {
        CacheClaim::Committed {
            operation_kind,
            operation_id,
            ..
        } => {
            assert_eq!(operation_kind, "task");
            assert_eq!(operation_id, task.id, "operation 指针必须指向已提交任务");
        }
        other => panic!("committed 行必须返回 Committed: {other:?}"),
    }

    let port = start_rest(&db);
    let (status, _, text) = post(port, path, &token, body, Some(key));
    assert_eq!(status, 201, "恢复必须返回与创建一致的状态码: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(true));
    assert_eq!(value["meta"]["replayed"], json!(true), "恢复响应标记重放");
    assert_eq!(value["data"]["id"], json!(task.id), "必须重建为同一任务");
    assert_eq!(task_count(&db), 1, "恢复不得重复写业务数据");
    assert_eq!(
        cache_state(&db, key).as_deref(),
        Some("done"),
        "恢复后应补写响应缓存"
    );
    let _ = rest::stop();
}

#[test]
fn idempotency_committed_row_is_never_preempted_after_lease_expiry() {
    let db = db();
    let (row_id, agent_id, _) = writable_agent(&db, "commit-lease");
    let principal = Principal::agent(row_id.clone(), agent_id, Source::Rest);
    let key = "commit-lease-1";
    let path = "/api/v1/tasks";
    let body = r#"{"title":"committed 不可抢占"}"#.as_bytes();
    let fp = request_fingerprint(&hyper::Method::POST, path, body);

    let attempt = match store::cache_claim(&db, &row_id, "rest", key, &fp, "POST", path, 300, 24)
        .unwrap()
    {
        CacheClaim::Acquired { attempt } => attempt,
        other => panic!("首次必须抢到占位: {other:?}"),
    };
    let guard = store::RequestCacheGuard::new(&row_id, "rest", key, &fp, attempt);
    let input: crate::agent_access::service::TaskCreateInput = serde_json::from_slice(body).unwrap();
    crate::agent_access::service::create_task_guarded(&db, &principal, input, &guard, "")
        .expect("业务事务提交");

    // 把租约改成过去：inflight 会被抢占，committed 必须不可抢占。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_request_cache SET expires_at = '2000-01-01T00:00:00'
             WHERE idempotency_key = ?1",
            rusqlite::params![key],
        )?;
        Ok(())
    })
    .unwrap();

    match store::cache_claim(&db, &row_id, "rest", key, &fp, "POST", path, 300, 24).unwrap() {
        CacheClaim::Committed { attempt: same, .. } => {
            assert_eq!(same, attempt, "committed 行不得让出执行权，attempt 不变");
        }
        other => panic!("committed 行过期后也不得被抢占: {other:?}"),
    }
    // 错误的 fencing token 既不能完成也不能释放 committed 行。
    assert!(!store::cache_complete(
        &db,
        &row_id,
        "rest",
        key,
        &fp,
        attempt + 99,
        r#"{"success":true}"#,
        201
    )
    .unwrap());
    assert!(!store::cache_fail(&db, &row_id, "rest", key, &fp, attempt + 99).unwrap());
    assert_eq!(
        cache_state(&db, key).as_deref(),
        Some("committed"),
        "committed 行不得被错误令牌改写"
    );
    assert_eq!(task_count(&db), 1);
}

#[test]
fn idempotency_committed_without_operation_pointer_requires_recovery() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (row_id, agent_id, token) = writable_agent(&db, "commit-handoff");
    mcp_perm::grant(&db, &row_id, "handoffs.write", "").expect("授权 handoffs.write");
    let key = "commit-handoff-1";
    let path = "/api/v1/agents/handoffs";
    let body = format!(r#"{{"to_agent_id":"{agent_id}","summary":"崩溃前提交的交接"}}"#);
    let body = body.as_bytes();
    let fp = request_fingerprint(&hyper::Method::POST, path, body);

    match store::cache_claim(&db, &row_id, "rest", key, &fp, "POST", path, 300, 24)
        .unwrap()
    {
        CacheClaim::Acquired { .. } => {}
        other => panic!("首次必须抢到占位: {other:?}"),
    };
    // 模拟「业务事务已提交，但该写路由没有记录 operation 指针」的缓存行。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_request_cache SET state='committed', committed_at=?2
             WHERE agent_row_id=?1 AND interface='rest' AND idempotency_key=?3",
            rusqlite::params![&row_id, crate::agents::now_iso(), key],
        )?;
        Ok(())
    })
    .expect("标记 committed");
    assert_eq!(handoff_count(&db), 0, "本用例不执行业务写入");
    match store::cache_claim(&db, &row_id, "rest", key, &fp, "POST", path, 300, 24).unwrap() {
        CacheClaim::Committed {
            operation_kind,
            operation_id,
            ..
        } => {
            assert!(operation_kind.is_empty(), "该写路由未记录 operation 指针");
            assert!(operation_id.is_empty());
        }
        other => panic!("必须返回 Committed: {other:?}"),
    }

    let port = start_rest(&db);
    let (status, _, text) = post(port, path, &token, body, Some(key));
    assert_eq!(status, 409, "无可恢复指针必须 409: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    assert_eq!(value["success"], json!(false));
    assert_eq!(value["error"]["code"], json!("CONFLICT"));
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("IDEMPOTENCY_RECOVERY_REQUIRED"),
        "必须标明 IDEMPOTENCY_RECOVERY_REQUIRED: {text}"
    );
    assert_eq!(handoff_count(&db), 0, "禁止重新执行写入");
    let _ = rest::stop();
}

// ── v82-B Task A：REST 读取授权 ─────────────────────────────────

/// 只注册、不授予任何能力的 Agent（scope=project_rw，能力为空）。
fn bare_agent(db: &Db, suffix: &str) -> (String, String, String) {
    let created =
        mcp_auth::create_agent(db, &format!("rest-v82-bare-{suffix}"), "REST 空能力 Agent")
            .expect("创建 Agent");
    mcp_auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
    (created.info.id, created.info.agent_id, created.token)
}

#[test]
fn rest_decision_reads_are_project_scoped() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    seed_project(&db, "proj-a");
    seed_project(&db, "proj-b");
    let (row_id, _, token) = bare_agent(&db, "decision");
    mcp_perm::grant(&db, &row_id, "decisions.read", "proj-a").expect("授权项目 A 决策读");
    // v92 统一授权第三层：project_rw 的项目型读取还要求项目根授权。
    grant_project(&db, &row_id, "proj-a");

    let local = Principal::local(Source::Ui);
    let other = crate::agent_access::store::create_decision(
        &db,
        &local,
        crate::agent_access::store::DecisionInput {
            title: "项目 B 决策".into(),
            project_id: Some("proj-b".into()),
            project_kind: Some("planning".into()),
            context: String::new(),
            decision: "只在 B 可见".into(),
            consequences: String::new(),
            alternatives: String::new(),
            tags: Vec::new(),
            status: None,
        },
    )
    .expect("写入项目 B 决策");

    let port = start_rest(&db);
    let (status, _, text) = get(port, "/api/v1/decisions?project=proj-b", Some(&token), &[]);
    assert_eq!(status, 403, "项目 A 的 Agent 不得读项目 B 决策: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["error"]["code"], json!("FORBIDDEN"));

    let detail = format!("/api/v1/decisions/{}", other.id);
    let (status, _, text) = get(port, &detail, Some(&token), &[]);
    assert_eq!(status, 403, "项目 B 决策详情必须 403: {text}");

    // 自己的项目仍可读（不是一刀切封禁）。
    let (status, _, text) = get(port, "/api/v1/decisions?project=proj-a", Some(&token), &[]);
    assert_eq!(status, 200, "项目 A 必须可读: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["data"], json!([]));
    let _ = rest::stop();
}

#[test]
fn rest_activity_requires_read_and_filters_other_projects() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    seed_project(&db, "proj-a");
    seed_project(&db, "proj-b");

    // 无任何读能力 → 403，不返回空列表让人猜。
    let (_, _, bare_token) = bare_agent(&db, "activity");
    // 只有项目 A 决策读 → 活动只可见项目 A。
    let (row_id, _, token) = bare_agent(&db, "activity-scoped");
    mcp_perm::grant(&db, &row_id, "decisions.read", "proj-a").expect("授权项目 A 决策读");
    // v92 统一授权第三层：project_rw 的项目型读取还要求项目根授权。
    grant_project(&db, &row_id, "proj-a");

    let local = Principal::local(Source::Ui);
    for (project, action) in [("proj-a", "decision.create"), ("proj-b", "decision.create")] {
        crate::agent_access::store::log_activity(
            &db,
            &crate::agent_access::store::ActivityEntry {
                principal: &local,
                action,
                resource_kind: "decision",
                resource_id: "d-1",
                project_id: project,
                request_id: "",
                success: true,
                error_code: "",
                detail: "测试活动",
                revision: None,
                duration_ms: 0,
            },
        );
    }

    let port = start_rest(&db);
    let (status, _, text) = get(port, "/api/v1/agents/activity", Some(&bare_token), &[]);
    assert_eq!(status, 403, "无读能力必须 403: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["error"]["code"], json!("FORBIDDEN"));

    let (status, _, text) = get(port, "/api/v1/agents/activity", Some(&token), &[]);
    assert_eq!(status, 200, "项目 A 可读活动: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    let items = value["data"].as_array().expect("items 数组");
    assert_eq!(items.len(), 1, "不得泄露项目 B 的活动: {text}");
    assert_eq!(items[0]["project_id"], json!("proj-a"));
    let _ = rest::stop();
}

#[test]
fn rest_sync_endpoints_require_projects_read() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, _, token) = writable_agent(&db, "sync-denied");
    let port = start_rest(&db);

    let (status, _, text) = get(port, "/api/v1/sync/status", Some(&token), &[]);
    assert_eq!(status, 403, "缺少 projects.read 必须 403: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["error"]["code"], json!("FORBIDDEN"));
    let (status, _, text) = get(port, "/api/v1/sync/conflicts", Some(&token), &[]);
    assert_eq!(status, 403, "缺少 projects.read 必须 403: {text}");

    // 本机/系统身份自动放行（授权层语义）。
    assert!(
        super::permissions::require(
            &db,
            &Principal::local(Source::Rest),
            crate::mcp::permissions::Capability::ProjectsRead,
            ""
        )
        .is_ok(),
        "本机身份必须自动放行 projects.read"
    );

    // 授权后返回 200：状态不需要工作空间；冲突列表需要已初始化工作空间。
    let (row_id, _, granted) = bare_agent(&db, "sync-granted");
    mcp_perm::grant(&db, &row_id, "projects.read", "").expect("授权 projects.read");
    let (status, _, text) = get(port, "/api/v1/sync/status", Some(&granted), &[]);
    assert_eq!(status, 200, "有 projects.read 必须 200: {text}");
    let _ = rest::stop();
}

#[test]
fn revoked_token_returns_401() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (row_id, _, token) = writable_agent(&db, "revoked");
    let port = start_rest(&db);

    let (status, _, text) = get(port, "/api/v1/tasks", Some(&token), &[]);
    assert_eq!(status, 200, "撤销前必须可访问: {text}");
    mcp_auth::revoke_agent(&db, &row_id).expect("撤销 Agent");
    let (status, _, text) = get(port, "/api/v1/tasks", Some(&token), &[]);
    assert_eq!(status, 401, "撤销后必须 401: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["error"]["code"], json!("UNAUTHORIZED"));
    let _ = rest::stop();
}

// ── Agent 操作生命周期（v86）──────────────────────────────────────

/// REST 真实写入：操作与业务数据一致，资源 ID 来自提交后的返回值。
#[test]
fn rest_write_records_committed_operation_with_real_resource_id() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, agent_id, token) = writable_agent(&db, "op-rest");
    let port = start_rest(&db);

    let body = r#"{"title":"REST 操作记录"}"#.as_bytes();
    let (status, _, text) = post(port, "/api/v1/tasks", &token, body, None);
    assert_eq!(status, 201, "写入应成功: {text}");
    let value: Value = serde_json::from_str(&text).expect("JSON 信封");
    let task_id = value["data"]["id"].as_str().expect("任务 ID").to_string();

    let query = super::operations::OperationQuery {
        agent_id: Some(agent_id),
        ..Default::default()
    };
    let (ops, page) = super::operations::list(&db, &query).unwrap();
    assert_eq!(page.total, 1, "一次 REST 写入只应有一条操作: {ops:?}");
    assert_eq!(ops[0].interface, "rest");
    assert_eq!(ops[0].action, "task.create");
    assert_eq!(ops[0].status, super::operations::OperationStatus::Committed);
    assert_eq!(ops[0].resource_id, task_id, "必须绑定真实资源 ID");
    assert!(ops[0].revision.is_some(), "完成时应记录 revision");
    let _ = rest::stop();
}

/// 参数错误：操作收敛为 failed，不得停留在 running。
#[test]
fn rest_validation_error_marks_operation_failed() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let (_, agent_id, token) = writable_agent(&db, "op-rest-fail");
    let port = start_rest(&db);

    let body = r#"{"title":""}"#.as_bytes();
    let (status, _, text) = post(port, "/api/v1/tasks", &token, body, None);
    assert_eq!(status, 400, "空标题应校验失败: {text}");

    let query = super::operations::OperationQuery {
        agent_id: Some(agent_id),
        ..Default::default()
    };
    let (ops, _) = super::operations::list(&db, &query).unwrap();
    let op = ops.first().expect("失败也应留下操作记录");
    assert_eq!(op.status, super::operations::OperationStatus::Failed);
    assert_eq!(op.error_code, "VALIDATION");
    let active = super::operations::active(
        &db,
        &super::operations::ActiveFilter::default(),
    )
    .unwrap();
    assert!(active.iter().all(|item| item.id != op.id));
    let _ = rest::stop();
}

// ── 领域四入口（REST）：PUT 幂等、冲突、提交后响应丢失恢复 ─────────

fn put(
    port: u16,
    path: &str,
    token: &str,
    body: &[u8],
    idem: Option<&str>,
) -> (u16, HashMap<String, String>, String) {
    let mut extra: Vec<(String, String)> = vec![("Content-Length".into(), body.len().to_string())];
    if let Some(key) = idem {
        extra.push(("Idempotency-Key".into(), key.to_string()));
    }
    let extra_refs: Vec<(&str, &str)> = extra
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let mut stream = connect(port);
    let head = request_head(&format!("PUT {path}"), token, &extra_refs);
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    read_http(&mut stream)
}

fn seed_domain_project(db: &Db, kind: &str) -> String {
    let id = format!("p-rest-domain-{}", uuid::Uuid::new_v4());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO workspace_projects
               (id,name,kind,status,root_path,dev_project_id,note,created_at,updated_at)
             VALUES (?1,'REST 领域测试',?2,'active','',NULL,'','2026-01-01','2026-01-01')",
            rusqlite::params![id, kind],
        )?;
        Ok(())
    })
    .unwrap();
    id
}

fn seed_rest_chapter(db: &Db, project: &str, id: &str, content: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO novel_chapters
               (id, project_id, volume_id, title, content, word_count, sort_order, created_at, updated_at)
             VALUES (?1, ?2, NULL, '第01章', ?3, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![id, project, content],
        )?;
        Ok(())
    })
    .unwrap();
}

fn seed_rest_comic(db: &Db, project: &str, media: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO comic_episodes
               (id, project_id, episode_no, title, synopsis, script, status, progress,
                character_ids_json, sort_order, created_at, updated_at)
             VALUES ('ep-rest', ?1, 1, '第1集', '', 'SECRET', 'draft', 0, '[]', 0,
                '2026-01-01','2026-01-01')",
            [project],
        )?;
        conn.execute(
            "INSERT INTO comic_shots
               (id, project_id, episode_id, shot_no, description, character_ids_json,
                scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                asset_refs_json, note, sort_order, created_at, updated_at)
             VALUES ('shot-rest', ?1, 'ep-rest', 1, '', '[]', NULL, '', '', '', 0, 'todo',
                '[]', '', 0, '2026-01-01', '2026-01-01')",
            [project],
        )?;
        conn.execute(
            "INSERT INTO comic_media_versions
               (id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                version_label, status, review_note, source, created_at, updated_at)
             VALUES (?1, ?2, 'shot-rest', NULL, NULL, '', 'image', 'v1', 'candidate', '',
                'imported', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![media, project],
        )?;
        Ok(())
    })
    .unwrap();
}

fn domain_agent(db: &Db, suffix: &str, project: &str) -> String {
    let (row, _, token) = writable_agent(db, suffix);
    mcp_perm::grant(db, &row, "projects.read", "").unwrap();
    mcp_perm::grant(db, &row, "projects.write", "").unwrap();
    mcp_auth::grant_project(db, &row, project).unwrap();
    token
}

fn domain_operations(db: &Db, action: &str) -> Vec<(String, String, String, String)> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT resource_kind, resource_id, project_id, status
             FROM agent_operations WHERE action = ?1 ORDER BY started_at, id",
        )?;
        let rows = stmt.query_map([action], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
    .unwrap()
}

fn chapter_content(db: &Db, id: &str) -> String {
    db.with_read(|conn| {
        Ok(conn.query_row(
            "SELECT content FROM novel_chapters WHERE id=?1",
            [id],
            |r| r.get(0),
        )?)
    })
    .unwrap()
}

#[test]
fn rest_put_novel_content_replays_conflicts_and_has_one_operation() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let project = seed_domain_project(&db, "novel");
    seed_rest_chapter(&db, &project, "ch-rest", "初始");
    let token = domain_agent(&db, "rest-novel", &project);
    let port = start_rest(&db);

    let path = format!("/api/v1/projects/{project}/novel/chapters/ch-rest/content");
    let body = br#"{"content":"rest-write","expected_revision":0}"#;
    let (first_status, _, first_text) = put(port, &path, &token, body, Some("rest-novel-1"));
    assert_eq!(first_status, 200, "PUT 领域写应 200: {first_text}");
    let first: Value = serde_json::from_str(&first_text).unwrap();
    assert_eq!(first["data"]["revision"], 1);
    assert_eq!(chapter_content(&db, "ch-rest"), "rest-write");

    let (replay_status, _, replay_text) = put(port, &path, &token, body, Some("rest-novel-1"));
    assert_eq!(replay_status, 200);
    let replay: Value = serde_json::from_str(&replay_text).unwrap();
    assert_eq!(replay["meta"]["replayed"], json!(true));
    assert_eq!(replay["data"], first["data"], "重放必须返回原结果");
    assert_eq!(chapter_content(&db, "ch-rest"), "rest-write");
    let ops = domain_operations(&db, "novel.chapter.content.update");
    assert_eq!(ops.len(), 1, "同一 Idempotency-Key 重放不得产生第二条 Operation");
    assert_eq!(ops[0].0, "novel.chapter");
    assert_eq!(ops[0].1, "ch-rest", "resource_id 必须是章节 ID");
    assert_eq!(ops[0].2, project, "project_id 必须是项目根");
    assert_eq!(ops[0].3, "committed");

    let conflict_body = br#"{"content":"different","expected_revision":1}"#;
    let (conflict_status, _, conflict_text) =
        put(port, &path, &token, conflict_body, Some("rest-novel-1"));
    assert_eq!(conflict_status, 409, "同 Key 不同内容必须冲突: {conflict_text}");
    assert_eq!(chapter_content(&db, "ch-rest"), "rest-write");
    let _ = rest::stop();
}

#[test]
fn rest_put_novel_recovers_committed_business_without_response() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let project = seed_domain_project(&db, "novel");
    seed_rest_chapter(&db, &project, "ch-recover", "初始");
    let token = domain_agent(&db, "rest-recover", &project);
    let port = start_rest(&db);
    let path = format!("/api/v1/projects/{project}/novel/chapters/ch-recover/content");
    let body = br#"{"content":"lost-response","expected_revision":0}"#;
    let (status, _, text) = put(port, &path, &token, body, Some("rest-recover-1"));
    assert_eq!(status, 200, "{text}");
    let first: Value = serde_json::from_str(&text).unwrap();

    // 模拟「业务提交 + committed 占位已写，但响应缓存尚未写回」时进程退出。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_request_cache
             SET state='committed', response_json='', committed_at='2026-01-01T00:00:00Z'
             WHERE idempotency_key='rest-recover-1'",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let (status, _, text) = put(port, &path, &token, body, Some("rest-recover-1"));
    assert_eq!(status, 200, "恢复必须返回成功: {text}");
    let recovered: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(recovered["meta"]["replayed"], json!(true));
    assert_eq!(recovered["data"], first["data"], "必须从资源指针恢复原结果");
    assert_eq!(chapter_content(&db, "ch-recover"), "lost-response");
    assert_eq!(
        domain_operations(&db, "novel.chapter.content.update").len(),
        1,
        "恢复不得重新执行或新增 Operation"
    );
    let revision: i64 = db
        .with_read(|conn| {
            Ok(conn.query_row(
                "SELECT revision FROM agent_resource_revisions
                 WHERE resource_kind='novel.chapter' AND resource_id='ch-recover'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(revision, 1, "恢复不得推进 revision");
    let _ = rest::stop();
}

#[test]
fn rest_comic_update_and_adopt_record_true_resources_and_recover() {
    let _serial = serial();
    let _ = rest::stop();
    let db = Arc::new(db());
    let project = seed_domain_project(&db, "ai_comic");
    seed_rest_comic(&db, &project, "m-rest");
    let token = domain_agent(&db, "rest-comic", &project);
    let port = start_rest(&db);

    let path = format!("/api/v1/projects/{project}/comic/media-versions/m-rest");
    let body = br#"{"version_label":"v2","status":"candidate","review_note":"candidate-note","expected_revision":0}"#;
    let (status, _, text) = put(port, &path, &token, body, Some("rest-comic-1"));
    assert_eq!(status, 200, "{text}");
    let first: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(first["data"]["revision"], 1);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE agent_request_cache
             SET state='committed', response_json='', committed_at='2026-01-01T00:00:00Z'
             WHERE idempotency_key='rest-comic-1'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let (status, _, text) = put(port, &path, &token, body, Some("rest-comic-1"));
    assert_eq!(status, 200, "{text}");
    let recovered: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(recovered["data"], first["data"], "comic.media_version 必须可恢复");

    let adopt_path = format!("/api/v1/projects/{project}/comic/media-versions/m-rest/adopt");
    let adopt_body = br#"{"expected_revision":1}"#;
    let (status, _, text) = post(port, &adopt_path, &token, adopt_body, Some("rest-comic-adopt"));
    assert_eq!(status, 201, "{text}");
    let adopted: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(adopted["data"]["media"]["status"], "adopted");
    assert_eq!(adopted["data"]["revision"], 2);

    let update_ops = domain_operations(&db, "comic.media.update");
    assert_eq!(update_ops.len(), 1, "PUT 重放/恢复不得新增 Operation");
    assert_eq!(update_ops[0].1, "m-rest");
    assert_eq!(update_ops[0].2, project);
    let adopt_ops = domain_operations(&db, "comic.media.adopt");
    assert_eq!(adopt_ops.len(), 1);
    assert_eq!(adopt_ops[0].1, "m-rest");
    assert_eq!(adopt_ops[0].2, project);
    assert_eq!(adopt_ops[0].3, "committed");

    let (detail_status, _, detail_text) = get(
        port,
        &format!("/api/v1/projects/{project}/comic/media-versions/m-rest"),
        Some(&token),
        &[],
    );
    assert_eq!(detail_status, 200, "{detail_text}");
    let detail: Value = serde_json::from_str(&detail_text).unwrap();
    assert_eq!(detail["data"]["status"], "adopted");
    assert_eq!(detail["data"]["revision"], 2, "素材详情必须带当前 revision");
    let _ = rest::stop();
}
