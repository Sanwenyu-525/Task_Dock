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

impl AppError {
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

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
