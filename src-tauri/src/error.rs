//! 统一错误类型：内部错误不在前端暴露细节，只暴露可读消息。
//!
//! 序列化契约（v0.11 起）：
//! ```json
//! { "code": "NOT_FOUND", "category": "not_found", "severity": "warning",
//!   "retryable": false, "message": "…", "detail": "…" }
//! ```
//! `message` 是可直接展示给用户的安全文案；`detail` 只允许放可核验的技术信息
//! （如 sqlite 错误码），不包含 SQL 语句、堆栈或剪贴板正文。前端 `normalizeError`
//! 同时兼容旧的纯字符串错误（旧版本后端 / 第三方插件抛出）。

use std::io::ErrorKind;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("校验失败: {0}")]
    Validation(String),
    #[error("未找到: {0}")]
    NotFound(String),
    #[error("Agent 接入错误: {0}")]
    Agent(String),
    /// 容量耗尽/队列满：调用方可重试（HTTP 503 + Retry-After）
    #[error("服务繁忙，请稍后重试: {0}")]
    Overloaded(String),
    /// 依赖服务暂时不可用（如接入管线未启动）：可重试
    #[error("服务暂不可用: {0}")]
    Unavailable(String),
    /// 需要用户先在系统设置中开启隐私/权限开关（如 Windows 在线语音识别）
    #[error("需要系统权限: {0}")]
    PermissionRequired(String),
    /// 状态冲突（如已有同类长任务进行中）；调用方应等待或显式取消
    #[error("操作冲突: {0}")]
    Conflict(String),
    #[error("Tauri 错误: {0}")]
    Tauri(#[from] tauri::Error),
}

/// 错误分类：前端据此选择提示形式与恢复动作，不依赖文案匹配。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    Validation,
    NotFound,
    Permission,
    Io,
    Database,
    Config,
    Ipc,
    Service,
    Agent,
    Conflict,
    Timeout,
    Unsupported,
    Integrity,
    Unknown,
}

impl ErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Validation => "validation",
            Self::NotFound => "not_found",
            Self::Permission => "permission",
            Self::Io => "io",
            Self::Database => "database",
            Self::Config => "config",
            Self::Ipc => "ipc",
            Self::Service => "service",
            Self::Agent => "agent",
            Self::Conflict => "conflict",
            Self::Timeout => "timeout",
            Self::Unsupported => "unsupported",
            Self::Integrity => "integrity",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorSeverity {
    Warning,
    Error,
    Critical,
}

impl ErrorSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Critical => "critical",
        }
    }
}

/// 单条错误的结构化描述（`code/category` 由错误变体 + 底层错误种类共同决定）。
struct ErrorMeta {
    code: &'static str,
    category: ErrorCategory,
    severity: ErrorSeverity,
    retryable: bool,
}

impl AppError {
    fn meta(&self) -> ErrorMeta {
        match self {
            AppError::Db(e) => match e {
                rusqlite::Error::SqliteFailure(err, _) => match err.code {
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                        ErrorMeta {
                            code: "DATABASE_BUSY",
                            category: ErrorCategory::Database,
                            severity: ErrorSeverity::Warning,
                            retryable: true,
                        }
                    }
                    rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                        ErrorMeta {
                            code: "DATA_INTEGRITY_ERROR",
                            category: ErrorCategory::Integrity,
                            severity: ErrorSeverity::Critical,
                            retryable: false,
                        }
                    }
                    _ => ErrorMeta {
                        code: "DATABASE_ERROR",
                        category: ErrorCategory::Database,
                        severity: ErrorSeverity::Error,
                        retryable: false,
                    },
                },
                _ => ErrorMeta {
                    code: "DATABASE_ERROR",
                    category: ErrorCategory::Database,
                    severity: ErrorSeverity::Error,
                    retryable: false,
                },
            },
            AppError::Io(e) => match e.kind() {
                ErrorKind::NotFound => ErrorMeta {
                    code: "NOT_FOUND",
                    category: ErrorCategory::NotFound,
                    severity: ErrorSeverity::Warning,
                    retryable: false,
                },
                ErrorKind::PermissionDenied => ErrorMeta {
                    code: "PERMISSION_DENIED",
                    category: ErrorCategory::Permission,
                    severity: ErrorSeverity::Error,
                    retryable: false,
                },
                ErrorKind::TimedOut => ErrorMeta {
                    code: "TIMEOUT",
                    category: ErrorCategory::Timeout,
                    severity: ErrorSeverity::Warning,
                    retryable: true,
                },
                _ => ErrorMeta {
                    code: "IO_ERROR",
                    category: ErrorCategory::Io,
                    severity: ErrorSeverity::Error,
                    retryable: true,
                },
            },
            AppError::Json(_) => ErrorMeta {
                code: "DATA_INTEGRITY_ERROR",
                category: ErrorCategory::Integrity,
                severity: ErrorSeverity::Error,
                retryable: false,
            },
            AppError::Validation(_) => ErrorMeta {
                code: "VALIDATION_ERROR",
                category: ErrorCategory::Validation,
                severity: ErrorSeverity::Warning,
                retryable: true,
            },
            AppError::NotFound(_) => ErrorMeta {
                code: "NOT_FOUND",
                category: ErrorCategory::NotFound,
                severity: ErrorSeverity::Warning,
                retryable: false,
            },
            AppError::Agent(_) => ErrorMeta {
                code: "AGENT_ERROR",
                category: ErrorCategory::Agent,
                severity: ErrorSeverity::Error,
                retryable: true,
            },
            AppError::Overloaded(_) => ErrorMeta {
                code: "SERVICE_OVERLOADED",
                category: ErrorCategory::Service,
                severity: ErrorSeverity::Warning,
                retryable: true,
            },
            AppError::Unavailable(_) => ErrorMeta {
                code: "SERVICE_UNAVAILABLE",
                category: ErrorCategory::Service,
                severity: ErrorSeverity::Error,
                retryable: true,
            },
            AppError::PermissionRequired(_) => ErrorMeta {
                code: "PERMISSION_REQUIRED",
                category: ErrorCategory::Permission,
                severity: ErrorSeverity::Warning,
                retryable: true,
            },
            AppError::Conflict(_) => ErrorMeta {
                code: "CONFLICT",
                category: ErrorCategory::Conflict,
                severity: ErrorSeverity::Warning,
                retryable: false,
            },
            AppError::Tauri(_) => ErrorMeta {
                code: "IPC_ERROR",
                category: ErrorCategory::Ipc,
                severity: ErrorSeverity::Error,
                retryable: true,
            },
        }
    }

    pub fn code(&self) -> &'static str {
        self.meta().code
    }

    pub fn category(&self) -> ErrorCategory {
        self.meta().category
    }

    pub fn severity(&self) -> ErrorSeverity {
        self.meta().severity
    }

    pub fn retryable(&self) -> bool {
        self.meta().retryable
    }

    /// 用户可读文案：优先保留后端已有的具体描述；数据库/系统错误收敛为安全文案，
    /// 避免把 SQL、堆栈与系统路径直接展示在界面上。
    pub fn user_message(&self) -> String {
        match self {
            AppError::Db(_) => "数据库操作失败".to_string(),
            AppError::Io(e) => match e.kind() {
                ErrorKind::NotFound => "文件或路径不存在".to_string(),
                ErrorKind::PermissionDenied => "没有权限访问该文件或路径".to_string(),
                ErrorKind::TimedOut => "文件操作超时".to_string(),
                _ => "文件操作失败".to_string(),
            },
            AppError::Json(_) => "数据格式错误".to_string(),
            AppError::Tauri(_) => "窗口服务调用失败".to_string(),
            AppError::Validation(m) => sanitize(m),
            AppError::NotFound(m) => sanitize(m),
            AppError::Agent(m) => sanitize(m),
            AppError::Overloaded(m) => {
                if m.trim().is_empty() {
                    "服务繁忙，请稍后重试".to_string()
                } else {
                    format!("服务繁忙，请稍后重试：{}", sanitize(m))
                }
            }
            AppError::Unavailable(m) => {
                if m.trim().is_empty() {
                    "服务暂不可用，请稍后重试".to_string()
                } else {
                    format!("服务暂不可用：{}", sanitize(m))
                }
            }
            AppError::PermissionRequired(m) => sanitize(m),
            AppError::Conflict(m) => sanitize(m),
        }
    }

    /// 可核验的技术信息（不进入普通提示正文）。禁止放 SQL / 堆栈 / 敏感正文。
    pub fn detail(&self) -> Option<String> {
        match self {
            AppError::Db(e) => Some(match e {
                rusqlite::Error::SqliteFailure(err, _) => {
                    format!("sqlite code={:?} extended={}", err.code, err.extended_code)
                }
                _ => "sqlite error".to_string(),
            }),
            AppError::Io(e) => Some(format!(
                "io kind={:?} os={}",
                e.kind(),
                e.raw_os_error()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "none".to_string())
            )),
            AppError::Json(e) => Some(format!("json line={} column={}", e.line(), e.column())),
            AppError::Tauri(_) => Some("tauri ipc error".to_string()),
            _ => None,
        }
    }

    /// 跨通道复制错误（AppError 不实现 Clone；内部错误统一降级为 Agent 文本）。
    pub fn duplicate(&self) -> Self {
        match self {
            AppError::Validation(m) => AppError::Validation(m.clone()),
            AppError::NotFound(m) => AppError::NotFound(m.clone()),
            AppError::Overloaded(m) => AppError::Overloaded(m.clone()),
            AppError::Unavailable(m) => AppError::Unavailable(m.clone()),
            AppError::PermissionRequired(m) => AppError::PermissionRequired(m.clone()),
            AppError::Conflict(m) => AppError::Conflict(m.clone()),
            AppError::Agent(m) => AppError::Agent(m.clone()),
            other => AppError::Agent(other.to_string()),
        }
    }
}

/// 单行化 + 过滤调试/ SQL 行 + 脱敏用户目录与凭证 + 截断。
///
/// 说明：detail 字段已按白名单生成（Io 只留 kind/os、Json 只留行列），这里主要保护
/// `user_message` 里的业务文案；两层都不能单独作为“已脱敏”的证明。
fn sanitize(raw: &str) -> String {
    sanitize_impl(raw, 240)
}

/// 诊断日志文本脱敏（复用用户文案规则，只放宽长度上限）。
///
/// 诊断事件允许稍长的技术文案（例如失败阶段拼接），但仍然单行化并隐藏用户目录与
/// 凭证；任何调用方都不应把业务对象整体序列化后交给这里。
pub(crate) fn sanitize_diagnostic(raw: &str, max_chars: usize) -> String {
    sanitize_impl(raw, max_chars.clamp(1, 2000))
}

fn sanitize_impl(raw: &str, max_chars: usize) -> String {
    let filtered: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|line| {
            if line.is_empty() {
                return false;
            }
            if line.starts_with("at ") || line.contains("stack backtrace") {
                return false;
            }
            let lower = line.to_lowercase();
            ![
                "select ",
                "insert into ",
                "update ",
                "delete from ",
                "create table",
                "alter table ",
                "drop table ",
                "pragma ",
            ]
            .iter()
            .any(|kw| lower.contains(kw))
        })
        .collect();

    let joined = filtered.join(" ");
    let joined = redact_home_dirs(&joined);
    let joined = redact_secrets(&joined);
    let mut out: String = joined.chars().take(max_chars).collect();
    if joined.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// 跨平台用户目录脱敏：`C:\Users\alice`、`/Users/alice`、`/home/alice` → `<用户>`。
fn redact_home_dirs(raw: &str) -> String {
    const WIN_MARKERS: [&str; 2] = ["\\users\\", "\\documents and settings\\"];
    const NIX_MARKERS: [&str; 2] = ["/users/", "/home/"];
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let rest = &raw[i..];
        if let Some(marker) = WIN_MARKERS.iter().find(|m| {
            rest.get(..m.len())
                .map(|p| p.eq_ignore_ascii_case(m))
                .unwrap_or(false)
        }) {
            out.push_str(&rest[..marker.len()]);
            let name_rest = &rest[marker.len()..];
            let end = name_rest
                .find(|c: char| c == '\\' || c == '/')
                .unwrap_or(name_rest.len());
            if end > 0 {
                out.push_str("<用户>");
            }
            i += marker.len() + end;
            continue;
        }
        if let Some(marker) = NIX_MARKERS.iter().find(|m| {
            rest.get(..m.len())
                .map(|p| p.eq_ignore_ascii_case(m))
                .unwrap_or(false)
        }) {
            out.push_str(&rest[..marker.len()]);
            let name_rest = &rest[marker.len()..];
            let end = name_rest
                .find(|c: char| c == '/' || c.is_whitespace())
                .unwrap_or(name_rest.len());
            if end > 0 {
                out.push_str("<用户>");
            }
            i += marker.len() + end;
            continue;
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 显式凭证脱敏：`Authorization: xxx`、`token=xxx`、`password=xxx` 等。
fn redact_secrets(raw: &str) -> String {
    const MARKERS: [&str; 10] = [
        "authorization:",
        "authorization=",
        "bearer ",
        "token=",
        "token:",
        "access_token=",
        "api_key=",
        "api-key=",
        "password=",
        "secret=",
    ];
    let mut out = raw.to_string();
    for marker in MARKERS {
        let mut from = 0usize;
        loop {
            let lower = out.to_lowercase();
            let Some(rel) = lower.get(from..).and_then(|tail| tail.find(marker)) else {
                break;
            };
            let pos = from + rel;
            let value_start = pos + marker.len();
            let value_rest = &out[value_start..];
            let skip = value_rest.len() - value_rest.trim_start().len();
            let value_start = value_start + skip;
            let value_rest = &out[value_start..];
            if value_rest.starts_with("<已隐藏>") {
                from = value_start + "<已隐藏>".len();
                continue;
            }
            // `Authorization: Bearer <token>` / `bearer <token>`：跳过认证方案名，
            // 否则只会隐藏 "Bearer" 而把真正的 token 留在文本里（隐私缺口）。
            let (scheme, after_scheme) = match value_rest
                .get(..7)
                .map(|prefix| prefix.eq_ignore_ascii_case("bearer "))
            {
                Some(true) => (7usize, &value_rest[7..]),
                _ => (0usize, value_rest),
            };
            let scheme_skip = after_scheme.len() - after_scheme.trim_start().len();
            let token_start = value_start + scheme + scheme_skip;
            let token_rest = &out[token_start..];
            if token_rest.starts_with("<已隐藏>") {
                from = token_start + "<已隐藏>".len();
                continue;
            }
            let end = token_rest
                .find(|c: char| c.is_whitespace() || c == ',' || c == '"' || c == '\'')
                .unwrap_or(token_rest.len());
            if end < 6 {
                // 没有可识别的凭证值：跳过该标记，继续找后面的出现位置
                from = pos + marker.len();
                continue;
            }
            out.replace_range(token_start..token_start + end, "<已隐藏>");
            from = token_start + "<已隐藏>".len();
        }
    }
    out
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    code: &'static str,
    category: &'static str,
    severity: &'static str,
    retryable: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let detail = self.detail();
        ErrorPayload {
            code: self.code(),
            category: self.category().as_str(),
            severity: self.severity().as_str(),
            retryable: self.retryable(),
            message: self.user_message(),
            detail: detail.as_deref(),
        }
        .serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_keeps_specific_message() {
        let e = AppError::Validation("标题不能为空".into());
        assert_eq!(e.code(), "VALIDATION_ERROR");
        assert_eq!(e.category().as_str(), "validation");
        assert!(e.retryable());
        assert_eq!(e.user_message(), "标题不能为空");
        assert!(e.detail().is_none());
    }

    #[test]
    fn missing_file_is_not_found_and_safe() {
        let e = AppError::Io(std::io::Error::new(
            ErrorKind::NotFound,
            "C:\\Users\\alice\\a.txt",
        ));
        assert_eq!(e.code(), "NOT_FOUND");
        assert_eq!(e.user_message(), "文件或路径不存在");
        // detail 只暴露白名单化的 kind/os，不包含原始路径或账户名
        let detail = e.detail().unwrap();
        assert!(!detail.contains("alice"));
        assert!(!detail.contains("a.txt"));
        assert!(detail.contains("kind=NotFound"));
    }

    #[test]
    fn sanitize_redacts_cross_platform_home_dirs() {
        let e = AppError::Validation(
            "无法读取 C:\\Users\\alice\\secret.txt、/Users/bob/x 和 /home/carol/y".into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("alice"));
        assert!(!msg.contains("bob"));
        assert!(!msg.contains("carol"));
        assert!(msg.contains("<用户>"));
    }

    #[test]
    fn sanitize_redacts_tokens_and_drops_sql_and_stack() {
        let e = AppError::Validation(
            "token=abcdef123456 Bearer eyJhbGciOiJIUzI1  Password=Hunter2\nSELECT * FROM tasks\n at src/main.rs:10".into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("abcdef123456"));
        assert!(!msg.contains("Hunter2"));
        assert!(!msg.contains("SELECT"));
        assert!(!msg.contains("main.rs"));
        assert!(msg.contains("<已隐藏>"));
    }

    #[test]
    fn permission_required_keeps_actionable_message() {
        let e = AppError::PermissionRequired("请先开启 Windows 在线语音识别".into());
        assert_eq!(e.code(), "PERMISSION_REQUIRED");
        assert_eq!(e.category().as_str(), "permission");
        assert!(e.retryable());
        assert_eq!(e.user_message(), "请先开启 Windows 在线语音识别");
    }

    #[test]
    fn serialized_payload_has_stable_code_and_message() {
        let e = AppError::Conflict("已有工作流正在运行".into());
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "CONFLICT");
        assert_eq!(v["category"], "conflict");
        assert_eq!(v["severity"], "warning");
        assert_eq!(v["retryable"], false);
        assert_eq!(v["message"], "已有工作流正在运行");
        assert!(v.get("detail").is_none());
    }
}
