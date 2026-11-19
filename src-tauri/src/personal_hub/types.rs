//! Personal Hub 状态与配置数据类型（P1 骨架）。

use std::path::PathBuf;
use std::time::SystemTime;

/// 默认本地管理管道名。Named Pipe 走 Windows 本地命名空间，不占用 TCP 端口，
/// 也不存在 0.0.0.0 监听；配合 `PIPE_REJECT_REMOTE_CLIENTS` 拒绝远程客户端。
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\taskdock-personal-hub";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubConfig {
    /// 本地 Named Pipe 名称，仅当前用户 ACL 可访问。
    pub pipe_name: String,
    /// 健康检查认为管道不健康的连续失败次数阈值。
    pub health_failure_threshold: u32,
    /// Personal Hub 独立数据目录（含 hub.db）。
    /// `None` 使用 `%LOCALAPPDATA%\TaskDock\personal-hub`（测试传临时目录）。
    pub data_dir: Option<PathBuf>,
    /// Control Plane HTTPS 基地址（P3 配对）。
    /// `None` 时回退环境变量 `TASKDOCK_PH_CONTROL_PLANE_URL`；两者都没有则
    /// 配对相关方法返回「未配置」，身份/设备管理仍可用。
    pub control_plane_url: Option<String>,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            pipe_name: DEFAULT_PIPE_NAME.to_string(),
            health_failure_threshold: 3,
            data_dir: None,
            control_plane_url: None,
        }
    }
}

/// Hub 生命周期状态。显式停止与异常失败分离，避免异常恢复误覆盖用户意图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubState {
    Stopped,
    Starting,
    Running,
    Stopping,
    /// 异常失败，可由 `recover_after_failure` 尝试重建管道。
    Failed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// 用户从托盘/设置显式退出；异常恢复不得自动重启。
    ExplicitUserRequest,
    /// Windows 用户注销 / 系统关机。
    SessionLogoff,
    /// 进程内故障导致停止。
    Failure(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubStatus {
    pub state: HubState,
    pub pipe_name: Option<String>,
    pub started_at: Option<SystemTime>,
    pub stop_reason: Option<StopReason>,
}

impl HubStatus {
    pub fn stopped() -> Self {
        Self {
            state: HubState::Stopped,
            pipe_name: None,
            started_at: None,
            stop_reason: None,
        }
    }

    pub fn is_running(&self) -> bool {
        self.state == HubState::Running
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentHealth {
    pub name: &'static str,
    pub healthy: bool,
    pub detail: String,
}

/// 健康检查结果。即使 Hub 处于 Stopped，`run_health_check` 也返回 Ok(report)，
/// 由 `healthy=false` 表达，`ENVIRONMENT` 类问题才由错误类型表达。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthReport {
    pub healthy: bool,
    pub state: HubState,
    pub checked_at: SystemTime,
    pub components: Vec<ComponentHealth>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryResult {
    /// 是否实际执行了恢复动作（显式停止时不自动恢复，返回 false）。
    pub recovered: bool,
    /// 已执行的动作（不含任何敏感数据）。
    pub actions: Vec<String>,
    pub status: HubStatus,
}
