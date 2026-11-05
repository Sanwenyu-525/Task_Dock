//! 命令层：前端 invoke 的统一入口。

pub mod actions;
pub mod agents;
pub mod agent_stats;
pub mod audio;
pub mod audit;
pub mod backup;
pub mod clipboard;
pub mod context;
pub mod focus;
pub mod global_search;
pub mod hotkeys;
pub mod notes;
pub mod shelf;
pub mod data;
pub mod navigation;
pub mod planning;
pub mod restore;
pub mod settings;
pub mod system;
pub mod task_analytics;
pub mod tasks;
pub mod user_preferences;
pub mod workspace;
pub mod workflows;

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
