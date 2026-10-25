//! 文件投递 Adapter：轮询应用数据目录下的 agent-inbox/，
//! 任何 Agent（含暂未验证官方接口的 Qoder / WorkBuddy）都可以通过写入 JSON 文件上报状态。
//!
//! 文件格式：单个事件对象或事件数组，字段见 `AgentEvent`。
//! 处理成功即删除；解析失败移入 failed/ 并记录日志（不写入文件内容，避免泄露）。

use std::time::Duration;

use tauri::Manager;

use crate::agents::{AgentEvent, AgentHub, AgentAdapter};

pub struct FileDropAdapter;

impl FileDropAdapter {
    pub fn new() -> Self {
        Self
    }
}

fn inbox_dir(hub: &AgentHub) -> std::path::PathBuf {
    hub.app()
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("agent-inbox")
}

async fn process_file(hub: &AgentHub, path: &std::path::Path) {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("读取投递文件失败 {:?}: {}", path.file_name(), e);
            return;
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("投递文件 JSON 解析失败 {:?}: {}", path.file_name(), e);
            move_to_failed(hub, path).await;
            return;
        }
    };
    let events: Vec<AgentEvent> = match value {
        serde_json::Value::Object(_) => match serde_json::from_value::<AgentEvent>(value) {
            Ok(mut ev) => {
                if ev.transport.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
                    ev.transport = Some("file".into());
                }
                vec![ev]
            }
            Err(e) => {
                tracing::warn!("投递文件事件校验失败 {:?}: {}", path.file_name(), e);
                move_to_failed(hub, path).await;
                return;
            }
        },
        serde_json::Value::Array(arr) => {
            let mut out = Vec::new();
            let mut bad = false;
            for item in arr {
                match serde_json::from_value::<AgentEvent>(item) {
                    Ok(mut ev) => {
                        if ev.transport.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
                            ev.transport = Some("file".into());
                        }
                        out.push(ev)
                    }
                    Err(e) => {
                        tracing::warn!("投递文件数组元素校验失败: {}", e);
                        bad = true;
                    }
                }
            }
            if out.is_empty() || bad {
                move_to_failed(hub, path).await;
                return;
            }
            out
        }
        _ => {
            move_to_failed(hub, path).await;
            return;
        }
    };
    let mut ok = true;
    for ev in &events {
        if let Err(e) = hub.ingest(ev) {
            tracing::warn!("投递事件被拒绝: {}", e);
            ok = false;
        }
    }
    if ok {
        let _ = tokio::fs::remove_file(path).await;
        tracing::info!("已处理投递文件 {:?}（{} 个事件）", path.file_name(), events.len());
    } else {
        move_to_failed(hub, path).await;
    }
}

async fn move_to_failed(hub: &AgentHub, path: &std::path::Path) {
    let failed = inbox_dir(hub).join("failed");
    let _ = tokio::fs::create_dir_all(&failed).await;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown.json".into());
    let dest = failed.join(format!("{}-{}", chrono::Utc::now().timestamp_millis(), name));
    let _ = tokio::fs::rename(path, dest).await;
}

impl AgentAdapter for FileDropAdapter {
    fn id(&self) -> &'static str {
        "file_drop"
    }

    fn spawn(self: Box<Self>, hub: std::sync::Arc<AgentHub>) -> tauri::async_runtime::JoinHandle<()> {
        tauri::async_runtime::spawn(async move {
            let dir = inbox_dir(&hub);
            let _ = tokio::fs::create_dir_all(&dir).await;
            tracing::info!("文件投递 Adapter 启动，监听目录 {:?}", dir);
            loop {
                if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let path = entry.path();
                        if path.extension().map(|e| e == "json").unwrap_or(false) {
                            process_file(&hub, &path).await;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
    }
}
