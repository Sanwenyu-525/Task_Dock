//! 诊断事件的字段白名单与文本脱敏。
//!
//! 原则：**从源头不写入敏感数据**，而不是事后用正则“洗”任意文本。
//! - `module` / `action` / `event` 只接受稳定标识符（小写字母、数字、`_ - . :`）；
//! - `message` 复用 `error::sanitize_diagnostic`（去堆栈/SQL、隐藏用户目录与凭证、限长）；
//! - `metadata` 只保留白名单 key 的标量值；对象/数组一律丢弃，避免业务对象整体入库；
//! - 敏感 key（token/password/secret/正文等）永不接受，即使调用方传了也丢弃。
//!
//! 这里是**最后一道**过滤：后端内部调用方仍应只传已经筛选过的语义化字段。

use serde_json::{Map, Value};

use crate::error::sanitize_diagnostic;

/// 单个诊断文本上限（字符）。足够定位，不足以装下业务对象。
pub const MAX_MESSAGE_CHARS: usize = 400;
/// metadata 单值上限（字符）。
const MAX_META_CHARS: usize = 120;
/// metadata key 数量上限。
pub const MAX_METADATA_KEYS: usize = 16;

/// metadata 允许的 key。新增字段必须在这里登记（白名单，不是黑名单）。
const ALLOWED_META_KEYS: &[&str] = &[
    "action",
    "agent_id",
    "agent_source",
    "attempt",
    "bytes",
    "capacity",
    "clipboard_id",
    "code",
    "command",
    "component",
    "count",
    "duration_bucket",
    "engine",
    // 文件投递/暂存添加批次汇总：只有计数、来源与稳定错误码，不含路径/文件名。
    "added",
    "failed",
    "failure_codes",
    "failure_groups",
    "partial",
    "skipped",
    "success",
    "target_id",
    "total",
    "entry_id",
    "error_kind",
    "event_count",
    "file_count",
    "from",
    "http_status",
    "item_count",
    "items",
    "key",
    "kind",
    "mode",
    "operation",
    "os_error",
    "path_kind",
    "port",
    "queue_depth",
    "reason",
    "retry",
    "retryable",
    "route",
    "run_id",
    "size_bytes",
    "source",
    "sqlite_code",
    "stage",
    "status_code",
    "step_id",
    "surface",
    "tab",
    "target",
    "task_count",
    "task_id",
    "to",
    "trigger",
    "voice_id",
    "widget",
    "widget_type",
    "window",
    "workflow_id",
];

/// 敏感 key 片段：即使误加进白名单也必须拒绝（防御性双保险）。
const FORBIDDEN_KEY_PARTS: &[&str] = &[
    "token",
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "content",
    "body",
    "clipboard_text",
    "transcript",
    "prompt",
    "message_text",
    "full_path",
    "file_path",
];

fn is_allowed_key(key: &str) -> bool {
    if !ALLOWED_META_KEYS.contains(&key) {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    !FORBIDDEN_KEY_PARTS.iter().any(|part| lower.contains(part))
}

/// 规范化稳定标识符：非法字符替换为 `_`，截断到 `max`。
/// 空值或全非法时返回 `fallback`，保证字段永远可筛选。
pub fn normalize_ident(raw: &str, max: usize, fallback: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':') {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(max)
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 诊断消息脱敏（单行化、去堆栈/SQL、隐藏路径与凭证、限长）。
pub fn sanitize_message(raw: &str) -> String {
    sanitize_diagnostic(raw, MAX_MESSAGE_CHARS)
}

/// 过滤 metadata：只保留白名单 key 的标量与短字符串。
/// 返回 `None` 表示无有效字段（不写空对象，保持日志行紧凑）。
pub fn sanitize_metadata(raw: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    for (key, value) in raw {
        if out.len() >= MAX_METADATA_KEYS {
            break;
        }
        if !is_allowed_key(key) {
            continue;
        }
        let kept = match value {
            Value::Bool(b) => Value::Bool(*b),
            Value::Number(n) => {
                // 只保留有限整数/浮点；NaN/Infinity 在 JSON 中无法表示，serde 已排除。
                Value::Number(n.clone())
            }
            Value::String(s) => {
                let text = sanitize_diagnostic(s, MAX_META_CHARS);
                if text.is_empty() {
                    continue;
                }
                Value::String(text)
            }
            // 对象/数组/null：一律丢弃（业务对象整体序列化是隐私与体积风险的主要来源）。
            _ => continue,
        };
        out.insert(key.clone(), kept);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 错误码白名单形态：`A-Z0-9_`，长度 3..=40；非法值归一为 `UNKNOWN_ERROR`。
pub fn normalize_error_code(raw: &str) -> Option<String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return None;
    }
    let ok = candidate.len() >= 3
        && candidate.len() <= 40
        && candidate
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if ok {
        Some(candidate.to_string())
    } else {
        Some("UNKNOWN_ERROR".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ident_normalization_keeps_stable_slug() {
        assert_eq!(normalize_ident("Create_Task", 32, "unknown"), "create_task");
        assert_eq!(normalize_ident("  ", 32, "unknown"), "unknown");
        assert_eq!(normalize_ident("a b/c", 32, "unknown"), "a_b_c");
        // 截断后不能只剩分隔符
        assert_eq!(normalize_ident("___", 32, "unknown"), "unknown");
    }

    #[test]
    fn metadata_drops_sensitive_and_non_scalar_values() {
        let raw = json!({
            "command": "create_task",
            "task_id": "t-1",
            "token": "sk-live-abcdef",
            "api_key": "abc",
            "password": "p",
            "clipboard_text": "正文",
            "nested": { "a": 1 },
            "list": [1, 2],
            "nullish": null,
        });
        let filtered = sanitize_metadata(raw.as_object().unwrap()).unwrap();
        assert!(filtered.contains_key("command"));
        assert!(filtered.contains_key("task_id"));
        for banned in [
            "token",
            "api_key",
            "password",
            "clipboard_text",
            "nested",
            "list",
            "nullish",
        ] {
            assert!(!filtered.contains_key(banned), "{banned} 不应进入日志");
        }
    }

    #[test]
    fn metadata_string_is_sanitized_and_capped() {
        let long = "x".repeat(400);
        let raw = json!({ "reason": format!("C:\\Users\\alice\\Desktop\\{long}") });
        let filtered = sanitize_metadata(raw.as_object().unwrap()).unwrap();
        let reason = filtered.get("reason").unwrap().as_str().unwrap();
        assert!(!reason.contains("alice"));
        assert!(reason.chars().count() <= MAX_META_CHARS + 1);
    }

    #[test]
    fn metadata_empty_returns_none() {
        let raw = json!({ "token": "x" });
        assert!(sanitize_metadata(raw.as_object().unwrap()).is_none());
    }

    /// 暂存添加汇总事件只带计数/模式/来源/失败码；新增 key 必须在白名单内。
    #[test]
    fn shelf_add_summary_metadata_keys_are_whitelisted() {
        let raw = json!({
            "count": 3,
            "total": 3,
            "added": 2,
            "failed": 1,
            "mode": "reference",
            "source": "drag",
            "failure_codes": "IO_ERROR,VALIDATION_ERROR",
        });
        let filtered = sanitize_metadata(raw.as_object().unwrap()).unwrap();
        assert_eq!(filtered.len(), 7);
        assert_eq!(filtered.get("added").and_then(|v| v.as_i64()), Some(2));
        assert_eq!(
            filtered.get("failure_codes").and_then(|v| v.as_str()),
            Some("IO_ERROR,VALIDATION_ERROR")
        );
        // 单事件仍远低于 key 数量上限。
        assert!(filtered.len() <= MAX_METADATA_KEYS);
    }

    #[test]
    fn error_code_shape_is_enforced() {
        assert_eq!(
            normalize_error_code("IO_ERROR").as_deref(),
            Some("IO_ERROR")
        );
        assert_eq!(
            normalize_error_code("select * from x").as_deref(),
            Some("UNKNOWN_ERROR")
        );
        assert!(normalize_error_code("   ").is_none());
    }

    #[test]
    fn message_redacts_secrets() {
        let text = sanitize_message("请求失败 Authorization: Bearer abcdef1234567890");
        assert!(!text.contains("abcdef1234567890"), "{text}");
    }
}
