//! 命令层：前端 invoke 的统一入口。

pub mod agents;
pub mod settings;
pub mod data;
pub mod system;
pub mod tasks;

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
