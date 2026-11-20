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
use std::sync::OnceLock;

use regex::Regex;
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
    /// 权限不足（能力/项目范围/角色限制）；不回显受保护数据是否存在
    #[error("权限不足: {0}")]
    Forbidden(String),
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
            AppError::Forbidden(_) => ErrorMeta {
                code: "PERMISSION_DENIED",
                category: ErrorCategory::Permission,
                severity: ErrorSeverity::Error,
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
            AppError::Forbidden(m) => sanitize(m),
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

/// 裸凭证值的结束字符：空白、ASCII 分隔标点与全角标点。
/// 全角标点用于中文错误文案——凭证值后跟 `，目录…` 时不得把「目录」一起吞进占位符。
fn is_value_delimiter(c: char) -> bool {
    c.is_whitespace() || matches!(c, ',' | '"' | '\'' | '，' | '、' | '；' | '）')
}

/// 脱敏形态规则（懒编译一次；`regex` 为既有依赖）。
struct Patterns {
    /// URL 查询参数凭证值：名称必须紧跟 `?`/`&`，`?keyword=`、`keyboard=` 不会误伤。
    query: Regex,
    /// `sk-` 前缀密钥：词边界后 `sk-` + ≥16 位密钥字符（字母/数字/`-`/`_`）。
    /// 前缀大小写敏感以压低误伤；`risk-`/`task-` 等词中形态由词边界排除。
    sk: Regex,
    /// 邮箱：域名首字符须为字母、TLD ≥2 位字母，排除 `logo@2x.png` 这类资源名。
    email: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        query: Regex::new(r#"(?i)([?&](?:key|auth|sig|access_token)=)[^&#\s"'()]+"#).unwrap(),
        sk: Regex::new(r"(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,})").unwrap(),
        email: Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}").unwrap(),
    })
}

/// 显式凭证脱敏：`Authorization: xxx`、`token=xxx`、`password: xxx` 等；另有
/// URL 查询参数（`?key=`/`?auth=`/`?sig=`）、`sk-` 前缀密钥与邮箱三条形态规则。
/// 占位符保持短小，错误码与错误原因原样保留。
fn redact_secrets(raw: &str) -> String {
    const MARKERS: [&str; 16] = [
        "authorization:",
        "authorization=",
        "bearer ",
        "token=",
        "token:",
        "access_token=",
        "api_key=",
        "api_key:",
        "apikey=",
        "apikey:",
        "api-key=",
        "api-key:",
        "password=",
        "password:",
        "secret=",
        "secret:",
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
            // 值形态一：引号包裹（Debug/JSON 对象 `token: "abc123"`）——只隐藏引号内内容；
            // 值形态二：裸值——到空白或分隔标点为止。
            let (replace_start, value_len) = match token_rest.chars().next() {
                Some(q @ ('"' | '\'')) => match token_rest[1..].find(q) {
                    Some(close_rel) => {
                        if token_rest[1..1 + close_rel].starts_with("<已隐藏>") {
                            from = token_start + 1 + close_rel;
                            continue;
                        }
                        (token_start + 1, close_rel)
                    }
                    // 只有开引号没有闭引号：无可识别值，跳过。
                    None => (token_start, 0),
                },
                _ => (
                    token_start,
                    token_rest.find(is_value_delimiter).unwrap_or(token_rest.len()),
                ),
            };
            if value_len < 6 {
                // 没有可识别的凭证值：跳过该标记，继续找后面的出现位置
                from = pos + marker.len();
                continue;
            }
            out.replace_range(replace_start..replace_start + value_len, "<已隐藏>");
            from = replace_start + "<已隐藏>".len();
        }
    }
    let out = patterns()
        .query
        .replace_all(&out, "${1}<已隐藏>")
        .into_owned();
    let out = patterns()
        .sk
        .replace_all(&out, "${1}<已隐藏>")
        .into_owned();
    patterns().email.replace_all(&out, "<邮箱>").into_owned()
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
    fn sanitize_redacts_password_and_secret_colon_variants() {
        let e = AppError::Validation("登录失败 password: hunter2secret, secret: abcdef123456".into());
        let msg = e.user_message();
        assert!(!msg.contains("hunter2secret"), "{msg}");
        assert!(!msg.contains("abcdef123456"), "{msg}");
        assert!(msg.contains("登录失败"), "{msg}");
    }

    #[test]
    fn sanitize_redacts_delimiterless_apikey_and_header_form() {
        let e = AppError::Validation(
            "调用失败 apikey=abcd1234efgh5678 ApiKey: abcd1234efgh5678 X-Api-Key: abcd1234efgh5678"
                .into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("abcd1234efgh5678"), "{msg}");
        assert!(msg.contains("X-Api-Key:"), "{msg}"); // 头名保留，只有值被隐藏
        assert!(msg.contains("调用失败"), "{msg}");
    }

    #[test]
    fn sanitize_redacts_url_query_credentials_without_false_positives() {
        let e = AppError::Validation(
            "GET https://api.example.com/v1/items?sig=abcdef123456&auth=zzzz9999yyyy&keyword=plain&key=abcd1234efgh5678#frag"
                .into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("abcdef123456"), "{msg}");
        assert!(!msg.contains("zzzz9999yyyy"), "{msg}");
        assert!(!msg.contains("abcd1234efgh5678"), "{msg}");
        assert!(msg.contains("keyword=plain"), "{msg}"); // 普通参数不误伤
        assert!(msg.contains("#frag"), "{msg}");
        // `keyboard=` 与无 `?`/`&` 前缀的 `key=` 不得命中
        let plain = AppError::Validation("keyboard=abc&theme=dark".into());
        assert_eq!(plain.user_message(), "keyboard=abc&theme=dark");
    }

    #[test]
    fn sanitize_redacts_emails() {
        let e = AppError::Validation("用户 bob@example.com 的同步失败，联系 alice@test.org".into());
        let msg = e.user_message();
        assert!(!msg.contains("bob@example.com"), "{msg}");
        assert!(!msg.contains("alice@test.org"), "{msg}");
        assert!(msg.contains("<邮箱>"), "{msg}");
        assert!(msg.contains("的同步失败，联系"), "{msg}"); // 错误原因保留
    }

    #[test]
    fn sanitize_redacts_sk_prefixed_keys_without_word_false_positive() {
        let e = AppError::Validation(
            "模型调用失败 sk-abcdEFGH12345678ijklMnOp，重试 risk-assessment 未受影响".into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("sk-abcdEFGH"), "{msg}");
        assert!(msg.contains("risk-assessment"), "{msg}"); // 词中 sk- 不误伤
        assert!(msg.contains("模型调用失败"), "{msg}");
        assert!(msg.contains("<已隐藏>"), "{msg}");
    }

    #[test]
    fn sanitize_redacts_quoted_debug_object_values() {
        let e = AppError::Validation(r#"Request { token: "abc123", user: "bob" } 序列化失败"#.into());
        let msg = e.user_message();
        assert!(!msg.contains("abc123"), "{msg}");
        assert!(msg.contains(r#"user: "bob""#), "{msg}"); // 非敏感字段保留
        assert!(msg.contains("序列化失败"), "{msg}");
    }

    #[test]
    fn sanitize_combines_multiple_credential_kinds() {
        let e = AppError::Validation(
            "同步失败 Authorization: Bearer eyJhbGciOiJIUzI1，目录 C:\\Users\\alice\\cache，邮箱 bob@example.com，密钥 sk-AbCdEf0123456789ghIjKl，URL https://x.dev/api?sig=qq99ww22ee44".into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("eyJhbGciOiJIUzI1"), "{msg}");
        assert!(!msg.contains("alice"), "{msg}");
        assert!(!msg.contains("bob@example.com"), "{msg}");
        assert!(!msg.contains("sk-AbCdEf"), "{msg}");
        assert!(!msg.contains("qq99ww22ee44"), "{msg}");
        assert!(msg.contains("<用户>"), "{msg}");
        assert!(msg.contains("<邮箱>"), "{msg}");
        // 全角标点后的错误原因不得被吞进占位符
        assert!(msg.contains("目录"), "{msg}");
        assert!(msg.contains("同步失败"), "{msg}");
    }

    #[test]
    fn sanitize_third_party_error_messages_keep_reason() {
        // reqwest 风格：URL 中的凭证隐藏，超时原因保留
        let e = AppError::Agent(
            "error sending request for url (https://api.example.com/v1/chat?auth=abcd1234efgh5678): operation timed out"
                .into(),
        );
        let msg = e.user_message();
        assert!(!msg.contains("abcd1234efgh5678"), "{msg}");
        assert!(msg.contains("operation timed out"), "{msg}");
        assert!(msg.contains("error sending request"), "{msg}");

        // serde 风格：无值字段名不是凭证，整句保留
        let e = AppError::Agent("missing field `api_key` at line 1 column 42".into());
        let msg = e.user_message();
        assert!(msg.contains("missing field `api_key`"), "{msg}");
        assert!(msg.contains("line 1 column 42"), "{msg}");
    }

    #[test]
    fn sanitize_keeps_error_codes_and_reasons() {
        let e = AppError::Agent("HTTP 503 SQLITE_BUSY token=abcdef1234567890 拒绝访问".into());
        let msg = e.user_message();
        assert!(msg.contains("HTTP 503 SQLITE_BUSY"), "{msg}");
        assert!(msg.contains("拒绝访问"), "{msg}");
        assert!(msg.contains("<已隐藏>"), "{msg}");
        assert!(!msg.contains("abcdef1234567890"), "{msg}");
    }

    #[test]
    fn sanitize_truncates_overlong_text_with_ellipsis() {
        let out = sanitize_diagnostic(&format!("前缀 {}", "x".repeat(600)), 400);
        assert_eq!(out.chars().count(), 401, "{}", out.chars().count());
        assert!(out.ends_with('…'));
        assert!(out.starts_with("前缀"));
    }

    #[test]
    fn sanitize_home_dir_shape_keeps_marker_and_hides_name() {
        let e = AppError::Validation(
            "读取 C:\\Users\\alice\\db.sqlite 与 /home/bob/.config 与 /Users/carol/x 失败".into(),
        );
        let msg = e.user_message();
        assert!(msg.contains("C:\\Users\\<用户>\\db.sqlite"), "{msg}");
        assert!(msg.contains("/home/<用户>/.config"), "{msg}");
        assert!(msg.contains("/Users/<用户>/x"), "{msg}");
        assert!(!msg.contains("alice"), "{msg}");
        assert!(!msg.contains("bob"), "{msg}");
        assert!(!msg.contains("carol"), "{msg}");
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
