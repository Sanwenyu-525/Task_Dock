//! 命令层：前端 invoke 的统一入口。

pub mod actions;
pub mod agent_stats;
pub mod agents;
pub mod audio;
pub mod audit;
pub mod backup;
pub mod clipboard;
pub mod command_phrases;
pub mod context;
pub mod diagnostics;
pub mod data;
pub mod dev_workbench;
pub mod dragdrop;
pub mod file_workspace;
pub mod focus;
pub mod global_search;
pub mod hotkeys;
pub mod lifecycle;
pub mod mobile_sync;
pub mod navigation;
pub mod notes;
pub mod planning;
pub mod project_workspace;
pub mod resource_cleanup;
pub mod restore;
pub mod scenario;
pub mod settings;
pub mod shelf;
pub mod system;
pub mod task_analytics;
pub mod tasks;
pub mod user_preferences;
pub mod virtual_display;
pub mod voice_packs;
pub mod workflows;
pub mod workspace;

use chrono::DateTime;

/// UTC ISO8601 → 本地时间可读字符串（前端展示用）。
pub fn format_local(iso: &str) -> String {
    match DateTime::parse_from_rfc3339(iso) {
        Ok(dt) => {
            let local = dt.with_timezone(&chrono::Local);
            local.format("%m-%d %H:%M").to_string()
        }
        Err(_) => iso.to_string(),
    }
}
