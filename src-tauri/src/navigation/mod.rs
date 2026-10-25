//! 统一导航系统（v0.4）：普通软件、窗口、网页、文件与 Agent 会话的统一跳转。
//!
//! 分层：
//! - `app_discovery`：软件发现（开始菜单 / 注册表 / UWP / 运行进程 / 常用路径），只做观测；
//! - `window_manager`：Windows 顶层窗口枚举与焦点控制（EnumWindows / SetForegroundWindow）；
//! - `target_resolver`：导航目标的持久化（navigation_targets）与执行前重校验；
//! - `agent_navigation`：各 Agent 的跳转能力（证据化，不含观测逻辑）；
//! - `router`：NavigationRouter —— 按目标类型选择 L1~L4 动作并按偏好降级。
//!
//! 安全约定：
//! - 跳转一律读取数据库中用户确认过的目标配置并重新校验，不信任前端透传的路径/参数；
//! - 全程使用结构化进程 API（Command::new + args 数组），不拼接 shell 字符串；
//! - URL 仅允许 http/https；Agent 事件携带的路径属于不可信数据，永不直接执行。

pub mod agent_navigation;
pub mod app_discovery;
pub mod router;
pub mod target_resolver;
pub mod window_manager;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 目标类型（与 navigation_targets.target_type 对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NavigationTargetType {
    Application,
    Url,
    File,
    Directory,
    AgentSession,
}

impl NavigationTargetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NavigationTargetType::Application => "application",
            NavigationTargetType::Url => "url",
            NavigationTargetType::File => "file",
            NavigationTargetType::Directory => "directory",
            NavigationTargetType::AgentSession => "agent_session",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "application" => Some(NavigationTargetType::Application),
            "url" => Some(NavigationTargetType::Url),
            "file" => Some(NavigationTargetType::File),
            "directory" => Some(NavigationTargetType::Directory),
            "agent_session" => Some(NavigationTargetType::AgentSession),
            _ => None,
        }
    }
}

/// 导航层级动作（L1 打开软件 → L4 恢复会话）。
pub const ACTION_OPEN_APP: &str = "open_app"; // L1 启动软件
pub const ACTION_FOCUS_WINDOW: &str = "focus_window"; // L2 唤醒窗口
pub const ACTION_OPEN_URL: &str = "open_url"; // L3 打开网页
pub const ACTION_OPEN_FILE: &str = "open_file"; // L3 打开文件
pub const ACTION_REVEAL_FILE: &str = "reveal_file"; // L3 资源管理器定位
pub const ACTION_OPEN_DIRECTORY: &str = "open_directory"; // L3 打开目录
pub const ACTION_RESUME_SESSION: &str = "resume_session"; // L4 恢复 Agent 会话
pub const ACTION_OPEN_WORKSPACE: &str = "open_workspace"; // L3/4 打开工作区（IDE/目录）

/// 验证级别：动作成功到什么程度被证实了。
/// 不允许把 process-spawned 说成 window-confirmed。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationLevel {
    /// 已验证：窗口已置前（前台句柄即目标窗口）
    WindowConfirmed,
    /// 进程确已启动（spawn 成功），窗口是否出现未证实
    ProcessSpawned,
    /// 启动请求已提交（explorer shell:AppsFolder 等），结果由系统决定
    LaunchRequested,
    /// 委托给系统默认处理器（默认浏览器 / 文件关联），无法核实结果
    Delegated,
    /// 未执行（失败或被拒绝）
    None,
}

impl VerificationLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            VerificationLevel::WindowConfirmed => "window-confirmed",
            VerificationLevel::ProcessSpawned => "process-spawned",
            VerificationLevel::LaunchRequested => "launch-requested",
            VerificationLevel::Delegated => "delegated",
            VerificationLevel::None => "none",
        }
    }
}

/// 统一导航结果（前端据此如实反馈，不夸大成功）。
#[derive(Debug, Clone, Serialize)]
pub struct NavigationResult {
    pub success: bool,
    pub requested_action: String,
    pub actual_action: Option<String>,
    pub fallback_used: bool,
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub verification_level: String,
}

impl NavigationResult {
    pub fn failure(target_id: &str, requested: &str, reason: impl Into<String>) -> Self {
        Self {
            success: false,
            requested_action: requested.to_string(),
            actual_action: None,
            fallback_used: false,
            target_id: target_id.to_string(),
            reason: Some(reason.into()),
            verification_level: VerificationLevel::None.as_str().to_string(),
        }
    }
}

// ── 安全校验（注册与执行共用）────────────────────────────────

/// 禁止注册为启动目标的解释器（参数可携带任意命令，属于 shell 注入面）。
const BLOCKED_EXE_NAMES: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wscript.exe",
    "cscript.exe",
    "mshta.exe",
    "rundll32.exe",
    "regsvr32.exe",
    "conhost.exe",
];

/// exe 路径校验：必须绝对路径、.exe 后缀、存在、且不在解释器黑名单。
/// 数据库中的目标在每次执行前都要再过一遍这里。
pub fn validate_exe_path(raw: &str) -> AppResult<std::path::PathBuf> {
    let p = std::path::PathBuf::from(raw.trim());
    if raw.trim().is_empty() {
        return Err(AppError::Validation("可执行路径为空".into()));
    }
    if !p.is_absolute() {
        return Err(AppError::Validation(format!("可执行路径必须是绝对路径: {}", raw)));
    }
    let lower = raw.trim().to_ascii_lowercase();
    if !lower.ends_with(".exe") {
        return Err(AppError::Validation("只允许 .exe 可执行文件".into()));
    }
    let file_name = p
        .file_name()
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if BLOCKED_EXE_NAMES.contains(&file_name.as_str()) {
        return Err(AppError::Validation(format!(
            "不允许注册 {} 为启动目标（命令解释器有注入风险）",
            file_name
        )));
    }
    if !p.exists() {
        return Err(AppError::Validation(format!("程序不存在: {}", raw)));
    }
    Ok(p)
}

/// URL 校验：仅 http/https，长度受限，禁止内嵌控制字符。
pub fn validate_url(raw: &str) -> AppResult<()> {
    let u = raw.trim();
    if u.is_empty() || u.chars().count() > 2048 {
        return Err(AppError::Validation("URL 为空或超过 2048 字符".into()));
    }
    if u.chars().any(|c| c.is_control() || c == '"' || c == '<' || c == '>' || c == '|') {
        return Err(AppError::Validation("URL 含非法字符".into()));
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::Validation(
            "仅允许 http/https 网址（其他协议已被拒绝）".into(),
        ));
    }
    Ok(())
}

/// UWP/MSIX AUMID 校验：白名单字符集（shell:AppsFolder 参数注入面）。
pub fn validate_aumid(raw: &str) -> AppResult<()> {
    let a = raw.trim();
    if a.is_empty() || a.chars().count() > 256 {
        return Err(AppError::Validation("AppUserModelID 为空或过长".into()));
    }
    if !a
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '!'))
    {
        return Err(AppError::Validation("AppUserModelID 含非法字符".into()));
    }
    Ok(())
}

/// 启动参数校验：长度受限、无换行/引号逃逸。参数经 args 数组传给 CreateProcess，
/// 本身不经 shell；校验主要为防止后续被别的路径误用。
pub fn validate_launch_args(raw: &str) -> AppResult<()> {
    let a = raw.trim();
    if a.chars().count() > 512 {
        return Err(AppError::Validation("启动参数超过 512 字符".into()));
    }
    if a.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("启动参数含控制字符".into()));
    }
    Ok(())
}

/// 本地路径（文件/目录）校验：绝对路径且存在。
pub fn validate_local_path(raw: &str) -> AppResult<std::path::PathBuf> {
    let p = std::path::PathBuf::from(raw.trim());
    if raw.trim().is_empty() {
        return Err(AppError::Validation("路径为空".into()));
    }
    if !p.is_absolute() {
        return Err(AppError::Validation(format!("必须是绝对路径: {}", raw)));
    }
    if !p.exists() {
        return Err(AppError::Validation(format!("路径不存在: {}", raw)));
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_scheme_whitelist() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://127.0.0.1:8080/x").is_ok());
        // 危险协议与注入形态全部拒绝
        assert!(validate_url("file:///C:/Windows/system32/cmd.exe").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("ms-settings:display").is_err());
        assert!(validate_url("https://a.com/\u{0000}").is_err());
        assert!(validate_url(&format!("https://a.com/{}", "x".repeat(3000))).is_err());
    }

    #[test]
    fn exe_path_rules() {
        // 相对路径拒绝
        assert!(validate_exe_path("notepad.exe").is_err());
        // 非 exe 拒绝
        assert!(validate_exe_path("C:\\Windows\\notepad.txt").is_err());
        // 不存在拒绝
        assert!(validate_exe_path("C:\\definitely\\not\\there\\app.exe").is_err());
        // 解释器黑名单：存在性未知也应被黑名单先行拒绝（本机 C:\Windows\System32\cmd.exe 存在）
        let err = validate_exe_path("C:\\Windows\\System32\\cmd.exe").unwrap_err();
        assert!(err.to_string().contains("不允许"));
        // 合法系统应用通过（所有 Windows 都有 notepad.exe）
        assert!(validate_exe_path("C:\\Windows\\notepad.exe").is_ok());
    }

    #[test]
    fn aumid_charset() {
        assert!(validate_aumid("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App").is_ok());
        assert!(validate_aumid("bad aumid & calc").is_err());
        assert!(validate_aumid(&format!("a!{}", "x".repeat(300))).is_err());
    }

    #[test]
    fn launch_args_rules() {
        assert!(validate_launch_args("--profile \"Work\"").is_ok());
        assert!(validate_launch_args(&format!("--{}", "x".repeat(600))).is_err());
        assert!(validate_launch_args("line\nbreak").is_err());
    }
}
