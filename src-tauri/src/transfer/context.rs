//! 跨窗口上下文：当前模块 / 项目 / 任务 / 目录 / 规划 / 知识条目。
//!
//! 规则：
//! - 只存在内存（`Mutex`），不落库；窗口关闭即消失，避免残留指向已删除实体；
//! - 变更后广播 `transfer:context-changed`（全窗口），前端据此刷新；
//! - 上下文只用于「推荐目标」，绝不用于「决定写入位置」——执行必须显式传目标；
//! - 字段随窗口独立：两个窗口各自持有一份，互不覆盖（用 `window` 区分来源）。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppResult;

pub const CONTEXT_EVENT: &str = "transfer:context-changed";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferContext {
    #[serde(default)]
    pub module: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub planning_id: Option<String>,
    #[serde(default)]
    pub knowledge_id: Option<String>,
    #[serde(default)]
    pub capture_id: Option<String>,
    /// 来源窗口标签（main / workspace），仅用于诊断与去重。
    #[serde(default)]
    pub window: String,
    #[serde(default)]
    pub updated_at: i64,
}

pub struct ContextState {
    inner: Mutex<TransferContext>,
}

impl Default for ContextState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(TransferContext::default()),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ContextState {
    pub fn get(&self) -> TransferContext {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 合并更新：只覆盖显式给出的字段（`None` 保持原值）。
    /// 需要清空单个字段时由前端传空字符串（会被规范化为 `None`）。
    pub fn update(&self, patch: TransferContext) -> TransferContext {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !patch.module.is_empty() {
            guard.module = patch.module.clone();
        }
        if let Some(v) = normalize(patch.project_id) {
            guard.project_id = v;
        }
        if let Some(v) = normalize(patch.task_id) {
            guard.task_id = v;
        }
        if let Some(v) = normalize(patch.directory) {
            guard.directory = v;
        }
        if let Some(v) = normalize(patch.planning_id) {
            guard.planning_id = v;
        }
        if let Some(v) = normalize(patch.knowledge_id) {
            guard.knowledge_id = v;
        }
        if let Some(v) = normalize(patch.capture_id) {
            guard.capture_id = v;
        }
        if !patch.window.is_empty() {
            guard.window = patch.window.clone();
        }
        guard.updated_at = now_ms();
        guard.clone()
    }

    pub fn clear(&self) -> TransferContext {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = TransferContext {
            updated_at: now_ms(),
            ..Default::default()
        };
        guard.clone()
    }
}

/// `Some("")` 表示显式清空，返回 `Some(None)` 由调用方忽略；
/// 这里用两层 Option 语义：外层 None = 未提供；Some(None) = 清空。
#[allow(clippy::option_option)]
fn normalize(value: Option<String>) -> Option<Option<String>> {
    match value {
        None => None,
        Some(v) => {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() {
                Some(None)
            } else {
                Some(Some(trimmed))
            }
        }
    }
}

pub fn state(app: &AppHandle) -> AppResult<std::sync::Arc<ContextState>> {
    app.try_state::<std::sync::Arc<ContextState>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| crate::error::AppError::Unavailable("上下文状态未初始化".into()))
}

pub fn publish(app: &AppHandle, context: &TransferContext) {
    let _ = app.emit(CONTEXT_EVENT, context);
}
