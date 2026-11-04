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
                    rusqlite::ErrorCode::DatabaseCorrupt
                    | rusqlite::ErrorCode::NotADatabase => ErrorMeta {
                        code: "DATA_INTEGRITY_ERROR",
                        category: ErrorCategory::Integrity,
                        severity: ErrorSeverity::Critical,
                        retryable: false,
                    },
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
            AppError::Io(e) => Some(sanitize(&e.to_string())),
            AppError::Json(e) => Some(sanitize(&e.to_string())),
            AppError::Tauri(e) => Some(sanitize(&e.to_string())),
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
            AppError::Conflict(m) => AppError::Conflict(m.clone()),
            AppError::Agent(m) => AppError::Agent(m.clone()),
            other => AppError::Agent(other.to_string()),
        }
    }
}

/// 单行化 + 截断 + 脱敏用户目录名：不把系统隐私路径原样抛给前端。
fn sanitize(raw: &str) -> String {
    let mut s = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    // C:\Users\<name>\... → C:\Users\<用户>\...（保留结构，隐藏账户名）
    for prefix in ["C:\\Users\\", "c:\\Users\\", "C:\\users\\", "c:\\users\\"] {
        while let Some(pos) = s.find(prefix) {
            let rest = &s[pos + prefix.len()..];
            match rest.find('\\') {
                Some(end) => {
                    let name = &rest[..end];
                    if name.is_empty() || name == "<用户>" {
                        break;
                    }
                    let start = pos + prefix.len();
                    s.replace_range(start..start + end, "<用户>");
                }
                None => break,
            }
        }
    }
    let mut out: String = s.chars().take(240).collect();
    if s.chars().count() > 240 {
        out.push('…');
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
        let e = AppError::Io(std::io::Error::new(ErrorKind::NotFound, "C:\\Users\\alice\\a.txt"));
        assert_eq!(e.code(), "NOT_FOUND");
        assert_eq!(e.user_message(), "文件或路径不存在");
        // 细节里保留路径结构，但隐藏账户名
        let detail = e.detail().unwrap();
        assert!(!detail.contains("alice"));
        assert!(detail.contains("<用户>"));
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
