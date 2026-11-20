//! 跨模块/跨端追踪标识（`trace_id`）契约：生成、外部传入校验与轻量线程局部上下文。
//!
//! ## 定位（设计文档 unified-observability §4.4）
//! - `trace_id` 标记**一次跨端/跨进程业务链路**（前端 → IPC → Rust → 移动通信 → Android），
//!   复用 OpenTelemetry 的 ID 形态（16 位小写 hex），但不引入 OTel SDK；
//! - 只用于**诊断事件关联**（诊断中心按 trace_id 串联一次链路的所有事件），
//!   **绝不参与任何认证/授权判断**（`authenticate_device`、MCP token 校验不读 trace_id）；
//! - 外部传入（MCP 客户端 / Android 回传 / 前端）的值必须过 [`validate_external_id`]：
//!   合法才采用，非法**丢弃并重新生成**，不报错、不透传、不拒绝请求。
//!
//! ## 线程局部上下文的边界
//! [`with_trace`] / [`current_trace`] 用 `thread_local!` 实现，**只适合同步段**：
//! - tokio 任务可能跨线程恢复，跨 `.await` 后线程局部会丢失/错位；
//!   因此**跨 await 或跨线程必须显式传参**（把 trace_id 写进事件或函数参数），
//!   不依赖全局可变状态；
//! - 生成与校验函数本身是纯函数，无此限制。

/// trace_id / span_id 长度（16 位 hex，OpenTelemetry 形态）。
pub const TRACE_ID_LEN: usize = 16;

/// 生成新的 trace_id：16 位小写 hex（由 uuid v4 随机字节派生）。
pub fn new_trace_id() -> String {
    random_hex()
}

/// 生成新的 span_id：与 trace_id 同形态（16 位小写 hex）。
pub fn new_span_id() -> String {
    random_hex()
}

/// 外部传入 ID 统一入口：匹配 `^[0-9a-f]{16}$` 才返回 `Some`；
/// 否则 `None`（调用方丢弃并重新生成，不报错、不透传）。长度硬上限 16。
/// **绝不参与任何认证/授权判断。**
pub fn validate_external_id(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.len() != TRACE_ID_LEN {
        return None;
    }
    if bytes
        .iter()
        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Some(raw.to_string())
    } else {
        None
    }
}

thread_local! {
    static CURRENT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// 在 `f` 执行期间把 `trace_id` 设为当前线程的追踪上下文（同步段专用）。
///
/// 支持嵌套：作用域结束后恢复外层值（含 panic 时经 Drop 恢复）。
/// 跨 `.await` / 跨线程**不得**依赖本函数，必须显式传参（见模块注释）。
pub fn with_trace<T>(trace_id: &str, f: impl FnOnce() -> T) -> T {
    /// 作用域守卫：无论正常返回还是 panic 都恢复外层上下文。
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(CURRENT.with(|slot| slot.borrow_mut().replace(trace_id.to_string())));
    f()
}

/// 读取当前线程的追踪上下文（`None` = 当前线程不在任何 `with_trace` 作用域内）。
pub fn current_trace() -> Option<String> {
    CURRENT.with(|slot| slot.borrow().clone())
}

/// uuid v4 前 8 字节 → 16 位小写 hex。
fn random_hex() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let mut out = String::with_capacity(TRACE_ID_LEN);
    for byte in &bytes[..8] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{DiagLevel, DiagnosticEvent};

    #[test]
    fn generated_ids_match_contract() {
        for _ in 0..64 {
            let trace = new_trace_id();
            let span = new_span_id();
            assert_eq!(trace.len(), TRACE_ID_LEN);
            assert!(validate_external_id(&trace).is_some(), "trace: {trace}");
            assert!(validate_external_id(&span).is_some(), "span: {span}");
            // 随机性抽查：连续生成不重复。
            assert_ne!(new_trace_id(), new_trace_id());
        }
    }

    #[test]
    fn validate_rejects_ill_formed_external_ids() {
        assert_eq!(validate_external_id("0123456789abcdef").as_deref(), Some("0123456789abcdef"));
        // 大写：非法（丢弃并重新生成，不透传）
        assert!(validate_external_id("0123456789ABCDEF").is_none());
        // 超长 / 不足：长度硬上限 16
        assert!(validate_external_id("0123456789abcdef0").is_none());
        assert!(validate_external_id("0123456789abcde").is_none());
        // 非 hex / 空串
        assert!(validate_external_id("0123456789abcdeg").is_none());
        assert!(validate_external_id("").is_none());
    }

    #[test]
    fn with_trace_scopes_and_restores() {
        assert!(current_trace().is_none());
        let outer = new_trace_id();
        with_trace(&outer, || {
            assert_eq!(current_trace().as_deref(), Some(outer.as_str()));
            // 嵌套：内层生效，离开后恢复外层。
            let inner = new_trace_id();
            with_trace(&inner, || {
                assert_eq!(current_trace().as_deref(), Some(inner.as_str()));
            });
            assert_eq!(current_trace().as_deref(), Some(outer.as_str()));
        });
        assert!(current_trace().is_none());
    }

    #[test]
    fn normalize_keeps_valid_and_drops_invalid_trace_id() {
        let valid = new_trace_id();
        let mut keep = DiagnosticEvent::new(DiagLevel::Info, "mcp", "tool", "failed");
        keep.trace_id = Some(valid.clone());
        assert!(keep.normalize("sess", true));
        assert_eq!(keep.trace_id.as_deref(), Some(valid.as_str()));

        // 非法（大写/超长）：直接丢弃置 None，不报错、不透传。
        let overlong = "x".repeat(64);
        for bad in ["0123456789ABCDEF", overlong.as_str(), "not-a-trace-id!!"] {
            let mut ev = DiagnosticEvent::new(DiagLevel::Info, "mcp", "tool", "failed");
            ev.trace_id = Some(bad.to_string());
            assert!(ev.normalize("sess", true));
            assert!(ev.trace_id.is_none(), "非法 trace_id 应被丢弃: {bad}");
        }
    }

    #[test]
    fn normalize_fills_from_current_scope_but_not_for_stage_events() {
        let trace = new_trace_id();
        with_trace(&trace, || {
            // 无显式值：从线程上下文补齐（用于 MCP 请求等同步段的诊断关联）。
            let mut ev = DiagnosticEvent::new(DiagLevel::Warn, "mcp", "tool", "failed");
            assert!(ev.normalize("sess", true));
            assert_eq!(ev.trace_id.as_deref(), Some(trace.as_str()));

            // stage 事件高频，不挂 trace_id（设计 §4.4.2，控制追踪记录量）。
            let mut stage = DiagnosticEvent::new(DiagLevel::Debug, "mcp", "tool", "stage");
            assert!(stage.normalize("sess", true));
            assert!(stage.trace_id.is_none());
        });
        // 作用域之外：不自动补齐。
        let mut outside = DiagnosticEvent::new(DiagLevel::Warn, "mcp", "tool", "failed");
        assert!(outside.normalize("sess", true));
        assert!(outside.trace_id.is_none());
    }
}
