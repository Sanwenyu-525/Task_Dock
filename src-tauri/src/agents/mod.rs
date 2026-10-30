//! AI Agent 状态接入层：统一事件模型、校验、状态机与事件总线。
//!
//! 架构（v0.2）：
//! - `AgentEvent` 是所有 Adapter 输出的统一事件（只含状态元数据，不含 Prompt/代码内容）；
//! - 分层模型：`Agent 来源 → 实例 → 会话 → 执行轮次 → 事件`；
//! - `ingest_core` 是纯数据库状态机（可在事务内调用，不依赖 Tauri，可用内存库做集成测试）；
//! - `AgentHub::ingest` 是唯一入口：事务内完成 校验→实例→会话→轮次状态机→事件→通知记录，
//!   提交后再做 OS 通知与 UI 广播；任何写库失败整体回滚，不出现半更新；
//! - 状态机保证：事件级幂等（dedupe_key 唯一）、乱序保护（迟到事件不回退终态）、
//!   终态保护（旧的 running 不会复活已结束的轮次）、多轮会话（终态后新一轮事件开新轮次）；
//! - Adapter（mock / file_drop / http_ingest / hooks / 插件桥接）只负责产生事件；
//! - 任何来源未注册或被禁用的事件一律拒绝，禁止伪造状态。

pub mod codex;
pub mod discovery;
pub mod dsh;
pub mod file_drop;
pub mod hook_cli;
pub mod hooks_install;
pub mod http_ingest;
pub mod inbox;
pub mod managed;
pub mod mock;
pub mod notify;
pub mod opencode;
pub mod pipeline;
pub mod qoder;
pub mod retention;
pub mod shutdown_signal;
pub mod spool;
pub mod trae;
pub mod workbuddy;
pub mod zcode;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::{AgentInstance, AgentRun, AgentSession, AgentSource, Db};
use crate::error::{AppError, AppResult};

use self::notify::{NotificationPolicy, NotifyGate, NotifyItem};

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// 服务端受理序号：跨 HTTP/文件/插件/合并缓冲的因果顺序基准。
///
/// 客户端载荷不能设置该字段（`serde(skip)`），一律由服务端在受理时分配。
/// 进程内严格递增；跨重启以 Unix 微秒抬高起点，避免重启后序号回退。
/// 若系统时钟被回拨，`bump_ingest_seq` 会在启动时把起点抬到库内最大值。
static INGEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// OS 通知诊断计数（每次调用与结果；不记录标题/正文）。
static NOTIFY_ATTEMPTED: AtomicU64 = AtomicU64::new(0);
static NOTIFY_SUCCEEDED: AtomicU64 = AtomicU64::new(0);
static NOTIFY_FAILED: AtomicU64 = AtomicU64::new(0);

pub fn notification_stats() -> serde_json::Value {
    serde_json::json!({
        "attempted": NOTIFY_ATTEMPTED.load(Ordering::Relaxed),
        "succeeded": NOTIFY_SUCCEEDED.load(Ordering::Relaxed),
        "failed": NOTIFY_FAILED.load(Ordering::Relaxed),
    })
}

pub fn next_ingest_seq() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(1);
    let mut cur = INGEST_SEQ.load(Ordering::Relaxed);
    loop {
        let next = now.max(cur.saturating_add(1));
        match INGEST_SEQ.compare_exchange_weak(cur, next, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(actual) => cur = actual,
        }
    }
}

/// 启动/恢复备份后抬高序号起点（不会降低）。
pub fn bump_ingest_seq(min: u64) {
    if min > 0 {
        INGEST_SEQ.fetch_max(min, Ordering::AcqRel);
    }
}

/// 传输通道（由服务端按接入入口确定，客户端载荷声明的 transport 一律不作为可信依据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Http,
    File,
    Hook,
    Plugin,
    /// 内置模拟器：永不参与任何验证置位
    Mock,
    /// 人工/调试上报：不作为接入证据
    Manual,
}

impl Transport {
    pub fn as_str(&self) -> &'static str {
        match self {
            Transport::Http => "http",
            Transport::File => "file",
            Transport::Hook => "hook",
            Transport::Plugin => "plugin",
            Transport::Mock => "mock",
            Transport::Manual => "manual",
        }
    }
    /// 是否真实 Agent 事件通道（有资格参与验证置位）。
    pub fn is_real(&self) -> bool {
        matches!(
            self,
            Transport::Http | Transport::File | Transport::Hook | Transport::Plugin
        )
    }

    /// 磁盘暂存重放时还原服务端判定的通道。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "http" => Some(Transport::Http),
            "file" => Some(Transport::File),
            "hook" => Some(Transport::Hook),
            "plugin" => Some(Transport::Plugin),
            "mock" => Some(Transport::Mock),
            "manual" => Some(Transport::Manual),
            _ => None,
        }
    }
}

/// 自测会话前缀：verify_hook_pipeline 生成的事件使用该前缀，
/// ingest 识别后隔离为 selftest 证据（不置 verified、不计入真实会话）。
const SELFTEST_PREFIX: &str = "taskdock-selftest-";

fn is_selftest_session(session_id: &str) -> bool {
    session_id.starts_with(SELFTEST_PREFIX)
}

/// 事件来源可信分类（完全由服务端判定，客户端载荷无法设置或提升）。
///
/// 判定依据：来源注册表的 `category`（服务端维护）、接入入口判定的 `Transport`
/// 以及验证器签发的保留会话前缀。客户端最多只能把自己的事件降级为测试数据，
/// 无法把压测/自测/模拟事件伪装成真实 Agent 事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventOrigin {
    /// 真实 Agent 通过真实通道产生的事件：唯一能改变真实状态、验证来源、
    /// 进入行动中心与系统通知的分类。
    Real,
    /// 接入向导自测：只证明通道可用，不产生真实状态/通知。
    Selftest,
    /// 性能基准：隐藏来源，不进入真实状态/行动中心/通知，可整体审计清理。
    Benchmark,
    /// 内置模拟器或 mock 来源：永不参与验证。
    Mock,
    /// 人工/调试上报：不作为接入证据。
    Manual,
}

impl EventOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventOrigin::Real => "real",
            EventOrigin::Selftest => "selftest",
            EventOrigin::Benchmark => "benchmark",
            EventOrigin::Mock => "mock",
            EventOrigin::Manual => "manual",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "real" => Some(EventOrigin::Real),
            "selftest" => Some(EventOrigin::Selftest),
            "benchmark" => Some(EventOrigin::Benchmark),
            "mock" => Some(EventOrigin::Mock),
            "manual" => Some(EventOrigin::Manual),
            _ => None,
        }
    }

    /// 只有真实事件可以驱动真实 Agent 状态、行动中心与系统通知。
    pub fn is_real(&self) -> bool {
        matches!(self, EventOrigin::Real)
    }
}

/// Agent 统一状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    Running,
    Waiting,
    Completed,
    Failed,
    Disconnected,
}

impl AgentState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentState::Idle => "idle",
            AgentState::Running => "running",
            AgentState::Waiting => "waiting",
            AgentState::Completed => "completed",
            AgentState::Failed => "failed",
            AgentState::Disconnected => "disconnected",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "idle" => Some(AgentState::Idle),
            "running" | "working" | "active" => Some(AgentState::Running),
            "waiting" | "wait" | "paused" => Some(AgentState::Waiting),
            "completed" | "done" | "complete" => Some(AgentState::Completed),
            "failed" | "error" => Some(AgentState::Failed),
            "disconnected" | "offline" | "stale" => Some(AgentState::Disconnected),
            _ => None,
        }
    }
    /// 是否执行终态（受终态保护，不容旧事件回退）。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            AgentState::Completed | AgentState::Failed | AgentState::Disconnected
        )
    }
    /// 托盘图标聚合优先级（越大越优先）。
    pub fn priority(&self) -> u8 {
        match self {
            AgentState::Failed => 5,
            AgentState::Waiting => 4,
            AgentState::Running => 3,
            AgentState::Completed => 2,
            AgentState::Disconnected => 1,
            AgentState::Idle => 0,
        }
    }
    pub fn label_cn(&self) -> &'static str {
        match self {
            AgentState::Idle => "空闲",
            AgentState::Running => "运行中",
            AgentState::Waiting => "等待处理",
            AgentState::Completed => "本轮完成",
            AgentState::Failed => "执行失败",
            AgentState::Disconnected => "已断开",
        }
    }
    pub fn is_active(&self) -> bool {
        matches!(self, AgentState::Running | AgentState::Waiting)
    }
}

/// Adapter 上报的统一事件（v0.2 扩展字段全部可选，兼容 v0.1 载荷）。
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AgentEvent {
    /// 事件 schema 版本（当前 1）
    #[serde(default)]
    pub schema_version: Option<u32>,
    /// Adapter 侧事件唯一 ID（提供则按其幂等去重）
    #[serde(default)]
    pub event_id: Option<String>,
    /// 已注册的来源 ID（codex / trae / qoder / workbuddy / opencode / ...）
    pub source_id: String,
    /// Agent 实例标识（同一 Agent 的多个进程/安装实例分开统计；可选）
    #[serde(default)]
    pub instance_id: Option<String>,
    /// Agent 侧会话 ID
    pub session_id: String,
    /// Agent 侧执行轮次 ID（可选；缺失时按会话内轮次状态机处理）
    #[serde(default)]
    pub run_id: Option<String>,
    /// 子 Agent 场景下的父轮次 ID（可选）
    #[serde(default)]
    pub parent_run_id: Option<String>,
    /// 任务/轮次标题（元数据，非 Prompt 内容）
    #[serde(default)]
    pub task_title: Option<String>,
    /// idle | running | waiting | completed | failed | disconnected
    pub state: String,
    /// 简短状态说明（可选，≤500 字符；禁止携带 Prompt/代码/密钥）
    #[serde(default)]
    pub message: Option<String>,
    /// 执行结束时列出的待处理事项（可选，≤20 条）
    #[serde(default)]
    pub pending_items: Option<Vec<String>>,
    /// 事件发生时间（ISO8601，可选；缺省用服务端接收时间）
    #[serde(default)]
    pub occurred_at: Option<String>,
    /// 服务端受理序号：仅内部使用，客户端 JSON 不可设置。
    /// 同一轮次内以此为因果顺序，数据库按轮次水位拒绝旧事件覆盖新状态。
    #[serde(skip)]
    pub ingest_seq: Option<u64>,
    /// 传输通道声明（兼容字段）：服务端不信任此值，落库与验证一律按接入入口
    /// 的服务端判定（见 `Transport`）。
    #[serde(default)]
    pub transport: Option<String>,
    /// 证据类型：observed（Agent 事件直报）| process（进程推断）| manual
    #[serde(default)]
    pub evidence_type: Option<String>,
    /// 状态置信度 0.0~1.0（默认 1.0）
    #[serde(default)]
    pub confidence: Option<f64>,
}

const MAX_ID_LEN: usize = 128;
const MAX_TITLE_LEN: usize = 200;
const MAX_MSG_LEN: usize = 500;
/// 单批最多逐条弹出的 OS 通知数；其余合并为一条摘要（数据库仍逐条记录）。
const MAX_PENDING: usize = 20;

fn check_id(v: &str, field: &str) -> AppResult<()> {
    if v.is_empty() || v.len() > MAX_ID_LEN {
        return Err(AppError::Validation(format!("{} 长度不合法", field)));
    }
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '@' | '/'))
    {
        return Err(AppError::Validation(format!("{} 含有非法字符", field)));
    }
    Ok(())
}

fn check_text(v: &str, field: &str, max: usize) -> AppResult<()> {
    if v.chars().count() > max {
        return Err(AppError::Validation(format!("{} 超过 {} 字符", field, max)));
    }
    Ok(())
}

/// 事件校验：返回规范化后的状态与发生时间。
pub fn validate_event(ev: &AgentEvent) -> AppResult<AgentState> {
    let state = AgentState::parse(&ev.state)
        .ok_or_else(|| AppError::Validation(format!("未知状态: {}", ev.state)))?;
    check_id(&ev.source_id, "source_id")?;
    check_id(&ev.session_id, "session_id")?;
    if let Some(r) = &ev.run_id {
        if !r.trim().is_empty() {
            check_id(r, "run_id")?;
        }
    }
    if let Some(i) = &ev.instance_id {
        if !i.trim().is_empty() {
            check_id(i, "instance_id")?;
        }
    }
    if let Some(p) = &ev.parent_run_id {
        if !p.trim().is_empty() {
            check_id(p, "parent_run_id")?;
        }
    }
    if let Some(e) = &ev.event_id {
        check_text(e, "event_id", 128)?;
    }
    if let Some(t) = &ev.task_title {
        check_text(t, "task_title", MAX_TITLE_LEN)?;
    }
    if let Some(m) = &ev.message {
        check_text(m, "message", MAX_MSG_LEN)?;
    }
    if let Some(items) = &ev.pending_items {
        if items.len() > MAX_PENDING {
            return Err(AppError::Validation("pending_items 超过 20 条".into()));
        }
        for it in items {
            check_text(it, "pending_item", MAX_TITLE_LEN)?;
        }
    }
    if let Some(ts) = &ev.occurred_at {
        DateTime::parse_from_rfc3339(ts)
            .map_err(|_| AppError::Validation("occurred_at 不是合法 ISO8601".into()))?;
    }
    Ok(state)
}

/// 单次接入的结果（供测试断言与调用方判断）。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct IngestOutcome {
    pub run_row_id: String,
    pub session_row_id: String,
    pub state: AgentState,
    pub prev_state: Option<AgentState>,
    /// 服务端判定的来源可信分类（真实/自测/压测/模拟/人工）。
    pub origin: EventOrigin,
    /// 重复事件：命中幂等去重，未产生任何状态变化
    pub deduplicated: bool,
    /// 迟到事件：occurred_at 早于轮次结束时间，仅记录、不改终态
    pub late: bool,
    /// 本事务内实际写入的通知（kind, title, body）；提交后由 AgentHub 弹 OS 通知
    pub notification: Option<(String, String, String)>,
}

/// 事件幂等键：Adapter 提供事件 ID 时按 ID；否则按内容签名。
fn dedupe_key(ev: &AgentEvent, state: AgentState, occurred: &str) -> String {
    if let Some(eid) = ev
        .event_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return format!("eid:{}:{}", ev.source_id, eid);
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    let run = ev.run_id.as_deref().map(str::trim).unwrap_or("");
    let inst = ev.instance_id.as_deref().map(str::trim).unwrap_or("");
    (
        &ev.source_id,
        inst,
        &ev.session_id,
        run,
        state.as_str(),
        occurred,
        ev.message.as_deref().unwrap_or(""),
        ev.task_title.as_deref().unwrap_or(""),
        ev.pending_items.as_ref().map(|p| p.len()).unwrap_or(0),
    )
        .hash(&mut hasher);
    format!("sig:{}:{:016x}", ev.source_id, hasher.finish())
}

fn normalize_ts(raw: &str) -> String {
    // 统一为 UTC RFC3339（可比字符串排序）
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| raw.to_string())
}

/// 事务内状态机：不触碰 Tauri，可用任意 rusqlite Connection（含内存库）做集成测试。
/// `transport` 由服务端按接入入口确定；`ev.transport` 的客户端声明仅作兼容读取、不采信。
pub fn ingest_core(
    conn: &Connection,
    ev: &AgentEvent,
    now: &str,
    transport: Transport,
) -> AppResult<IngestOutcome> {
    let state = validate_event(ev)?;
    let occurred = normalize_ts(ev.occurred_at.as_deref().unwrap_or(now));
    // 因果序号：由入口受理时分配；直接调用 ingest_core 的旧路径/测试在此补齐。
    let ingest_seq = ev.ingest_seq.unwrap_or_else(next_ingest_seq) as i64;
    let title = ev.task_title.clone().unwrap_or_default();
    let pending: Vec<String> = ev.pending_items.clone().unwrap_or_default();
    let pending_json = if pending.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&pending)?
    };
    let message = ev.message.clone();
    let run_ext = ev
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let instance_ext = ev
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // 自测会话隔离：verify 管线产生的事件标记为 selftest，不污染真实会话与验证状态
    let selftest = is_selftest_session(&ev.session_id);
    let evidence = if selftest {
        "selftest".to_string()
    } else {
        ev.evidence_type
            .as_deref()
            .unwrap_or("observed")
            .to_string()
    };
    let confidence = ev.confidence.unwrap_or(1.0).clamp(0.0, 1.0);
    let schema_version = ev.schema_version.unwrap_or(1);

    // 1. 来源必须已注册且启用；category 由服务端注册表维护，是可信分类的根。
    let source: Option<(bool, String)> = conn
        .query_row(
            "SELECT enabled, category FROM agent_sources WHERE id = ?1",
            rusqlite::params![ev.source_id],
            |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let (source_enabled, source_category) =
        source.ok_or_else(|| AppError::Agent(format!("未注册的来源: {}", ev.source_id)))?;
    if !source_enabled {
        return Err(AppError::Agent(format!("来源已禁用: {}", ev.source_id)));
    }
    let origin = if source_category == "benchmark" {
        EventOrigin::Benchmark
    } else if source_category == "mock" || transport == Transport::Mock {
        EventOrigin::Mock
    } else if transport == Transport::Manual {
        EventOrigin::Manual
    } else if selftest {
        EventOrigin::Selftest
    } else {
        EventOrigin::Real
    };

    // 2. 事件级幂等：唯一 dedupe_key，重复事件直接短路
    let dkey = dedupe_key(ev, state, &occurred);
    let event_row_id = uuid::Uuid::new_v4().to_string();
    let inserted = conn.execute(
        "INSERT INTO agent_events
           (id, source_id, session_external_id, run_external_id, event_type, state, message, received_at,
            schema_version, event_id, instance_id, parent_run_id, occurred_at, transport, evidence_type, confidence, dedupe_key, ingest_seq, origin)
         VALUES (?1, ?2, ?3, ?4, 'status', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(dedupe_key) DO NOTHING",
        rusqlite::params![
            event_row_id,
            ev.source_id,
            ev.session_id,
            run_ext,
            state.as_str(),
            message,
            now,
            schema_version,
            ev.event_id,
            instance_ext,
            ev.parent_run_id,
            occurred,
            transport.as_str(),
            evidence,
            confidence,
            dkey,
            ingest_seq,
            origin.as_str(),
        ],
    )? > 0;
    if !inserted {
        // 幂等命中：解析既有事件对应的轮次，仅返回（不重复通知、不改状态）
        let prior: Option<(Option<String>, String)> = conn
            .query_row(
                "SELECT run_external_id, session_external_id FROM agent_events WHERE dedupe_key = ?1",
                rusqlite::params![dkey],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let (run_row_id, session_row_id) =
            resolve_prior_run(conn, &ev.source_id, &prior, &run_ext)?;
        return Ok(IngestOutcome {
            run_row_id,
            session_row_id,
            state,
            prev_state: None,
            origin,
            deduplicated: true,
            late: false,
            notification: None,
        });
    }

    // 2.5 来源隔离：同一会话/轮次不允许跨可信分类混写。
    // 例如真实会话 ID 被压测脚本复用，或自测会话伪造真实会话 ID：
    // 事件仍保留流水（供审计），但绝不改变既有真实/测试轮次状态，也不发通知。
    let existing_session_origin: Option<String> = conn
        .query_row(
            "SELECT origin FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
            rusqlite::params![ev.source_id, ev.session_id],
            |r| r.get(0),
        )
        .optional()?;
    let origin_conflict = existing_session_origin
        .as_deref()
        .map(|o| o != origin.as_str())
        .unwrap_or(false);
    if origin_conflict {
        conn.execute(
            "UPDATE agent_sources SET last_event_at = ?1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, ev.source_id],
        )?;
        let run_row_id: Option<String> = if let Some(ext) = &run_ext {
            conn.query_row(
                "SELECT id FROM agent_runs WHERE source_id = ?1 AND external_run_id = ?2",
                rusqlite::params![ev.source_id, ext],
                |r| r.get(0),
            )
            .optional()?
        } else {
            conn.query_row(
                "SELECT last_run_id FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                rusqlite::params![ev.source_id, ev.session_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        };
        return Ok(IngestOutcome {
            run_row_id: run_row_id.unwrap_or_default(),
            session_row_id: String::new(),
            state,
            prev_state: None,
            origin,
            deduplicated: false,
            late: true,
            notification: None,
        });
    }

    // 3. 实例层 upsert（同一 Agent 的多个实例分开记录；自测事件不建实例，防止污染真实实例表）
    let instance_row_id: Option<String> = if let Some(iext) = &instance_ext {
        if selftest {
            None
        } else {
            let iid = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO agent_instances (id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, origin)
                 VALUES (?1, ?2, ?3, ?3, '', ?4, ?4, ?5)
                 ON CONFLICT(source_id, instance_key) DO UPDATE SET last_seen_at = MAX(agent_instances.last_seen_at, excluded.last_seen_at)",
                rusqlite::params![iid, ev.source_id, iext, occurred, origin.as_str()],
            )?;
            conn.query_row(
                "SELECT id FROM agent_instances WHERE source_id = ?1 AND instance_key = ?2",
                rusqlite::params![ev.source_id, iext],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        }
    } else {
        None
    };

    // 4. 会话 upsert（scope = 来源 + 会话外部 ID；不同来源同外部 ID 不冲突）
    let new_session_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, ?7, ?8)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           title = CASE WHEN length(excluded.title) > 0 THEN excluded.title ELSE agent_sessions.title END,
           instance_id = COALESCE(excluded.instance_id, agent_sessions.instance_id)",
        rusqlite::params![
            new_session_id,
            ev.source_id,
            ev.session_id,
            title,
            state.as_str(),
            occurred,
            instance_row_id,
            origin.as_str(),
        ],
    )?;
    let session_row_id: String = conn.query_row(
        "SELECT id FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
        rusqlite::params![ev.source_id, ev.session_id],
        |r| r.get(0),
    )?;

    // 5. 轮次状态机
    struct ExistingRun {
        id: String,
        status: String,
        ended_at: Option<String>,
        last_ingest_seq: i64,
        last_event_at: String,
    }
    let existing: Option<ExistingRun> = if let Some(ext) = &run_ext {
        conn.query_row(
            "SELECT id, status, ended_at, last_ingest_seq, last_event_at FROM agent_runs WHERE source_id = ?1 AND external_run_id = ?2",
            rusqlite::params![ev.source_id, ext],
            |r| Ok(ExistingRun { id: r.get(0)?, status: r.get(1)?, ended_at: r.get(2)?, last_ingest_seq: r.get(3)?, last_event_at: r.get(4)? }),
        )
        .optional()?
    } else {
        conn.query_row(
            "SELECT id, status, ended_at, last_ingest_seq, last_event_at FROM agent_runs WHERE session_id = ?1 AND status IN ('running','waiting','idle')
             ORDER BY updated_at DESC LIMIT 1",
            rusqlite::params![session_row_id],
            |r| Ok(ExistingRun { id: r.get(0)?, status: r.get(1)?, ended_at: r.get(2)?, last_ingest_seq: r.get(3)?, last_event_at: r.get(4)? }),
        )
        .optional()?
        .or_else(|| {
            conn.query_row(
                "SELECT id, status, ended_at, last_ingest_seq, last_event_at FROM agent_runs WHERE session_id = ?1
                 ORDER BY updated_at DESC LIMIT 1",
                rusqlite::params![session_row_id],
                |r| Ok(ExistingRun { id: r.get(0)?, status: r.get(1)?, ended_at: r.get(2)?, last_ingest_seq: r.get(3)?, last_event_at: r.get(4)? }),
            )
            .optional()
            .unwrap_or(None)
        })
    };

    // 因果顺序屏障（受理序号）：该轮次已经应用过更大的受理序号时，本次只记录
    // 事件流水，不改变轮次/会话状态、不发通知。适用于合并缓冲、批处理、跨通道交错。
    let ordered_late = existing
        .as_ref()
        .map(|r| r.last_ingest_seq > 0 && ingest_seq <= r.last_ingest_seq)
        .unwrap_or(false);

    // 因果顺序屏障（事件时间）：文件积压/离线恢复会把很旧的事件排在新事件之后受理，
    // 此时序号更新但事件时间更旧；只入流水，不回退状态。终态后确实更新的事件时间
    // 仍允许开启新一轮，避免误杀重连。时间无法解析时不启用该屏障（只用序号）。
    let prev_terminal = existing
        .as_ref()
        .and_then(|r| AgentState::parse(&r.status))
        .map(|s| s.is_terminal())
        .unwrap_or(false);
    let opens_new_round = prev_terminal
        && !state.is_terminal()
        && existing
            .as_ref()
            .and_then(|r| r.ended_at.as_deref())
            .map(|e| occurred.as_str() > e)
            .unwrap_or(true);
    let time_late = existing
        .as_ref()
        .filter(|r| !r.last_event_at.is_empty())
        .filter(|_| !opens_new_round)
        .and_then(|r| {
            match (
                DateTime::parse_from_rfc3339(&r.last_event_at),
                DateTime::parse_from_rfc3339(&occurred),
            ) {
                (Ok(prev), Ok(cur)) => Some(cur < prev),
                _ => None,
            }
        })
        .unwrap_or(false);
    let stale = ordered_late || time_late;

    let mut prev_state: Option<AgentState> = None;
    let mut late = stale;
    let run_row_id: String = match existing {
        Some(run) => {
            let prev = AgentState::parse(&run.status);
            prev_state = prev;
            if stale {
                run.id
            } else {
                let prev_terminal = prev.map(|p| p.is_terminal()).unwrap_or(false);
                let is_new_round = prev_terminal
                    && !state.is_terminal()
                    && run
                        .ended_at
                        .as_deref()
                        .map(|e| occurred.as_str() > e)
                        .unwrap_or(true);
                if prev_terminal && !state.is_terminal() && !is_new_round {
                    // 乱序保护：终态后的迟到活跃事件（如 completed 之后到达的旧 running）
                    // 只记录事件，绝不让已结束的轮次复活。
                    late = true;
                    run.id
                } else if is_new_round {
                    // 终态后重连/新一轮：携带同一 external_run_id 时唯一索引
                    // idx_runs_external(source_id, external_run_id) 禁止开第二行，
                    // 必须重开原轮次（状态回活跃、ended_at 清空）。
                    if run_ext.is_some() {
                        conn.execute(
                            "UPDATE agent_runs SET
                           status = ?1,
                           updated_at = MAX(updated_at, ?2),
                           ended_at = NULL,
                           pending_items = CASE WHEN length(?3) > 2 THEN ?3 ELSE pending_items END,
                           task_title = CASE WHEN length(?4) > 0 THEN ?4 ELSE task_title END,
                           instance_id = COALESCE(?5, instance_id),
                           parent_run_id = COALESCE(?6, parent_run_id)
                         WHERE id = ?7",
                            rusqlite::params![
                                state.as_str(),
                                occurred,
                                pending_json,
                                title,
                                instance_row_id,
                                ev.parent_run_id.as_deref().filter(|s| !s.trim().is_empty()),
                                run.id,
                            ],
                        )?;
                        run.id
                    } else {
                        // 无 run_id 的会话新一轮执行：旧轮次保持终态，新开一个轮次
                        insert_new_run(
                            conn,
                            &ev.source_id,
                            &session_row_id,
                            instance_row_id.as_deref(),
                            run_ext.as_deref(),
                            ev.parent_run_id.as_deref().filter(|s| !s.trim().is_empty()),
                            &title,
                            state,
                            &occurred,
                            &pending_json,
                            ingest_seq,
                            origin,
                        )?
                    }
                } else {
                    // 常规更新（含终态间修正，如 completed 修正为 failed；ended_at 保留首个）
                    conn.execute(
                        "UPDATE agent_runs SET
                       status = ?1,
                       updated_at = MAX(updated_at, ?2),
                       ended_at = CASE WHEN ?3 THEN COALESCE(ended_at, ?2) ELSE ended_at END,
                       pending_items = CASE WHEN length(?4) > 2 THEN ?4 ELSE pending_items END,
                       task_title = CASE WHEN length(?5) > 0 THEN ?5 ELSE task_title END,
                       instance_id = COALESCE(?6, instance_id),
                       parent_run_id = COALESCE(?7, parent_run_id)
                     WHERE id = ?8",
                        rusqlite::params![
                            state.as_str(),
                            occurred,
                            state.is_terminal(),
                            pending_json,
                            title,
                            instance_row_id,
                            ev.parent_run_id.as_deref().filter(|s| !s.trim().is_empty()),
                            run.id,
                        ],
                    )?;
                    run.id
                }
            }
        }
        None => insert_new_run(
            conn,
            &ev.source_id,
            &session_row_id,
            instance_row_id.as_deref(),
            run_ext.as_deref(),
            ev.parent_run_id.as_deref().filter(|s| !s.trim().is_empty()),
            &title,
            state,
            &occurred,
            &pending_json,
            ingest_seq,
            origin,
        )?,
    };

    // 6. 水位：受理序号无论是否应用状态都推进；事件时间只向前推进。
    //    旧序号/旧时间事件（合并缓冲/文件积压/跨通道迟到）因此无法覆盖新状态。
    conn.execute(
        "UPDATE agent_runs SET
           last_ingest_seq = MAX(last_ingest_seq, ?1),
           last_event_at = CASE WHEN length(?2) > 0 AND ?2 > last_event_at THEN ?2 ELSE last_event_at END
         WHERE id = ?3",
        rusqlite::params![ingest_seq, occurred, run_row_id],
    )?;

    // 7. 会话指针更新（迟到事件不改变会话状态/指针；时间戳只向前）
    if !late {
        conn.execute(
            "UPDATE agent_sessions SET last_run_id = ?1, status = ?2, last_seen_at = MAX(last_seen_at, ?3) WHERE id = ?4",
            rusqlite::params![run_row_id, state.as_str(), occurred, session_row_id],
        )?;
    }

    // 8. 补齐事件行的轮次外部 ID
    if run_ext.is_some() {
        conn.execute(
            "UPDATE agent_events SET run_external_id = ?1 WHERE id = ?2",
            rusqlite::params![run_ext, event_row_id],
        )?;
    }

    // 8. 来源健康分层（v3 + v12）：
    //    - event_received：任何事件都记录（流水 + last_event_at）；
    //    - transport_verified：真实通道打通（自测事件即可证明通道，Mock/Manual/压测永不）；
    //    - verified（natural_session_verified）：真实来源 + 真实通道 + 非自测会话 才置位。
    match origin {
        EventOrigin::Real => {
            conn.execute(
                "UPDATE agent_sources SET verified = 1, transport_verified = 1, last_event_at = ?1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, ev.source_id],
            )?;
        }
        EventOrigin::Selftest if transport.is_real() => {
            conn.execute(
                "UPDATE agent_sources SET transport_verified = 1, last_event_at = ?1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, ev.source_id],
            )?;
        }
        _ => {
            conn.execute(
                "UPDATE agent_sources SET last_event_at = ?1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, ev.source_id],
            )?;
        }
    }

    // 9. 状态跃迁通知（事务内写通知记录；Agent 执行结束 ≠ 关联任务完成，仅通知、不改任务状态）
    //    只有真实事件可以产生通知：自测/压测/模拟/人工事件即使状态跃迁也不进入收件箱。
    let mut notification = None;
    let changed = prev_state.map(|p| p != state).unwrap_or(true);
    if origin.is_real()
        && !late
        && changed
        && matches!(
            state,
            AgentState::Waiting | AgentState::Completed | AgentState::Failed
        )
    {
        let (kind, title_cn) = match state {
            AgentState::Waiting => ("agent_waiting", "Agent 等待处理"),
            AgentState::Completed => ("agent_done", "Agent 本轮执行完成"),
            _ => ("agent_failed", "Agent 执行失败"),
        };
        let source_name: String = conn
            .query_row(
                "SELECT display_name FROM agent_sources WHERE id = ?1",
                rusqlite::params![ev.source_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| ev.source_id.clone());
        let body = if title.is_empty() {
            format!("{} · 会话 {}", source_name, ev.session_id)
        } else {
            format!("{} · {}", source_name, title)
        };
        // 同一轮次同一状态只通知一次（occurrence 幂等）
        let occurrence = format!("{}:{}", run_row_id, state.as_str());
        let n = conn.execute(
            "INSERT OR IGNORE INTO notification_history
               (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin)
             VALUES (?1, ?2, ?3, ?4, 'agent_run', ?5, ?6, 0, ?7, 'real')",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                kind,
                title_cn,
                body,
                run_row_id,
                occurrence,
                now,
            ],
        )?;
        if n > 0 {
            notification = Some((kind.to_string(), title_cn.to_string(), body));
        }
    }

    Ok(IngestOutcome {
        run_row_id,
        session_row_id,
        state,
        prev_state,
        origin,
        deduplicated: false,
        late,
        notification,
    })
}

#[allow(clippy::too_many_arguments)]
fn insert_new_run(
    conn: &Connection,
    source_id: &str,
    session_row_id: &str,
    instance_id: Option<&str>,
    run_ext: Option<&str>,
    parent_run_id: Option<&str>,
    title: &str,
    state: AgentState,
    occurred: &str,
    pending_json: &str,
    ingest_seq: i64,
    origin: EventOrigin,
) -> AppResult<String> {
    let rid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO agent_runs
           (id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id, last_ingest_seq, last_event_at, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, CASE WHEN ?8 THEN ?7 ELSE NULL END, ?9, '{}', ?10, ?11, ?12, ?7, ?13)",
        rusqlite::params![
            rid,
            session_row_id,
            source_id,
            run_ext,
            title,
            state.as_str(),
            occurred,
            state.is_terminal(),
            pending_json,
            instance_id,
            parent_run_id,
            ingest_seq,
            origin.as_str(),
        ],
    )?;
    Ok(rid)
}

/// 幂等命中时解析既有事件归属的轮次（仅用于返回值，不改变任何状态）。
fn resolve_prior_run(
    conn: &Connection,
    source_id: &str,
    prior: &Option<(Option<String>, String)>,
    run_ext: &Option<String>,
) -> AppResult<(String, String)> {
    if let Some((Some(r), sess)) = prior {
        if let Some(rid) = conn
            .query_row(
                "SELECT id FROM agent_runs WHERE source_id = ?1 AND external_run_id = ?2",
                rusqlite::params![source_id, r],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if let Some(sid) = conn
                .query_row(
                    "SELECT id FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                    rusqlite::params![source_id, sess],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                return Ok((rid, sid));
            }
            return Ok((rid, String::new()));
        }
    }
    if let Some(r) = run_ext {
        if let Some(rid) = conn
            .query_row(
                "SELECT id FROM agent_runs WHERE source_id = ?1 AND external_run_id = ?2",
                rusqlite::params![source_id, r],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok((rid, String::new()));
        }
    }
    Ok((String::new(), String::new()))
}

/// 心跳失联判定（事务内核心）：超过阈值的活跃轮次 → disconnected + 断连通知（每轮次一次）。
pub fn cleanup_stale_core(
    conn: &Connection,
    stale_minutes: i64,
) -> AppResult<Vec<(String, String)>> {
    let now = Utc::now();
    let cutoff = (now - Duration::minutes(stale_minutes.max(1))).to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    let stale: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, source_id FROM agent_runs
             WHERE origin = 'real' AND status IN ('running','waiting') AND updated_at < ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !stale.is_empty() {
        tx.execute(
            "UPDATE agent_runs SET status = 'disconnected', updated_at = ?1
             WHERE origin = 'real' AND status IN ('running','waiting') AND updated_at < ?2",
            rusqlite::params![now.to_rfc3339(), cutoff],
        )?;
        for (run_id, source_id) in &stale {
            let name: String = tx
                .query_row(
                    "SELECT display_name FROM agent_sources WHERE id = ?1",
                    rusqlite::params![source_id],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| source_id.clone());
            let occurrence = format!("{}:disconnect", run_id);
            tx.execute(
                "INSERT OR IGNORE INTO notification_history
                   (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
                 VALUES (?1, 'agent_disconnected', 'Agent 连接中断', ?2, 'agent_run', ?3, ?4, 0, ?5)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    format!("{} · 超过 {} 分钟无心跳，标记为断开（不推断任务成败）", name, stale_minutes),
                    run_id,
                    occurrence,
                    now.to_rfc3339(),
                ],
            )?;
        }
    }
    // 同步会话状态：没有活跃轮次的真实会话回到 idle（测试来源不参与真实状态）
    tx.execute(
        "UPDATE agent_sessions SET status = 'idle' WHERE origin = 'real' AND status IN ('running','waiting')
         AND id NOT IN (SELECT session_id FROM agent_runs WHERE origin = 'real' AND status IN ('running','waiting'))",
        [],
    )?;
    tx.commit()?;
    Ok(stale)
}

/// 前端快照。
#[derive(Debug, Clone, Serialize)]
pub struct AgentSnapshot {
    pub sources: Vec<AgentSource>,
    pub instances: Vec<AgentInstance>,
    pub sessions: Vec<AgentSession>,
    pub runs: Vec<AgentRun>,
}

/// 事件总线：Adapter 与 UI 之间的唯一通道。
pub struct AgentHub {
    app: AppHandle,
    db: Arc<Db>,
    /// 跨批次 OS 通知限流/合并状态（静音时不消耗额度）。
    notify_gate: std::sync::Mutex<NotifyGate>,
}

impl AgentHub {
    pub fn new(app: AppHandle, db: Arc<Db>) -> Self {
        Self {
            app,
            db,
            notify_gate: std::sync::Mutex::new(NotifyGate::new()),
        }
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn db_arc(&self) -> Arc<Db> {
        self.db.clone()
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// 接入一个事件：单一事务（会话/轮次/事件/通知记录一起提交或一起回滚）。
    /// transport 由调用方（Adapter）按接入入口确定，客户端声明不采信。
    /// 注意：高吞吐入口（HTTP/文件/插件）统一走 `pipeline::IngestPipeline`，
    /// 本方法保留给低频率调试/模拟路径。
    pub fn ingest(&self, ev: &AgentEvent, transport: Transport) -> AppResult<String> {
        let outcomes = self.commit_events(&[(ev.clone(), transport)])?;
        let run_row_id = outcomes
            .first()
            .map(|o| o.run_row_id.clone())
            .unwrap_or_default();
        self.after_batch(std::slice::from_ref(ev), &outcomes);
        Ok(run_row_id)
    }

    /// 批量接入：所有事件在同一个事务内处理，任一失败整体回滚（全成功/全失败）。
    /// 返回实际写入的事件结果；Err 表示一个都没写入。
    pub fn ingest_batch(
        &self,
        events: &[AgentEvent],
        transport: Transport,
    ) -> AppResult<Vec<IngestOutcome>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let items: Vec<(AgentEvent, Transport)> =
            events.iter().cloned().map(|e| (e, transport)).collect();
        let outcomes = self.commit_events(&items)?;
        self.after_batch(events, &outcomes);
        Ok(outcomes)
    }

    /// 只写库、不产生任何 UI/托盘/OS 副作用（供接入管线批量调用）。
    /// 每个事件可带不同 transport（同一批可混合 HTTP/文件来源）。
    pub(crate) fn commit_events(
        &self,
        items: &[(AgentEvent, Transport)],
    ) -> AppResult<Vec<IngestOutcome>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_iso();
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut outs = Vec::with_capacity(items.len());
            for (ev, transport) in items {
                outs.push(ingest_core(&tx, ev, &now, *transport)?);
            }
            tx.commit()?;
            Ok::<_, AppError>(outs)
        })
    }

    /// 提交后的副作用：OS 通知（聚合）+ 一次广播 + 一次托盘刷新（绝不放进事务）。
    /// 批量事件不再逐条广播/逐条查托盘，避免 100 事件 → 100 次快照请求/4×100 次查询。
    pub(crate) fn after_batch(&self, events: &[AgentEvent], outcomes: &[IngestOutcome]) {
        if outcomes.is_empty() {
            return;
        }
        let has_notification = outcomes.iter().any(|o| o.notification.is_some());
        if has_notification {
            let items: Vec<NotifyItem> = outcomes
                .iter()
                .filter_map(|o| o.notification.as_ref())
                .map(|(kind, title, body)| NotifyItem::new(kind, title, body))
                .collect();
            self.notify_agent_popups(&items);
        }
        if has_notification {
            let _ = self.app.emit("notification", ());
        }

        let changed = outcomes.iter().any(|o| !o.deduplicated);
        let late = outcomes.iter().any(|o| o.late);
        let mut states = serde_json::Map::new();
        for o in outcomes {
            let key = o.state.as_str();
            let n = states.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
            states.insert(key.to_string(), serde_json::json!(n + 1));
        }
        let mut sources: Vec<&str> = Vec::new();
        for ev in events {
            if !sources.contains(&ev.source_id.as_str()) {
                sources.push(ev.source_id.as_str());
            }
        }
        let last = outcomes.last();
        let _ = self.app.emit(
            "agent-changed",
            serde_json::json!({
                "source_id": events.last().map(|e| e.source_id.as_str()).unwrap_or(""),
                "sources": sources,
                "session_id": events.last().map(|e| e.session_id.as_str()).unwrap_or(""),
                "run_id": last.map(|o| o.run_row_id.clone()),
                "state": last.map(|o| o.state.as_str()),
                "states": states,
                "batch": outcomes.len(),
                "changed": changed,
                "deduplicated": !changed,
                "late": late,
            }),
        );
        if changed {
            self.update_tray();
        }
    }

    /// OS 通知（调用方已按设置过滤）。
    fn show_os_notification(&self, title: &str, body: &str) {
        use tauri_plugin_notification::NotificationExt;
        NOTIFY_ATTEMPTED.fetch_add(1, Ordering::Relaxed);
        match self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            Ok(()) => {
                NOTIFY_SUCCEEDED.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                NOTIFY_FAILED.fetch_add(1, Ordering::Relaxed);
                tracing::debug!("OS 通知发送失败（不影响事件落库）: {}", e);
            }
        }
    }

    #[allow(dead_code)]
    fn source_display_name(&self, id: &str) -> String {
        self.db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT display_name FROM agent_sources WHERE id = ?1",
                    rusqlite::params![id],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(AppError::from)
            })
            .ok()
            .flatten()
            .unwrap_or_else(|| id.to_string())
    }

    /// OS 通知（设置开关 + 免打扰过滤；仅数据库已提交后调用）。
    fn show_notification(&self, kind: &str, title: &str, body: &str) {
        let settings = crate::db::Settings::load(&self.db).unwrap_or_default();
        let allowed = match kind {
            "reminder" => settings.notify_reminder,
            _ => settings.notify_agent,
        };
        if allowed && !settings.notify_muted {
            self.show_os_notification(title, body);
        }
        let _ = self.app.emit("notification", ());
    }

    /// 调度器周期调用：窗口结束后补发被抑制通知的汇总摘要。
    /// 静音/关闭时不消耗额度，也不弹摘要。
    pub fn flush_notification_digest(&self) {
        let settings = crate::db::Settings::load(&self.db).unwrap_or_default();
        if settings.notify_muted || (!settings.notify_agent && !settings.notify_reminder) {
            return;
        }
        let policy = NotificationPolicy::from_settings(&settings);
        let popup = self
            .notify_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .flush(std::time::Instant::now(), &policy);
        if let Some(p) = popup {
            self.show_os_notification(&p.title, &p.body);
        }
    }

    /// Agent 状态通知弹窗：跨批次共用同一窗口额度（等待/失败优先，完成合并）。
    /// 静音或关闭 Agent 通知时不消耗额度。
    pub fn notify_agent_popups(&self, items: &[NotifyItem]) -> usize {
        let settings = crate::db::Settings::load(&self.db).unwrap_or_default();
        if !settings.notify_agent || settings.notify_muted {
            return 0;
        }
        self.plan_popups(items, &settings)
    }

    /// 任务提醒弹窗：与 Agent 通知共用同一窗口额度，
    /// 避免一批到期提醒在同一秒内刷屏（通知历史仍逐条落库）。
    pub fn notify_reminder_popups(&self, items: &[NotifyItem]) -> usize {
        let settings = crate::db::Settings::load(&self.db).unwrap_or_default();
        if !settings.notify_reminder || settings.notify_muted {
            return 0;
        }
        self.plan_popups(items, &settings)
    }

    fn plan_popups(&self, items: &[NotifyItem], settings: &crate::db::Settings) -> usize {
        if items.is_empty() {
            return 0;
        }
        let policy = NotificationPolicy::from_settings(settings);
        let popups = self
            .notify_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .plan(std::time::Instant::now(), &policy, items);
        let shown = popups.len();
        for p in popups {
            self.show_os_notification(&p.title, &p.body);
        }
        shown
    }

    /// 写通知历史（带去重）；返回是否实际写入（供非 ingest 场景，如提醒调度）。
    #[allow(dead_code)]
    pub fn push_notification(
        &self,
        kind: &str,
        title: &str,
        body: &str,
        ref_type: Option<&str>,
        ref_id: Option<&str>,
        occurrence: Option<&str>,
    ) -> bool {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let inserted = self
            .db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO notification_history
                       (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
                    rusqlite::params![id, kind, title, body, ref_type, ref_id, occurrence, now],
                )
                .map(|n| n > 0)
                .map_err(AppError::from)
            })
            .unwrap_or(false);
        if inserted {
            self.show_notification(kind, title, body);
        }
        inserted
    }

    /// 过期状态清理：长时间无更新的活跃轮次标记为 disconnected（不推断任务成败）。
    pub fn cleanup_stale(&self) -> AppResult<usize> {
        let settings = crate::db::Settings::load(&self.db).unwrap_or_default();
        let stale_minutes = settings.stale_run_minutes.max(1) as i64;
        let stale = self
            .db
            .with_conn(|conn| cleanup_stale_core(conn, stale_minutes))?;
        let notified = stale;
        if !notified.is_empty() {
            self.notify_agent_popups(&[NotifyItem::new(
                "agent_disconnected",
                "Agent 连接中断",
                &format!(
                    "{} 个 Agent 轮次长时间无心跳，已标记为断开（不推断任务成败）",
                    notified.len()
                ),
            )]);
            let _ = self.app.emit(
                "agent-changed",
                serde_json::json!({ "stale_cleanup": notified.len() }),
            );
            self.update_tray();
        }
        Ok(notified.len())
    }

    /// 异常重启恢复：Task Dock 重启时，把重启前遗留的活跃轮次按失联规则归位。
    /// （重启期间 Agent 可能已停止；未超阈值的不动，等待后续事件或 stale 清理。）
    pub fn recover_after_restart(&self) -> AppResult<usize> {
        self.cleanup_stale()
    }

    pub fn snapshot(&self) -> AppResult<AgentSnapshot> {
        snapshot_query(&self.db)
    }

    /// 当前最需要关注的 Agent 状态（托盘图标用）。
    pub fn worst_state(&self) -> AgentState {
        worst_state_query(&self.db)
    }
}

/// 单个只读快照：四张表在同一个读事务内取，避免与写入并发时的跨表不一致，
/// 且只占用读连接池，不与事件批量写入争抢唯一写锁。
pub(crate) fn snapshot_query(db: &Db) -> AppResult<AgentSnapshot> {
    db.with_read(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut stmt = tx.prepare(
            "SELECT id, display_name, kind, enabled, verified, homepage, note, config, created_at, updated_at
             FROM agent_sources WHERE hidden = 0 ORDER BY id",
        )?;
            let sources = stmt
                .query_map([], |r| {
                    Ok(AgentSource {
                        id: r.get(0)?,
                        display_name: r.get(1)?,
                        kind: r.get(2)?,
                        enabled: r.get::<_, i64>(3)? != 0,
                        verified: r.get::<_, i64>(4)? != 0,
                        homepage: r.get(5)?,
                        note: r.get(6)?,
                        config: serde_json::from_str(&r.get::<_, String>(7)?)
                            .unwrap_or(serde_json::Value::Null),
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut stmt = tx.prepare(
                "SELECT id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at
                 FROM agent_instances WHERE origin = 'real' ORDER BY last_seen_at DESC LIMIT 200",
            )?;
            let instances = stmt
                .query_map([], |r| {
                    Ok(AgentInstance {
                        id: r.get(0)?,
                        source_id: r.get(1)?,
                        instance_key: r.get(2)?,
                        display_name: r.get(3)?,
                        exe_path: r.get(4)?,
                        first_seen_at: r.get(5)?,
                        last_seen_at: r.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut stmt = tx.prepare(
                "SELECT id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id FROM agent_sessions WHERE origin = 'real' ORDER BY last_seen_at DESC LIMIT 200",
            )?;
            let sessions = stmt
                .query_map([], |r| {
                    Ok(AgentSession {
                        id: r.get(0)?,
                        source_id: r.get(1)?,
                        external_id: r.get(2)?,
                        title: r.get(3)?,
                        status: r.get(4)?,
                        first_seen_at: r.get(5)?,
                        last_seen_at: r.get(6)?,
                        last_run_id: r.get(7)?,
                        instance_id: r.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut stmt = tx.prepare(
                "SELECT id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, instance_id
                 FROM agent_runs WHERE origin = 'real' ORDER BY updated_at DESC LIMIT 300",
            )?;
            let runs = stmt
                .query_map([], |r| {
                    Ok(AgentRun {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        source_id: r.get(2)?,
                        external_run_id: r.get(3)?,
                        task_title: r.get(4)?,
                        status: r.get(5)?,
                        started_at: r.get(6)?,
                        updated_at: r.get(7)?,
                        ended_at: r.get(8)?,
                        pending_items: serde_json::from_str(&r.get::<_, String>(9)?)
                            .unwrap_or_default(),
                        instance_id: r.get(10)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            tx.commit()?;
            Ok(AgentSnapshot {
                sources,
                instances,
                sessions,
                runs,
            })
        })
}

/// 当前最需要关注的 Agent 状态（托盘图标用）；只统计真实来源。
pub(crate) fn worst_state_query(db: &Db) -> AgentState {
    let states: Vec<String> = db
        .with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT status FROM agent_runs
                 WHERE origin = 'real' AND status IN ('running','waiting','completed','failed')
                   AND updated_at > ?1",
            )?;
            let cutoff = (Utc::now() - Duration::seconds(120)).to_rfc3339();
            let rows = stmt.query_map(rusqlite::params![cutoff], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })
        .unwrap_or_default();
    let mut worst = AgentState::Idle;
    for s in states {
        if let Some(st) = AgentState::parse(&s) {
            if st.priority() > worst.priority() {
                worst = st;
            }
        }
    }
    worst
}

impl AgentHub {
    /// 更新托盘图标与提示（由 lib.rs 提供的回调实现）。
    pub fn update_tray(&self) {
        crate::refresh_tray(self.app(), self.worst_state());
    }
}

/// 会话 ID 白名单校验（用于跳转命令等场景，防注入）。
pub fn validate_session_id(v: &str) -> AppResult<()> {
    if v.is_empty() || v.len() > MAX_ID_LEN {
        return Err(AppError::Validation("session_id 长度不合法".into()));
    }
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return Err(AppError::Validation("session_id 含有非法字符".into()));
    }
    Ok(())
}

/// Adapter 统一接口：只负责产生事件，不接触 UI 与存储细节。
pub trait AgentAdapter: Send + 'static {
    #[allow(dead_code)]
    fn id(&self) -> &'static str;
    fn spawn(self: Box<Self>, hub: Arc<AgentHub>) -> tauri::async_runtime::JoinHandle<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().expect("内存库")
    }

    fn ingest(db: &Db, ev: &AgentEvent, now: &str) -> AppResult<IngestOutcome> {
        ingest_with(db, ev, now, Transport::Http)
    }

    fn ingest_with(
        db: &Db,
        ev: &AgentEvent,
        now: &str,
        transport: Transport,
    ) -> AppResult<IngestOutcome> {
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let out = ingest_core(&tx, ev, now, transport)?;
            tx.commit()?;
            Ok::<_, AppError>(out)
        })
    }

    fn ingest_batch_core(
        db: &Db,
        events: &[AgentEvent],
        transport: Transport,
    ) -> AppResult<Vec<IngestOutcome>> {
        let now = "2026-10-25T10:00:00+00:00";
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut outs = Vec::with_capacity(events.len());
            for ev in events {
                outs.push(ingest_core(&tx, ev, now, transport)?);
            }
            tx.commit()?;
            Ok::<_, AppError>(outs)
        })
    }

    fn cell<P: rusqlite::Params>(db: &Db, sql: &str, params: P) -> String {
        db.with_conn(|conn| {
            conn.query_row(sql, params, |r| r.get::<_, String>(0))
                .map_err(AppError::from)
        })
        .unwrap()
    }

    fn count(db: &Db, sql: &str) -> i64 {
        db.with_conn(|conn| {
            conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                .map_err(AppError::from)
        })
        .unwrap()
    }

    fn ev(source: &str, session: &str, run: Option<&str>, state: &str) -> AgentEvent {
        AgentEvent {
            source_id: source.into(),
            session_id: session.into(),
            run_id: run.map(|s| s.to_string()),
            state: state.into(),
            transport: Some("http".into()),
            ..Default::default()
        }
    }

    #[test]
    fn terminal_state_is_protected_from_late_running() {
        let db = memdb();
        ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let done = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "completed"),
            "2026-10-25T10:05:00+00:00",
        )
        .unwrap();
        assert_eq!(done.state, AgentState::Completed);
        // 旧的 running 事件（occurred_at 早于结束时间）不得复活轮次
        let late = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:02:00+00:00",
        )
        .unwrap();
        assert!(late.late);
        let status = cell(
            &db,
            "SELECT status FROM agent_runs WHERE id = ?1",
            rusqlite::params![&done.run_row_id],
        );
        assert_eq!(status, "completed");
    }

    #[test]
    fn duplicate_event_is_idempotent() {
        let db = memdb();
        let e = ev("codex", "s1", Some("r1"), "running");
        let first = ingest(&db, &e, "2026-10-25T10:00:00+00:00").unwrap();
        let second = ingest(&db, &e, "2026-10-25T10:00:00+00:00").unwrap();
        assert!(!first.deduplicated);
        assert!(second.deduplicated);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_events"),
            1,
            "重复事件只留一条流水"
        );
    }

    #[test]
    fn missing_run_id_creates_separate_runs_without_conflict() {
        let db = memdb();
        // 两个会话都不带 run_id：P0 缺陷场景（v0.1 空字符串撞唯一索引）
        let a = ingest(
            &db,
            &ev("codex", "sA", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let b = ingest(
            &db,
            &ev("codex", "sB", None, "running"),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        assert_ne!(a.run_row_id, b.run_row_id);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_runs WHERE external_run_id IS NULL"
            ),
            2
        );
    }

    #[test]
    fn same_session_multiple_rounds() {
        let db = memdb();
        ingest(
            &db,
            &ev("codex", "s1", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let r1 = ingest(
            &db,
            &ev("codex", "s1", None, "completed"),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();
        // 会话恢复：completed 之后新的 running（发生时间更晚）→ 新一轮次
        let r2 = ingest(
            &db,
            &ev("codex", "s1", None, "running"),
            "2026-10-25T10:10:00+00:00",
        )
        .unwrap();
        assert_ne!(r1.run_row_id, r2.run_row_id, "多轮任务应开新轮次");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'completed'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'running'"
            ),
            1
        );
    }

    #[test]
    fn same_external_session_id_different_sources_never_merge() {
        let db = memdb();
        let a = ingest(
            &db,
            &ev("codex", "same-id", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let b = ingest(
            &db,
            &ev("trae", "same-id", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        assert_ne!(a.session_row_id, b.session_row_id);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_sessions"), 2);
    }

    #[test]
    fn disabled_or_unknown_source_rejected() {
        let db = memdb();
        let err = ingest(
            &db,
            &ev("nope", "s", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap_err();
        assert!(err.to_string().contains("未注册"));
        db.with_conn(|c| {
            c.execute(
                "UPDATE agent_sources SET enabled = 0 WHERE id = 'codex'",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let err = ingest(
            &db,
            &ev("codex", "s", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap_err();
        assert!(err.to_string().contains("禁用"));
    }

    #[test]
    fn notification_dedupe_across_duplicate_states() {
        let db = memdb();
        let a = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        assert!(a.notification.is_none(), "running 不通知");
        let w1 = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "waiting"),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();
        assert!(w1.notification.is_some(), "进入 waiting 通知");
        // running → waiting 再次发生：同轮次同状态只通知一次
        ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:02:00+00:00",
        )
        .unwrap();
        let w2 = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "waiting"),
            "2026-10-25T10:03:00+00:00",
        )
        .unwrap();
        assert!(w2.notification.is_none(), "重复 waiting 去重");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM notification_history WHERE kind = 'agent_waiting'"
            ),
            1
        );
    }

    #[test]
    fn mock_transport_never_verifies_source() {
        let db = memdb();
        let e = ev("mock", "s1", None, "running");
        ingest_with(&db, &e, "2026-10-25T10:00:00+00:00", Transport::Mock).unwrap();
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) FROM agent_sources WHERE id = 'mock'",
                rusqlite::params![]
            ),
            "0",
            "模拟事件不得置 verified"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(transport_verified AS TEXT) FROM agent_sources WHERE id = 'mock'",
                rusqlite::params![]
            ),
            "0",
            "模拟事件不得置 transport_verified"
        );
    }

    #[test]
    fn manual_transport_never_verifies_source() {
        let db = memdb();
        let e = ev("codex", "s-manual", None, "running");
        ingest_with(&db, &e, "2026-10-25T10:00:00+00:00", Transport::Manual).unwrap();
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "0",
            "人工/调试上报不得置 verified"
        );
    }

    #[test]
    fn selftest_events_isolated_from_real_sessions_and_verification() {
        let db = memdb();
        let e = ev("codex", "taskdock-selftest-codex", None, "running");
        ingest(&db, &e, "2026-10-25T10:00:00+00:00").unwrap();
        // 自测事件证明通道可用，但不作为真实会话证据
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "0",
            "自测事件不得置 verified"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(transport_verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "1",
            "自测事件可证明通道打通"
        );
        assert_eq!(cell(&db, "SELECT evidence_type FROM agent_events WHERE session_external_id = 'taskdock-selftest-codex'", rusqlite::params![]), "selftest");
        // 自测事件不建实例，不污染真实实例表
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_instances"), 0);
        // 随后真实会话事件仍可正常置位
        ingest(
            &db,
            &ev("codex", "real-sess", None, "running"),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "1"
        );
    }

    #[test]
    fn benchmark_source_is_fully_isolated() {
        let db = memdb();
        let mut e = ev(
            "bench",
            "http-perf-t1-session-0",
            Some("http-perf-t1-run-0-0"),
            "waiting",
        );
        e.instance_id = Some("http-instance-0".into());
        let out = ingest(&db, &e, "2026-10-25T10:00:00+00:00").unwrap();
        assert_eq!(out.origin, EventOrigin::Benchmark);
        assert!(out.notification.is_none(), "压测事件不得产生通知");
        assert_eq!(
            cell(
                &db,
                "SELECT origin FROM agent_events WHERE session_external_id = 'http-perf-t1-session-0'",
                rusqlite::params![]
            ),
            "benchmark"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT origin FROM agent_sessions WHERE external_id = 'http-perf-t1-session-0'",
                rusqlite::params![]
            ),
            "benchmark"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT origin FROM agent_runs WHERE id = ?1",
                rusqlite::params![&out.run_row_id]
            ),
            "benchmark"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT origin FROM agent_instances WHERE instance_key = 'http-instance-0'",
                rusqlite::params![]
            ),
            "benchmark"
        );
        // 来源健康：压测来源不置 verified / transport_verified
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) || '/' || CAST(transport_verified AS TEXT)
                 FROM agent_sources WHERE id = 'bench'",
                rusqlite::params![]
            ),
            "0/0"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM notification_history"), 0);
        // 快照与托盘状态只含真实数据
        let snap = snapshot_query(&db).unwrap();
        assert!(snap.instances.is_empty());
        assert!(snap.sessions.is_empty());
        assert!(snap.runs.is_empty());
        assert_eq!(worst_state_query(&db), AgentState::Idle);
        // 失联清理不会把压测轮次标记断开，也不会生成断连通知
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_runs SET updated_at = '2000-01-01T00:00:00+00:00' WHERE id = ?1",
                rusqlite::params![&out.run_row_id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let stale = db.with_conn(|conn| cleanup_stale_core(conn, 1)).unwrap();
        assert!(stale.is_empty(), "压测轮次不参与失联判定");
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&out.run_row_id]
            ),
            "waiting"
        );
    }

    #[test]
    fn cross_origin_events_cannot_mutate_existing_session() {
        let db = memdb();
        // 先建立真实会话与轮次
        let real = ingest(
            &db,
            &ev("codex", "shared-sess", Some("shared-run"), "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        assert_eq!(real.origin, EventOrigin::Real);
        // 管理员把来源改为压测类别后，同一会话的后续事件必须被隔离
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_sources SET category = 'benchmark' WHERE id = 'codex'",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let forged = ingest(
            &db,
            &ev("codex", "shared-sess", Some("shared-run"), "waiting"),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();
        assert!(forged.late, "跨来源类别的事件只能入流水");
        assert!(forged.notification.is_none());
        assert_eq!(forged.origin, EventOrigin::Benchmark);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&real.run_row_id]
            ),
            "running",
            "真实轮次状态不得被压测事件改写"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT origin FROM agent_sessions WHERE external_id = 'shared-sess'",
                rusqlite::params![]
            ),
            "real",
            "既有会话的可信类别不得被后续事件改写"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM notification_history"), 0);
    }

    #[test]
    fn selftest_waiting_never_notifies() {
        let db = memdb();
        let out = ingest(
            &db,
            &ev("codex", "taskdock-selftest-codex", None, "waiting"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        assert_eq!(out.origin, EventOrigin::Selftest);
        assert!(out.notification.is_none());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM notification_history"), 0);
    }

    #[test]
    fn client_declared_transport_is_not_trusted() {
        // 客户端把 transport 声明为 mock：服务端按 HTTP 入口处理，落库为 http、照常验证
        let db = memdb();
        let mut e = ev("codex", "s-fake", None, "running");
        e.transport = Some("mock".into());
        ingest_with(&db, &e, "2026-10-25T10:00:00+00:00", Transport::Http).unwrap();
        assert_eq!(
            cell(
                &db,
                "SELECT transport FROM agent_events WHERE session_external_id = 's-fake'",
                rusqlite::params![]
            ),
            "http"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "1",
            "客户端无法通过声明 mock 逃避验证记录"
        );
        // 反向：文件通道声明 http，落库仍为 file
        let mut e2 = ev("codex", "s-file", None, "running");
        e2.transport = Some("http".into());
        ingest_with(&db, &e2, "2026-10-25T10:01:00+00:00", Transport::File).unwrap();
        assert_eq!(
            cell(
                &db,
                "SELECT transport FROM agent_events WHERE session_external_id = 's-file'",
                rusqlite::params![]
            ),
            "file"
        );
    }

    #[test]
    fn reconnect_after_terminal_with_same_run_id_reopens_run() {
        // 终态后重连：同一 external_run_id 的活跃事件不得撞唯一索引，也不得静默丢弃
        let db = memdb();
        let first = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "completed"),
            "2026-10-25T10:05:00+00:00",
        )
        .unwrap();
        let re = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:10:00+00:00",
        )
        .unwrap();
        assert!(!re.late, "终态之后更晚发生的重连事件是合法新一轮");
        assert_eq!(
            re.run_row_id, first.run_row_id,
            "同一 run_id 必须重开原轮次（唯一索引）"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_runs"), 1);
        let (status, ended): (String, Option<String>) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT status, ended_at FROM agent_runs WHERE id = ?1",
                    rusqlite::params![&re.run_row_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(status, "running");
        assert!(ended.is_none(), "重开后 ended_at 必须清空");
    }

    #[test]
    fn same_run_id_across_sources_never_conflicts() {
        let db = memdb();
        let a = ingest(
            &db,
            &ev("codex", "sa", Some("same-run"), "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let b = ingest(
            &db,
            &ev("trae", "sb", Some("same-run"), "running"),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        assert_ne!(a.run_row_id, b.run_row_id, "跨来源同 run_id 必须各自成轮");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_runs"), 2);
    }

    #[test]
    fn batch_ingest_is_all_or_nothing() {
        let db = memdb();
        let good = ev("codex", "s1", Some("r1"), "running");
        let mut bad = ev("codex", "s2", Some("r2"), "running");
        bad.state = "not-a-state".into();
        let err = ingest_batch_core(&db, &[good.clone(), bad], Transport::Http).unwrap_err();
        assert!(!err.to_string().is_empty());
        // 第一个事件也必须回滚
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_events"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_runs"), 0);
        // 全部合法时整批成功
        let ok = ingest_batch_core(
            &db,
            &[good, ev("codex", "s2", Some("r2"), "running")],
            Transport::Http,
        )
        .unwrap();
        assert_eq!(ok.len(), 2);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_events"), 2);
    }

    #[test]
    fn real_event_verifies_source() {
        let db = memdb();
        ingest(
            &db,
            &ev("codex", "s1", None, "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "1",
            "真实事件到达即最低联调证据"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT CAST(transport_verified AS TEXT) FROM agent_sources WHERE id = 'codex'",
                rusqlite::params![]
            ),
            "1"
        );
    }

    #[test]
    fn instance_layer_records_multiple_instances() {
        let db = memdb();
        let mut e1 = ev("codex", "s1", Some("r1"), "running");
        e1.instance_id = Some("proc-111".into());
        let mut e2 = ev("codex", "s2", Some("r2"), "running");
        e2.instance_id = Some("proc-222".into());
        ingest(&db, &e1, "2026-10-25T10:00:00+00:00").unwrap();
        ingest(&db, &e2, "2026-10-25T10:00:01+00:00").unwrap();
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_instances"),
            2,
            "多实例分开记录"
        );
    }

    #[test]
    fn instance_id_linked_on_sessions_and_runs_or_null() {
        // v0.3 P0：snapshot 必须能暴露 instance 关联；未知关系保持 NULL（不伪造 default 实例）
        let db = memdb();
        let mut e1 = ev("codex", "s1", Some("r1"), "running");
        e1.instance_id = Some("proc-111".into());
        let out1 = ingest(&db, &e1, "2026-10-25T10:00:00+00:00").unwrap();
        let out2 = ingest(
            &db,
            &ev("codex", "s2", None, "running"),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();

        // 会话层：s1 关联到 proc-111 的实例行；s2 为 NULL
        let inst_key_1 = db
            .with_conn(|c| {
                let sid: Option<String> = c.query_row(
                    "SELECT instance_id FROM agent_sessions WHERE external_id = 's1'",
                    [],
                    |r| r.get(0),
                )?;
                match sid {
                    Some(id) => c.query_row(
                        "SELECT instance_key FROM agent_instances WHERE id = ?1",
                        rusqlite::params![id],
                        |r| r.get(0),
                    ),
                    None => Ok("__null__".to_string()),
                }
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(inst_key_1, "proc-111", "会话应关联事件携带的实例");
        let inst_2: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT instance_id FROM agent_sessions WHERE external_id = 's2'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(inst_2.is_none(), "未携带实例信息时必须保持 NULL，不得伪造");

        // 轮次层：run r1 关联实例，run 无实例信息为 NULL
        let run_inst: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT instance_id FROM agent_runs WHERE id = ?1",
                    rusqlite::params![&out1.run_row_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(run_inst.is_some(), "带实例的轮次应记录 instance_id");
        let run_inst2: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT instance_id FROM agent_runs WHERE id = ?1",
                    rusqlite::params![&out2.run_row_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(run_inst2.is_none(), "无实例信息的轮次保持 NULL");
    }

    #[test]
    fn five_concurrent_sessions_one_source() {
        let db = memdb();
        let now = "2026-10-25T10:00:00+00:00";
        for i in 0..5 {
            let s = format!("sess-{}", i);
            ingest(
                &db,
                &ev("codex", &s, Some(&format!("run-{}", i)), "running"),
                now,
            )
            .unwrap();
        }
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_sessions"), 5);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'running'"
            ),
            5
        );
    }

    #[test]
    fn terminal_correction_between_terminal_states() {
        let db = memdb();
        ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "completed"),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();
        // 终态间修正：completed → failed 允许（不同状态非重复）
        let fixed = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "failed"),
            "2026-10-25T10:02:00+00:00",
        )
        .unwrap();
        assert_eq!(fixed.state, AgentState::Failed);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_runs"),
            1,
            "修正不开新轮次"
        );
        let ended = cell(
            &db,
            "SELECT ended_at FROM agent_runs WHERE external_run_id = 'r1'",
            rusqlite::params![],
        );
        assert_eq!(
            ended, "2026-10-25T10:01:00+00:00",
            "ended_at 保留首个终态时间"
        );
    }

    #[test]
    fn task_completion_unaffected_by_agent_events() {
        // 场景 11：Agent 执行结束不改变普通任务完成状态
        let db = memdb();
        let task_id = uuid::Uuid::new_v4().to_string();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES (?1, '验收任务', '', 2, 'pending', '', '[]', 0, '2026-10-25T09:00:00+00:00', '2026-10-25T09:00:00+00:00')",
                rusqlite::params![task_id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "completed"),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let status = cell(
            &db,
            "SELECT status FROM tasks WHERE id = ?1",
            rusqlite::params![&task_id],
        );
        assert_eq!(status, "pending", "Agent 完成不得改任务状态");
    }
    #[test]
    fn agent_sudden_exit_marks_disconnected_once() {
        // 场景 8：Agent 突然退出 → 心跳超时判失联，只通知一次，不推断成败
        let db = memdb();
        let r = ingest(
            &db,
            &ev("codex", "s1", Some("r1"), "running"),
            "2026-10-25T09:00:00+00:00",
        )
        .unwrap();
        let stale: Vec<(String, String)> =
            db.with_conn(|conn| cleanup_stale_core(conn, 15)).unwrap();
        assert_eq!(stale.len(), 1, "超时轮次判失联");
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&r.run_row_id]
            ),
            "disconnected"
        );
        // 再次清理不重复通知
        db.with_conn(|conn| cleanup_stale_core(conn, 15)).unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM notification_history WHERE kind = 'agent_disconnected'"
            ),
            1
        );
        // 会话回到 idle
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_sessions WHERE status = 'running'"
            ),
            0
        );
    }

    #[test]
    fn restart_recovery_and_history_preserved() {
        // 场景 9/18：重启后历史保留；重启前遗留的活跃轮次按失联规则归位
        let dir = std::env::temp_dir().join(format!("td-restart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap();
            ingest(
                &db,
                &ev("codex", "s1", Some("r1"), "running"),
                "2026-10-24T09:00:00+00:00",
            )
            .unwrap();
            ingest(
                &db,
                &ev("trae", "s2", Some("r2"), "completed"),
                "2026-10-25T10:00:00+00:00",
            )
            .unwrap();
        } // drop = 模拟退出
        let db2 = Db::open(&path).unwrap();
        assert_eq!(
            count(&db2, "SELECT COUNT(*) FROM agent_runs"),
            2,
            "历史轮次保留"
        );
        assert_eq!(
            count(&db2, "SELECT COUNT(*) FROM agent_events"),
            2,
            "事件流水保留"
        );
        let stale: Vec<(String, String)> =
            db2.with_conn(|conn| cleanup_stale_core(conn, 15)).unwrap();
        assert_eq!(stale.len(), 1, "仅遗留 running 被归位，completed 不动");
        assert_eq!(
            count(
                &db2,
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'completed'"
            ),
            1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn three_agents_concurrently() {
        // 场景 1/15：多 Agent 并行不混淆
        let db = memdb();
        for (src, s) in [("codex", "a"), ("trae", "b"), ("qoder", "c")] {
            ingest(
                &db,
                &ev(src, s, None, "running"),
                "2026-10-25T10:00:00+00:00",
            )
            .unwrap();
        }
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_sessions"), 3);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_runs WHERE status = 'running'"
            ),
            3
        );
    }

    #[test]
    fn no_event_evidence_means_unknown_not_running() {
        // 场景 13/14：安装但未启动 / 有进程无状态 → 健康状态为 no-events，绝不推断运行
        let db = memdb();
        let h = crate::agents::managed::source_health(&db, "zcode");
        assert_eq!(h["state"], serde_json::json!("no-events"));
    }

    #[test]
    fn mock_vs_real_events_distinguishable() {
        // 场景 16：模拟与真实事件在流水里可区分
        let db = memdb();
        let m = ev("mock", "s1", None, "running");
        ingest_with(&db, &m, "2026-10-25T10:00:00+00:00", Transport::Mock).unwrap();
        ingest(
            &db,
            &ev("codex", "s2", None, "running"),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        let mock_t = cell(
            &db,
            "SELECT transport FROM agent_events WHERE source_id = 'mock'",
            rusqlite::params![],
        );
        let real_t = cell(
            &db,
            "SELECT transport FROM agent_events WHERE source_id = 'codex'",
            rusqlite::params![],
        );
        assert_eq!(mock_t, "mock");
        assert_eq!(real_t, "http");
    }

    // ── P0-01 事件顺序屏障 ─────────────────────────────────────

    fn seq_ev(source: &str, session: &str, run: Option<&str>, state: &str, seq: u64) -> AgentEvent {
        let mut e = ev(source, session, run, state);
        e.ingest_seq = Some(seq);
        e
    }

    #[test]
    fn older_running_does_not_override_newer_waiting() {
        // 合并缓冲里的旧 running（序号更小）晚于 waiting 落库：只记流水，不改状态。
        let db = memdb();
        ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let waiting = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 200),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        assert!(!waiting.late);
        let late = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 150),
            "2026-10-25T10:00:02+00:00",
        )
        .unwrap();
        assert!(late.late, "旧序号 running 必须标记为迟到");
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&waiting.run_row_id]
            ),
            "waiting"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_sessions WHERE external_id = 's1'",
                rusqlite::params![]
            ),
            "waiting",
            "会话状态不得被迟到事件回退"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_events WHERE state = 'running'"
            ),
            2,
            "迟到事件仍须保留在历史流水"
        );
    }

    #[test]
    fn newer_running_after_waiting_applies() {
        // waiting → running（序号更新）必须正常应用，不得被迟到保护误伤。
        let db = memdb();
        let waiting = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let running = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 200),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        assert!(!running.late);
        assert_eq!(running.prev_state, Some(AgentState::Waiting));
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&waiting.run_row_id]
            ),
            "running"
        );
    }

    #[test]
    fn backlog_event_with_newer_seq_but_older_time_is_history_only() {
        // 文件积压/离线恢复：新关键事件先受理（序号小），旧文件后受理（序号大但事件时间更早）。
        // 事件时间屏障必须阻止旧 running 覆盖新 waiting。
        let db = memdb();
        let waiting = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 100),
            "2026-10-25T10:05:00+00:00",
        )
        .unwrap();
        let backlog = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 900),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        assert!(backlog.late, "事件时间更旧的事件必须标记为迟到");
        assert_eq!(backlog.run_row_id, waiting.run_row_id);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&waiting.run_row_id]
            ),
            "waiting",
            "旧积压事件不得回退新状态"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_sessions WHERE external_id = 's1'",
                rusqlite::params![]
            ),
            "waiting"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_events WHERE state = 'running'"
            ),
            1,
            "旧事件仍须保留在历史流水"
        );
    }

    #[test]
    fn older_completed_is_not_reopened_by_late_running_with_newer_timestamp() {
        // 即使 occurred_at 更晚（时钟偏差/跨通道），只要受理序号更旧，
        // 就不能复活已结束轮次。
        let db = memdb();
        ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let done = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "completed", 300),
            "2026-10-25T10:05:00+00:00",
        )
        .unwrap();
        let late = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 200),
            "2026-10-25T10:10:00+00:00",
        )
        .unwrap();
        assert!(late.late);
        assert_eq!(late.run_row_id, done.run_row_id);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&done.run_row_id]
            ),
            "completed"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_runs"), 1);
    }

    #[test]
    fn older_failed_is_not_reopened_by_late_running() {
        let db = memdb();
        ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let failed = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "failed", 300),
            "2026-10-25T10:05:00+00:00",
        )
        .unwrap();
        let late = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 200),
            "2026-10-25T10:10:00+00:00",
        )
        .unwrap();
        assert!(late.late);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&failed.run_row_id]
            ),
            "failed"
        );
    }

    #[test]
    fn equal_ingest_seq_is_history_only() {
        // 序号相等无法证明先后：保守按迟到处理，先落库状态不被覆盖。
        let db = memdb();
        ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        let equal = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 100),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        assert!(equal.late);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE external_run_id = 'r1'",
                rusqlite::params![]
            ),
            "running"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_events"), 2);
    }

    #[test]
    fn missing_occurred_at_uses_server_time_and_still_respects_seq() {
        // 缺少 occurred_at：以服务端时间补齐；顺序仍由受理序号决定。
        let db = memdb();
        let mut a = ev("codex", "s1", Some("r1"), "running");
        a.ingest_seq = Some(100);
        a.occurred_at = None;
        ingest(&db, &a, "2026-10-25T10:00:00+00:00").unwrap();

        let mut w = ev("codex", "s1", Some("r1"), "waiting");
        w.ingest_seq = Some(200);
        w.occurred_at = None;
        let applied = ingest(&db, &w, "2026-10-25T10:00:05+00:00").unwrap();
        assert!(!applied.late);

        let mut late = ev("codex", "s1", Some("r1"), "running");
        late.ingest_seq = Some(150);
        late.occurred_at = None;
        // 服务端收到时间更晚，但受理序号更旧 → 迟到
        let out = ingest(&db, &late, "2026-10-25T10:00:10+00:00").unwrap();
        assert!(out.late);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE external_run_id = 'r1'",
                rusqlite::params![]
            ),
            "waiting"
        );
    }

    #[test]
    fn late_progress_is_recorded_without_duplicate_notifications() {
        // 迟到事件不产生通知；关键状态各自只通知一次。
        let db = memdb();
        ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "completed", 300),
            "2026-10-25T10:05:00+00:00",
        )
        .unwrap();
        let late = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 200),
            "2026-10-25T10:10:00+00:00",
        )
        .unwrap();
        assert!(late.notification.is_none());
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM notification_history WHERE kind = 'agent_done'"
            ),
            1
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM notification_history"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_events"), 3);
    }

    #[test]
    fn cross_source_same_session_id_keeps_independent_order() {
        // 多 Agent 使用相同外部会话 ID：顺序水位按轮次隔离，互不干扰。
        let db = memdb();
        ingest(
            &db,
            &seq_ev("codex", "shared", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
        )
        .unwrap();
        ingest(
            &db,
            &seq_ev("trae", "shared", Some("r1"), "running", 110),
            "2026-10-25T10:00:01+00:00",
        )
        .unwrap();
        let w = ingest(
            &db,
            &seq_ev("codex", "shared", Some("r1"), "waiting", 200),
            "2026-10-25T10:00:02+00:00",
        )
        .unwrap();
        assert!(!w.late);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE source_id = 'codex'",
                rusqlite::params![]
            ),
            "waiting"
        );
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE source_id = 'trae'",
                rusqlite::params![]
            ),
            "running",
            "另一个来源的轮次不得被跨来源序号影响"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM agent_sessions"), 2);
    }

    #[test]
    fn http_and_file_transport_interleaving_respects_seq() {
        // 跨通道（HTTP ↔ 文件投递）交错：最终状态按受理序号，不按通道先后。
        let db = memdb();
        ingest_with(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 100),
            "2026-10-25T10:00:00+00:00",
            Transport::Http,
        )
        .unwrap();
        let waiting = ingest_with(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 200),
            "2026-10-25T10:00:01+00:00",
            Transport::File,
        )
        .unwrap();
        let resumed = ingest_with(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "running", 300),
            "2026-10-25T10:00:02+00:00",
            Transport::Http,
        )
        .unwrap();
        assert!(!resumed.late);
        assert_eq!(resumed.prev_state, Some(AgentState::Waiting));
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&waiting.run_row_id]
            ),
            "running"
        );
        let final_wait = ingest_with(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 400),
            "2026-10-25T10:00:03+00:00",
            Transport::File,
        )
        .unwrap();
        assert!(!final_wait.late);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&waiting.run_row_id]
            ),
            "waiting"
        );
    }

    #[test]
    fn restart_reopens_above_persisted_watermark_after_clock_rollback() {
        // 重启 + 时钟回拨：启动时 bump 到库内最大序号，新事件仍严格新于历史。
        let dir = std::env::temp_dir().join(format!("taskdock-seq-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("task-dock.db");
        let (run_id, watermark) = {
            let db = Db::open(&path).unwrap();
            let out = ingest(
                &db,
                &seq_ev("codex", "s1", Some("r1"), "running", 100),
                "2026-10-25T10:00:00+00:00",
            )
            .unwrap();
            // 模拟库内水位远高于当前时钟（时钟回拨后的历史库）
            let future = 9_000_000_000_000_000i64;
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE agent_runs SET last_ingest_seq = ?1 WHERE id = ?2",
                    rusqlite::params![future, out.run_row_id],
                )
                .map_err(AppError::from)
            })
            .unwrap();
            (out.run_row_id, future as u64)
        };

        let db = Db::open(&path).unwrap();
        assert_eq!(db.max_ingest_seq().unwrap(), watermark);
        bump_ingest_seq(db.max_ingest_seq().unwrap());
        let next = next_ingest_seq();
        assert!(next > watermark, "重启后受理序号必须高于库内水位");

        // 旧序号事件仍是历史记录，不回退状态
        let old = ingest(
            &db,
            &seq_ev("codex", "s1", Some("r1"), "waiting", 200),
            "2026-10-25T10:01:00+00:00",
        )
        .unwrap();
        assert!(old.late);

        // 重启后分配的新序号事件正常应用
        let mut fresh = ev("codex", "s1", Some("r1"), "waiting");
        fresh.ingest_seq = Some(next);
        let applied = ingest(&db, &fresh, "2026-10-25T10:02:00+00:00").unwrap();
        assert!(!applied.late);
        assert_eq!(
            cell(
                &db,
                "SELECT status FROM agent_runs WHERE id = ?1",
                rusqlite::params![&run_id]
            ),
            "waiting"
        );
        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }
}
