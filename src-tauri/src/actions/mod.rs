//! Agent 行动中心：把散落的 Agent 事件聚合成「需要人处理的动作」。
//!
//! 语义分层（v0.5.2 重构）：
//! - 「需介入」：当前轮次真的停在 `waiting` / `failed` 且尚未确认；授权类型是
//!   最新消息的关键词推断（UI 必须标注「推断」），不是权限系统；
//! - 「通知」：尚未被当前需介入状态代表的未读通知（任务提醒、已恢复轮次遗留的
//!   失败通知）；已完成/断连通知只进历史，不计入徽标；
//! - 「历史」：最近 30 天真实轮次（运行中/已完成/历史等待/已恢复失败/断连），
//!   只读展示，不产生待办。
//!
//! 正确性约束：
//! - 状态只读 `agent_runs` 的当前状态（最新事件胜出），不按事件窗口猜测；
//! - 确认只写 `action_acks` / 通知已读，绝不改 `agent_runs` / `agent_sessions`；
//! - 确认后同一轮次有新事件（受理时间晚于确认时间）会重新出现；
//! - 自测/压测/模拟来源（origin <> 'real'）永不进入行动中心或徽标；
//! - 计数全部来自显式 SQL 聚合，与筛选、分页无关；分页使用 keyset 游标，
//!   新事件插入不会导致旧页丢失、重复或重排。

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const ITEM_LIMIT_DEFAULT: usize = 40;
pub const ITEM_LIMIT_MAX: usize = 200;
const HISTORY_LOOKBACK_DAYS: i64 = 30;
const SOURCE_STALE_HOURS: i64 = 24;
const CURSOR_SEP: char = '\u{1f}';

const AUTH_KEYWORDS: &[&str] = &[
    "授权",
    "权限",
    "批准",
    "同意",
    "确认访问",
    "permission",
    "approve",
    "authorization",
    "allow access",
];

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ActionFilter {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// failed | authorization | waiting_input | running | completed | disconnected | reminder
    #[serde(default)]
    pub kind: Option<String>,
    /// 0=P0 … 3=P3
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub include_acked: bool,
    /// intervention | notification | history（缺省 intervention）
    #[serde(default)]
    pub category: Option<String>,
    /// keyset 游标：只能来自上一页的 next_cursor
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionItem {
    /// 稳定 ID：`run:<轮次行 ID>` 或 `notification:<通知 ID>`
    pub id: String,
    /// intervention | notification | history
    pub category: String,
    pub kind: String,
    /// 0=P0 最高 … 3=P3
    pub priority: u8,
    pub source_id: String,
    pub source_name: String,
    pub session_external_id: String,
    pub run_row_id: Option<String>,
    pub run_external_id: Option<String>,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub title: String,
    pub message: String,
    pub occurred_at: String,
    pub acked: bool,
    /// 「需授权」是关键词推断，UI 必须标注
    pub authorization_inferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoverageRow {
    pub source_id: String,
    pub display_name: String,
    pub enabled: bool,
    pub verified: bool,
    pub transport_verified: bool,
    /// 仅 enabled && transport_verified 才算真正接入监控
    pub monitored: bool,
    pub last_event_at: Option<String>,
    /// live | stale | no-events | disabled | not-configured
    pub level: String,
    /// 给用户看的一句话说明（为什么是当前级别）
    pub explanation: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ActionCounts {
    /// 需介入：当前失败（未确认）
    pub failed: usize,
    /// 需介入：等待授权（关键词推断，未确认）
    pub authorization: usize,
    /// 需介入：等待输入（未确认）
    pub waiting_input: usize,
    /// 未读任务提醒
    pub reminder: usize,
    /// 通知总数（提醒 + 未被当前状态代表的失败等）
    pub notification: usize,
    /// 历史：运行中
    pub running: usize,
    /// 历史：已完成
    pub completed: usize,
    /// 历史：连接中断
    pub disconnected: usize,
    /// 历史总轮次（最近 30 天）
    pub history: usize,
    /// 需介入总数
    pub intervention: usize,
    /// 徽标数 = 需介入 + 通知（两者不重叠）
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionFeed {
    pub items: Vec<ActionItem>,
    /// 全局计数（非筛选、非分页），用于徽标与分类标签
    pub counts: ActionCounts,
    pub coverage: Vec<CoverageRow>,
    pub generated_at: String,
    /// 本次查询的分类
    pub category: String,
    /// 该分类在数据库中的总条数（与筛选无关）
    pub db_total: usize,
    /// 当前筛选命中的总条数（与分页无关）
    pub filtered_total: usize,
    /// 本页之后前端累计已加载的条数由前端维护；此处为当前返回页条数
    pub loaded: usize,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    /// 模块开关；false 时 items 恒为空，Agent 事件仍照常入库。
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Category {
    Intervention,
    Notification,
    History,
}

impl Category {
    fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("notification") => Self::Notification,
            Some("history") => Self::History,
            _ => Self::Intervention,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Intervention => "intervention",
            Self::Notification => "notification",
            Self::History => "history",
        }
    }
}

#[derive(Debug, Clone)]
struct TaskMapping {
    id: String,
    title: String,
    status: String,
    updated_at: String,
}

struct Paged {
    items: Vec<ActionItem>,
    filtered_total: usize,
    has_more: bool,
    next_cursor: Option<String>,
}

fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// 最新消息（授权推断只用于当前轮次；无 run_id 的旧式上报回退到会话当前轮次）。
const LATEST_MESSAGE_SQL: &str = "CASE WHEN r.external_run_id IS NOT NULL THEN \
    (SELECT e.message FROM agent_events e \
      WHERE e.source_id = r.source_id AND e.run_external_id = r.external_run_id \
      ORDER BY e.ingest_seq DESC, e.received_at DESC LIMIT 1) \
  ELSE \
    (SELECT e.message FROM agent_events e \
      JOIN agent_sessions ss2 ON ss2.id = r.session_id \
      WHERE e.source_id = r.source_id AND e.session_external_id = ss2.external_id \
        AND e.run_external_id IS NULL AND r.id = ss2.last_run_id \
      ORDER BY e.ingest_seq DESC, e.received_at DESC LIMIT 1) \
  END";

const LAST_RUN_EVENT_AT_SQL: &str = "(SELECT MAX(e.received_at) FROM agent_events e \
    WHERE e.source_id = r.source_id AND e.run_external_id = r.external_run_id)";

/// 确认是否仍然有效：确认时间必须不早于该轮次最后一次事件受理时间。
/// 新事件（例如再次进入等待/失败）会让旧确认失效，动作重新出现。
fn ack_expr() -> String {
    format!(
        "EXISTS (SELECT 1 FROM action_acks a WHERE a.event_id = 'run:' || r.id \
         AND julianday(a.acked_at) >= julianday(COALESCE({LAST_RUN_EVENT_AT_SQL}, r.updated_at)))"
    )
}

fn auth_expr(msg: &str) -> String {
    let parts: Vec<String> = AUTH_KEYWORDS
        .iter()
        .map(|k| {
            if k.is_ascii() {
                format!(
                    "lower({msg}) LIKE '%{}%'",
                    sql_literal(&k.to_ascii_lowercase())
                )
            } else {
                format!("{msg} LIKE '%{}%'", sql_literal(k))
            }
        })
        .collect();
    format!("({})", parts.join(" OR "))
}

fn kind_expr() -> String {
    format!(
        "CASE WHEN status = 'failed' THEN 'failed' \
              WHEN status = 'waiting' THEN CASE WHEN {auth} THEN 'authorization' ELSE 'waiting_input' END \
              WHEN status = 'disconnected' THEN 'disconnected' \
              WHEN status = 'running' THEN 'running' \
              WHEN status = 'completed' THEN 'completed' \
              ELSE 'idle' END",
        auth = auth_expr("msg")
    )
}

fn priority_for_kind(kind: &str) -> u8 {
    match kind {
        "failed" => 0,
        "authorization" | "waiting_input" => 1,
        "disconnected" | "running" => 2,
        _ => 3,
    }
}

fn kind_title(kind: &str) -> &'static str {
    match kind {
        "failed" => "执行失败",
        "authorization" => "等待授权（推断）",
        "waiting_input" => "等待输入",
        "disconnected" => "连接中断",
        "running" => "正在执行",
        "completed" => "本轮完成",
        "reminder" => "任务提醒",
        _ => "状态更新",
    }
}

fn item_title(kind: &str, subject: &str) -> String {
    let subject = subject.trim();
    if subject.is_empty() {
        kind_title(kind).to_string()
    } else {
        format!("{} · {}", kind_title(kind), subject)
    }
}

fn raw_id(item: &ActionItem) -> &str {
    item.id
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(&item.id)
}

fn load_task_map(conn: &Connection) -> AppResult<HashMap<(String, String), TaskMapping>> {
    let mut stmt = conn.prepare(
        "SELECT l.source_id, l.session_external_id, t.id, t.title, t.status, t.updated_at
         FROM task_agent_links l JOIN tasks t ON t.id = l.task_id
         UNION ALL
         SELECT n.agent_source_id, n.agent_session_id, t.id, t.title, t.status, t.updated_at
         FROM task_navigation_targets nl
         JOIN navigation_targets n ON n.id = nl.target_id
         JOIN tasks t ON t.id = nl.task_id
         WHERE n.target_type = 'agent_session'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
            TaskMapping {
                id: r.get(2)?,
                title: r.get(3)?,
                status: r.get(4)?,
                updated_at: r.get(5)?,
            },
        ))
    })?;
    let mut out: HashMap<(String, String), TaskMapping> = HashMap::new();
    for row in rows {
        let (key, cand) = row?;
        match out.get(&key) {
            None => {
                out.insert(key, cand);
            }
            Some(cur) => {
                // 未完成优先，其次最近更新（一个会话可能被多个任务引用）
                let cur_pending = cur.status == "pending";
                let cand_pending = cand.status == "pending";
                if (cand_pending && !cur_pending)
                    || (cand_pending == cur_pending && cand.updated_at > cur.updated_at)
                {
                    out.insert(key, cand);
                }
            }
        }
    }
    Ok(out)
}

fn add_run_filters(filter: &ActionFilter, sql: &mut String, args: &mut Vec<Value>) {
    if let Some(source) = filter.source_id.as_deref().filter(|v| !v.is_empty()) {
        sql.push_str(" AND r.source_id = ?");
        args.push(Value::Text(source.to_string()));
    }
    if let Some(task) = filter.task_id.as_deref().filter(|v| !v.is_empty()) {
        sql.push_str(
            " AND EXISTS (
                 SELECT 1 FROM task_agent_links l
                 WHERE l.task_id = ? AND l.source_id = r.source_id
                   AND l.session_external_id = s.external_id
                 UNION ALL
                 SELECT 1 FROM task_navigation_targets nl
                 JOIN navigation_targets n ON n.id = nl.target_id
                 WHERE nl.task_id = ? AND n.target_type = 'agent_session'
                   AND n.agent_source_id = r.source_id
                   AND n.agent_session_id = s.external_id
               )",
        );
        args.push(Value::Text(task.to_string()));
        args.push(Value::Text(task.to_string()));
    }
}

fn add_kind_filter(
    category: Category,
    kind: Option<&str>,
    sql: &mut String,
    args: &mut Vec<Value>,
) {
    let Some(kind) = kind.filter(|k| !k.is_empty() && *k != "all") else {
        return;
    };
    match category {
        Category::Intervention => {
            if matches!(kind, "failed" | "authorization" | "waiting_input") {
                sql.push_str(" AND kind = ?");
                args.push(Value::Text(kind.to_string()));
            } else {
                sql.push_str(" AND 0");
            }
        }
        Category::History => {
            if matches!(
                kind,
                "failed"
                    | "authorization"
                    | "waiting_input"
                    | "running"
                    | "completed"
                    | "disconnected"
            ) {
                sql.push_str(" AND kind = ?");
                args.push(Value::Text(kind.to_string()));
            } else {
                sql.push_str(" AND 0");
            }
        }
        Category::Notification => match kind {
            "reminder" => sql.push_str(" AND nkind = 'reminder'"),
            "failed" => sql.push_str(" AND nkind = 'agent_failed'"),
            _ => sql.push_str(" AND 0"),
        },
    }
}

fn add_priority_filter(category: Category, priority: Option<u8>, sql: &mut String) {
    let Some(priority) = priority else {
        return;
    };
    match category {
        Category::Intervention => match priority {
            0 => sql.push_str(" AND kind = 'failed'"),
            1 => sql.push_str(" AND kind IN ('authorization','waiting_input')"),
            _ => sql.push_str(" AND 0"),
        },
        Category::History => match priority {
            0 => sql.push_str(" AND kind = 'failed'"),
            1 => sql.push_str(" AND kind IN ('authorization','waiting_input')"),
            2 => sql.push_str(" AND kind IN ('disconnected','running')"),
            _ => sql.push_str(" AND kind = 'completed'"),
        },
        // 通知只有 P1（提醒/已恢复失败）
        Category::Notification => {
            if priority != 1 {
                sql.push_str(" AND 0");
            }
        }
    }
}

fn split_cursor(cursor: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = cursor.split(CURSOR_SEP).map(str::to_string).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    Some(parts)
}

fn add_run_cursor(cursor: Option<&str>, with_rank: bool, sql: &mut String, args: &mut Vec<Value>) {
    let Some(parts) = cursor.and_then(split_cursor) else {
        return;
    };
    if with_rank {
        if parts.len() != 3 {
            return;
        }
        let Ok(rank) = parts[0].parse::<i64>() else {
            return;
        };
        let rank_expr = "CASE kind WHEN 'failed' THEN 0 ELSE 1 END";
        sql.push_str(&format!(
            " AND ({rank_expr} > ? OR ({rank_expr} = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))",
            rank_expr = rank_expr
        ));
        args.push(Value::Integer(rank));
        args.push(Value::Integer(rank));
        args.push(Value::Text(parts[1].clone()));
        args.push(Value::Text(parts[1].clone()));
        args.push(Value::Text(parts[2].clone()));
    } else {
        if parts.len() != 2 {
            return;
        }
        sql.push_str(" AND (updated_at < ? OR (updated_at = ? AND id < ?))");
        args.push(Value::Text(parts[0].clone()));
        args.push(Value::Text(parts[0].clone()));
        args.push(Value::Text(parts[1].clone()));
    }
}

fn add_notification_cursor(cursor: Option<&str>, sql: &mut String, args: &mut Vec<Value>) {
    let Some(parts) = cursor.and_then(split_cursor) else {
        return;
    };
    if parts.len() != 2 {
        return;
    }
    sql.push_str(" AND (created_at < ? OR (created_at = ? AND id < ?))");
    args.push(Value::Text(parts[0].clone()));
    args.push(Value::Text(parts[0].clone()));
    args.push(Value::Text(parts[1].clone()));
}

fn intervention_cursor(item: &ActionItem) -> String {
    let rank = if item.kind == "failed" { 0 } else { 1 };
    format!(
        "{}{}{}{}{}",
        rank,
        CURSOR_SEP,
        item.occurred_at,
        CURSOR_SEP,
        raw_id(item)
    )
}

fn history_cursor(item: &ActionItem) -> String {
    format!("{}{}{}", item.occurred_at, CURSOR_SEP, raw_id(item))
}

fn notification_cursor(item: &ActionItem) -> String {
    format!("{}{}{}", item.occurred_at, CURSOR_SEP, raw_id(item))
}

fn task_of<'a>(
    task_map: &'a HashMap<(String, String), TaskMapping>,
    source_id: &str,
    session: &str,
) -> Option<&'a TaskMapping> {
    task_map.get(&(source_id.to_string(), session.to_string()))
}

fn run_item(
    row: &rusqlite::Row<'_>,
    category: Category,
    task_map: &HashMap<(String, String), TaskMapping>,
) -> rusqlite::Result<ActionItem> {
    let id: String = row.get(0)?;
    let source_id: String = row.get(1)?;
    let source_name: String = row.get(2)?;
    let session: String = row.get(3)?;
    let run_ext: Option<String> = row.get(4)?;
    let msg: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    let run_title: String = row.get(8)?;
    let acked: i64 = row.get(9)?;
    let kind: String = row.get(10)?;

    let task = task_of(task_map, &source_id, &session);
    let task_title = task
        .map(|t| t.title.clone())
        .filter(|t| !t.trim().is_empty());
    let subject = task_title.clone().unwrap_or(run_title);
    Ok(ActionItem {
        id: format!("run:{}", id),
        category: category.as_str().to_string(),
        kind: kind.clone(),
        priority: priority_for_kind(&kind),
        source_id,
        source_name,
        session_external_id: session,
        run_row_id: Some(id),
        run_external_id: run_ext,
        task_id: task.map(|t| t.id.clone()),
        task_title,
        title: item_title(&kind, &subject),
        message: msg,
        occurred_at: updated_at,
        acked: acked != 0,
        authorization_inferred: kind == "authorization",
    })
}

fn intervene_rows(
    conn: &Connection,
    filter: &ActionFilter,
    task_map: &HashMap<(String, String), TaskMapping>,
    limit: usize,
) -> AppResult<Paged> {
    let mut inner_where = String::from("r.origin = 'real' AND r.status IN ('waiting','failed')");
    let mut inner_args: Vec<Value> = Vec::new();
    add_run_filters(filter, &mut inner_where, &mut inner_args);

    let ack = ack_expr();
    let base = format!(
        "SELECT r.id AS id, r.source_id AS source_id, \
                COALESCE(src.display_name, r.source_id) AS source_name, \
                s.external_id AS session_ext, r.external_run_id AS run_ext, \
                r.status AS status, COALESCE({msg}, '') AS msg, \
                r.updated_at AS updated_at, r.task_title AS run_title, \
                ({ack}) AS acked \
         FROM agent_runs r \
         JOIN agent_sessions s ON s.id = r.session_id \
         LEFT JOIN agent_sources src ON src.id = r.source_id \
         WHERE {inner_where}",
        msg = LATEST_MESSAGE_SQL,
        ack = ack,
    );
    let mid = format!(
        "SELECT id, source_id, source_name, session_ext, run_ext, status, msg, \
                updated_at, run_title, acked, {kind} AS kind \
         FROM ({base}) b",
        kind = kind_expr(),
    );

    let mut filters = String::new();
    let mut args = inner_args.clone();
    if !filter.include_acked {
        filters.push_str(" AND acked = 0");
    }
    add_kind_filter(
        Category::Intervention,
        filter.kind.as_deref(),
        &mut filters,
        &mut args,
    );
    add_priority_filter(Category::Intervention, filter.priority, &mut filters);

    let count_sql = format!("SELECT COUNT(*) FROM ({mid}) x WHERE 1=1{filters}");
    let filtered_total: i64 =
        conn.query_row(&count_sql, params_from_iter(args.iter()), |r| r.get(0))?;
    let filtered_total = filtered_total.max(0) as usize;

    add_run_cursor(filter.cursor.as_deref(), true, &mut filters, &mut args);
    args.push(Value::Integer((limit as i64) + 1));
    let sql = format!(
        "SELECT id, source_id, source_name, session_ext, run_ext, status, msg, \
                updated_at, run_title, acked, kind \
         FROM ({mid}) x WHERE 1=1{filters} \
         ORDER BY CASE kind WHEN 'failed' THEN 0 ELSE 1 END ASC, updated_at DESC, id DESC \
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        run_item(r, Category::Intervention, task_map)
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    let next_cursor = if has_more {
        items.last().map(intervention_cursor)
    } else {
        None
    };
    Ok(Paged {
        items,
        filtered_total,
        has_more,
        next_cursor,
    })
}

fn history_rows(
    conn: &Connection,
    filter: &ActionFilter,
    task_map: &HashMap<(String, String), TaskMapping>,
    limit: usize,
    cutoff: &str,
) -> AppResult<Paged> {
    let mut inner_where = String::from("r.origin = 'real' AND r.updated_at >= ?");
    let mut inner_args: Vec<Value> = vec![Value::Text(cutoff.to_string())];
    add_run_filters(filter, &mut inner_where, &mut inner_args);

    let ack = ack_expr();
    let base = format!(
        "SELECT r.id AS id, r.source_id AS source_id, \
                COALESCE(src.display_name, r.source_id) AS source_name, \
                s.external_id AS session_ext, r.external_run_id AS run_ext, \
                r.status AS status, COALESCE({msg}, '') AS msg, \
                r.updated_at AS updated_at, r.task_title AS run_title, \
                ({ack}) AS acked \
         FROM agent_runs r \
         JOIN agent_sessions s ON s.id = r.session_id \
         LEFT JOIN agent_sources src ON src.id = r.source_id \
         WHERE {inner_where}",
        msg = LATEST_MESSAGE_SQL,
        ack = ack,
    );
    let mid = format!(
        "SELECT id, source_id, source_name, session_ext, run_ext, status, msg, \
                updated_at, run_title, acked, {kind} AS kind \
         FROM ({base}) b",
        kind = kind_expr(),
    );

    let mut filters = String::new();
    let mut args = inner_args.clone();
    add_kind_filter(
        Category::History,
        filter.kind.as_deref(),
        &mut filters,
        &mut args,
    );
    add_priority_filter(Category::History, filter.priority, &mut filters);

    let count_sql = format!("SELECT COUNT(*) FROM ({mid}) x WHERE 1=1{filters}");
    let filtered_total: i64 =
        conn.query_row(&count_sql, params_from_iter(args.iter()), |r| r.get(0))?;
    let filtered_total = filtered_total.max(0) as usize;

    add_run_cursor(filter.cursor.as_deref(), false, &mut filters, &mut args);
    args.push(Value::Integer((limit as i64) + 1));
    let sql = format!(
        "SELECT id, source_id, source_name, session_ext, run_ext, status, msg, \
                updated_at, run_title, acked, kind \
         FROM ({mid}) x WHERE 1=1{filters} \
         ORDER BY updated_at DESC, id DESC LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        run_item(r, Category::History, task_map)
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    let next_cursor = if has_more {
        items.last().map(history_cursor)
    } else {
        None
    };
    Ok(Paged {
        items,
        filtered_total,
        has_more,
        next_cursor,
    })
}

fn notification_rows(
    conn: &Connection,
    filter: &ActionFilter,
    task_map: &HashMap<(String, String), TaskMapping>,
    limit: usize,
) -> AppResult<Paged> {
    let mut inner_where = String::from(
        "n.agent_origin = 'real' AND n.is_read = 0 AND (\
           n.kind = 'reminder' OR \
           (n.kind = 'agent_failed' AND r.origin = 'real' AND r.status <> 'failed')\
         )",
    );
    let mut inner_args: Vec<Value> = Vec::new();
    if let Some(source) = filter.source_id.as_deref().filter(|v| !v.is_empty()) {
        inner_where.push_str(" AND r.source_id = ?");
        inner_args.push(Value::Text(source.to_string()));
    }
    if let Some(task) = filter.task_id.as_deref().filter(|v| !v.is_empty()) {
        inner_where.push_str(
            " AND ((n.ref_type = 'task' AND n.ref_id = ?) OR (r.id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM task_agent_links l
                 WHERE l.task_id = ? AND l.source_id = r.source_id
                   AND l.session_external_id = s.external_id
                 UNION ALL
                 SELECT 1 FROM task_navigation_targets nl
                 JOIN navigation_targets n2 ON n2.id = nl.target_id
                 WHERE nl.task_id = ? AND n2.target_type = 'agent_session'
                   AND n2.agent_source_id = r.source_id
                   AND n2.agent_session_id = s.external_id
               )))",
        );
        inner_args.push(Value::Text(task.to_string()));
        inner_args.push(Value::Text(task.to_string()));
        inner_args.push(Value::Text(task.to_string()));
    }

    let base = format!(
        "SELECT n.id AS id, n.kind AS nkind, n.title AS ntitle, n.body AS nbody, \
                n.created_at AS created_at, n.ref_type AS ref_type, n.ref_id AS ref_id, \
                r.id AS run_row_id, r.external_run_id AS run_ext, r.source_id AS source_id, \
                COALESCE(src.display_name, r.source_id) AS source_name, \
                s.external_id AS session_ext, r.task_title AS run_title, \
                COALESCE((SELECT title FROM tasks WHERE id = n.ref_id), '') AS reminder_task_title \
         FROM notification_history n \
         LEFT JOIN agent_runs r ON n.ref_type = 'agent_run' AND r.id = n.ref_id \
         LEFT JOIN agent_sessions s ON s.id = r.session_id \
         LEFT JOIN agent_sources src ON src.id = r.source_id \
         WHERE {inner_where}"
    );

    let mut filters = String::new();
    let mut args = inner_args.clone();
    add_kind_filter(
        Category::Notification,
        filter.kind.as_deref(),
        &mut filters,
        &mut args,
    );
    add_priority_filter(Category::Notification, filter.priority, &mut filters);

    let count_sql = format!("SELECT COUNT(*) FROM ({base}) x WHERE 1=1{filters}");
    let filtered_total: i64 =
        conn.query_row(&count_sql, params_from_iter(args.iter()), |r| r.get(0))?;
    let filtered_total = filtered_total.max(0) as usize;

    add_notification_cursor(filter.cursor.as_deref(), &mut filters, &mut args);
    args.push(Value::Integer((limit as i64) + 1));
    let sql = format!(
        "SELECT id, nkind, ntitle, nbody, created_at, ref_type, ref_id, run_row_id, run_ext, \
                source_id, source_name, session_ext, run_title, reminder_task_title \
         FROM ({base}) x WHERE 1=1{filters} \
         ORDER BY created_at DESC, id DESC LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        let nid: String = r.get(0)?;
        let nkind: String = r.get(1)?;
        let ntitle: String = r.get(2)?;
        let nbody: String = r.get(3)?;
        let created_at: String = r.get(4)?;
        let ref_type: Option<String> = r.get(5)?;
        let ref_id: Option<String> = r.get(6)?;
        let run_row_id: Option<String> = r.get(7)?;
        let run_ext: Option<String> = r.get(8)?;
        let source_id: Option<String> = r.get(9)?;
        let source_name: Option<String> = r.get(10)?;
        let session: Option<String> = r.get(11)?;
        let run_title: Option<String> = r.get(12)?;
        let reminder_task_title: String = r.get(13)?;

        if nkind == "reminder" {
            let task_id = ref_id
                .clone()
                .filter(|_| ref_type.as_deref() == Some("task"));
            let task_title = if reminder_task_title.trim().is_empty() {
                None
            } else {
                Some(reminder_task_title)
            };
            return Ok(ActionItem {
                id: format!("notification:{}", nid),
                category: Category::Notification.as_str().to_string(),
                kind: "reminder".into(),
                priority: 1,
                source_id: String::new(),
                source_name: "任务提醒".into(),
                session_external_id: String::new(),
                run_row_id: None,
                run_external_id: None,
                task_id,
                task_title,
                title: ntitle,
                message: nbody,
                occurred_at: created_at,
                acked: false,
                authorization_inferred: false,
            });
        }

        let source_id = source_id.unwrap_or_default();
        let session = session.unwrap_or_default();
        let task = task_of(task_map, &source_id, &session);
        let task_title = task
            .map(|t| t.title.clone())
            .filter(|t| !t.trim().is_empty());
        let subject = task_title
            .clone()
            .unwrap_or_else(|| run_title.unwrap_or_default());
        Ok(ActionItem {
            id: format!("notification:{}", nid),
            category: Category::Notification.as_str().to_string(),
            kind: "failed".into(),
            priority: 1,
            source_name: source_name.unwrap_or_else(|| source_id.clone()),
            source_id,
            session_external_id: session,
            run_row_id,
            run_external_id: run_ext,
            task_id: task.map(|t| t.id.clone()),
            task_title,
            title: item_title("failed", &subject),
            message: nbody,
            occurred_at: created_at,
            acked: false,
            authorization_inferred: false,
        })
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    let next_cursor = if has_more {
        items.last().map(notification_cursor)
    } else {
        None
    };
    Ok(Paged {
        items,
        filtered_total,
        has_more,
        next_cursor,
    })
}

fn load_counts(conn: &Connection, cutoff: &str) -> AppResult<ActionCounts> {
    let mut counts = ActionCounts::default();

    let intervention_sql = format!(
        "SELECT kind, COUNT(*) FROM (\
           SELECT CASE WHEN status = 'failed' THEN 'failed' \
                       WHEN status = 'waiting' THEN CASE WHEN {auth} THEN 'authorization' ELSE 'waiting_input' END \
                       ELSE status END AS kind \
           FROM (SELECT r.status AS status, COALESCE({msg}, '') AS msg \
                 FROM agent_runs r \
                 WHERE r.origin = 'real' AND r.status IN ('waiting','failed') \
                   AND NOT ({ack})) b\
         ) k GROUP BY kind",
        auth = auth_expr("msg"),
        msg = LATEST_MESSAGE_SQL,
        ack = ack_expr(),
    );
    let mut stmt = conn.prepare(&intervention_sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let kind: String = row.get(0)?;
        let n: i64 = row.get(1)?;
        let n = n.max(0) as usize;
        match kind.as_str() {
            "failed" => counts.failed += n,
            "authorization" => counts.authorization += n,
            "waiting_input" => counts.waiting_input += n,
            _ => {}
        }
    }
    counts.intervention = counts.failed + counts.authorization + counts.waiting_input;

    let notification_sql = "SELECT \
        COALESCE(SUM(CASE WHEN n.kind = 'reminder' THEN 1 ELSE 0 END), 0), \
        COUNT(*) \
        FROM notification_history n \
        LEFT JOIN agent_runs r ON n.ref_type = 'agent_run' AND r.id = n.ref_id \
        WHERE n.agent_origin = 'real' AND n.is_read = 0 AND (\
          n.kind = 'reminder' OR \
          (n.kind = 'agent_failed' AND r.origin = 'real' AND r.status <> 'failed')\
        )";
    let (reminders, notifications): (i64, i64) =
        conn.query_row(notification_sql, [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    counts.reminder = reminders.max(0) as usize;
    counts.notification = notifications.max(0) as usize;

    let mut stmt = conn.prepare(
        "SELECT status, COUNT(*) FROM agent_runs \
         WHERE origin = 'real' AND updated_at >= ?1 GROUP BY status",
    )?;
    let mut rows = stmt.query(params![cutoff])?;
    while let Some(row) = rows.next()? {
        let status: String = row.get(0)?;
        let n: i64 = row.get(1)?;
        let n = n.max(0) as usize;
        counts.history += n;
        match status.as_str() {
            "running" => counts.running += n,
            "completed" => counts.completed += n,
            "disconnected" => counts.disconnected += n,
            _ => {}
        }
    }

    counts.total = counts.intervention + counts.notification;
    Ok(counts)
}

fn coverage(conn: &Connection) -> AppResult<Vec<CoverageRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, display_name, enabled, verified, transport_verified, last_event_at,
                COALESCE(adapter, ''), COALESCE(note, '')
         FROM agent_sources WHERE hidden = 0 AND id <> 'mock'
         ORDER BY enabled DESC, id",
    )?;
    let now = Utc::now();
    let rows = stmt.query_map([], |r| {
        let enabled = r.get::<_, i64>(2)? != 0;
        let verified = r.get::<_, i64>(3)? != 0;
        let transport_verified = r.get::<_, i64>(4)? != 0;
        let last_event_at: Option<String> = r.get(5)?;
        let adapter: String = r.get(6)?;
        let note: String = r.get(7)?;
        let monitored = enabled && transport_verified;
        let level = if !enabled {
            "disabled".to_string()
        } else if last_event_at.is_none() {
            "no-events".to_string()
        } else {
            let fresh = last_event_at
                .as_deref()
                .and_then(parse_ts)
                .map(|t| now - t <= Duration::hours(SOURCE_STALE_HOURS))
                .unwrap_or(false);
            if monitored && fresh {
                "live".to_string()
            } else if monitored {
                "stale".to_string()
            } else {
                "not-configured".to_string()
            }
        };
        let explanation = match level.as_str() {
            "disabled" => "已停用：不接收事件".to_string(),
            "no-events" => "未接入：仅发现/安装，尚无真实事件".to_string(),
            "stale" => format!("{} 小时无新事件，状态可能已过期", SOURCE_STALE_HOURS),
            "not-configured" => "通道未验证：不显示运行状态".to_string(),
            _ => {
                if verified {
                    "运行中：已收到真实会话事件".to_string()
                } else {
                    "通道已打通，尚未收到真实会话事件".to_string()
                }
            }
        };
        Ok(CoverageRow {
            source_id: r.get(0)?,
            display_name: r.get(1)?,
            enabled,
            verified,
            transport_verified,
            monitored,
            last_event_at,
            level,
            explanation,
            note: if note.is_empty() {
                adapter
            } else {
                format!("{} · {}", adapter, note)
            },
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn empty_feed(category: Category) -> ActionFeed {
    ActionFeed {
        items: Vec::new(),
        counts: ActionCounts::default(),
        coverage: Vec::new(),
        generated_at: crate::agents::now_iso(),
        category: category.as_str().to_string(),
        db_total: 0,
        filtered_total: 0,
        loaded: 0,
        has_more: false,
        next_cursor: None,
        enabled: false,
    }
}

pub fn feed(db: &Db, filter: &ActionFilter) -> AppResult<ActionFeed> {
    let category = Category::parse(filter.category.as_deref());
    // 模块关闭：不聚合、不推送动作；Agent 事件接入与历史不受影响
    if !crate::db::Settings::load(db)?.actions_enabled {
        return Ok(empty_feed(category));
    }
    let limit = filter
        .limit
        .unwrap_or(ITEM_LIMIT_DEFAULT)
        .clamp(1, ITEM_LIMIT_MAX);
    let cutoff = (Utc::now() - Duration::days(HISTORY_LOOKBACK_DAYS)).to_rfc3339();
    db.with_read(|conn| {
        let counts = load_counts(conn, &cutoff)?;
        let coverage = coverage(conn)?;
        let task_map = load_task_map(conn)?;
        let paged = match category {
            Category::Intervention => intervene_rows(conn, filter, &task_map, limit)?,
            Category::Notification => notification_rows(conn, filter, &task_map, limit)?,
            Category::History => history_rows(conn, filter, &task_map, limit, &cutoff)?,
        };
        let db_total = match category {
            Category::Intervention => counts.intervention,
            Category::Notification => counts.notification,
            Category::History => counts.history,
        };
        let loaded = paged.items.len();
        Ok(ActionFeed {
            items: paged.items,
            counts,
            coverage,
            generated_at: crate::agents::now_iso(),
            category: category.as_str().to_string(),
            db_total,
            filtered_total: paged.filtered_total,
            loaded,
            has_more: paged.has_more,
            next_cursor: paged.next_cursor,
            enabled: true,
        })
    })
}

/// 标记已处理（幂等）。ID 为 `run:<轮次>` / `notification:<通知>`。
/// 只写确认表与通知已读状态，绝不修改 Agent 轮次/会话状态。
pub fn ack(db: &Db, ids: &[String]) -> AppResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut n = 0usize;
        for id in ids.iter().take(500) {
            if let Some(notification_id) = id.strip_prefix("notification:") {
                n += tx.execute(
                    "INSERT OR IGNORE INTO action_acks (event_id, acked_at) VALUES (?1, ?2)",
                    params![id, now],
                )?;
                tx.execute(
                    "UPDATE notification_history SET is_read = 1 WHERE id = ?1",
                    params![notification_id],
                )?;
            } else if let Some(run_id) = id.strip_prefix("run:") {
                n += tx.execute(
                    "INSERT OR IGNORE INTO action_acks (event_id, acked_at) VALUES (?1, ?2)",
                    params![id, now],
                )?;
                tx.execute(
                    "UPDATE notification_history SET is_read = 1 \
                     WHERE ref_type = 'agent_run' AND ref_id = ?1 \
                       AND kind IN ('agent_waiting','agent_failed')",
                    params![run_id],
                )?;
            } else {
                // 兼容旧版按事件 ID 的确认记录：仍记录，但不改任何 Agent 状态
                n += tx.execute(
                    "INSERT OR IGNORE INTO action_acks (event_id, acked_at) VALUES (?1, ?2)",
                    params![id, now],
                )?;
            }
        }
        tx.commit()?;
        Ok(n)
    })
}

/// 取消已处理标记（误点恢复）。
pub fn unack(db: &Db, ids: &[String]) -> AppResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut n = 0usize;
        for id in ids.iter().take(500) {
            n += tx.execute("DELETE FROM action_acks WHERE event_id = ?1", params![id])?;
            if let Some(notification_id) = id.strip_prefix("notification:") {
                tx.execute(
                    "UPDATE notification_history SET is_read = 0 WHERE id = ?1",
                    params![notification_id],
                )?;
            } else if let Some(run_id) = id.strip_prefix("run:") {
                tx.execute(
                    "UPDATE notification_history SET is_read = 0 \
                     WHERE ref_type = 'agent_run' AND ref_id = ?1 \
                       AND kind IN ('agent_waiting','agent_failed')",
                    params![run_id],
                )?;
            }
        }
        tx.commit()?;
        Ok(n)
    })
}

pub fn open_session_target(
    db: &Db,
    source_id: &str,
    session_id: &str,
) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT id FROM navigation_targets
             WHERE target_type = 'agent_session' AND agent_source_id = ?1 AND agent_session_id = ?2
             LIMIT 1",
            params![source_id, session_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(AppError::from)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{ingest_core, AgentEvent, IngestOutcome, Transport};
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn step(
        db: &Db,
        event_id: &str,
        source: &str,
        session: &str,
        run: Option<&str>,
        state: &str,
        message: &str,
        at: &str,
    ) -> IngestOutcome {
        let ev = AgentEvent {
            event_id: Some(event_id.to_string()),
            source_id: source.into(),
            session_id: session.into(),
            run_id: run.map(str::to_string),
            state: state.into(),
            message: if message.is_empty() {
                None
            } else {
                Some(message.into())
            },
            ..Default::default()
        };
        db.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let out = ingest_core(&tx, &ev, at, Transport::Http)?;
            tx.commit()?;
            Ok::<_, AppError>(out)
        })
        .unwrap()
    }

    fn event_count(db: &Db) -> i64 {
        db.with_read(|c| Ok(c.query_row("SELECT COUNT(*) FROM agent_events", [], |r| r.get(0))?))
            .unwrap()
    }

    fn run_status(db: &Db, run_id: &str) -> String {
        db.with_read(|c| {
            Ok(c.query_row(
                "SELECT status FROM agent_runs WHERE id = ?1",
                params![run_id],
                |r| r.get(0),
            )?)
        })
        .unwrap()
    }

    fn task(db: &Db, id: &str, title: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?1, ?2, 'pending', 'now', 'now')",
                params![id, title],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn link_task(db: &Db, id: &str, task_id: &str, source: &str, session: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'now')",
                params![id, task_id, source, session],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn reminder(db: &Db, id: &str, task_id: &str, created_at: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin)
                 VALUES (?1, 'reminder', '任务提醒', '交报告', 'task', ?2, ?3, 0, ?4, 'real')",
                params![id, task_id, id, created_at],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn feed_of(db: &Db, category: &str) -> ActionFeed {
        feed(
            db,
            &ActionFilter {
                category: Some(category.into()),
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn seed_runs(db: &Db, prefix: &str, count: usize, status: &str, updated_at: &str) {
        db.with_conn(|c| {
            for i in 0..count {
                let sid = format!("{}-sess-{:04}", prefix, i);
                let rid = format!("{}-run-{:04}", prefix, i);
                c.execute(
                    "INSERT INTO agent_sessions
                       (id, source_id, external_id, title, status, first_seen_at, last_seen_at, last_run_id, instance_id, origin)
                     VALUES (?1, 'codex', ?2, '', ?3, ?4, ?4, ?5, NULL, 'real')",
                    params![format!("{}-sid-{:04}", prefix, i), sid, status, updated_at, rid],
                )?;
                c.execute(
                    "INSERT INTO agent_runs
                       (id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, ended_at, pending_items, meta, instance_id, parent_run_id, last_ingest_seq, last_event_at, origin)
                     VALUES (?1, ?2, 'codex', ?3, '', ?4, ?5, ?5, NULL, '[]', '{}', NULL, NULL, 1, ?5, 'real')",
                    params![rid, format!("{}-sid-{:04}", prefix, i), format!("{}-ext-{:04}", prefix, i), status, updated_at],
                )?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn intervention_follows_current_run_state_and_task_mapping() {
        let db = memdb();
        task(&db, "t1", "重构登录");
        link_task(&db, "l1", "t1", "codex", "s1");
        let out = step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "waiting",
            "等待输入文件名",
            "2026-10-28T10:00:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items.len(), 1);
        let item = &f.items[0];
        assert_eq!(item.id, format!("run:{}", out.run_row_id));
        assert_eq!(item.kind, "waiting_input");
        assert_eq!(item.task_id.as_deref(), Some("t1"));
        assert_eq!(item.task_title.as_deref(), Some("重构登录"));
        assert!(item.title.contains("重构登录"));
        assert_eq!(f.counts.total, 1);
        assert_eq!(f.counts.intervention, 1);

        // 轮次继续执行：旧等待立即从需介入消失，进入历史
        step(
            &db,
            "e2",
            "codex",
            "s1",
            Some("r1"),
            "running",
            "继续执行",
            "2026-10-28T10:01:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert!(f.items.is_empty(), "已恢复的等待不得继续阻塞");
        assert_eq!(f.counts.intervention, 0);
        let h = feed_of(&db, "history");
        assert_eq!(h.items.len(), 1);
        assert_eq!(h.items[0].kind, "running");
        assert_eq!(h.items[0].task_id.as_deref(), Some("t1"));
        assert_eq!(h.counts.running, 1);
        assert_eq!(h.counts.history, 1);
        assert_eq!(h.counts.total, 0, "运行中不进入徽标");
    }

    #[test]
    fn completed_never_counts_in_badge() {
        let db = memdb();
        step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "running",
            "执行中",
            "2026-10-28T10:00:00+00:00",
        );
        step(
            &db,
            "e2",
            "codex",
            "s1",
            Some("r1"),
            "completed",
            "完成",
            "2026-10-28T10:01:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert!(f.items.is_empty());
        assert_eq!(f.counts.total, 0);
        assert_eq!(f.counts.intervention, 0);
        let h = feed_of(&db, "history");
        assert_eq!(h.items.len(), 1);
        assert_eq!(h.items[0].kind, "completed");
        assert_eq!(h.counts.completed, 1);
        assert_eq!(h.counts.total, 0);
        // 完成通知存在但未读，也不计入通知徽标
        assert_eq!(f.counts.notification, 0);
    }

    #[test]
    fn authorization_is_inferred_from_latest_message_and_marked() {
        let db = memdb();
        let out = step(
            &db,
            "e1",
            "qoder",
            "s1",
            Some("r1"),
            "waiting",
            "需要授权访问工作区",
            "2026-10-28T10:00:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items[0].kind, "authorization");
        assert!(f.items[0].authorization_inferred);
        assert_eq!(f.counts.authorization, 1);
        assert_eq!(f.counts.failed, 0);

        // 最新事件改为普通等待：推断必须跟随最新消息，而不是旧关键词
        step(
            &db,
            "e2",
            "qoder",
            "s1",
            Some("r1"),
            "waiting",
            "等待输入文件名",
            "2026-10-28T10:01:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items[0].id, format!("run:{}", out.run_row_id));
        assert_eq!(f.items[0].kind, "waiting_input");
        assert!(!f.items[0].authorization_inferred);
        assert_eq!(f.counts.waiting_input, 1);
        assert_eq!(f.counts.authorization, 0);
    }

    #[test]
    fn ack_never_changes_agent_state_and_new_event_resurfaces() {
        let db = memdb();
        let out = step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "failed",
            "测试失败",
            "2026-10-28T10:00:00+00:00",
        );
        let run_id = out.run_row_id.clone();
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items[0].kind, "failed");
        assert_eq!(f.counts.total, 1);

        ack(&db, &[format!("run:{}", run_id)]).unwrap();
        assert_eq!(run_status(&db, &run_id), "failed", "确认不得修改真实状态");
        let f = feed_of(&db, "intervention");
        assert!(f.items.is_empty());
        assert_eq!(f.counts.total, 0);
        let read: i64 = db
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT is_read FROM notification_history WHERE ref_type='agent_run' AND ref_id=?1 AND kind='agent_failed'",
                    params![run_id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(read, 1, "确认轮次必须同时消除对应未读通知");

        // 新事件（受理时间晚于确认）使失败动作重新出现
        step(
            &db,
            "e2",
            "codex",
            "s1",
            Some("r1"),
            "failed",
            "再次失败",
            "2026-10-31T10:00:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items.len(), 1, "新事件后已确认动作必须重新出现");
        assert!(!f.items[0].acked);
        assert_eq!(f.counts.total, 1);
        // 恢复确认：回到待处理（仍不改真实状态）
        unack(&db, &[format!("run:{}", run_id)]).unwrap();
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items.len(), 1);
        assert!(!f.items[0].acked);
        assert_eq!(run_status(&db, &run_id), "failed");
    }

    #[test]
    fn recovered_failure_stays_as_unread_notification_not_intervention() {
        let db = memdb();
        step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "failed",
            "构建失败",
            "2026-10-28T10:00:00+00:00",
        );
        // 同一轮次重新活跃（终态后新一轮）：旧失败通知仍未读，但轮次已不失败
        step(
            &db,
            "e2",
            "codex",
            "s1",
            Some("r1"),
            "running",
            "重新执行",
            "2026-10-28T10:05:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert!(f.items.is_empty(), "已恢复的失败不再是需介入");
        assert_eq!(f.counts.failed, 0);
        assert_eq!(f.counts.notification, 1, "未读失败通知进入通知分类");
        assert_eq!(f.counts.total, 1);

        let n = feed_of(&db, "notification");
        assert_eq!(n.items.len(), 1);
        assert_eq!(n.items[0].kind, "failed");
        assert!(n.items[0].id.starts_with("notification:"));
        assert!(n.items[0].source_id == "codex");

        // 确认通知 → 已读 → 徽标归零
        ack(&db, &[n.items[0].id.clone()]).unwrap();
        assert_eq!(feed_of(&db, "notification").counts.notification, 0);
        assert_eq!(feed_of(&db, "intervention").counts.total, 0);
    }

    #[test]
    fn unread_reminders_and_task_filter() {
        let db = memdb();
        task(&db, "t1", "交报告");
        reminder(&db, "n1", "t1", "2026-10-28T10:00:00+00:00");
        reminder(&db, "n2", "t1", "2026-10-28T10:01:00+00:00");
        let f = feed_of(&db, "notification");
        assert_eq!(f.items.len(), 2);
        assert!(f.items.iter().all(|i| i.kind == "reminder"));
        assert_eq!(f.counts.reminder, 2);
        assert_eq!(f.counts.notification, 2);
        assert_eq!(f.items[0].task_id.as_deref(), Some("t1"));
        assert_eq!(f.items[0].task_title.as_deref(), Some("交报告"));

        let filtered = feed(
            &db,
            &ActionFilter {
                category: Some("notification".into()),
                task_id: Some("t1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.filtered_total, 2);
        assert_eq!(filtered.counts.notification, 2, "计数不受筛选影响");

        ack(&db, &[f.items[0].id.clone()]).unwrap();
        let f = feed_of(&db, "notification");
        assert_eq!(f.items.len(), 1);
        assert_eq!(f.counts.reminder, 1);
        assert_eq!(f.counts.notification, 1);
    }

    #[test]
    fn benchmark_selftest_and_mock_never_enter_actions() {
        let db = memdb();
        step(
            &db,
            "e1",
            "bench",
            "http-perf-1-s1",
            Some("http-perf-1-r1"),
            "failed",
            "压测失败",
            "2026-10-28T10:00:00+00:00",
        );
        step(
            &db,
            "e2",
            "codex",
            "taskdock-selftest-codex",
            Some("r1"),
            "waiting",
            "自测等待",
            "2026-10-28T10:00:00+00:00",
        );
        step(
            &db,
            "e3",
            "mock",
            "mock-s1",
            Some("mock-r1"),
            "failed",
            "模拟失败",
            "2026-10-28T10:00:00+00:00",
        );
        for category in ["intervention", "notification", "history"] {
            let f = feed_of(&db, category);
            assert!(f.items.is_empty(), "{category} 不得出现测试数据");
            assert_eq!(f.counts.total, 0);
            assert_eq!(f.counts.history, 0);
        }
    }

    #[test]
    fn late_events_do_not_revert_current_action_state() {
        let db = memdb();
        step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "waiting",
            "等待输入",
            "2026-10-28T10:00:00+00:00",
        );
        // 受理更晚、但事件时间更旧的 running：不得把等待变成运行
        step(
            &db,
            "e2",
            "codex",
            "s1",
            Some("r1"),
            "running",
            "迟到运行",
            "2026-10-28T09:59:00+00:00",
        );
        let f = feed_of(&db, "intervention");
        assert_eq!(f.items.len(), 1);
        assert_eq!(f.items[0].kind, "waiting_input");
    }

    #[test]
    fn filter_and_counts_are_independent_of_pagination() {
        let db = memdb();
        seed_runs(&db, "a", 3, "failed", "2026-10-28T10:00:00+00:00");
        seed_runs(&db, "b", 2, "waiting", "2026-10-28T10:01:00+00:00");
        let f = feed(
            &db,
            &ActionFilter {
                category: Some("intervention".into()),
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(f.items.len(), 2);
        assert_eq!(f.filtered_total, 5);
        assert_eq!(f.db_total, 5);
        assert_eq!(f.counts.intervention, 5);
        assert_eq!(f.counts.failed, 3);
        assert_eq!(f.counts.waiting_input, 2);
        assert!(f.has_more);

        let only_failed = feed(
            &db,
            &ActionFilter {
                category: Some("intervention".into()),
                kind: Some("failed".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_failed.filtered_total, 3);
        assert_eq!(only_failed.counts.intervention, 5, "全局计数不受筛选影响");
        assert_eq!(only_failed.counts.failed, 3);
    }

    #[test]
    fn keyset_pagination_is_stable_under_insertions() {
        let db = memdb();
        let n = 1005usize;
        seed_runs(&db, "run", n, "waiting", "2026-10-28T10:00:00+00:00");

        let mut ids = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        let mut inserted = false;
        loop {
            let f = feed(
                &db,
                &ActionFilter {
                    category: Some("intervention".into()),
                    limit: Some(100),
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                f.filtered_total,
                n + if inserted { 5 } else { 0 },
                "筛选总数只反映数据库现状，不随分页变化"
            );
            ids.extend(f.items.iter().map(|i| i.id.clone()));
            pages += 1;
            if !f.has_more {
                assert!(f.next_cursor.is_none());
                break;
            }
            cursor = f.next_cursor.clone();
            assert!(cursor.is_some());
            if !inserted {
                // 翻页途中插入新数据：不得导致旧页重复/丢失
                seed_runs(&db, "new", 5, "failed", "2026-10-29T10:00:00+00:00");
                inserted = true;
            }
            assert!(pages < 100, "分页必须收敛");
        }
        assert_eq!(ids.len(), n, "旧数据一页不丢");
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), n, "分页不得重复");
        let expected: std::collections::HashSet<String> =
            (0..n).map(|i| format!("run:run-run-{:04}", i)).collect();
        assert_eq!(
            unique
                .into_iter()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
            expected
        );

        // 新数据在自己的页里可见，且不重排旧页
        let first = feed(
            &db,
            &ActionFilter {
                category: Some("intervention".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(first.filtered_total, n + 5);
        assert_eq!(first.counts.intervention, n + 5);
        assert!(
            first.items.iter().take(5).all(|i| i.id.contains("new-run")),
            "新失败按优先级排在最前"
        );
    }

    #[test]
    fn history_and_notification_pagination_have_no_duplicates_or_gaps() {
        let db = memdb();
        seed_runs(&db, "h", 120, "completed", "2026-10-28T10:00:00+00:00");
        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        let mut total = 0;
        loop {
            let f = feed(
                &db,
                &ActionFilter {
                    category: Some("history".into()),
                    limit: Some(25),
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(f.counts.history, 120);
            for it in &f.items {
                assert!(seen.insert(it.id.clone()), "历史分页出现重复 {}", it.id);
                total += 1;
            }
            if !f.has_more {
                break;
            }
            cursor = f.next_cursor.clone();
        }
        assert_eq!(total, 120);
        assert_eq!(seen.len(), 120);

        db.with_conn(|c| {
            for i in 0..70 {
                c.execute(
                    "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at, agent_origin)
                     VALUES (?1, 'reminder', '提醒', '', 'task', NULL, ?1, 0, ?2, 'real')",
                    params![format!("pagerem-{:04}", i), "2026-10-28T10:00:00+00:00"],
                )?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        loop {
            let f = feed(
                &db,
                &ActionFilter {
                    category: Some("notification".into()),
                    limit: Some(20),
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(f.counts.notification, 70);
            for it in &f.items {
                assert!(seen.insert(it.id.clone()), "通知分页出现重复 {}", it.id);
            }
            if !f.has_more {
                break;
            }
            cursor = f.next_cursor.clone();
        }
        assert_eq!(seen.len(), 70);
    }

    #[test]
    fn acking_history_waiting_run_removes_badge_but_keeps_history_item() {
        let db = memdb();
        let out = step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "waiting",
            "等待输入",
            "2026-10-28T10:00:00+00:00",
        );
        ack(&db, &[format!("run:{}", out.run_row_id)]).unwrap();
        let f = feed_of(&db, "intervention");
        assert!(f.items.is_empty());
        let h = feed_of(&db, "history");
        assert_eq!(h.items.len(), 1);
        assert!(h.items[0].acked, "历史保留已确认标记");
        assert_eq!(h.counts.total, 0);
    }

    #[test]
    fn source_and_task_filters_never_change_global_counts() {
        let db = memdb();
        task(&db, "t1", "任务一");
        link_task(&db, "l1", "t1", "codex", "s1");
        step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "failed",
            "x",
            "2026-10-28T10:00:00+00:00",
        );
        step(
            &db,
            "e2",
            "trae",
            "s2",
            Some("r2"),
            "waiting",
            "y",
            "2026-10-28T10:01:00+00:00",
        );
        let by_task = feed(
            &db,
            &ActionFilter {
                category: Some("intervention".into()),
                task_id: Some("t1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_task.filtered_total, 1);
        assert_eq!(by_task.items[0].source_id, "codex");
        assert_eq!(by_task.counts.intervention, 2);
        let by_source = feed(
            &db,
            &ActionFilter {
                category: Some("intervention".into()),
                source_id: Some("nope".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_source.items.len(), 0);
        assert_eq!(by_source.filtered_total, 0);
        assert_eq!(by_source.counts.total, 2);
    }

    #[test]
    fn coverage_never_fakes_monitoring() {
        let db = memdb();
        let f = feed_of(&db, "intervention");
        let zcode = f.coverage.iter().find(|c| c.source_id == "zcode").unwrap();
        assert_eq!(zcode.level, "no-events");
        assert!(!zcode.monitored, "未收到真实事件的来源不得标记为监控中");
        let now = crate::agents::now_iso();
        step(
            &db,
            "e1",
            "codex",
            "taskdock-selftest-codex",
            Some("r1"),
            "running",
            "",
            &now,
        );
        let f = feed_of(&db, "intervention");
        let codex = f.coverage.iter().find(|c| c.source_id == "codex").unwrap();
        // 自测只能证明通道，不能把来源标成已验证真实接入
        assert!(!codex.verified);
        assert!(codex.transport_verified);
        assert!(codex.explanation.contains("尚未收到真实会话事件"));
        assert!(f.items.is_empty());
    }

    #[test]
    fn disabled_module_returns_empty_feed_but_keeps_events() {
        let db = memdb();
        step(
            &db,
            "e1",
            "codex",
            "s1",
            Some("r1"),
            "failed",
            "失败",
            "2026-10-28T10:00:00+00:00",
        );
        db.set_setting("actions_enabled", serde_json::json!(false))
            .unwrap();
        for category in ["intervention", "notification", "history"] {
            let f = feed_of(&db, category);
            assert!(!f.enabled);
            assert!(f.items.is_empty());
            assert_eq!(f.counts.total, 0);
        }
        assert_eq!(event_count(&db), 1, "关闭行动中心不得影响 Agent 事件入库");
    }
}
