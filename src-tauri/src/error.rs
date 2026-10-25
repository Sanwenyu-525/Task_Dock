//! 统一错误类型：内部错误不在前端暴露细节，只暴露可读消息。
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
    #[error("Tauri 错误: {0}")]
    Tauri(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
