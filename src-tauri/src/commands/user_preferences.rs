//! 用户偏好（语言 / 桌面微件布局）IPC 命令。
//!
//! 运行时来源仍是 WebView localStorage；前端在变更时防抖调用
//! `set_user_preferences` 把镜像写入数据目录 `preferences.json`，
//! 备份/恢复通过该文件打包。命令只做校验、归一化与原子写，不直接操作 UI。

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::user_preferences::{self, WidgetItem, CONFIG_VERSION};

#[derive(Debug, Clone, Serialize)]
pub struct UserPreferencesView {
    pub version: i64,
    pub locale: Option<String>,
    pub widgets: Option<Vec<WidgetItem>>,
    /// 应用网格手动顺序（含加号伪项）；None = 从未手动排序。
    pub app_grid_order: Option<Vec<String>>,
    /// 归一化提示（非法语言回退、未知微件被过滤等），供设置页/启动诊断展示。
    pub warnings: Vec<String>,
    /// true = 刚恢复过配置，前端必须以文件为准覆盖本机 localStorage。
    pub apply_restore: bool,
    /// 待回执的恢复会话 ID；随 `set_user_preferences` 的 `appliedRestoreId` 回传。
    pub restore_id: Option<String>,
}

fn view(data_dir: &std::path::Path) -> UserPreferencesView {
    let loaded = user_preferences::load_preferences(data_dir);
    let (restore_id, pending_warning) = user_preferences::pending_restore(data_dir);
    let mut warnings = loaded.warnings;
    if let Some(warning) = pending_warning {
        warnings.push(warning);
    }
    UserPreferencesView {
        version: CONFIG_VERSION,
        locale: loaded.locale,
        widgets: loaded.widgets,
        app_grid_order: loaded.app_grid_order,
        warnings,
        apply_restore: restore_id.is_some(),
        restore_id,
    }
}

#[tauri::command]
pub fn get_user_preferences(app: AppHandle) -> AppResult<UserPreferencesView> {
    let data_dir = crate::app_data_dir(&app);
    Ok(view(&data_dir))
}

/// 写入偏好镜像。字段省略（None）表示保留文件中的该字段。
/// `applied_restore_id` 与待应用标记一致时清除标记（前端已把恢复值写入 localStorage）。
#[tauri::command]
pub fn set_user_preferences(
    app: AppHandle,
    locale: Option<String>,
    widgets: Option<Vec<serde_json::Value>>,
    app_grid_order: Option<Vec<serde_json::Value>>,
    applied_restore_id: Option<String>,
) -> AppResult<UserPreferencesView> {
    let data_dir = crate::app_data_dir(&app);
    let existing = user_preferences::load_preferences(&data_dir);
    let mut warnings: Vec<String> = Vec::new();

    let next_locale: Option<String> = match locale.as_deref() {
        Some(raw) => {
            let (normalized, issues) = user_preferences::normalize_locale(Some(raw));
            warnings.extend(issues);
            normalized
        }
        None => existing.locale.clone(),
    };
    let next_widgets: Option<Vec<WidgetItem>> = match widgets {
        Some(raw) => {
            let value = serde_json::Value::Array(raw);
            let (normalized, issues) = user_preferences::normalize_widgets(&value);
            warnings.extend(issues);
            Some(normalized)
        }
        None => existing.widgets.clone(),
    };
    let next_app_grid_order: Option<Vec<String>> = match app_grid_order {
        Some(raw) => {
            let value = serde_json::Value::Array(raw);
            let (normalized, issues) = user_preferences::normalize_app_grid_order(&value);
            warnings.extend(issues);
            normalized
        }
        None => existing.app_grid_order.clone(),
    };

    if next_locale.is_some() || next_widgets.is_some() || next_app_grid_order.is_some() {
        user_preferences::write_preferences(
            &data_dir,
            next_locale.as_deref(),
            next_widgets.as_deref(),
            next_app_grid_order.as_deref(),
        )
        .map_err(|message| AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, message)))?;
    }

    if let Some(restore_id) = applied_restore_id.as_deref() {
        if let Err(message) = user_preferences::clear_restore_pending(&data_dir, restore_id) {
            tracing::warn!("清除偏好恢复标记失败: {}", message);
        }
    }

    let mut result = view(&data_dir);
    // 保留本次输入归一化产生的警告（读取路径对同一文件会再次产生，因此去重）。
    for warning in warnings {
        if !result.warnings.contains(&warning) {
            result.warnings.push(warning);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_reports_pending_marker_and_valid_locale() {
        let dir = std::env::temp_dir().join(format!(
            "td-pref-cmd-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let widgets = user_preferences::normalize_widgets(&serde_json::json!([])).0;
        user_preferences::write_preferences(&dir, Some("en-US"), Some(&widgets), None).unwrap();
        user_preferences::mark_restore_pending(&dir, "sess-1").unwrap();
        let view = view(&dir);
        assert_eq!(view.locale.as_deref(), Some("en-US"));
        assert!(view.apply_restore);
        assert_eq!(view.restore_id.as_deref(), Some("sess-1"));
        assert_eq!(view.widgets.as_ref().unwrap().len(), widgets.len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
