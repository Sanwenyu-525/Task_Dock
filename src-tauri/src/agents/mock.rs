//! Mock Adapter：无需安装真实 Agent 即可测试完整状态流程。
//! UI 与通知中均明确标注「模拟」，不作为真实接入证据。
//!
//! v0.2（P1-6）：移除 30 秒自动剧本——Mock 只在用户于「模拟控制台」手动触发时运行，
//! 不再持续产生无意义的模拟通知。transport 标记为 mock，永不置 verified。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use crate::agents::{AgentAdapter, AgentEvent, AgentHub};

/// 由前端「模拟控制台」触发的剧本。
#[derive(Debug, Clone, Deserialize)]
pub struct MockScenario {
    pub session_title: String,
    /// completed | failed | waiting_only
    pub outcome: String,
}

static MOCK_TX: OnceLock<Mutex<tokio::sync::mpsc::UnboundedSender<MockScenario>>> = OnceLock::new();

/// 供命令层调用：触发一次模拟会话（手动触发专用）。
pub fn trigger(scenario: MockScenario) -> bool {
    if let Some(tx) = MOCK_TX.get() {
        if let Ok(guard) = tx.lock() {
            return guard.send(scenario).is_ok();
        }
    }
    false
}

pub struct MockAdapter;

impl MockAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl AgentAdapter for MockAdapter {
    fn id(&self) -> &'static str {
        "mock"
    }

    fn spawn(self: Box<Self>, hub: std::sync::Arc<AgentHub>) -> tauri::async_runtime::JoinHandle<()> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<MockScenario>();
        let _ = MOCK_TX.set(Mutex::new(tx));
        tauri::async_runtime::spawn(async move {
            tracing::info!("Mock Adapter 启动（仅手动触发，不再自动生成模拟事件）");
            while let Some(sc) = rx.recv().await {
                run_scenario(&hub, &sc.session_title, &sc.outcome).await;
            }
        })
    }
}

fn event(session: &str, run: &str, title: &str, state: &str, message: Option<&str>, pending: Option<Vec<String>>) -> AgentEvent {
    AgentEvent {
        source_id: "mock".to_string(),
        session_id: session.to_string(),
        run_id: Some(run.to_string()),
        task_title: Some(title.to_string()),
        state: state.to_string(),
        message: message.map(|m| m.to_string()),
        pending_items: pending,
        occurred_at: None,
        transport: Some("mock".into()),
        ..Default::default()
    }
}

async fn run_scenario(hub: &AgentHub, session_title: &str, outcome: &str) {
    let session = format!("mock-sess-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let run = format!("mock-run-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    tracing::info!("[模拟] 手动触发会话 {} ({})", session, session_title);

    let _ = hub.ingest(&event(&session, &run, session_title, "running", Some("模拟：开始执行"), None));
    tokio::time::sleep(Duration::from_millis(1200)).await;

    if outcome != "waiting_only" {
        let _ = hub.ingest(&event(
            &session,
            &run,
            session_title,
            "waiting",
            Some("模拟：等待用户确认一项操作（仅演示）"),
            None,
        ));
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let _ = hub.ingest(&event(&session, &run, session_title, "running", Some("模拟：用户已确认，继续执行"), None));
        tokio::time::sleep(Duration::from_millis(1200)).await;
    }

    match outcome {
        "failed" => {
            let _ = hub.ingest(&event(&session, &run, session_title, "failed", Some("模拟：执行失败（演示）"), None));
        }
        "waiting_only" => {
            let _ = hub.ingest(&event(
                &session,
                &run,
                session_title,
                "waiting",
                Some("模拟：等待用户确认一项操作（仅演示）"),
                None,
            ));
        }
        _ => {
            let _ = hub.ingest(&event(
                &session,
                &run,
                session_title,
                "completed",
                Some("模拟：本轮执行完成"),
                Some(vec![
                    "检查测试覆盖率报告（模拟待办）".to_string(),
                    "更新接口文档（模拟待办）".to_string(),
                ]),
            ));
        }
    }
    tracing::info!("[模拟] 会话结束 {} outcome={}", session, outcome);
}
