//! 数据模型：与 SQLite 表一一对应的行结构（时间一律以 UTC ISO8601 字符串存储）。
use serde::{Deserialize, Serialize};

pub const PRIORITY_NAMES: [&str; 4] = ["P0", "P1", "P2", "P3"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub priority: u8,
    pub status: String, // pending | completed
    pub category: String,
    pub tags: Vec<String>,
    pub due_at: Option<String>,
    pub remind_at: Option<String>,
    pub advance_minutes: i64,
    pub recurrence: Option<RecurrenceRule>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// 关联的 Agent 会话数量（UI 展示用）
    #[serde(default)]
    pub linked_agents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecurrenceRule {
    pub id: String,
    pub freq: String, // daily | weekly | monthly
    pub interval: i64,
    pub by_weekday: Vec<u32>, // 1=周一 .. 7=周日
    pub by_monthday: Option<u32>,
    pub until: Option<String>,
    #[serde(default)]
    pub anchor: String, // 首次发生日期 YYYY-MM-DD（每周多日规则的周锚点）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub id: String,
    pub task_id: String,
    pub remind_at: String,
    pub occurrence: String,
    pub kind: String, // due | advance | custom
    pub fired: bool,
    pub fired_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSource {
    pub id: String,
    pub display_name: String,
    /// transport | manual | stub | mock
    pub kind: String,
    pub enabled: bool,
    /// 是否已核实官方接入能力
    pub verified: bool,
    pub homepage: String,
    pub note: String,
    pub config: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: String,
    pub source_id: String,
    pub external_id: String,
    pub title: String,
    pub status: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub last_run_id: Option<String>,
    /// 关联的 agent_instances 行 ID（未知为 NULL，前端不得伪造实例）
    #[serde(default)]
    pub instance_id: Option<String>,
}

/// Agent 实例（同一 Agent 的多个安装/进程实例）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstance {
    pub id: String,
    pub source_id: String,
    pub instance_key: String,
    pub display_name: String,
    pub exe_path: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: String,
    pub session_id: String,
    pub source_id: String,
    pub external_run_id: Option<String>,
    pub task_title: String,
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    pub pending_items: Vec<String>,
    /// 关联的 agent_instances 行 ID（事件未携带实例信息时为 NULL）
    #[serde(default)]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEventRow {
    pub id: String,
    pub source_id: String,
    pub session_external_id: String,
    pub run_external_id: Option<String>,
    pub event_type: String,
    pub state: String,
    pub message: Option<String>,
    pub received_at: String,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub evidence_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskAgentLink {
    pub id: String,
    pub task_id: String,
    pub source_id: String,
    pub session_external_id: String,
    pub run_external_id: Option<String>,
    pub created_at: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub ref_type: Option<String>,
    pub ref_id: Option<String>,
    pub occurrence: Option<String>,
    pub is_read: bool,
    pub created_at: String,
}
