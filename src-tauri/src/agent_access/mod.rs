//! Agent 共享工作空间：统一访问层。
//!
//! 四个入口（CLI / MCP / REST / 文件）共用同一套业务服务与权限、审计、版本规则：
//! ```text
//! CLI(独立进程) ─┐
//! MCP(loopback) ─┼→ service / context / handoff → 既有 planning·tasks·knowledge 服务 → SQLite
//! REST(loopback)─┤
//! 文件(受控导入) ─┘
//! ```
//! 本模块**不复制**任何业务 SQL：任务/规划/知识读写全部调用既有 `*_impl`；
//! 只有新增语义（决策、交接、报告、同步、版本、活动、上下文访问）才拥有自己的表。

pub mod cli;
pub mod commands;
pub mod context;
pub mod handoff;
pub mod mcp_tools;
pub mod permissions;
pub mod projection;
pub mod rest;
pub mod schema;
pub mod service;
pub mod store;
pub mod sync;
pub mod watch;
pub mod workspace;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

/// 文件协议名（写入 manifest，其他软件据此识别）。
pub const PROTOCOL: &str = "taskdock-agent-workspace";
pub const PROTOCOL_VERSION: &str = "1.0";
pub const SCHEMA_VERSION: &str = "1.0";

/// 工作空间归属标记文件名。缺失时拒绝向该目录导出（避免污染用户目录）。
pub const WORKSPACE_MARKER: &str = ".taskdock-workspace.json";
pub const MANIFEST_FILE: &str = "manifest.json";

/// 单个导入文件上限（与 REST body 上限一致）。
pub const MAX_IMPORT_BYTES: u64 = 256 * 1024;
/// 单次导入扫描的文件数上限。
pub const MAX_SCAN_FILES: usize = 200;
/// 单次全量导出的文件数上限；超出时只导出脏资源。
pub const MAX_EXPORT_FILES: usize = 2000;
/// 轮询监听默认间隔（秒）。
pub const DEFAULT_WATCH_SECS: u64 = 20;

/// 写入来源。由服务端按入口判定，调用方不能伪造。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Ui,
    Cli,
    Mcp,
    Rest,
    File,
    System,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Ui => "ui",
            Source::Cli => "cli",
            Source::Mcp => "mcp",
            Source::Rest => "rest",
            Source::File => "file",
            Source::System => "system",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "ui" => Source::Ui,
            "cli" => Source::Cli,
            "mcp" => Source::Mcp,
            "rest" => Source::Rest,
            "file" => Source::File,
            "system" => Source::System,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    Human,
    Agent,
    System,
}

impl ActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ActorKind::Human => "human",
            ActorKind::Agent => "agent",
            ActorKind::System => "system",
        }
    }
}

/// 一次请求的操作主体。
#[derive(Clone, Debug)]
pub struct Principal {
    /// `mcp_agents.id`；本机用户为 None
    pub agent_row_id: Option<String>,
    /// `mcp_agents.agent_id`；本机用户为空串
    pub agent_id: String,
    pub actor_kind: ActorKind,
    pub source: Source,
    /// 审计用会话键（同一次进程/连接内稳定，不落用户数据）
    pub session_key: String,
    /// 强制只读（`TASKDOCK_CLI_READONLY`）
    pub read_only: bool,
}

impl Principal {
    pub fn local(source: Source) -> Self {
        Self {
            agent_row_id: None,
            agent_id: String::new(),
            actor_kind: ActorKind::Human,
            source,
            session_key: format!("local-{}", short_id()),
            read_only: false,
        }
    }

    pub fn agent(agent_row_id: String, agent_id: String, source: Source) -> Self {
        Self {
            agent_row_id: Some(agent_row_id),
            agent_id,
            actor_kind: ActorKind::Agent,
            source,
            session_key: format!("agent-{}", short_id()),
            read_only: false,
        }
    }

    /// 审计/导出使用的身份标签。
    pub fn label(&self) -> String {
        match self.actor_kind {
            ActorKind::Agent => self.agent_id.clone(),
            ActorKind::Human => "local".to_string(),
            ActorKind::System => "system".to_string(),
        }
    }

    pub fn is_agent(&self) -> bool {
        self.actor_kind == ActorKind::Agent
    }
}

fn short_id() -> String {
    uuid::Uuid::new_v4().to_string().chars().take(8).collect()
}

/// 分页元数据。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Page {
    pub limit: u32,
    pub offset: u32,
    pub total: u32,
    pub has_more: bool,
}

impl Page {
    pub fn new(limit: u32, offset: u32, total: u32) -> Self {
        let has_more = (offset as u64 + limit as u64) < total as u64;
        Self {
            limit,
            offset,
            total,
            has_more,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Meta {
    pub request_id: String,
    pub timestamp: String,
    pub schema_version: &'static str,
    pub interface: &'static str,
    pub actor: &'static str,
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pagination: Option<Page>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replayed: bool,
}

impl Meta {
    pub fn new(principal: &Principal, request_id: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            timestamp: crate::agents::now_iso(),
            schema_version: SCHEMA_VERSION,
            interface: principal.source.as_str(),
            actor: principal.actor_kind.as_str(),
            agent_id: if principal.agent_id.is_empty() {
                None
            } else {
                Some(principal.agent_id.clone())
            },
            pagination: None,
            replayed: false,
        }
    }

    pub fn with_page(mut self, page: Page) -> Self {
        self.pagination = Some(page);
        self
    }
}

/// 统一响应封套（CLI stdout / REST body 共用同一形状）。
#[derive(Clone, Debug, Serialize)]
pub struct Envelope {
    pub success: bool,
    pub data: Value,
    pub error: Option<ErrorBody>,
    pub meta: Meta,
}

impl Envelope {
    pub fn ok(data: Value, meta: Meta) -> Self {
        Self {
            success: true,
            data,
            error: None,
            meta,
        }
    }

    pub fn fail(err: &AppError, meta: Meta) -> Self {
        Self {
            success: false,
            data: Value::Null,
            error: Some(ErrorBody {
                code: error_code(err),
                message: err.user_message(),
                details: error_details(err),
                retryable: err.retryable(),
            }),
            meta,
        }
    }
}

/// `AppError` → 稳定错误码（对外契约，不随文案变化）。
pub fn error_code(err: &AppError) -> &'static str {
    match err {
        AppError::Validation(_) => "VALIDATION",
        AppError::NotFound(_) => "NOT_FOUND",
        AppError::Conflict(_) => "CONFLICT",
        AppError::Agent(_) => "FORBIDDEN",
        AppError::Forbidden(_) => "FORBIDDEN",
        AppError::Overloaded(_) => "RATE_LIMITED",
        AppError::Unavailable(_) => "UNAVAILABLE",
        AppError::PermissionRequired(_) => "PERMISSION_REQUIRED",
        AppError::Io(_) => "IO",
        AppError::Db(_) => "DATABASE",
        AppError::Json(_) => "JSON",
        AppError::Tauri(_) => "IPC",
    }
}

fn error_details(err: &AppError) -> Value {
    match err {
        AppError::Validation(msg) | AppError::NotFound(msg) | AppError::Conflict(msg) => {
            serde_json::json!({ "reason": msg })
        }
        AppError::Agent(msg) => serde_json::json!({ "reason": msg }),
        _ => Value::Null,
    }
}

/// HTTP 状态映射（REST 用）。
pub fn http_status(code: &str) -> u16 {
    match code {
        "VALIDATION" => 400,
        "UNAUTHORIZED" => 401,
        "FORBIDDEN" => 403,
        "NOT_FOUND" => 404,
        "CONFLICT" => 409,
        "SCHEMA_MISMATCH" => 422,
        "RATE_LIMITED" => 429,
        "UNAVAILABLE" | "PERMISSION_REQUIRED" => 503,
        _ => 500,
    }
}

/// CLI 退出码映射。
pub fn exit_code(code: &str) -> i32 {
    match code {
        "USAGE" => 2,
        "NOT_FOUND" => 3,
        "VALIDATION" | "SCHEMA_MISMATCH" => 4,
        "CONFLICT" => 5,
        "FORBIDDEN" | "UNAUTHORIZED" | "PERMISSION_REQUIRED" => 6,
        "UNAVAILABLE" | "DATABASE" | "IO" => 7,
        _ => 8,
    }
}

/// 便捷构造：授权失败（对外统一 FORBIDDEN）。
pub fn forbidden(msg: impl Into<String>) -> AppError {
    AppError::Agent(msg.into())
}

/// 便捷构造：字段校验失败。
pub fn validation(msg: impl Into<String>) -> AppError {
    AppError::Validation(msg.into())
}

/// 未知/缺失参数统一文案，避免各接口写法漂移。
pub fn missing_arg(name: &str) -> AppError {
    AppError::Validation(format!("缺少必填参数: {name}"))
}
