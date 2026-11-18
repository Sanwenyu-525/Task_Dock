//! 安全保险箱错误类型。
//!
//! 与 `crate::error::AppError` 分开：保险箱需要**稳定的错误码**（前端按码分支），
//! 且错误消息绝不能回显用户输入（主密码、恢复密钥、记录内容）。
//! 序列化结构与前端 `normalizeError` 兼容：`{ code, category, severity, retryable, message, detail? }`。

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultError {
    pub code: String,
    pub category: &'static str,
    pub severity: &'static str,
    pub retryable: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl VaultError {
    fn new(
        code: &str,
        message: impl Into<String>,
        category: &'static str,
        severity: &'static str,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.to_string(),
            category,
            severity,
            retryable,
            message: message.into(),
            detail: None,
        }
    }

    pub fn locked() -> Self {
        Self::new(
            "VAULT_LOCKED",
            "保险箱已锁定，请先解锁",
            "permission",
            "warning",
            false,
        )
    }

    pub fn bad_password() -> Self {
        Self::new(
            "VAULT_BAD_PASSWORD",
            "主密码不正确",
            "permission",
            "warning",
            true,
        )
    }

    pub fn bad_recovery_key() -> Self {
        Self::new(
            "VAULT_BAD_RECOVERY_KEY",
            "恢复密钥无效，请检查是否抄写完整",
            "permission",
            "warning",
            true,
        )
    }

    pub fn cooldown(seconds: i64) -> Self {
        Self::new(
            "VAULT_COOLDOWN",
            format!("尝试过于频繁，请 {seconds} 秒后再试"),
            "permission",
            "warning",
            true,
        )
    }

    pub fn corrupt() -> Self {
        Self::new(
            "VAULT_DATA_CORRUPT",
            "数据校验失败，可能已损坏或被修改",
            "integrity",
            "critical",
            false,
        )
    }

    pub fn format_unsupported(found: u32, supported: u32) -> Self {
        Self::new(
            "VAULT_FORMAT_UNSUPPORTED",
            format!("保险箱版本 {found} 高于当前支持的 {supported}，请升级 Task Dock"),
            "unsupported",
            "error",
            false,
        )
        .with_detail(format!("found={found},supported={supported}"))
    }

    pub fn validation(field: &str, rule: &str) -> Self {
        Self::new(
            "VAULT_VALIDATION",
            format!("{field} 不符合要求：{rule}"),
            "validation",
            "warning",
            true,
        )
    }

    pub fn not_found() -> Self {
        Self::new("VAULT_NOT_FOUND", "记录不存在", "not_found", "warning", false)
    }

    pub fn conflict(expected: i64, actual: i64) -> Self {
        Self::new(
            "VAULT_CONFLICT",
            "该记录已被修改，请刷新后重试",
            "conflict",
            "warning",
            true,
        )
        .with_detail(format!("expected={expected},actual={actual}"))
    }

    pub fn already_exists() -> Self {
        Self::new(
            "VAULT_ALREADY_EXISTS",
            "保险箱已存在",
            "conflict",
            "warning",
            false,
        )
    }

    pub fn recovery_readonly() -> Self {
        Self::new(
            "VAULT_RECOVERY_READONLY",
            "恢复模式下只能查看，请先设置新主密码",
            "permission",
            "warning",
            false,
        )
    }

    pub fn kdf_failed(detail: impl Into<String>) -> Self {
        Self::new(
            "VAULT_KDF_FAILED",
            "密钥派生失败，请重试",
            "service",
            "error",
            true,
        )
        .with_detail(detail)
    }

    pub fn io(detail: impl Into<String>) -> Self {
        Self::new(
            "VAULT_IO",
            "本地存储读写失败",
            "io",
            "error",
            true,
        )
        .with_detail(detail)
    }

    pub fn migration(detail: impl Into<String>) -> Self {
        Self::new(
            "VAULT_MIGRATION_FAILED",
            "保险箱升级失败，数据未被修改",
            "database",
            "critical",
            false,
        )
        .with_detail(detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(
            "VAULT_INTERNAL",
            "保险箱操作失败",
            "unknown",
            "error",
            false,
        )
        .with_detail(detail)
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for VaultError {}

impl From<rusqlite::Error> for VaultError {
    fn from(e: rusqlite::Error) -> Self {
        // 只保留 sqlite 错误码，不带 SQL 语句。
        let detail = match &e {
            rusqlite::Error::SqliteFailure(err, _) => format!("sqlite:{:?}", err.code),
            _ => "sqlite".to_string(),
        };
        Self::io(detail)
    }
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        Self::io(format!("io:{:?}", e.kind()))
    }
}

impl From<serde_json::Error> for VaultError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(
            "VAULT_DATA_CORRUPT",
            "数据校验失败，可能已损坏或被修改",
            "integrity",
            "critical",
            false,
        )
        .with_detail(format!("json:{}", e.classify() as u8))
    }
}
