//! 跨窗口上下文：当前模块 / 项目 / 任务 / 目录 / 规划 / 知识条目。
//!
//! 规则：
//! - **按窗口 label 各存一份**（真正的每窗口上下文），两个窗口不会互相覆盖
//!   「当前项目 / 当前目录」；窗口关闭时对应条目移除，避免残留指向已删除实体；
//! - 只存在内存，不落库；
//! - 变更后广播 `transfer:context-changed`（全窗口），载荷带 `window`，
//!   前端只接受自己窗口 label 的那一份；
//! - 上下文只用于「推荐目标」，绝不用于「决定写入位置」——执行必须显式传目标。

use std::collections::HashMap;
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
    /// 来源窗口标签（main / workspace）。
    #[serde(default)]
    pub window: String,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Default)]
pub struct ContextState {
    /// 窗口 label → 该窗口的上下文；单窗口内部字段仍然整体替换，避免读写撕裂。
    inner: Mutex<HashMap<String, TransferContext>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

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

impl ContextState {
    pub fn get(&self, window: &str) -> TransferContext {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .get(window)
            .cloned()
            .unwrap_or_else(|| TransferContext {
                window: window.to_string(),
                ..Default::default()
            })
    }

    /// 合并更新：只覆盖显式给出的字段（`None` 保持原值）。
    /// 需要清空单个字段时由前端传空字符串（会被规范化为 `None`）。
    pub fn update(&self, window: &str, patch: TransferContext) -> TransferContext {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = guard.entry(window.to_string()).or_insert_with(|| TransferContext {
            window: window.to_string(),
            ..Default::default()
        });
        if !patch.module.is_empty() {
            entry.module = patch.module.clone();
        }
        if let Some(v) = normalize(patch.project_id) {
            entry.project_id = v;
        }
        if let Some(v) = normalize(patch.task_id) {
            entry.task_id = v;
        }
        if let Some(v) = normalize(patch.directory) {
            entry.directory = v;
        }
        if let Some(v) = normalize(patch.planning_id) {
            entry.planning_id = v;
        }
        if let Some(v) = normalize(patch.knowledge_id) {
            entry.knowledge_id = v;
        }
        if let Some(v) = normalize(patch.capture_id) {
            entry.capture_id = v;
        }
        entry.window = window.to_string();
        entry.updated_at = now_ms();
        entry.clone()
    }

    pub fn clear(&self, window: &str) -> TransferContext {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let next = TransferContext {
            window: window.to_string(),
            updated_at: now_ms(),
            ..Default::default()
        };
        guard.insert(window.to_string(), next.clone());
        next
    }

    /// 窗口关闭：移除该窗口的上下文（不广播，避免其他窗口被无关刷新打扰）。
    pub fn forget(&self, window: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(window);
    }

    /// 诊断：当前持有上下文的窗口数量。
    pub fn window_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(window: &str, project: &str, directory: &str) -> TransferContext {
        TransferContext {
            project_id: Some(project.into()),
            directory: Some(directory.into()),
            window: window.into(),
            ..Default::default()
        }
    }

    #[test]
    fn contexts_are_isolated_per_window() {
        let state = ContextState::default();
        let main = state.update("main", patch("main", "p-main", "C:/main"));
        let workspace = state.update("workspace", patch("workspace", "p-ws", "C:/ws"));

        assert_eq!(main.project_id.as_deref(), Some("p-main"));
        assert_eq!(main.directory.as_deref(), Some("C:/main"));
        assert_eq!(workspace.project_id.as_deref(), Some("p-ws"));
        assert_eq!(workspace.directory.as_deref(), Some("C:/ws"));

        // 两个窗口各自读取互不影响（不是同一份全局状态）。
        assert_eq!(state.get("main").project_id.as_deref(), Some("p-main"));
        assert_eq!(state.get("workspace").project_id.as_deref(), Some("p-ws"));
        assert_eq!(state.window_count(), 2);
    }

    #[test]
    fn updating_one_window_does_not_touch_the_other() {
        let state = ContextState::default();
        state.update("main", patch("main", "p-main", "C:/main"));
        state.update("workspace", patch("workspace", "p-ws", "C:/ws"));

        // 再更新 main：workspace 的当前项目/目录保持不变。
        state.update("main", patch("main", "p-main-2", "C:/main2"));
        let workspace = state.get("workspace");
        assert_eq!(workspace.project_id.as_deref(), Some("p-ws"));
        assert_eq!(workspace.directory.as_deref(), Some("C:/ws"));
    }

    #[test]
    fn clear_and_forget_only_affect_target_window() {
        let state = ContextState::default();
        state.update("main", patch("main", "p-main", "C:/main"));
        state.update("workspace", patch("workspace", "p-ws", "C:/ws"));

        let cleared = state.clear("main");
        assert!(cleared.project_id.is_none());
        assert_eq!(state.get("workspace").project_id.as_deref(), Some("p-ws"));

        state.forget("workspace");
        assert_eq!(state.window_count(), 1);
        // 被移除的窗口读取到的是空上下文，而不是别的窗口的数据。
        assert!(state.get("workspace").project_id.is_none());
        assert_eq!(state.get("workspace").window, "workspace");
    }

    #[test]
    fn unknown_window_starts_empty() {
        let state = ContextState::default();
        let empty = state.get("never-seen");
        assert!(empty.module.is_empty());
        assert!(empty.directory.is_none());
        assert_eq!(empty.window, "never-seen");
    }
}
