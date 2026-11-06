//! MCP 端到端测试：spawn 同二进制 `task-dock --mcp-server` 子进程，
//! stdin/stdout 驱动 initialize → tools/list → 读 → 授权写 → 幂等 → 冲突 →
//! 审计校验 → 重连。bridge（主进程角色）在测试进程内启动，stdio 子进程与
//! 真实客户端一样只经 loopback HTTP + agent token 访问。
//!
//! 隔离：TASK_DOCK_DATA_DIR 指向临时目录，绝不触碰真实用户数据。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

struct StdioSession {
    child: Child,
    rx: mpsc::Receiver<String>,
    stdin: std::process::ChildStdin,
    next_id: i64,
}

impl StdioSession {
    /// 关闭 stdin 并等待子进程退出。
    fn close_and_wait(mut self) -> std::process::ExitStatus {
        drop(self.stdin);
        self.child.wait().expect("等待子进程退出")
    }

    fn spawn(data_dir: &std::path::Path, agent_token: Option<&str>) -> StdioSession {
        let exe = env!("CARGO_BIN_EXE_task-dock");
        let mut cmd = Command::new(exe);
        cmd.arg("--mcp-server")
            .env("TASK_DOCK_DATA_DIR", data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(token) = agent_token {
            cmd.env("TASKDOCK_MCP_TOKEN", token);
        } else {
            cmd.env_remove("TASKDOCK_MCP_TOKEN");
        }
        let mut child = cmd.spawn().expect("spawn --mcp-server 子进程");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        StdioSession {
            child,
            rx,
            stdin,
            next_id: 1,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let raw = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.send_expect(&raw.to_string(), id)
    }

    fn notify(&mut self, method: &str) {
        let raw = json!({"jsonrpc":"2.0","method":method});
        self.stdin
            .write_all(raw.to_string().as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .expect("写通知");
    }

    fn raw(&mut self, line: &str) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send_expect(line, id)
    }

    fn send_expect(&mut self, line: &str, id: i64) -> Value {
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .expect("写请求");
        let deadline = Duration::from_secs(20);
        let start = std::time::Instant::now();
        loop {
            let line = self
                .rx
                .recv_timeout(deadline.saturating_sub(start.elapsed()))
                .expect("等待响应超时");
            let v: Value = serde_json::from_str(&line).expect("响应应为 JSON");
            if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                return v;
            }
            // 忽略其它 id 的响应（不应发生，防御性跳过）
        }
    }
}

/// 测试内表示「用户已创建、未经 Agent 授权」的项目夹具。
struct ExistingProject {
    id: String,
    revision: i64,
}

fn tool_result_value(resp: &Value) -> Value {
    assert!(resp.get("error").is_none(), "不应为协议错误: {resp}");
    let result = &resp["result"];
    assert_eq!(result["isError"], false, "工具业务失败: {result}");
    let text = result["content"][0]["text"].as_str().expect("content text");
    serde_json::from_str(text).expect("工具结果应为 JSON")
}

fn tool_error_message(resp: &Value) -> String {
    let result = &resp["result"];
    assert_eq!(result["isError"], true, "应为 isError result: {resp}");
    let text = result["content"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    payload["message"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdio_end_to_end_handshake_read_write_conflict_audit_reconnect() {
    let dir = std::env::temp_dir().join(format!("td-mcp-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    // 主进程角色：打开隔离库、启动 bridge、写传输文件、准备 Agent 与数据
    let db = std::sync::Arc::new(task_dock_lib::db::Db::open(&dir.join("task-dock.db")).unwrap());
    let (emit, _events) = {
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = log.clone();
        let cb: task_dock_lib::mcp::ChangeEmitter = std::sync::Arc::new(move |c| {
            sink.lock().unwrap().push(c);
        });
        (cb, log)
    };
    let bridge = task_dock_lib::mcp::bridge::start(db.clone(), emit.clone())
        .await
        .unwrap();
    task_dock_lib::mcp::write_transport_config(&dir, bridge.port, &bridge.token, true).unwrap();

    // 用户侧准备：project_rw Agent + 一个已有项目（用户创建，未授权给 Agent）
    let created = task_dock_lib::mcp::auth::create_agent(&db, "e2e-agent", "端到端").unwrap();
    let token = created.token;
    task_dock_lib::mcp::auth::set_agent_scope(&db, &created.info.id, "project_rw").unwrap();
    // 测试夹具：模拟「用户自己建的项目」（命令层路径已由单测覆盖）
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO planning_projects (id, name, revision, created_at, updated_at)
             VALUES ('proj-user', '既有项目', 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .map_err(task_dock_lib::error::AppError::from)
    })
    .unwrap();
    let existing = ExistingProject {
        id: "proj-user".into(),
        revision: 3,
    };

    // ── 会话 1：握手 → 工具发现 → 读 → 未授权写 → 授权后写 → 幂等 → 冲突 ──
    let mut s1 = StdioSession::spawn(&dir, Some(&token));
    let init = s1.request(
        "initialize",
        json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "task-dock");
    s1.notify("notifications/initialized");

    let tools = s1.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 18, "应暴露 18 个工具: {names:?}");

    // project_rw 只读取已授权项目，初始列表不泄漏用户项目名称。
    let listed = tool_result_value(&s1.request(
        "tools/call",
        json!({"name":"taskdock_list_projects","arguments":{}}),
    ));
    assert_eq!(listed.as_array().unwrap().len(), 0);

    // 写未授权项目 → JSON-RPC -32002
    let denied = s1.request(
        "tools/call",
        json!({"name":"taskdock_update_project","arguments":{
            "project_id": existing.id, "expected_revision": existing.revision, "name":"越权"}}),
    );
    assert_eq!(
        denied["error"]["code"], -32002,
        "未授权应为 RPC 错误: {denied}"
    );

    // 用户授权该项目
    task_dock_lib::mcp::auth::grant_project(&db, &created.info.id, &existing.id).unwrap();
    let listed = tool_result_value(&s1.request(
        "tools/call",
        json!({"name":"taskdock_list_projects","arguments":{}}),
    ));
    assert_eq!(listed.as_array().unwrap().len(), 1);

    // 授权后写成功，revision +1
    let updated = tool_result_value(&s1.request(
        "tools/call",
        json!({"name":"taskdock_update_project","arguments":{
            "project_id": existing.id, "expected_revision": existing.revision, "name":"端到端改名",
            "requestId":"e2e-req-1"}}),
    ));
    assert_eq!(updated["revision"], existing.revision + 1);

    // 同 requestId 重放 → 原结果，不再消耗 revision
    let replayed = tool_result_value(&s1.request(
        "tools/call",
        json!({"name":"taskdock_update_project","arguments":{
            "project_id": existing.id, "expected_revision": existing.revision, "name":"端到端改名",
            "requestId":"e2e-req-1"}}),
    ));
    assert_eq!(
        replayed["revision"],
        existing.revision + 1,
        "重放返回原结果"
    );
    assert_eq!(replayed["name"], "端到端改名");

    let changed_parameters = s1.request(
        "tools/call",
        json!({"name":"taskdock_update_project","arguments":{
            "project_id": existing.id, "expected_revision": existing.revision, "name":"不同参数",
            "requestId":"e2e-req-1"}}),
    );
    assert!(
        tool_error_message(&changed_parameters).contains("不同参数"),
        "同一 requestId 不得复用到不同参数: {changed_parameters}"
    );

    // 过期 revision → 明确冲突
    let conflict = s1.request(
        "tools/call",
        json!({"name":"taskdock_update_project","arguments":{
            "project_id": existing.id, "expected_revision": existing.revision, "name":"迟到"}}),
    );
    assert!(
        tool_error_message(&conflict).contains("版本冲突"),
        "{conflict}"
    );

    // 通知不回包：发送后立即发 ping，验证只有 ping 的响应
    s1.notify("notifications/initialized");
    let ping = s1.request("ping", json!({}));
    assert!(ping.get("result").is_some());

    // 审计校验：写成功 + 拒绝都在 mcp_audit_log
    let audit_count: i64 = db
        .with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM mcp_audit_log WHERE action='taskdock_update_project'",
                [],
                |r| r.get(0),
            )
            .map_err(task_dock_lib::error::AppError::from)
        })
        .unwrap();
    assert!(
        audit_count >= 3,
        "应记录成功/重放前的拒绝等审计: {audit_count}"
    );
    let denied_authz: i64 = db
        .with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM mcp_audit_log WHERE authz=0 AND agent_id='e2e-agent'",
                [],
                |r| r.get(0),
            )
            .map_err(task_dock_lib::error::AppError::from)
        })
        .unwrap();
    assert!(denied_authz >= 1, "授权拒绝应留审计");

    // 关闭 stdin → 子进程应干净退出 0
    let status = s1.close_and_wait();
    assert!(
        status.success() || status.code() == Some(0),
        "stdio 子进程应正常退出: {status:?}"
    );
    let _ = bridge.stop().await;

    // ── 会话 2（重连/Task Dock 重启模拟）：新 bridge + 新传输文件，重新握手 ──
    let bridge2 = task_dock_lib::mcp::bridge::start(db.clone(), emit.clone())
        .await
        .unwrap();
    task_dock_lib::mcp::write_transport_config(&dir, bridge2.port, &bridge2.token, true).unwrap();
    let mut s2 = StdioSession::spawn(&dir, Some(&token));
    let init2 = s2.request("initialize", json!({"protocolVersion":"2024-11-05"}));
    assert_eq!(init2["result"]["protocolVersion"], "2024-11-05");
    let again = tool_result_value(&s2.request(
        "tools/call",
        json!({"name":"taskdock_get_project","arguments":{"project_id": existing.id}}),
    ));
    assert_eq!(again["name"], "端到端改名", "重连后数据一致");
    drop(bridge2.stop());

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdio_returns_unavailable_when_task_dock_not_running() {
    let dir = std::env::temp_dir().join(format!("td-mcp-e2e-off-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // 不写传输文件（Task Dock 未运行 / 未启用 MCP）
    let mut s = StdioSession::spawn(&dir, Some("tdm_anything"));
    let resp =
        s.raw(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string());
    assert_eq!(
        resp["error"]["code"], -32000,
        "应返回明确不可用错误: {resp}"
    );
    assert!(resp["error"]["message"]
        .as_str()
        .unwrap()
        .contains("不可用"));

    // 传输文件存在但 enabled=false → 同样明确错误
    task_dock_lib::mcp::write_transport_config(&dir, 1, "t", false).unwrap();
    let resp2 =
        s.raw(&json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}).to_string());
    assert_eq!(
        resp2["error"]["code"], -32000,
        "未启用也应明确报错: {resp2}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdio_without_agent_token_reports_authorization_error() {
    let dir = std::env::temp_dir().join(format!("td-mcp-e2e-notok-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = std::sync::Arc::new(task_dock_lib::db::Db::open(&dir.join("task-dock.db")).unwrap());
    let bridge = task_dock_lib::mcp::bridge::start(db, std::sync::Arc::new(|_| {}))
        .await
        .unwrap();
    task_dock_lib::mcp::write_transport_config(&dir, bridge.port, &bridge.token, true).unwrap();

    // 未配置 TASKDOCK_MCP_TOKEN → stdio 侧直接报不可用/未配置，不挂死
    let mut s = StdioSession::spawn(&dir, None);
    let resp =
        s.raw(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string());
    assert_eq!(
        resp["error"]["code"], -32000,
        "缺少 agent token 应明确报错: {resp}"
    );
    let _ = bridge.stop().await;
    std::fs::remove_dir_all(&dir).ok();
}
