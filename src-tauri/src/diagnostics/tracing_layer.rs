//! `tracing` → 诊断日志的桥接层。
//!
//! 目的：让仓库里**已经存在**的 `tracing::warn!/error!` 自动进入持久化诊断日志，
//! 不需要改动几十个业务文件。约束：
//! - 只接收本 crate（`task_dock_lib`）的事件，第三方库日志不落盘；
//! - 默认只落 WARN 及以上；INFO/DEBUG/TRACE 仅在详细诊断模式下接收（避免长期噪声）；
//! - 只提取白名单字段（`message`/`action`/`stage`/`operation_id`/`error_code`/`status`/
//!   `window`/`duration_ms`），其余结构化字段全部丢弃——防止把业务参数原样写入日志；
//! - 不修改 `tracing` 的原有控制台输出（fmt layer 仍然独立工作）。

use std::sync::Arc;

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use super::{DiagLevel, DiagStatus, DiagnosticEvent, Diagnostics};

/// 诊断订阅层。与 `tracing_subscriber::fmt` 并列挂载。
pub struct DiagnosticsLayer {
    diag: Arc<Diagnostics>,
}

impl DiagnosticsLayer {
    pub fn new(diag: Arc<Diagnostics>) -> Self {
        Self { diag }
    }
}

impl<S: Subscriber> Layer<S> for DiagnosticsLayer {
    fn enabled(&self, metadata: &Metadata<'_>, _ctx: Context<'_, S>) -> bool {
        metadata.target().starts_with("task_dock_lib")
    }

    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = match *event.metadata().level() {
            Level::ERROR => DiagLevel::Error,
            Level::WARN => DiagLevel::Warn,
            Level::INFO => DiagLevel::Info,
            Level::DEBUG => DiagLevel::Debug,
            Level::TRACE => DiagLevel::Trace,
        };
        // 正常模式只落 WARN 及以上；更细的级别需要用户显式开启详细诊断。
        if level < DiagLevel::Warn && !self.diag.is_verbose() {
            return;
        }

        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let target = event.metadata().target();
        let module = visitor.module.unwrap_or_else(|| module_from_target(target));
        let action = visitor.action.unwrap_or_else(|| action_from_target(target));
        let name = visitor.event.unwrap_or_else(|| {
            if visitor.status.is_some() {
                "status".to_string()
            } else {
                "log".to_string()
            }
        });

        let mut out = DiagnosticEvent::new(level, &module, &action, &name);
        out.message = visitor.message;
        out.stage = visitor.stage;
        out.operation_id = visitor.operation_id;
        out.window_id = visitor.window;
        out.error_code = visitor.error_code;
        out.status = visitor.status.as_deref().and_then(DiagStatus::parse);
        out.duration_ms = visitor.duration_ms;
        self.diag.record(out);
    }
}

/// `task_dock_lib::clipboard::paste` → `clipboard`；crate 根事件 → `app`。
fn module_from_target(target: &str) -> String {
    match target {
        "task_dock_lib" | "" => return "app".to_string(),
        _ => {}
    }
    let rest = target.strip_prefix("task_dock_lib::").unwrap_or(target);
    rest.split("::")
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("app")
        .to_string()
}

/// `task_dock_lib::clipboard::paste` → `paste`（稳定操作标识）。
///
/// 末尾是 `mod`（模块级事件）时退一级，例如 `task_dock_lib::clipboard::mod` →
/// `clipboard`；crate 根事件没有可用操作名，统一 `log`。
fn action_from_target(target: &str) -> String {
    let mut parts: Vec<&str> = target.split("::").filter(|part| !part.is_empty()).collect();
    while parts.len() > 1 && parts.last().copied() == Some("mod") {
        parts.pop();
    }
    parts
        .last()
        .copied()
        .filter(|segment| *segment != "task_dock_lib")
        .unwrap_or("log")
        .to_string()
}

/// 只收集白名单字段；其余字段（任意业务值）直接忽略。
#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    module: Option<String>,
    action: Option<String>,
    event: Option<String>,
    stage: Option<String>,
    operation_id: Option<String>,
    error_code: Option<String>,
    status: Option<String>,
    duration_ms: Option<u64>,
    window: Option<String>,
}

impl FieldVisitor {
    fn assign(&mut self, name: &str, value: String) {
        match name {
            "message" => self.message = Some(value),
            "module" => self.module = Some(value),
            "action" => self.action = Some(value),
            "event" => self.event = Some(value),
            "stage" => self.stage = Some(value),
            "operation_id" => self.operation_id = Some(value),
            "error_code" => self.error_code = Some(value),
            "status" => self.status = Some(value),
            "window" | "window_id" => self.window = Some(value),
            // 白名单之外：丢弃。
            _ => {}
        }
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.assign(field.name(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == "duration_ms" {
            self.duration_ms = Some(value);
        } else {
            self.assign(field.name(), value.to_string());
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.assign(field.name(), value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.assign(field.name(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let text = format!("{value:?}");
        self.assign(field.name(), text.trim_matches('"').to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_and_action_come_from_target() {
        assert_eq!(
            module_from_target("task_dock_lib::clipboard::paste"),
            "clipboard"
        );
        assert_eq!(
            action_from_target("task_dock_lib::clipboard::paste"),
            "paste"
        );
        assert_eq!(module_from_target("task_dock_lib"), "app");
        assert_eq!(action_from_target("task_dock_lib"), "log");
        assert_eq!(
            action_from_target("task_dock_lib::clipboard::mod"),
            "clipboard"
        );
        assert_eq!(module_from_target("hyper::proto"), "hyper");
    }

    #[test]
    fn visitor_ignores_non_whitelisted_fields() {
        let mut visitor = FieldVisitor::default();
        // 模拟 tracing 对业务字段的调用：只有白名单 key 会被记住。
        for name in [
            "task_id",
            "clipboard_text",
            "token",
            "password",
            "arbitrary_payload",
        ] {
            visitor.assign(name, "very-secret".to_string());
        }
        visitor.assign("module", "task".to_string());
        visitor.assign("action", "create".to_string());
        assert_eq!(visitor.module.as_deref(), Some("task"));
        assert_eq!(visitor.action.as_deref(), Some("create"));
        assert!(visitor.message.is_none());
        assert!(visitor.error_code.is_none());
    }
}
