//! 统一错误类型（方法级设计 §0）。
//!
//! P1 只实际使用 `Storage` / `Network` 两个变体；其余变体按基线预留给
//! P2–P7（身份、配对、认证、会话、权限、撤销）。提前定义完整枚举是为了
//! 保证后续阶段不必改动公开 API。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum HubError {
    /// 邀请过期/重复/签名错误（P3）。
    #[error("invalid invitation: {0}")]
    InvalidInvitation(String),

    /// 身份/签名/指纹不匹配（P3/P4）。
    #[error("identity verification failed: {0}")]
    Identity(String),

    /// 设备已撤销（P3/P7）。
    #[error("device revoked")]
    DeviceRevoked,

    /// 需要先完成被控端本机认证（P5）。
    #[error("local authentication required")]
    LocalAuthRequired,

    /// 本机认证失败/取消/超时/不可用（P5）。
    #[error("local authentication failed: {0}")]
    LocalAuthFailed(String),

    /// 权限拒绝（P5/P7）。
    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// 会话状态/身份/nonce/过期不符（P5/P7）。
    #[error("invalid session: {0}")]
    InvalidSession(String),

    /// 网络/传输错误（P1 用于 Named Pipe 创建、P2/P4 用于 WSS/WebRTC）。
    #[error("network error: {0}")]
    Network(String),

    /// 本地存储/IPC 资源错误（P1 主要错误类型）。
    #[error("storage error: {0}")]
    Storage(String),
}

pub type HubResult<T> = Result<T, HubError>;
