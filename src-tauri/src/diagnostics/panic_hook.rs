//! Rust panic 捕获：让 panic 留下可定位的痕迹，而不是「无声消失」。
//!
//! ## 背景
//!
//! 仓库此前**没有**安装 `std::panic::set_hook`：Rust panic 直接终止进程，
//! 唯一线索是 stderr 上的一行输出。诊断日志里**看不到任何 panic 记录**，
//! 崩溃现场无法从「诊断中心」定位。
//!
//! ## 硬约束
//!
//! - **hook 自身绝不 panic**：panic hook 里再 panic 会直接 `abort`，反而丢掉全部现场，
//!   因此所有写入都包在 `catch_unwind` 里；
//! - **只写最小且脱敏的信息**：panic 消息（脱敏 + 限长）、`文件名:行号`
//!   （**只取文件名**，绝不写绝对路径——绝对路径含用户名）、线程名；
//! - **不写栈回溯全文**（可能含用户目录与业务对象）、不写任何线程局部业务数据；
//! - **保留默认行为**：调用上一个 hook，让运行时照常打印与退出；
//! - **不阻塞**：写入走诊断日志已有的 `try_send` 背压路径，队列满则丢弃计数。
//!
//! ## 与诊断契约的关系
//!
//! panic 事件是普通诊断事件（`kind=diagnostic`），带稳定错误码 `RUST_PANIC`，
//! 可在诊断中心按 `module=runtime` 或 `error_code=RUST_PANIC` 精确筛选。
//! 它**不是**安全审计事件：审计需要独立存储与独立开关（见
//! `docs/architecture/unified-observability-design.md` §4.3），本模块不越界实现。

use std::any::Any;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value};

use super::{DiagLevel, DiagStatus, DiagnosticEvent, Diagnostics};

/// 进程级一次性安装标志：首个 `install` 调用者获胜，后续调用 no-op。
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// panic 事件的稳定错误码（可在诊断中心直接筛选）。
pub const PANIC_ERROR_CODE: &str = "RUST_PANIC";
/// panic 事件所属模块。
pub const PANIC_MODULE: &str = "runtime";
/// panic 事件的动作名。
pub const PANIC_ACTION: &str = "panic";
/// panic 消息长度上限（字符）。超长即截断——完整堆栈对定位没有额外价值。
pub const MAX_PANIC_CHARS: usize = 240;
/// 未知载荷的兜底文案。
const UNKNOWN_PAYLOAD: &str = "panic 载荷不是字符串";

/// 抢占安装权（纯函数，便于测试）：仅当 `flag` 为 false 时置为 true 并返回 true。
/// `install` 用它保证进程内只装一次；重复调用返回 false 且不产生任何副作用。
fn try_mark_installed(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// `flag` 是否已置位（`is_installed` 的可测内核）。
fn is_installed_on(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

/// 进程内是否已安装 panic hook：首个 `install` 成功后为 true。
pub fn is_installed() -> bool {
    is_installed_on(&INSTALLED)
}

/// 安装 panic hook。必须在 `Diagnostics::init` 之后调用。
///
/// 进程内一次性：首个调用者包装 previous hook 完成安装，后续调用**直接返回**——
/// 不再 `take_hook` 串联（串联会让同一 panic 被重复记录）。可通过
/// [`is_installed`] 查询是否已安装。
pub fn install(diag: Arc<Diagnostics>) {
    if !try_mark_installed(&INSTALLED) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // hook 里再 panic 会 abort：必须兜住，绝不能让日志系统把崩溃现场也带走。
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let location = info.location().map(|loc| (loc.file(), loc.line()));
            diag.record(build_event(info.payload(), location));
        }));
        previous(info);
    }));
}

/// 构造 panic 诊断事件（纯函数，便于单元测试）。
///
/// `location` 为 `(源文件路径, 行号)`；路径只取文件名部分。
fn build_event(payload: &(dyn Any + Send), location: Option<(&str, u32)>) -> DiagnosticEvent {
    let mut event = DiagnosticEvent::new(
        DiagLevel::Error,
        PANIC_MODULE,
        PANIC_ACTION,
        "failed",
    );
    event.status = Some(DiagStatus::Failed);
    event.error_code = Some(PANIC_ERROR_CODE.to_string());
    event.error_category = Some("runtime".to_string());
    event.message = Some(sanitize_panic_message(&payload_text(payload)));

    if let Some((file, line)) = location {
        // 只保留文件名：`C:\Users\<用户>\...` 这类绝对路径绝不能进日志。
        event.stage = Some(format!("{}:{}", file_name(file), line));
    }

    let mut meta = Map::new();
    if let Some(name) = std::thread::current().name() {
        let safe = super::privacy::normalize_ident(name, 32, "unnamed");
        meta.insert("thread".to_string(), Value::String(safe));
    }
    if !meta.is_empty() {
        event.metadata = Some(meta);
    }
    event
}

/// 提取 panic 载荷文本。只认 `&str` 与 `String`；其它类型用固定兜底文案。
fn payload_text(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&'static str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    UNKNOWN_PAYLOAD.to_string()
}

/// 只保留文件名（去掉目录部分）。
///
/// Windows 用 `\`，POSIX 用 `/`；两者都处理，避免把用户名写进日志。
fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or("unknown")
}

/// panic 消息脱敏：复用诊断文本规则（单行化、去堆栈、隐藏用户目录与凭证）并限长。
fn sanitize_panic_message(raw: &str) -> String {
    let cleaned = crate::error::sanitize_diagnostic(raw, MAX_PANIC_CHARS);
    if cleaned.trim().is_empty() {
        "panic（无消息）".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_event_uses_stable_code_and_location() {
        let event = build_event(&"boom", Some(("src/diagnostics/mod.rs", 42)));
        assert_eq!(event.level, DiagLevel::Error);
        assert_eq!(event.status, Some(DiagStatus::Failed));
        assert_eq!(event.error_code.as_deref(), Some(PANIC_ERROR_CODE));
        assert_eq!(event.module, PANIC_MODULE);
        assert_eq!(event.action, PANIC_ACTION);
        assert_eq!(event.stage.as_deref(), Some("mod.rs:42"));
        assert_eq!(event.message.as_deref(), Some("boom"));
    }

    #[test]
    fn panic_event_never_leaks_absolute_path() {
        let event = build_event(
            &"boom",
            Some(("C:\\Users\\alice\\project\\src\\diagnostics\\mod.rs", 7)),
        );
        let stage = event.stage.as_deref().unwrap_or_default();
        assert_eq!(stage, "mod.rs:7");
        assert!(!stage.contains("alice"), "{stage}");
        assert!(!stage.contains('\\'), "{stage}");
        // 盘符只会出现在「文件名」部分（形如 "C:"）；文件名本身不得含冒号。
        let (file, _line) = stage.rsplit_once(':').expect("stage 应为 文件名:行号");
        assert!(!file.contains(':'), "Windows 盘符不得出现: {stage}");
    }

    #[test]
    fn panic_event_accepts_string_payload() {
        let event = build_event(&String::from("owned message"), None);
        assert_eq!(event.message.as_deref(), Some("owned message"));
        assert!(event.stage.is_none());
    }

    #[test]
    fn panic_event_handles_non_string_payload() {
        let event = build_event(&42u32, None);
        assert_eq!(event.message.as_deref(), Some(UNKNOWN_PAYLOAD));
    }

    #[test]
    fn panic_event_message_is_truncated() {
        // `dyn Any` 要求 `'static`：这里故意泄漏一小段内存换取静态引用（测试进程内）。
        let long: &'static str = Box::leak("x".repeat(5000).into_boxed_str());
        let event = build_event(&long, None);
        let message = event.message.as_deref().unwrap_or_default();
        assert!(
            message.chars().count() <= MAX_PANIC_CHARS + 1,
            "消息应被限长，实际 {}",
            message.chars().count()
        );
    }

    #[test]
    fn panic_event_carries_thread_name() {
        let event = build_event(&"boom", None);
        let meta = event.metadata.as_ref().expect("应带线程名");
        assert!(meta.contains_key("thread"), "{meta:?}");
        let thread = meta.get("thread").and_then(|v| v.as_str()).unwrap_or_default();
        assert!(!thread.is_empty());
        // 线程名必须已归一（只含小写字母数字与 `_-.:`）。
        assert!(
            thread
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':')),
            "{thread}"
        );
    }

    #[test]
    fn panic_event_metadata_survives_privacy_filter() {
        // 线程名走 `thread` 白名单键；不在白名单会被 privacy 直接丢弃。
        let event = build_event(&"boom", None);
        let raw = event.metadata.clone().unwrap_or_default();
        let filtered = super::super::privacy::sanitize_metadata(&raw);
        assert!(filtered.is_some(), "thread 键必须在白名单内");
    }

    // ---- 一次性安装守卫 ------------------------------------------------------
    // panic hook 是进程级共享状态，测试只对局部 flag 断言 CAS 语义，
    // 不在并行测试里真正 set_hook（真实安装见下方 #[ignore] 用例）。

    #[test]
    fn install_guard_is_one_shot() {
        let flag = AtomicBool::new(false);
        assert!(try_mark_installed(&flag), "首个调用者应获得安装权");
        assert!(!try_mark_installed(&flag), "第二个调用者不得再次安装");
        assert!(!try_mark_installed(&flag), "后续调用同样不得安装");
    }

    #[test]
    fn is_installed_semantics_follow_mark() {
        let flag = AtomicBool::new(false);
        assert!(!is_installed_on(&flag), "未标记前应返回 false");
        assert!(try_mark_installed(&flag));
        assert!(is_installed_on(&flag), "标记成功后应返回 true");
    }

    #[test]
    fn is_installed_reads_the_global_flag() {
        // 公开查询必须读全局标志；并行测试不真正安装，故此处只断言两者一致。
        assert_eq!(is_installed(), INSTALLED.load(Ordering::Acquire));
    }

    /// 真正执行进程级 `set_hook` 并翻转全局 `INSTALLED` 标志——会污染同进程的
    /// 其它 panic 相关用例，因此只在手工确认时运行：
    /// `cargo test --lib diagnostics::panic_hook -- --ignored`
    #[test]
    #[ignore]
    fn real_install_sets_global_flag_once() {
        let dir = std::env::temp_dir().join(format!("taskdock-panic-hook-{}", std::process::id()));
        let diag = super::Diagnostics::init_at(dir.clone(), super::super::WriterConfig::default());
        super::install(diag.clone());
        assert!(is_installed(), "首个 install 应置位全局标志");
        super::install(diag); // 第二次调用必须 no-op：标志不变、不再包装 hook
        assert!(is_installed(), "重复 install 不得翻转或卸载");
        let _ = std::fs::remove_dir_all(dir); // 尽力清理；写线程可能短暂持有文件
    }
}
