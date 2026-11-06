//! 自定义快捷键 IPC 命令。
//!
//! 前端只通过这些命令读写快捷键；失败时返回结构化 `HotkeyChangeOutcome`
//! （`ok=false` + 明确原因），而不是把“注册失败”包装成保存成功。

use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::hotkeys::{self, HotkeyChangeOutcome, HotkeyResetOutcome, HotkeySnapshot};

fn manager() -> AppResult<&'static std::sync::Arc<hotkeys::HotkeysManager>> {
    hotkeys::manager().ok_or_else(|| AppError::Unavailable("快捷键模块尚未初始化".to_string()))
}

#[tauri::command]
pub fn hotkeys_snapshot() -> AppResult<HotkeySnapshot> {
    Ok(manager()?.snapshot())
}

/// 修改组合或启用状态；`accelerator`/`enabled` 省略表示保持不变。
#[tauri::command]
pub fn hotkeys_change(
    app: AppHandle,
    action: String,
    accelerator: Option<String>,
    enabled: Option<bool>,
) -> AppResult<HotkeyChangeOutcome> {
    let outcome = manager()?.change(&action, accelerator.as_deref(), enabled)?;
    if outcome.persisted {
        hotkeys::emit_changed(&app);
    }
    Ok(outcome)
}

/// 恢复默认；`action` 为空时恢复全部。
#[tauri::command]
pub fn hotkeys_reset(app: AppHandle, action: Option<String>) -> AppResult<HotkeyResetOutcome> {
    let outcome = manager()?.reset(action.as_deref())?;
    if outcome.results.iter().any(|result| result.persisted) {
        hotkeys::emit_changed(&app);
    }
    Ok(outcome)
}
